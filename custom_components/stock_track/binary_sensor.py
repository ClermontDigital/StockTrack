"""On when what's in storage is at or below the resource's "running low" level."""
from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import ResourceEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([RunningLow(hass, entry)])


class RunningLow(ResourceEntity, BinarySensorEntity):
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, entry, "running_low")

    @property
    def is_on(self) -> bool:
        return self.stats().running_low

    @property
    def icon(self) -> str:
        return "mdi:alert-circle-outline" if self.is_on else "mdi:check-circle-outline"

    @property
    def extra_state_attributes(self) -> dict[str, int | None]:
        s = self.stats()
        return {"low_level": s.low_level or None, "in_storage": s.in_storage}
