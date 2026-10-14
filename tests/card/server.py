"""Serve the Stock Track card against the integration's real WebSocket handlers, storage rules and calculations,
with made-up data.

Each message the card sends is checked against the command's real schema and handled by the real function in
api.py, over a stand-in connection, with an in-memory StockStore. No Home Assistant instance is needed, only
the package (it's installed by requirements_test.txt). Used by drive.cjs; also handy for looking at the card by hand:

    python tests/card/server.py        # then open http://127.0.0.1:8798/

Test hooks: /reset?data=demo|fresh|empty|none, /config?low=N&unit=U, /fail?n=N (the next N writes fail),
/readonly?on=1 (a user who can look but not change), /unload?on=1 (Home Assistant up but Stock Track not loaded,
as during a restart), /remove?entry=demo (a resource deleted), /store?entry=demo, /log, and POST /ws?quiet for a write
from "another device" that isn't logged or failed. CARD=path serves another copy of the card (the mutation checks).
"""
import asyncio
import json
import os
import random
import sys
import threading
from datetime import date, datetime, time, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
from homeassistant.util import dt as dt_util  # noqa: E402  (first: Home Assistant swaps in its own voluptuous)
import voluptuous as vol  # noqa: E402
from voluptuous.humanize import humanize_error  # noqa: E402

# Home Assistant's "today" is this machine's, as the browser's is.
_zone = os.path.realpath("/etc/localtime").partition("zoneinfo/")[2]
dt_util.set_default_time_zone(dt_util.get_time_zone(_zone) if _zone else datetime.now().astimezone().tzinfo)

from custom_components.stock_track import api, engine  # noqa: E402
from custom_components.stock_track.const import DOMAIN  # noqa: E402
from custom_components.stock_track.storage import StockStore  # noqa: E402

PORT = int(os.environ.get("PORT", "8798"))
CARD = Path(os.environ.get("CARD") or REPO / "custom_components/stock_track/www/stock-track-card.js")
HANDLERS = {f._ws_command: f for f in vars(api).values() if callable(f) and hasattr(f, "_ws_command")}
READS = {"resources", "overview", "events", "subscribe"}
FAILURE = "Saving to Home Assistant failed (a made-up failure for the test). Try again."
LOOP = asyncio.new_event_loop()
# Requests are served on threads (Chrome holds idle connections open, which would stall a single-threaded server),
# but handled one at a time, as Home Assistant's event loop would.
LOCK = threading.Lock()


def entry(entry_id: str, title: str, unit: str, icon: str, low: int) -> SimpleNamespace:
    return SimpleNamespace(entry_id=entry_id, domain=DOMAIN, title=title, data={"name": title, "unit": unit},
                           options={"icon": icon, "low_level": low})


class Log:
    """Builds events in the shape StockStore writes them, at made-up times of day."""

    def __init__(self, seed: int) -> None:
        self.rng = random.Random(seed)
        self.events: list[dict] = []

    def add(self, day: date, kind: str, n: int, hour: int, minute: int = 0, note: str = "", put_back: bool = False):
        when = datetime.combine(day, time(hour, minute, self.rng.randrange(60)), dt_util.DEFAULT_TIME_ZONE)
        event = {"id": "%012x" % self.rng.getrandbits(48), "seq": len(self.events) + 1,
                 "ts": when.astimezone(timezone.utc).isoformat(timespec="seconds"), "date": day.isoformat(),
                 "kind": kind, "n": n, "by": "made-up-user"}
        if note:
            event["note"] = note
        if put_back:
            event["put_back"] = True
        self.events.append(event)


def earlier_today(hours: int) -> tuple[int, int]:
    """A time a few hours ago, still today, so today's made-up entries aren't in the future."""
    now = datetime.now()
    then = max(now - timedelta(hours=hours), now.replace(hour=0, minute=5))
    return then.hour, then.minute


def household(today: date) -> tuple[list[dict], dict[str, str]]:
    """Four months of a two-person household with a bidet: a roll every few days, more with visitors,
    a restock whenever the cupboard gets low, and a recount that found one fewer than the log said."""
    log = Log(11)
    start = today - timedelta(days=118)
    log.add(start, "count", 22, 19, 10, "First count, hall cupboard")
    level, big = 22, False
    for back in range(117, 0, -1):
        day = today - timedelta(days=back)
        takes = int(log.rng.random() < 0.22) + int(log.rng.random() < 0.03)
        takes = {19: 1, 18: 2, 17: 2, 16: 0, 12: 1}.get(back, takes)   # visitors for a long weekend; the restock day
        for _ in range(takes):
            log.add(day, "take", 1, log.rng.choice([6, 7, 8, 12, 17, 19, 20, 21]), log.rng.randrange(60))
        level -= takes
        if back == 23:
            level -= 1
            log.add(day, "count", level, 20, 15, "Recount: one fewer than the log said")
        if back == 12:
            log.add(day, "add", 24, 17, 40, "Bulk pack on special")
            level += 24
        elif level <= 7 and back > 12:
            big = not big
            n = 18 if big else 12
            log.add(day, "add", n, 17, 40)
            level += n
        if back == 9:
            log.add(day, "add", 1, 21, 5, put_back=True)   # one back from the bathroom shelf, unused
            level += 1
    log.add(today, "take", 1, *earlier_today(3))
    notes = {(today - timedelta(days=19)).isoformat(): "Visitors for the long weekend",
             (today - timedelta(days=12)).isoformat(): "Two 12-packs from the wholesaler"}
    return engine.ordered(log.events), notes


def pantry(today: date) -> tuple[list[dict], dict[str, str]]:
    """A second resource, to show nothing in the card is about toilet paper."""
    log = Log(5)
    log.add(today - timedelta(days=30), "count", 14, 18, 0)
    for back in range(29, 0, -1):
        for _ in range(sum(log.rng.random() < 0.4 for _ in range(1))):
            log.add(today - timedelta(days=back), "take", 1, 18, log.rng.randrange(60))
        if back == 8:
            log.add(today - timedelta(days=back), "add", 6, 11, 30)
    return engine.ordered(log.events), {}


def fresh(today: date) -> tuple[list[dict], dict[str, str]]:
    """Day one: a restock two days ago (before tracking began), then the first stocktake today."""
    log = Log(3)
    log.add(today - timedelta(days=2), "add", 8, 15, 0, "Moved into the cupboard")
    log.add(today, "count", 23, *earlier_today(1))
    return engine.ordered(log.events), {}


class Memory:
    async def async_save(self, data): ...
    async def async_remove(self): ...


def new_store(events: list[dict], notes: dict[str, str]) -> StockStore:
    store = StockStore.__new__(StockStore)      # the real class, without Home Assistant's file store behind it
    store._store, store._lock, store.events, store.notes = Memory(), asyncio.Lock(), events, notes
    return store


class Entries:
    def async_get_entry(self, entry_id):
        return STATE["entries"].get(entry_id)

    def async_entries(self, domain=None):
        return list(STATE["entries"].values())


# Enough of Home Assistant for the handlers: config entries, hass.data, and an event-loop check.
HASS = SimpleNamespace(data={}, config_entries=Entries(), verify_event_loop_thread=lambda _what: None)
# Who may log is decided from the Take one button's entity; a stand-in registry finds it.
api.er = SimpleNamespace(async_get=lambda _hass: SimpleNamespace(
    async_get_entity_id=lambda domain, platform, unique_id: f"{domain}.{unique_id}"))
STATE: dict = {}


def reset(data: str = "demo") -> None:
    today = dt_util.now().date()
    entries, stores = {}, {}
    if data != "none":
        entries["demo"] = entry("demo", "Toilet paper", "rolls", "mdi:paper-roll", 6)
        stores["demo"] = new_store(*{"demo": household, "fresh": fresh}.get(data, lambda _t: ([], {}))(today))
        if data == "demo":
            entries["tins"] = entry("tins", "Tinned food", "tins", "mdi:food-variant", 4)
            stores["tins"] = new_store(*pantry(today))
    STATE.update(entries=entries, log=[], fail=0, readonly=False, id=0, unloaded=False)
    HASS.data.clear()
    HASS.data[DOMAIN] = {k: {"store": s} for k, s in stores.items()}


class Connection:
    def __init__(self, readonly: bool) -> None:
        self.user = SimpleNamespace(id="harness-user", is_admin=not readonly,
                                    permissions=SimpleNamespace(check_entity=lambda _entity_id, _policy: False))
        self.subscriptions: dict = {}
        self.reply = (500, {"code": "no_reply", "message": "The handler didn't answer"})

    def send_result(self, _msg_id, result=None):
        self.reply = (200, result)

    def send_error(self, _msg_id, code, message):
        self.reply = (400, {"code": code, "message": message})

    def send_message(self, _message):   # subscription events: the page stands these in with window.notify()
        ...


def handle(msg: dict, logged: bool = True) -> tuple[int, object]:
    """One WebSocket command, the way Home Assistant's connection handles it. The card's writes are logged
    (and can be made to fail); `logged=False` is for the tests' own writes, standing in for another device."""
    STATE["id"] += 1
    msg = {**msg, "id": STATE["id"]}
    handler = HANDLERS.get(msg.get("type"))
    if handler is None:
        return 400, {"code": "unknown_command", "message": "Unknown command."}
    if STATE.get("unloaded"):   # Home Assistant restarting: up, but Stock Track not loaded yet
        return 400, {"code": "unknown_command", "message": "Unknown command."}
    write = msg["type"].split("/", 1)[1] not in READS
    if write and logged:
        STATE["log"].append({k: v for k, v in msg.items() if k != "id"})
        if STATE["fail"] > 0:
            STATE["fail"] -= 1
            return 400, {"code": "home_assistant_error", "message": FAILURE}
    if schema := getattr(handler, "_ws_schema", False):
        try:
            msg = schema(msg)
        except vol.Invalid as err:
            return 400, {"code": "invalid_format", "message": humanize_error(msg, err)}
    connection = Connection(STATE["readonly"])
    result = getattr(handler, "__wrapped__", handler)(HASS, connection, msg)
    if asyncio.iscoroutine(result):
        LOOP.run_until_complete(result)
    return connection.reply


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): ...

    def _send(self, body: bytes, ctype: str = "application/json", code: int = 200) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, value, code: int = 200) -> None:
        self._send(json.dumps(value).encode(), code=code)

    def do_GET(self):
        with LOCK:
            self._get()

    def _get(self):
        url = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        if url.path == "/card.js":
            self._send(CARD.read_bytes(), "text/javascript")
        elif url.path == "/log":
            self._json(STATE["log"])
        elif url.path == "/store":
            store = HASS.data[DOMAIN][q.get("entry", "demo")]["store"]
            self._json({"events": store.events, "notes": store.notes, "in_storage": engine.replay(store.events)[0]})
        elif url.path == "/reset":
            reset(q.get("data", "demo"))
            self._json({})
        elif url.path == "/fail":
            STATE["fail"] = int(q.get("n", 1))
            self._json({})
        elif url.path == "/readonly":
            STATE["readonly"] = q.get("on", "1") == "1"
            self._json({})
        elif url.path == "/unload":
            STATE["unloaded"] = q.get("on", "1") == "1"
            self._json({})
        elif url.path == "/remove":   # a resource deleted in Settings
            STATE["entries"].pop(q["entry"], None)
            HASS.data[DOMAIN].pop(q["entry"], None)
            self._json({})
        elif url.path == "/config":
            found = STATE["entries"][q.get("entry", "demo")]
            if "low" in q:
                found.options["low_level"] = int(q["low"])
            if "unit" in q:
                found.data["unit"] = q["unit"]
            self._json(api.settings(found))
        else:
            self._send((Path(__file__).parent / "index.html").read_bytes(), "text/html")

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with LOCK:
            code, body = handle(msg, logged="quiet" not in urlparse(self.path).query)
        self._json(body, code)


if __name__ == "__main__":
    reset()
    print(f"Stock Track card harness on http://127.0.0.1:{PORT}/  "
          "(?theme=light|dark|navy, ?view=calendar, ?weeks=8, ?entry=tins, ?hide_title=1, ?w=300)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
