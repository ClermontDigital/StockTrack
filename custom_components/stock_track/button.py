"""One-press logging: handy for a dashboard button, an NFC tag on the cupboard or a voice command."""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import KIND_TAKE
from .entity import ResourceEntity
from .storage import InvalidEntry


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([TakeOne(hass, entry), PutBack(hass, entry)])


class TakeOne(ResourceEntity, ButtonEntity):
    """One out of storage, into use."""
    _attr_icon = "mdi:tray-arrow-up"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, entry, "take_one")

    async def async_press(self) -> None:
        try:
            await self.store.async_change(KIND_TAKE, self.today, self.today, 1, None, self.user_id)
        except InvalidEntry as err:
            raise ServiceValidationError(str(err)) from err
        self.notify_changed()


class PutBack(ResourceEntity, ButtonEntity):
    """One back into storage: undoes one of today's takes, or with none to undo, records one put back."""
    _attr_icon = "mdi:tray-arrow-down"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, entry, "put_back")

    async def async_press(self) -> None:
        try:
            await self.store.async_put_back(self.today, self.today, self.user_id)
        except InvalidEntry as err:
            raise ServiceValidationError(str(err)) from err
        self.notify_changed()
