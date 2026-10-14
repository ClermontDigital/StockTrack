"""WebSocket API for the Stock Track card.

Anyone signed in to Home Assistant can read. Logging needs the same permission as pressing the resource's
Take one button, so a read-only user can look but not change anything.
"""
from __future__ import annotations

from datetime import date
from typing import Any

import voluptuous as vol

from homeassistant.auth.models import User
from homeassistant.auth.permissions.const import POLICY_CONTROL
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect, async_dispatcher_send
from homeassistant.util import dt as dt_util

from . import engine
from .const import (
    CONF_ICON, CONF_LOW, CONF_UNIT, DEFAULT_ICON, DEFAULT_UNIT, DOMAIN, KIND_ADD, KIND_TAKE, MAX_NOTE, MAX_UNITS,
    SIGNAL_UPDATED,
)
from .storage import InvalidEntry, StockStore, check_day

MAX_CHART_DAYS = 366


def settings(entry: ConfigEntry) -> dict[str, Any]:
    merged = {**entry.data, **entry.options}
    return {"unit": merged.get(CONF_UNIT) or DEFAULT_UNIT, "icon": merged.get(CONF_ICON) or DEFAULT_ICON,
            "low_level": int(merged.get(CONF_LOW) or 0)}


def resources(hass: HomeAssistant) -> list[ConfigEntry]:
    """Loaded resources, in the order they were added."""
    return [e for e in hass.config_entries.async_entries(DOMAIN) if e.entry_id in hass.data.get(DOMAIN, {})]


def store_of(hass: HomeAssistant, entry_id: str) -> StockStore:
    return hass.data[DOMAIN][entry_id]["store"]


def describe(entry: ConfigEntry) -> dict[str, Any]:
    return {"entry_id": entry.entry_id, "name": entry.title, **settings(entry)}


@callback
def changed(hass: HomeAssistant, entry_id: str) -> None:
    """Tell the sensors and every open card that this resource's log changed."""
    async_dispatcher_send(hass, SIGNAL_UPDATED.format(entry_id))


def can_change(hass: HomeAssistant, user: User | None, entry_id: str) -> bool:
    """Whether this person may log for this resource: if they could press its Take one button."""
    if user is None or user.is_admin:
        return True
    entity_id = er.async_get(hass).async_get_entity_id("button", DOMAIN, f"{entry_id}_take_one")
    return entity_id is not None and user.permissions.check_entity(entity_id, POLICY_CONTROL)


NOT_ALLOWED = "Your Home Assistant user can look at this but not change it"


def _resolve(hass: HomeAssistant, connection: websocket_api.ActiveConnection,
             msg: dict[str, Any], write: bool = False) -> tuple[ConfigEntry, StockStore] | None:
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if not entry or entry.domain != DOMAIN or entry.entry_id not in hass.data.get(DOMAIN, {}):
        connection.send_error(msg["id"], "not_found", "No such resource")
        return None
    if write and not can_change(hass, connection.user, entry.entry_id):
        connection.send_error(msg["id"], websocket_api.ERR_UNAUTHORIZED, NOT_ALLOWED)
        return None
    return entry, store_of(hass, entry.entry_id)


def _iso_date(value: Any) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except (TypeError, ValueError) as err:
        raise vol.Invalid("Dates look like 2026-10-14") from err


def _day(msg: dict[str, Any], today: date) -> date:
    day = date.fromisoformat(msg["date"]) if msg.get("date") else today
    check_day(day, today)
    return day


def overview(entry: ConfigEntry, store: StockStore, today: date, chart_days: int, day: date | None = None) -> dict[str, Any]:
    s = settings(entry)
    return {
        "resource": describe(entry),
        "today": today.isoformat(),
        "day": engine.day_record(store.events, store.notes, day or today),
        "stats": engine.stats(store.events, today, s["low_level"]).as_dict(),
        "series": engine.series(store.events, store.notes, today, chart_days),
    }


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/resources"})
@callback
def ws_resources(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    connection.send_result(msg["id"], [describe(e) for e in resources(hass)])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/overview",
    vol.Required("entry_id"): str,
    vol.Optional("date"): _iso_date,
    vol.Optional("days", default=35): vol.All(vol.Coerce(int), vol.Range(min=1, max=MAX_CHART_DAYS)),
})
@callback
def ws_overview(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Everything the card needs. `date` is the day being looked at; today when left out."""
    if not (found := _resolve(hass, connection, msg)):
        return
    entry, store = found
    today = dt_util.now().date()
    day = date.fromisoformat(msg["date"]) if msg.get("date") else today
    connection.send_result(msg["id"], overview(entry, store, today, msg["days"], day))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/events",
    vol.Required("entry_id"): str,
    vol.Optional("start"): _iso_date,
    vol.Optional("end"): _iso_date,
})
@callback
def ws_events(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Everything logged in a range (all of it when no range is given), plus day notes, for the CSV export."""
    if not (found := _resolve(hass, connection, msg)):
        return
    _, store = found
    start, end = msg.get("start", ""), msg.get("end", "9999-12-31")
    connection.send_result(msg["id"], {
        "events": [{k: e[k] for k in ("date", "ts", "kind", "n", "note", "put_back", "backdated") if k in e}
                   for e in engine.ordered(store.events) if start <= e["date"] <= end],
        "notes": {d: n for d, n in sorted(store.notes.items()) if start <= d <= end},
    })


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/change",
    vol.Required("entry_id"): str,
    vol.Required("kind"): vol.In([KIND_TAKE, KIND_ADD]),
    vol.Optional("delta", default=1): vol.All(vol.Coerce(int), vol.Range(min=-MAX_UNITS, max=MAX_UNITS)),
    vol.Optional("date"): _iso_date,
    vol.Optional("note"): vol.All(str, vol.Length(max=MAX_NOTE * 4)),
})
@websocket_api.async_response
async def ws_change(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Take or restock some (a positive delta), or undo the day's latest (a negative one)."""
    if not (found := _resolve(hass, connection, msg, write=True)):
        return
    entry, store = found
    today = dt_util.now().date()
    try:
        done = await store.async_change(msg["kind"], _day(msg, today), today, msg["delta"], msg.get("note"),
                                        connection.user.id)
    except InvalidEntry as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    changed(hass, entry.entry_id)
    connection.send_result(msg["id"], {"changed": done})


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/stocktake",
    vol.Required("entry_id"): str,
    vol.Required("count"): vol.All(vol.Coerce(int), vol.Range(min=0, max=MAX_UNITS)),
    vol.Optional("date"): _iso_date,
    vol.Optional("note"): vol.All(str, vol.Length(max=MAX_NOTE * 4)),
})
@websocket_api.async_response
async def ws_stocktake(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if not (found := _resolve(hass, connection, msg, write=True)):
        return
    entry, store = found
    today = dt_util.now().date()
    try:
        await store.async_stocktake(msg["count"], _day(msg, today), today, msg.get("note"), connection.user.id)
    except InvalidEntry as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    changed(hass, entry.entry_id)
    connection.send_result(msg["id"], {"in_storage": engine.replay(store.events)[0]})


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/put_back",
    vol.Required("entry_id"): str,
    vol.Optional("date"): _iso_date,
})
@websocket_api.async_response
async def ws_put_back(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """One back into storage: undoes one of that day's takes, or with none to undo, records one put back."""
    if not (found := _resolve(hass, connection, msg, write=True)):
        return
    entry, store = found
    today = dt_util.now().date()
    try:
        undone = await store.async_put_back(_day(msg, today), today, connection.user.id)
    except InvalidEntry as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    changed(hass, entry.entry_id)
    connection.send_result(msg["id"], {"undone": undone})


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/set_note",
    vol.Required("entry_id"): str,
    vol.Required("date"): _iso_date,
    vol.Required("note"): vol.All(str, vol.Length(max=MAX_NOTE * 4)),
})
@websocket_api.async_response
async def ws_set_note(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if not (found := _resolve(hass, connection, msg, write=True)):
        return
    entry, store = found
    today = dt_util.now().date()
    try:
        note = await store.async_set_note(_day(msg, today), msg["note"])
    except InvalidEntry as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    changed(hass, entry.entry_id)
    connection.send_result(msg["id"], {"note": note})


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/delete_event",
    vol.Required("entry_id"): str,
    vol.Required("event_id"): str,
})
@websocket_api.async_response
async def ws_delete_event(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Remove one thing from the log, such as a stocktake typed in by mistake."""
    if not (found := _resolve(hass, connection, msg, write=True)):
        return
    entry, store = found
    if not await store.async_delete(msg["event_id"]):
        connection.send_error(msg["id"], "not_found", "That entry isn't in the log")
        return
    changed(hass, entry.entry_id)
    connection.send_result(msg["id"], {"deleted": msg["event_id"]})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe", vol.Required("entry_id"): str})
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """An event every time this resource's log changes (and at midnight), so open cards stay in step."""
    if not _resolve(hass, connection, msg):
        return

    @callback
    def _forward() -> None:
        connection.send_message(websocket_api.event_message(msg["id"], {"changed": True}))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(
        hass, SIGNAL_UPDATED.format(msg["entry_id"]), _forward)
    connection.send_result(msg["id"])


@callback
def async_register_api(hass: HomeAssistant) -> None:
    for command in (ws_resources, ws_overview, ws_events, ws_change, ws_put_back, ws_stocktake, ws_set_note,
                    ws_delete_event, ws_subscribe):
        websocket_api.async_register_command(hass, command)
