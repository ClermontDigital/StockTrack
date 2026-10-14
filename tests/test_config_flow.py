"""Adding and changing a resource."""
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType

from custom_components.stock_track.const import DOMAIN


async def test_add_toilet_paper_then_tinned_food(hass):
    r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert r["type"] is FlowResultType.FORM
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {
        "name": " Toilet paper ", "unit": "rolls", "icon": "mdi:paper-roll", "low_level": 8})
    assert r["type"] is FlowResultType.CREATE_ENTRY
    assert r["title"] == "Toilet paper" and r["data"] == {"name": "Toilet paper", "unit": "rolls"}
    assert r["options"] == {"icon": "mdi:paper-roll", "low_level": 8}

    r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"name": "toilet PAPER", "unit": "rolls"})
    assert r["type"] is FlowResultType.FORM and r["errors"] == {"name": "name_taken"}
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"name": "Tinned food", "unit": "  "})
    assert r["errors"] == {"unit": "unit_required"}
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"name": "Tinned food", "unit": "tins"})
    assert r["type"] is FlowResultType.CREATE_ENTRY and r["options"]["low_level"] == 0


async def test_options_change_the_icon_and_level_but_not_the_unit(hass):
    """The unit can't change: Home Assistant stops compiling a sensor's long-term statistics when it does."""
    r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"name": "Toilet paper", "unit": "rolls"})
    entry = hass.config_entries.async_get_entry(r["result"].entry_id)
    r = await hass.config_entries.options.async_init(entry.entry_id)
    assert "unit" not in r["data_schema"].schema
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"icon": "mdi:package", "low_level": 3})
    assert r["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options == {"icon": "mdi:package", "low_level": 3} and entry.data["unit"] == "rolls"
