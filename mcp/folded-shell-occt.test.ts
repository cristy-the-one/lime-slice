/**
 * Folded walls through ribs_plan against real Open CASCADE (docs/plan-folded-shell.md).
 * Synthetic cover and open box only. Skips without LIME_OCCT_BRIDGE; fails in CI when it is unset.
 * The shell and the Stress study share the filament card's E and ν, the study made isotropic.
 * The study is sliced: the smear solver only meshes a generated beam, and refuses any other solid as open.
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
    console.error("folded-shell-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("folded-shell-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-folded-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "180";

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
  solid?: { volumeMm3: number; positions: Float32Array; triangles: Uint32Array };
}
const held = (object: string) => (session as unknown as { find(id: string): Held | undefined }).find(object)!.solid!;
const report: string[] = [];
const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

async function waitJob(job: string): Promise<Reply> {
  for (;;) {
    const reply = await call("slice_wait", { job, timeoutS: 2 });
    if (reply.status !== "running") return reply;
  }
}

async function fuse(object: string, op: Reply) {
  const reply = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "fuse", ...op } });
  if (reply.ok !== true) throw new Error(`fuse: ${JSON.stringify(reply).slice(0, 400)}`);
}

/** The study cover, centred: belly 80 × 48 × 2, walls 12 tall, rim 6 mm out at z 12. Volume 16992 mm³. */
async function cover(): Promise<string> {
  const object = String((await call("solid_new", { primitive: "box", dx: 80, dy: 48, dz: 2 })).object);
  const blocks = [
    { primitive: "box", origin: [-40, -24, 2], dx: 2, dy: 48, dz: 12 },
    { primitive: "box", origin: [38, -24, 2], dx: 2, dy: 48, dz: 12 },
    { primitive: "box", origin: [-38, -24, 2], dx: 76, dy: 2, dz: 12 },
    { primitive: "box", origin: [-38, 22, 2], dx: 76, dy: 2, dz: 12 },
    { primitive: "box", origin: [-46, -30, 12], dx: 6, dy: 60, dz: 2 },
    { primitive: "box", origin: [40, -30, 12], dx: 6, dy: 60, dz: 2 },
    { primitive: "box", origin: [-40, -30, 12], dx: 80, dy: 6, dz: 2 },
    { primitive: "box", origin: [-40, 24, 12], dx: 80, dy: 6, dz: 2 },
  ];
  for (const op of blocks) await fuse(object, op);
  return object;
}

/** Open box 100 × 60 × 30, walls 2 mm. Volume 29472 mm³. Inner floor at z 2. */
async function openBox(): Promise<string> {
  const object = String((await call("solid_new", { primitive: "box", dx: 100, dy: 60, dz: 30 })).object);
  const shelled = await call("model_apply", { object, probe: true, op: { kind: "shell", thickness: 2, openFaces: [{ normal: [0, 0, 1] }] } });
  if (shelled.ok !== true) throw new Error(`shell: ${JSON.stringify(shelled).slice(0, 400)}`);
  return object;
}

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

function facesWhere(object: string, pred: (n: V3, g: V3) => boolean): number[] {
  const pos = held(object).positions;
  const faceOf = held(object).triangles;
  const seen = new Set<number>();
  for (let t = 0; t * 9 + 8 < pos.length; t += 1) {
    const a = [pos[t * 9]!, pos[t * 9 + 1]!, pos[t * 9 + 2]!];
    const b = [pos[t * 9 + 3]!, pos[t * 9 + 4]!, pos[t * 9 + 5]!];
    const c = [pos[t * 9 + 6]!, pos[t * 9 + 7]!, pos[t * 9 + 8]!];
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const m = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const l = Math.hypot(m[0]!, m[1]!, m[2]!);
    if (!(l > 0)) continue;
    const n: V3 = [m[0]! / l, m[1]! / l, m[2]! / l];
    const g: V3 = [(a[0]! + b[0]! + c[0]!) / 3, (a[1]! + b[1]! + c[1]!) / 3, (a[2]! + b[2]! + c[2]!) / 3];
    if (pred(n, g)) seen.add(Number(faceOf[t]));
  }
  return [...seen];
}

function holdsOf(faces: number[]): { kind: "faces"; faces: number[] }[] {
  const holds: { kind: "faces"; faces: number[] }[] = [];
  for (let i = 0; i < faces.length && holds.length < 8; i += 8) holds.push({ kind: "faces", faces: faces.slice(i, i + 8) });
  return holds;
}

const pressure = (floor: number) => [{ kind: "pressure" as const, faces: [floor], magnitude: 0.01, direction: [0, 0, -1] }];
const rib = { width: 1.5, maxHeight: 4, minSpacing: 12, minLength: 8, profile: "straight" as const };

async function plan(object: string, floor: number, tops: number[], folded: boolean, full: boolean, features = true, hold = true): Promise<Reply> {
  const args: Reply = {
    object,
    wall: { faces: [floor], ...(folded ? { folded: true } : {}), ...(features ? {} : { features: false }) },
    loads: pressure(floor),
    baselines: false,
    ...(full ? { rib } : { goal: { budgetMm3: 1 } }),
    ...(folded && hold && tops.length ? { holds: holdsOf(tops) } : {}),
  };
  const started = await call("ribs_plan", args);
  if (started.ok !== true || typeof started.job !== "string") return started;
  return waitJob(started.job);
}

function bareMm(done: Reply): number {
  const value = done.plan?.bare?.maxDeflectionMm;
  return typeof value === "number" ? value : NaN;
}

/** Rib length on the belly (z under 4), on a wall, and on a rim outboard of the walls. */
function split(ribs: Reply[], kind: "cover" | "box") {
  let belly = 0;
  let wall = 0;
  let rim = 0;
  for (const row of ribs) {
    const pts = (row.points ?? []) as number[][];
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const len = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
      const z = (a[2]! + b[2]!) / 2;
      const x = (a[0]! + b[0]!) / 2;
      const y = (a[1]! + b[1]!) / 2;
      const outboard = kind === "cover" && (Math.abs(x) > 41 || Math.abs(y) > 25);
      if (outboard) rim += len;
      else if (z < 4) belly += len;
      else if (kind === "box" && z > 28) rim += len;
      else wall += len;
    }
  }
  const total = belly + wall + rim;
  const pct = (n: number) => (total > 0 ? Math.round((1000 * n) / total) / 10 : 0);
  return { total, belly: pct(belly), wall: pct(wall), rim: pct(rim) };
}

async function solidMax(object: string, floor: number, tops: number[], e: number, nu: number): Promise<Reply> {
  // Six walls and solid infill fill a 2 mm section, so the print is the solid rather than a sparse one.
  const set = await call("settings_set", { object, values: { infill: 1, walls: 6 } });
  if (set.ok !== true) return set;
  const setup = await call("sim_setup", {
    object,
    representation: "sliced",
    hMm: 2,
    fixtures: holdsOf(tops),
    loads: pressure(floor),
    card: { isotropic: true, EInPlaneMPa: e, EAcrossLayersMPa: e, nu },
  });
  if (setup.ok !== true) return setup;
  return call("sim_run", { object, checkResolution: false });
}

{
  // The schema refuses this before the handler, and the session throws that refusal rather than returning it.
  let reason = "";
  try {
    const bad = await call("ribs_plan", { wall: { folded: "yes" } });
    reason = String(bad.reason ?? "");
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  check("a non-boolean wall.folded is refused", /true or false/.test(reason), reason.slice(0, 300));
}

let material = { e: 1800, nu: 0.35 };

async function compare(title: string, object: string, kind: "cover" | "box", volumeMm3: number) {
  const volume = Math.abs(held(object).volumeMm3);
  check(`${title}: volume ${r1(volume)} mm³`, Math.abs(volume - volumeMm3) < volumeMm3 * 0.001, `expected ${volumeMm3}`);
  const floor = faceAt(object, [0, 0, 2], [0, 0, 1]);
  const tops = facesWhere(object, (n, g) => n[2] > 0.9 && g[2] > (kind === "cover" ? 12 : 28));
  check(`${title}: the floor and the top rim are faces`, floor >= 0 && tops.length > 0, `floor ${floor}, tops ${tops.length}`);
  const off = await plan(object, floor, tops, false, false);
  let on = await plan(object, floor, tops, true, true);
  if (on.ok !== true && on.code === "off-wall") on = await plan(object, floor, tops, true, true, true, false);
  check(`${title}: folded false plans`, off.ok === true && off.wall?.faces?.folded === undefined, JSON.stringify(off.reason ?? off.wall?.faces).slice(0, 400));
  check(`${title}: folded true takes the side walls and says why growth stopped`, on.ok === true && (on.wall?.faces?.folded?.length ?? 0) >= 4 && (on.wall?.faces?.stops ?? []).every((row: Reply) => row.why === "kink" || row.why === "thick" || row.why === "fold-back"), JSON.stringify(on.reason ?? on.wall?.faces).slice(0, 500));
  if (on.ok === true && title === "cover") {
    const again = await waitJob(String((await call("ribs_plan", { ...on.plan.request, goal: { budgetMm3: 1 }, baselines: false })).job));
    check("re-plan keeps wall.folded and the walls", again.ok === true && again.plan?.request?.wall?.folded === true && (again.wall?.faces?.folded?.length ?? 0) >= 4, JSON.stringify(again.reason ?? again.plan?.request?.wall).slice(0, 300));
    const row = on.rules?.material ?? {};
    if (typeof row.eMPa === "number" && typeof row.nu === "number") material = { e: row.eMPa, nu: row.nu };
  }
  const solid = await solidMax(object, floor, tops, material.e, material.nu);
  const shellOn = bareMm(on);
  const shellOff = bareMm(off);
  const solidW = typeof solid.maxDisplacementMm === "number" ? solid.maxDisplacementMm : NaN;
  const err = (shell: number) => (100 * (shell - solidW)) / solidW;
  report.push(`${title}: folded true ${r3(shellOn)} mm (${r1(err(shellOn))} %), folded false ${r3(shellOff)} mm (${r1(err(shellOff))} %), sliced study ${r3(solidW)} mm, E ${material.e} ν ${material.nu}`);
  check(`${title}: the sliced study solved`, solid.ok === true && solidW > 0, JSON.stringify({ reason: solid.reason, trust: solid.trust, representation: solid.representation }).slice(0, 400));
  check(`${title}: folded true is within 10 % of the solid`, solidW > 0 && Math.abs(err(shellOn)) <= 10, `${r1(err(shellOn))} % (shell ${r3(shellOn)}, solid ${r3(solidW)})`);
  check(`${title}: folded false is more than 10 % too stiff`, solidW > 0 && err(shellOff) < -10, `${r1(err(shellOff))} % (shell ${r3(shellOff)}, solid ${r3(solidW)})`);
  if (on.ok === true) {
    const ribs = (on.plan?.ribs ?? []) as Reply[];
    const lengths = split(ribs, kind);
    const line = `${title} plan: ${ribs.length} ribs, factor ${on.plan?.stiffnessFactor}, planner ${on.adds?.plannerMm3} mm³, built ${on.adds?.mm3} mm³, width ${on.rules?.width} mm, length belly ${lengths.belly} % wall ${lengths.wall} % rim ${lengths.rim} % (${r1(lengths.total)} mm)`;
    report.push(line);
    check(`${title}: the plan has ribs`, ribs.length > 0 && Number(on.plan?.stiffnessFactor) > 1 && Number(on.adds?.plannerMm3) > 0, line);
  }
}

await compare("cover", await cover(), "cover", 16992);
await compare("box", await openBox(), "box", 29472);

{
  const object = await cover();
  await fuse(object, { primitive: "cylinder", origin: [0, 0, -6], radius: 8, height: 6.05 });
  const floor = faceAt(object, [0, 0, 2], [0, 0, 1]);
  const tops = facesWhere(object, (n, g) => n[2] > 0.9 && g[2] > 12);
  let folded = await plan(object, floor, tops, true, false);
  if (folded.ok !== true && folded.code === "off-wall") folded = await plan(object, floor, tops, true, false, true, false);
  const capped = await plan(object, floor, tops, false, false, false);
  const real = (folded.wall?.patches ?? []) as Reply[];
  const thick = real.filter((row) => Number(row.thicknessMm) > 7);
  check("boss: folded keeps a patch over 7 mm", folded.ok === true && Number(folded.wall?.thickness?.maxMm) > 7 && thick.length > 0, JSON.stringify({ max: folded.wall?.thickness, patches: real, reason: folded.reason }).slice(0, 500));
  check("boss: the pad is a plate, not a rigid lump", thick.some((row) => row.rigid === false), JSON.stringify(thick).slice(0, 400));
  const capMax = Number(capped.wall?.thickness?.maxMm);
  check("boss: without folded the old cap is about 6 mm", capped.ok === true && capMax > 5.5 && capMax < 6.5 && capped.wall?.patches === undefined, JSON.stringify(capped.wall?.thickness ?? capped.reason).slice(0, 300));
  const solid = await solidMax(object, floor, tops, material.e, material.nu);
  const solidW = typeof solid.maxDisplacementMm === "number" ? solid.maxDisplacementMm : NaN;
  const on = bareMm(folded);
  const off = bareMm(capped);
  const err = (shell: number) => (100 * (shell - solidW)) / solidW;
  report.push(`boss: folded patch ${r3(on)} mm (${r1(err(on))} %), 3× cap ${r3(off)} mm (${r1(err(off))} %), solid max ${r3(solidW)} mm at ${((solid.maxDisplacementAt ?? []) as number[]).map((n) => r1(n)).join(",")}, thickness folded ${folded.wall?.thickness?.maxMm} cap ${capMax}`);
  check("boss: both shell deflections and the solid were measured", solid.ok === true && on > 0 && off > 0, `folded ${r3(on)}, cap ${r3(off)}, solid ${r3(solidW)} (${solid.reason ?? ""})`);
}

console.log("  --- folded shell ---");
for (const line of report) console.log(`  ${line}`);
console.log("  C1 cover, hand mesh, for scale: 3 ribs, ×2.251, 1372 mm³, length 62 % belly, 25 % wall, 13 % rim. The study: folded +6.1 % cover and +2.7 % box, one wall −28 %.");
rmSync(workspace, { recursive: true, force: true });
if (failed > 0) {
  console.error(`folded-shell-occt: ${failed} failed`);
  process.exit(1);
}
console.log("folded-shell-occt: ok");
process.exit(0);
