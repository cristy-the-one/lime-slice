/**
 * recipe_run through the session against real Open CASCADE and real lust: the build, each call as its MCP tool, the
 * transaction (a failed or dry run takes back what it made), and the one undo step on a part passed in.
 * Skips without LIME_OCCT_BRIDGE, the MCP addon, or lust; in CI LIME_RECIPE_REQUIRED=1 makes a missing one a failure.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { findLust } from "./recipe.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const lust = findLust();
if (!bridge || !existsSync(bridge) || !addon || !lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("recipe-session: LIME_OCCT_BRIDGE, the MCP addon, and lust (LIME_LUST) are required here");
    process.exit(1);
  }
  console.log("recipe-session: skipped (needs LIME_OCCT_BRIDGE, lime-mcp-engine, and LIME_LUST)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-recipe-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const session = new Session(loadEngineWorker(root));
const call = (name: string, args: unknown = {}) => session.call(name, args);
const objects = async () => ((await call("plate_list", {})).objects as { object: string }[] | undefined ?? []).map((row) => row.object);
const example = readFileSync(join(root, "crates", "lime-recipe", "examples", "mounting_bar.rs"), "utf8");

// --- check: builds only, and an auto fix comes back as fixedSource.
{
  const broken = example.replace('let width = s.param_f64("width", 60.0);', "let width: f64 = 60;");
  const r = await call("recipe_run", { source: broken, name: "bar", mode: "check" });
  check("check builds after the auto fix", r.ok === true && r.built === true, r);
  check("check returns the fixed source", typeof r.fixedSource === "string" && (r.fixedSource as string).includes("let width: f64 = 60.0;"), r.fixedSource);
  check("check makes nothing", (await objects()).length === 0);
}

// --- A build error: diagnostics with lines, nothing run.
{
  const r = await call("recipe_run", { source: 'fn main() { let _ = std::fs::read("/etc/passwd"); }\n', name: "fs" });
  check("the sandbox refusal is a diagnostic", r.ok === false && (r.diagnostics as { code: string; line: number }[]).some((d) => d.code === "L0532" && d.line === 1), r);
}

// --- apply: the bar with its holes; every hole is a real cut, and the part is on the plate.
let bar = "";
{
  const r = await call("recipe_run", { source: example, name: "bar", params: { width: 60, holes: 4 }, profile: true });
  check("the bar applies", r.ok === true && typeof r.object === "string", r);
  const profile = r.profile as { callsMs?: number; outsideCallsMs?: number; lines?: { line: number; tool: string; calls: number }[] } | undefined;
  check("the profile names timed recipe calls and time outside them", typeof profile?.callsMs === "number" && typeof profile.outsideCallsMs === "number" && !!profile.lines?.some((row) => row.tool === "model_apply" && row.line > 0 && row.calls >= 1), profile);
  bar = String(r.object);
  check("four holes drilled", (r.metrics as { holes?: number } | undefined)?.holes === 4, r.metrics);
  check("the bar is listed as created", Array.isArray(r.created) && (r.created as string[]).includes(bar), r.created);
  const described = await call("model_describe", { object: bar });
  const solid = 60 * 20 * 4;
  const holes = 4 * Math.PI * 1.6 ** 2 * 4;
  const volume = Number(described.volumeMm3);
  // The fillet takes a little off the top edges, or is skipped with a note: either way below the drilled bar.
  check("the volume is the drilled bar's, or a little less", volume <= solid - holes + 0.5 && volume > solid - holes - 60, { volume, expected: solid - holes });
  check("the bar is on the plate", (await objects()).includes(bar));
}

// --- dry: runs, reports, and leaves nothing behind.
{
  const before = await objects();
  const r = await call("recipe_run", { source: example, name: "bar", params: { width: 40, holes: 2 }, mode: "dry" });
  check("dry reports metrics", r.ok === true && r.dry === true && (r.metrics as { holes?: number }).holes === 2, r);
  check("dry leaves the plate as it was", JSON.stringify(await objects()) === JSON.stringify(before), { before, after: await objects() });
}

// --- A recipe that unwraps a refusal: the run fails at its line and its new object is taken back.
{
  const before = await objects();
  const src = [
    "use lime_recipe::{ops, Session};",
    "fn main() {",
    "    let mut s = Session::start();",
    "    let p = s.solid_new(ops::cuboid(10.0, 10.0, 10.0)).unwrap();",
    "    s.apply(&p, ops::hole_through([500.0, 500.0, 10.0], [0.0, 0.0, -1.0], 3.0)).unwrap();",
    "    s.done(&p);",
    "}",
  ].join("\n");
  const r = await call("recipe_run", { source: src, name: "miss" });
  check("an unwrapped refusal fails at line 5", r.ok === false && r.line === 5, r);
  check("the failed run's object is removed", JSON.stringify(await objects()) === JSON.stringify(before) && ((r.rolledBack as { removed: string[] }).removed.length === 1), { r: r.rolledBack, after: await objects() });
}

// --- A part passed in: the recipe's steps are one undo step.
{
  const src = [
    "use lime_recipe::{ops, Session};",
    "fn main() {",
    "    let mut s = Session::start();",
    "    let p = s.object().unwrap();",
    "    for i in 0..3 {",
    "        let x = -15.0 + 15.0 * i as f64;",
    "        s.apply(&p, ops::hole_through([x, 6.0, 4.0], [0.0, 0.0, -1.0], 2.0)).unwrap();",
    "    }",
    "    s.done(&p);",
    "}",
  ].join("\n");
  const v0 = Number((await call("model_describe", { object: bar })).volumeMm3);
  const r = await call("recipe_run", { source: src, name: "more", object: bar });
  check("three more holes in the bar", r.ok === true && r.calls === 3, r);
  const v1 = Number((await call("model_describe", { object: bar })).volumeMm3);
  check("the bar lost three holes of material", Math.abs(v0 - v1 - 3 * Math.PI * 1 ** 2 * 4) < 0.5, { v0, v1 });
  const undo = await call("model_undo", { object: bar });
  check("one undo takes the whole recipe back", undo.ok === true && undo.group === "recipe more", undo);
  const v2 = Number((await call("model_describe", { object: bar })).volumeMm3);
  check("the volume is back", Math.abs(v2 - v0) < 0.01, { v0, v2 });
}

// --- A failed run on a part passed in leaves it at its step.
{
  const v0 = Number((await call("model_describe", { object: bar })).volumeMm3);
  const src = [
    "use lime_recipe::{ops, Session};",
    "fn main() {",
    "    let mut s = Session::start();",
    "    let p = s.object().unwrap();",
    "    s.apply(&p, ops::hole_through([0.0, 6.0, 4.0], [0.0, 0.0, -1.0], 2.0)).unwrap();",
    '    panic!("changed my mind");',
    "}",
  ].join("\n");
  const r = await call("recipe_run", { source: src, name: "regret", object: bar });
  check("a panic fails the run at its line", r.ok === false && r.line === 6 && /changed my mind/.test(String(r.reason)), r);
  const v1 = Number((await call("model_describe", { object: bar })).volumeMm3);
  check("the part is back at its step", Math.abs(v1 - v0) < 0.01 && (r.rolledBack as { restored: string[] }).restored.includes(bar), { v0, v1, rolledBack: r.rolledBack });
}

// --- I8. A selector says which face it picked. nearPoint over a pocket falls to the pocket floor; the refusal says so
// and names the top, level with the point, so the recipe can aim at material.
{
  const src = [
    "use lime_recipe::{ops, Json, Session};",
    "fn main() {",
    "    let mut s = Session::start();",
    "    let p = s.solid_new(ops::cuboid(40.0, 40.0, 10.0)).unwrap();",
    "    s.apply(&p, ops::boolean(\"cut\", ops::cuboid(10.0, 10.0, 5.0), [-5.0, -5.0, 7.0])).unwrap();",
    "    let top = Json::obj().set(\"normal\", [0.0, 0.0, 1.0]).set(\"nearPoint\", [0.0, 0.0, 10.0]);",
    "    let edges = Json::obj().set(\"select\", Json::obj().set(\"onFace\", top).set(\"convex\", true));",
    "    if let Err(e) = s.apply(&p, ops::fillet(edges, 0.5)) {",
    "        s.log(&e.reason);",
    "    }",
    "    s.done(&p);",
    "}",
  ].join("\n");
  const r = await call("recipe_run", { source: src, name: "pocket" });
  const said = (r.notes as string[] | undefined)?.[0] ?? "";
  check("the pocket recipe applies", r.ok === true, r);
  check("the refusal names the floor it fell to and the point over empty space", said.includes("No edge matches that filter.") && /picked face \d+ \(normal \[0, 0, 1\], centre \[0, 0, 7\]/.test(said) && said.includes("3 mm from nearPoint [0, 0, 10]") && said.includes("over empty space"), said);
  check("and names the top, level with the point, 5 mm away", /level with the point is face \d+ \(centre \[[^\]]+\], 1500 mm², 5 mm away\)/.test(said), said);
  const part = String(r.object);
  const found = await call("faces_find", { object: part, normal: [0, 0, 1], nearPoint: [0, 0, 10] });
  check("faces_find says the point is on no face, and which face is level with it", found.ok === true && String(found.note).startsWith("The nearest face is face") && String(found.note).includes("over empty space"), found);
  const rim = await call("model_apply", { object: part, op: { kind: "fillet", size: 0.5, edges: { select: { onFace: { normal: [0, 0, 1], nearPoint: [12, 0, 10] }, convex: true } } }, probe: true });
  const picked = rim.picked as { index: number; areaMm2: number; distanceMm: number; centre: number[] }[] | undefined;
  check("a fillet aimed at the top applies and says the face it picked", rim.ok === true && picked?.length === 1 && picked[0]!.areaMm2 === 1500 && picked[0]!.distanceMm === 0 && picked[0]!.centre[2] === 10, rim);
}

// --- Plugins (milestones 1–2): keep the bar as a plugin, then run it by id: the same solid, fingerprint for fingerprint.
{
  process.env.LIME_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "lime-plugins-real-"));
  const typed = example.replace('let width = s.param_f64("width", 60.0);', 'let width = s.number("width", 60.0).range(50.0, 120.0).unit("mm").get();');
  const kept = await call("recipe_run", { source: typed, name: "bar_typed", keep: { title: "Mounting bar", description: "A bar with a row of holes." } });
  check("the bar is kept as a plugin", kept.ok === true && (kept.kept as { id?: string } | undefined)?.id === "mounting-bar", kept);
  const listed = await call("plugin", { action: "list", query: "bar" });
  check("plugin list shows its typed width", JSON.stringify(listed.plugins).includes("width mm 60 [50-120]"), listed);
  const byId = await call("recipe_run", { plugin: "mounting-bar" });
  const a = await call("model_describe", { object: String(kept.object) });
  const b = await call("model_describe", { object: String(byId.object) });
  check("run by id, it builds the same solid", byId.ok === true && !!a.fingerprint && JSON.stringify(a.fingerprint) === JSON.stringify(b.fingerprint), { a: a.fingerprint, b: b.fingerprint, byId });
}

if (failed > 0) {
  console.error(`recipe-session: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-session: all passed");
process.exit(0);
