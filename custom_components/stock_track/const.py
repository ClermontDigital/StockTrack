"""Constants for Stock Track."""
from __future__ import annotations

DOMAIN = "stock_track"

CONF_NAME = "name"
CONF_UNIT = "unit"
CONF_ICON = "icon"
CONF_LOW = "low_level"          # "running low" at or below this many; 0 = off

DEFAULT_NAME = "Toilet paper"
DEFAULT_UNIT = "rolls"
DEFAULT_ICON = "mdi:paper-roll"

MAX_UNITS = 100_000             # in one go, and in storage
MAX_NOTE = 200
RATE_WINDOW = 30                # usage rates look back this many days ...
MIN_RATE_DAYS = 7               # ... once there's at least a week of tracking

KIND_TAKE = "take"              # out of storage, into use: what the usage rates count
KIND_ADD = "add"                # into storage: a restock
KIND_COUNT = "count"            # a stocktake: there are exactly this many in storage
KINDS = (KIND_TAKE, KIND_ADD, KIND_COUNT)

CARD_FILENAME = "stock-track-card.js"
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"

SIGNAL_UPDATED = f"{DOMAIN}_updated_{{}}"  # format with entry_id

SERVICE_TAKE = "take"
SERVICE_RESTOCK = "restock"
SERVICE_STOCKTAKE = "stocktake"
ATTR_ENTRY_ID = "entry_id"
ATTR_AMOUNT = "amount"
ATTR_COUNT = "count"
ATTR_DATE = "date"
ATTR_NOTE = "note"
