/**
 * The rib network (`ribNet`, docs/plan-auto-ribs.md step 1) through the MCP server against real Open CASCADE, on
 * synthetic solids only: a flat-floored shelled box, a floor that turns into an 8° slope, a cylinder-segment panel
 * (R 80, 2 mm wall), a lofted freeform cover, a Y, two crossing paths, a path over a crease, a path into a side wall, and
 * a path under a lid (the room in front of the wall). Each asserts one shell, the outside unchanged by rays from beyond
 * the walls, the volume added against the analytic one, one History row, and an undo that takes it all back. Then 312
 * runs in one network, timed, and model_check on a ribbed box flat and on the belt.
 *
 * First, the leak of the existing `ribs` step the probe found (2026-11-17): on a sloped floor that meets a flat strip,
 * ribs up the slope ran on inside the flat floor's wall and broke 0.2 mm through its underside.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { shellCount } from "../src/mesh-shells.ts";
import { ribShape, type RibProfile, type RibShape } from "../src/modeling/rib-net.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("rib-net-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("rib-net-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-rib-net-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "120";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
type V3 = [number, number, number];
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;
interface Held {
  solid?: { fingerprint: { volumeMm3: number; faces: number; edges: number }; positions: Float32Array; bounds: { min: V3; max: V3 } };
}
const held = (object: string) => (session as unknown as { find(id: string): Held | undefined }).find(object)!.solid!;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Distances along rays, null for a miss. */
async function rays(object: string, list: { point: V3; direction: V3 }[]): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (let i = 0; i < list.length; i += 400) {
    const reply = await call("surface_at", { object, rays: list.slice(i, i + 400) });
    for (const hit of (reply.hits ?? []) as Reply[]) out.push(hit.hit === true ? Number(hit.distanceMm) : null);
  }
  return out;
}

/** Rays from beyond the outside toward the part: from under the floor and from each side, on a grid of the box. */
type Side = "under" | "x" | "y" | "z+" | "+x";
function outsideRays(box: { min: V3; max: V3 }, sides: Side[] = ["under", "x", "y"]): { point: V3; direction: V3 }[] {
  const list: { point: V3; direction: V3 }[] = [];
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const steps = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 0.5)) / n);
  if (sides.includes("under")) for (const x of steps(x0, x1, 41)) for (const y of steps(y0, y1, 23)) list.push({ point: [x, y, z0 - 10], direction: [0, 0, 1] });
  if (sides.includes("x")) for (const y of steps(y0, y1, 15)) for (const z of steps(z0, z1, 9)) list.push({ point: [x0 - 10, y, z], direction: [1, 0, 0] }, { point: [x1 + 10, y, z], direction: [-1, 0, 0] });
  if (sides.includes("y")) for (const x of steps(x0, x1, 25)) for (const z of steps(z0, z1, 9)) list.push({ point: [x, y0 - 10, z], direction: [0, 1, 0] }, { point: [x, y1 + 10, z], direction: [0, -1, 0] });
  // Only from beyond +X, toward -X: the outside of a curved panel whose inside faces -X.
  if (sides.includes("+x")) for (const y of steps(y0, y1, 31)) for (const z of steps(z0, z1, 15)) list.push({ point: [x1 + 10, y, z], direction: [-1, 0, 0] });
  if (sides.includes("z+")) for (const x of steps(x0, x1, 41)) for (const y of steps(y0, y1, 23)) list.push({ point: [x, y, z1 + 10], direction: [0, 0, -1] });
  return list;
}

/** How far the outside moved: the largest change of any outside ray's distance, mm. */
async function outsideShift(object: string, list: { point: V3; direction: V3 }[], before: (number | null)[]): Promise<number> {
  const after = await rays(object, list);
  let worst = 0;
  after.forEach((d, i) => {
    const b = before[i];
    if (b === null && d === null) return;
    worst = Math.max(worst, b === null || d === null ? Infinity : Math.abs(d - b!));
  });
  return worst;
}

async function shellBox(dx: number, dy: number, dz: number): Promise<string> {
  const object = String((await call("solid_new", { primitive: "box", dx, dy, dz })).object);
  const shelled = await call("model_apply", { object, probe: true, op: { kind: "shell", thickness: 2, openFaces: [{ normal: [0, 0, 1] }] } });
  if (shelled.ok !== true) throw new Error(`shell: ${JSON.stringify(shelled).slice(0, 300)}`);
  return object;
}

/**
 * One network on one part, with every check: it applies as one History row with its report, the mesh is one shell,
 * the outside is unchanged, the volume added is near `expect` (±`tol`, a fraction), and an undo takes it all back.
 */
async function network(title: string, object: string, op: Record<string, unknown>, expect: number | null, tol: number, sides?: Side[]): Promise<Reply> {
  const box = held(object).bounds;
  const outside = outsideRays(box, sides);
  const before = await rays(object, outside);
  const volume = held(object).fingerprint.volumeMm3;
  const history = ((await call("model_history", { object })).nodes ?? []) as unknown[];
  const started = Date.now();
  let done = await call("model_apply", { object, op: { kind: "ribNet", ...op } });
  // A call past the reply limit goes on as a job; its result is the call's own.
  while (done.status === "running" && typeof done.job === "string") done = await call("slice_wait", { job: done.job, timeoutS: 30 });
  const ms = Date.now() - started;
  const report = (done.ribNet ?? {}) as Reply;
  check(`${title}: applies as one step`, done.ok === true && done.applied === 1, JSON.stringify(done).slice(0, 900));
  if (done.ok !== true) return done;
  const added = held(object).fingerprint.volumeMm3 - volume;
  check(`${title}: one shell`, shellCount(held(object).positions) === 1, String(shellCount(held(object).positions)));
  const shift = await outsideShift(object, outside, before);
  check(`${title}: the outside is unchanged (${outside.length} rays from beyond the walls)`, shift < 0.01, `moved ${shift} mm`);
  const grew = held(object).bounds;
  // On the cylinder panel (outside +X) the ribs stand toward -X, and a square end may reach past the panel's edges there.
  const inward = sides?.includes("+x") ?? false;
  check(`${title}: the box did not grow but rib-side`, [0, 1].every((k) => (grew.min[k]! >= box.min[k]! - 1e-3 || (k === 0 && inward)) && grew.max[k]! <= box.max[k]! + 1e-3) && grew.min[2] >= box.min[2] - 1e-3, JSON.stringify([box, grew]));
  check(`${title}: the reply's addedMm3 is the volume change`, Math.abs(Number(report.addedMm3) - added) < 0.01, JSON.stringify(report).slice(0, 400));
  if (expect !== null) check(`${title}: adds ${r3(added)} mm³ against ${r3(expect)} mm³ analytic (±${tol * 100} %)`, Math.abs(added - expect) <= tol * expect, `${r3(added)} vs ${r3(expect)}`);
  const after = ((await call("model_history", { object })).nodes ?? []) as unknown[];
  check(`${title}: one History row`, after.length === history.length + 1, JSON.stringify([history.length, after.length]));
  console.log(`  ${title}: ${report.runs} runs, +${r3(added)} mm³ (analytic ${expect === null ? "n/a" : r3(expect)}), ${ms} ms, ends ${JSON.stringify(report.ends)}${report.shortened ? `, shortened ${JSON.stringify(report.shortened)}` : ""}${report.skipped ? `, skipped ${JSON.stringify(report.skipped)}` : ""}`);
  return { ...done, added, ms };
}

async function undoes(title: string, object: string, volume: number) {
  const undone = await call("model_undo", { object });
  check(`${title}: one undo takes the whole network back`, undone.ok === true && Math.abs(held(object).fingerprint.volumeMm3 - volume) < 1e-6, JSON.stringify(undone).slice(0, 300));
  const redone = await call("model_redo", { object });
  check(`${title}: redo brings it back`, redone.ok === true && held(object).fingerprint.volumeMm3 > volume + 1);
}

const t8 = Math.tan((8 * Math.PI) / 180);
const s8 = Math.sin((8 * Math.PI) / 180);
const c8 = Math.cos((8 * Math.PI) / 180);

/** The probe's sloped part: 200 × 100 × 40, its bottom cut at 8° from x = 0 to the +X end, shelled 2 mm, open on top. */
async function slopedShell(): Promise<string> {
  const object = String((await call("solid_new", { primitive: "box", dx: 200, dy: 100, dz: 40 })).object);
  const top: V3 = [100, 0, 100 * t8];
  const centre: V3 = [top[0] + 50 * s8, 0, top[2] - 50 * c8];
  const cut = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", dx: 300, dy: 200, dz: 100, centre, turn: [0, -8, 0] } });
  if (cut.ok !== true) throw new Error(`slope: ${JSON.stringify(cut).slice(0, 300)}`);
  const shelled = await call("model_apply", { object, probe: true, op: { kind: "shell", thickness: 2, openFaces: [{ normal: [0, 0, 1] }] } });
  if (shelled.ok !== true) throw new Error(`shell: ${JSON.stringify(shelled).slice(0, 300)}`);
  return object;
}

// ===== The `ribs` leak on a sloped floor, and its fix. =====
{
  const object = await slopedShell();
  const box = held(object).bounds;
  const outside = outsideRays(box, ["under"]);
  const before = await rays(object, outside);
  const done = await call("model_apply", { object, op: { kind: "ribs", face: { normal: [-s8, 0, c8], nearPoint: [50, 0, 50 * t8 + 2 / c8] }, along: "v", width: 1.5, pitch: 15, depth: 6 } });
  check("ribs up the 8° slope apply", done.ok === true, JSON.stringify(done).slice(0, 500));
  const shift = await outsideShift(object, outside, before);
  const low = held(object).bounds.min[2];
  console.log(`  ribs on the sloped floor: underside moved ${r3(shift)} mm, lowest point z ${r3(low)} (was ${r3(box.min[2])})`);
  check("ribs on a sloped floor leave the underside as it was (the probe's leak was 0.2 mm through it)", shift < 0.01 && low >= box.min[2] - 1e-3, `moved ${shift} mm, lowest z ${low}`);
}

// ===== Flat-floored shell box, 120 × 80 × 30, 2 mm walls: inner floor at z 2, inner walls at x ±58, y ±38. =====
const w = 1.5;
const h = 6;
{
  const object = await shellBox(120, 80, 30);
  const volume = held(object).fingerprint.volumeMm3;
  await network("wall to wall on a flat floor", object, { width: w, height: h, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] }, w * h * 116, 0.005);
  await undoes("wall to wall on a flat floor", object, volume);
}
{
  const object = await shellBox(120, 80, 30);
  // One loose end tapered over the height (half its volume lost over 6 mm), the other into the wall.
  await network("a path running into a side wall", object, { width: w, height: h, paths: [{ points: [[20, 0, 2], [58, 0, 2]] }] }, w * h * (38 - h / 2), 0.005);
}
{
  const object = await shellBox(120, 80, 30);
  // Two runs, each 80 long with two tapered ends, crossing at the middle: less the shared w × w × h.
  await network("two crossing paths", object, { width: w, height: h, paths: [{ points: [[-40, 0, 2], [40, 0, 2]] }, { points: [[0, -30, 2], [0, 30, 2]] }] }, w * h * (80 - h) + w * h * (60 - h) - w * w * h, 0.01);
}
{
  const object = await shellBox(120, 80, 30);
  // A Y: a trunk with two branches from its middle. The branches overlap the trunk and each other at the joint.
  const branch = Math.hypot(20, 20);
  const expect = w * h * (80 - h) + 2 * w * h * (branch - h / 2);
  await network("a Y-branching path", object, { width: w, height: h, paths: [{ points: [[-40, 0, 2], [40, 0, 2]] }, { points: [[0, 0, 2], [20, 20, 2]] }, { points: [[0, 0, 2], [-20, 20, 2]] }] }, expect, 0.03);
}

// ===== A path over a crease: the flat strip, over the kink, up the 8° slope. =====
{
  const object = await slopedShell();
  const zIn = (x: number) => x * t8 + 2 / c8;
  const kink = (2 - 2 / c8) / t8;
  const length = (kink + 40) + (60 - kink) / c8;
  await network("a path over a crease (flat to 8° slope)", object, { width: w, height: h, paths: [{ points: [[-40, 20, 2], [kink, 20, 2], [60, 20, zIn(60)]] }] }, w * h * (length - h), 0.01, ["under", "y"]);
}

// ===== A cylinder-segment panel: a tube R 80, 2 mm wall, 60 tall, kept for x > 0 and |y| < 40; ribs on its inside. =====
{
  const object = String((await call("solid_new", { primitive: "tube", radius: 80, innerRadius: 78, height: 60 })).object);
  const kept = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "common", primitive: "box", origin: [0, -40, -1], dx: 100, dy: 80, dz: 62 } });
  check("the cylinder panel is made", kept.ok === true, JSON.stringify(kept).slice(0, 300));
  const R = 78;
  const arc: V3[] = [];
  for (let deg = -25; deg <= 25; deg += 5) arc.push([R * Math.cos((deg * Math.PI) / 180), R * Math.sin((deg * Math.PI) / 180), 30]);
  const theta = (50 * Math.PI) / 180;
  // The arc rib fills R − h to R over 50°, less its two tapers; the upright one 50 long less its tapers; less their crossing.
  const sector = (w * (R * R - (R - h) * (R - h))) / 2;
  const expect = sector * (theta - h / R) + w * h * (50 - h) - w * w * h;
  await network("a cylinder-segment shell, R 78 inside", object, { width: w, height: h, paths: [{ points: arc }, { points: [[R, 0, 5], [R, 0, 55]] }] }, expect, 0.02, ["+x"]);
}

// ===== A freeform cover: a smooth loft through four sections whose tops rise and fall, hollowed by a smaller loft cut
// from underneath (a shell of this loft is refused by the kernel), so its roof's inside is a B-spline face about 2 mm in.
{
  const object = String((await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 5 })).object);
  const section = (x: number, top: number, half: number, low: number) => ({ origin: [x, 0, 0], turn: [0, 90, 0], profile: [[-low, -half], [-low, half], [-top, half], [-top, -half]] });
  const outer = [[-60, 20], [-20, 32], [20, 26], [60, 22]].map(([x, top]) => section(x!, top!, 40, 0));
  const lofted = await call("model_apply", { object, probe: true, op: { kind: "loft", op: "fuse", sections: outer } });
  check("the freeform cover is lofted", lofted.ok === true, JSON.stringify(lofted).slice(0, 300));
  const inner = [[-58, 18.5], [-20, 30], [20, 24], [58, 20]].map(([x, top]) => section(x!, top!, 38, -1));
  const hollowed = await call("model_apply", { object, probe: true, op: { kind: "loft", op: "cut", sections: inner } });
  check("and hollowed from underneath", hollowed.ok === true, JSON.stringify(hollowed).slice(0, 300));
  // Points on the inside of its roof, read by rays up from inside; one run along X, one across Y wall to wall.
  const along = await call("surface_at", { object, rays: Array.from({ length: 23 }, (_, i) => ({ point: [-55 + i * 5, 0, 1], direction: [0, 0, 1] })) });
  const across = await call("surface_at", { object, rays: Array.from({ length: 16 }, (_, i) => ({ point: [10, -37.5 + i * 5, 1], direction: [0, 0, 1] })) });
  const pts = (reply: Reply) => ((reply.hits ?? []) as Reply[]).filter((hit) => hit.hit === true).map((hit) => hit.point as V3);
  const a = pts(along);
  const b = [[10, -38, pts(across)[0]![2]] as V3, ...pts(across), [10, 38, pts(across).at(-1)![2]] as V3];
  const arcLength = (list: V3[]) => list.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - list[i]![0], p[1] - list[i]![1], p[2] - list[i]![2]), 0);
  const expect = w * 4 * (arcLength(a) - 4) + w * 4 * arcLength(b) - w * w * 4;
  await network("a freeform lofted shell (ribs under its roof)", object, { width: w, height: 4, paths: [{ points: a }, { points: b }] }, expect, 0.1, ["x", "y", "z+"]);
}

// ===== The room in front of the wall: a lid over half the box, 22 mm over the floor, and a block hanging from it. =====
{
  const object = await shellBox(120, 80, 30);
  const lid = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [-60, -40, 24], dx: 60, dy: 80, dz: 6 } });
  check("the lid is fused", lid.ok === true, JSON.stringify(lid).slice(0, 300));
  const H = 25;
  const done = await network("a path too close to a facing wall (the lid)", object, { width: w, height: H, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] }, w * (21.5 * 58 + H * 58), 0.01, ["under", "y"]);
  const report = (done.ribNet ?? {}) as Reply;
  check("the lid: the stretch under it is reported shortened to 21.5 mm", Array.isArray(report.shortened) && report.shortened.length === 1 && report.shortened[0].heightMm === 21.5, JSON.stringify(report.shortened));
}
{
  const object = await shellBox(120, 80, 30);
  await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [-60, -40, 24], dx: 60, dy: 80, dz: 6 } });
  const hang = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [-30, -5, 3.5], dx: 10, dy: 10, dz: 21 } });
  check("a block hangs from the lid 1.5 mm over the floor", hang.ok === true, JSON.stringify(hang).slice(0, 300));
  const done = await network("a stretch with no room is left out (the hanging block)", object, { width: w, height: 25, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] }, null, 0, ["under", "y"]);
  const report = (done.ribNet ?? {}) as Reply;
  check("the hanging block: one stretch skipped with why, two runs built", Array.isArray(report.skipped) && report.skipped.length === 1 && /in front of the wall/.test(String(report.skipped[0].why)) && report.runs === 2, JSON.stringify(report).slice(0, 600));
}

// ===== Refusals: nothing changes. =====
{
  const object = await shellBox(120, 80, 30);
  const before = JSON.stringify(held(object).fingerprint);
  const off = await call("model_apply", { object, op: { kind: "ribNet", width: w, height: h, paths: [{ points: [[0, 0, 10], [20, 0, 10]] }] } });
  check("a path off the surface is refused in a sentence", off.ok === false && /more than 2 mm from the part's surface/.test(JSON.stringify(off)), JSON.stringify(off).slice(0, 400));
  const thin = await call("model_apply", { object, op: { kind: "ribNet", width: w, height: h, sinkMm: 1.9, paths: [{ points: [[-20, 0, 2], [20, 0, 2]] }] } });
  check("a sink that would break through a 2 mm wall is refused", thin.ok === false && /could break through the outside/.test(JSON.stringify(thin)), JSON.stringify(thin).slice(0, 400));
  check("and the part is as it was", JSON.stringify(held(object).fingerprint) === before);
}

// ===== Profiles: drafted and tee (with their default flared roots) on every wall, mixed, tapered, and timed. =====
// The analytic volume is the section's area over the wall times the length; the section's area is the closed form the
// unit test (src/modeling/rib-net.test.ts) checks the polygon against. Crossings take off ∫ w1(v)·w2(v) dv, the
// square the two sections share at each height.
type P2 = [number, number];
const profiles: Record<"drafted" | "tee", (width: number, height: number) => RibProfile> = {
  drafted: (width, height) => ({ kind: "drafted", width, draftDeg: 1, rootRadius: 0.5 * (width - height * Math.tan(Math.PI / 180)), flangeWidth: 0, flangeThickness: 0, flangeChamferDeg: 0 }),
  tee: (width) => ({ kind: "tee", width, draftDeg: 0, rootRadius: 0.5 * width, flangeWidth: 3 * width, flangeThickness: width, flangeChamferDeg: 45 }),
};
const straightProfile = (width: number): RibProfile => ({ kind: "straight", width, draftDeg: 0, rootRadius: 0, flangeWidth: 0, flangeThickness: 0, flangeChamferDeg: 0 });
const shapeOf = (profile: RibProfile, height: number): RibShape => {
  const made = ribShape(profile, height, 0.5, 0.05);
  if ("reason" in made) throw new Error(made.reason);
  return made;
};
/** The section over the wall (v ≥ 0), clipped. */
function overWall(poly: readonly P2[]): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    if (p[1] >= 0) out.push(p);
    if ((p[1] >= 0) !== (q[1] >= 0)) out.push([p[0] + ((q[0] - p[0]) * (0 - p[1])) / (q[1] - p[1]), 0]);
  }
  return out;
}
/** Area and first moment about v = 0 of the section over the wall. */
function areaOver(shape: RibShape, hk: number): { area: number; moment: number } {
  const poly = overWall(shape.section(hk));
  let area = 0;
  let moment = 0;
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length]!;
    const c = p[0] * q[1] - q[0] * p[1];
    area += c / 2;
    moment += ((p[1] + q[1]) * c) / 6;
  });
  return { area, moment };
}
/** ∫ over v of what two sections share where they cross square: widths at each height, multiplied. */
function crossing(a: RibShape, b: RibShape, width: (s: RibShape, v: number) => number = (s, v) => 2 * s.halfAt(s.height, v)): number {
  const top = Math.min(a.height, b.height);
  const n = 4000;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = ((i + 0.5) * top) / n;
    sum += width(a, v) * width(b, v);
  }
  return (sum * top) / n;
}
/** A taper from 0 to the full height over `length`: Simpson's rule on each straight blend (exact, the area being quadratic). */
function taperVolume(shape: RibShape, length: number): number {
  const A = (hk: number) => areaOver(shape, hk).area;
  const h = shape.height;
  const hb = shape.hb;
  const l1 = (length * hb) / h;
  const l2 = length - l1;
  return (l1 / 6) * (A(0) + 4 * A(hb / 2) + A(hb)) + (l2 / 6) * (A(hb) + 4 * A((hb + h) / 2) + A(h));
}
const timings: string[] = [];
const checkedBoxes: { title: string; object: string }[] = [];
for (const kind of ["drafted", "tee"] as const) {
  const shape = shapeOf(profiles[kind](w, h), h);
  const A = areaOver(shape, h).area;
  console.log(`  ${kind}: section ${shape.section(h).length} corners, ${r3(A)} mm² over the wall (a plain rib ${r3(w * h)}), reach ${r3(shape.reach)} mm, hb ${r3(shape.hb)} mm`);
  {
    const object = await shellBox(120, 80, 30);
    const volume = held(object).fingerprint.volumeMm3;
    const done = await network(`${kind}: wall to wall on a flat floor`, object, { width: w, height: h, profile: kind, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] }, A * 116, 0.002);
    check(`${kind}: the reply counts one ${kind} run`, JSON.stringify((done.ribNet as Reply | undefined)?.profiles) === JSON.stringify({ [kind]: 1 }), JSON.stringify(done.ribNet));
    await undoes(`${kind}: wall to wall`, object, volume);
  }
  {
    const object = await shellBox(120, 80, 30);
    await network(`${kind}: two crossing ribs, wall to wall each way`, object, { width: w, height: h, profile: kind, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }, { points: [[0, -38, 2], [0, 38, 2]] }] }, A * 116 + A * 76 - crossing(shape, shape), 0.005);
  }
  {
    const object = await shellBox(120, 80, 30);
    // One loose end tapered over the height (to hb with the root and flange whole, then flat), the other into the wall.
    await network(`${kind}: a tapered free end`, object, { width: w, height: h, profile: kind, paths: [{ points: [[20, 0, 2], [58, 0, 2]] }] }, taperVolume(shape, h) + A * (38 - h), 0.005);
  }
  {
    // The cylinder panel, R 78 inside: an arc rib round it and an upright rib up it, square ends (taper 0).
    const object = String((await call("solid_new", { primitive: "tube", radius: 80, innerRadius: 78, height: 60 })).object);
    await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "common", primitive: "box", origin: [0, -40, -1], dx: 100, dy: 80, dz: 62 } });
    const R = 78;
    const arcPts: V3[] = [];
    for (let deg = -25; deg <= 25; deg += 5) arcPts.push([R * Math.cos((deg * Math.PI) / 180), R * Math.sin((deg * Math.PI) / 180), 30]);
    const { area, moment } = areaOver(shape, h);
    // The arc rib turns its section about the axis (Pappus); the upright one stands on a wall that rises u²/2R across it.
    const arcVolume = ((50 * Math.PI) / 180) * (R * area - moment);
    const upright = (area - (2 * shape.foot ** 3) / (6 * R)) * 50;
    await network(`${kind}: a cylinder-segment shell, R 78 inside`, object, { width: w, height: h, profile: kind, taper: 0, paths: [{ points: arcPts }, { points: [[R, 0, 5], [R, 0, 55]] }] }, arcVolume + upright - crossing(shape, shape), 0.02, ["+x"]);
  }
  {
    // The freeform cover (see above): ribs under its B-spline roof, 1.2 wide and 4 tall, square loose ends.
    const object = String((await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 5 })).object);
    const section = (x: number, top: number, half: number, low: number) => ({ origin: [x, 0, 0], turn: [0, 90, 0], profile: [[-low, -half], [-low, half], [-top, half], [-top, -half]] });
    await call("model_apply", { object, probe: true, op: { kind: "loft", op: "fuse", sections: [[-60, 20], [-20, 32], [20, 26], [60, 22]].map(([x, top]) => section(x!, top!, 40, 0)) } });
    await call("model_apply", { object, probe: true, op: { kind: "loft", op: "cut", sections: [[-58, 18.5], [-20, 30], [20, 24], [58, 20]].map(([x, top]) => section(x!, top!, 38, -1)) } });
    const along = await call("surface_at", { object, rays: Array.from({ length: 23 }, (_, i) => ({ point: [-55 + i * 5, 0, 1], direction: [0, 0, 1] })) });
    const across = await call("surface_at", { object, rays: Array.from({ length: 16 }, (_, i) => ({ point: [10, -37.5 + i * 5, 1], direction: [0, 0, 1] })) });
    const pts = (reply: Reply) => ((reply.hits ?? []) as Reply[]).filter((hit) => hit.hit === true).map((hit) => hit.point as V3);
    const a = pts(along);
    const b = [[10, -38, pts(across)[0]![2]] as V3, ...pts(across), [10, 38, pts(across).at(-1)![2]] as V3];
    const arcLength = (list: V3[]) => list.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - list[i]![0], p[1] - list[i]![1], p[2] - list[i]![2]), 0);
    const small = shapeOf(profiles[kind](1.2, 4), 4);
    const As = areaOver(small, 4).area;
    await network(`${kind}: a freeform lofted shell (ribs under its roof)`, object, { width: 1.2, height: 4, profile: kind, taper: 0, paths: [{ points: a }, { points: b }] }, As * arcLength(a) + As * arcLength(b) - crossing(small, small), 0.1, ["x", "y", "z+"]);
  }
  {
    // The 312-run lattice (as below for straight ribs), this profile, timed.
    const object = await shellBox(200, 140, 30);
    const paths: { points: V3[] }[] = [];
    const xs = Array.from({ length: 13 }, (_, i) => -90 + i * 15);
    const ys = Array.from({ length: 13 }, (_, j) => -60 + j * 10);
    for (const y of ys) for (let i = 0; i + 1 < xs.length; i += 1) paths.push({ points: [[xs[i]!, y, 2], [xs[i + 1]!, y, 2]] });
    for (const x of xs) for (let j = 0; j + 1 < ys.length; j += 1) paths.push({ points: [[x, ys[j]!, 2], [x, ys[j + 1]!, 2]] });
    const done = await network(`${kind}: ${paths.length} runs in one network`, object, { width: 1.2, height: 5, profile: kind, paths }, null, 0);
    timings.push(`${kind} ${paths.length} runs: ${done.ms} ms, +${r3(Number(done.added))} mm³`);
    check(`${kind}: ${paths.length} runs build within 60 s`, Number(done.ms) < 60000, String(done.ms));
  }
  {
    // A ribbed box for model_check: three ribs of this profile across the floor.
    const object = await shellBox(120, 80, 30);
    await network(`${kind}: three ribs for model_check`, object, { width: w, height: h, profile: kind, paths: [-20, 0, 20].map((y) => ({ points: [[-58, y, 2], [58, y, 2]] as V3[] })) }, 3 * A * 116, 0.005);
    checkedBoxes.push({ title: kind, object });
  }
}
{
  // Mixed profiles meeting: a drafted rib wall to wall along X, a tee from the +Y wall ending on it (a joint), and a
  // straight rib along X at y 20 the tee crosses.
  const object = await shellBox(120, 80, 30);
  const d = shapeOf(profiles.drafted(w, h), h);
  const t = shapeOf(profiles.tee(w, h), h);
  const s = shapeOf(straightProfile(w), h);
  const Ad = areaOver(d, h).area;
  const At = areaOver(t, h).area;
  // The tee runs from the wall to past the drafted rib's centre by the drafted top's half-width; where it lies over the
  // drafted rib, at each height it shares its width times the drafted half-width plus that.
  const shared = crossing(t, d, (shape, v) => (shape === d ? d.halfAt(h, v) + d.minHalf : 2 * shape.halfAt(h, v)));
  const expect = Ad * 116 + At * (38 + d.minHalf) + w * h * 116 - shared - crossing(t, s);
  const done = await network("mixed: a tee ends on a drafted rib and crosses a straight one", object, { width: w, height: h, paths: [{ points: [[-58, 0, 2], [58, 0, 2]], profile: "drafted" }, { points: [[0, 38, 2], [0, 0, 2]], profile: "tee" }, { points: [[-58, 20, 2], [58, 20, 2]] }] }, expect, 0.005);
  const report = (done.ribNet ?? {}) as Reply;
  check("mixed: one joint, five wall ends, a run of each profile", report.ends?.joint === 1 && report.ends?.wall === 5 && JSON.stringify(report.profiles) === JSON.stringify({ drafted: 1, tee: 1, straight: 1 }), JSON.stringify(report).slice(0, 400));
}
{
  // The square flange (flangeChamferDeg 0), for model_check against the 45° one.
  const object = await shellBox(120, 80, 30);
  const sq = shapeOf({ ...profiles.tee(w, h), flangeChamferDeg: 0 }, h);
  await network("tee, square flange: three ribs for model_check", object, { width: w, height: h, profile: "tee", flangeChamferDeg: 0, paths: [-20, 0, 20].map((y) => ({ points: [[-58, y, 2], [58, y, 2]] as V3[] })) }, 3 * areaOver(sq, h).area * 116, 0.005);
  checkedBoxes.push({ title: "tee, square flange", object });
  const plain = await shellBox(120, 80, 30);
  await network("straight: three ribs for model_check", plain, { width: w, height: h, paths: [-20, 0, 20].map((y) => ({ points: [[-58, y, 2], [58, y, 2]] as V3[] })) }, 3 * w * h * 116, 0.005);
  checkedBoxes.unshift({ title: "straight", object: plain });
}
/** model_check's overhang and thin-wall numbers, in a line. */
const checkLine = (reply: Reply) => `overhang ${reply.overhang?.areaMm2} mm² (${(reply.overhang?.regions ?? []).length} regions), thin walls ${reply.thinWalls?.areaMm2 ?? "n/a"} mm²${reply.thinWalls?.regions?.length ? ` thinnest ${Math.min(...(reply.thinWalls.regions as Reply[]).map((row) => Number(row.thinnestMm)))} mm` : ""}, open edges ${reply.edges?.open ?? "n/a"}`;
const flatOverhang: Record<string, number> = {};
for (const { title, object } of checkedBoxes) {
  const reply = await call("model_check", { object });
  check(`model_check on the flat bed reads the ${title} box`, reply.ok === true, JSON.stringify(reply).slice(0, 300));
  flatOverhang[title] = Number(reply.overhang?.areaMm2 ?? NaN);
  console.log(`  model_check flat, ${title}: ${checkLine(reply)}`);
}
// The 45° chamfer under the flange is at the threshold, not over it; the square flange's underside is a ceiling.
check("flat bed: the 45° chamfered tee reports no more overhang than the plain box, the square flange does", flatOverhang.tee === flatOverhang.straight && flatOverhang["tee, square flange"]! > flatOverhang.straight! + 3 * 2 * 1.5 * 116 * 0.95, JSON.stringify(flatOverhang));

// ===== 312 runs in one network: a 13 × 13 lattice of short ribs on a 200 × 140 floor, every end a joint. =====
let lattice = "";
let beltSelected = false;
{
  const object = await shellBox(200, 140, 30);
  const paths: { points: V3[] }[] = [];
  const xs = Array.from({ length: 13 }, (_, i) => -90 + i * 15);
  const ys = Array.from({ length: 13 }, (_, j) => -60 + j * 10);
  for (const y of ys) for (let i = 0; i + 1 < xs.length; i += 1) paths.push({ points: [[xs[i]!, y, 2], [xs[i + 1]!, y, 2]] });
  for (const x of xs) for (let j = 0; j + 1 < ys.length; j += 1) paths.push({ points: [[x, ys[j]!, 2], [x, ys[j + 1]!, 2]] });
  const volume = held(object).fingerprint.volumeMm3;
  const done = await network(`${paths.length} runs in one network`, object, { width: 1.2, height: 5, paths }, null, 0);
  lattice = `${paths.length} runs: ${done.ms} ms, +${r3(Number(done.added))} mm³`;
  check(`${paths.length} runs build within 60 s`, Number(done.ms) < 60000, String(done.ms));
  await undoes(`${paths.length} runs`, object, volume);
  // --- model_check on a ribbed flat box: flat on the bed, then on the belt.
  const flatCheck = await call("model_check", { object });
  check("model_check reads the ribbed box", flatCheck.ok === true, JSON.stringify(flatCheck).slice(0, 300));
  const belt = await call("machine_select", { printerId: "ideaformer-ir3-v2", filamentId: "lime-petg" });
  beltSelected = belt.ok === true;
  const beltCheck = belt.ok === true ? await call("model_check", { object }) : null;
  check("model_check reads it on the belt", beltCheck?.ok === true, JSON.stringify([belt, beltCheck]).slice(0, 300));
  const brief = (reply: Reply | null) => JSON.stringify(reply ? { overhang: reply.overhang ?? reply.overhangs, thin: reply.thin ?? reply.thinWalls, fits: reply.fits ?? reply.fit, summary: reply.summary ?? reply.note } : null).slice(0, 700);
  console.log(`  model_check flat: ${brief(flatCheck)}`);
  console.log(`  model_check belt: ${brief(beltCheck)}`);
}
// The profiled boxes on the belt (selected above): overhang read in the tilted layer frame.
if (beltSelected) {
  for (const { title, object } of checkedBoxes) {
    const reply = await call("model_check", { object });
    check(`model_check on the belt reads the ${title} box`, reply.ok === true, JSON.stringify(reply).slice(0, 300));
    console.log(`  model_check belt, ${title}: ${checkLine(reply)}`);
  }
}

console.log(`  timing: ${lattice}`);
for (const line of timings) console.log(`  timing: ${line}`);
rmSync(workspace, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("rib-net-occt: ok");
process.exit(0);
