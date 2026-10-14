// Drive the Stock Track card in headless Chrome against the integration's real WebSocket handlers (see
// server.py): check how it behaves, and retake the made-up-data README screenshots in images/.
//
//   pip install -r requirements_test.txt && npm install --no-save puppeteer-core
//   node tests/card/drive.cjs            (starts tests/card/server.py itself)
//
// Environment: CHROME = path to Chrome or Chromium, PYTHON = the Python that has Home Assistant installed,
// PUPPETEER = where to load puppeteer-core from, PORT = the harness port (8798), SHOTS=0 to leave the
// screenshots in images/ alone, CARD = another copy of the card to serve (mutate.cjs uses it).
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const puppeteer = require(process.env.PUPPETEER || "puppeteer-core");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = process.env.PYTHON || "python3";
const PORT = process.env.PORT || "8798";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "..", "..");
const IMAGES = path.join(ROOT, "images");
const CARD = process.env.CARD || path.join(ROOT, "custom_components/stock_track/www/stock-track-card.js");
const OFFLINE = "Couldn't reach Home Assistant. Check the connection and try again.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  — " + detail}`); };

async function main() {
  const server = spawn(PYTHON, [path.join(__dirname, "server.py")], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PORT } });
  let browser;
  try {
    for (let i = 0; ; i++) {
      try { await fetch(`${BASE}/reset`); break; } catch (err) { if (i > 80) throw new Error("the harness server didn't start"); await sleep(250); }
    }
    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
    const p = await browser.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    // R("card") is the card's shadow root; R("pop") the calendar card's inside the popup.
    await p.evaluateOnNewDocument(() => {
      window.R = (w) => (w === "pop" ? window.card?.shadowRoot.querySelector("dialog stock-track-card")?.shadowRoot : window.card?.shadowRoot);
      // Any CSS colour (oklab from color-mix included) to sRGB, and the WCAG contrast of two.
      window.rgbOf = (css) => { const c = document.createElement("canvas"); c.width = c.height = 1; const x = c.getContext("2d"); x.fillStyle = css; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      window.contrastOf = (el) => {
        const lum = (rgb) => rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
        const cs = getComputedStyle(el); const a = lum(window.rgbOf(cs.color)); const b = lum(window.rgbOf(cs.backgroundColor));
        return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
      };
      // Whether a tap 21 px left, right, above and below the middle of an element still lands on it (a 44 px target,
      // less a pixel either side for rounding).
      window.hitArea = (w, sel) => {
        const r = window.R(w); const el = r?.querySelector(sel); if (!el) return false;
        const b = el.getBoundingClientRect(); const x = b.left + b.width / 2; const y = b.top + b.height / 2;
        return [[-21, 0], [21, 0], [0, -21], [0, 21]].every(([dx, dy]) => el.contains(r.elementFromPoint(x + dx, y + dy)));
      };
    });

    const open = async (qs = "theme=dark", w = 520, h = 900, data = "demo") => {
      await fetch(`${BASE}/reset?data=${data}`);
      await p.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
      await p.goto(`${BASE}/?${qs}`, { waitUntil: "networkidle0" });
      await sleep(350);
    };
    const text = (sel, w = "card") => p.evaluate((s, w) => window.R(w)?.querySelector(s)?.textContent.trim().replace(/\s+/g, " ") ?? null, sel, w);
    const has = (sel, w = "card") => p.evaluate((s, w) => !!window.R(w)?.querySelector(s), sel, w);
    const count = (sel, w = "card") => p.evaluate((s, w) => window.R(w)?.querySelectorAll(s).length ?? 0, sel, w);
    const el = (sel, w = "card") => p.evaluateHandle((s, w) => window.R(w).querySelector(s), sel, w);
    const click = async (sel, w = "card", wait = 400) => { await (await el(sel, w)).click(); await sleep(wait); };
    // A phone's tap on a button doesn't always take focus off the box being typed in: click without moving focus.
    const tap = async (sel, w = "card", wait = 450) => { await p.evaluate((s, w) => window.R(w).querySelector(s).click(), sel, w); await sleep(wait); };
    const tapAt = async (sel, times = 1, w = "card") => {   // the same spot each time, as a finger does
      const b = await (await el(sel, w)).boundingBox();
      for (let i = 0; i < times; i++) await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    };
    const focused = (w = "card") => p.evaluate((w) => { const a = window.R(w)?.activeElement; return a ? a.dataset.act || a.dataset.field || a.dataset.date || a.tagName : null; }, w);
    const value = (sel, w = "card") => p.evaluate((s, w) => window.R(w)?.querySelector(s)?.value ?? null, sel, w);
    const setValue = (sel, v, w = "card") => p.evaluate((s, v, w) => { const i = window.R(w).querySelector(s); i.focus(); i.value = v; i.dispatchEvent(new Event("input", { bubbles: true, composed: true })); }, sel, v, w);
    const log = async () => (await fetch(`${BASE}/log`)).json();
    const store = async (entry = "demo") => (await fetch(`${BASE}/store?entry=${entry}`)).json();
    // A write from "another device": straight to the handlers, not through the card, and not in the card's log.
    const elsewhere = async (msg) => { const r = await fetch(`${BASE}/ws?quiet`, { method: "POST", body: JSON.stringify({ entry_id: "demo", ...msg }) }); return r.json(); };
    const overview = (days = 35, date) => elsewhere({ type: "stock_track/overview", days, ...(date ? { date } : {}) });
    const n = async (w = "card") => Number(((await text(".n", w)) || "").replace(/,/g, ""));
    const today = await p.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
    const shift = (s, k) => { const [y, m, d] = s.split("-").map(Number); const t = new Date(y, m - 1, d + k); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
    const long = (s) => { const [y, m, d] = s.split("-").map(Number); const t = new Date(y, m - 1, d); return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][t.getDay()]} ${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]}`; };
    const shoot = async (file, handle) => { if (process.env.SHOTS !== "0") await (handle || (await p.$("#wrap"))).screenshot({ path: path.join(IMAGES, file) }); };
    const dialogShot = async (file) => shoot(file, await p.evaluateHandle(() => window.card.shadowRoot.querySelector("dialog.cal")));
    const openPopup = async () => { await click('[data-act="calendar"]', "card", 700); };
    const openDay = async (date) => { await click(`[data-date="${date}"]`, "pop", 600); };
    const errText = async (w = "card") => (await text(".err", w)) || "";

    // ---- the strip: what it shows ------------------------------------------------------------------
    await open();
    let o = await overview(1);
    check("the resource's name and icon", (await text(".title span")) === "Toilet paper" && (await p.evaluate(() => window.R("card").querySelector(".title ha-icon").getAttribute("icon"))) === "mdi:paper-roll");
    check("what's in storage, in the resource's unit", (await n()) === o.stats.in_storage && (await text(".unit")) === "rolls in storage", `${await text(".n")} | ${await text(".unit")} vs ${o.stats.in_storage}`);
    const rate = await text(".rates");
    check("the weekly rate and how long the supply lasts", rate.includes(`${Math.round(o.stats.per_week * 10) / 10} a week`) && /\d+ (days|weeks|months|years) left/.test(rate), rate);
    await shoot("strip.png");

    // ---- take one, put one back ----------------------------------------------------------------------
    const start = o.stats.in_storage;
    const takenToday = o.stats.used_today;
    await click('[data-act="take"]');
    let w = await log();
    const live = await p.evaluate(() => { const r = window.R("card"); const sr = r.querySelector(".sr[aria-live]"); return { text: sr?.textContent, outside: !!sr && !r.querySelector(".body").contains(sr), others: r.querySelector(".body").querySelectorAll("[aria-live]").length }; });
    check("screen readers hear the new count, from one live region outside what's redrawn", live.text === `${start - 1} rolls in storage` && live.outside && live.others === 0, JSON.stringify(live));
    check("− takes one out of storage, for today (no date sent)", (await n()) === start - 1 && w.length === 1 && w[0].type === "stock_track/change" && w[0].kind === "take" && w[0].delta === 1 && !("date" in w[0]) && (await store()).in_storage === start - 1, `${await n()} ${JSON.stringify(w)}`);
    await click('[data-act="back"]');
    w = await log();
    let st = await store();
    check("+ puts one back with put_back (no date sent), undoing that take", (await n()) === start && w.at(-1).type === "stock_track/put_back" && !("date" in w.at(-1)) && st.in_storage === start && st.events.filter((e) => e.date === today && e.kind === "take").length === takenToday, `${await n()} ${JSON.stringify(w.at(-1))}`);
    for (let i = 0; i < takenToday + 1; i++) await click('[data-act="back"]');
    st = await store();
    check("+ with no take left to undo still puts one back (a put-back, not a restock)", (await n()) === start + takenToday + 1 && st.in_storage === start + takenToday + 1 && st.events.some((e) => e.date === today && e.kind === "add" && e.put_back), `${await n()} / ${st.in_storage}`);

    let before = await n();
    await tapAt('[data-act="take"]', 5);
    const during = await n(); await sleep(900);
    check("five fast taps on − land on five fewer and stay there", during === before - 5 && (await n()) === before - 5 && (await store()).in_storage === before - 5, `${during} then ${await n()}, stored ${(await store()).in_storage}`);

    const minus = await (await el('[data-act="take"]')).boundingBox();
    await p.mouse.move(minus.x + minus.width / 2, minus.y + minus.height / 2); await p.mouse.down();
    await p.evaluate(() => window.notify()); await sleep(250);
    await p.mouse.up(); await sleep(600);
    check("a refresh during a press doesn't swallow the tap", (await n()) === before - 6, `${await n()}`);

    await (await el('[data-act="take"]')).focus();
    await p.keyboard.press("Enter"); await sleep(350); await p.keyboard.press("Enter"); await sleep(500);
    check("keyboard: Enter twice on − takes two (focus stays put)", (await n()) === before - 8 && (await focused()) === "take", `${await n()}, focus on ${await focused()}`);

    // ---- a stocktake, typed into the number -----------------------------------------------------------
    await click('[data-act="edit"]');
    check("tapping the number opens a box for a stocktake", await has('[data-field="exact"]'));
    await p.keyboard.type("42"); await p.keyboard.press("Enter"); await sleep(500);
    w = await log();
    check("typing 42 records a stocktake of 42 for today, focus back on the number", (await n()) === 42 && w.at(-1).type === "stock_track/stocktake" && w.at(-1).count === 42 && !("date" in w.at(-1)) && (await store()).in_storage === 42 && (await focused()) === "edit", `${await n()} ${JSON.stringify(w.at(-1))} focus ${await focused()}`);

    let marks = (await log()).length;
    await click('[data-act="edit"]');
    await p.keyboard.type("4x"); await p.keyboard.press("Enter"); await sleep(400);
    check("a count that isn't a whole number says so and records nothing", /whole number from 0 to 100,000/.test(await errText()) && (await n()) === 42 && (await log()).length === marks, `${await errText()} | ${await n()}`);
    await click('[data-act="take"]');
    check("the message clears on the next tap", !(await has(".err")) && (await n()) === 41, `${await errText()} | ${await n()}`);

    await click('[data-act="edit"]');
    await p.keyboard.type("3");                                   // on the way to 37 ...
    await elsewhere({ type: "stock_track/change", kind: "take", delta: 1 }); await p.evaluate(() => window.notify());
    await sleep(400);                                             // ... someone else takes one
    check("a refresh doesn't close a stocktake that's being typed", (await has('[data-field="exact"]')) && (await value('[data-field="exact"]')) === "3", await value('[data-field="exact"]'));
    await p.keyboard.type("7"); await p.keyboard.press("Enter"); await sleep(500);
    check("and the finished number is what's saved", (await n()) === 37 && (await store()).in_storage === 37, `${await n()} / ${(await store()).in_storage}`);

    await click('[data-act="edit"]');
    await setValue('[data-field="exact"]', "30");
    marks = (await log()).length;
    await tap('[data-act="take"]', "card", 600);
    w = (await log()).slice(marks);
    check("a typed stocktake is saved before a tap that follows it", w.length === 2 && w[0].type === "stock_track/stocktake" && w[0].count === 30 && w[1].type === "stock_track/change" && (await n()) === 29, `${JSON.stringify(w)} | ${await n()}`);

    marks = (await log()).length;
    await click('[data-act="edit"]'); await click(".title");       // open the box, then tap away without typing
    check("opening and leaving the box without typing records nothing", (await log()).length === marks && (await n()) === 29 && !(await has('[data-field="exact"]')));

    await click('[data-act="edit"]'); await p.keyboard.type("0"); await p.keyboard.press("Enter"); await sleep(500);
    check("− is switched off at zero", (await n()) === 0 && (await p.evaluate(() => window.R("card").querySelector('[data-act="take"]').disabled)));

    // ---- staying in step -------------------------------------------------------------------------------
    await elsewhere({ type: "stock_track/change", kind: "add", delta: 12 }); await p.evaluate(() => window.notify());
    await sleep(400);
    check("follows a change made on another device", (await n()) === 12, `${await n()}`);

    await p.evaluate(() => { window.offline = true; window.card.hass = window.makeHass(false); });
    await tapAt('[data-act="take"]', 2); await sleep(600);
    check("offline: taps are taken back and it says why", (await n()) === 12 && (await errText()) === OFFLINE, `${await n()} | ${await errText()}`);
    await p.evaluate(() => { window.offline = false; });
    await elsewhere({ type: "stock_track/change", kind: "add", delta: 2 });
    await p.evaluate(() => { window.card.hass = window.makeHass(true); });
    await sleep(500);
    check("back online: catches up without being asked", (await n()) === 14 && !(await has(".err")), `${await n()} | ${await errText()}`);
    await elsewhere({ type: "stock_track/put_back" });
    await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await sleep(500);
    check("coming back to the tab refreshes it", (await n()) === 15, `${await n()}`);

    await fetch(`${BASE}/fail?n=1`);
    await click('[data-act="take"]', "card", 600);
    check("a tap Home Assistant refuses is taken back, with its message", (await n()) === 15 && /made-up failure/.test(await errText()), `${await n()} | ${await errText()}`);
    await fetch(`${BASE}/readonly?on=1`);
    await click('[data-act="back"]', "card", 600);
    check("a user who can only look is told so, and nothing changes", (await n()) === 15 && /can look at this but not change it/.test(await errText()) && (await store()).in_storage === 15, `${await n()} | ${await errText()}`);
    await fetch(`${BASE}/readonly?on=0`);

    await p.evaluate(() => { window.frame = window.R("card").querySelector("ha-card"); window.frame.dataset.styled = "yes"; });
    await click('[data-act="take"]'); await click('[data-act="edit"]'); await p.keyboard.press("Escape"); await sleep(300);
    check("Escape leaves the stocktake box without saving, focus back on the number", !(await has('[data-field="exact"]')) && (await focused()) === "edit" && (await n()) === 14);
    check("the card's frame survives redraws (so styling on it doesn't flicker)", await p.evaluate(() => window.R("card").querySelector("ha-card") === window.frame && window.frame.dataset.styled === "yes"));
    check("what card-mod adds inside the card is left alone", await has("#from-card-mod"));

    // Home Assistant restarts: the socket drops, and when it reconnects Stock Track hasn't loaded yet. Home Assistant's
    // own resubscribe fails then and is dropped without a word (home-assistant-js-websocket), so the card must redo it.
    await p.evaluate(() => { window.offline = true; window.card.hass = window.makeHass(false); }); await sleep(200);
    await fetch(`${BASE}/unload?on=1`);
    await p.evaluate(() => { window.offline = false; window.subs = []; window.card.hass = window.makeHass(true); });
    await sleep(600);
    const waiting = await errText();
    await fetch(`${BASE}/unload?on=0`);
    await sleep(2600);
    await elsewhere({ type: "stock_track/change", kind: "add", delta: 10 }); await p.evaluate(() => window.notify()); await sleep(500);
    check("after a restart it waits for Stock Track, then catches up and follows other devices again", /Waiting for Stock Track/.test(waiting) && (await n()) === (await store()).in_storage && !(await has(".err")) && (await p.evaluate(() => window.subs.length)) === 1,
      `${waiting} | ${await n()} vs ${(await store()).in_storage} | ${await errText()} | subs ${await p.evaluate(() => window.subs.length)}`);

    // ---- states ----------------------------------------------------------------------------------------
    await fetch(`${BASE}/config?low=40`); await p.evaluate(() => window.notify()); await sleep(400);
    check("running low: says so in place of the unit", (await has(".strip.low")) && (await text(".low-tag")) === "Running low", await text(".count"));
    await open("theme=light"); await shoot("strip-light.png");
    await open("theme=dark", 520, 900, "fresh");
    check("under a week of tracking, says so plainly", (await text(".rates")) === "Day 1 of 7 rates after a week" && (await n()) === 23, await text(".rates"));
    await open("theme=dark", 520, 900, "empty");
    check("nothing counted yet: asks for a count", (await text(".n")) === "Count" && (await text(".unit")) === "not counted yet" && (await text(".rates")) === "Not started rates after a week", `${await text(".count")} | ${await text(".rates")}`);
    const backOff = () => p.evaluate(() => window.R("card").querySelector('[data-act="back"]').disabled);
    check("with nothing counted and nothing taken, + is off (it would change nothing you can see)", await backOff());
    await click('[data-act="take"]', "card", 500);
    check("...and on once one is taken, so it can be undone", !(await backOff()) && (await text(".n")) === "Count");
    await click('[data-act="back"]', "card", 500);
    await click('[data-act="edit"]'); await p.keyboard.type("12"); await p.keyboard.press("Enter"); await sleep(500);
    check("and the first count starts it", (await n()) === 12 && (await store()).in_storage === 12, `${await text(".count")}`);
    await open("theme=dark", 520, 900, "none");
    check("no resources: says how to add one", /No resources yet/.test((await text(".msg")) || "") && (await has('[data-act="retry"]')), await text(".msg"));
    await open("theme=dark&entry=tins");
    check("another resource brings its own name, unit and icon", (await text(".title span")) === "Tinned food" && (await text(".unit")) === "tins in storage" && (await p.evaluate(() => window.R("card").querySelector(".title ha-icon").getAttribute("icon"))) === "mdi:food-variant", `${await text(".title span")} | ${await text(".unit")}`);
    await open("theme=dark");
    await fetch(`${BASE}/remove?entry=demo`); await p.evaluate(() => window.notify()); await sleep(700);
    check("with no resource chosen, deleting the first one moves the card on to the next", (await text(".title span")) === "Tinned food" && !(await has(".err")), `${await text(".title span")} | ${await errText()}`);
    const specific = fs.readFileSync(CARD, "utf8").split("\n").filter((l) => /toilet|paper(?!-font)|\brolls?\b/i.test(l) && !/^const ST_(UNIT|ICON) =/.test(l));
    check("nothing in the card is about toilet paper beyond the fallback unit and icon", specific.length === 0, specific.join(" | "));

    // ---- the popup: a shelf for each week ---------------------------------------------------------------
    await open("theme=dark&hide_title=1", 520, 1000);
    await openPopup();
    o = await overview(35);
    const pop = await p.evaluate(() => {
      const d = window.card.shadowRoot.querySelector("dialog.cal"); const r = window.R("pop");
      return { open: !!d?.open, slots: r?.querySelectorAll(".slot").length, days: r?.querySelectorAll("button.slot").length, first: r?.querySelector(".slot[data-date]")?.dataset.date,
        title: d?.querySelector(".cal-head .title")?.textContent.trim(), nestedTitle: !!r?.querySelector(".title"), strip: !!r?.querySelector(".strip"), names: r?.querySelector(".names")?.textContent };
    });
    const weekday = (new Date().getDay() + 6) % 7;   // Monday = 0
    check("the calendar button opens five weeks of days in a popup, up to today", pop.open && pop.slots === 35 && pop.days === 28 + weekday + 1 && pop.title === "Toilet paper" && !pop.nestedTitle && !pop.strip, JSON.stringify(pop));
    check("a week to a shelf, Monday first, this week at the bottom", pop.names === "MTWTFSS" && new Date(pop.first + "T12:00").getDay() === 1 && pop.first === shift(today, -weekday - 28), `${pop.names} ${pop.first}`);
    const grid = await p.evaluate(() => [...window.R("pop").querySelectorAll("button.slot")].map((b) => ({ date: b.dataset.date, jar: b.querySelector(".jar").textContent, add: b.querySelector(".k-add")?.textContent || null, cnt: b.querySelector(".k-count")?.textContent || null, now: b.classList.contains("now") })));
    const wrong = grid.filter((g) => { const r = o.series.find((x) => x.date === g.date); return !r || g.jar !== (r.used ? String(r.used) : "") || g.add !== (r.added ? `+${r.added}` : null) || g.cnt !== (r.count != null ? `=${r.count}` : null); });
    check("each day shows how many were used (an empty day shows none), with +N on restock days and =N on stocktake days", wrong.length === 0 && grid.some((g) => g.add) && grid.some((g) => g.cnt), JSON.stringify(wrong.slice(0, 3)));
    const edge = Number(today.slice(8)) === 1 ? long(today).split(" ")[2] : String(Number(today.slice(8)));
    check("today is marked", grid.filter((g) => g.now).map((g) => g.date).join() === today && (await text(".slot.now .edge", "pop")) === edge);
    check("the popup is solid, whatever the card behind it looks like", await p.evaluate(() => { const c = getComputedStyle(window.card.shadowRoot.querySelector("dialog.cal")).backgroundColor.match(/[\d.]+/g); return c.length === 3 || Number(c[3]) === 1; }));
    await dialogShot("popup.png");

    // ---- the day editor, in the popup ------------------------------------------------------------------
    const past = shift(today, -12);   // a restock day in the made-up data
    let rec = (await overview(35, past)).day;
    await openDay(past);
    const shown = await p.evaluate(() => ({ name: window.R("pop").querySelector(".day-name")?.textContent, used: window.R("pop").querySelector(".counter .n")?.textContent, entries: [...window.R("pop").querySelectorAll(".entry")].map((e) => e.querySelector(".what").firstChild.textContent + " " + e.querySelector(".tag").textContent) }));
    check("tapping a day opens it: its date, how many were used, and what was logged", shown.name === long(past) && shown.used === String(rec.used) && shown.entries.length === rec.events.length && shown.entries.includes("Restocked +24"), JSON.stringify(shown));
    check("keyboard focus moves to the way back", (await focused("pop")) === "days");
    const targets = await p.evaluate(() => ({ prev: window.hitArea("pop", '[data-act="prev"]'), next: window.hitArea("pop", '[data-act="next"]'), days: window.hitArea("pop", '[data-act="days"]'),
      del: window.hitArea("pop", '[data-act="del"]'), add: window.hitArea("pop", '[data-act="add-save"]'), close: window.hitArea("card", "dialog [data-close]") }));
    check("the day's buttons take a tap anywhere in 44 px: previous, next, All days, delete, Add, close", Object.values(targets).every(Boolean), JSON.stringify(targets));

    const sizes = await p.evaluate(() => ["note", "add", "count"].map((f) => parseFloat(getComputedStyle(window.R("pop").querySelector(`[data-field="${f}"]`)).fontSize)));
    check("text boxes are at least 16 px, so a phone doesn't zoom in on them", sizes.every((x) => x >= 16), sizes.join());
    marks = (await log()).length;
    await click('[data-act="day-take"]', "pop", 500);
    w = (await log()).slice(marks);
    check("...and the day editor says how many were used on the day", (await p.evaluate(() => window.R("pop").querySelector(".sr").textContent)) === `${rec.used + 1} used on ${long(past)}`, await p.evaluate(() => window.R("pop").querySelector(".sr").textContent));
    check("+ on a past day takes one on that day", w.length === 1 && w[0].type === "stock_track/change" && w[0].kind === "take" && w[0].date === past && (await text(".counter .n", "pop")) === String(rec.used + 1), `${JSON.stringify(w)} | ${await text(".counter .n", "pop")}`);
    await click('[data-act="day-back"]', "pop", 500);
    w = (await log()).slice(marks);
    check("− on a past day puts one back on that day", w.length === 2 && w[1].type === "stock_track/put_back" && w[1].date === past && (await text(".counter .n", "pop")) === String(rec.used), `${JSON.stringify(w)} | ${await text(".counter .n", "pop")}`);

    await setValue('[data-field="add"]', "12", "pop"); await click('[data-act="add-save"]', "pop", 500);
    w = await log();
    check("restock: 12 logged for that day, and focus stays on Add (a phone's keyboard goes away)", w.at(-1).type === "stock_track/change" && w.at(-1).kind === "add" && w.at(-1).delta === 12 && w.at(-1).date === past && (await count(".entry .k-add", "pop")) === 2 && (await value('[data-field="add"]', "pop")) === "" && (await focused("pop")) === "add-save", `${JSON.stringify(w.at(-1))} focus ${await focused("pop")}`);
    marks = (await log()).length;
    await click('[data-act="add-save"]', "pop", 300);
    check("Add with nothing typed puts the cursor in the box instead", (await focused("pop")) === "add" && (await log()).length === marks);
    await (await el('[data-field="count"]', "pop")).focus(); await p.keyboard.type("15"); await p.keyboard.press("Enter"); await sleep(500);
    w = await log();
    check("stocktake: a count for that day, from Enter, focus on Save", w.at(-1).type === "stock_track/stocktake" && w.at(-1).count === 15 && w.at(-1).date === past && (await text(".entry:last-child .tag", "pop")) === "=15" && (await focused("pop")) === "count-save", `${JSON.stringify(w.at(-1))} | ${await text(".entry:last-child .tag", "pop")} | focus ${await focused("pop")}`);
    await setValue('[data-field="add"]', "0", "pop"); await click('[data-act="add-save"]', "pop", 400);
    check("a restock of nothing says what to type and keeps the box as it was", /how many went into storage, a whole number from 1/.test(await errText("pop")) && (await value('[data-field="add"]', "pop")) === "0", await errText("pop"));
    await setValue('[data-field="add"]', "", "pop");

    rec = (await overview(35, past)).day;
    const restock = rec.events.find((e) => e.kind === "add" && e.n === 24);
    marks = (await log()).length;
    await click(`[data-act="del"][data-id="${restock.id}"]`, "pop", 300);
    check("delete asks first: the first tap only arms it", (await text(`[data-id="${restock.id}"]`, "pop")) === "Delete?" && (await log()).length === marks);
    await click(`[data-act="del"][data-id="${restock.id}"]`, "pop", 500);
    w = (await log()).slice(marks);
    check("the second tap deletes that entry", w.length === 1 && w[0].type === "stock_track/delete_event" && w[0].event_id === restock.id && !(await store()).events.some((e) => e.id === restock.id) && !(await has(`[data-id="${restock.id}"]`, "pop")), JSON.stringify(w));
    const gone = (await overview(35, past)).day.events.find((e) => e.kind === "add");
    await elsewhere({ type: "stock_track/delete_event", event_id: gone.id });   // deleted on another device first
    await click(`[data-act="del"][data-id="${gone.id}"]`, "pop", 250); await click(`[data-act="del"][data-id="${gone.id}"]`, "pop", 600);
    check("deleting something already gone shows Home Assistant's message", /isn't in the log/.test(await errText("pop")) && !(await has(`[data-id="${gone.id}"]`, "pop")), await errText("pop"));

    check("the day's note is shown", (await value('[data-field="note"]', "pop")) === rec.note && rec.note !== "", await value('[data-field="note"]', "pop"));
    await (await el('[data-field="note"]', "pop")).click({ clickCount: 3 }); await p.keyboard.type("Checked the cupboard"); await p.keyboard.press("Tab"); await sleep(500);
    check("a day note is saved for that day", (await store()).notes[past] === "Checked the cupboard" && (await log()).at(-1).type === "stock_track/set_note" && (await log()).at(-1).date === past,
      `${JSON.stringify((await store()).notes[past])} | ${JSON.stringify((await log()).at(-1))} | ${await errText("pop")}`);
    await setValue('[data-field="note"]', "half-typ", "pop"); await p.evaluate(() => window.notify()); await sleep(400);
    check("a refresh keeps a half-typed note and the cursor in it", (await value('[data-field="note"]', "pop")) === "half-typ" && (await focused("pop")) === "note");
    await setValue('[data-field="note"]', "Checked the cupboard twice", "pop");
    await tap('[data-act="prev"]', "pop", 600);
    st = await store();
    check("a typed note goes to the day it was typed for, not the day moved to", st.notes[past] === "Checked the cupboard twice" && !st.notes[shift(past, -1)] && (await text(".day-name", "pop")) === long(shift(past, -1)) && (await value('[data-field="note"]', "pop")) === "", `${JSON.stringify(st.notes)} | ${await text(".day-name", "pop")}`);
    await setValue('[data-field="add"]', "5", "pop");
    marks = (await log()).length;
    await tap('[data-act="day-take"]', "pop", 600);
    w = (await log()).slice(marks);
    check("a typed restock is saved before another tap on the same day", w.length === 2 && w[0].kind === "add" && w[0].delta === 5 && w[0].date === shift(past, -1) && w[1].kind === "take" && w[1].date === shift(past, -1), JSON.stringify(w));
    await click('[data-act="day-back"]', "pop", 500);
    await tap('[data-act="next"]', "pop", 600);
    await p.evaluate(() => { const r = window.R("pop"); window.flash = false; window.mo = new MutationObserver(() => { if (r.querySelector(".shelves")) window.flash = true; }); window.mo.observe(r.querySelector("ha-card"), { childList: true, subtree: true }); });
    await click('[data-act="prev"]', "pop", 500); await click('[data-act="next"]', "pop", 500);
    check("moving between days keeps the day open, without a flash of the shelves", !(await p.evaluate(() => window.flash)) && (await text(".day-name", "pop")) === long(past) && !(await has(".loading", "pop")));
    await p.evaluate(() => window.mo.disconnect());
    await (await el('[data-field="count"]', "pop")).focus(); await p.keyboard.type("9"); await p.keyboard.press("Escape"); await sleep(300);
    check("Escape in a box clears it, and leaves the popup and the day open", (await value('[data-field="count"]', "pop")) === "" && (await has(".editor", "pop")) && (await p.evaluate(() => window.card.shadowRoot.querySelector("dialog.cal")?.open)));
    await (await el('[data-act="prev"]', "pop")).focus(); await p.keyboard.press("Escape"); await sleep(500);
    check("Escape on the day goes back to the shelves, with focus on that day", !(await has(".editor", "pop")) && (await has(".shelves", "pop")) && (await focused("pop")) === past && (await p.evaluate(() => window.card.shadowRoot.querySelector("dialog.cal")?.open)), `${await focused("pop")}`);
    check("and the day's new restock shows on its shelf", (await text(`[data-date="${shift(past, -1)}"] .k-add`, "pop")) === "+5", await text(`[data-date="${shift(past, -1)}"] .k-add`, "pop"));

    // What's typed for a day stays with that day: saved by its own Add, Save or Enter (or another tap on that day),
    // never later, for a day nobody is looking at.
    const dA = shift(past, -3), dB = shift(past, -2);
    await openDay(dA);
    await (await el('[data-field="add"]', "pop")).focus(); await p.keyboard.type("5"); await p.keyboard.press("Tab"); await sleep(100);
    await p.evaluate(() => window.notify()); await sleep(400);
    check("a refresh keeps a typed restock after focus has moved on to its Add button", (await value('[data-field="add"]', "pop")) === "5" && (await focused("pop")) === "add-save", `${await value('[data-field="add"]', "pop")} / ${await focused("pop")}`);
    marks = (await log()).length;
    await p.keyboard.press("Escape"); await sleep(500);
    await openDay(dB);
    check("a restock typed but not added is dropped on leaving the day (Escape, then another day)", (await log()).length === marks && (await value('[data-field="add"]', "pop")) === "", JSON.stringify((await log()).slice(marks)));
    await (await el('[data-field="count"]', "pop")).focus(); await p.keyboard.type("3");
    await p.evaluate(() => window.card.shadowRoot.querySelector("dialog.cal").dispatchEvent(new Event("cancel", { cancelable: true }))); await sleep(500);
    check("the back gesture goes back to the shelves", (await has(".shelves", "pop")) && (await p.evaluate(() => window.card.shadowRoot.querySelector("dialog.cal")?.open)));
    await openDay(dA);
    check("...and what was typed is neither saved later nor waiting in its box on going back", (await log()).length === marks && (await value('[data-field="add"]', "pop")) === "" && (await value('[data-field="count"]', "pop")) === "", JSON.stringify((await log()).slice(marks)));
    await setValue('[data-field="add"]', "7", "pop"); await fetch(`${BASE}/fail?n=1`);
    await click('[data-act="add-save"]', "pop", 600);
    check("a restock Home Assistant refuses stays in its box, with the message", /made-up failure/.test(await errText("pop")) && (await value('[data-field="add"]', "pop")) === "7", `${await errText("pop")} / ${await value('[data-field="add"]', "pop")}`);
    await tap('[data-act="next"]', "pop", 600);
    marks = (await log()).length;
    await tap('[data-act="day-take"]', "pop", 600);
    w = (await log()).slice(marks);
    check("...but isn't sent again by a tap on another day", w.length === 1 && w[0].kind === "take" && w[0].date === dB, JSON.stringify(w));

    await (await el('[data-field="note"]', "pop")).click({ clickCount: 3 }); await p.keyboard.type("Bought the b");
    await p.evaluate(() => { window.noteBox = window.R("pop").querySelector('[data-field="note"]'); });
    marks = (await log()).length;
    const errorsBefore = errors.length;
    await elsewhere({ type: "stock_track/change", kind: "take", delta: 1 }); await p.evaluate(() => window.notify()); await sleep(500);
    const kept = await p.evaluate(() => ({ same: window.R("pop").activeElement === window.noteBox, connected: window.noteBox.isConnected }));
    await p.keyboard.type("ig pack"); await sleep(100);
    check("a refresh while a note is being typed leaves the box alone: nothing saved, same box, typing carries on",
      (await log()).length === marks && errors.length === errorsBefore && kept.same && kept.connected && (await value('[data-field="note"]', "pop")) === "Bought the big pack",
      `${JSON.stringify((await log()).slice(marks))} ${JSON.stringify(kept)} ${errors.slice(errorsBefore)} "${await value('[data-field="note"]', "pop")}"`);
    await p.keyboard.press("Tab"); await sleep(500);
    check("...and leaving the box saves all of it", (await store()).notes[dB] === "Bought the big pack", JSON.stringify((await store()).notes[dB]));
    await p.keyboard.press("Escape"); await sleep(400);

    const outside = await n();
    await openDay(today);
    check("today's day can't go forward, and days to come can't be opened", (await p.evaluate(() => window.R("pop").querySelector('[data-act="next"]').disabled)) && (await text(".day-name", "pop")) === "Today");
    marks = (await log()).length;
    await click('[data-act="day-take"]', "pop", 700);
    w = (await log()).slice(marks);
    check("a take logged for today in the popup has no date, and shows on the strip behind it", w.length === 1 && !("date" in w[0]) && (await n()) === outside - 1, `${JSON.stringify(w)} | strip ${await n()}`);
    await p.keyboard.press("Escape"); await sleep(300); await p.keyboard.press("Escape"); await sleep(500);
    check("Escape twice closes the popup and puts focus back on its button", !(await has("dialog.cal")) && (await focused()) === "calendar", `${await has("dialog.cal")} / ${await focused()}`);
    await openPopup();
    await p.evaluate(() => window.card.shadowRoot.querySelector("dialog.cal [data-close]").click()); await sleep(400);
    check("the popup's close button closes it", !(await has("dialog.cal")));

    await open("theme=dark&weeks=8&hide_title=1", 520, 1200);
    await openPopup();
    check("weeks: eight shelves", (await count(".shelf", "pop")) === 8 && (await count(".slot", "pop")) === 56);

    await open("theme=dark&hide_title=1", 520, 1000);
    await openPopup(); await openDay(past);
    const subsOpen = await p.evaluate(() => window.subs.length);
    // What a masonry view does when its columns change (a phone turned): the card is taken out and put back at once.
    await p.evaluate(() => { const col = document.createElement("div"); col.style.width = "440px"; document.body.appendChild(col); col.appendChild(window.card); });
    await sleep(500);
    const moved = await p.evaluate(() => { const d = window.card.shadowRoot.querySelector("dialog.cal"); return { open: !!d?.open, modal: !!d?.matches(":modal"), day: window.R("pop")?.querySelector(".day-name")?.textContent, subs: window.subs.length }; });
    check("a card that's moved (a phone turned) keeps its popup, as a popup, on the same day", moved.open && moved.modal && moved.day === long(past) && moved.subs === subsOpen, JSON.stringify(moved));
    await p.keyboard.press("Escape"); await sleep(300); await p.keyboard.press("Escape"); await sleep(400);
    check("...and still closes as before", !(await has("dialog.cal")) && (await focused()) === "calendar");
    await openPopup(); await openDay(past);
    const noteBox = await (await el('[data-field="note"]', "pop")).boundingBox();
    await p.mouse.move(noteBox.x + 20, noteBox.y + noteBox.height / 2); await p.mouse.down();
    await p.mouse.move(6, 6, { steps: 5 }); await p.mouse.up(); await sleep(400);
    check("selecting text in the popup and letting go outside it doesn't close it", await p.evaluate(() => !!window.card.shadowRoot.querySelector("dialog.cal")?.open));
    await p.mouse.click(6, 6); await sleep(400);
    check("a tap outside it does", !(await has("dialog.cal")));
    await open("theme=dark&hide_title=1", 520, 1000, "fresh");
    await openPopup();
    const fresh = await p.evaluate((t) => [...window.R("pop").querySelectorAll("button.slot")].map((b) => ({ date: b.dataset.date, cls: b.className, jar: b.querySelector(".jar").textContent })), today);
    const early = fresh.filter((f) => f.date < today);
    check("days before tracking began look untracked, not like zero", early.length > 0 && early.every((f) => /untracked/.test(f.cls) && f.jar === "") && /zero|used/.test(fresh.at(-1).cls) && !/untracked/.test(fresh.at(-1).cls), JSON.stringify(fresh.slice(-3)));
    check("a restock before tracking began still carries its +8", (await text(`[data-date="${shift(today, -2)}"] .k-add`, "pop")) === "+8");

    // ---- the popup on the dark navy dashboard card ------------------------------------------------------
    await open("theme=navy&hide_title=1&w=380", 460, 1000);
    const accent = await p.evaluate(() => getComputedStyle(window.R("card").querySelector('[data-act="take"]')).backgroundColor);
    check("card-mod's --st-accent on ha-card colours the card", accent === "rgb(255, 122, 147)", accent);
    const bare = await p.evaluate(() => { const r = window.R("card"); const kids = [...r.querySelector(".strip").querySelectorAll(".counter, .side")].map((k) => Math.round(k.getBoundingClientRect().top + k.getBoundingClientRect().height / 2)); return { h: Math.round(r.querySelector("ha-card").getBoundingClientRect().height), rows: new Set(kids.map((y) => Math.round(y / 12))).size, title: !!r.querySelector(".title") }; });
    check("compact without its title is one line, under 90 px, on a 380 px card", !bare.title && bare.rows === 1 && bare.h <= 90, JSON.stringify(bare));
    const stripTargets = await p.evaluate(() => ({ calendar: window.hitArea("card", '[data-act="calendar"]'), number: window.hitArea("card", '[data-act="edit"]'), take: window.hitArea("card", '[data-act="take"]'), back: window.hitArea("card", '[data-act="back"]') }));
    check("...and its buttons take a tap anywhere in 44 px, the calendar button too", Object.values(stripTargets).every(Boolean), JSON.stringify(stripTargets));
    await shoot("strip-navy.png");
    await openPopup();
    const navy = await p.evaluate(() => { const d = window.card.shadowRoot.querySelector("dialog.cal"); const s = getComputedStyle(d); return { bg: s.backgroundColor, img: s.backgroundImage, left: s.borderLeftColor, now: getComputedStyle(window.R("pop").querySelector(".slot.now .edge")).backgroundColor }; });
    check("on a see-through navy card the popup keeps the gradient over a solid base, and the accent", /gradient/.test(navy.img) && (navy.bg.match(/[\d.]+/g).length === 3 || Number(navy.bg.match(/[\d.]+/g)[3]) === 1) && navy.left === "rgb(255, 122, 147)" && navy.now === "rgb(255, 122, 147)", JSON.stringify(navy));
    await dialogShot("popup-navy.png");

    // ---- text on the accent -----------------------------------------------------------------------------
    await open("theme=light&view=calendar");
    const ink = (w = "card") => p.evaluate((w) => {
      const r = window.R(w);
      const jars = [...r.querySelectorAll(".slot.used .jar")].map((j) => window.contrastOf(j));
      return { take: window.contrastOf(r.querySelector('[data-act="take"]')), today: window.contrastOf(r.querySelector(".slot.now .edge")), sticker: window.contrastOf(r.querySelector(".slot .k-add")), jars: Math.min(...jars), color: getComputedStyle(r.querySelector('[data-act="take"]')).color };
    }, w);
    let k = await ink();
    check("text on the default accent is dark, and readable (4.5:1 or better)", k.color === "rgb(5, 36, 30)" && Math.min(k.take, k.today, k.sticker, k.jars) >= 4.5, JSON.stringify(k));
    await p.evaluate(() => window.card.style.setProperty("--stock-track-accent", "#1565C0")); await p.evaluate(() => window.notify()); await sleep(500);
    k = await ink();
    check("on a dark accent it turns light, and stays readable on the button, today's date, the stickers and every day's canister", k.color === "rgb(255, 255, 255)" && Math.min(k.take, k.today, k.sticker, k.jars) >= 4.5, JSON.stringify(k));
    await open("theme=dark");
    await p.evaluate(() => { window.card.shadowRoot.querySelector("#from-card-mod").innerHTML = "<style>ha-card { --st-accent: #0D47A1; }</style>"; });
    await sleep(2100); await p.evaluate(() => { window.card.hass = window.makeHass(); }); await sleep(300);
    check("an accent card-mod applies after the first draw is picked up too", (await p.evaluate(() => getComputedStyle(window.R("card").querySelector('[data-act="take"]')).color)) === "rgb(255, 255, 255)");

    // ---- the calendar layout: the shelves on the card -------------------------------------------------
    await open("theme=dark&view=calendar");
    check("calendar layout: title, strip and shelves on the card", (await has(".title")) && (await has(".strip")) && (await count(".slot")) === 35 && !(await has(".cal-open")));
    await shoot("calendar.png");
    await click(`[data-date="${shift(today, -3)}"]`, "card", 600);
    check("calendar layout: a day opens in place of the shelves, without the strip", (await has(".editor")) && !(await has(".strip")) && !(await has(".shelves")) && (await text(".day-name")) === long(shift(today, -3)));
    await click('[data-act="days"]', "card", 500);
    check("calendar layout: All days goes back, with focus on that day", (await has(".shelves")) && (await has(".strip")) && (await focused()) === shift(today, -3));
    const slow = shift(today, -6);
    await click(`[data-date="${slow}"]`, "card", 600);
    await p.evaluate(() => { const hass = window.card._hass; const real = hass.callWS; window.card.hass = { ...hass, callWS: async (msg) => { if (msg.type === "stock_track/overview") await new Promise((r) => setTimeout(r, 1200)); return real(msg); } }; });
    await click('[data-act="next"]', "card", 100);
    await (await el('[data-act="day-take"]')).focus();
    marks = (await log()).length;
    await p.keyboard.press("Enter"); await sleep(1600);
    check("Enter on Take one while the next day loads logs nothing on the day being left", (await log()).length === marks && (await text(".day-name")) === long(shift(slow, 1)), JSON.stringify((await log()).slice(marks)));
    await p.evaluate(() => { window.card.hass = window.makeHass(); });
    await click('[data-act="days"]', "card", 500);

    // ---- export ----------------------------------------------------------------------------------------
    await p.evaluate(() => {
      window.csv = null;
      // The raw bytes, since decoding as UTF-8 swallows the byte-order mark.
      URL.createObjectURL = (blob) => { blob.arrayBuffer().then((b) => { const u = new Uint8Array(b); window.bom = u[0] === 0xEF && u[1] === 0xBB && u[2] === 0xBF; window.csv = new TextDecoder().decode(u); }); return "blob:test"; };
      HTMLAnchorElement.prototype.click = () => {};
    });
    await elsewhere({ type: "stock_track/set_note", date: today, note: '=SUM(A1) "x"' });
    await elsewhere({ type: "stock_track/put_back", date: shift(today, -1) });
    await elsewhere({ type: "stock_track/change", kind: "take", delta: 1, date: shift(today, -2) });   // filled in later: no real time
    await click('[data-act="export"]', "card", 600);
    const csv = (await p.evaluate(() => window.csv)) || "";
    const lines = csv.trim().split("\n");
    const bom = await p.evaluate(() => window.bom);
    check("the CSV opens as UTF-8 in Excel, leaves stand-in times out, and has every entry and no live formulas",
      bom && lines[0] === "date,time,what,amount,note" && lines.some((l) => l === `${shift(today, -2)},,taken,1,""`) && lines.some((l) => l.startsWith(`${today},,day note,,"'=SUM(A1) ""x"""`))
      && ["taken", "restocked", "stocktake", "put back"].every((k) => lines.some((l) => l.split(",")[2] === k)) && lines.length - 1 === (await store()).events.length + Object.keys((await store()).notes).length,
      `bom ${bom} backdated ${lines.some((l) => l === `${shift(today, -2)},,taken,1,""`)} rows ${lines.length - 1} vs ${(await store()).events.length}+${Object.keys((await store()).notes).length} | ${lines.filter((l) => l.startsWith(shift(today, -2))).join(" / ")}`);

    // ---- light, and the day editor for the README -------------------------------------------------------
    for (const theme of ["dark", "light"]) {
      await open(`theme=${theme}&hide_title=1`, 520, 1100);
      if (theme === "light") { await openPopup(); await dialogShot("popup-light.png"); await p.keyboard.press("Escape"); await sleep(400); }
      await openPopup(); await openDay(past);
      await dialogShot(theme === "dark" ? "day.png" : "day-light.png");
    }

    // ---- narrow cards, markup, settings -------------------------------------------------------------------
    await open("theme=dark&w=250", 330, 600);
    check("compact: wraps on a narrow card without overflowing", await p.evaluate(() => { const c = window.R("card").querySelector(".st"); return c.scrollWidth <= c.clientWidth + 1; }));
    await open("theme=dark&view=calendar&w=260", 330, 1000);
    const narrow = async (w) => p.evaluate((w) => { const c = window.R(w).querySelector(".st"); return c.scrollWidth <= c.clientWidth + 1; }, w);
    check("calendar: nothing overflows a narrow card", await narrow("card"));
    await click(`[data-date="${past}"]`, "card", 600);
    check("calendar: nor does the day editor", (await has(".editor")) && (await narrow("card")));
    await open("theme=dark&hide_title=1", 320, 700);
    await openPopup(); await openDay(past);
    check("the popup fits a 320 px phone", (await narrow("pop")) && (await p.evaluate(() => window.card.shadowRoot.querySelector("dialog.cal").getBoundingClientRect().width <= 320)));

    await open("theme=dark&view=calendar&title=" + encodeURIComponent('<img src=x onerror="window.pwned=1">'));
    await elsewhere({ type: "stock_track/set_note", date: shift(today, -2), note: '<img src=x onerror="window.pwned=2">' }); await p.evaluate(() => window.notify()); await sleep(400);
    await click(`[data-date="${shift(today, -2)}"]`, "card", 600);
    check("a title and a note with markup are shown as text", !(await p.evaluate(() => window.pwned)) && /<img/.test(await text(".title span")) && (await value('[data-field="note"]')) === '<img src=x onerror="window.pwned=2">');

    const settings = await p.evaluate(() => {
      const c = document.createElement("stock-track-card");
      const bad = (cfg) => { try { c.setConfig(cfg); return false; } catch (e) { return /Stock Track/.test(e.message); } };
      const form = customElements.get("stock-track-card").getConfigForm();
      const entry = form.schema.find((s) => s.name === "entry_id");
      const empty = [null, ""].map((v) => { try { c.setConfig({ view: v }); return c._config.view; } catch (e) { return "refused"; } }).join();
      return { view: bad({ view: "grid" }), weeks: bad({ weeks: 13 }), weeks1: bad({ weeks: 1 }), ok: !bad({ view: "calendar", weeks: 12 }), empty, selector: entry?.selector?.config_entry?.integration, stub: JSON.stringify(customElements.get("stock-track-card").getStubConfig()), labels: form.schema.every((s) => form.computeLabel(s)) };
    });
    check("settings: a bad layout or week count is refused, an empty one is compact; the form picks a Stock Track resource", settings.view && settings.weeks && settings.weeks1 && settings.ok && settings.empty === "compact,compact" && settings.selector === "stock_track" && settings.stub === "{}" && settings.labels, JSON.stringify(settings));

    // Older iPhones (iOS before 16.2) can't mix colours: what's drawn then is the plain set of tints.
    await open("theme=dark");
    const plain = await p.evaluate(async () => {
      const C = customElements.get("stock-track-card");
      const css = C.styles;
      const before = css.replace(/\/\*[\s\S]*?\*\//g, "").split("@supports")[0];
      const used = new Set(css.match(/var\(--st-[a-z-]+/g).map((x) => x.slice(4)));
      const defined = new Set([...before.matchAll(/(--st-[a-z-]+):/g)].map((m) => m[1]));
      Object.defineProperty(C, "styles", { configurable: true, get: () => css.replace("@supports (color: color-mix(in srgb, red, blue))", "@supports (color: no-such-colour(1))") });
      const c = document.createElement("stock-track-card");
      c.setConfig({ view: "calendar" });
      document.getElementById("wrap").appendChild(c);
      c.hass = window.makeHass();
      await new Promise((r) => setTimeout(r, 700));
      Object.defineProperty(C, "styles", { configurable: true, get: () => css });
      const r = c.shadowRoot; const jar = r.querySelector(".slot.used .jar");
      const clear = (v) => v === "rgba(0, 0, 0, 0)" || v === "transparent";
      const out = { mixFree: !before.includes("color-mix("), undefinedTints: [...used].filter((u) => !defined.has(u)),
        jarFill: !clear(getComputedStyle(jar).backgroundColor), lid: !clear(getComputedStyle(jar, "::before").backgroundColor),
        shelf: !clear(getComputedStyle(r.querySelector(".shelf"), "::before").backgroundColor), shelves: !clear(getComputedStyle(r.querySelector(".shelves")).backgroundColor),
        jarText: window.contrastOf(jar) };
      c.remove();
      return out;
    });
    check("without colour mixing (older iOS) every tint has a plain colour, and used days keep a fill with readable text", plain.mixFree && plain.undefinedTints.length === 0 && plain.jarFill && plain.lid && plain.shelf && plain.shelves && plain.jarText >= 4.5, JSON.stringify(plain));

    check("no script errors", errors.length === 0, errors.join(" | "));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.length && results.every(Boolean) ? 0 : 1);
}

main().catch((err) => { console.error("driver failed:", err); process.exit(2); });
