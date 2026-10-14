"""The log on a real (test) Home Assistant: putting one back, the order of back-dated entries, dates, restarts,
midnight, permissions, and many writes at once."""
import asyncio
from unittest.mock import patch

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from homeassistant.core import Context
from homeassistant.exceptions import ServiceValidationError, Unauthorized
from homeassistant.helpers.dispatcher import DATA_DISPATCHER
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util

from custom_components.stock_track.const import DOMAIN


async def _setup(hass, tz="Australia/Brisbane", entry_id=None):
    await hass.config.async_set_time_zone(tz)
    e = MockConfigEntry(domain=DOMAIN, title="Toilet paper", data={"name": "Toilet paper", "unit": "rolls"},
                        options={"icon": "mdi:paper-roll", "low_level": 0}, **({"entry_id": entry_id} if entry_id else {}))
    e.add_to_hass(hass)
    assert await hass.config_entries.async_setup(e.entry_id)
    await hass.async_block_till_done()
    return e


def st(hass, key):
    return hass.states.get(f"sensor.toilet_paper_{key}").state


async def press(hass, which):
    await hass.services.async_call("button", "press", {"entity_id": f"button.toilet_paper_{which}"}, blocking=True)


async def call(hass, service, **data):
    await hass.services.async_call(DOMAIN, service, data, blocking=True)


async def _ws(client, **msg):
    await client.send_json_auto_id(msg)
    return await client.receive_json()


# Putting one back

async def test_put_back_after_a_stocktake_puts_one_back(hass, freezer):
    """08:00 a roll is taken; 09:00 the stocktake counts 37 with it out; 10:00 it goes back unused."""
    freezer.move_to("2026-10-14 08:00:00+10:00")
    await _setup(hass)
    await press(hass, "take_one")
    freezer.move_to("2026-10-14 09:00:00+10:00")
    await call(hass, "stocktake", count=37)
    freezer.move_to("2026-10-14 10:00:00+10:00")
    await press(hass, "put_one_back")
    assert st(hass, "in_storage") == "38" and st(hass, "used_today") == "0"


async def test_put_back_does_not_become_the_last_restock(hass, freezer):
    """The household's start, then a roll put back the next day with nothing to undo."""
    freezer.move_to("2026-10-14 19:00:00+10:00")
    await _setup(hass)
    await call(hass, "restock", amount=8, date="2026-10-12", note="Moved 8 rolls into storage")
    await call(hass, "stocktake", count=37)
    assert st(hass, "in_storage") == "37" and st(hass, "last_restock") == "2026-10-12"
    freezer.move_to("2026-10-15 09:00:00+10:00")
    await press(hass, "put_one_back")
    assert st(hass, "in_storage") == "38" and st(hass, "last_restock") == "2026-10-12"


async def test_two_put_backs_while_the_store_is_busy(hass, freezer):
    """One take today; two presses arrive while another write holds the store: one undo and one put back."""
    freezer.move_to("2026-10-14 08:00:00+10:00")
    entry = await _setup(hass)
    await call(hass, "stocktake", count=10)
    await press(hass, "take_one")
    store = hass.data[DOMAIN][entry.entry_id]["store"]
    gate = asyncio.Event()
    real_save = store._save

    async def slow_save():
        await gate.wait()
        await real_save()

    with patch.object(store, "_save", slow_save):
        note = hass.async_create_task(store.async_set_note(dt_util.now().date(), "busy"))
        await asyncio.sleep(0)
        first = hass.async_create_task(press(hass, "put_one_back"))
        second = hass.async_create_task(press(hass, "put_one_back"))
        for _ in range(50):
            await asyncio.sleep(0)
        gate.set()
        await asyncio.gather(note, first, second)
    await hass.async_block_till_done()
    assert st(hass, "in_storage") == "11" and st(hass, "used_today") == "0"


async def test_put_back_over_the_websocket(hass, hass_ws_client):
    entry = await _setup(hass)
    client = await hass_ws_client(hass)
    await call(hass, "stocktake", count=5)
    await press(hass, "take_one")
    r = await _ws(client, type=f"{DOMAIN}/put_back", entry_id=entry.entry_id)
    assert r["success"] and r["result"] == {"undone": True}
    r = await _ws(client, type=f"{DOMAIN}/put_back", entry_id=entry.entry_id)
    assert r["result"] == {"undone": False}
    r = await _ws(client, type=f"{DOMAIN}/overview", entry_id=entry.entry_id, days=1)
    day = r["result"]["day"]
    assert r["result"]["stats"]["in_storage"] == 6 and day["returned"] == 1 and day["added"] == 0
    assert day["events"][-1]["put_back"] is True


# The order of back-dated entries

async def test_a_stocktake_for_yesterday_is_the_count_at_the_end_of_that_day(hass, freezer):
    """A roll taken at 8 pm, then next morning the previous evening's count is typed in: 37, not 36."""
    freezer.move_to("2026-10-13 20:00:00+10:00")
    await _setup(hass)
    await call(hass, "stocktake", count=40)
    await press(hass, "take_one")
    freezer.move_to("2026-10-14 08:00:00+10:00")
    await call(hass, "stocktake", count=37, date="2026-10-13")
    assert st(hass, "in_storage") == "37"
    store = hass.data[DOMAIN][next(iter(e for e in hass.data[DOMAIN] if e != "_frontend"))]["store"]
    assert [e.get("backdated") for e in store.events] == [None, None, True]


async def test_a_take_for_an_earlier_day_comes_before_that_days_count(hass, freezer):
    freezer.move_to("2026-10-14 08:00:00+10:00")
    await _setup(hass)
    await call(hass, "stocktake", count=37, date="2026-10-13")
    await call(hass, "take", date="2026-10-13")
    assert st(hass, "in_storage") == "37"           # the end-of-day count already had it out
    await call(hass, "take")
    assert st(hass, "in_storage") == "36"


async def test_tomorrow_from_a_phone_ahead_is_stamped_now(hass, freezer):
    """A stocktake sent for tomorrow at 10 pm mustn't swallow a roll taken at 7 the next morning."""
    freezer.move_to("2026-10-14 22:00:00+10:00")
    await _setup(hass)
    await call(hass, "stocktake", count=30, date="2026-10-15")
    freezer.move_to("2026-10-15 07:00:00+10:00")
    await press(hass, "take_one")
    assert st(hass, "in_storage") == "29"


# Dates

@pytest.mark.parametrize("tz", ["Australia/Brisbane", "America/Anchorage"])
async def test_dates_before_2000_are_refused(hass, hass_ws_client, tz):
    entry = await _setup(hass, tz)
    client = await hass_ws_client(hass)
    for day in ("0001-01-01", "1999-12-31"):
        r = await _ws(client, type=f"{DOMAIN}/stocktake", entry_id=entry.entry_id, count=5, date=day)
        assert not r["success"] and r["error"]["code"] == "invalid", r
    with pytest.raises(ServiceValidationError):
        await call(hass, "take", date="1999-12-31")


# Restart, reload and midnight

async def test_restart_replays_the_log_in_order(hass, hass_storage, freezer):
    """Events saved out of order (a hand edit, say) still replay in the order they happened."""
    freezer.move_to("2026-10-14 20:00:00+10:00")
    hass_storage[f"{DOMAIN}.abc"] = {"version": 1, "key": f"{DOMAIN}.abc", "data": {"events": [
        {"id": "t", "seq": 3, "ts": "2026-10-14T10:00:00+00:00", "date": "2026-10-14", "kind": "take", "n": 1},
        {"id": "c", "seq": 2, "ts": "2026-10-14T09:00:00+00:00", "date": "2026-10-14", "kind": "count", "n": 37},
        {"id": "a", "seq": 1, "ts": "2026-10-12T02:00:00+00:00", "date": "2026-10-12", "kind": "add", "n": 8},
    ], "notes": {}}}
    await _setup(hass, entry_id="abc")
    assert st(hass, "in_storage") == "36"


async def test_reloading_keeps_the_log_and_adds_no_listeners(hass, freezer):
    freezer.move_to("2026-10-14 20:00:00+10:00")
    entry = await _setup(hass)
    await call(hass, "stocktake", count=37)
    signal = f"{DOMAIN}_updated_{entry.entry_id}"
    before = len(hass.data[DATA_DISPATCHER].get(signal, {}))
    for _ in range(3):
        assert await hass.config_entries.async_reload(entry.entry_id)
        await hass.async_block_till_done()
    assert len(hass.data[DATA_DISPATCHER].get(signal, {})) == before
    await press(hass, "take_one")
    assert st(hass, "in_storage") == "36"


async def test_used_today_starts_again_at_midnight(hass, freezer):
    freezer.move_to("2026-10-14 23:50:00+10:00")
    await _setup(hass)
    await call(hass, "stocktake", count=37)
    await press(hass, "take_one")
    assert st(hass, "used_today") == "1"
    for day in ("2026-10-15", "2026-10-16"):     # and the night after, from the refresh it booked
        freezer.move_to(f"{day} 00:00:06+10:00")
        async_fire_time_changed(hass)
        await hass.async_block_till_done()
        assert st(hass, "used_today") == "0", day
        freezer.move_to(f"{day} 12:00:00+10:00")
        await press(hass, "take_one")
        assert st(hass, "used_today") == "1"


async def test_midnight_refresh_where_the_clocks_change_at_midnight(hass, freezer):
    """Cairo's clocks go from 00:00 to 01:00 on 24 April 2026, so that day has no midnight."""
    freezer.move_to("2026-04-23 23:50:00+02:00")
    await _setup(hass, "Africa/Cairo")
    await call(hass, "stocktake", count=37)
    await press(hass, "take_one")
    freezer.move_to("2026-04-24 01:00:06+03:00")
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert st(hass, "used_today") == "0"


# Permissions

async def test_a_read_only_user_can_look_but_not_change(hass, hass_ws_client, hass_read_only_user,
                                                       hass_read_only_access_token):
    entry = await _setup(hass)
    await call(hass, "stocktake", count=37)
    store = hass.data[DOMAIN][entry.entry_id]["store"]
    client = await hass_ws_client(hass, hass_read_only_access_token)
    r = await _ws(client, type=f"{DOMAIN}/overview", entry_id=entry.entry_id)
    assert r["success"] and r["result"]["stats"]["in_storage"] == 37
    for msg in ({"type": f"{DOMAIN}/delete_event", "event_id": store.events[0]["id"]},
                {"type": f"{DOMAIN}/stocktake", "count": 0},
                {"type": f"{DOMAIN}/change", "kind": "take"},
                {"type": f"{DOMAIN}/put_back"},
                {"type": f"{DOMAIN}/set_note", "date": dt_util.now().date().isoformat(), "note": "x"}):
        r = await _ws(client, entry_id=entry.entry_id, **msg)
        assert not r["success"] and r["error"]["code"] == "unauthorized", (msg, r)
    with pytest.raises(Unauthorized):
        await hass.services.async_call(DOMAIN, "take", {}, blocking=True, context=Context(user_id=hass_read_only_user.id))
    assert st(hass, "in_storage") == "37" and len(store.events) == 1


async def test_people_and_automations_can_change(hass, hass_ws_client, hass_admin_user):
    entry = await _setup(hass)
    await hass.services.async_call(DOMAIN, "stocktake", {"count": 5}, blocking=True,
                                   context=Context(user_id=hass_admin_user.id))
    await hass.services.async_call(DOMAIN, "take", {}, blocking=True)       # an automation: no user
    client = await hass_ws_client(hass)
    r = await _ws(client, type=f"{DOMAIN}/change", entry_id=entry.entry_id, kind="take")
    assert r["success"] and st(hass, "in_storage") == "3"


# Many at once

async def test_many_takes_at_once_lose_nothing(hass, hass_ws_client):
    entry = await _setup(hass)
    await call(hass, "stocktake", count=100)
    client = await hass_ws_client(hass)
    calls = [hass.services.async_call(DOMAIN, "take", {}, blocking=True) for _ in range(15)]
    calls += [press(hass, "take_one") for _ in range(5)]
    await asyncio.gather(*calls)
    for _ in range(5):
        await client.send_json_auto_id({"type": f"{DOMAIN}/change", "entry_id": entry.entry_id, "kind": "take"})
    for _ in range(5):
        assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert st(hass, "in_storage") == "75" and st(hass, "used_today") == "25"
    store = hass.data[DOMAIN][entry.entry_id]["store"]
    assert len({e["seq"] for e in store.events}) == len(store.events) == 26


# The card

async def test_no_dashboard_resource_without_the_cards_file(hass):
    assert await async_setup_component(hass, "lovelace", {})
    with patch("custom_components.stock_track.CARD_FILENAME", "not-there.js"):
        await _setup(hass)
    from homeassistant.components.lovelace import LOVELACE_DATA
    assert not [i for i in hass.data[LOVELACE_DATA].resources.async_items() if "stock_track" in i.get("url", "")]
