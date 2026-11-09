/**
 * recipe_run's kernel timing split and meshing once at the end (docs/plan-native-recipes.md milestones 2 and 4).
 *
 * 1. Against the stand-in engine, which answers a request that starts with the timing marker with fixed `kernelUs`
 *    numbers and an apply that asks for no mesh with the engine's own light reply: `profile.split` is there, its parts add
 *    up to the run, the kernel counters and each line's kernel time are there, and a recipe that meshes at the end
 *    (recipe_run {meshAtEnd}, or s.mesh_at_end(), recipe API 1.10) sends no mesh request after a plain step, asks for the
 *    mesh before any call that reads the part and once at the end, ends with the same solid as the run that meshes every
 *    step, and leaves nothing pending after a refused run. Needs lust.
 * 2. Against real Open CASCADE: the same three things with real numbers, and the final solid and mesh byte for byte
 *    the same either way, on a sphere with bosses and bores. Needs LIME_OCCT_BRIDGE and the MCP addon.
 * In CI, LIME_RECIPE_REQUIRED=1 makes a missing lust, bridge or addon a failure.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, fakeEngine, loadEngineWorker, type Engine } from "./engine.ts";
import { findLust } from "./recipe.ts";
import { Session } from "./session.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const required = process.env.LIME_RECIPE_REQUIRED === "1";
if (!findLust()) {
  if (required) {
    console.error("recipe-profile: lust (LIME_LUST) is required here");
    process.exit(1);
  }
  console.log("recipe-profile: skipped (needs LIME_LUST)");
  process.exit(0);
}
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-recipe-profile-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "60";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2500)}`);
}

// The replies are read by property here, as the other tests read theirs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Four bosses and four bores on a block: eight plain steps, and a read of the part in the middle when `read`. */
const recipe = (opts: { read?: boolean; meshAtEnd?: boolean; hole?: boolean; refuse?: boolean } = {}) => [
  "use lime_recipe::{ops, Json, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  ...(opts.meshAtEnd ? ["    s.mesh_at_end();"] : []),
  "    let p = s.solid_new(ops::cuboid(60.0, 40.0, 10.0)).unwrap();",
  "    let mut seen = 0.0;",
  "    for i in 0..4 {",
  "        let x = -22.5 + 15.0 * i as f64;",
  "        s.apply(&p, ops::boolean(\"fuse\", ops::cylinder(4.0, 8.0), [x, 0.0, 10.0])).unwrap();",
  ...(opts.hole ? ["        if i == 1 { s.apply(&p, ops::hole_through([x, 12.0, 5.0], [0.0, 0.0, -1.0], 2.0)).unwrap(); }"] : []),
  "        s.apply(&p, ops::boolean(\"cut\", ops::cylinder(1.5, 30.0), [x, 0.0, 0.0])).unwrap();",
  ...(opts.read ? ["        if i == 1 { let (lo, hi) = s.bounds(&p).unwrap(); seen = hi[2] - lo[2]; }"] : []),
  ...(opts.refuse ? ["        if i == 2 { s.apply(&p, ops::hole_through([500.0, 500.0, 10.0], [0.0, 0.0, -1.0], 20.0)).unwrap(); }"] : []),
  "    }",
  "    s.done_with(&p, Json::obj().set(\"seen\", seen));",
  "}",
].join("\n");

/** Bosses and bores along the top of the part passed in (a sphere of radius 30 standing on Z = 0), with a read of it between. */
const onTop = [
  "use lime_recipe::{ops, Json, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  "    let p = s.object().unwrap();",
  "    let mut seen = 0.0;",
  "    for i in 0..4 {",
  "        let x = -15.0 + 10.0 * i as f64;",
  "        s.apply(&p, ops::boolean(\"fuse\", ops::cylinder(3.0, 12.0), [x, 0.0, 50.0])).unwrap();",
  "        s.apply(&p, ops::boolean(\"cut\", ops::cylinder(1.0, 30.0), [x, 0.0, 40.0])).unwrap();",
  "        if i == 1 { let (lo, hi) = s.bounds(&p).unwrap(); seen = hi[2] - lo[2]; }",
  "    }",
  "    s.done_with(&p, Json::obj().set(\"seen\", seen));",
  "}",
].join("\n");

const sum = (split: Row) => Object.values(split as Record<string, number>).reduce((a, b) => a + b, 0);
const hash = (positions: Float32Array) => createHash("sha256").update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength)).digest("hex").slice(0, 16);

/** A session, with every request the engine got (the timing marker taken off) kept in `bodies`. */
function tapped(engine: Engine): { session: Session; bodies: Row[]; call: (name: string, args?: unknown) => Promise<Row> } {
  const bodies: Row[] = [];
  const original = engine.modelTree.bind(engine);
  engine.modelTree = (body: string) => {
    if (!body.startsWith('{"timing":true,')) bodies.push(JSON.parse(body) as Row);
    return original(body);
  };
  const session = new Session(engine);
  return { session, bodies, call: (name, args = {}) => session.call(name, args) as Promise<Row> };
}

// --- 1. The stand-in engine.
{
  const { session, bodies, call } = tapped(fakeEngine());
  const applies = () => bodies.filter((b) => b.call === "apply");
  const gotos = () => bodies.filter((b) => b.call === "goto");

  const every = await call("recipe_run", { source: recipe(), name: "boss", profile: true });
  check("a profiled run applies", every.ok === true && every.calls === 9, every);
  const profile = every.profile as Row;
  const split = profile.split as Row;
  check("the profile has the split: recipe, host, engine hop, kernel booleans, kernel meshing, kernel other", ["recipeMs", "hostMs", "engineHopMs", "kernelBooleanMs", "kernelMeshMs", "kernelOtherMs"].every((key) => typeof split[key] === "number" && split[key] >= 0), split);
  check("its parts add up to the run time, to within a millisecond", Math.abs(sum(split) - Number(every.runMs)) <= 1, { split, runMs: every.runMs });
  check("the kernel's own counters are there", profile.kernel?.booleans >= 16 && profile.kernel?.meshes === 8 && profile.kernel?.booleanMs > 0 && profile.kernel?.meshMs > 0 && typeof profile.kernel?.otherMs === "number", profile.kernel);
  const line = (profile.lines as Row[]).find((row) => row.tool === "model_apply");
  check("each line says its kernel time, boolean time and mesh time", !!line && typeof line.kernelMs === "number" && typeof line.booleanMs === "number" && typeof line.meshMs === "number" && line.ms >= 0, profile.lines);
  check("a run without profile asks for no timing and its reply has none", (await call("recipe_run", { source: recipe(), name: "boss2" })).profile === undefined && bodies.every((b) => b.timing === undefined));
  check("a run that did not ask for it meshes every step, as before", applies().every((b) => b.mesh === undefined) && gotos().length === 0, applies().length);

  const solidOf = (id: string) => (session as unknown as { find(id: string): { solid: { positions: Float32Array; fingerprint: unknown; volumeMm3: number }; tree: { nodes: Map<number, { op: unknown }> } } }).find(id)!;
  const plainId = String(every.object);
  const plain = solidOf(plainId);
  const plainOps = JSON.stringify([...plain.tree.nodes.values()].map((node) => node.op));

  bodies.length = 0;
  const late = await call("recipe_run", { source: recipe(), name: "boss3", profile: true, meshAtEnd: true });
  check("meshAtEnd applies the same recipe", late.ok === true && late.calls === every.calls, late);
  check("every plain step asks for no mesh", applies().length === 8 && applies().every((b) => b.mesh === false), applies().map((b) => b.mesh));
  check("the part is meshed once, after the last step", gotos().length === 1, gotos());
  const lateProfile = late.profile as Row;
  check("the run meshed nothing and the end meshed once", lateProfile.kernel?.meshes === 0 && lateProfile.meshAtEnd?.meshes === 1 && lateProfile.meshAtEnd?.ms >= 0, { kernel: lateProfile.kernel, end: lateProfile.meshAtEnd });
  check("the split still adds up", Math.abs(sum(lateProfile.split) - Number(late.runMs)) <= 1, { split: lateProfile.split, runMs: late.runMs });
  const lateSolid = solidOf(String(late.object));
  check("the final solid is the same: fingerprint, volume, mesh", JSON.stringify(lateSolid.solid.fingerprint) === JSON.stringify(plain.solid.fingerprint) && lateSolid.solid.volumeMm3 === plain.solid.volumeMm3 && hash(lateSolid.solid.positions) === hash(plain.solid.positions), { a: lateSolid.solid.fingerprint, b: plain.solid.fingerprint });
  check("and the same steps are stored", JSON.stringify([...lateSolid.tree.nodes.values()].map((node) => node.op)) === plainOps);
  check("nothing is left waiting for a mesh", (session as unknown as { meshPending: Map<string, number> }).meshPending.size === 0);

  // The recipe says it itself (API 1.10), and a read of the part in the middle meshes it first.
  bodies.length = 0;
  const said = await call("recipe_run", { source: recipe({ meshAtEnd: true, read: true }), name: "boss4" });
  check("s.mesh_at_end() does what the parameter does", said.ok === true && applies().length === 8 && applies().every((b) => b.mesh === false), said.ok === true ? applies().map((b) => b.mesh) : said);
  check("a read of the part meshes it first, and the end meshes once more", gotos().length === 2, gotos().length);
  bodies.length = 0;
  const readEvery = await call("recipe_run", { source: recipe({ read: true }), name: "boss5" });
  check("the read answers the same either way", typeof (said.metrics as Row).seen === "number" && (said.metrics as Row).seen === (readEvery.metrics as Row).seen, { said: said.metrics, every: readEvery.metrics });

  // A step that is not a plain boolean is meshed as it always was; the plain ones carry on.
  bodies.length = 0;
  const mixed = await call("recipe_run", { source: recipe({ hole: true }), name: "boss6", meshAtEnd: true });
  check("a hole is applied with its mesh, the booleans without", mixed.ok === true && applies().filter((b) => b.mesh === false).length === 8 && applies().filter((b) => b.mesh === undefined).length === 1, applies().map((b) => `${(b.op as Row).kind}:${b.mesh}`));

  // A refused step takes the run back and leaves no mesh owed.
  const before = ((await call("plate_list", {})).objects as unknown[]).length;
  const refused = await call("recipe_run", { source: recipe({ refuse: true }), name: "boss7", meshAtEnd: true });
  check("a refusal in the middle fails the run and takes it back", refused.ok === false && ((await call("plate_list", {})).objects as unknown[]).length === before, refused);
  check("and nothing is left waiting for a mesh", (session as unknown as { meshPending: Map<string, number> }).meshPending.size === 0);
  const after = await call("recipe_run", { source: recipe(), name: "boss8", meshAtEnd: true });
  check("the session carries on", after.ok === true, after);
}

// --- 2. Real Open CASCADE.
const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
if (!bridge || !existsSync(bridge) || !addon) {
  if (required) {
    console.error("recipe-profile: LIME_OCCT_BRIDGE and the MCP addon are required here");
    process.exit(1);
  }
  console.log("recipe-profile: real Open CASCADE part skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
} else {
  const { session, call } = tapped(loadEngineWorker(root));
  const onSphere = (meshAtEnd: boolean) => async () => {
    const ball = String((await call("solid_new", { primitive: "sphere", radius: 30 })).object);
    const reply = await call("recipe_run", { source: onTop, name: "sphere-bosses", object: ball, profile: true, ...(meshAtEnd ? { meshAtEnd: true } : {}) });
    const solid = (session as unknown as { find(id: string): { solid: { positions: Float32Array; fingerprint: unknown; volumeMm3: number } } }).find(ball)!.solid;
    const checked = await call("model_check", { object: ball });
    return { reply, solid, ball, checked };
  };
  const every = await onSphere(false)();
  const late = await onSphere(true)();
  check("on real Open CASCADE the recipe applies both ways", every.reply.ok === true && late.reply.ok === true, { every: every.reply, late: late.reply });
  const split = every.reply.profile?.split as Row | undefined;
  const lateSplit = late.reply.profile?.split as Row | undefined;
  check("the kernel's timing comes back: booleans, meshing and the rest, adding up to the run", !!split && split.kernelBooleanMs > 0 && split.kernelMeshMs > 0 && Math.abs(sum(split) - Number(every.reply.runMs)) <= 1, { split, runMs: every.reply.runMs });
  check("the kernel is inside the engine's time, which is inside the calls", every.reply.profile.kernel.kernelMs <= every.reply.profile.kernel.engineMs + 0.01 && every.reply.profile.kernel.engineMs <= every.reply.profile.callsMs + 1, every.reply.profile);
  check("meshing once at the end meshes the run less, and the end once", late.reply.profile.kernel.meshes < every.reply.profile.kernel.meshes && late.reply.profile.meshAtEnd.meshes === 1 && !!lateSplit && lateSplit.kernelMeshMs < (split?.kernelMeshMs ?? 0), { every: every.reply.profile.kernel, late: late.reply.profile });
  check("the same solid: fingerprint and volume", JSON.stringify(every.solid.fingerprint) === JSON.stringify(late.solid.fingerprint) && every.solid.volumeMm3 === late.solid.volumeMm3, { a: every.solid.fingerprint, b: late.solid.fingerprint });
  check("the same mesh, byte for byte", hash(every.solid.positions) === hash(late.solid.positions) && every.solid.positions.length === late.solid.positions.length, { a: every.solid.positions.length, b: late.solid.positions.length });
  check("the same read in the middle and the same check at the end", JSON.stringify((every.reply.metrics as Row).seen) === JSON.stringify((late.reply.metrics as Row).seen) && JSON.stringify(every.checked) === JSON.stringify(late.checked), { a: every.reply.metrics, b: late.reply.metrics });
}

if (failed > 0) {
  console.error(`recipe-profile: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-profile: all passed");
process.exit(0);
