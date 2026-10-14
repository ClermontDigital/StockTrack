"""The numbers behind Stock Track: what's in storage, what's been used, and how fast.

Pure Python, no Home Assistant imports, so it can be tested on its own.

The log is a list of events, each `{"id", "seq", "ts", "date", "kind", "n", "note"?}`:

* `take`: `n` came out of storage to be used. Usage rates count these.
* `add`: `n` went into storage: a restock, or with `"put_back": true` one put back that wasn't used after all.
* `count`: a stocktake. There were exactly `n` in storage at that moment.

`ts` is a UTC timestamp (ISO 8601), so the events sort into the order they happened; `backdated` marks one
filled in later for an earlier day, whose `ts` is a stand-in (midday, or the end of the day for a
stocktake) rather than when it happened. `date` is the
local day they belong to. The level in storage replays them in order: a stocktake sets it, a restock
adds to it and a take subtracts from it (never below zero). It's unknown until the first stocktake or
restock: takes alone don't say how many are left.

Usage is measured from the first stocktake (or the first take, if there's never been a stocktake):
days before that weren't tracked, so they mustn't count as days nothing was used. Rates appear once
a week has been tracked, and look back at most 30 days.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, timedelta
from typing import Any

from .const import KIND_ADD, KIND_COUNT, KIND_TAKE, MIN_RATE_DAYS, RATE_WINDOW

Events = list[dict[str, Any]]
Notes = dict[str, str]


def ordered(events: Events) -> Events:
    """In the order they happened; things logged in the same second keep the order they were logged in."""
    return sorted(events, key=lambda e: (e["ts"], e.get("seq", 0), e.get("id", "")))


def is_restock(event: dict[str, Any]) -> bool:
    """An `add` that brought more in, as opposed to one put back that wasn't used after all."""
    return event["kind"] == KIND_ADD and not event.get("put_back")


def replay(events: Events) -> tuple[int | None, dict[str, int | None]]:
    """The level in storage now, and at the end of each day that has events. None until it's known: the
    first stocktake or restock sets it, and takes or put-backs before then can't say how many are left."""
    level: int | None = None
    ends: dict[str, int | None] = {}
    for event in ordered(events):
        n = int(event["n"])
        if event["kind"] == KIND_COUNT:
            level = n
        elif is_restock(event):
            level = (level or 0) + n
        elif level is not None:         # a put-back or a take only moves a level that's known
            level = level + n if event["kind"] == KIND_ADD else max(0, level - n)
        ends[event["date"]] = level
    return level, ends


def empty_day() -> dict[str, Any]:
    return {"used": 0, "added": 0, "returned": 0, "count": None}


def daily(events: Events) -> dict[str, dict[str, Any]]:
    """Per day: how many were taken, restocked and put back, and the last stocktake's count (None if none)."""
    out: dict[str, dict[str, Any]] = {}
    for event in ordered(events):
        day = out.setdefault(event["date"], empty_day())
        if event["kind"] == KIND_TAKE:
            day["used"] += int(event["n"])
        elif event["kind"] == KIND_ADD:
            day["added" if is_restock(event) else "returned"] += int(event["n"])
        elif event["kind"] == KIND_COUNT:
            day["count"] = int(event["n"])
    return out


def tracking_since(events: Events) -> date | None:
    """The first stocktake's day; failing that, the first take's. Restocks alone don't start tracking."""
    for kind in (KIND_COUNT, KIND_TAKE):
        days = [e["date"] for e in events if e["kind"] == kind]
        if days:
            return date.fromisoformat(min(days))
    return None


def used(days: dict[str, dict[str, Any]], start: date, end: date) -> int:
    """Taken from `start` to `end`, both included."""
    if end < start:
        return 0
    lo, hi = start.isoformat(), end.isoformat()
    return sum(r["used"] for d, r in days.items() if lo <= d <= hi)


@dataclass(frozen=True)
class Stats:
    in_storage: int | None
    used_today: int
    used_yesterday: int
    used_last_7_days: int
    used_last_30_days: int
    used_this_month: int
    used_total: int
    tracking_since: date | None
    tracked_days: int
    per_day: float | None            # average taken a day over the last 30 days (or since tracking began)
    per_week: float | None
    days_between: float | None       # on average, one taken every this many days
    days_left: int | None            # how long what's in storage lasts at that rate
    last_taken: str | None           # UTC timestamp
    last_restock: date | None
    last_restock_amount: int
    last_stocktake: date | None
    last_stocktake_count: int | None
    low_level: int
    running_low: bool

    def as_dict(self) -> dict[str, Any]:
        out = asdict(self)
        for key in ("tracking_since", "last_restock", "last_stocktake"):
            out[key] = out[key].isoformat() if out[key] else None
        return out


def stats(events: Events, today: date, low_level: int = 0) -> Stats:
    level, _ = replay(events)
    days = daily(events)
    since = tracking_since(events)
    tracked = (today - since).days + 1 if since and since <= today else 0

    # The rate as a fraction, window_used / window_days, so what's derived from it isn't skewed by rounding.
    window_used = window_days = 0
    if tracked >= MIN_RATE_DAYS and since is not None:
        start = max(since, today - timedelta(days=RATE_WINDOW - 1))
        window_used, window_days = used(days, start, today), (today - start).days + 1
    per_day = round(window_used / window_days, 3) if window_days else None

    takes = [e for e in events if e["kind"] == KIND_TAKE]
    adds = [e for e in events if is_restock(e)]
    counts = ordered([e for e in events if e["kind"] == KIND_COUNT])
    last_restock = max((e["date"] for e in adds), default=None)
    return Stats(
        in_storage=level,
        used_today=used(days, today, today),
        used_yesterday=used(days, today - timedelta(days=1), today - timedelta(days=1)),
        used_last_7_days=used(days, today - timedelta(days=6), today),
        used_last_30_days=used(days, today - timedelta(days=29), today),
        used_this_month=used(days, today.replace(day=1), today),
        used_total=sum(int(e["n"]) for e in takes),
        tracking_since=since,
        tracked_days=tracked,
        per_day=per_day,
        per_week=round(window_used * 7 / window_days, 2) if window_days else None,
        days_between=round(window_days / window_used, 1) if window_used else None,
        days_left=level * window_days // window_used if window_used and level is not None else None,
        last_taken=max((e["ts"] for e in takes), default=None),
        last_restock=date.fromisoformat(last_restock) if last_restock else None,
        last_restock_amount=days[last_restock]["added"] if last_restock else 0,
        last_stocktake=date.fromisoformat(counts[-1]["date"]) if counts else None,
        last_stocktake_count=int(counts[-1]["n"]) if counts else None,
        low_level=low_level,
        running_low=bool(low_level > 0 and level is not None and level <= low_level),
    )


def day_record(events: Events, notes: Notes, day: date) -> dict[str, Any]:
    """One day as the card shows it: totals, the note, and each thing logged that day."""
    key = day.isoformat()
    totals = daily(events).get(key, empty_day())
    return {
        "date": key, **totals, "note": notes.get(key, ""),
        "events": [{k: e[k] for k in ("id", "kind", "n", "ts", "note", "put_back", "backdated") if k in e}
                   for e in ordered(events) if e["date"] == key],
    }


def series(events: Events, notes: Notes, today: date, count: int) -> list[dict[str, Any]]:
    """The last `count` days, oldest first: what was taken, restocked and put back, any stocktake, and the level
    at the day's end. Days before tracking began have no level, so a restock logged before the first stocktake
    doesn't draw a jump."""
    days = daily(events)
    _, ends = replay(events)
    since = tracking_since(events)
    first = today - timedelta(days=count - 1)
    # The level at the end of the day before the range, carried forward through days with no events.
    earlier = [d for d in ends if d < first.isoformat()]
    level = ends[max(earlier)] if earlier else None
    out = []
    for back in range(count - 1, -1, -1):
        day = today - timedelta(days=back)
        key = day.isoformat()
        if key in ends:
            level = ends[key]
        record = days.get(key, empty_day())
        tracked = bool(since and day >= since)
        out.append({"date": key, **record, "note": notes.get(key, ""), "level": level if tracked else None,
                    "tracked": tracked})
    return out
