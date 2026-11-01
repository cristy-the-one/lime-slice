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
  const r = await call("recipe_run", { source: example, name: "bar", params: { width: 60, holes: 4 } });
  check("the bar applies", r.ok === true && typeof r.object === "string", r);
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

if (failed > 0) {
  console.error(`recipe-session: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-session: all passed");
process.exit(0);
