"""The card's WebSocket API and the services, on a real (test) Home Assistant."""
from datetime import timedelta

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.util import dt as dt_util

from custom_components.stock_track.const import DOMAIN


@pytest.fixture
async def entry(hass: HomeAssistant):
    await hass.config.async_set_time_zone("Australia/Brisbane")
    e = MockConfigEntry(domain=DOMAIN, title="Toilet paper", data={"name": "Toilet paper", "unit": "rolls"},
                        options={"icon": "mdi:paper-roll", "low_level": 6})
    e.add_to_hass(hass)
    assert await hass.config_entries.async_setup(e.entry_id)
    await hass.async_block_till_done()
    return e


async def _ws(client, **msg):
    await client.send_json_auto_id(msg)
    return await client.receive_json()


async def test_household_start_and_a_roll_taken(hass, hass_ws_client, entry):
    client = await hass_ws_client(hass)
    today = dt_util.now().date()
    two_days_ago = (today - timedelta(days=2)).isoformat()
    r = await _ws(client, type=f"{DOMAIN}/change", entry_id=entry.entry_id, kind="add", delta=8, date=two_days_ago,
                  note="Moved 8 rolls into storage")
    assert r["success"] and r["result"] == {"changed": 8}
    r = await _ws(client, type=f"{DOMAIN}/stocktake", entry_id=entry.entry_id, count=37, note="Inventory")
    assert r["success"] and r["result"] == {"in_storage": 37}
    r = await _ws(client, type=f"{DOMAIN}/overview", entry_id=entry.entry_id, days=7)
    o = r["result"]
    assert o["resource"]["name"] == "Toilet paper" and o["resource"]["unit"] == "rolls"
    assert o["stats"]["in_storage"] == 37 and o["stats"]["last_restock_amount"] == 8
    assert o["series"][-3]["added"] == 8 and o["series"][-1]["count"] == 37
    # A roll out of storage, then undone, then out again.
    for delta, left in ((1, 36), (-1, 37), (1, 36)):
        r = await _ws(client, type=f"{DOMAIN}/change", entry_id=entry.entry_id, kind="take", delta=delta)
        assert r["success"], r
        assert hass.states.get("sensor.toilet_paper_in_storage").state == str(left)
    assert hass.states.get("sensor.toilet_paper_used_today").state == "1"


async def test_undo_never_takes_away_more_than_was_logged(hass, hass_ws_client, entry):
    client = await hass_ws_client(hass)
    await _ws(client, type=f"{DOMAIN}/stocktake", entry_id=entry.entry_id, count=10)
    r = await _ws(client, type=f"{DOMAIN}/change", entry_id=entry.entry_id, kind="take", delta=-3)
    assert r["result"] == {"changed": 0}
    await _ws(client, type=f"{DOMAIN}/change", entry_id=entry.entry_id, kind="take", delta=2)
    r = await _ws(client, type=f"{DOMAIN}/change", entry_id=entry.entry_id, kind="take", delta=-5)
    assert r["result"] == {"changed": -2}
    assert hass.states.get("sensor.toilet_paper_in_storage").state == "10"


async def test_notes_delete_and_export(hass, hass_ws_client, entry):
    client = await hass_ws_client(hass)
    today = dt_util.now().date().isoformat()
    await _ws(client, type=f"{DOMAIN}/stocktake", entry_id=entry.entry_id, count=37)
    r = await _ws(client, type=f"{DOMAIN}/set_note", entry_id=entry.entry_id, date=today, note="  Inventory  ")
    assert r["result"] == {"note": "Inventory"}
    r = await _ws(client, type=f"{DOMAIN}/overview", entry_id=entry.entry_id, days=1)
    day = r["result"]["day"]
    assert day["note"] == "Inventory" and day["events"][0]["kind"] == "count"
    r = await _ws(client, type=f"{DOMAIN}/events", entry_id=entry.entry_id)
    assert r["result"]["notes"] == {today: "Inventory"} and r["result"]["events"][0]["n"] == 37
    r = await _ws(client, type=f"{DOMAIN}/delete_event", entry_id=entry.entry_id, event_id=day["events"][0]["id"])
    assert r["success"]
    assert hass.states.get("sensor.toilet_paper_in_storage").state == "unknown"
    r = await _ws(client, type=f"{DOMAIN}/delete_event", entry_id=entry.entry_id, event_id="nope")
    assert not r["success"] and r["error"]["code"] == "not_found"


async def test_refuses_the_future_and_unknown_resources(hass, hass_ws_client, entry):
    client = await hass_ws_client(hass)
    later = (dt_util.now().date() + timedelta(days=3)).isoformat()
    r = await _ws(client, type=f"{DOMAIN}/change", entry_id=entry.entry_id, kind="take", date=later)
    assert not r["success"] and r["error"]["code"] == "invalid"
    r = await _ws(client, type=f"{DOMAIN}/overview", entry_id="missing")
    assert not r["success"] and r["error"]["code"] == "not_found"
    r = await _ws(client, type=f"{DOMAIN}/change", entry_id=entry.entry_id, kind="count")
    assert not r["success"]


async def test_resources_list(hass, hass_ws_client, entry):
    client = await hass_ws_client(hass)
    r = await _ws(client, type=f"{DOMAIN}/resources")
    assert r["result"] == [{"entry_id": entry.entry_id, "name": "Toilet paper", "unit": "rolls",
                            "icon": "mdi:paper-roll", "low_level": 6}]


async def test_services(hass, entry):
    today = dt_util.now().date()
    await hass.services.async_call(DOMAIN, "restock", {"amount": 8, "date": today - timedelta(days=2),
                                                       "note": "Moved into storage"}, blocking=True)
    await hass.services.async_call(DOMAIN, "stocktake", {"count": 7}, blocking=True)
    await hass.services.async_call(DOMAIN, "take", {}, blocking=True)
    await hass.async_block_till_done()
    assert hass.states.get("sensor.toilet_paper_in_storage").state == "6"
    assert hass.states.get("binary_sensor.toilet_paper_running_low").state == "on"
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "take", {"date": today + timedelta(days=5)}, blocking=True)
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "take", {"entry_id": "nope"}, blocking=True)
