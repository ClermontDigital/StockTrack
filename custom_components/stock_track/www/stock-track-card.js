/* Stock Track card - keep count of a household supply and see how fast it goes.
 * Buildless: plain JS custom element, served by the stock_track integration.
 * Colours come from the Home Assistant theme; set --stock-track-accent to change the accent
 * (or --st-accent on ha-card, from card-mod).
 */
const ST_VERSION = "0.1.1";

const ST_MAX = 100000;                // the most the integration takes in one go
const ST_UNIT = "rolls";              // only used if a resource somehow comes without a unit or icon of its own
const ST_ICON = "mdi:paper-roll";
const ST_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ST_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ST_OFFLINE = "Couldn't reach Home Assistant. Check the connection and try again.";
const ST_GONE = "This card's resource no longer exists. Pick another in the card's settings.";
const ST_STARTING = "Waiting for Stock Track to load in Home Assistant…";
const ST_EDITS = new Set(["day-take", "day-back", "add-save", "count-save", "del"]);   // the day editor's own taps
const stEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stParse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const stIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const stShift = (s, n) => { const d = stParse(s); d.setDate(d.getDate() + n); return stIso(d); };
const stShort = (s) => { const d = stParse(s); return `${d.getDate()} ${ST_MONTHS[d.getMonth()]}`; };
const stLong = (s) => { const d = stParse(s); return `${ST_WEEKDAYS[d.getDay()]} ${d.getDate()} ${ST_MONTHS[d.getMonth()]}`; };
const stNum = (n) => Number(n).toLocaleString();
const stDec = (n) => { const r = Math.round(Number(n) * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
// How long the supply lasts, in the unit a person would say it in.
const stLasts = (d) => (d < 14 ? `${d} ${d === 1 ? "day" : "days"}` : d < 63 ? `${Math.round(d / 7)} weeks`
  : d < 730 ? `${Math.round(d / 30.44)} months` : `${Math.round(d / 365.25)} years`);
// Something filled in later for an earlier day (`backdated`) has a stand-in time, so no time is shown for it.
const stTime = (e) => {
  const d = new Date(e.ts);
  if (Number.isNaN(d.getTime()) || e.backdated) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};
const stClock = (ts) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
// Home Assistant's connection rejects with a bare number when the socket is down.
const stMessage = (err) => (err && typeof err === "object" && err.message ? String(err.message) : ST_OFFLINE);
// A spreadsheet treats a cell starting with one of these as a formula.
const stCsvText = (s) => `"${(/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;
// Text on the accent: dark or light, whichever reads better on it (WCAG contrast).
const ST_DARK = [5, 36, 30];
const ST_LABEL_RGB = [255, 253, 245];   // --st-label, the pale end of a used day's canister
const stRgb = (css) => {
  const n = String(css).match(/-?[\d.]+/g)?.map(Number);
  if (!n || n.length < 3) return null;
  return /^color\(/.test(css) ? n.slice(0, 3).map((c) => c * 255) : n.slice(0, 3);
};
const stLum = (rgb) => rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const stContrast = (a, b) => { const x = stLum(a); const y = stLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const stLightText = (rgb) => stContrast(rgb, [255, 255, 255]) > stContrast(rgb, ST_DARK);
const stMix = (a, b, p) => a.map((c, i) => c * p + b[i] * (1 - p));

// Bring what's on screen (`from`) into line with what was just drawn (`to`), keeping every element that is still
// the same thing. So a redraw never takes focus, the caret or a half-typed value out of a box (and a phone's
// keyboard stays up), and never swaps out a button under a finger.
const stKey = (n) => (n.nodeType === 1 ? `${n.tagName}|${n.dataset.act || ""}|${n.dataset.date || ""}|${n.dataset.field || ""}|${n.dataset.id || ""}` : `#${n.nodeType}`);
function stMorph(from, to) {
  const old = [...from.childNodes];
  const now = [...to.childNodes];
  now.forEach((n, i) => {
    const o = old[i];
    if (!o) { from.appendChild(n); return; }
    if (stKey(o) !== stKey(n)) { from.replaceChild(n, o); return; }
    if (o.nodeType !== 1) { if (o.data !== n.data) o.data = n.data; return; }
    for (const { name } of [...o.attributes]) if (!n.hasAttribute(name)) o.removeAttribute(name);
    for (const { name, value } of [...n.attributes]) if (o.getAttribute(name) !== value) o.setAttribute(name, value);
    if (o.tagName === "INPUT") { if (o !== o.getRootNode().activeElement && o.value !== n.value) o.value = n.value; return; }
    if (!o.tagName.includes("-")) stMorph(o, n);   // a custom element (ha-icon) draws its own inside
  });
  for (let i = now.length; i < old.length; i++) old[i].remove();
}

// A change on its way to Home Assistant, shown straight away on top of the last overview. Home Assistant's
// answer replaces it; anything this can't know for sure (the level after a change to an earlier day that a
// later stocktake overrides, say) is left alone until then.
function stApply(v, op) {
  const s = v.stats;
  const day = v.day.date === op.date ? v.day : null;
  const rows = [day, v.series.find((r) => r.date === op.date)].filter(Boolean);
  const isToday = op.date === v.today;
  // Today's change comes after everything else; another day's only moves the level if no stocktake came later.
  const moves = isToday || !s.last_stocktake || op.date > s.last_stocktake;
  if (op.type === "change") {
    const key = op.kind === "take" ? "used" : "added";
    rows.forEach((r) => { r[key] += op.delta; });
    if (day) day.events.push({ id: null, kind: op.kind, n: op.delta, ts: op.ts });
    if (op.kind === "take") {
      if (isToday) s.used_today += op.delta;
      if (moves && s.in_storage != null) s.in_storage = Math.max(0, s.in_storage - op.delta);
    } else if (moves) s.in_storage = (s.in_storage ?? 0) + op.delta;   // a restock makes an unknown level known
  } else if (op.type === "put_back") {
    // Undo the day's latest take; with none to undo, one goes back into storage (a put-back, not a restock).
    // Either way there's one more in storage: Home Assistant puts it back after any later stocktake.
    if (rows.length && rows[0].used > 0) {
      rows.forEach((r) => { r.used -= 1; });
      const i = day ? day.events.map((e) => e.kind).lastIndexOf("take") : -1;
      if (i >= 0 && (day.events[i].n -= 1) <= 0) day.events.splice(i, 1);
      if (isToday) s.used_today = Math.max(0, s.used_today - 1);
    } else {
      rows.forEach((r) => { r.returned = (r.returned || 0) + 1; });
      if (day) day.events.push({ id: null, kind: "add", n: 1, put_back: true, ts: op.ts });
    }
    if (s.in_storage != null) s.in_storage += 1;
  } else if (op.type === "count") {
    rows.forEach((r) => { r.count = op.n; });
    if (day) day.events.push({ id: null, kind: "count", n: op.n, ts: op.ts });
    if (isToday) s.in_storage = op.n;
  } else if (op.type === "delete") {
    const i = day ? day.events.findIndex((e) => e.id === op.id) : -1;
    if (i < 0) return;
    const [e] = day.events.splice(i, 1);
    if (e.kind === "count") {
      const last = day.events.filter((x) => x.kind === "count").at(-1);
      rows.forEach((r) => { r.count = last ? last.n : null; });
    } else {
      const key = e.kind === "take" ? "used" : e.put_back ? "returned" : "added";
      rows.forEach((r) => { r[key] = Math.max(0, (r[key] || 0) - e.n); });
      if (e.kind === "take" && isToday) s.used_today = Math.max(0, s.used_today - e.n);
    }
  } else if (op.type === "note") {
    rows.forEach((r) => { r.note = op.note; });
  }
  s.running_low = s.low_level > 0 && s.in_storage != null && s.in_storage <= s.low_level;
  if (s.per_day) s.days_left = s.in_storage == null ? null : Math.floor(s.in_storage / s.per_day);
}

class StockTrackCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { view: "compact", weeks: 5 };
    this._selected = null;    // the day open in the day editor (calendar layout); null = the grid of days
    this._editing = false;    // typing a stocktake into the big number
    this._exactDirty = false; // ... and something has actually been typed
    this._drafts = {};        // note / add / count -> { date, value }: typed, not saved yet
    this._ops = [];           // changes on their way to Home Assistant, already on screen
    this._pending = 0;
    this._seq = 0;
    this._armed = null;       // the entry whose delete button has been tapped once
    const root = this.shadowRoot;
    // The frame is built once, here, and only its inside is ever redrawn. card-mod and themes put their
    // styling next to it or on it, so nothing else in the shadow root is touched after this.
    // Inside the frame but outside what's redrawn: one live region for screen readers (a region that's redrawn
    // isn't reliably announced), and a probe that resolves the accent, wherever it was set.
    root.innerHTML = `<style>${StockTrackCard.styles}</style><ha-card><div class="sr" aria-live="polite" aria-atomic="true"></div>`
      + `<span class="probe" aria-hidden="true"></span><div class="body"></div></ha-card>`;
    this._frame = root.querySelector("ha-card");
    this._main = root.querySelector(".body");
    this._live = root.querySelector(".sr");
    this._probe = root.querySelector(".probe");
    root.addEventListener("click", (ev) => this._onClick(ev));
    root.addEventListener("input", (ev) => this._onInput(ev));
    // Chrome fires change on an edited box that a redraw takes away: that isn't the person leaving the box.
    root.addEventListener("change", (ev) => { if (!this._redrawing && ev.target.dataset?.field === "note") this._flushNote(); });
    root.addEventListener("keydown", (ev) => this._onKey(ev));
    root.addEventListener("focusout", (ev) => {
      if (!this._redrawing && ev.target.dataset?.field === "exact") this._commitExact(ev.target);
    });
    // Redrawing while a finger is down on a button would swallow the tap, so a redraw waits for the release.
    root.addEventListener("pointerdown", () => { this._pressing = true; });
    this._release = () => {
      this._pressing = false;
      if (this._renderQueued) setTimeout(() => this._render(), 0);
    };
    this._visibility = () => {
      if (document.visibilityState === "visible") this._load();   // the app was in the background: catch up
      else this._flushNote();
    };
  }

  setConfig(config) {
    const weeks = Number(config?.weeks ?? 5);
    const view = config?.view || "compact";
    if (!["compact", "calendar"].includes(view)) throw new Error("Stock Track: view must be compact or calendar");
    if (!Number.isInteger(weeks) || weeks < 2 || weeks > 12) throw new Error("Stock Track: weeks must be a whole number from 2 to 12");
    const changed = (config?.entry_id || null) !== (this._config.entry_id || null);
    this._config = { ...config, view, weeks };
    if (changed) {
      this._unsubscribe();
      this._entryId = null;
      this._data = null;
      this._ops = [];
      this._drafts = {};
      this._selected = null;
    }
    if (this._hass) this._load();
  }

  static getStubConfig() { return {}; }

  static getConfigForm() {
    const labels = { entry_id: "Resource", view: "Layout", weeks: "Weeks in the calendar", title: "Title", hide_title: "Hide the title" };
    const helpers = {
      entry_id: "Leave empty to use the first one.", weeks: "From 2 to 12. This week is at the bottom.",
      title: "Leave empty to use the resource's name.", hide_title: "For when the card sits under a heading of its own.",
    };
    return {
      schema: [
        { name: "entry_id", selector: { config_entry: { integration: "stock_track" } } },
        { name: "view", selector: { select: { mode: "dropdown", options: [
          { value: "compact", label: "Compact: a strip, with the calendar in a popup" },
          { value: "calendar", label: "Calendar: the days on the card" },
        ] } } },
        { name: "weeks", selector: { number: { min: 2, max: 12, step: 1, mode: "box" } } },
        { name: "title", selector: { text: {} } },
        { name: "hide_title", selector: { boolean: {} } },
      ],
      computeLabel: (schema) => labels[schema.name],
      computeHelper: (schema) => helpers[schema.name],
    };
  }

  getCardSize() { return this._config.view === "calendar" ? 3 + this._config.weeks : 2; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

  set hass(hass) {
    const first = !this._hass;
    const wasDown = this._connected === false;
    const wasStarting = !!this._hass?.config?.state && this._hass.config.state !== "RUNNING";
    this._hass = hass;
    if (this._calendar) this._calendar.hass = hass;
    this._connected = hass.connected !== false;
    if (first) { this._load(); return; }
    if ((wasDown && this._connected) || (wasStarting && hass.config?.state === "RUNNING")) { this._reconnected(); return; }
    const now = stIso(new Date());
    if (this._clockDay && now !== this._clockDay) {   // midnight: a new day
      this._clockDay = now;
      this._load();
      return;
    }
    // card-mod can apply its accent after the first draw: look again now and then, and redraw if it changed.
    if (this._data && performance.now() - (this._inkAt || 0) > 2000 && this._ink()) this._render();
  }

  // Text on the accent is dark or light to suit it, whether it's the default, a theme's or card-mod's.
  _ink() {
    this._inkAt = performance.now();
    const color = getComputedStyle(this._probe).color;
    if (color === this._inkFor) return false;
    this._inkFor = color;
    this._accentRgb = stRgb(color);
    this._main.style.setProperty("--st-on-accent", this._accentRgb && stLightText(this._accentRgb) ? "#FFFFFF" : "#05241E");
    return true;
  }

  connectedCallback() {
    window.addEventListener("pointerup", this._release, true);
    window.addEventListener("pointercancel", this._release, true);
    document.addEventListener("visibilitychange", this._visibility);
    if (this._hass && this._entryId) { this._subscribe(); this._load(); }
    // Moved, not removed (a masonry view re-laying its columns when a phone turns): taking the card out of the
    // page took its popup out of the top layer, so show it as a popup again.
    const d = this._dialog;
    if (d?.open && !d.matches(":modal")) { d.close(); d.showModal(); }
  }

  // Back online, or Home Assistant has finished starting. After a restart the old subscription is gone (and
  // resubscribing may have failed while Stock Track was still loading), so start again: reload, retrying while it
  // isn't there yet, and subscribe once a load works.
  _reconnected() {
    if (this._error === ST_OFFLINE) this._error = null;
    this._unsubscribe();
    this._retries = 0;
    clearTimeout(this._retryTimer);
    this._load();
  }

  _retryLater() {
    clearTimeout(this._retryTimer);
    if (!this.isConnected || !this._connected) return;   // offline: coming back online reloads
    const wait = Math.min(30000, 1000 * 2 ** Math.min(this._retries || 0, 5));
    this._retries = (this._retries || 0) + 1;
    this._retryTimer = setTimeout(() => this._load(), wait);
  }

  disconnectedCallback() {
    clearTimeout(this._retryTimer);
    window.removeEventListener("pointerup", this._release, true);
    window.removeEventListener("pointercancel", this._release, true);
    document.removeEventListener("visibilitychange", this._visibility);
    this._pressing = false;
    this._flushNote();
    this._unsubscribe();
    // Only if it stays out of the page: a card that's just being moved is back before this runs.
    queueMicrotask(() => { if (!this.isConnected) this._dialog?.close(); });
  }

  _ws(msg) { return this._hass.callWS(msg); }

  async _load() {
    if (this._pending) return;   // changes still on their way: the last one reloads
    const seq = (this._seq += 1);
    try {
      if (!this._entryId) {
        if (this._config.entry_id) this._entryId = this._config.entry_id;
        else {
          const list = await this._ws({ type: "stock_track/resources" });
          if (seq !== this._seq) return;
          if (!list.length) { this._data = null; this._empty = true; this._loadError = null; this._render(); return; }
          this._entryId = list[0].entry_id;
        }
      }
      const msg = { type: "stock_track/overview", entry_id: this._entryId, days: this._config.view === "calendar" ? this._config.weeks * 7 : 1 };
      if (this._selected) msg.date = this._selected;
      const data = await this._ws(msg);
      if (seq !== this._seq) return;   // a newer request, or a tap, has overtaken this one
      this._data = data;
      this._ops = [];
      this._empty = false;
      this._loadError = null;
      this._retries = 0;
      this._refind = 0;
      this._clockDay = stIso(new Date());
      if (!this._unsub && this.isConnected) this._subscribe();
    } catch (err) {
      if (seq !== this._seq) return;
      if (err?.code === "not_found" && !this._config.entry_id && this._entryId && (this._refind = (this._refind || 0) + 1) <= 2) {
        // The card was showing the first resource, and it's been deleted: show whichever is first now.
        this._entryId = null;
        this._data = null;
        this._unsubscribe();
        this._load();
        return;
      }
      this._loadError = err?.code === "not_found" ? ST_GONE : err?.code === "unknown_command" ? ST_STARTING : stMessage(err);
      if (err?.code !== "not_found") this._retryLater();
    }
    this._render();
  }

  _subscribe() {
    if (this._subscribing || this._unsub || !this._entryId) return;
    this._subscribing = true;
    this._hass.connection.subscribeMessage(() => this._load(), { type: "stock_track/subscribe", entry_id: this._entryId })
      .then((unsub) => { this._unsub = unsub; if (!this.isConnected) this._unsubscribe(); })
      .catch(() => this._retryLater())   // not loaded yet: the next load that works subscribes again
      .finally(() => { this._subscribing = false; });
  }

  _unsubscribe() {
    const unsub = this._unsub;
    this._unsub = null;
    // After a restart the old subscription can't be cancelled: Home Assistant answers with an error, which is fine.
    if (unsub) { try { Promise.resolve(unsub()).catch(() => {}); } catch (_) { /* connection already gone */ } }
  }

  // What's on screen: the last overview with the changes still on their way laid over it.
  _view() {
    if (!this._ops.length) return this._data;
    const v = JSON.parse(JSON.stringify(this._data));
    for (const op of this._ops) stApply(v, op);
    return v;
  }

  // Writes ---------------------------------------------------------------------------------------

  async _do(op, msg, onFail) {
    op.ts = new Date().toISOString();
    this._ops.push(op);
    if (op.type === "change" && op.kind === "take" && op.delta > 0) this._pop = { date: op.date, at: performance.now() };
    this._seq += 1;   // an overview already on its way would undo this on screen
    this._render();
    this._pending += 1;
    try {
      await this._ws({ entry_id: this._entryId, ...msg });
    } catch (err) {
      this._error = stMessage(err);
      this._ops = this._ops.filter((o) => o !== op);   // it didn't happen: take it back
      onFail?.();
    }
    this._pending -= 1;
    if (!this._pending) await this._load();
    else this._render();
  }

  // Today's changes go without a date, so Home Assistant stamps them "now"; an earlier day's carry its date.
  _dated(msg, date) { return date === this._data.today ? msg : { ...msg, date }; }

  _take(date) {
    this._do({ type: "change", kind: "take", delta: 1, date }, this._dated({ type: "stock_track/change", kind: "take", delta: 1 }, date));
  }

  // Undo the day's latest take or, with none to undo, put one back into storage (the integration decides which).
  _putBack(date) {
    this._do({ type: "put_back", date }, this._dated({ type: "stock_track/put_back" }, date));
  }

  _commitExact(input) {
    if (!this._editing) return;
    this._editing = false;
    const typed = this._exactDirty;
    this._exactDirty = false;
    const text = input.value.trim();
    // Opened and closed without typing, or emptied: nothing was counted.
    if (!typed || text === "") { this._render(); return; }
    const n = Number(text);
    if (!/^\d+$/.test(text) || n > ST_MAX) { this._error = `Type a whole number from 0 to ${stNum(ST_MAX)}.`; this._render(); return; }
    const before = this._view().stats.in_storage ?? 0;
    this._tick(n < before ? -1 : 1);
    this._do({ type: "count", n, date: this._data.today }, { type: "stock_track/stocktake", count: n });
  }

  // A restock or stocktake typed for the day on screen. False when it isn't a number it can save (the box keeps it).
  _commitField(field) {
    const d = this._drafts[field];
    if (!d) return true;
    delete this._drafts[field];
    const text = d.value.trim();
    if (!text) return true;
    const n = Number(text);
    // Kept to try again, but only while its day is still the one on screen.
    const keep = () => { if (!this._drafts[field] && this._shownDay() === d.date) this._drafts[field] = d; };
    if (field === "add") {
      if (!/^\d+$/.test(text) || n < 1 || n > ST_MAX) {
        this._error = `Type how many went into storage, a whole number from 1 to ${stNum(ST_MAX)}.`;
        keep(); return false;
      }
      this._do({ type: "change", kind: "add", delta: n, date: d.date }, this._dated({ type: "stock_track/change", kind: "add", delta: n }, d.date), keep);
    } else {
      if (!/^\d+$/.test(text) || n > ST_MAX) {
        this._error = `Type the exact count in storage, a whole number from 0 to ${stNum(ST_MAX)}.`;
        keep(); return false;
      }
      this._do({ type: "count", n, date: d.date }, this._dated({ type: "stock_track/stocktake", count: n }, d.date), keep);
    }
    return true;
  }

  _flushNote() {
    const d = this._drafts.note;
    if (!d || !this._entryId || !this._data) return;
    delete this._drafts.note;
    const v = this._view();
    const saved = v.day.date === d.date ? v.day.note : v.series.find((r) => r.date === d.date)?.note;
    const note = d.value.trim();
    if (saved != null && note === saved) return;   // nothing changed
    this._do({ type: "note", date: d.date, note }, { type: "stock_track/set_note", date: d.date, note },
      () => { if (!this._drafts.note && this._shownDay() === d.date) this._drafts.note = d; });
  }

  // The day open in the editor, once it has loaded (not while the next one is on its way); null otherwise.
  _shownDay() {
    const v = this._data && this._view();
    return v && this._selected && v.day.date === this._selected ? v.day.date : null;
  }

  _loadingDay() { return !!this._selected && !!this._data && this._data.day.date !== this._selected; }

  // On a phone a tap on a button doesn't always take focus off a box first, so what was typed is saved before the
  // tap: the stocktake in the number, and the open day's note, restock and stocktake. Anything typed for a day
  // that is no longer on screen is dropped, never saved to a day nobody is looking at.
  _flushTyped() {
    this._commitStrip();
    const shown = this._shownDay();
    let refused = false;
    for (const f of ["note", "add", "count"]) {
      const d = this._drafts[f];
      if (!d) continue;
      if (d.date !== shown) delete this._drafts[f];
      else if (f === "note") this._flushNote();
      else if (!this._commitField(f)) refused = true;
    }
    if (refused) this._render();
  }

  _commitStrip() {
    const exact = this.shadowRoot.querySelector('[data-field="exact"]');
    if (this._editing && exact) this._commitExact(exact);
  }

  // Leaving a day (another day, All days, Escape, the back gesture, closing the popup): its note is saved, as
  // leaving the box would; a restock or stocktake only counts once Add, Save or Enter says so, so it's dropped.
  _leaveDay() {
    const box = this.shadowRoot.activeElement;
    if (box?.dataset?.field && box.dataset.field !== "exact") box.blur();
    if (this._drafts.note && this._drafts.note.date === this._shownDay()) this._flushNote();
    this._drafts = {};
    this._armed = null;
  }

  _delete(id) {
    if (!id) return;
    if (this._armed !== id) {   // the first tap asks; the second deletes
      this._armed = id;
      clearTimeout(this._armTimer);
      this._armTimer = setTimeout(() => { if (this._armed === id) { this._armed = null; this._render(); } }, 4000);
      this._render();
      return;
    }
    this._armed = null;
    this._do({ type: "delete", id, date: this._view().day.date }, { type: "stock_track/delete_event", event_id: id });
  }

  // Events ---------------------------------------------------------------------------------------

  _onInput(ev) {
    const f = ev.target.dataset?.field;
    if (!f || !this._data) return;
    if (f === "exact") { this._exactDirty = true; return; }
    this._drafts[f] = { date: this._view().day.date, value: ev.target.value };
  }

  _onKey(ev) {
    const f = ev.target.dataset?.field;
    if (ev.key === "Escape" && (f || this._selected)) {
      // Escape steps back one level (a box, then the day), rather than closing the popup it's in.
      ev.preventDefault();
      ev.stopPropagation();
      if (f === "exact") {
        this._editing = false;
        this._exactDirty = false;
        this._focusNext = '[data-act="edit"]';
        this._render();
      } else if (f) {
        delete this._drafts[f];
        ev.target.value = f === "note" ? this._view().day.note || "" : "";   // a redraw leaves a box being typed in alone
        this._render();
      } else this._closeDay();
      return;
    }
    if (ev.key !== "Enter" || !f) return;
    ev.preventDefault();
    if (f !== "exact" && this._loadingDay()) return;   // the day on screen is the one being left
    this._error = null;
    if (f === "exact") {
      this._focusNext = '[data-act="edit"]';   // back on the number, as Escape does
      this._commitExact(ev.target);
    } else if (f === "note") this._flushNote();
    else {
      // Saved: the box empties and focus moves to its button, so a phone's keyboard goes away.
      ev.target.blur();
      this._focusNext = `[data-act="${f}-save"]`;
      if (!this._commitField(f)) { this._focusNext = `[data-field="${f}"]`; this._render(); }
    }
  }

  _onClick(ev) {
    const cell = ev.target.closest("[data-date]");
    const btn = ev.target.closest("[data-act]");
    const act = btn?.dataset.act;
    if (!cell && !act) return;
    if (act === "retry") { this._retries = 0; this._load(); return; }
    if (!this._data) return;
    // While the next day loads, the editor on screen is the day being left: nothing is logged on it.
    if (this._loadingDay() && ST_EDITS.has(act)) return;
    if (act !== "del") this._armed = null;
    this._error = null;
    const field = act === "add-save" ? "add" : act === "count-save" ? "count" : null;
    const typed = !!field && this._drafts[field]?.date === this._shownDay() && this._drafts[field].value.trim() !== "";
    // Moving to another day or back to all days leaves this one (see _leaveDay); any other tap saves what was typed.
    if (!cell && !["prev", "next", "days", "edit"].includes(act)) this._flushTyped();
    else this._commitStrip();   // a stocktake typed into the number is saved by any tap
    if (cell) { this._openDay(cell.dataset.date); return; }
    const { day, stats, today } = this._view();
    // The strip works on today; the day editor on its own day.
    if (act === "take") { if (stats.in_storage !== 0) { this._tick(-1); this._take(today); } }
    else if (act === "back") { if (stats.in_storage != null || stats.used_today) { this._tick(1); this._putBack(today); } }
    else if (act === "day-take") this._take(day.date);
    else if (act === "day-back") { if (day.used) this._putBack(day.date); }
    else if (field) {
      // Saved: focus stays on the button (a phone's keyboard goes away). Nothing typed, or not a number: into the box.
      const box = this.shadowRoot.activeElement;
      if (typed && !this._drafts[field] && box?.dataset?.field) box.blur();
      this._focusNext = typed && !this._drafts[field] ? `[data-act="${act}"]` : `[data-field="${field}"]`;
      this._render();
    } else if (act === "del") this._delete(btn.dataset.id);
    else if (act === "days") this._closeDay();
    else if (act === "prev") this._openDay(stShift(this._selected || day.date, -1));
    else if (act === "next") this._openDay(stShift(this._selected || day.date, 1));
    else if (act === "export") this._export();
    else if (act === "calendar") this._openCalendar();
    else if (act === "edit") {
      this._editing = true;
      this._exactDirty = false;
      this._render();
      const input = this.shadowRoot.querySelector('[data-field="exact"]');
      if (input) { input.focus(); input.select(); }
    } else this._render();
  }

  _tick(dir) { this._bump = { dir, at: performance.now(), k: this._bump?.k ? 0 : 1 }; }

  _openDay(date) {
    if (this._config.view !== "calendar" || date > this._data.today) return;
    this._leaveDay();
    if (!this._selected) this._focusNext = '[data-act="days"]';
    this._selected = date;
    this._render();   // the tapped day is marked straight away; the editor opens when its day has loaded
    this._load();
  }

  _closeDay() {
    this._leaveDay();
    const was = this._selected;
    this._selected = null;
    this._dayShown = false;
    this._focusNext = `[data-date="${was}"]`;
    this._render();
    this._load();
  }

  _openCalendar() {
    // The calendar of days in a popup, for the compact layout: a second card inside a native dialog.
    if (this._dialog || !this._data) return;
    const { resource } = this._data;
    const name = this._config.title || resource.name;
    const dialog = document.createElement("dialog");
    dialog.className = "cal";
    dialog.setAttribute("aria-label", `${name}, each day`);
    dialog.innerHTML = `<div class="cal-head"><div class="title"><ha-icon icon="${stEsc(resource.icon || ST_ICON)}"></ha-icon><span>${stEsc(name)}</span></div><button class="x" data-close aria-label="Close">×</button></div>`;
    const grid = document.createElement("stock-track-card");
    grid._popup = true;
    grid.setConfig({ entry_id: this._entryId, view: "calendar", weeks: this._config.weeks, hide_title: true });
    // The popup takes its look from this card (a theme's, or card-mod's), and the calendar inside sits flat on it.
    const look = getComputedStyle(this._frame);
    // A see-through card would let the dashboard show through the popup, so its fill goes over a solid base.
    const clear = look.backgroundColor === "rgba(0, 0, 0, 0)";
    const layers = [look.backgroundImage !== "none" ? look.backgroundImage : "", clear ? "" : `linear-gradient(${look.backgroundColor}, ${look.backgroundColor})`].filter(Boolean);
    if (layers.length) {
      dialog.style.backgroundImage = layers.join(", ");
      dialog.style.backgroundColor = getComputedStyle(this).getPropertyValue("--primary-background-color").trim() || "#111";
    }
    for (const side of ["Top", "Right", "Bottom", "Left"]) dialog.style[`border${side}`] = `${look[`border${side}Width`]} ${look[`border${side}Style`]} ${look[`border${side}Color`]}`;
    dialog.style.borderRadius = look.borderRadius;
    if (look.boxShadow !== "none") dialog.style.boxShadow = look.boxShadow;
    grid.style.setProperty("--ha-card-background", "transparent");
    grid.style.setProperty("--ha-card-border-width", "0");
    grid.style.setProperty("--ha-card-box-shadow", "none");
    const accent = look.getPropertyValue("--st-accent").trim();
    if (accent) { dialog.style.setProperty("--st-accent", accent); grid.style.setProperty("--stock-track-accent", accent); }
    grid.hass = this._hass;
    dialog.appendChild(grid);
    // The backdrop closes it, but only a press that starts there too: selecting text in the note and letting go
    // outside the popup shouldn't.
    let downOnBackdrop = false;
    dialog.addEventListener("pointerdown", (ev) => { downOnBackdrop = ev.target === dialog; });
    dialog.addEventListener("click", (ev) => {
      if (ev.target.closest?.("[data-close]") || (ev.target === dialog && downOnBackdrop)) dialog.close();
    });
    dialog.addEventListener("cancel", (ev) => { if (grid._selected) { ev.preventDefault(); grid._closeDay(); } });
    dialog.addEventListener("close", () => {
      if (dialog.open) return;   // closed only to be shown again as a popup (see connectedCallback)
      grid._leaveDay();
      dialog.remove();
      this._dialog = this._calendar = null;
      this._load();
      this.shadowRoot.querySelector('[data-act="calendar"]')?.focus();
    });
    this.shadowRoot.appendChild(dialog);
    this._dialog = dialog;
    this._calendar = grid;
    dialog.showModal();
  }

  async _export() {
    try {
      const { events, notes } = await this._ws({ type: "stock_track/events", entry_id: this._entryId });
      const what = { take: "taken", add: "restocked", count: "stocktake" };
      const rows = events.map((e, i) => ({ date: e.date, i,
        line: `${e.date},${e.backdated ? "" : stClock(e.ts)},${e.kind === "add" && e.put_back ? "put back" : what[e.kind] || stCsvText(String(e.kind))},${Number(e.n)},${stCsvText(e.note || "")}` }));
      Object.entries(notes || {}).forEach(([d, n]) => rows.push({ date: d, i: Infinity, line: `${d},,day note,,${stCsvText(n)}` }));
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.i - b.i));
      // The byte-order mark tells Excel it's UTF-8, so notes with accents or emoji come through.
      const csv = "\uFEFF" + ["date,time,what,amount,note", ...rows.map((r) => r.line)].join("\n") + "\n";
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      link.download = `stock-track-${(this._data.resource.name || "resource").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);   // the Android app needs a while to pick it up
    } catch (err) {
      this._error = stMessage(err);
      this._render();
    }
  }

  // Drawing --------------------------------------------------------------------------------------

  _render() {
    const root = this.shadowRoot;
    // A redraw asked for from inside a redraw (a blur handler, say) runs straight after this one.
    if (this._redrawing) { this._again = true; return; }
    // Not while a finger is down on a button, and not under a stocktake that's being typed.
    if (this._pressing || (this._editing && root.querySelector('[data-field="exact"]'))) { this._renderQueued = true; return; }
    this._renderQueued = false;
    // Put keyboard focus (and a half-typed box's cursor) back where it was.
    const active = root.activeElement;
    let focus = null;
    let caret = null;
    if (active?.dataset?.act) focus = `[data-act="${active.dataset.act}"]${active.dataset.id ? `[data-id="${active.dataset.id}"]` : ""}`;
    else if (active?.dataset?.date) focus = `[data-date="${active.dataset.date}"]`;
    else if (active?.dataset?.field) { focus = `[data-field="${active.dataset.field}"]`; caret = [active.selectionStart, active.selectionEnd]; }
    this._ink();
    this._redrawing = true;
    try {
      const next = document.createElement("div");
      next.innerHTML = this._html();
      stMorph(this._main, next);
    } finally { this._redrawing = false; }
    // Say what changed (not on the first draw), once.
    if (this._said && this._said !== this._lastSaid) {
      if (this._lastSaid !== undefined) this._live.textContent = this._said;
      this._lastSaid = this._said;
    }
    if (this._again) { this._again = false; setTimeout(() => this._render(), 0); }
    if (this._focusNext && root.querySelector(this._focusNext)) { focus = this._focusNext; caret = null; this._focusNext = null; }
    else if (active && active.isConnected && root.activeElement === active) focus = null;   // still where it was
    const el = focus && root.querySelector(focus);
    if (el && !el.disabled) {
      el.focus({ preventScroll: true });
      if (caret && caret[0] != null) { try { el.setSelectionRange(caret[0], caret[1]); } catch (_) { /* not a text box */ } }
    }
  }

  _html() {
    this._said = "";
    if (this._empty) {
      return `<div class="st msg"><ha-icon icon="${ST_ICON}"></ha-icon><p>No resources yet. Add one in Settings, Devices &amp; services, Add integration, <b>Stock Track</b>.</p><button class="link" data-act="retry">Check again</button></div>`;
    }
    if (!this._data) {
      return this._loadError
        ? `<div class="st msg"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><p>${stEsc(this._loadError)}</p><button class="link" data-act="retry">Try again</button></div>`
        : `<div class="st msg"><p>Loading…</p></div>`;
    }
    const v = this._view();
    const { resource } = v;
    const name = this._config.hide_title || this._popup ? ""
      : `<div class="head"><div class="title"><ha-icon icon="${stEsc(resource.icon || ST_ICON)}"></ha-icon><span>${stEsc(this._config.title || resource.name)}</span></div></div>`;
    const problem = this._error || this._loadError;
    const error = problem ? `<div class="err" role="alert">${stEsc(problem)}</div>` : "";
    if (this._config.view === "compact") return `<div class="st compact">${name}${this._strip(v)}${error}</div>`;
    // A day's editor stays up, dimmed, while the next or previous day loads, rather than flashing the shelves.
    const ready = this._selected && v.day.date === this._selected;
    if (ready || (this._selected && this._dayShown)) {
      this._dayShown = true;
      return `<div class="st cal${ready ? "" : " loading"}">${name}${error}${this._editor(v)}</div>`;
    }
    this._dayShown = false;
    return `<div class="st cal">${name}${this._popup ? "" : this._strip(v)}${error}${this._shelves(v)}${this._summary(v)}</div>`;
  }

  _strip(v) {
    const { stats: s, resource } = v;
    const unit = stEsc(resource.unit || ST_UNIT);
    const level = s.in_storage;
    let cls = "n";
    const since = this._bump ? performance.now() - this._bump.at : Infinity;
    if (since < 300) cls += ` ${this._bump.dir < 0 ? "d" : "u"}${this._bump.k}`;
    const said = `${level == null ? `${unit} in storage: not counted yet` : `${stNum(level)} ${unit} in storage`}${s.running_low ? ", running low" : ""}`;
    const count = this._editing
      ? `<input class="exact" data-field="exact" type="text" inputmode="numeric" enterkeyhint="done" autocomplete="off" maxlength="6" value="${level ?? ""}" aria-label="Stocktake: how many ${unit} are in storage now">`
      : level == null
        ? `<button class="n ask" data-act="edit" aria-label="${said}. Tap to count what's in storage.">Count</button>`
        : `<button class="${cls}" data-act="edit" title="Tap to type a stocktake" aria-label="${said}. Tap to type a stocktake.">${stNum(level)}</button>`;
    const under = s.running_low ? `<span class="low-tag">Running low</span>`
      : `<span class="unit">${level == null ? "not counted yet" : `${unit} in storage`}</span>`;
    this._said = said;
    const calendar = this._config.view === "compact"
      ? `<button class="cal-open" data-act="calendar" aria-label="Open the calendar of each day" title="Each day"><ha-icon icon="mdi:calendar-month"></ha-icon></button>` : "";
    return `
      <div class="strip${s.running_low ? " low" : ""}">
        <div class="counter">
          <button class="round take" data-act="take" aria-label="Take one" title="Take one" ${level === 0 ? "disabled" : ""}><span>−</span></button>
          <div class="count">${count}${under}</div>
          <button class="round back" data-act="back" aria-label="Put one back" title="Put one back" ${level == null && !s.used_today ? "disabled" : ""}><span>+</span></button>
        </div>
        <div class="side">${this._rates(s)}${calendar}</div>
      </div>`;
  }

  _rates(s) {
    if (s.per_week == null) {
      return s.tracked_days > 0
        ? `<div class="rates"><span><b>Day ${s.tracked_days}</b> of 7</span> <span>rates after a week</span></div>`
        : `<div class="rates"><span><b>Not started</b></span> <span>rates after a week</span></div>`;
    }
    const often = s.days_between ? ` title="One every ${stDec(s.days_between)} days"` : "";
    const left = s.per_day && s.days_left != null ? `<span><b>${stLasts(s.days_left)}</b> left</span>` : `<span>none used lately</span>`;
    return `<div class="rates"${often}><span><b>${stDec(s.per_week)}</b> a week</span> ${left}</div>`;
  }

  _shelves(v) {
    // A shelf for each week (Monday first, this week at the bottom), and a canister for each day on it.
    const { series, today } = v;
    const weeks = this._config.weeks;
    const byDate = new Map(series.map((r) => [r.date, r]));
    // Shade by the busiest day on show, so a household's own heavy and light days stand apart.
    const top = Math.max(1, ...series.map((r) => r.used));
    const monday = stShift(today, -((stParse(today).getDay() + 6) % 7));
    const first = stShift(monday, -7 * (weeks - 1));
    // The pop outlives the redraw that follows Home Assistant's answer: pick it up where it had got to.
    const pop = this._pop && performance.now() - this._pop.at < 360 ? this._pop.date : null;
    let shelves = "";
    for (let w = 0; w < weeks; w++) {
      let slots = "";
      for (let i = 0; i < 7; i++) {
        const date = stShift(first, w * 7 + i);
        const d = stParse(date);
        const month = d.getDate() === 1 || (w === 0 && i === 0);
        const edge = `<span class="edge${month ? " mon" : ""}">${month ? ST_MONTHS[d.getMonth()] : d.getDate()}</span>`;
        const r = byDate.get(date);
        if (date > today || !r) { slots += `<span class="slot future" aria-hidden="true"><span class="jar"></span>${edge}</span>`; continue; }
        const kind = r.used > 0 ? "used" : r.tracked ? "zero" : "untracked";
        const said = [kind === "untracked" ? "before tracking began" : `${r.used} used`];
        if (r.added) said.push(`restocked ${r.added}`);
        if (r.returned) said.push(`put back ${r.returned}`);
        if (r.count != null) said.push(`stocktake ${r.count}`);
        if (r.note) said.push(`note: ${r.note}`);
        const label = stEsc(`${date === today ? "Today, " : ""}${stLong(date)}: ${said.join(", ")}`);
        const tags = (r.count != null ? `<i class="tag k-count">=${stNum(r.count)}</i>` : "") + (r.added ? `<i class="tag k-add">+${stNum(r.added)}</i>` : "");
        const cls = ["slot", kind, date === today ? "now" : "", date === this._selected ? "sel" : "", date === pop ? "pop" : ""].filter(Boolean).join(" ");
        const style = [];
        if (r.used) {
          const t = r.used / top;
          style.push(`--t:${t.toFixed(2)}`);
          if (this._accentRgb && stLightText(stMix(this._accentRgb, ST_LABEL_RGB, 0.4 + 0.6 * t))) style.push("--ink:#fff");
        }
        slots += `<button class="${cls}" data-date="${date}" title="${label}" aria-label="${label}"${style.length ? ` style="${style.join(";")}"` : ""}>${tags}<span class="jar">${kind === "used" ? r.used : ""}</span>${edge}</button>`;
      }
      shelves += `<div class="shelf">${slots}</div>`;
    }
    const names = ["M", "T", "W", "T", "F", "S", "S"].map((n) => `<span>${n}</span>`).join("");
    return `<div class="shelves" role="group" aria-label="Used each day, last ${weeks} weeks"><div class="names" aria-hidden="true">${names}</div>${shelves}</div>`;
  }

  _summary(v) {
    const { stats: s, resource } = v;
    const unit = stEsc(resource.unit || ST_UNIT);
    let line;
    if (s.in_storage == null) line = "Not counted yet. Tap today and save a stocktake to start the count.";
    else {
      line = `<b>${stNum(s.in_storage)}</b> ${unit} in storage`;
      if (s.running_low) line += ", running low";
      else if (s.per_day && s.days_left != null) line += `, enough for about ${stLasts(s.days_left)}`;
      line += ".";
    }
    if (s.per_week != null) line += s.per_day ? ` Using ${stDec(s.per_week)} a week, one every ${stDec(s.days_between)} days.` : " None used in the last 30 days.";
    else if (s.tracking_since) line += ` Tracking since ${stShort(s.tracking_since)}; rates show after a week (day ${s.tracked_days} of 7).`;
    return `
      <div class="sum">
        <p>${line}</p>
        <div class="foot"><span class="legend"><i class="tag k-add">+</i> restock <i class="tag k-count">=</i> stocktake</span><button class="link" data-act="export">Export CSV</button></div>
      </div>`;
  }

  _editor(v) {
    const { day, today, series, stats: s } = v;
    const isToday = day.date === today;
    const when = isToday ? "today" : `on ${stLong(day.date)}`;
    const draft = (f) => (this._drafts[f] && this._drafts[f].date === day.date ? this._drafts[f].value : null);
    const note = draft("note") ?? day.note ?? "";
    const row = series.find((r) => r.date === day.date);
    this._said = `${stNum(day.used)} used ${when}`;
    const log = day.events.length
      ? `<ul class="log">${day.events.map((e) => this._entry(e)).join("")}</ul>`
      : `<p class="quiet">Nothing logged ${isToday ? "today" : "this day"} yet.</p>`;
    let foot = "";
    if (row && !row.tracked) foot = "This day is before tracking began, so it isn't in the rates.";
    else if (isToday && s.in_storage != null) foot = `${stNum(s.in_storage)} in storage now.`;
    else if (row?.level != null) foot = `Ended the day with ${stNum(row.level)} in storage.`;
    return `
      <div class="editor">
        <div class="day-head">
          <button class="back-link" data-act="days" aria-label="Back to the calendar"><span aria-hidden="true">‹</span> All days</button>
          <div class="nav">
            <button class="icon" data-act="prev" aria-label="Previous day">‹</button>
            <span class="day-name">${isToday ? "Today" : stLong(day.date)}</span>
            <button class="icon" data-act="next" aria-label="Next day" ${isToday ? "disabled" : ""}>›</button>
          </div>
        </div>
        <div class="counter big">
          <div class="btn"><button class="round back" data-act="day-back" aria-label="Put one back: undo a take ${when}" ${day.used ? "" : "disabled"}><span>−</span></button><small>Put one back</small></div>
          <div class="count"><span class="n">${stNum(day.used)}</span><span class="unit">used ${isToday ? "today" : "this day"}</span></div>
          <div class="btn"><button class="round take" data-act="day-take" aria-label="Take one ${when}"><span>+</span></button><small>Take one</small></div>
        </div>
        <div class="forms">
          <div class="row"><label for="st-add"><b>Restock</b><small>Add to storage</small></label>
            <input id="st-add" class="field" data-field="add" type="text" inputmode="numeric" enterkeyhint="done" autocomplete="off" maxlength="6" value="${stEsc(draft("add") ?? "")}" aria-label="Restock ${when}: how many went into storage">
            <button class="pill" data-act="add-save">Add</button></div>
          <div class="row"><label for="st-count"><b>Stocktake</b><small>Exact count in storage</small></label>
            <input id="st-count" class="field" data-field="count" type="text" inputmode="numeric" enterkeyhint="done" autocomplete="off" maxlength="6" value="${stEsc(draft("count") ?? "")}" aria-label="Stocktake ${when}: exactly how many were in storage">
            <button class="pill" data-act="count-save">Save</button></div>
        </div>
        <div class="logged"><h3>Logged ${isToday ? "today" : "this day"}</h3>${log}</div>
        <input class="note" data-field="note" type="text" maxlength="200" enterkeyhint="done" placeholder="Note for ${isToday ? "today" : stShort(day.date)} (optional)" aria-label="Note for ${isToday ? "today" : stLong(day.date)}" value="${stEsc(note)}">
        ${foot ? `<p class="quiet">${foot}</p>` : ""}
      </div>`;
  }

  _entry(e) {
    const kind = e.kind === "add" && e.put_back ? "back" : e.kind;
    const label = { take: "Taken", add: "Restocked", back: "Put back", count: "Stocktake" }[kind] || stEsc(e.kind);
    const mark = { take: "−", add: "+", back: "+", count: "=" }[kind] || "";
    const time = stTime(e);
    const armed = e.id && this._armed === e.id;
    const said = stEsc(`${label} ${e.n}${time ? ` at ${time}` : ""}`);
    const del = e.id
      ? `<button class="del${armed ? " armed" : ""}" data-act="del" data-id="${stEsc(e.id)}" aria-label="${armed ? "Tap again to delete" : "Delete"}: ${said}" title="${armed ? "Tap again to delete" : "Delete"}">${armed ? "Delete?" : `<ha-icon icon="mdi:delete-outline"></ha-icon>`}</button>`
      : `<span class="del"></span>`;
    return `<li class="entry${e.id ? "" : " pending"}"><i class="tag k-${stEsc(kind)}">${mark}${stNum(e.n)}</i><span class="what">${label}${e.note ? `<small>${stEsc(e.note)}</small>` : ""}</span><span class="time">${time}</span>${del}</li>`;
  }

  static get styles() {
    return `
    :host { display: block; --st-accent: var(--stock-track-accent, #3DBEA6); --st-on-accent: #05241E;
      --st-label: #FFFDF5; --st-ink: #0B2A24; --st-low: var(--warning-color, #F0A030);
      --st-round: ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", inherit; }
    ha-card { overflow: hidden; container-type: inline-size; height: 100%; box-sizing: border-box; }
    .sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .probe { display: none; color: var(--st-accent); }
    /* Tints of the theme's text colour and of the accent. Plain colours here, for browsers that can't mix colours
       (iOS before 16.2). A mix with var() in it that a browser can't do leaves the property unset rather than
       falling back to an earlier declaration, so the mixed tints are all set at the end, only where mixing works.
       They're declared inside ha-card, so an accent card-mod puts on ha-card is the one they're mixed from. */
    .body, dialog.cal {
      --st-wash: rgba(127, 127, 127, 0.09); --st-fill: rgba(127, 127, 127, 0.14); --st-plank: rgba(127, 127, 127, 0.2);
      --st-rule: rgba(127, 127, 127, 0.18); --st-chip: rgba(127, 127, 127, 0.25); --st-edge: rgba(127, 127, 127, 0.35);
      --st-line: rgba(127, 127, 127, 0.55); --st-faint: rgba(127, 127, 127, 0.4); --st-dim: var(--secondary-text-color);
      --st-accent-soft: rgba(127, 127, 127, 0.2); --st-accent-rim: rgba(0, 0, 0, 0.22); --st-accent-deep: rgba(0, 0, 0, 0.42);
      --st-accent-ring: rgba(255, 255, 255, 0.35); --st-accent-lift: var(--st-accent); --st-error-soft: rgba(127, 127, 127, 0.2); }
    .body { display: contents; }
    .st { padding: 16px; color: var(--primary-text-color); display: grid; gap: 14px; font-family: var(--paper-font-body1_-_font-family, inherit); }
    .st.compact { gap: 6px; padding: 10px 14px; height: 100%; box-sizing: border-box; align-content: center; }
    button { font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    button:focus-visible, .slot:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    /* A tap area at least 44 px square, where the button itself is drawn smaller. */
    .cal-open, .pill, button.n { position: relative; }
    .cal-open::after, .pill::after, button.n::after { content: ""; position: absolute; inset: -3px; }
    .pill::after { inset: -6px 0; }
    .msg { justify-items: center; text-align: center; color: var(--secondary-text-color); padding: 28px 16px; }
    .msg ha-icon { --mdc-icon-size: 36px; color: var(--st-accent); }
    .msg p { margin: 0; max-width: 34ch; line-height: 1.45; }
    .head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title { display: flex; align-items: center; gap: 8px; font-size: 1.1rem; font-weight: 600; min-width: 0; }
    .title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title ha-icon { color: var(--st-accent); flex: none; }
    .compact .title { font-size: 1rem; }
    .compact .title ha-icon { --mdc-icon-size: 20px; }

    .strip { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px 14px; }
    .counter { display: flex; align-items: center; justify-content: center; gap: 8px; }
    .side { display: flex; align-items: center; gap: 12px; }
    .round { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 50%; display: grid; place-items: center; font-size: 1.7rem; line-height: 1;
      transition: transform 0.08s ease, background 0.15s ease; }
    .round span { margin-top: -3px; }
    .round.take { border: 0; color: var(--st-on-accent); background: var(--st-accent);
      box-shadow: inset 0 0 0 3px var(--st-accent-rim), inset 0 0 0 5px var(--st-accent-ring); }
    .round.back { border: 2px solid var(--st-accent); background: transparent; color: var(--primary-text-color); }
    .round.take:not(:disabled):hover { background: var(--st-accent-lift); }
    .round.back:not(:disabled):hover { background: var(--st-accent-soft); }
    .round:not(:disabled):active { transform: scale(0.93); }
    .round:disabled { opacity: 0.35; cursor: default; }
    .count { display: grid; justify-items: center; min-width: 72px; }
    .n { background: none; border: 0; padding: 0 8px; font-family: var(--st-round); font-size: 2.3rem; font-weight: 700; line-height: 1.05;
      font-variant-numeric: tabular-nums; border-radius: 10px; }
    button.n:hover { background: var(--secondary-background-color); }
    .n.ask { margin: 3px 0 2px; padding: 5px 14px; font-size: 1.05rem; line-height: 1.2; border: 2px dashed var(--st-accent); border-radius: 999px; }
    .n.d0 { animation: st-d0 0.3s ease-out both; } .n.d1 { animation: st-d1 0.3s ease-out both; }
    .n.u0 { animation: st-u0 0.3s ease-out both; } .n.u1 { animation: st-u1 0.3s ease-out both; }
    @keyframes st-d0 { from { transform: translateY(-0.22em); opacity: 0.35; } }
    @keyframes st-d1 { from { transform: translateY(-0.22em); opacity: 0.35; } }
    @keyframes st-u0 { from { transform: translateY(0.22em); opacity: 0.35; } }
    @keyframes st-u1 { from { transform: translateY(0.22em); opacity: 0.35; } }
    .unit { font-size: 0.75rem; color: var(--secondary-text-color); white-space: nowrap; }
    .low .n { color: var(--st-low); }
    .low-tag { font-size: 0.72rem; font-weight: 700; line-height: 1.45; color: var(--st-low); border: 1.5px solid currentColor; border-radius: 999px; padding: 0 7px; white-space: nowrap; }
    .exact { width: 4.4ch; font: inherit; font-family: var(--st-round); font-size: 1.9rem; font-weight: 700; text-align: center; color: var(--primary-text-color);
      background: var(--secondary-background-color); border: 2px solid var(--st-accent); border-radius: 10px; padding: 0 4px; }
    .rates { display: grid; gap: 1px; font-size: 0.8rem; line-height: 1.35; color: var(--secondary-text-color); white-space: nowrap; }
    .rates b { font-family: var(--st-round); font-size: 1.05rem; font-weight: 700; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
    .cal-open { width: 38px; height: 38px; flex: none; display: grid; place-items: center; border-radius: 12px; border: 0; color: var(--secondary-text-color);
      background: var(--st-fill); --mdc-icon-size: 22px; }
    .cal-open:hover { color: var(--primary-text-color); background: var(--st-accent-soft); }

    dialog.cal { padding: 0; width: min(440px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; box-sizing: border-box;
      color: var(--primary-text-color); background: var(--card-background-color, #1c1c1c); border: 1px solid var(--divider-color); border-radius: 16px; }
    dialog.cal::backdrop { background: rgba(0, 0, 0, 0.6); }
    .cal-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 6px 0 16px; }
    .cal-head .x { width: 44px; height: 44px; flex: none; border: 0; border-radius: 50%; background: none; font-size: 1.7rem; line-height: 1; color: var(--secondary-text-color); }
    .cal-head .x:hover { background: var(--st-plank); color: var(--primary-text-color); }
    dialog.cal stock-track-card { margin-top: -6px; }

    .shelves { display: grid; gap: 3px; padding: 8px 10px 10px; border-radius: 14px; background: var(--st-wash); }
    .names { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); justify-items: center; font-size: 0.7rem; color: var(--secondary-text-color); }
    .shelf { position: relative; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
    .shelf::before { content: ""; position: absolute; left: -4px; right: -4px; bottom: 0; height: 17px; border-radius: 4px;
      background: var(--st-plank); box-shadow: inset 0 2px 0 var(--st-rule), 0 3px 4px -2px rgba(0, 0, 0, 0.35); }
    .slot { position: relative; z-index: 1; min-width: 0; display: grid; grid-template-rows: 1fr 17px; justify-items: center; align-items: end;
      margin: 0; padding: 13px 0 0; border: 0; border-radius: 8px; background: none; }
    .jar { position: relative; width: 64%; max-width: 38px; aspect-ratio: 5 / 6; box-sizing: border-box; display: grid; place-items: center;
      border-radius: 4px 4px 8px 8px; font-family: var(--st-round); font-size: 0.92rem; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
    .jar::before { content: ""; position: absolute; left: -9%; right: -9%; top: -6px; height: 6px; box-sizing: border-box; border-radius: 3px 3px 1px 1px; }
    .used .jar { color: var(--st-on-accent); box-shadow: inset -3px -3px 0 rgba(0, 0, 0, 0.1);
      background: linear-gradient(90deg, transparent 9%, rgba(255, 255, 255, 0.5) 9% 17%, transparent 17%), var(--st-accent); }
    .used .jar::before { background: var(--st-accent-deep); }
    .zero .jar { color: var(--st-dim); font-size: 0.74rem; font-weight: 600; border: 1.5px solid var(--st-line); }
    .zero .jar::before { border: 1.5px solid var(--st-line); }
    .untracked .jar { border: 1.5px dashed var(--st-faint); }
    .future .jar { visibility: hidden; }
    .edge { height: 17px; line-height: 17px; padding: 0 4px; border-radius: 4px; font-size: 0.64rem; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .edge.mon { font-weight: 700; color: var(--primary-text-color); }
    .future .edge { opacity: 0.45; }
    .now .edge { background: var(--st-accent); color: var(--st-on-accent); font-weight: 800; }
    .slot.sel .jar { outline: 2px solid var(--st-accent); outline-offset: 2px; }
    button.slot:hover .jar { filter: brightness(1.1); }
    .slot.pop .jar { animation: st-pop 0.36s cubic-bezier(0.3, 1.6, 0.5, 1) both; }
    @keyframes st-pop { from { transform: translateY(-7px) scale(0.8); } }
    .tag { display: inline-block; font-style: normal; font-family: var(--st-round); font-size: 0.62rem; font-weight: 800; line-height: 1;
      padding: 2px 4px; border-radius: 4px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .k-add { background: var(--st-accent); color: var(--st-on-accent); }
    .k-count { background: var(--st-label); color: var(--st-ink); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.3); }
    .k-take, .k-back { background: var(--st-chip); color: var(--primary-text-color); }
    .slot .tag { position: absolute; top: 0; z-index: 2; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
    .slot .k-add { right: 0; transform: rotate(5deg); }
    .slot .k-count { left: 0; transform: rotate(-5deg); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.4); }

    .sum { display: grid; gap: 8px; font-size: 0.84rem; line-height: 1.45; color: var(--secondary-text-color); }
    .sum p { margin: 0; text-wrap: pretty; }
    .sum b { color: var(--primary-text-color); }
    .foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; }
    .legend { display: inline-flex; align-items: center; gap: 5px; font-size: 0.78rem; }
    .legend .tag { margin-left: 4px; }
    .link { background: none; border: 0; padding: 0; color: var(--primary-color); font-size: inherit; text-decoration: underline; text-underline-offset: 2px; }
    .err { font-size: 0.85rem; color: var(--error-color, #db4437); text-align: center; }
    .compact .err { font-size: 0.78rem; }
    .quiet { margin: 0; font-size: 0.82rem; color: var(--secondary-text-color); }

    .editor { display: grid; gap: 14px; transition: opacity 0.15s ease; }
    .loading .editor { opacity: 0.55; }
    .loading .editor > :not(.day-head) { pointer-events: none; }
    .day-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: -6px 0; }
    .back-link { min-height: 44px; background: none; border: 0; border-radius: 8px; padding: 0 8px 0 2px; color: var(--primary-color); font-size: 0.92rem; font-weight: 500; white-space: nowrap; }
    .back-link span { font-size: 1.2rem; line-height: 0; margin-right: 2px; }
    .nav { display: flex; align-items: center; gap: 0; }
    .nav .icon { min-width: 44px; min-height: 44px; border: 0; border-radius: 8px; background: none; font-size: 1.3rem; line-height: 1; color: var(--secondary-text-color); }
    .nav .icon:not(:disabled):hover { background: var(--secondary-background-color); }
    .nav .icon:disabled { opacity: 0.4; cursor: default; }
    .day-name { min-width: 8.5ch; text-align: center; font-weight: 600; font-size: 0.95rem; }
    .counter.big { gap: 18px; align-items: flex-start; }
    .counter.big .round { width: 54px; height: 54px; font-size: 1.9rem; }
    .counter.big .count { padding-top: 2px; }
    .counter.big .n { font-size: 2.6rem; padding: 0; }
    .btn { display: grid; justify-items: center; gap: 5px; }
    .btn small { font-size: 0.72rem; color: var(--secondary-text-color); white-space: nowrap; }
    .forms { display: grid; gap: 8px; }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) 5em auto; align-items: center; gap: 10px; padding: 8px 8px 8px 12px; border-radius: 12px;
      background: var(--st-wash); }
    .row label { display: grid; gap: 1px; min-width: 0; }
    .row b { font-size: 0.92rem; font-weight: 600; }
    .row small { font-size: 0.74rem; color: var(--secondary-text-color); }
    .field { width: 100%; box-sizing: border-box; padding: 6px 4px; font: inherit; font-family: var(--st-round); font-size: max(16px, 1.1rem); font-weight: 700; text-align: center;
      color: var(--primary-text-color); background: var(--st-fill); border: 1.5px solid var(--st-edge); border-radius: 8px; }
    .field::placeholder { color: var(--secondary-text-color); opacity: 0.5; }
    .pill { min-width: 60px; padding: 8px 14px; border: 0; border-radius: 999px; font-size: 0.88rem; font-weight: 600; background: var(--st-accent); color: var(--st-on-accent); }
    .pill:hover { background: var(--st-accent-lift); }
    .logged h3 { margin: 0 0 4px; font-size: 0.8rem; font-weight: 500; color: var(--secondary-text-color); }
    .log { list-style: none; margin: 0; padding: 0; }
    .entry { display: grid; grid-template-columns: minmax(2.8em, auto) minmax(0, 1fr) auto auto; align-items: center; gap: 10px; min-height: 44px;
      border-bottom: 1px solid var(--st-rule); }
    .entry:last-child { border-bottom: 0; }
    .entry .tag { justify-self: start; font-size: 0.78rem; padding: 3px 6px; }
    .entry .what { font-size: 0.9rem; min-width: 0; }
    .entry .what small { display: block; font-size: 0.75rem; color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .entry .time { font-size: 0.78rem; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .entry.pending { opacity: 0.6; }
    .del { min-width: 44px; height: 44px; padding: 0; border: 0; border-radius: 8px; background: none; color: var(--secondary-text-color); display: grid; place-items: center; --mdc-icon-size: 20px; }
    button.del:hover { color: var(--error-color, #db4437); background: var(--st-error-soft); }
    .del.armed { height: 32px; margin: 6px 0; padding: 0 10px; font-size: 0.8rem; font-weight: 700; color: #fff; background: var(--error-color, #db4437); position: relative; }
    .del.armed::after { content: ""; position: absolute; inset: -6px 0; }
    button.del.armed:hover { color: #fff; background: var(--error-color, #db4437); }
    .note { width: 100%; box-sizing: border-box; font: inherit; font-size: max(16px, 1rem); color: var(--primary-text-color); background: var(--st-fill);
      border: 1px solid transparent; border-radius: 10px; padding: 9px 12px; }
    .note::placeholder { color: var(--secondary-text-color); opacity: 0.8; }
    .note:focus, .exact:focus, .field:focus { outline: none; border-color: var(--st-accent); }

    @container (max-width: 330px) {
      .strip { gap: 8px 12px; } .counter { gap: 8px; } .count { min-width: 64px; } .n { font-size: 2rem; }
      .shelves { padding: 6px 4px 8px; } .edge { padding: 0 2px; font-size: 0.6rem; } .slot .tag { font-size: 0.56rem; padding: 1px 3px; }
      .counter.big { gap: 10px; } .row { grid-template-columns: minmax(0, 1fr) 4em auto; gap: 6px; } .pill { min-width: 0; padding: 8px 10px; }
      .entry { gap: 6px; } }
    @media (prefers-reduced-motion: reduce) { .round { transition: none; } .n, .slot.pop .jar { animation: none !important; } }

    @supports (color: color-mix(in srgb, red, blue)) {
      .body, dialog.cal {
        --st-wash: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
        --st-fill: color-mix(in srgb, var(--primary-text-color) 7%, transparent);
        --st-plank: color-mix(in srgb, var(--primary-text-color) 10%, transparent);
        --st-rule: color-mix(in srgb, var(--primary-text-color) 9%, transparent);
        --st-chip: color-mix(in srgb, var(--primary-text-color) 14%, transparent);
        --st-edge: color-mix(in srgb, var(--primary-text-color) 18%, transparent);
        --st-line: color-mix(in srgb, var(--secondary-text-color) 42%, transparent);
        --st-faint: color-mix(in srgb, var(--secondary-text-color) 30%, transparent);
        --st-dim: color-mix(in srgb, var(--secondary-text-color) 60%, transparent);
        --st-accent-soft: color-mix(in srgb, var(--st-accent) 20%, transparent);
        --st-accent-rim: color-mix(in oklab, var(--st-accent) 78%, #000);
        --st-accent-deep: color-mix(in oklab, var(--st-accent) 58%, #000);
        --st-accent-ring: color-mix(in oklab, var(--st-accent) 70%, #fff);
        --st-accent-lift: color-mix(in oklab, var(--st-accent) 88%, #fff);
        --st-error-soft: color-mix(in srgb, var(--error-color, #db4437) 14%, transparent); }
      /* A used day's canister: paler on lighter days. Its text is set per day, to read on its own shade. */
      .used .jar { color: var(--ink, var(--st-ink));
        background: linear-gradient(90deg, transparent 9%, rgba(255, 255, 255, 0.5) 9% 17%, transparent 17%),
          color-mix(in oklab, var(--st-accent) calc(40% + var(--t, 1) * 60%), var(--st-label)); }
    }
    `;
  }
}

if (!customElements.get("stock-track-card")) customElements.define("stock-track-card", StockTrackCard);
window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === "stock-track-card")) {
  window.customCards.push({ type: "stock-track-card", name: "Stock Track", description: "Keep count of a household supply, see how fast it goes, and look back day by day.", preview: false, documentationURL: "https://github.com/ClermontDigital/StockTrack" });
}
console.info(`%c STOCK-TRACK-CARD %c ${ST_VERSION} `, "background:#3DBEA6;color:#05241E;border-radius:3px 0 0 3px", "background:#1F4F46;color:#fff;border-radius:0 3px 3px 0");
