/**
 * A frequency goal through ribs_plan, against real Open CASCADE and the engine, on a synthetic shelled box.
 * The reply's Hz and factor, the notes, each refusal by its message, a load that misses the wall, and ribs_apply
 * with and without verify. It runs on the folded-shell job: the rest of auto-ribs-occt stays on the shared job.
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
    console.error("frequency-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("frequency-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-frequency-"));
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

const [BX, BY, BZ] = [120, 70, 25];
const object = await shellBox(BX, BY, BZ);
const floor = faceAt(object, [0, 0, 2], [0, 0, 1]);
const wall = { faces: [floor] };

/** A refusal the tool answers, including one the schema throws before the planner runs. */
async function refusal(args: Reply, message: RegExp) {
  let text = "";
  try {
    const asked = await call("ribs_plan", { object, wall, ...args });
    const done = typeof asked.job === "string" ? await waitJob(asked.job) : asked;
    text = `${done.reason ?? ""} ${JSON.stringify(done)}`;
    check(`frequency refusal ${message}`, done.ok === false && message.test(text), text.slice(0, 400));
  } catch (err) {
    text = err instanceof ProtocolError ? err.message : String(err);
    check(`frequency refusal ${message}`, message.test(text), text.slice(0, 400));
  }
  report.push(`refusal ${message}: ${text.slice(0, 240)}`);
}

await refusal({ goal: { frequency: 0.5 } }, /A frequency goal must be 1 or more/);
await refusal({ goal: { frequency: 1.3, budgetMm3: 100 } }, /A plan has one goal: frequency and budgetMm3 cannot both be set/);
await refusal({ goal: { frequency: 1.3, stiffer: 2, budgetG: 1 } }, /A plan has one goal: frequency, stiffer and budgetG cannot all be set/);

const one = await waitJob(String((await call("ribs_plan", { object, wall, goal: { frequency: 1 } })).job));
check("×1 asks for no change and plans nothing", one.ok === true && one.plan.ribs.length === 0 && /×1 asks for no change/.test(String(one.sentence)), JSON.stringify({ sentence: one.sentence, ribs: one.plan?.ribs?.length }).slice(0, 300));
report.push(`×1: ${one.sentence}`);

const started = await call("ribs_plan", { object, wall, goal: { frequency: 1.3 } });
const done = await waitJob(String(started.job));
const hz = done.plan?.frequencyHz;
const factor = Number(done.plan?.frequencyFactor);
check("the reply has frequencyHz and frequencyFactor", done.ok === true && done.plan.goalMet === true && hz && hz.ribbed > hz.bare && factor >= 1.3 && Math.abs(factor - hz.ribbed / hz.bare) < 1e-4, JSON.stringify({ hz, factor, goalMet: done.plan?.goalMet, sentence: done.sentence }).slice(0, 500));
check("the sentence names the Hz and the stiffness factor", /Hz/.test(String(done.sentence)) && /Stiffness /.test(String(done.sentence)) && /for information/.test(String(done.sentence)), String(done.sentence));
const notes = (done.notes ?? []) as string[];
check("no loads were given, so the notes do not say they are ignored", notes.some((line) => /mode shape/.test(line)) && notes.every((line) => !/ignored/.test(line)), JSON.stringify(notes));
const material = done.rules?.material as Reply | undefined;
if (material && material.forFilament === false) check("the Hz name the default card", notes.some((line) => /default/.test(line) && line.includes(String(material.card))), JSON.stringify({ material, notes }));
report.push(`frequency plan on the ${BX}×${BY}×${BZ} box: ${hz?.bare} Hz → ${hz?.ribbed} Hz, ×${factor}, stiffness ×${done.plan?.stiffnessFactor}, ribs ${done.plan?.ribs?.length}, notes ${JSON.stringify(notes)}`);
report.push(`sentence: ${done.sentence}`);

const withoutGoal = { ...done.plan };
delete withoutGoal.goal;
let applied = await call("ribs_apply", { object, plan: withoutGoal });
if (applied.status === "running") applied = await waitJob(String(applied.job));
check("a plan applied without its goal does not take the stored frequency note", applied.ok === true && !/frequency to check/.test(String(applied.note ?? "")), JSON.stringify(applied).slice(0, 400));
await call("model_undo", { object });
let verified = await call("ribs_apply", { object, plan: done.plan, verify: true });
if (verified.status === "running") verified = await waitJob(String(verified.job));
check("ribs_apply with the plan's goal says a static check has no frequency", verified.ok === true && /no frequency to check/.test(String(verified.note ?? "")), JSON.stringify({ note: verified.note, ok: verified.ok }).slice(0, 400));
check("verify on a frequency plan says the check is static", verified.verify && /no frequency to check/.test(String(verified.verify.note)), JSON.stringify(verified.verify).slice(0, 400));
report.push(`apply without goal: note ${JSON.stringify(applied.note ?? null)}`);
report.push(`apply with verify: note ${JSON.stringify(verified.note)}; verify ${JSON.stringify(verified.verify?.note)}`);

const missedObject = await shellBox(BX, BY, BZ);
const missedFloor = faceAt(missedObject, [0, 0, 2], [0, 0, 1]);
const side = faceAt(missedObject, [BX / 2 - 2, 0, BZ / 2], [-1, 0, 0]);
const missed = await waitJob(String((await call("ribs_plan", { object: missedObject, wall: { faces: [missedFloor] }, goal: { frequency: 1.3 }, loads: [{ kind: "force", faces: [side], magnitude: 20, direction: [1, 0, 0] }] })).job));
const missedNotes = (missed.notes ?? []) as string[];
check("a load that misses the wall does not refuse a frequency plan", missed.ok === true && missed.code !== "off-wall", JSON.stringify(missed).slice(0, 400));
check("the note names the load and says it is ignored", missedNotes.some((line) => /Load 1 misses the wall and is ignored/.test(line)), JSON.stringify(missedNotes));
report.push(`load off the wall: ${missed.ok === true ? "planned" : missed.code} ${JSON.stringify(missedNotes)}`);

const casesObject = await shellBox(BX, BY, BZ);
const casesFloor = faceAt(casesObject, [0, 0, 2], [0, 0, 1]);
const force = (magnitude: number) => ({ kind: "force", faces: [casesFloor], magnitude, direction: [0, 0, -1] });
const cases = await waitJob(String((await call("ribs_plan", { object: casesObject, wall: { faces: [casesFloor] }, goal: { frequency: 1.3 }, loadCases: [{ name: "spread", loads: [force(10)] }, { name: "point", loads: [force(20)] }] })).job));
check("loads that were given are named as ignored", ((cases.notes ?? []) as string[]).some((line) => /Loads are ignored/.test(line)), JSON.stringify(cases.notes));
check("each case factor is labelled stiffness", /Per case, stiffness: spread \S+×, point \S+×/.test(String(cases.sentence)), String(cases.sentence));
report.push(`two cases: ${cases.sentence}`);

for (const line of report) console.log(`  ${line}`);
rmSync(workspace, { recursive: true, force: true });
if (failed > 0) {
  console.error(`frequency-occt: ${failed} failed`);
  process.exit(1);
}
console.log("frequency-occt: ok");
process.exit(0);
