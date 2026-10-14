"""Shared base for a resource's entities."""
from __future__ import annotations

from datetime import date

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity
from homeassistant.util import dt as dt_util

from . import engine
from .api import changed, settings, store_of
from .const import DOMAIN, SIGNAL_UPDATED
from .storage import StockStore


class ResourceEntity(Entity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, key: str) -> None:
        self.hass = hass
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_translation_key = key
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Stock Track",
            entry_type=DeviceEntryType.SERVICE,
        )

    @property
    def store(self) -> StockStore:
        return store_of(self.hass, self._entry.entry_id)

    @property
    def unit(self) -> str:
        return settings(self._entry)["unit"]

    @property
    def resource_icon(self) -> str:
        return settings(self._entry)["icon"]

    @property
    def today(self) -> date:
        return dt_util.now().date()

    def stats(self) -> engine.Stats:
        return engine.stats(self.store.events, self.today, settings(self._entry)["low_level"])

    @callback
    def notify_changed(self) -> None:
        changed(self.hass, self._entry.entry_id)

    @property
    def user_id(self) -> str | None:
        return self._context.user_id if self._context else None

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(
            self.hass, SIGNAL_UPDATED.format(self._entry.entry_id), self._refresh))

    @callback
    def _refresh(self) -> None:
        self.async_write_ha_state()
