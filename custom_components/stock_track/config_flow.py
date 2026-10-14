"""Config flow: one entry per resource (toilet paper, tinned food, ...)."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_ICON, CONF_LOW, CONF_NAME, CONF_UNIT, DEFAULT_ICON, DEFAULT_NAME, DEFAULT_UNIT, DOMAIN, MAX_UNITS,
)


def _low() -> selector.NumberSelector:
    return selector.NumberSelector(selector.NumberSelectorConfig(
        min=0, max=MAX_UNITS, step=1, mode=selector.NumberSelectorMode.BOX))


def _settings_schema(current: dict[str, Any]) -> dict:
    """What can be changed later. The unit can't: the sensors' long-term statistics are kept in it, and
    Home Assistant stops compiling them when a sensor's unit changes."""
    return {
        vol.Optional(CONF_ICON, default=current.get(CONF_ICON, DEFAULT_ICON)): selector.IconSelector(),
        vol.Optional(CONF_LOW, default=current.get(CONF_LOW, 0)): _low(),
    }


def _options(user_input: dict[str, Any]) -> dict[str, Any]:
    return {CONF_ICON: user_input.get(CONF_ICON) or DEFAULT_ICON, CONF_LOW: int(user_input.get(CONF_LOW) or 0)}


class StockTrackConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            name = user_input[CONF_NAME].strip()
            unit = (user_input.get(CONF_UNIT) or "").strip()
            if not name:
                errors[CONF_NAME] = "name_required"
            elif any(e.title.casefold() == name.casefold() for e in self._async_current_entries()):
                errors[CONF_NAME] = "name_taken"
            if not unit:
                errors[CONF_UNIT] = "unit_required"
            if not errors:
                return self.async_create_entry(title=name, data={CONF_NAME: name, CONF_UNIT: unit},
                                               options=_options(user_input))
        current = user_input or {}
        schema = vol.Schema({
            vol.Required(CONF_NAME, default=current.get(CONF_NAME, DEFAULT_NAME)): str,
            vol.Required(CONF_UNIT, default=current.get(CONF_UNIT, DEFAULT_UNIT)): str,
            **_settings_schema(current),
        })
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return StockTrackOptionsFlow()


class StockTrackOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=_options(user_input))
        current = {**self.config_entry.data, **self.config_entry.options}
        return self.async_show_form(step_id="init", data_schema=vol.Schema(_settings_schema(current)))
