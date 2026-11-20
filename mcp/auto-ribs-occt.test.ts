/**
 * Auto ribs end to end through the MCP server against real Open CASCADE and the release engine's rib planner
 * (docs/plan-auto-ribs.md step 6), on synthetic solids only.
 *
 * 1. The wall extraction (`ribWall`) on the kernel's own display meshes: a shelled box, a floor that turns into an 8°
 *    slope, a shell with filleted inside corners, a cylinder-segment panel and a lofted freeform cover; what it takes,
 *    what it finds in the mesh (seams, T-junctions, slivers), thickness, borders.
 * 2. A shelled box, 2 mm walls: ribs_plan with defaults on the inner floor (a job, its progress), then
 *    ribs_apply: one History row, the outside unchanged by rays, ribs only on the floor, undo removes it.
 * 3. A noRibs box zone (no added material inside it), an obstacle object (capped ribs under it), a cancel mid-plan (a
 *    usable partial plan, applied), apply:true in one job, a stale plan refused.
 * 4. verify:true: the sliced Stress study before and after (relative numbers).
 * 5. A curved wall: the cylinder-segment panel, planned and applied. Load cases (5b, 5c) are in auto-ribs-cases-occt.test.ts,
 *    which runs in the folded-shell CI job so the shared Open CASCADE job stays inside its limit.
 * 5d. A side wall under an open rim, resin defaults: the corner rib built with a sharp root (it stays in this file).
 * 6. The flange table: a tee with a 45° chamfered and a square flange, ribs along X, along Y and at 45°, model_check on a
 *    flat bed and on the 45° belt, against the rule auto-ribs.ts chooses by.
 * The frequency goal is mcp/frequency-occt.test.ts, on the folded-shell job: this file plus those plans did not fit
 * that job's 25 minutes (run 44698889099 reached this file's end at 20 minutes).
 * The planning cases use a 120 × 70 × 25 box: CI's debug engine plans and slices about fifty times slower than a release
 * build, and the 200 × 100 × 30 box took 19 minutes there. LIME_RIBS_FULL=1 runs them on 200 × 100 × 30.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { shellCount } from "../src/mesh-shells.ts";
import { ribWall, type RibWallSolid } from "../src/modeling/rib-wall.ts";
import { flangeUndersides } from "../src/modeling/auto-ribs.ts";
import { posedBounds } from "../src/model-space.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("auto-ribs-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("auto-ribs-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

/** The box the planning cases stand on: outside size, 2 mm walls, open on top; inner floor at z 2. */
const FULL = process.env.LIME_RIBS_FULL === "1";
const [BX, BY, BZ] = FULL ? [200, 100, 30] : [120, 70, 25];
const BOX = `${BX} × ${BY} × ${BZ}`;

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-auto-ribs-"));
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
  modelPose: { m: number[]; t: V3 };
  solid?: { fingerprint: { volumeMm3: number }; volumeMm3: number; positions: Float32Array; triangles: Uint32Array; bounds: { min: V3; max: V3 }; faces: { index: number; kind?: string }[] };
}
const part = (object: string) => (session as unknown as { find(id: string): Held | undefined }).find(object)!;
const held = (object: string) => part(object).solid!;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const timings: string[] = [];
const report: string[] = [];

async function rays(object: string, list: { point: V3; direction: V3 }[]): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (let i = 0; i < list.length; i += 400) {
    const reply = await call("surface_at", { object, rays: list.slice(i, i + 400) });
    for (const hit of (reply.hits ?? []) as Reply[]) out.push(hit.hit === true ? Number(hit.distanceMm) : null);
  }
  return out;
}
const steps = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 0.5)) / n);
/** Rays from beyond the box's outside: under the floor and from each side. */
function outsideRays(box: { min: V3; max: V3 }, sides: ("under" | "x" | "y" | "+x" | "z+")[] = ["under", "x", "y"]): { point: V3; direction: V3 }[] {
  const list: { point: V3; direction: V3 }[] = [];
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  if (sides.includes("under")) for (const x of steps(x0, x1, 41)) for (const y of steps(y0, y1, 23)) list.push({ point: [x, y, z0 - 10], direction: [0, 0, 1] });
  if (sides.includes("x")) for (const y of steps(y0, y1, 15)) for (const z of steps(z0, z1, 9)) list.push({ point: [x0 - 10, y, z], direction: [1, 0, 0] }, { point: [x1 + 10, y, z], direction: [-1, 0, 0] });
  if (sides.includes("y")) for (const x of steps(x0, x1, 25)) for (const z of steps(z0, z1, 9)) list.push({ point: [x, y0 - 10, z], direction: [0, 1, 0] }, { point: [x, y1 + 10, z], direction: [0, -1, 0] });
  if (sides.includes("+x")) for (const y of steps(y0, y1, 31)) for (const z of steps(z0, z1, 15)) list.push({ point: [x1 + 10, y, z], direction: [-1, 0, 0] });
  if (sides.includes("z+")) for (const x of steps(x0, x1, 41)) for (const y of steps(y0, y1, 23)) list.push({ point: [x, y, z1 + 10], direction: [0, 0, -1] });
  return list;
}
async function shift(object: string, list: { point: V3; direction: V3 }[], before: (number | null)[]): Promise<number> {
  const after = await rays(object, list);
  let worst = 0;
  after.forEach((d, i) => {
    const b = before[i];
    if (b === null && d === null) return;
    worst = Math.max(worst, b === null || d === null ? Infinity : Math.abs(d - b!));
  });
  return worst;
}
/** The plan's estimate of what it adds against the volume the kernel measured after apply: within 5 %. */
const volumeRows: string[] = [];
function addedAsPlanned(title: string, done: Reply, applied: Reply) {
  const estimate = Number(done.adds?.mm3);
  const planner = Number(done.adds?.plannerMm3);
  const measured = Number(applied.added?.mm3);
  const off = (x: number) => `${x >= measured ? "+" : ""}${Math.round((1000 * (x - measured)) / measured) / 10} %`;
  volumeRows.push(`${title}: measured ${r3(measured)} mm³; estimate ${estimate} (${off(estimate)}); the planner's own ${planner} (${off(planner)})`);
  check(`${title}: the plan's added volume is the built one within 5 % (estimate ${estimate}, measured ${r3(measured)} mm³)`, measured > 0 && Math.abs(estimate - measured) <= 0.05 * measured, JSON.stringify({ adds: done.adds, added: applied.added, paths: applied.paths, ribNet: applied.ribNet, leftOut: applied.leftOut, leftOutNote: applied.leftOutNote, skipped: applied.skipped, ribs: (done.plan?.ribs as Reply[] | undefined)?.map((rib) => ({ points: rib.points, heights: rib.heights, ends: rib.ends, trimmedMm: rib.trimmedMm })) }));
}
async function historyCount(object: string): Promise<number> {
  return (((await call("model_history", { object })).nodes ?? []) as unknown[]).length;
}

/** Wait for a job, collecting the progress each wait gives. */
async function waitJob(job: string, onRunning?: (reply: Reply) => void | Promise<void>, timeoutS = 2): Promise<Reply> {
  for (;;) {
    const reply = await call("slice_wait", { job, timeoutS });
    if (reply.status !== "running") return reply;
    await onRunning?.(reply);
  }
}

async function shellBox(dx: number, dy: number, dz: number): Promise<string> {
  const object = String((await call("solid_new", { primitive: "box", dx, dy, dz })).object);
  const shelled = await call("model_apply", { object, probe: true, op: { kind: "shell", thickness: 2, openFaces: [{ normal: [0, 0, 1] }] } });
  if (shelled.ok !== true) throw new Error(`shell: ${JSON.stringify(shelled).slice(0, 300)}`);
  return object;
}

// ===== 1. ribWall on the kernel's display meshes. =====
const t8 = Math.tan((8 * Math.PI) / 180);
const s8 = Math.sin((8 * Math.PI) / 180);
const c8 = Math.cos((8 * Math.PI) / 180);
async function slopedShell(): Promise<string> {
  const object = String((await call("solid_new", { primitive: "box", dx: 200, dy: 100, dz: 40 })).object);
  const top: V3 = [100, 0, 100 * t8];
  const centre: V3 = [top[0] + 50 * s8, 0, top[2] - 50 * c8];
  await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", dx: 300, dy: 200, dz: 100, centre, turn: [0, -8, 0] } });
  await call("model_apply", { object, probe: true, op: { kind: "shell", thickness: 2, openFaces: [{ normal: [0, 0, 1] }] } });
  return object;
}
async function filletedShell(): Promise<string> {
  // The inner floor's four edges filleted 6 mm after the shell: the floor runs into the walls through the fillets.
  const object = await shellBox(120, 80, 30);
  const f = await call("model_apply", { object, probe: true, op: { kind: "fillet", edges: { select: { onFace: { normal: [0, 0, 1], nearPoint: [0, 0, 2] } } }, size: 6 } });
  if (f.ok !== true) throw new Error(`fillet: ${JSON.stringify(f).slice(0, 300)}`);
  return object;
}
async function cylinderPanel(): Promise<string> {
  const object = String((await call("solid_new", { primitive: "tube", radius: 80, innerRadius: 78, height: 60 })).object);
  await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "common", primitive: "box", origin: [0, -40, -1], dx: 100, dy: 80, dz: 62 } });
  return object;
}
async function loftedCover(): Promise<string> {
  const object = String((await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 5 })).object);
  const section = (x: number, top: number, half: number, low: number) => ({ origin: [x, 0, 0], turn: [0, 90, 0], profile: [[-low, -half], [-low, half], [-top, half], [-top, -half]] });
  await call("model_apply", { object, probe: true, op: { kind: "loft", op: "fuse", sections: [[-60, 20], [-20, 32], [20, 26], [60, 22]].map(([x, top]) => section(x!, top!, 40, 0)) } });
  await call("model_apply", { object, probe: true, op: { kind: "loft", op: "cut", sections: [[-58, 18.5], [-20, 30], [20, 24], [58, 20]].map(([x, top]) => section(x!, top!, 38, -1)) } });
  return object;
}
async function ribbedShell(): Promise<string> {
  // A shelled box whose floor already carries a rib across it (splitting the floor in two) and a boss on one half.
  const object = await shellBox(120, 70, 25);
  const rib = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", dx: 117, dy: 2, dz: 6, centre: [0, 0, 5] } });
  if (rib.ok !== true) throw new Error(`rib: ${JSON.stringify(rib).slice(0, 300)}`);
  const boss = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "fuse", primitive: "cylinder", radius: 3, height: 8, centre: [-30, -18, 5] } });
  if (boss.ok !== true) throw new Error(`boss: ${JSON.stringify(boss).slice(0, 300)}`);
  return object;
}
const solidOf = (object: string): RibWallSolid => ({ positions: held(object).positions, faceOf: held(object).triangles });
/** The face of the nearest triangle to `p` whose normal is within 30° of `n`. */
function faceAt(object: string, p: V3, n: V3): number {
  const pos = held(object).positions;
  const faceOf = held(object).triangles;
  let best = { d: Infinity, face: -1 };
  for (let t = 0; t * 9 + 8 < pos.length; t += 1) {
    const a = [pos[t * 9]!, pos[t * 9 + 1]!, pos[t * 9 + 2]!];
    const b = [pos[t * 9 + 3]!, pos[t * 9 + 4]!, pos[t * 9 + 5]!];
    const c = [pos[t * 9 + 6]!, pos[t * 9 + 7]!, pos[t * 9 + 8]!];
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const m = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const l = Math.hypot(m[0]!, m[1]!, m[2]!);
    if (!(l > 0) || (m[0]! * n[0] + m[1]! * n[1] + m[2]! * n[2]) / l < Math.cos(Math.PI / 6)) continue;
    const g = [(a[0]! + b[0]! + c[0]!) / 3, (a[1]! + b[1]! + c[1]!) / 3, (a[2]! + b[2]! + c[2]!) / 3];
    const d = Math.hypot(g[0]! - p[0], g[1]! - p[1], g[2]! - p[2]);
    if (d < best.d) best = { d, face: Number(faceOf[t]) };
  }
  return best.face;
}
{
  const cases: { title: string; make: () => Promise<string>; at: V3; n: V3; expect: (rep: Reply, object: string) => string | null }[] = [
    { title: "shelled box 200 × 100 × 30", make: () => shellBox(200, 100, 30), at: [0, 0, 2], n: [0, 0, 1], expect: (rep) => (rep.faces.taken.length === 1 && Math.abs(rep.thickness.medianMm - 2) < 0.05 && rep.loops.length === 1 && rep.loops[0].class === "joined" ? null : "one face, 2 mm, one joined border") },
    { title: "floor turning into an 8° slope", make: slopedShell, at: [-40, 0, 2], n: [0, 0, 1], expect: (rep) => (rep.faces.taken.length === 2 && Math.abs(rep.thickness.medianMm - 2) < 0.1 ? null : "the flat strip and the slope, 2 mm") },
    { title: "shell with filleted inside corners", make: filletedShell, at: [0, 0, 2], n: [0, 0, 1], expect: (rep) => (rep.faces.taken.length > 1 ? null : "the floor grows over its fillets") },
    { title: "cylinder-segment panel R 78 inside", make: cylinderPanel, at: [78, 0, 30], n: [-1, 0, 0], expect: (rep) => (rep.faces.taken.length === 1 && Math.abs(rep.thickness.medianMm - 2) < 0.1 && rep.loops.length === 1 ? null : "one face, 2 mm, one border") },
    { title: "lofted freeform cover", make: loftedCover, at: [0, 0, 26], n: [0, 0, -1], expect: (rep) => (rep.faces.taken.length >= 1 && rep.thickness.medianMm > 1 && rep.thickness.medianMm < 3 ? null : "the roof's inside, about 2 mm") },
    // One click on one half takes the floor on both sides of the rib; the rib and the boss are features, their
    // footprints (116 × 2 and π 3², kernel facets) filled in and not held, one border left.
    { title: "floor already carrying a rib and a boss", make: ribbedShell, at: [30, 18, 2], n: [0, 0, 1], expect: (rep) => (rep.faces.taken.length >= 2 && rep.features.count === 2 && Math.abs(rep.features.footprintMm2 - (116 * 2 + Math.PI * 9)) < 8 && rep.loops.length === 1 && Math.abs(rep.areaMm2 - 116 * 66) < 10 && Math.abs(rep.thickness.medianMm - 2) < 0.05 ? null : `the whole floor, 2 features (${rep.features.count}, ${rep.features.footprintMm2} mm²), one border (${rep.loops.length}), ${rep.areaMm2} mm²`) },
  ];
  for (const row of cases) {
    const object = await row.make();
    const face = faceAt(object, row.at, row.n);
    const t0 = Date.now();
    const wall = ribWall(solidOf(object), { picked: [face] });
    const ms = Date.now() - t0;
    if ("reason" in wall) {
      check(`ribWall reads the ${row.title}`, false, wall.reason);
      continue;
    }
    const rep = wall.report as unknown as Reply;
    const problem = row.expect(rep, object);
    check(`ribWall reads the ${row.title}${problem ? "" : ` (${rep.faces.taken.length} faces, ${rep.triangles} triangles)`}`, problem === null, `${problem}: ${JSON.stringify({ faces: rep.faces, thickness: rep.thickness, loops: rep.loops.map((l: Reply) => [l.class, Math.round(l.lengthMm)]), input: rep.input, warnings: rep.warnings }).slice(0, 900)}`);
    check(`${row.title}: the wall mesh is one edge-manifold piece with no sliver under 15° left past 2 %`, rep.input.nonManifoldEdges === 0 && rep.quality.under15Share < 0.02, JSON.stringify({ input: rep.input, quality: rep.quality }));
    report.push(`${row.title}: kernel ${rep.input.triangles} triangles (degenerate ${rep.input.degenerate}, duplicate ${rep.input.duplicate}, T-junctions ${rep.input.tJunctions}, flipped ${rep.input.flipped}, non-manifold ${rep.input.nonManifoldEdges}), faces ${JSON.stringify(rep.faces.taken)} of picked ${face}, stops ${rep.faces.stops.length}, wall ${rep.triangles} triangles, thickness ${rep.thickness.minMm}/${rep.thickness.medianMm}/${rep.thickness.maxMm} mm (thick ${rep.thickness.thick}, unread ${rep.thickness.unread}), min angle ${rep.quality.minAngleDeg}° (${rep.quality.under15} under 15°), borders ${rep.loops.map((l: Reply) => `${l.class} ${Math.round(l.lengthMm)} mm`).join(", ")}, warnings ${rep.warnings.length}, ${ms} ms`);
  }
}

// ===== 2. The shelled box, defaults, the four actions. =====
// Inner floor z 2, inner walls at x ±(BX/2 − 2), y ±(BY/2 − 2).
let defaultJob = "";
let boxObject = "";
{
  const object = await shellBox(BX, BY, BZ);
  boxObject = object;
  const box = held(object).bounds;
  const outside = outsideRays(box);
  const before = await rays(object, outside);
  // Rays across the cavity above the ribs' greatest height: the side walls must not change.
  const sideRays: { point: V3; direction: V3 }[] = [];
  for (const z of [12, 18, 24]) for (const y of [-30, 0, 30]) sideRays.push({ point: [0, y, z], direction: [1, 0, 0] }, { point: [0, y, z], direction: [-1, 0, 0] });
  for (const z of [12, 18, 24]) for (const x of [-0.3 * BX, 0, 0.3 * BX]) sideRays.push({ point: [x, 0, z], direction: [0, 1, 0] }, { point: [x, 0, z], direction: [0, -1, 0] });
  const sideBefore = await rays(object, sideRays);
  const volume = held(object).volumeMm3;
  const rows = await historyCount(object);
  const t0 = Date.now();
  const started = await call("ribs_plan", { object, wall: { face: { normal: [0, 0, 1], nearPoint: [0, 0, 2] } } });
  check("ribs_plan answers at once with a job", started.ok === true && started.status === "running" && typeof started.job === "string" && Date.now() - t0 < 5000, JSON.stringify(started).slice(0, 400));
  defaultJob = String(started.job);
  // A plan alone does not block other calls.
  const listed = await call("model_history", { object });
  check("a call runs while the plan runs", listed.ok === true, JSON.stringify(listed).slice(0, 200));
  const events: Reply[] = [];
  const fractions: number[] = [];
  const done = await waitJob(defaultJob, (reply) => {
    events.push(...((reply.ribs?.events ?? []) as Reply[]));
    fractions.push(Number(reply.fraction));
  });
  const planMs = Date.now() - t0;
  // Events no running wait read come with the result.
  events.push(...((done.ribs?.events ?? []) as Reply[]));
  check("the plan is done", done.ok === true && done.status === "done", JSON.stringify(done).slice(0, 600));
  const plan = done.plan as Reply;
  const ribEvents = events.filter((e) => e.kind === "rib");
  check(`progress came while it ran: ${events.length} events (${ribEvents.length} rib), fractions rising`, ribEvents.length >= 1 && events.some((e) => e.kind === "stage") && fractions.every((f, i) => i === 0 || f >= fractions[i - 1]! - 1e-9), JSON.stringify({ events: events.slice(0, 3), fractions }).slice(0, 400));
  check("a rib event carries its polyline, heights and the running totals", ribEvents.filter((e) => e.change !== "removed").every((e) => Array.isArray(e.points) && e.points.length >= 2 && Array.isArray(e.heights) && typeof e.ribVolumeMm3 === "number" && typeof e.stiffnessFactor === "number"), JSON.stringify(ribEvents[0] ?? null).slice(0, 300));
  check("the plan has ribs, stiffer than the bare wall", Array.isArray(plan?.ribs) && plan.ribs.length > 0 && plan.stiffnessFactor > 1, JSON.stringify(plan).slice(0, 400));
  check("the wall is the inner floor alone", done.wall.faces.taken.length === 1 && Math.abs(done.wall.thickness.medianMm - 2) < 0.05, JSON.stringify(done.wall.faces));
  check("every rib stands on the floor (z 2)", plan.ribs.every((rib: Reply) => rib.points.every((p: V3) => Math.abs(p[2] - 2) < 0.05)), JSON.stringify(plan.ribs[0]?.points.slice(0, 3)));
  check("the defaults are named: 3 beads wide, 6 mm tall", Math.abs(done.rules.width - 1.35) < 1e-6 && Math.abs(done.rules.maxHeight - 6) < 0.1 && done.rules.defaults.length >= 5, JSON.stringify(done.rules));
  check("the comparisons are there", done.comparisons.thickening && done.comparisons.grid && typeof done.comparisons.notBetterThanBaseline === "boolean", JSON.stringify(done.comparisons).slice(0, 300));
  check("adds names mm³, grams and percent", done.adds.mm3 > 0 && done.adds.grams > 0 && done.adds.percent > 0, JSON.stringify(done.adds));
  report.push(`default plan on the ${BOX} box: ${plan.ribs.length} ribs (${JSON.stringify(plan.profiles)}), +${done.adds.mm3} mm³ / ${done.adds.grams} g / ${done.adds.percent} %, stiffness factor ${plan.stiffnessFactor} (shell, relative), bare ${JSON.stringify(plan.bare)}, ribbed ${JSON.stringify(plan.ribbed)}, thickening ${JSON.stringify(plan.thickening)}, grid ${JSON.stringify(plan.grid)}, notBetterThanBaseline ${plan.notBetterThanBaseline}, plan ${planMs} ms (engine ${JSON.stringify(done.seconds)}), ${events.length} progress events`);
  report.push(`default plan sentence: ${done.sentence}`);
  report.push(`default rules: ${JSON.stringify(done.rules.defaults)}`);
  // Apply.
  const t1 = Date.now();
  let applied = await call("ribs_apply", { job: defaultJob });
  if (applied.status === "running") applied = await waitJob(String(applied.job));
  const applyMs = Date.now() - t1;
  check("ribs_apply builds it", applied.ok === true, JSON.stringify(applied).slice(0, 900));
  check("as one History row", (await historyCount(object)) === rows + 1);
  const moved = await shift(object, outside, before);
  check(`the outside is unchanged (${outside.length} rays from beyond the walls)`, moved < 0.01, `moved ${moved} mm`);
  const sideMoved = await shift(object, sideRays, sideBefore);
  check("ribs only on the floor: the side walls above the ribs are as they were", sideMoved < 0.01, `moved ${sideMoved} mm`);
  check("one shell", shellCount(held(object).positions) === 1);
  const grew = held(object).volumeMm3 - volume;
  check("the reply's added mm³ is the volume change, grams and percent with it", Math.abs(applied.added.mm3 - grew) < 0.05 && applied.added.grams > 0 && applied.added.percent > 0, JSON.stringify(applied.added));
  check("model_check before and after are in the reply", typeof applied.check.before.overhangMm2 === "number" && typeof applied.check.after.overhangMm2 === "number", JSON.stringify(applied.check));
  check("the row keeps the request", JSON.stringify(((await call("model_history", { object })).nodes as Reply[]).at(-1)).includes("Auto ribs"));
  report.push(`default apply: ${applied.paths} paths, ribNet ${JSON.stringify({ runs: applied.ribNet?.runs, ends: applied.ribNet?.ends, profiles: applied.ribNet?.profiles, shortened: applied.ribNet?.shortened?.length ?? 0, skipped: applied.ribNet?.skipped?.length ?? 0 })}, measured +${r3(grew)} mm³ (planned ${done.adds.mm3}), ${applied.added.grams} g, ${applied.added.percent} %, check ${JSON.stringify(applied.check)}, ${applyMs} ms`);
  addedAsPlanned("default plan", done, applied);
  check("every rib end meets a border, a hold or another rib, or is listed with why", (plan.ribs as Reply[]).every((rib, i) => (rib.ends as string[]).every((end, k) => end !== "free" || (plan.looseEnds as Reply[]).some((row) => row.rib === i && row.end === k))), JSON.stringify({ ends: (plan.ribs as Reply[]).map((rib) => rib.ends), loose: plan.looseEnds }));
  timings.push(`default plan ${planMs} ms, apply ${applyMs} ms`);
  const undone = await call("model_undo", { object });
  check("undo removes the row: the volume is back", undone.ok === true && Math.abs(held(object).volumeMm3 - volume) < 1e-6, JSON.stringify(undone).slice(0, 300));
  const stale = await call("model_redo", { object });
  check("redo brings it back", stale.ok === true && held(object).volumeMm3 > volume + 1);
  const again = await call("ribs_apply", { job: defaultJob });
  check("the same plan on the ribbed part is refused as stale", again.ok === false && again.code === "stale-rib-plan", JSON.stringify(again).slice(0, 300));
  // A plan passed whole: its fingerprint is the bare part's, so on the ribbed part it is refused even with no node.
  const { node: _node, ...noNode } = plan;
  const passed = await call("ribs_apply", { object, plan: noNode });
  check("a plan passed without its node is refused by its fingerprint", passed.ok === false && passed.code === "stale-rib-plan" && /not the solid this plan was made for/.test(String(passed.reason)), JSON.stringify(passed).slice(0, 300));
  const { node: _n2, fingerprint: _fp, ...bare } = plan;
  const blind = await call("ribs_apply", { object, plan: bare });
  check("a plan with no fingerprint is refused", blind.ok === false && blind.code === "bad-rib-plan" && /fingerprint/.test(String(blind.reason)), JSON.stringify(blind).slice(0, 300));
  check("the plan carries the solid's fingerprint", typeof plan.fingerprint?.volumeMm3 === "number" && plan.fingerprint.faces > 0 && plan.fingerprint.edges > 0, JSON.stringify(plan.fingerprint));
  const material = done.rules.material as Reply;
  check(`the shell model names its card: ${material.card} (${material.polymer}) for ${material.filament}, ${material.forFilament ? "the filament's own" : "the default standing in"}`, typeof material.card === "string" && typeof material.note === "string" && (material.forFilament ? /library's .* card for/.test(material.note) : /stands in/.test(material.note)) && /relative/.test(material.note), JSON.stringify(material));
  report.push(`material: ${material.note}`);
  await call("model_undo", { object });
}

// ===== 3a. A noRibs box zone in the middle of the floor; a load on a side wall, which the floor cannot carry. =====
{
  const object = await shellBox(BX, BY, BZ);
  const zone = { min: [-30, -20, 0] as V3, max: [30, 20, 40] as V3 };
  const side = faceAt(object, [BX / 2 - 2, 0, BZ / 2], [-1, 0, 0]);
  const missedLoad = { kind: "force", faces: [side], magnitude: 20, direction: [1, 0, 0] };
  // Refused by name, before any planning: never planned under even pressure in the load's place.
  const asked = await call("ribs_plan", { object, wall: { faces: [faceAt(object, [0, 0, 2], [0, 0, 1])] }, loads: [missedLoad] });
  const refused = typeof asked.job === "string" ? await waitJob(asked.job) : asked;
  check("a load that misses the wall: refused, naming it, why and what to do", refused.ok === false && refused.code === "off-wall" && /Load 1: /.test(String(refused.reason)) && /Include the face it is on in the wall/.test(String(refused.reason)) && /ifMissed:"evenPressure"/.test(String(refused.reason)) && refused.missed?.length === 1, JSON.stringify(refused).slice(0, 500));
  // Asked to plan without it: the even pressure, and said first.
  const started = await call("ribs_plan", { object, wall: { faces: [faceAt(object, [0, 0, 2], [0, 0, 1])] }, zones: [{ region: { box: zone }, mode: "noRibs" }], loads: [missedLoad], ifMissed: "evenPressure" });
  const done = await waitJob(String(started.job));
  check("a plan with a noRibs zone", done.ok === true && done.plan.ribs.length > 0, JSON.stringify(done).slice(0, 400));
  check("ifMissed:evenPressure: the plan says first that it ran under even pressure, in notes and the sentence", /^Planned under even pressure instead of the given load: load 1 misses the wall/.test(String(done.sentence)) && done.notes?.[0] === done.wall.substituted?.sentence, JSON.stringify({ sentence: done.sentence, notes: done.notes }).slice(0, 500));
  const landed = done.wall.zones[0] as Reply;
  check("the zone landed on the floor where it is", landed.triangles > 0 && landed.areaMm2 > 0.8 * 60 * 40 && landed.areaMm2 < 1.3 * 60 * 40, JSON.stringify(landed));
  const inside = (p: V3, m: number) => p[0] > zone.min[0] + m && p[0] < zone.max[0] - m && p[1] > zone.min[1] + m && p[1] < zone.max[1] - m;
  check("no planned rib point inside the zone", done.plan.ribs.every((rib: Reply) => rib.points.every((p: V3) => !inside(p, 0.5))), JSON.stringify(done.plan.ribs.map((rib: Reply) => rib.points.filter((p: V3) => inside(p, 0.5)).length)));
  const down: { point: V3; direction: V3 }[] = [];
  for (const x of steps(zone.min[0] + 2, zone.max[0] - 2, 25)) for (const y of steps(zone.min[1] + 2, zone.max[1] - 2, 17)) down.push({ point: [x, y, 40], direction: [0, 0, -1] });
  const applied = await call("ribs_apply", { job: done.job });
  check("it applies", applied.ok === true, JSON.stringify(applied).slice(0, 400));
  const hits = await rays(object, down);
  const high = hits.filter((d) => d === null || Math.abs(d - 38) > 0.01).length;
  check(`no added material inside the zone: ${down.length} rays from above all meet the floor at z 2`, high === 0, `${high} rays met something higher`);
  report.push(`noRibs zone: ${done.plan.ribs.length} ribs, zone ${landed.triangles} triangles ${landed.areaMm2} mm², ${down.length} rays inside, ${high} higher than the floor, ribNet ${JSON.stringify({ ends: applied.ribNet?.ends, shortened: applied.ribNet?.shortened, skipped: applied.ribNet?.skipped })}, looseEnds ${JSON.stringify(done.plan.looseEnds)}, ribs ${JSON.stringify((done.plan.ribs as Reply[]).map((rib) => ({ n: rib.points.length, ends: rib.ends, len: rib.lengthMm, h: rib.height, trimmed: rib.trimmedMm })))}`);
  addedAsPlanned("noRibs zone", done, applied);
}

// ===== 3b. An obstacle object: a 40 × 20 × 10 block standing 4 mm over the floor in the middle. =====
{
  const object = await shellBox(BX, BY, BZ);
  const block = String((await call("solid_new", { primitive: "box", dx: 40, dy: 20, dz: 10 })).object);
  const placed = await call("model_place", { object: block, x: 0, y: 0, z: 6 });
  const bb = posedBounds(held(block).positions, part(block).modelPose as never)!;
  check("the block stands 4 mm over the floor in the middle", placed.ok === true && Math.abs(bb.min[2] - 6) < 0.01 && Math.abs((bb.min[0] + bb.max[0]) / 2) < 0.01, JSON.stringify({ placed: placed.ok, bb }));
  const started = await call("ribs_plan", { object, wall: { face: { normal: [0, 0, 1], nearPoint: [0, 0, 2] } }, zones: [{ region: { obstacle: { object: block, clearanceMm: 1 } } }], rib: { profile: "straight" } });
  const done = await waitJob(String(started.job));
  check("a plan under an obstacle", done.ok === true, JSON.stringify(done).slice(0, 400));
  const landed = done.wall.zones[0] as Reply;
  check("the obstacle capped the floor under it at 3 mm (4 mm gap less 1 mm clearance)", landed.capped > 0 && Math.abs(landed.capMinMm - 3) < 0.05, JSON.stringify(landed));
  const under = (p: V3) => Math.abs(p[0]) < bb.max[0] - 1 && Math.abs(p[1]) < bb.max[1] - 1;
  let underStretches = 0;
  let tallest = 0;
  // A stretch is under the block by its middle: the plan keeps a point only where the height changes or the rib turns.
  for (const rib of done.plan.ribs as Reply[]) {
    for (let k = 0; k + 1 < rib.points.length; k += 1) {
      const a = rib.points[k] as V3;
      const b = rib.points[k + 1] as V3;
      if (!under([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2])) continue;
      underStretches += 1;
      tallest = Math.max(tallest, rib.heights[k]);
    }
  }
  check(`ribs under the block are capped: ${underStretches} stretches, tallest ${r3(tallest)} mm`, underStretches > 0 && tallest <= 3 + 0.05, JSON.stringify({ underStretches, tallest }));
  const applied = await call("ribs_apply", { job: done.job });
  check("the capped plan applies, a straight rib one path through its height change (no runs meeting end to end)", applied.ok === true && applied.paths === done.plan.ribs.length && applied.ribNet?.ends?.joint === 0, JSON.stringify(applied).slice(0, 600));
  const down: { point: V3; direction: V3 }[] = [];
  for (const x of steps(bb.min[0] + 1, bb.max[0] - 1, 41)) for (const y of steps(bb.min[1] + 1, bb.max[1] - 1, 21)) down.push({ point: [x, y, 5.9], direction: [0, 0, -1] });
  const hits = await rays(object, down);
  const top = Math.max(...hits.map((d) => (d === null ? 0 : 5.9 - d)));
  check(`nothing built under the block stands above z 5 (2 + 3): highest ${r3(top)}`, top <= 5 + 0.05, String(top));
  report.push(`obstacle: zone ${JSON.stringify({ capped: landed.capped, capMinMm: landed.capMinMm, how: landed.how })}, ${done.plan.ribs.length} ribs, ${underStretches} stretches under the block, tallest ${r3(tallest)} mm, ${applied.paths} paths applied, highest material under the block z ${r3(top)}`);
  addedAsPlanned("obstacle", done, applied);
}

// ===== 3b'. A height-capped zone with the profile auto: tees where the cap holds the ribs lower, and they print. =====
{
  const object = await shellBox(BX, BY, BZ);
  const zone = { min: [-0.3 * BX, -BY, 0] as V3, max: [0.3 * BX, BY, 40] as V3 };
  const done = await waitJob(String((await call("ribs_plan", { object, wall: { face: { normal: [0, 0, 1], nearPoint: [0, 0, 2] } }, zones: [{ region: { box: zone }, mode: "maxHeight", maxHeightMm: 4.5 }] })).job));
  check("a plan under a 4.5 mm cap", done.ok === true && done.plan.ribs.length > 0, JSON.stringify(done).slice(0, 400));
  const sections = (done.plan.ribs as Reply[]).flatMap((rib) => (rib.sections as Reply[]).map((s, k) => ({ s, h: rib.heights[k] as number })));
  const tees = sections.filter((row) => row.s.profile === "tee");
  check(`auto puts tees only where the cap holds a rib under the greatest height: ${tees.length} of ${sections.length} stretches`, tees.length > 0 && tees.every((row) => row.h < 6 - 1e-6) && sections.filter((row) => row.h >= 6 - 1e-6).every((row) => row.s.profile === "straight"), JSON.stringify(done.plan.profile));
  check("a flat bed's tees have the 46° chamfer", tees.every((row) => row.s.flangeChamferDeg === 46), JSON.stringify(tees[0]?.s));
  const applied = await call("ribs_apply", { job: done.job });
  check("the tees build", applied.ok === true && (applied.ribNet?.profiles?.tee ?? 0) > 0, JSON.stringify(applied).slice(0, 500));
  check("and print on the flat bed: no overhang before or after", applied.check?.before?.overhangMm2 === applied.check?.after?.overhangMm2, JSON.stringify(applied.check));
  addedAsPlanned("4.5 mm capped zone", done, applied);
  report.push(`4.5 mm capped zone, profile auto: ${done.plan.ribs.length} ribs, ${tees.length} of ${sections.length} stretches tee (${JSON.stringify(done.plan.flange)}), plan profile ${JSON.stringify(done.plan.profile)}, ribNet profiles ${JSON.stringify(applied.ribNet?.profiles)}, +${applied.added?.mm3} mm³, check ${JSON.stringify(applied.check)}`);
}

// ===== 3c. Cancel mid-plan: the plan so far comes back and is usable. On the larger box, read every 50 ms: a release
// engine plans the smaller one in under a second. =====
{
  const object = await shellBox(200, 100, 30);
  const started = await call("ribs_plan", { object, wall: { face: { normal: [0, 0, 1], nearPoint: [0, 0, 2] } }, goal: { stiffer: 1000 } });
  let cancelled: Reply | null = null;
  const t0 = Date.now();
  const done = await waitJob(String(started.job), async (reply) => {
    const ribs = ((reply.ribs?.events ?? []) as Reply[]).filter((e) => e.kind === "rib" && e.change === "added");
    if (!cancelled && ribs.length > 0) cancelled = await call("slice_cancel", { job: started.job });
  }, 0.05);
  const ms = Date.now() - t0;
  check("slice_cancel stops the plan", cancelled !== null && (cancelled as Reply).ok === true, JSON.stringify(cancelled).slice(0, 300));
  check("the plan so far comes back, stopped early, with ribs", done.ok === true && done.plan.stoppedEarly === true && done.plan.ribs.length >= 1, JSON.stringify(done).slice(0, 500));
  const applied = await call("ribs_apply", { job: done.job });
  check("and it applies", applied.ok === true, JSON.stringify(applied).slice(0, 300));
  report.push(`cancel: stopped after ${ms} ms with ${done.plan?.ribs?.length} ribs, factor ${done.plan?.stiffnessFactor}, applied ${applied.ok}`);
  addedAsPlanned("cancelled plan", done, applied);
}

// ===== 3d. apply:true in one job; 4. verify:true with the sliced Stress study. =====
{
  const object = await shellBox(BX, BY, BZ);
  const rows = await historyCount(object);
  const started = await call("ribs_plan", { object, wall: { face: { normal: [0, 0, 1], nearPoint: [0, 0, 2] } }, apply: true });
  const blocked = await call("model_check", { object });
  check("a plan that applies keeps the part to itself while it runs", blocked.ok === false && blocked.code === "job-running", JSON.stringify(blocked).slice(0, 200));
  const done = await waitJob(String(started.job));
  check("ribs_plan {apply:true} plans and applies in one job", done.ok === true && done.applied === true && (await historyCount(object)) === rows + 1, JSON.stringify(done.apply ?? done).slice(0, 400));
  await call("model_undo", { object });
  const plan = await waitJob(String((await call("ribs_plan", { object, wall: { face: { normal: [0, 0, 1], nearPoint: [0, 0, 2] } } })).job));
  const t0 = Date.now();
  const verifying = await call("ribs_apply", { job: plan.job, verify: true });
  check("verify answers with a job", verifying.status === "running" && typeof verifying.job === "string", JSON.stringify(verifying).slice(0, 300));
  const verified = await waitJob(String(verifying.job));
  const ms = Date.now() - t0;
  check("verify: the sliced Stress study before and after", verified.ok === true && verified.verify?.before?.maxDisplacementMm > 0 && verified.verify?.after?.maxDisplacementMm > 0, JSON.stringify(verified.verify ?? verified).slice(0, 900));
  check("verify: the ribbed part bends less", verified.verify?.after?.maxDisplacementMm < verified.verify?.before?.maxDisplacementMm, JSON.stringify(verified.verify));
  check("verify: print time and filament of both slices", typeof verified.verify?.before?.slicerSeconds === "number" && typeof verified.verify?.after?.slicerGrams === "number", JSON.stringify(verified.verify));
  report.push(`verify (sliced Stress study, placeholder card, relative): ${JSON.stringify(verified.verify)} in ${ms} ms`);
  timings.push(`verify ${ms} ms`);
}

// ===== 5. A curved wall: the cylinder-segment panel. =====
{
  const object = await cylinderPanel();
  const box = held(object).bounds;
  const outside = outsideRays(box, ["+x"]);
  const before = await rays(object, outside);
  const rows = await historyCount(object);
  const t0 = Date.now();
  const done = await waitJob(String((await call("ribs_plan", { object, wall: { face: { normal: [-1, 0, 0], nearPoint: [78, 0, 30] } } })).job));
  const planMs = Date.now() - t0;
  check("a plan on the curved panel", done.ok === true && done.plan.ribs.length > 0, JSON.stringify(done).slice(0, 500));
  const t1 = Date.now();
  const applied = await call("ribs_apply", { job: done.job });
  check("it applies as one row", applied.ok === true && (await historyCount(object)) === rows + 1, JSON.stringify(applied).slice(0, 500));
  const moved = await shift(object, outside, before);
  check("the panel's outside is unchanged", moved < 0.01, `moved ${moved} mm`);
  report.push(`cylinder panel: ${done.plan?.ribs?.length} ribs ${JSON.stringify(done.plan?.profiles)}, factor ${done.plan?.stiffnessFactor}, +${applied.added?.mm3} mm³ (${applied.added?.percent} %), plan ${planMs} ms, apply ${Date.now() - t1} ms, ribNet ${JSON.stringify({ runs: applied.ribNet?.runs, shortened: applied.ribNet?.shortened?.length ?? 0, skipped: applied.ribNet?.skipped?.length ?? 0 })}`);
  addedAsPlanned("cylinder panel", done, applied);
}

// ===== 5d. A side wall with an open rim, resin defaults: drafted ribs with a root meet the rim at a slant
// in the corners. ribNet refused the whole plan there (the root's footprint ran off the rim) until the ends were drawn
// back for the footprint, or the rib built with a sharp root. =====
{
  for (const process of ["resin"] as const) {
    const object = await shellBox(BX, BY, BZ);
    const t0 = Date.now();
    const done = await waitJob(String((await call("ribs_plan", { object, wall: { face: { normal: [-1, 0, 0], nearPoint: [BX / 2 - 2, 0, BZ / 2] } }, process })).job));
    check(`${process}: a default plan on the side wall under the open rim`, done.ok === true && done.plan.ribs.length > 0 && (done.plan.ribs as Reply[]).every((rib) => rib.profile === "drafted"), JSON.stringify(done).slice(0, 400));
    const applied = await call("ribs_apply", { job: done.job });
    check(`${process}: ribs_apply builds the app's own plan`, applied.ok === true, JSON.stringify(applied).slice(0, 600));
    const why = (done.plan.ribs as Reply[]).map((rib) => String(rib.why));
    // On the 120 × 70 × 25 box, resin's corner rib meets the rim too flat for its root's foot within 4 mm.
    if (!FULL && process === "resin") check("resin: the corner rib is built with a sharp root, and says so", why.some((s) => /built with a sharp root/.test(s)) && (done.plan.ribs as Reply[]).some((rib) => (rib.sections as Reply[]).every((s) => s.rootRadius === 0)), JSON.stringify(why));
    report.push(`side wall under the open rim, ${process}: ${done.plan?.ribs?.length} ribs, trimmed ${JSON.stringify((done.plan?.ribs as Reply[] | undefined)?.map((rib) => rib.trimmedMm ?? null))}, applied ${applied.ok} +${applied.added?.mm3} mm³, ${Date.now() - t0} ms`);
  }
}

// ===== 6. The flange table: tees with a 45° chamfered and a square flange, along X, along Y and at 45°. =====
const flangeRows: Reply[] = [];
{
  const w = 1.35;
  const h = 6;
  const dirs: Record<string, V3[][]> = {
    "along X": [-20, 0, 20].map((y) => [[-58, y, 2], [58, y, 2]] as V3[]),
    "along Y": [-30, 0, 30].map((x) => [[x, -38, 2], [x, 38, 2]] as V3[]),
    "at 45°": [-30, 0, 30].map((x) => [[x - 25, -25, 2], [x + 25, 25, 2]] as V3[]),
  };
  const boxes: { dir: string; flange: string; object: string; plain: string }[] = [];
  const flatPrinter = session.library.printerId;
  const flatFilament = session.library.filamentId;
  for (const [dir, paths] of Object.entries(dirs)) {
    for (const [flange, chamfer] of [["45° chamfer", 45], ["46° chamfer", 46], ["square", 0]] as const) {
      const object = await shellBox(120, 80, 30);
      const done = await call("model_apply", { object, op: { kind: "ribNet", width: w, height: h, profile: "tee", flangeChamferDeg: chamfer, taper: 0, paths: paths.map((points) => ({ points })) } });
      check(`tee, ${flange}, ${dir}: built`, done.ok === true, JSON.stringify(done).slice(0, 300));
      const plain = await shellBox(120, 80, 30);
      await call("model_apply", { object: plain, op: { kind: "ribNet", width: w, height: h, taper: 0, paths: paths.map((points) => ({ points })) } });
      boxes.push({ dir, flange, object, plain });
    }
  }
  const read = async (title: string, build: V3) => {
    for (const row of boxes) {
      const tee = await call("model_check", { object: row.object });
      const plain = await call("model_check", { object: row.plain });
      const extra = Number(tee.overhang?.areaMm2 ?? NaN) - Number(plain.overhang?.areaMm2 ?? NaN);
      const d = dirs[row.dir]![0]!;
      const unitDir = (() => { const v = [d[1]![0] - d[0]![0], d[1]![1] - d[0]![1], 0]; const l = Math.hypot(v[0]!, v[1]!); return [v[0]! / l, v[1]! / l, 0] as V3; })();
      const rule = flangeUndersides([[0, 0, 0], unitDir], [[0, 0, 1], [0, 0, 1]], build);
      const predicted = row.flange === "square" ? rule.square : row.flange.startsWith("45") ? rule.chamfer : flangeUndersides([[0, 0, 0], unitDir], [[0, 0, 1], [0, 0, 1]], build, 46).chamfer;
      flangeRows.push({ printer: title, dir: row.dir, flange: row.flange, extraOverhangMm2: r3(extra), prints: extra < 1, rule: predicted });
    }
  };
  await read("flat bed", [0, 0, 1]);
  const belt = await call("machine_select", { printerId: "ideaformer-ir3-v2", filamentId: "lime-petg" });
  check("the belt printer is selected", belt.ok === true, JSON.stringify(belt).slice(0, 200));
  if (belt.ok === true) await read("45° belt", [0, -Math.SQRT1_2, Math.SQRT1_2]);
  for (const row of flangeRows) (row.flange.startsWith("45") ? (name: string, ok: boolean) => console.log(`  ${ok ? "agrees" : "DIFFERS"}: ${name}`) : check)(`flange table, ${row.printer}, ${row.dir}, ${row.flange}: model_check ${row.prints ? "prints" : `adds ${row.extraOverhangMm2} mm² overhang`}, the rule says ${row.rule ? "prints" : "does not"}`, row.prints === row.rule, JSON.stringify(row));
  // Back to a flat printer for anything after.
  await call("machine_select", { printerId: flatPrinter, filamentId: flatFilament });
}

console.log("  --- flange table: extra overhang of three 116 mm tee ribs (w 1.35, h 6) over the same straight ribs, mm² ---");
for (const row of flangeRows) console.log(`  ${row.printer.padEnd(9)} ${row.dir.padEnd(8)} ${row.flange.padEnd(12)} ${String(row.extraOverhangMm2).padStart(9)}  ${row.prints ? "prints" : "overhang"} (rule: ${row.rule ? "prints" : "overhang"})`);
for (const line of report) console.log(`  ${line}`);
for (const line of timings) console.log(`  timing: ${line}`);
for (const line of volumeRows) console.log(`  added volume, ${line}`);
void boxObject;
rmSync(workspace, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("auto-ribs-occt: ok");
process.exit(0);
