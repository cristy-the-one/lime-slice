/**
 * One frame for reads and cuts (recipe API 1.4), against real Open CASCADE: a sphere left where it was made, moved by
 * model_place x + 200, and turned 90° about X. On each, through the MCP session and through the app's answers to a
 * recipe (src/recipe/app-calls.ts, the Plugins panel's run): model_describe's bounds, faces_find's sphere centre,
 * surface_at's hit and a picked face's centre all land where model_apply cuts, so a recipe that measures the part and
 * cuts a crater at its top hits it. A part placed in its own frame (frame: "part") reads and cuts in that frame. The
 * probe's refusal of a cut that misses names the frame and the pose without "sits at (", which the moon-crater-field v2
 * workaround parsed for an offset to add. Skips without LIME_OCCT_BRIDGE, the MCP addon or lust; CI fails instead.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker, type Engine } from "./engine.ts";
import { findLust, RecipeHost, recipeCrateDir } from "./recipe.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const lust = findLust();
if (!bridge || !existsSync(bridge) || !addon || !lust) {
  if (ci || process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("recipe-frame: LIME_OCCT_BRIDGE, the MCP addon and lust are required");
    process.exit(1);
  }
  console.log("recipe-frame: skipped (set LIME_OCCT_BRIDGE and LIME_LUST, and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-recipe-frame-"));
process.env.LIME_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "lime-mcp-recipe-frame-lib-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "60";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

const { Session } = await import("./session.ts");
const { applyPose, typedPoseOf } = await import("../src/model-space.ts");
const { runPluginFresh } = await import("../src/recipe/apply.ts");
const { AppRecipeCalls } = await import("../src/recipe/app-calls.ts");
const { solidView } = await import("../src/modeling/model-calls.ts");
const { gotoRequest } = await import("../src/model-request.ts");
type Affine = import("../src/model-space.ts").Affine;
type AppEngine = import("../src/recipe/app-calls.ts").AppEngine;
type Row = Record<string, unknown>;
type V3 = [number, number, number];

const host = new RecipeHost({ crateDir: recipeCrateDir(new URL("./recipe.ts", import.meta.url).href), root: mkdtempSync(join(tmpdir(), "lime-recipe-frame-host-")), lust });
const engine: Engine = loadEngineWorker(root);
const appEngine: AppEngine = {
  tree: async (_key, _node, request) => JSON.parse(await engine.modelTree(JSON.stringify(request))) as Row,
  open: async (request) => JSON.parse(await engine.modelTree(JSON.stringify(request))) as Row,
};
const near = (a: readonly number[] | undefined, b: readonly number[], tol = 0.05) => !!a && a.length >= 3 && b.every((v, i) => Math.abs(a[i]! - v) <= tol);
const vec = (value: unknown): V3 | undefined => (Array.isArray(value) && value.length >= 3 ? [Number(value[0]), Number(value[1]), Number(value[2])] : undefined);

const R = 20;
/** The recipe: pick the sphere face, measure the part, cut a crater at the middle of its top, and say what it read. */
const crater = [
  "use lime_recipe::{ops, Json, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let f = s.face("ball").curved().label("Ball").get();',
  "    let p = s.object().unwrap();",
  "    let pf = s.pick_face(&p, &f).unwrap();",
  "    let c = pf.centre.unwrap_or([f64::NAN; 3]);",
  "    let (mn, mx) = s.bounds(&p).unwrap();",
  "    let top = [(mn[0] + mx[0]) / 2.0, (mn[1] + mx[1]) / 2.0, mx[2]];",
  "    let before = s.volume(&p).unwrap();",
  '    let cut = s.apply(&p, ops::boolean("cut", Json::obj().set("primitive", "sphere").set("radius", 3.0), top));',
  "    let after = s.volume(&p).unwrap();",
  '    s.log(&format!("centre {:.3} {:.3} {:.3}", c[0], c[1], c[2]));',
  '    s.log(&format!("top {:.3} {:.3} {:.3}", top[0], top[1], top[2]));',
  '    s.log(&format!("removed {:.3} {}", before - after, if cut.is_ok() { "cut" } else { "refused" }));',
  "    s.done(&p);",
  "}",
  "",
].join("\n");

/** The numbers a run logged: `centre x y z`, `top x y z`, `removed v`. */
function logged(notes: readonly string[]): { centre?: V3; top?: V3; removed?: number } {
  const line = (word: string) => notes.map((note) => note.replace(/^line \d+: /, "")).find((note) => note.startsWith(`${word} `))?.split(" ").slice(1).map(Number);
  const c = line("centre");
  const t = line("top");
  const r = line("removed");
  return { ...(c ? { centre: c as V3 } : {}), ...(t ? { top: t as V3 } : {}), ...(r ? { removed: r[0] } : {}) };
}

interface Case {
  name: string;
  place: Record<string, unknown> | null;
}
const cases: Case[] = [
  { name: "unmoved", place: null },
  { name: "moved x+200", place: { x: 200 } },
  { name: "turned 90° about X", place: { turnX: 90 } },
  { name: "moved and turned, part frame", place: { x: 200, turnX: 90, frame: "part" } },
];

const refusals: Record<string, unknown> = {};
for (const c of cases) {
  const session = new Session(engine);
  session.clientName = "recipe-frame-test";
  const call = (name: string, args: unknown = {}) => session.call(name, args) as Promise<Row>;
  const made = await call("solid_new", { primitive: "sphere", radius: R });
  const ball = String(made.object);
  // The centre in the solid's own frame, before any pose.
  const own = ((await call("faces_find", { object: ball, kind: "sphere" })).faces as Row[] | undefined)?.[0];
  const ownCentre = vec(own?.axisPoint);
  check(`${c.name}: faces_find gives the sphere's centre (axisPoint)`, !!ownCentre, own);
  if (!ownCentre) continue;
  if (c.place) {
    const placed = await call("model_place", { object: ball, ...c.place });
    check(`${c.name}: model_place`, placed.ok === true, placed);
  }
  const obj = (session as unknown as { find(id: string): { modelPose?: Affine; frame?: "part" | "model"; tree: never; workplane: never; name: string; source: Float32Array; orient: never; scale: number; centered: boolean; offset: never } }).find(ball)!;
  const typed = typedPoseOf(obj);
  // Where the centre is in the frame ops are typed in: model space, or the part's own frame for frame: "part".
  const centre = applyPose(typed, ownCentre);
  const top: V3 = [centre[0], centre[1], centre[2] + R];

  // --- The MCP session's reads.
  const described = await call("model_describe", { object: ball, limit: 1 });
  const box = described.bounds as { min: number[]; max: number[] };
  check(`${c.name}: MCP model_describe's bounds are where ops are typed`, near(box?.min, [centre[0] - R, centre[1] - R, centre[2] - R], 0.2) && near(box?.max, [centre[0] + R, centre[1] + R, centre[2] + R], 0.2), { box, centre });
  const sphere = ((await call("faces_find", { object: ball, kind: "sphere" })).faces as Row[])[0]!;
  check(`${c.name}: MCP faces_find's sphere centre is where ops are typed`, near(vec(sphere.axisPoint), centre, 1e-3), { sphere, centre });
  const hit = await call("surface_at", { object: ball, point: [centre[0], centre[1], centre[2] + 3 * R], direction: [0, 0, -1] });
  check(`${c.name}: MCP surface_at hits the top where ops are typed`, hit.hit === true && near(vec(hit.point), top, 0.2), { hit, top });
  const probe = await call("model_probe", { object: ball, op: { kind: "boolean", op: "cut", primitive: "sphere", radius: 3, origin: vec(hit.point) ?? top } });
  check(`${c.name}: MCP model_probe of a crater at surface_at's point fits`, probe.ok === true, probe);
  const missed = await call("model_probe", { object: ball, op: { kind: "boolean", op: "cut", primitive: "sphere", radius: 0.5, origin: [centre[0] - R - 5, centre[1] - R - 5, centre[2] - R - 5] } });
  check(`${c.name}: a cut beside the part is refused as a miss`, missed.ok === false && missed.missed === true, missed);
  check(`${c.name}: the refusal no longer says "sits at ("`, !String(missed.reason).includes("sits at ("), missed.reason);
  if (c.place && !c.place.frame) check(`${c.name}: the refusal names model space and the pose`, /model space/.test(String(missed.reason)) && /moved by \(200, 0, 0\)|turned \(90°, 0°, 0°\)/.test(String(missed.reason)), missed.reason);
  refusals[c.name] = { probeRefusal: missed.reason };

  // --- A recipe over MCP: pick, measure, cut at the top.
  const viaMcp = await call("recipe_run", { source: crater, name: "frame-crater", object: ball, params: { ball: Number(sphere.index) } });
  const mcpRead = logged((viaMcp.notes as string[] | undefined) ?? []);
  check(`${c.name}: MCP recipe runs`, viaMcp.ok === true, viaMcp);
  check(`${c.name}: MCP recipe's pick_face centre is where ops are typed`, near(mcpRead.centre, centre, 1e-2), { read: mcpRead, centre });
  check(`${c.name}: MCP recipe's bounds top is the part's top`, near(mcpRead.top, top, 0.2), { read: mcpRead, top });
  check(`${c.name}: MCP recipe's crater at the measured top cuts the part`, (mcpRead.removed ?? 0) > 1, mcpRead);
  await call("model_undo", { object: ball });

  // --- The app's answers (the Plugins panel's run), on the same part at the same step.
  const part = { id: ball, name: obj.name, tree: obj.tree, pose: typed, modelPose: obj.modelPose, workplane: obj.workplane, frame: "model", place: { source: obj.source, orient: obj.orient, scale: obj.scale, centered: obj.centered, offset: obj.offset } };
  const shown = (obj.tree as unknown as { key: string; current: number });
  const start = solidView(await appEngine.tree(shown.key, shown.current, gotoRequest(shown.key, shown.current, 0.05)))!;
  const app = new AppRecipeCalls({ ...part, solid: start } as never, appEngine, { chordMm: 0.05, params: {} });
  const ask = async (tool: string, args: Row) => {
    const reply = await app.call({ id: 1, tool, args: { object: ball, ...args }, line: 1 });
    return reply.ok ? (reply.result as Row) : { ok: false, reason: reply.error, ...(reply.extra ?? {}) };
  };
  const appBox = (await ask("model_describe", { limit: 1 })).bounds as { min: number[]; max: number[] };
  check(`${c.name}: app model_describe's bounds match the MCP's`, near(appBox?.min, box.min, 1e-6) && near(appBox?.max, box.max, 1e-6), { app: appBox, mcp: box });
  const appSphere = ((await ask("faces_find", { kind: "sphere" })).faces as Row[] | undefined)?.[0];
  check(`${c.name}: app faces_find's sphere centre matches`, near(vec(appSphere?.axisPoint), centre, 1e-3), appSphere);
  const appHit = await ask("surface_at", { point: [centre[0], centre[1], centre[2] + 3 * R], direction: [0, 0, -1] });
  check(`${c.name}: app surface_at hits the top where ops are typed`, appHit.hit === true && near(vec(appHit.point), top, 0.2), appHit);
  const appMissed = await ask("model_probe", { op: { kind: "boolean", op: "cut", primitive: "sphere", radius: 0.5, origin: [centre[0] - R - 5, centre[1] - R - 5, centre[2] - R - 5] } });
  check(`${c.name}: the app's refusal of a miss says what the MCP's says`, appMissed.ok === false && appMissed.reason === missed.reason, { app: appMissed.reason, mcp: missed.reason });
  (refusals[c.name] as Row).appProbeRefusal = appMissed.reason;

  const viaApp = await runPluginFresh({
    part: part as never,
    plugin: { id: "frame-crater", version: 1, sha256: "0".repeat(64), api: "1.4" },
    body: crater,
    params: { ball: Number(sphere.index) },
    context: { bedMm: [250, 210, 220], nozzleMm: 0.4 },
    recipes: host,
    engine: appEngine,
    env: { chordMm: 0.05, params: {} },
    runId: "f00dcafe",
  });
  const appRead = logged(viaApp.notes);
  check(`${c.name}: the app's run keeps a step`, viaApp.ok === true, viaApp.ok ? "" : viaApp.reason);
  check(`${c.name}: the app reads what the MCP reads (pick centre, bounds top, crater)`, near(appRead.centre, mcpRead.centre ?? [NaN, NaN, NaN], 1e-3) && near(appRead.top, mcpRead.top ?? [NaN, NaN, NaN], 1e-3) && Math.abs((appRead.removed ?? 0) - (mcpRead.removed ?? -1)) < 1e-3, { app: appRead, mcp: mcpRead });
}

console.log(JSON.stringify(refusals, null, 1));

if (failed) {
  console.error(`recipe-frame: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-frame: all passed");
process.exit(0);
