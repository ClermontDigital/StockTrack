"""stock_track.take / restock / stocktake, for automations, scripts and voice."""
from __future__ import annotations

from datetime import date

import voluptuous as vol

from homeassistant.auth.permissions.const import POLICY_CONTROL
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import ServiceValidationError, Unauthorized
from homeassistant.helpers import config_validation as cv
from homeassistant.util import dt as dt_util

from .api import can_change, changed, resources, store_of
from .const import (
    ATTR_AMOUNT, ATTR_COUNT, ATTR_DATE, ATTR_ENTRY_ID, ATTR_NOTE, DOMAIN, KIND_ADD, KIND_TAKE, MAX_NOTE, MAX_UNITS,
    SERVICE_RESTOCK, SERVICE_STOCKTAKE, SERVICE_TAKE,
)
from .storage import InvalidEntry, check_day

TAKE_SCHEMA = vol.Schema({
    vol.Optional(ATTR_ENTRY_ID): cv.string,
    vol.Optional(ATTR_AMOUNT, default=1): vol.All(vol.Coerce(int), vol.Range(min=1, max=MAX_UNITS)),
    vol.Optional(ATTR_DATE): cv.date,
    vol.Optional(ATTR_NOTE): vol.All(cv.string, vol.Length(max=MAX_NOTE)),
})
RESTOCK_SCHEMA = TAKE_SCHEMA
STOCKTAKE_SCHEMA = vol.Schema({
    vol.Optional(ATTR_ENTRY_ID): cv.string,
    vol.Required(ATTR_COUNT): vol.All(vol.Coerce(int), vol.Range(min=0, max=MAX_UNITS)),
    vol.Optional(ATTR_DATE): cv.date,
    vol.Optional(ATTR_NOTE): vol.All(cv.string, vol.Length(max=MAX_NOTE)),
})


async def _resource(hass: HomeAssistant, call: ServiceCall) -> str:
    """The resource the call is for: the one named, or the only one there is. The person calling (if it's a
    person, not an automation) needs the same permission as for pressing its Take one button."""
    loaded = resources(hass)
    if entry_id := call.data.get(ATTR_ENTRY_ID):
        if entry_id not in {e.entry_id for e in loaded}:
            raise ServiceValidationError("That resource isn't set up in Stock Track")
    elif len(loaded) == 1:
        entry_id = loaded[0].entry_id
    else:
        raise ServiceValidationError(
            "Choose a resource: there is more than one" if loaded else "Add a resource to Stock Track first")
    if call.context.user_id:
        user = await hass.auth.async_get_user(call.context.user_id)
        if not can_change(hass, user, entry_id):
            raise Unauthorized(context=call.context, permission=POLICY_CONTROL)
    return entry_id


def _day(call: ServiceCall, today: date) -> date:
    day = call.data.get(ATTR_DATE) or today
    try:
        check_day(day, today)
    except InvalidEntry as err:
        raise ServiceValidationError(str(err)) from err
    return day


@callback
def async_register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, SERVICE_TAKE):
        return

    def _change(kind: str):
        async def handler(call: ServiceCall) -> None:
            entry_id = await _resource(hass, call)
            today = dt_util.now().date()
            try:
                await store_of(hass, entry_id).async_change(
                    kind, _day(call, today), today, call.data[ATTR_AMOUNT], call.data.get(ATTR_NOTE),
                    call.context.user_id)
            except InvalidEntry as err:
                raise ServiceValidationError(str(err)) from err
            changed(hass, entry_id)
        return handler

    async def stocktake(call: ServiceCall) -> None:
        entry_id = await _resource(hass, call)
        today = dt_util.now().date()
        try:
            await store_of(hass, entry_id).async_stocktake(
                call.data[ATTR_COUNT], _day(call, today), today, call.data.get(ATTR_NOTE), call.context.user_id)
        except InvalidEntry as err:
            raise ServiceValidationError(str(err)) from err
        changed(hass, entry_id)

    hass.services.async_register(DOMAIN, SERVICE_TAKE, _change(KIND_TAKE), schema=TAKE_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_RESTOCK, _change(KIND_ADD), schema=RESTOCK_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_STOCKTAKE, stocktake, schema=STOCKTAKE_SCHEMA)
