"""Stock Track: keep count of household supplies (toilet paper, tinned food) and see how fast they go."""
from __future__ import annotations

import logging
from datetime import timedelta
from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_point_in_time
from homeassistant.util import dt as dt_util
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from .api import async_register_api
from .const import CARD_FILENAME, CARD_URL, DOMAIN, SIGNAL_UPDATED
from .services import async_register_services
from .storage import StockStore

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.BINARY_SENSOR, Platform.NUMBER, Platform.BUTTON]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    hass.data.setdefault(DOMAIN, {})
    async_register_api(hass)
    async_register_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store = StockStore(hass, entry.entry_id)
    await store.async_load()
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {"store": store}

    # "Today" starts again at zero, and the rates move on a day, at midnight even when nothing is logged.
    # Each refresh books the next for the start of the following local day, which is right even where a
    # clock change happens at midnight and that day has no 00:00.
    cancel = [lambda: None]

    @callback
    def _midnight(_now=None) -> None:
        if _now is not None:
            async_dispatcher_send(hass, SIGNAL_UPDATED.format(entry.entry_id))
        tomorrow = dt_util.now().date() + timedelta(days=1)
        cancel[0] = async_track_point_in_time(hass, _midnight, dt_util.start_of_local_day(tomorrow) + timedelta(seconds=5))

    _midnight()
    entry.async_on_unload(lambda: cancel[0]())
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    try:
        await _async_setup_frontend(hass)
    except Exception:  # noqa: BLE001 - the tracker works without the card being auto-registered
        _LOGGER.warning("Stock Track: card setup failed", exc_info=True)
    return True


async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """A new unit, icon or running-low level shows straight away, and a renamed resource renames its device."""
    registry = dr.async_get(hass)
    for device in dr.async_entries_for_config_entry(registry, entry.entry_id):
        if device.name != entry.title:
            registry.async_update_device(device.id, name=entry.title)
    async_dispatcher_send(hass, SIGNAL_UPDATED.format(entry.entry_id))


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return ok


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Deleting a resource deletes its log too, and the last one takes the card's dashboard resource with it."""
    await StockStore(hass, entry.entry_id).async_remove()
    if not hass.config_entries.async_entries(DOMAIN):
        await _async_remove_resource(hass)
        hass.data.get(DOMAIN, {}).pop("_frontend", None)   # so a resource added later registers it again


async def _async_setup_frontend(hass: HomeAssistant) -> None:
    """Serve the bundled card and make sure dashboards load it (once per HA run)."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("_frontend"):
        return
    domain_data["_frontend"] = True

    card_path = Path(__file__).parent / "www" / CARD_FILENAME
    if not await hass.async_add_executor_job(card_path.is_file):
        _LOGGER.warning("Stock Track: the card's file is missing (%s), so dashboards won't load it", card_path)
        return
    try:
        version = (await async_get_integration(hass, DOMAIN)).version
    except Exception:  # noqa: BLE001
        version = None
    url = f"{CARD_URL}?v={version}" if version else CARD_URL
    try:
        await hass.http.async_register_static_paths([StaticPathConfig(CARD_URL, str(card_path), False)])
    except Exception:  # noqa: BLE001 - already registered after a reload
        _LOGGER.debug("Stock Track: card path already registered")
    if not await _async_register_resource(hass, url):
        try:
            frontend.add_extra_js_url(hass, url)
        except Exception:  # noqa: BLE001 - frontend not loaded (tests, minimal installs)
            _LOGGER.warning("Stock Track: couldn't auto-load the card; add %s as a dashboard resource", CARD_URL)


async def _async_resources(hass: HomeAssistant):
    """The storage-mode dashboard resource collection, loaded, or None when there isn't one."""
    from homeassistant.components.lovelace import LOVELACE_DATA

    resources = getattr(hass.data.get(LOVELACE_DATA), "resources", None)
    if resources is None or not hasattr(resources, "async_create_item"):
        return None
    if hasattr(resources, "loaded") and not resources.loaded:
        await resources.async_load()
    return resources


async def _async_remove_resource(hass: HomeAssistant) -> None:
    try:
        resources = await _async_resources(hass)
        for item in list(resources.async_items()) if resources else []:
            if item.get("url", "").split("?")[0] == CARD_URL:
                await resources.async_delete_item(item["id"])
    except Exception:  # noqa: BLE001 - a left-over resource is harmless
        _LOGGER.debug("Stock Track: couldn't remove the card resource", exc_info=True)


async def _async_register_resource(hass: HomeAssistant, url: str) -> bool:
    """Add or refresh the Lovelace resource so storage-mode dashboards load the card."""
    try:
        resources = await _async_resources(hass)
        if resources is None:
            return False
        base = url.split("?")[0]
        for item in resources.async_items():
            existing = item.get("url", "")
            if existing.split("?")[0] == base:
                if existing != url:
                    await resources.async_update_item(item["id"], {"url": url})
                return True
        await resources.async_create_item({"res_type": "module", "url": url})
        return True
    except Exception:  # noqa: BLE001 - the card can still be added by hand
        _LOGGER.warning("Stock Track: couldn't register the card resource", exc_info=True)
        return False
