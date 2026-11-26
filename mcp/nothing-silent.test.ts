/**
 * E1 "nothing silent" (docs/plan-agent-ergonomics.md §4): one check per item.
 * Items 1–5 and 8 need lust. Items 6 and 7 run on the stand-in engine either way.
 * Skips the lust items without lust; LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { findLust, lustFeatures } from "./recipe.ts";
import { bodyHash, readPlugin, writePlugin, type PluginHeader, type PluginParam } from "./plugins.ts";
import { writePreset } from "./nuggets.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-nothing-ws-"));
process.env.LIME_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "lime-nothing-lib-"));
process.env.LIME_PLUGIN_AUTHOR = "Test";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 3000)}`);
}

type R = Record<string, unknown>;
const callOf = (session: Session) => (name: string, args: unknown = {}) => session.call(name, args) as Promise<R>;
function objectsOf(session: Session): string[] {
  return (session as unknown as { objects: { id: string }[] }).objects.map((obj) => obj.id);
}
function lineOf(source: string, needle: string): number {
  return source.split("\n").findIndex((line) => line.includes(needle)) + 1;
}

const USE = "use lime_recipe::{ops, Json, Session};\n\n";

// --- Item 6. Point replies name the frame the points are in. An assembly member is frame "part".
{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const body = await call("solid_new", { primitive: "box", dx: 30, dy: 20, dz: 16 });
  const lid = await call("solid_new", { primitive: "box", dx: 12, dy: 10, dz: 8 });
  const placed = await call("model_place", { object: lid.object, to: body.object });
  const measured = await call("measure", { object: lid.object, faceA: 0, faceB: 1 });
  const cut = await call("section", { object: lid.object, planes: [{ origin: [0, 0, 4], normal: [0, 0, 1] }] });
  const ray = await call("surface_at", { object: lid.object, point: [0, 0, 40], direction: [0, 0, -1] });
  const described = await call("model_describe", { object: lid.object, limit: 1 });
  const guide = await call("guide", { topic: "recipes", full: true });
  const text = String(guide.text ?? "");
  const named = placed.ok === true
    && measured.ok === true && measured.frame === "part"
    && cut.ok === true && cut.frame === "part"
    && ray.ok === true && ray.frame === "part"
    && described.frame === "part";
  // The guide rule is the docs half of this item: assembly members answer in the part frame, as the code does.
  const rule = /assembly member/.test(text) && /answers in the part frame/.test(text) && !text.includes("model space for a part model_place moved or turned");
  check("item 6: point tools name the part frame, and the guide says an assembly member does", named && rule, { placed, measured, cut: { ok: cut.ok, frame: cut.frame, reason: cut.reason }, ray: { ok: ray.ok, frame: ray.frame }, described: described.frame, rule });
}

// --- Item 7. model_edit keeps the label it is given.
{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const made = await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const hole = { kind: "hole", origin: [0, 0, 20], axis: [0, 0, -1], diameterMm: 4, depth: 8, label: "pin bore" };
  const applied = await call("model_apply", { object: made.object, probe: true, op: hole });
  const edited = await call("model_edit", { object: made.object, node: applied.node, probe: true, op: { ...hole, diameterMm: 6, label: "pin bore" } });
  const history = await call("model_history", { object: made.object });
  const labels = ((history.nodes ?? []) as { label?: string; current?: boolean }[]);
  const current = labels.find((row) => row.current);
  check("item 7: model_edit keeps the label it is given", edited.ok === true && current?.label === "pin bore", { edited, current, labels });
}

const lust = findLust();
if (!lust || !lustFeatures(lust).markUnread) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("nothing-silent: lust 0.3.0+ with --mark-unread is required (LIME_LUST)");
    process.exit(1);
  }
  console.log("nothing-silent: lust items skipped (set LIME_LUST to lust 0.3.0+)");
  if (failed) process.exit(1);
  process.exit(0);
}

const MISSED = `${USE}fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(60.0, 20.0, 10.0)).unwrap();
    s.apply_later(&p, Json::obj().set("kind", "hole").set("origin", [0.0, 0.0, 10.0]).set("axis", [0.0, 0.0, -1.0]).set("diameterMm", 20.0).set("depth", 4.0)).unwrap();
    s.done(&p);
}
`;

// --- Item 1. Strict is the default (7.4.0). No header rolls an unread refused step back.
// `//! strict: true` still rolls it back. `//! strict: false` warns, keeps the parts, and notes the opt-out once.
const OPT_OUT = "//! strict: false is accepted through 7.4 and removed in 7.5.0: read or handle each queued step's result instead.";
const REFUSED = "A queued step was refused and the recipe never read it";
function notesOf(reply: R): string[] {
  return ((reply.notes ?? []) as string[]);
}
function droppedOf(reply: R): { line?: number; tool?: string; reason?: string }[] {
  return ((reply.warnings ?? []) as { line?: number; tool?: string; reason?: string }[]).filter((row) => typeof row.line === "number" && typeof row.tool === "string" && typeof row.reason === "string" && row.reason.length > 0);
}
{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const reply = await call("recipe_run", { source: MISSED, name: "missed", timeoutS: 120 });
  const buried = notesOf(reply).some((note) => note.includes("apply_later was refused"));
  const at = lineOf(MISSED, "apply_later");
  const rolledBack = reply.ok === false && !buried && objectsOf(session).length === 0 && String(reply.reason ?? "").includes(`${REFUSED}: line ${at} model_apply`);
  check("item 1: an unread refused step with no header rolls the run back", rolledBack, { reply: { ok: reply.ok, reason: reply.reason, warnings: reply.warnings, notes: reply.notes }, left: objectsOf(session) });
  const strict = new Session(fakeEngine());
  const strictCall = callOf(strict);
  const rolled = await strictCall("recipe_run", { source: `//! strict: true\n${MISSED}`, name: "missed-strict", timeoutS: 120 });
  const back = rolled.ok === false && objectsOf(strict).length === 0;
  check("item 1: //! strict: true rolls the run back", back, { rolled: { ok: rolled.ok, reason: rolled.reason, code: rolled.code }, left: objectsOf(strict) });
  const loose = new Session(fakeEngine());
  const looseCall = callOf(loose);
  const opted = `  //! strict: false  \n${MISSED}`;
  const warned = await looseCall("recipe_run", { source: opted, name: "missed-loose", timeoutS: 120 });
  const looseAt = lineOf(opted, "apply_later");
  const looseNotes = notesOf(warned);
  const kept = warned.ok === true && objectsOf(loose).length > 0 && !looseNotes.some((note) => note.includes("apply_later was refused"))
    && droppedOf(warned).some((row) => row.line === looseAt && row.tool === "model_apply")
    && looseNotes.filter((note) => note === OPT_OUT).length === 1;
  check("item 1: //! strict: false warns, keeps the parts, and notes the opt-out once", kept, { warned: { ok: warned.ok, warnings: warned.warnings, notes: warned.notes, reason: warned.reason }, left: objectsOf(loose) });
  const again = kept ? await looseCall("recipe_run", { object: warned.object, timeoutS: 120 }) : { ok: false };
  const againNotes = notesOf(again);
  check("item 1: a rerun follows the stored source header", again.ok === true && objectsOf(loose).length > 0 && droppedOf(again).some((row) => row.tool === "model_apply") && againNotes.filter((note) => note === OPT_OUT).length === 1, { again: { ok: again.ok, warnings: again.warnings, notes: again.notes, reason: again.reason }, left: objectsOf(loose) });
}

const SIZED = (header: string) => `${header}use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let d = s.number("diameter", 20.0).range(1.0, 40.0).get();
    let p = s.solid_new(ops::cuboid(60.0, 20.0, 10.0)).unwrap();
    s.apply_later(&p, Json::obj().set("kind", "hole").set("origin", [0.0, 0.0, 10.0]).set("axis", [0.0, 0.0, -1.0]).set("diameterMm", d).set("depth", 4.0)).unwrap();
    s.done(&p);
}
`;

{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const bare = await call("recipe_run", { source: SIZED(""), name: "sized", params: { diameter: 4 }, timeoutS: 120, keep: { title: "Sized hole", description: "A hole." } });
  const refused = bare.ok === true && String(bare.keepRefused ?? "").startsWith("This plugin does not build with its own defaults") && String(bare.keepRefused ?? "").includes(REFUSED) && !readPlugin("sized-hole", process.env.LIME_PLUGINS_DIR);
  check("item 1: a kept plugin with no header fails its defaults check under strict", refused, { bare: { ok: bare.ok, keepRefused: bare.keepRefused, kept: bare.kept, reason: bare.reason, notes: bare.notes } });
  const loose = await call("recipe_run", { source: SIZED("//! strict: false\n"), name: "sized-loose", params: { diameter: 4 }, timeoutS: 120, keep: { title: "Loose hole", description: "A hole." } });
  const file = readPlugin("loose-hole", process.env.LIME_PLUGINS_DIR);
  const body = file && !("reason" in file) ? file.body : "";
  const keptLoose = loose.ok === true && (loose.kept as { id?: string } | undefined)?.id === "loose-hole" && notesOf(loose).filter((note) => note === OPT_OUT).length === 1 && body.includes("//! strict: false") && !body.includes("//! strict: true");
  check("item 1: a plugin kept with //! strict: false is kept, with the note", keptLoose, { loose: { ok: loose.ok, kept: loose.kept, keepRefused: loose.keepRefused, notes: loose.notes, reason: loose.reason }, body: body.slice(0, 240) });
}

function plant(id: string, body: string, params: PluginParam[] = []): void {
  const header: PluginHeader = { plugin: id, title: id, version: 1, description: "A queued drop.", author: "Test", api: "1.16", "source-sha256": bodyHash(body), created: "2026-11-26", target: "new", params };
  writePlugin(header, body, process.env.LIME_PLUGINS_DIR);
}

{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  plant("bare-drop", MISSED);
  plant("loose-drop", `//! strict: false\n${MISSED}`);
  const outer = `${USE}fn main() {
    let mut s = Session::start();
    let loose = match s.run_plugin("loose-drop", Json::obj()) { Ok(run) => run.part, Err(e) => { s.log(&e.reason); s.solid_new(ops::cuboid(1.0, 1.0, 1.0)).unwrap() } };
    let said = match s.run_plugin("bare-drop", Json::obj()) { Ok(_) => "ran".to_string(), Err(e) => e.reason };
    s.log(&said);
    s.done(&loose);
}
`;
  const ran = await call("recipe_run", { source: outer, name: "nested-own", timeoutS: 120 });
  const notes = notesOf(ran);
  const follows = ran.ok === true && notes.some((note) => note === `loose-drop: ${OPT_OUT}`) && notes.some((note) => note.includes(`bare-drop: ${REFUSED}`)) && !notes.some((note) => note === OPT_OUT) && objectsOf(session).length === 1;
  check("item 1: a nested run follows its own header", follows, { ran: { ok: ran.ok, notes, warnings: ran.warnings, reason: ran.reason, created: ran.created }, left: objectsOf(session) });
  const optedOuter = `//! strict: false\n${USE}fn main() {
    let mut s = Session::start();
    let said = match s.run_plugin("bare-drop", Json::obj()) { Ok(_) => "ran".to_string(), Err(e) => e.reason };
    s.log(&said);
    let p = s.solid_new(ops::cuboid(2.0, 2.0, 2.0)).unwrap();
    s.done(&p);
}
`;
  const over = await call("recipe_run", { source: optedOuter, name: "nested-over", timeoutS: 120 });
  const overNotes = notesOf(over);
  check("item 1: an opted-out run does not opt out a nested run", over.ok === true && overNotes.filter((note) => note === OPT_OUT).length === 1 && overNotes.some((note) => note.includes(`bare-drop: ${REFUSED}`)), { over: { ok: over.ok, notes: overNotes, reason: over.reason } });
  const pluginRun = await call("recipe_run", { plugin: "loose-drop", timeoutS: 120 });
  check("item 1: a kept plugin run follows its stored source header", pluginRun.ok === true && droppedOf(pluginRun).some((row) => row.tool === "model_apply") && notesOf(pluginRun).filter((note) => note === OPT_OUT).length === 1, { pluginRun: { ok: pluginRun.ok, warnings: pluginRun.warnings, notes: pluginRun.notes, reason: pluginRun.reason } });
  const bareRun = await call("recipe_run", { plugin: "bare-drop", timeoutS: 120 });
  check("item 1: a kept plugin with no header rolls back", bareRun.ok === false && String(bareRun.reason ?? "").includes(REFUSED), { bareRun: { ok: bareRun.ok, reason: bareRun.reason, notes: bareRun.notes } });
  writePreset({ plugin: "loose-drop", name: "plain", params: {}, created: "2026-11-26" });
  writePreset({ plugin: "bare-drop", name: "plain", params: {}, created: "2026-11-26" });
  const preset = await call("recipe_run", { plugin: "loose-drop", preset: "plain", timeoutS: 120 });
  const presetBare = await call("recipe_run", { plugin: "bare-drop", preset: "plain", timeoutS: 120 });
  check("item 1: a preset run follows the plugin source header", preset.ok === true && notesOf(preset).filter((note) => note === OPT_OUT).length === 1 && presetBare.ok === false && String(presetBare.reason ?? "").includes(REFUSED), { preset: { ok: preset.ok, notes: preset.notes, reason: preset.reason }, presetBare: { ok: presetBare.ok, reason: presetBare.reason } });
  const made = String(pluginRun.object ?? "");
  const rebuilt = made ? await call("recipe_run", { object: made, timeoutS: 120 }) : { ok: false };
  check("item 1: a rebuild follows the stamped plugin source header", rebuilt.ok === true && notesOf(rebuilt).filter((note) => note === OPT_OUT).length === 1 && droppedOf(rebuilt).some((row) => row.tool === "model_apply"), { rebuilt: { ok: rebuilt.ok, notes: rebuilt.notes, warnings: rebuilt.warnings, reason: rebuilt.reason } });
}

{
  const session = new Session(fakeEngine());
  const guide = await callOf(session)("guide", { topic: "recipes", full: true });
  const text = String(guide.text ?? "");
  check("item 1: the recipes guide says strict is the default from 7.4.0", text.includes("Strict is the default from 7.4.0") && text.includes("a refused queued step the recipe never reads fails the run") && text.includes("`//! strict: false` is the opt-out for one release"), text.slice(0, 200));
}

const TWO = `${USE}fn main() {
    let mut s = Session::start();
    let w = s.number("width", 20.0).get();
    let a = s.solid_new(ops::cuboid(w, 10.0, 8.0)).unwrap();
    let b = s.solid_new(ops::cuboid(w, 12.0, 6.0)).unwrap();
    s.done(&a);
}
`;

// --- Item 2. A multi-part rerun that would drop a hand edit: dry lists it, apply refuses, replaceHandEdits allows it.
{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const made = await call("recipe_run", { source: TWO, name: "pair", params: { width: 20 }, timeoutS: 120 });
  const created = (made.created ?? []) as string[];
  const object = String(made.object ?? "");
  const other = created.find((id) => id !== object) ?? "";
  const hole = await call("model_apply", { object: other, probe: true, op: { kind: "hole", origin: [0, 0, 6], axis: [0, 0, -1], diameterMm: 3, depth: 4, label: "hand hole" } });
  const history = await call("model_history", { object: other });
  const node = ((history.nodes ?? []) as { id?: string; label?: string }[]).find((row) => row.label === "hand hole");
  const edited = node ? await call("model_edit", { object: other, node: node.id, probe: true, op: { kind: "hole", origin: [1, 0, 6], axis: [0, 0, -1], diameterMm: 3, depth: 4, label: "hand hole" } }) : { ok: false };
  const dry = await call("recipe_run", { object, mode: "dry", timeoutS: 120 });
  const listed = (dry.handEdits ?? []) as { object?: string; kind?: string; label?: string }[];
  const lists = dry.ok === true && dry.dry === true && listed.some((row) => row.object === other && row.kind === "step") && listed.some((row) => row.object === other && row.kind === "branch");
  const refused = await call("recipe_run", { object, timeoutS: 120 });
  const refuses = refused.ok === false && String(refused.reason ?? "").includes("replaceHandEdits");
  const replaced = refuses ? await call("recipe_run", { object, replaceHandEdits: true, timeoutS: 120 }) : { ok: false };
  const after = await call("model_history", { object: other });
  const labels = ((after.nodes ?? []) as { label?: string }[]).map((row) => row.label);
  const gone = replaced.ok === true && !labels.includes("hand hole");
  check("item 2: a multi-part rerun lists hand edits when dry and refuses unless replaceHandEdits", made.ok === true && hole.ok === true && edited.ok === true && lists && refuses && gone, { made: { ok: made.ok, object, created, reason: made.reason }, hole, edited, dry: { ok: dry.ok, handEdits: dry.handEdits, warnings: dry.warnings, reason: dry.reason }, refused: { ok: refused.ok, reason: refused.reason }, replaced: { ok: replaced.ok, reason: replaced.reason }, labels });
}

function cup(width: number): string {
  return `${USE}fn main() {
    let mut s = Session::start();
    let w = s.number("width", ${width}.0).get();
    let p = s.solid_new(ops::cuboid(w, 8.0, 4.0)).unwrap();
    s.done(&p);
}
`;
}

// --- Item 3. nugget save {from} keeps the dry run's newer code, never the old code silently.
{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const applied = await call("recipe_run", { source: cup(10), name: "cup", timeoutS: 120 });
  const first = await call("nugget", { action: "save", kind: "plugin", from: "cup", title: "Cup", description: "A cup." });
  const dry = await call("recipe_run", { source: cup(30), name: "cup", mode: "dry", timeoutS: 120 });
  const again = await call("nugget", { action: "save", kind: "plugin", from: "cup", title: "Cup", description: "A cup." });
  const got = await call("nugget", { action: "get", kind: "plugin", id: "cup", withSource: true });
  const source = String(got.source ?? "");
  const kept = again.ok === true && again.version === 2 && source.includes("30.0") && !source.includes("10.0");
  check("item 3: nugget save {from} keeps the dry run's code", applied.ok === true && first.ok === true && dry.ok === true && kept, { applied: applied.ok, first, dry: { ok: dry.ok, reason: dry.reason }, again, source: source.slice(0, 400) });
}

const BODY = (span: number) => `${USE}fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(${span}.0, 10.0, 8.0)).unwrap();
    s.done(&p);
}
`;

// --- Item 4. keep of a name that differs only by punctuation from a kept id.
{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const first = await call("recipe_run", { source: BODY(20), name: "tour", timeoutS: 120, keep: { title: "T-26 Touring Body", description: "A body." } });
  const second = await call("recipe_run", { source: BODY(22), name: "tour2", timeoutS: 120, keep: { title: "T26 Touring Body", description: "A body." } });
  const clash = readPlugin("t26-touring-body-2", process.env.LIME_PLUGINS_DIR);
  const meant = String(second.keepRefused ?? second.reason ?? "");
  const twin = readPlugin("t26-touring-body", process.env.LIME_PLUGINS_DIR);
  check("item 4: keep refuses a punctuation-only twin with did you mean", first.ok === true && first.kept !== undefined && meant.includes("did you mean t-26-touring-body?") && !clash && !twin, { first: { ok: first.ok, kept: first.kept, reason: first.reason }, second: { ok: second.ok, keepRefused: second.keepRefused, reason: second.reason, kept: second.kept }, clash: !!clash, twin: !!twin });
}

// --- Item 5. A rerun with object and no params names the reused params and their run.
{
  const session = new Session(fakeEngine());
  const call = callOf(session);
  const made = await call("recipe_run", { source: cup(10), name: "flange", params: { width: 12 }, timeoutS: 120 });
  const again = await call("recipe_run", { object: made.object, timeoutS: 120 });
  const text = JSON.stringify(again.warnings ?? "");
  const named = again.ok === true && text.includes("width") && text.includes("flange");
  const given = await call("recipe_run", { object: made.object, params: { width: 8 }, timeoutS: 120 });
  const quiet = !JSON.stringify(given.warnings ?? "").includes("Reused");
  check("item 5: a rerun with no params warns which params it reused", made.ok === true && named && given.ok === true && quiet, { made: { ok: made.ok, reason: made.reason }, again: { ok: again.ok, warnings: again.warnings, reason: again.reason }, given: { ok: given.ok, warnings: given.warnings, reason: given.reason } });
}

// --- Item 8. A refusal inside a queued run is reported at that tool's line, not an earlier one's.
{
  const engine = fakeEngine();
  const inner = engine.modelTree.bind(engine);
  engine.modelTree = (body: string) => {
    const req = JSON.parse(body) as { call?: string; op?: { kind?: string; source?: { kind?: string } } };
    const op = req.op;
    if (req.call === "apply" && op?.kind === "group" && op.source?.kind === "queue") return JSON.stringify({ error: "The cut does not change the part." });
    const text = JSON.stringify(op ?? {});
    if (op?.kind === "boolean" && text.includes("[12,") && (req.call === "probe" || req.call === "apply")) return JSON.stringify({ ok: false, error: "The cut does not change the part." });
    return inner(body);
  };
  const source = `${USE}fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(60.0, 20.0, 10.0)).unwrap();
    let _ = s.apply(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [-12.0, 0.0, -5.0]));
    let _ = s.apply(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [12.0, 0.0, -5.0]));
    s.done(&p);
}
`;
  const session = new Session(engine);
  const reply = await callOf(session)("recipe_run", { source, name: "queued-fuse", timeoutS: 120 });
  const at = lineOf(source, "[12.0");
  const replayed = (reply.replayed as { line?: number } | undefined)?.line;
  check("item 8: a queued refusal is reported at the refused tool's line", reply.ok === true && replayed === at, { at, replayed, ok: reply.ok, reason: reply.reason, notes: reply.notes, refused: reply.refused });
}

if (failed) {
  console.error(`nothing-silent: ${failed} failed`);
  process.exit(1);
}
console.log("nothing-silent: all checks passed");
