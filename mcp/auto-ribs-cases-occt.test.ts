/**
 * Auto ribs with load cases, end to end through the MCP server against real Open CASCADE and the release engine's rib
 * planner, on synthetic solids only. Sections 5b and 5c of mcp/auto-ribs-occt.test.ts, moved here unchanged so they
 * run in the "Auto ribs against real Open CASCADE" CI job and the shared Open CASCADE job stays inside its limit.
 *
 * 5b. Two load cases on a shelled box: a case whose loads all miss is refused by its name; per-case factors and
 *     deflections; the plan applies; the stored request re-plans the same ribs and the same factors.
 * 5c. ribs_apply {verify:true} with two load cases on a 64 × 40 × 14 box: each case before and after.
 * The box is 120 × 70 × 25 (LIME_RIBS_FULL=1: 200 × 100 × 30), as in auto-ribs-occt.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("auto-ribs-cases-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("auto-ribs-cases-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

/** The box the planning cases stand on: outside size, 2 mm walls, open on top; inner floor at z 2. */
const FULL = process.env.LIME_RIBS_FULL === "1";
const [BX, BY, BZ] = FULL ? [200, 100, 30] : [120, 70, 25];
const BOX = `${BX} × ${BY} × ${BZ}`;

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-auto-ribs-cases-"));
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
  solid?: { positions: Float32Array; triangles: Uint32Array };
}
const part = (object: string) => (session as unknown as { find(id: string): Held | undefined }).find(object)!;
const held = (object: string) => part(object).solid!;
const timings: string[] = [];
const report: string[] = [];

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

const started = Date.now();

// ===== 5b. Two load cases: per-case factors, and the stored request re-plans the same ribs. =====
// verify:true for two cases is four sliced studies. Section 4 already times the one-case study, and a second
// study on top of it pushed this job past its 25 minutes, so the per-case study is not run again here.
{
  const pressure = { kind: "pressure", faces: [] as number[], magnitude: 0.01, direction: [0, 0, -1] };
  const point = { kind: "force", region: { sphere: { centre: [0, 0, 2], radiusMm: 12 } }, magnitude: 30, direction: [0, 0, -1] };
  const object = await shellBox(BX, BY, BZ);
  const floor = faceAt(object, [0, 0, 2], [0, 0, 1]);
  pressure.faces = [floor];
  const side = faceAt(object, [BX / 2 - 2, 0, BZ / 2], [-1, 0, 0]);
  const missed = await call("ribs_plan", { object, wall: { faces: [floor] }, loadCases: [{ name: "spread", loads: [pressure] }, { name: "sideways", loads: [{ kind: "force", faces: [side], magnitude: 20, direction: [1, 0, 0] }] }] });
  const missedDone = typeof missed.job === "string" ? await waitJob(missed.job) : missed;
  check("a case whose loads all miss: refused, named by its case", missedDone.ok === false && missedDone.code === "off-wall" && /sideways/.test(String(missedDone.reason)), JSON.stringify(missedDone).slice(0, 400));
  const loadCases = [{ name: "spread", loads: [pressure] }, { name: "point", weight: 2, loads: [point] }];
  const args = { object, wall: { faces: [floor] }, loadCases, goal: { budgetMm3: 2000 }, baselines: false };
  const done = await waitJob(String((await call("ribs_plan", args)).job));
  const cases = done.plan?.cases as Reply[];
  check("two cases: each named, with its factor and its bare and ribbed deflection", done.ok === true && cases?.length === 2 && cases[0]?.name === "spread" && cases[1]?.name === "point" && cases[1]?.weight === 2 && cases.every((c: Reply) => typeof c.factor === "number" && c.factor > 1 && c.bare?.deflectionMm > 0 && c.ribbed?.deflectionMm > 0 && c.ribbed.deflectionMm < c.bare.deflectionMm), JSON.stringify(cases));
  const ribKey = (ribs: Reply[]) => JSON.stringify(ribs.map((rb) => ({ points: rb.points, heights: rb.heights, family: rb.family })));
  const firstRibs = ribKey(done.plan.ribs);
  const firstFactors = cases.map((c: Reply) => c.factor as number);
  const applied = await call("ribs_apply", { job: done.job });
  check("two cases: the plan applies", applied.ok === true, JSON.stringify(applied).slice(0, 300));
  await call("model_undo", { object });
  const again = await waitJob(String((await call("ribs_plan", done.plan.request)).job));
  const againCases = again.plan?.cases as Reply[];
  check("re-planning the stored request repeats the ribs", again.ok === true && ribKey(again.plan.ribs) === firstRibs, `first ${done.plan.ribs.length}, again ${again.plan?.ribs?.length}`);
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);
  check("two cases: the factors match a fresh solve of the same ribs within 1e-6", againCases?.length === 2 && againCases.every((c: Reply, i: number) => rel(c.factor, firstFactors[i]!) <= 1e-6), JSON.stringify({ first: firstFactors, again: againCases?.map((c: Reply) => c.factor) }));
  report.push(`two cases on the ${BOX} box: ${cases.map((c: Reply) => `${c.name} w${c.weight} ×${c.factor} (bare ${c.bare.deflectionMm} → ribbed ${c.ribbed.deflectionMm} mm)`).join("; ")}; combined ×${done.plan.stiffnessFactor}`);
}

// ===== 5c. ribs_apply {verify:true} with two load cases. A 64 × 40 × 14 box: four sliced studies on the
// 120 × 70 box would run this job past its 25 minutes (the one-case study there took about 200 s).
// The point load is a 20 N force in a box over the middle of the inner floor. A sphere centred on that
// face (z 2) also covers the outer bottom. The verify study reads the stored place back; if that read
// drops it, the sliced study loads a sliver at the part's max X and the floor barely moves. =====
{
  const [sx, sy, sz] = [64, 40, 14];
  const object = await shellBox(sx, sy, sz);
  const floor = faceAt(object, [0, 0, 2], [0, 0, 1]);
  // Inner floor at z 2, outer bottom at z 0, walls about 18 mm off the middle. The box takes the inner face only.
  const pointBox = { min: [-12, -10, 1.2], max: [12, 10, 3.2] };
  const pointForce = [0, 0, -20];
  const loadCases = [
    { name: "spread", loads: [{ kind: "pressure", faces: [floor], magnitude: 0.01, direction: [0, 0, -1] }] },
    { name: "point", weight: 2, loads: [{ kind: "force", region: { box: pointBox }, magnitude: 20, direction: [0, 0, -1] }] },
  ];
  const pos = held(object).positions;
  const faceOf = held(object).triangles;
  const byFace = new Map<number, { area: number; triangles: number }>();
  for (let t = 0; t * 9 + 8 < pos.length; t += 1) {
    const corner = (k: number) => [pos[t * 9 + k]!, pos[t * 9 + k + 1]!, pos[t * 9 + k + 2]!] as V3;
    const a = corner(0);
    const b = corner(3);
    const c = corner(6);
    const g = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    if (g.some((v, k) => v < pointBox.min[k]! || v > pointBox.max[k]!)) continue;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const area = Math.hypot(cross[0]!, cross[1]!, cross[2]!) / 2;
    const face = Number(faceOf[t]);
    const row = byFace.get(face) ?? { area: 0, triangles: 0 };
    row.area += area;
    row.triangles += 1;
    byFace.set(face, row);
  }
  const landed = [...byFace.entries()].map(([face, row]) => ({ face, areaMm2: Math.round(row.area * 100) / 100, triangles: row.triangles })).sort((p, q) => q.areaMm2 - p.areaMm2);
  const planned = await waitJob(String((await call("ribs_plan", { object, wall: { faces: [floor] }, loadCases, goal: { budgetMm3: 600 }, baselines: false })).job));
  const planCases = planned.plan?.cases as Reply[] | undefined;
  const wallCases = planned.wall?.cases as Reply[] | undefined;
  const pointWall = wallCases?.find((c) => c.name === "point");
  report.push(`point load on ${sx} × ${sy} × ${sz}: force [${pointForce.join(", ")}] N, box ${JSON.stringify(pointBox)}, faces ${JSON.stringify(landed)}, wall ${JSON.stringify(pointWall?.loads ?? null)}, plan ${JSON.stringify(planCases?.map((c) => ({ name: c.name, factor: c.factor, bare: c.bare?.deflectionMm, ribbed: c.ribbed?.deflectionMm })))}`);
  check("two-case verify: the plan has ribs", planned.ok === true && planned.plan?.ribs?.length > 0, JSON.stringify(planned).slice(0, 400));
  check("two-case verify: the point load lands on the floor", landed[0]?.face === floor && landed[0]!.areaMm2 > 50 && pointWall?.loads?.[0]?.how === "on the wall" && pointWall.loads[0].share >= 0.9, JSON.stringify({ floor, landed, how: pointWall?.loads }));
  const planSpread = planCases?.find((c) => c.name === "spread");
  const planPoint = planCases?.find((c) => c.name === "point");
  check("two-case verify: the point case bends the floor in the plan", typeof planPoint?.bare?.deflectionMm === "number" && planPoint.bare.deflectionMm > (planSpread?.bare?.deflectionMm ?? 0) * 0.25, JSON.stringify(planCases));
  const t0 = Date.now();
  const verifying = await call("ribs_apply", { job: planned.job, verify: true });
  const verified = await waitJob(String(verifying.job));
  const ms = Date.now() - t0;
  const rows = verified.verify?.cases as Reply[] | undefined;
  check("two-case verify: each case has a before and an after", verified.ok === true && rows?.length === 2 && rows.every((c) => typeof c.name === "string" && c.before?.maxDisplacementMm > 0 && c.after?.maxDisplacementMm > 0), JSON.stringify(verified.verify ?? verified).slice(0, 900));
  check("two-case verify: the ribbed part is stiffer for each case", !!rows && rows.every((c) => c.after.maxDisplacementMm < c.before.maxDisplacementMm), JSON.stringify(rows?.map((c) => ({ name: c.name, before: c.before?.maxDisplacementMm, after: c.after?.maxDisplacementMm, stiffer: c.stiffer }))));
  const sameWay = (plan: number, got: number) => {
    const a = plan - 1;
    const b = got - 1;
    return Math.abs(a) < 0.02 && Math.abs(b) < 0.02 ? true : a * b > 0;
  };
  check("two-case verify: each case's factor is in the same direction as the plan", !!rows && !!planCases && rows.every((c) => {
    const plan = planCases.find((p) => p.name === c.name);
    return typeof plan?.factor === "number" && typeof c.stiffer === "number" && sameWay(plan.factor, c.stiffer);
  }), JSON.stringify({ plan: planCases?.map((c) => ({ name: c.name, factor: c.factor })), verify: rows?.map((c) => ({ name: c.name, stiffer: c.stiffer })) }));
  const verifySpread = rows?.find((c) => c.name === "spread");
  const verifyPoint = rows?.find((c) => c.name === "point");
  check("two-case verify: the point case bends the floor", typeof verifyPoint?.before?.maxDisplacementMm === "number" && verifyPoint.before.maxDisplacementMm > (verifySpread?.before?.maxDisplacementMm ?? 0) * 0.25, JSON.stringify(rows?.map((c) => ({ name: c.name, before: c.before?.maxDisplacementMm }))));
  report.push(`verify two cases on ${sx} × ${sy} × ${sz}: ${(rows ?? []).map((c) => `${c.name} ${c.before.maxDisplacementMm} → ${c.after.maxDisplacementMm} mm (${c.stiffer}×)`).join("; ")} in ${ms} ms (reported ${verified.verify?.seconds} s)`);
  timings.push(`verify two cases ${ms} ms`);
}

for (const line of report) console.log(`  ${line}`);
for (const line of timings) console.log(`  timing: ${line}`);
console.log(`  timing: whole file ${Date.now() - started} ms`);
rmSync(workspace, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("auto-ribs-cases-occt: ok");
process.exit(0);
