"""Per-resource storage: the event log and day notes, kept in Home Assistant's .storage."""
from __future__ import annotations

import asyncio
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from uuid import uuid4

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN, KIND_ADD, KIND_COUNT, KIND_TAKE, MAX_NOTE, MAX_UNITS
from .engine import ordered

STORAGE_VERSION = 1
EARLIEST = date(2000, 1, 1)


class InvalidEntry(ValueError):
    """Raised when a change contains something the tracker can't store."""


def check_day(day: date, today: date) -> None:
    """Tomorrow is allowed, to forgive a phone that's a time zone ahead of Home Assistant."""
    if day > today + timedelta(days=1):
        raise InvalidEntry("That day hasn't happened yet")
    if day < EARLIEST:
        raise InvalidEntry("Dates go back as far as 1 January 2000")


def _clean_note(note: str | None) -> str:
    note = (note or "").strip()
    if len(note) > MAX_NOTE:
        raise InvalidEntry(f"Notes can be up to {MAX_NOTE} characters")
    return note


def _check_amount(n: int) -> int:
    n = int(n)
    if not 0 <= n <= MAX_UNITS:
        raise InvalidEntry(f"Amounts must be between 0 and {MAX_UNITS:,}")
    return n


def timestamp(day: date, today: date, kind: str) -> str:
    """When an event happened, as far as anyone can tell.

    Today (or tomorrow, from a phone a time zone ahead): now. An earlier day: midday on it, the same each
    time, so things filled in later keep the order they were logged in. A stocktake for an earlier day is
    the count at the end of that day, so it comes after everything else logged for it."""
    if day >= today:
        when = dt_util.utcnow()
    else:
        when = datetime.combine(day, time(23, 59, 59) if kind == KIND_COUNT else time(12), dt_util.DEFAULT_TIME_ZONE)
    return when.astimezone(timezone.utc).isoformat(timespec="seconds")


def _key(event: dict[str, Any]) -> tuple:
    return (event["ts"], event.get("seq", 0), event.get("id", ""))


class StockStore:
    """Read-change-write is serialised, so two people taking a roll at once can't lose one."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        self._store = Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry_id}")
        self._lock = asyncio.Lock()
        self.events: list[dict[str, Any]] = []
        self.notes: dict[str, str] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.events = ordered(data.get("events") or [])
        self.notes = data.get("notes") or {}

    async def _save(self) -> None:
        await self._store.async_save({"events": self.events, "notes": self.notes})

    async def async_remove(self) -> None:
        await self._store.async_remove()

    def _new(self, kind: str, n: int, day: date, today: date, note: str, user_id: str | None,
             put_back: bool = False) -> dict[str, Any]:
        seq = max((e.get("seq", 0) for e in self.events), default=0) + 1
        event = {"id": uuid4().hex[:12], "seq": seq, "ts": timestamp(day, today, kind), "date": day.isoformat(),
                 "kind": kind, "n": n}
        if put_back:
            event["put_back"] = True
        if day < today:
            event["backdated"] = True       # filled in later: its time is a stand-in, not when it happened
        if note:
            event["note"] = note
        if user_id:
            event["by"] = user_id
        return event

    async def async_change(self, kind: str, day: date, today: date, delta: int, note: str | None = None,
                           user_id: str | None = None) -> int:
        """Take (kind "take") or restock (kind "add") `delta` more on `day`; a negative delta undoes that many of
        the day's latest takes or restocks. Undoing never goes below what was logged. Returns what changed."""
        if kind not in (KIND_TAKE, KIND_ADD):
            raise InvalidEntry("Only takes and restocks can be added or undone")
        delta = int(delta)
        if abs(delta) > MAX_UNITS:
            raise InvalidEntry(f"Amounts must be between 0 and {MAX_UNITS:,}")
        note = _clean_note(note)
        async with self._lock:
            if delta > 0:
                self.events = ordered([*self.events, self._new(kind, delta, day, today, note, user_id)])
                await self._save()
                return delta
            if delta == 0:
                return 0
            left = -delta
            for event in reversed(list(self.events)):
                if left == 0:
                    break
                if event["kind"] != kind or event["date"] != day.isoformat():
                    continue
                if event["n"] <= left:
                    left -= event["n"]
                    self.events.remove(event)
                else:
                    event["n"] -= left
                    left = 0
            undone = -delta - left
            if undone:
                await self._save()
            return -undone

    async def async_put_back(self, day: date, today: date, user_id: str | None = None) -> bool:
        """One goes back into storage. If one was taken that day it wasn't used after all, so that take is
        undone (True); otherwise it's recorded as put back (False), which isn't a restock.

        When a stocktake came between the take and now, it was counted while this one was out, so undoing
        the take alone wouldn't change what's in storage: it's also put back after the stocktake."""
        async with self._lock:
            key = day.isoformat()
            take = next((e for e in reversed(self.events) if e["kind"] == KIND_TAKE and e["date"] == key), None)
            back = self._new(KIND_ADD, 1, day, today, "", user_id, put_back=True)
            if take is not None:
                counted_since = any(e["kind"] == KIND_COUNT and _key(take) < _key(e) < _key(back) for e in self.events)
                if take["n"] > 1:
                    take["n"] -= 1
                else:
                    self.events.remove(take)
                if counted_since:
                    self.events = ordered([*self.events, back])
            else:
                self.events = ordered([*self.events, back])
            await self._save()
            return take is not None

    async def async_stocktake(self, count: int, day: date, today: date, note: str | None = None,
                              user_id: str | None = None) -> None:
        """There are exactly `count` in storage."""
        count, note = _check_amount(count), _clean_note(note)
        async with self._lock:
            self.events = ordered([*self.events, self._new(KIND_COUNT, count, day, today, note, user_id)])
            await self._save()

    async def async_set_note(self, day: date, note: str) -> str:
        note = _clean_note(note)
        async with self._lock:
            if note:
                self.notes[day.isoformat()] = note
            elif self.notes.pop(day.isoformat(), None) is None:
                return note
            await self._save()
        return note

    async def async_delete(self, event_id: str) -> bool:
        async with self._lock:
            kept = [e for e in self.events if e["id"] != event_id]
            if len(kept) == len(self.events):
                return False
            self.events = kept
            await self._save()
        return True
