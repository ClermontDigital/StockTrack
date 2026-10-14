"""Sensors for dashboards, graphs and automations."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import engine
from .entity import ResourceEntity

PER_WEEK = "{unit}/week"


@dataclass(frozen=True)
class SensorSpec:
    key: str
    value: Callable[[engine.Stats], Any]
    unit: str | None = "{unit}"      # "{unit}" is the resource's own unit, such as rolls
    icon: str | None = None          # None: the resource's icon
    state_class: SensorStateClass | None = SensorStateClass.MEASUREMENT
    device_class: SensorDeviceClass | None = None
    precision: int | None = 0


def _when(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


SPECS = [
    SensorSpec("in_storage", lambda s: s.in_storage),
    SensorSpec("used_today", lambda s: s.used_today, icon="mdi:tray-arrow-up"),
    SensorSpec("used_last_7_days", lambda s: s.used_last_7_days, icon="mdi:calendar-week"),
    SensorSpec("used_this_month", lambda s: s.used_this_month, icon="mdi:calendar-month"),
    # A running total, so Home Assistant's long-term statistics can chart use per day, week or month.
    SensorSpec("used_total", lambda s: s.used_total, icon="mdi:counter", state_class=SensorStateClass.TOTAL),
    SensorSpec("weekly_use", lambda s: s.per_week, unit=PER_WEEK, icon="mdi:chart-line", precision=1),
    SensorSpec("days_between", lambda s: s.days_between, unit=UnitOfTime.DAYS, icon="mdi:calendar-refresh",
               device_class=SensorDeviceClass.DURATION, precision=1),
    SensorSpec("days_left", lambda s: s.days_left, unit=UnitOfTime.DAYS, icon="mdi:timer-sand",
               device_class=SensorDeviceClass.DURATION, precision=0),
    SensorSpec("last_taken", lambda s: _when(s.last_taken), unit=None, icon="mdi:clock-outline",
               state_class=None, device_class=SensorDeviceClass.TIMESTAMP, precision=None),
    SensorSpec("last_restock", lambda s: s.last_restock, unit=None, icon="mdi:tray-arrow-down",
               state_class=None, device_class=SensorDeviceClass.DATE, precision=None),
]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities(ResourceSensor(hass, entry, spec) for spec in SPECS)


class ResourceSensor(ResourceEntity, SensorEntity):
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, spec: SensorSpec) -> None:
        super().__init__(hass, entry, spec.key)
        self._spec = spec
        self._attr_state_class = spec.state_class
        self._attr_device_class = spec.device_class
        if spec.precision is not None:
            self._attr_suggested_display_precision = spec.precision

    @property
    def native_unit_of_measurement(self) -> str | None:
        return self._spec.unit.format(unit=self.unit) if self._spec.unit else None

    @property
    def icon(self) -> str | None:
        return self._spec.icon or self.resource_icon

    @property
    def native_value(self) -> Any:
        return self._spec.value(self.stats())

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        if self._spec.key != "in_storage":
            return None
        s = self.stats()
        return {"low_level": s.low_level or None, "last_stocktake": s.last_stocktake,
                "last_stocktake_count": s.last_stocktake_count, "tracking_since": s.tracking_since}
