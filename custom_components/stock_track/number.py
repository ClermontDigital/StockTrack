"""What's in storage as a number you can set. Setting it records a stocktake."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import MAX_UNITS
from .entity import ResourceEntity
from .storage import InvalidEntry


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([StocktakeNumber(hass, entry)])


class StocktakeNumber(ResourceEntity, NumberEntity):
    _attr_native_min_value = 0
    _attr_native_max_value = MAX_UNITS
    _attr_native_step = 1
    _attr_mode = NumberMode.BOX

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, entry, "stocktake")

    @property
    def native_unit_of_measurement(self) -> str:
        return self.unit

    @property
    def icon(self) -> str:
        return self.resource_icon

    @property
    def native_value(self) -> float | None:
        return self.stats().in_storage

    async def async_set_native_value(self, value: float) -> None:
        try:
            await self.store.async_stocktake(int(value), self.today, self.today, None, self.user_id)
        except InvalidEntry as err:
            raise ServiceValidationError(str(err)) from err
        self.notify_changed()
