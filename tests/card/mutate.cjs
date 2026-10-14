// Mutation checks for the card: break one important behaviour at a time in a copy of the card, run drive.cjs
// against the copy, and confirm a check notices. The real card is never touched.
//
//   node tests/card/mutate.cjs              (same environment as drive.cjs; JOBS=3 runs at once, ONLY=name,name)
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CARD = path.resolve(__dirname, "../../custom_components/stock_track/www/stock-track-card.js");
const source = fs.readFileSync(CARD, "utf8");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stock-track-mutants-"));

// [name, what to find, what to put instead, words from the check(s) that must fail]. Where two separate guards
// stop the same thing, "what to find" is a list of [find, replace] pairs and the mutant breaks both.
const MUTANTS = [
  ["card-mod wipe: redraw the whole shadow root", "stMorph(this._main, next);",
    "this.shadowRoot.innerHTML = `<style>${StockTrackCard.styles}</style><ha-card><div class=\"body\">${next.innerHTML}</div></ha-card>`; this._frame = this.shadowRoot.querySelector(\"ha-card\"); this._main = this.shadowRoot.querySelector(\".body\");", ["card-mod adds", "frame survives"]],
  ["redraws replace the boxes instead of patching them", "stMorph(this._main, next);", "this._main.innerHTML = next.innerHTML;", ["while a note is being typed"]],
  ["see-through popup: the card's own (clear) fill as its base", "dialog.style.backgroundColor = getComputedStyle(this).getPropertyValue(\"--primary-background-color\").trim() || \"#111\";",
    "dialog.style.backgroundColor = look.backgroundColor;", ["solid base"]],
  ["no rollback when a write fails", "this._ops = this._ops.filter((o) => o !== op);", "", ["taken back"]],
  ["offline: a vague message", 'err.message ? String(err.message) : ST_OFFLINE', 'err.message ? String(err.message) : "Error " + err', ["says why"]],
  // Patching in place keeps the button under a finger too, so the press guard is a second layer: break both.
  ["redraw while a finger is down", [["stMorph(this._main, next);", "this._main.innerHTML = next.innerHTML;"], ["if (this._pressing || (this._editing", "if ((this._editing"]], null, ["during a press"]],
  ["keyboard focus not put back", "el.focus({ preventScroll: true });", "", ["focus back on the number"]],
  ["a typed restock lost on a refresh once focus moves on", 'value="${stEsc(draft("add") ?? "")}"', 'value=""', ["keeps a typed restock"]],
  ["typed values not saved before the next tap", 'if (!cell && !["prev", "next", "days", "edit"].includes(act)) this._flushTyped();', "if (false) this._flushTyped();", ["restock: 12 logged"]],
  ["no catch-up on reconnect", "    clearTimeout(this._retryTimer);\n    this._load();\n  }", "    clearTimeout(this._retryTimer);\n  }", ["back online"]],
  ["no retry while Stock Track is still loading", '      if (err?.code !== "not_found") this._retryLater();\n', "", ["after a restart"]],
  ["the dead subscription kept after a restart", "    this._unsubscribe();\n    this._retries = 0;", "    this._retries = 0;", ["after a restart"]],
  ["no refresh when the tab comes back", 'if (document.visibilityState === "visible") this._load();', 'if (document.visibilityState === "visible") void 0;', ["coming back to the tab"]],
  ["no subscription", "this._hass.connection.subscribeMessage(() => this._load(),", "Promise.reject(() => this._load(),", ["another device"]],
  ["+ restocks instead of putting back", 'this._do({ type: "put_back", date }, this._dated({ type: "stock_track/put_back" }, date));',
    'this._do({ type: "change", kind: "add", delta: 1, date }, this._dated({ type: "stock_track/change", kind: "add", delta: 1 }, date));', ["put_back"]],
  ["+ on with nothing counted or taken", '${level == null && !s.used_today ? "disabled" : ""}', "", ["+ is off"]],
  ["today's writes carry a date", "_dated(msg, date) { return date === this._data.today ? msg : { ...msg, date }; }", "_dated(msg, date) { return { ...msg, date }; }", ["no date"]],
  ["typed values follow you to other days", [["    this._drafts = {};\n    this._armed = null;\n  }", "    this._armed = null;\n  }"],
    ["if (d.date !== shown) delete this._drafts[f];\n      else if (f === \"note\")", "if (f === \"note\")"]], null, ["isn't sent again by a tap on another day"]],
  ["typed values not dropped on leaving the day", "    this._drafts = {};\n    this._armed = null;\n  }", "    this._armed = null;\n  }", ["waiting in its box"]],
  ["the day editor's taps work while the next day loads", "    if (this._loadingDay() && ST_EDITS.has(act)) return;\n", "", ["while the next day loads"]],
  ["Add puts the cursor back in the emptied box", "this._focusNext = typed && !this._drafts[field] ? `[data-act=\"${act}\"]` : `[data-field=\"${field}\"]`;", "this._focusNext = `[data-field=\"${field}\"]`;", ["focus stays on Add"]],
  ["Enter in the stocktake box drops focus", "      this._focusNext = '[data-act=\"edit\"]';   // back on the number, as Escape does\n", "", ["focus back on the number"]],
  ["an empty layout setting kept", 'const view = config?.view || "compact";', 'const view = config?.view ?? "compact";', ["an empty one is compact"]],
  ["CSV without a byte-order mark", '"\\uFEFF" + ', "", ["opens as UTF-8"]],
  ["CSV with stand-in times", '${e.backdated ? "" : stClock(e.ts)}', "${stClock(e.ts)}", ["opens as UTF-8"]],
  ["CSV cells can start formulas", "(/^[=+\\-@\\t\\r]/.test(s) ? \"'\" + s : s)", "s", ["no live formulas"]],
  ["note box under 16px (iOS zooms in)", "font-size: max(16px, 1rem);", "font-size: 0.9rem;", ["at least 16 px"]],
  ["a deleted first resource isn't replaced", 'if (err?.code === "not_found" && !this._config.entry_id', 'if (false && err?.code === "not_found" && !this._config.entry_id', ["moves the card on"]],
  ["markup not escaped", "const stEsc = (s) => String(s ?? \"\").replace(", "const stEsc = (s) => String(s ?? \"\"); void (", ["markup are shown as text"]],
  ["− not switched off at zero", '${level === 0 ? "disabled" : ""}', "", ["switched off at zero"]],
  ["running low not shown", "const under = s.running_low ?", "const under = false ?", ["running low"]],
  ["untracked days drawn as zero", 'r.tracked ? "zero" : "untracked"', '"zero"', ["untracked"]],
  ["no restock sticker", "(r.added ? `<i class=\"tag k-add\">+${stNum(r.added)}</i>` : \"\")", '""', ["+N on restock days"]],
  ["weeks start on Sunday", "const monday = stShift(today, -((stParse(today).getDay() + 6) % 7));", "const monday = stShift(today, -stParse(today).getDay());", ["Monday first"]],
  ["delete without asking", "if (this._armed !== id) {", "if (false) {", ["delete asks first"]],
  ["rates shown before a week of tracking", "if (s.per_week == null) {", "if (s.per_week === undefined) {", ["under a week"]],
  ["the day flashes the shelves while the next one loads", "if (ready || (this._selected && this._dayShown)) {", "if (ready) {", ["without a flash"]],
  ["Escape in a box closes the popup", "      ev.preventDefault();\n      ev.stopPropagation();\n      if (f === \"exact\")", "      if (f === \"exact\")", ["Escape in a box"]],
];

function run(name, mutated, port) {
  return new Promise((resolve) => {
    const file = path.join(dir, `${port}.js`);
    fs.writeFileSync(file, mutated);
    const child = spawn(process.execPath, [path.join(__dirname, "drive.cjs")], { env: { ...process.env, CARD: file, SHOTS: "0", PORT: String(port) } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", () => resolve(out));
  });
}

async function main() {
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  const queue = MUTANTS.filter(([name]) => !only || only.some((o) => name.includes(o)));
  const jobs = Number(process.env.JOBS || 3);
  let survived = 0;
  let next = 0;
  const worker = async (slot) => {
    while (next < queue.length) {
      const [name, find, replace, expect] = queue[next++];
      const pairs = Array.isArray(find) ? find : [[find, replace]];
      const missing = pairs.filter(([f]) => !source.includes(f));
      if (missing.length) { survived += 1; console.log(`NOT APPLIED  ${name}: the text to break wasn't found`); continue; }
      const out = await run(name, pairs.reduce((code, [f, r]) => code.replace(f, r), source), 8810 + slot);
      const failed = out.split("\n").filter((l) => l.startsWith("FAIL")).map((l) => l.slice(6).split("  — ")[0]);
      // A driver that stops part way (the broken card left it nothing to click) has caught the mutant too.
      const stopped = out.includes("driver failed");
      if (stopped) failed.push(`driver stopped: ${out.split("driver failed: ")[1].split("\n")[0]}`);
      const caught = stopped || expect.every((e) => failed.some((f) => f.includes(e)));
      if (!caught) survived += 1;
      console.log(`${caught ? "CAUGHT  " : "MISSED  "}${name}\n          failing: ${failed.join("; ") || (out.includes("driver failed") ? out.trim().split("\n").pop() : "nothing")}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, (_, i) => worker(i)));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${queue.length - survived}/${queue.length} mutations caught`);
  process.exit(survived ? 1 : 0);
}

main();
