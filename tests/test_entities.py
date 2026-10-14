"""Sensors, buttons and the stocktake number."""
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from custom_components.stock_track.const import DOMAIN


@pytest.fixture
async def entry(hass: HomeAssistant):
    e = MockConfigEntry(domain=DOMAIN, title="Toilet paper", data={"name": "Toilet paper", "unit": "rolls"},
                        options={"icon": "mdi:paper-roll", "low_level": 0})
    e.add_to_hass(hass)
    assert await hass.config_entries.async_setup(e.entry_id)
    await hass.async_block_till_done()
    return e


async def test_entities_and_units(hass, entry):
    ids = sorted(e.entity_id for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id))
    assert ids == sorted([
        "binary_sensor.toilet_paper_running_low", "button.toilet_paper_put_one_back", "button.toilet_paper_take_one",
        "number.toilet_paper_stocktake", "sensor.toilet_paper_days_between",
        "sensor.toilet_paper_in_storage", "sensor.toilet_paper_last_restock", "sensor.toilet_paper_last_taken",
        "sensor.toilet_paper_supply_left", "sensor.toilet_paper_used_last_7_days",
        "sensor.toilet_paper_used_this_month", "sensor.toilet_paper_used_today", "sensor.toilet_paper_used_total",
        "sensor.toilet_paper_weekly_use"])
    s = hass.states.get("sensor.toilet_paper_in_storage")
    assert s.state == "unknown" and s.attributes["unit_of_measurement"] == "rolls"
    assert s.attributes["icon"] == "mdi:paper-roll"
    assert hass.states.get("sensor.toilet_paper_weekly_use").attributes["unit_of_measurement"] == "rolls/week"
    assert hass.states.get("sensor.toilet_paper_used_total").attributes["state_class"] == "total"


async def test_stocktake_number_and_buttons(hass, entry):
    await hass.services.async_call("number", "set_value", {"entity_id": "number.toilet_paper_stocktake",
                                                           "value": 37}, blocking=True)
    assert hass.states.get("sensor.toilet_paper_in_storage").state == "37"
    await hass.services.async_call("button", "press", {"entity_id": "button.toilet_paper_take_one"}, blocking=True)
    await hass.services.async_call("button", "press", {"entity_id": "button.toilet_paper_take_one"}, blocking=True)
    assert hass.states.get("sensor.toilet_paper_in_storage").state == "35"
    assert hass.states.get("sensor.toilet_paper_used_today").state == "2"
    assert hass.states.get("sensor.toilet_paper_last_taken").state not in ("unknown", "unavailable")
    # Put back undoes today's takes first ...
    await hass.services.async_call("button", "press", {"entity_id": "button.toilet_paper_put_one_back"}, blocking=True)
    assert hass.states.get("sensor.toilet_paper_used_today").state == "1"
    await hass.services.async_call("button", "press", {"entity_id": "button.toilet_paper_put_one_back"}, blocking=True)
    assert hass.states.get("sensor.toilet_paper_used_today").state == "0"
    # ... and with none to undo, one goes back into storage. That's not a restock.
    await hass.services.async_call("button", "press", {"entity_id": "button.toilet_paper_put_one_back"}, blocking=True)
    assert hass.states.get("sensor.toilet_paper_in_storage").state == "38"
    assert hass.states.get("sensor.toilet_paper_last_restock").state == "unknown"


async def test_options_change_icon_and_low_level(hass, entry):
    hass.config_entries.async_update_entry(entry, options={"icon": "mdi:package", "low_level": 40})
    await hass.async_block_till_done()
    await hass.services.async_call(DOMAIN, "stocktake", {"count": 37}, blocking=True)
    s = hass.states.get("sensor.toilet_paper_in_storage")
    assert s.attributes["unit_of_measurement"] == "rolls" and s.attributes["icon"] == "mdi:package"
    assert hass.states.get("binary_sensor.toilet_paper_running_low").state == "on"


async def test_removing_the_entry_removes_its_log(hass, entry):
    await hass.services.async_call(DOMAIN, "stocktake", {"count": 5}, blocking=True)
    await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    again = MockConfigEntry(domain=DOMAIN, title="Toilet paper", data={"name": "Toilet paper", "unit": "rolls"},
                            entry_id=entry.entry_id)
    again.add_to_hass(hass)
    assert await hass.config_entries.async_setup(again.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get("sensor.toilet_paper_in_storage").state == "unknown"
