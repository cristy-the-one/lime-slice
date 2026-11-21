/**
 * A buckling goal through ribs_plan, against real Open CASCADE and the engine, on a synthetic shelled box.
 * The reply's load factor before and after, the refusals, a named case, a wall that already holds, and ribs_apply with and without verify.
 * It runs on the Auto ribs Open CASCADE job: a buckling plan eigen-solves many times.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker, ProtocolError } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("buckling-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("buckling-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-buckling-"));
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
const held = (object: string) => (session as unknown as { find(id: string): Held | undefined }).find(object)!.solid!;
const report: string[] = [];

async function waitJob(job: string): Promise<Reply> {
  for (;;) {
    const reply = await call("slice_wait", { job, timeoutS: 2 });
    if (reply.status !== "running") return reply;
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

const [BX, BY, BZ] = [64, 40, 14];
const object = await shellBox(BX, BY, BZ);
const floor = faceAt(object, [0, 0, 2], [0, 0, 1]);
const wall = { faces: [floor] };
const MILD_N = 40;
const ASKED = 1.5;
const edgeForce = (magnitude: number) => ({ kind: "force", faces: [floor], magnitude, direction: [1, 0, 0] });
const edge = edgeForce(MILD_N);
const casesFor = (magnitude: number) => [
  { name: "edge", loads: [edgeForce(magnitude)] },
  { name: "press", loads: [{ kind: "pressure", faces: [floor], magnitude: 0.01, direction: [0, 0, -1] }] },
];

function factorLine(label: string, reply: Reply): string {
  const factor = reply.plan?.bucklingFactor;
  const line = `${label}: plan.bucklingFactor bare ${factor?.bare} ribbed ${factor?.ribbed} ribs ${reply.plan?.ribs?.length} goalMet ${reply.plan?.goalMet}`;
  console.log(`  ${line}`);
  report.push(line);
  return line;
}

/** A refusal the tool answers, including one the schema throws before the planner runs. */
async function refusal(args: Reply, message: RegExp) {
  let text = "";
  try {
    const asked = await call("ribs_plan", { object, wall, baselines: false, ...args });
    const done = typeof asked.job === "string" ? await waitJob(asked.job) : asked;
    text = `${done.reason ?? ""} ${JSON.stringify(done)}`;
    check(`buckling refusal ${message}`, done.ok === false && message.test(text), text.slice(0, 400));
  } catch (err) {
    text = err instanceof ProtocolError ? err.message : String(err);
    check(`buckling refusal ${message}`, message.test(text), text.slice(0, 400));
  }
  report.push(`refusal ${message}: ${text.slice(0, 240)}`);
}

await refusal({ goal: { buckling: 0.5 } }, /A buckling goal must be 1 or more/);
await refusal({ goal: { buckling: 3, budgetMm3: 100 } }, /A plan has one goal: buckling and budgetMm3 cannot both be set/);
await refusal({ goal: { buckling: 3, on: "only" }, loadCases: [{ name: "only", loads: [edge] }] }, /A buckling goal names a load case only when there is more than one/);
await refusal({ goal: { buckling: 3 }, loadCases: casesFor(MILD_N) }, /A buckling goal needs the load case it is solved against/);

const pressure = await waitJob(String((await call("ribs_plan", { object, wall, goal: { buckling: 2 }, baselines: false })).job));
check("even pressure is refused as no compression", pressure.ok === false && /doesn't press along it/.test(String(pressure.reason)), JSON.stringify(pressure).slice(0, 400));
report.push(`pressure: ${pressure.reason}`);

const enoughAsked = await call("ribs_plan", {
  object,
  wall,
  baselines: false,
  goal: { buckling: ASKED, on: "edge" },
  loadCases: casesFor(MILD_N),
});
const enough = await waitJob(String(enoughAsked.job));
const enoughFactor = enough.plan?.bucklingFactor;
const enoughSentence = String(enough.sentence ?? "");
check(
  "a wall already above the factor plans no ribs",
  enough.ok === true && (enough.plan?.ribs?.length ?? 0) === 0 && enough.plan?.goalMet === true && !!enoughFactor && enoughFactor.bare > ASKED && /The wall already holds /.test(enoughSentence) && /No ribs needed\./.test(enoughSentence),
  JSON.stringify({ factor: enoughFactor, ribs: enough.plan?.ribs?.length, goalMet: enough.plan?.goalMet, sentence: enough.sentence, reason: enough.reason }).slice(0, 500),
);
factorLine("already enough", enough);
report.push(`already enough sentence: ${enough.sentence}`);

// The load factor scales as 1/load. The mild edge load already holds, so raise it until the bare factor sits near 1.1, under the 1.5× ask.
const mildBare = Number(enoughFactor?.bare);
const heavyN = Number.isFinite(mildBare) && mildBare > ASKED ? Math.ceil((MILD_N * mildBare) / 1.1) : MILD_N * 50;
report.push(`rib load ${heavyN} N, from bare ${mildBare} at ${MILD_N} N`);

const started = await call("ribs_plan", {
  object,
  wall,
  baselines: false,
  goal: { buckling: ASKED, on: "edge" },
  loadCases: casesFor(heavyN),
});
const done = await waitJob(String(started.job));
const factor = done.plan?.bucklingFactor;
const ribs = done.plan?.ribs?.length ?? 0;
check("the reply has bucklingFactor before and after", done.ok === true && factor && factor.ribbed + 1e-9 >= factor.bare && factor.bare > 0, JSON.stringify({ factor, goalMet: done.plan?.goalMet, sentence: done.sentence, reason: done.reason }).slice(0, 500));
const ready = done.ok === true && ribs > 0 && !!factor && factor.bare < ASKED;
check("the plan has ribs and the bare factor is below the asked factor", ready, JSON.stringify({ factor, ribs, asked: ASKED, goalMet: done.plan?.goalMet, sentence: done.sentence, reason: done.reason }).slice(0, 500));
check("the sentence carries the warning", /This is the ideal buckling load/.test(String(done.sentence)), String(done.sentence));
check("the sentence names the case", /Against case: edge/.test(String(done.sentence)) || ((done.notes ?? []) as string[]).some((line) => line === "Against case: edge"), JSON.stringify({ sentence: done.sentence, notes: done.notes }).slice(0, 500));
factorLine("with ribs", done);
report.push(`sentence: ${done.sentence}`);
report.push(`notes: ${JSON.stringify(done.notes)}`);

if (ready) {
  const withoutGoal = { ...done.plan };
  delete withoutGoal.goal;
  let applied = await call("ribs_apply", { object, plan: withoutGoal });
  if (applied.status === "running") applied = await waitJob(String(applied.job));
  check("a plan applied without its goal does not take the stored buckling note", applied.ok === true && !/buckling load to check/.test(String(applied.note ?? "")), JSON.stringify(applied).slice(0, 400));
  await call("model_undo", { object });
  let verified = await call("ribs_apply", { object, plan: done.plan, verify: true });
  if (verified.status === "running") verified = await waitJob(String(verified.job));
  check("ribs_apply with the plan's goal says a static check has no buckling load", verified.ok === true && /no buckling load to check/.test(String(verified.note ?? "")), JSON.stringify({ note: verified.note, ok: verified.ok }).slice(0, 400));
  check("verify on a buckling plan says the check is static", verified.verify && /no buckling load to check/.test(String(verified.verify.note)), JSON.stringify(verified.verify).slice(0, 400));
  report.push(`apply without goal: note ${JSON.stringify(applied.note ?? null)}`);
  report.push(`apply with verify: note ${JSON.stringify(verified.note)}; verify ${JSON.stringify(verified.verify?.note)}`);
}

const missedObject = await shellBox(BX, BY, BZ);
const missedFloor = faceAt(missedObject, [0, 0, 2], [0, 0, 1]);
const side = faceAt(missedObject, [BX / 2 - 2, 0, BZ / 2], [-1, 0, 0]);
const missedAsked = await call("ribs_plan", { object: missedObject, wall: { faces: [missedFloor] }, goal: { buckling: 1.5 }, baselines: false, loads: [{ kind: "force", faces: [side], magnitude: 20, direction: [1, 0, 0] }] });
const missed = typeof missedAsked.job === "string" ? await waitJob(missedAsked.job) : missedAsked;
check("a load that misses the wall still refuses a buckling plan", missed.ok === false, JSON.stringify(missed).slice(0, 400));
report.push(`load off the wall: ${missed.code ?? ""} ${missed.reason ?? ""}`);

for (const line of report) console.log(`  ${line}`);
rmSync(workspace, { recursive: true, force: true });
if (failed > 0) {
  console.error(`buckling-occt: ${failed} failed`);
  process.exit(1);
}
console.log("buckling-occt: ok");
process.exit(0);
