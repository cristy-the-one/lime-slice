/**
 * Byte compare of ribs_plan replies against a captured planner run.
 *
 * Fixtures: mcp/fixtures/plan-refs-abeb0353.json
 * Recaptured on 05c99d4d (run 45943043698) after faces were meshed with Watson. The wall mesh triangle
 * counts moved (the tray 526 → 522, the panel 226 → 230) and the rib paths moved with them. The file
 * name keeps the abeb0353 capture it replaced. Do not regenerate these files for a planner change that
 * is not a mesh change.
 *
 * The walls are the vent tests' walls, each 3 mm. A reference that already carries plan.vents is compared
 * in full. A reference from before venting (no vents object) still allows the three vent keys.
 * Clock fields stripped before the compare, and named here:
 * - reply.seconds: wall, plan, total, and planner.bare, planner.field, planner.trace, planner.embed,
 *   planner.select, planner.connect, planner.prune, planner.size, planner.baselines, planner.solver, planner.total
 * - reply.wall.ms: select, remesh, measure, total
 * - reply.ribs.events: the progress events still queued when the slice_wait that returns the finished plan drains
 *   them. Each wait takes what has arrived, so the array is whichever stages and rib changes fell in that wait.
 *   Both arrays are printed in full before they are dropped.
 * A number that is not finite is compared as null, because the fixtures were stored with JSON.stringify and JSON
 * has no Infinity or NaN. The log names the two raw values when they differ in JavaScript and match as JSON.
 *
 * A resin reply whose plan.vents is a non-empty object may add exactly three keys, and only when each is present
 * in the new reply and absent from the reference: notes, plan.notes, plan.vents. They are deleted before the
 * compare. If the top-level sentence is the reference sentence plus vent sentences, only those sentences are
 * removed. A vent sentence is one of: "N pocket(s) vented, M could not be vented", "M could not be vented: …",
 * "The plate has no resin printer, so the build direction is the part as it sits, +Z.", "Build direction is the
 * one given, in the plate frame, turned into the wall's frame.", "Venting was skipped: …", or a sentence that is
 * one of the notes just deleted. Filament, moulded, and a resin reply with no vents get no allowance.
 * The log prints the allowed keys for every fixture. Everything else is compared field by field.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GIVEN_AXIS, NO_RESIN_PRINTER } from "../src/modeling/vents.ts";
import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("plan-refs: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("plan-refs: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-plan-refs-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "180";

type Reply = Record<string, unknown>;
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;

async function waitJob(job: string): Promise<Reply> {
  for (;;) {
    const reply = await call("slice_wait", { job, timeoutS: 2 });
    if (reply.status !== "running") return reply;
  }
}

async function shelled(dx: number, dy: number, dz: number, open: { normal: number[]; nearPoint: number[] }[]): Promise<string> {
  const made = await call("solid_new", { primitive: "box", dx, dy, dz });
  if (made.ok === false) throw new Error(`solid_new: ${JSON.stringify(made).slice(0, 300)}`);
  const object = String(made.object);
  const shell = await call("model_apply", { object, probe: true, op: { kind: "shell", thickness: 3, openFaces: open } });
  if (shell.ok !== true) throw new Error(`shell ${dx}×${dy}×${dz}: ${JSON.stringify(shell).slice(0, 400)}`);
  return object;
}

/** Drop the wall-clock fields named in the file header. Nothing else. */
function stripClock(reply: Reply): Reply {
  const copy = structuredClone(reply);
  delete copy.seconds;
  const wall = copy.wall;
  if (wall && typeof wall === "object") delete (wall as Reply).ms;
  const ribs = copy.ribs;
  if (ribs && typeof ribs === "object") delete (ribs as Reply).events;
  return copy;
}

/** What the value is, including NaN and Infinity, which JSON.stringify turns into null. */
function shown(value: unknown): string {
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (value === undefined) return "undefined";
  return JSON.stringify(value) ?? "undefined";
}

/** JSON.stringify writes a non-finite number as null. The fixtures were stored that way. */
function asJson(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

/** plan.vents counts when it is an object with at least one field. Absent, null, and {} do not. */
function ventsNonEmpty(reply: Reply): boolean {
  const plan = reply.plan;
  if (!plan || typeof plan !== "object") return false;
  const vents = (plan as Reply).vents;
  return vents !== null && typeof vents === "object" && !Array.isArray(vents) && Object.keys(vents as Reply).length > 0;
}

/** A sentence this branch may add after the reference sentence, and nothing else. */
function isVentSentence(part: string, notes: readonly string[]): boolean {
  const text = part.endsWith(".") ? part.slice(0, -1) : part;
  if (/^\d+ pockets? vented, \d+ could not be vented/.test(text)) return true;
  if (/^\d+ could not be vented:/.test(text)) return true;
  if (text === NO_RESIN_PRINTER || part === NO_RESIN_PRINTER) return true;
  if (text === GIVEN_AXIS || part === GIVEN_AXIS) return true;
  if (text.startsWith("Venting was skipped")) return true;
  return notes.some((note) => part === note || text === note || text === (note.endsWith(".") ? note.slice(0, -1) : note));
}

/**
 * The reference sentence plus only vent sentences. Returns the text that was a vent sentence, or null when the
 * sentence differs for any other reason (that difference stays in the compare).
 */
function ventSentenceAdded(live: string, ref: string, notes: readonly string[]): string | null {
  if (live === ref || !live.startsWith(ref)) return null;
  const extra = live.slice(ref.length).trim();
  if (!extra) return null;
  const parts = extra.split(/(?<=\.)\s+/).filter((part) => part.length > 0);
  if (!parts.length || !parts.every((part) => isVentSentence(part, notes))) return null;
  return extra;
}

/**
 * On a resin reply with a non-empty plan.vents, require notes, plan.notes and plan.vents in the new reply and in
 * neither place in the reference, then delete exactly those three keys. Returns a failure sentence, or null.
 */
function allowResinVents(name: string, live: Reply, ref: Reply): string | null {
  if (!ventsNonEmpty(live)) {
    console.log(`plan-refs: ${name} allowed keys: none`);
    return null;
  }
  const livePlan = live.plan as Reply;
  const refPlan = (ref.plan ?? {}) as Reply;
  const problems: string[] = [];
  if (!("notes" in live)) problems.push("notes missing from the new reply");
  if ("notes" in ref) problems.push("notes is in the abeb0353 reply");
  if (!("notes" in livePlan)) problems.push("plan.notes missing from the new reply");
  if ("notes" in refPlan) problems.push("plan.notes is in the abeb0353 reply");
  if (!("vents" in livePlan)) problems.push("plan.vents missing from the new reply");
  if ("vents" in refPlan) problems.push("plan.vents is in the abeb0353 reply");
  if (problems.length) {
    console.log(`plan-refs: ${name} allowed keys: none (${problems.join("; ")})`);
    return problems.join("; ");
  }
  const notes = Array.isArray(live.notes) ? live.notes.filter((note): note is string => typeof note === "string") : [];
  delete live.notes;
  delete livePlan.notes;
  delete livePlan.vents;
  const allowed = ["notes", "plan.notes", "plan.vents"];
  if (typeof live.sentence === "string" && typeof ref.sentence === "string") {
    const added = ventSentenceAdded(live.sentence, ref.sentence, notes);
    if (added) {
      live.sentence = ref.sentence;
      allowed.push(`sentence vent text: ${added}`);
    }
  }
  console.log(`plan-refs: ${name} allowed keys: ${allowed.join("; ")}`);
  return null;
}

function diffs(path: string, live: unknown, ref: unknown, out: string[]): void {
  if (out.length >= 24) return;
  const liveJson = asJson(live);
  const refJson = asJson(ref);
  if (liveJson === refJson && (typeof liveJson !== "object" || liveJson === null)) {
    if (live !== ref) console.log(`plan-refs: ${path} live ${shown(live)}, fixture ${shown(ref)} (the same JSON value)`);
    return;
  }
  if (live === ref) return;
  if (typeof live !== typeof ref || live === null || ref === null || typeof live !== "object") {
    out.push(`${path}: ${shown(live).slice(0, 400)} != ${shown(ref).slice(0, 400)}`);
    return;
  }
  if (Array.isArray(live) || Array.isArray(ref)) {
    if (!Array.isArray(live) || !Array.isArray(ref) || live.length !== ref.length) {
      out.push(`${path}: length ${Array.isArray(live) ? live.length : typeof live} != ${Array.isArray(ref) ? ref.length : typeof ref}`);
      out.push(`${path} live ${JSON.stringify(live)}`);
      out.push(`${path} abeb0353 ${JSON.stringify(ref)}`);
      return;
    }
    live.forEach((item, i) => diffs(`${path}[${i}]`, item, ref[i], out));
    return;
  }
  const a = live as Reply;
  const b = ref as Reply;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    if (!(key in a) || !(key in b)) {
      const value = key in a ? a[key] : b[key];
      out.push(`${path}.${key}: ${key in a ? "only in this reply" : "only in abeb0353"} ${JSON.stringify(value)}`);
    } else diffs(`${path}.${key}`, a[key], b[key], out);
  }
}

const fixture = JSON.parse(readFileSync(join(root, "mcp/fixtures/plan-refs-abeb0353.json"), "utf8")) as { commit: string; replies: Record<string, Reply> };
if (fixture.commit !== "05c99d4d4d40da04973d9837346af2e40cd3b7a0") {
  console.error(`plan-refs: fixture commit is ${fixture.commit}`);
  process.exit(1);
}

const tray = await shelled(120, 70, 25, [
  { normal: [0, 0, 1], nearPoint: [0, 0, 25] },
  { normal: [1, 0, 0], nearPoint: [60, 0, 12] },
]);
const panel = await shelled(40, 93, 12, [{ normal: [0, 0, 1], nearPoint: [0, 0, 12] }]);
const walls = [
  { name: "tray", object: tray, wall: { face: { normal: [0, 0, 1], nearPoint: [0, 0, 3] } } },
  { name: "panel", object: panel, wall: { face: { normal: [0, 0, 1], nearPoint: [0, 0, 3] } } },
];
const processes = ["filament", "moulded", "resin"] as const;
let failed = 0;
for (const wall of walls) {
  for (const process of processes) {
    const name = `${wall.name}-${process}`;
    const ref = fixture.replies[name];
    const started = await call("ribs_plan", { object: wall.object, wall: wall.wall, process, goal: { budgetMm3: 2500 }, baselines: false });
    const reply = started.job ? await waitJob(String(started.job)) : started;
    const found: string[] = [];
    if (!ref) found.push("no fixture");
    else if (reply.ok !== true) found.push(`reply not ok: ${JSON.stringify(reply).slice(0, 300)}`);
    else {
      const liveEvents = (reply.ribs as Reply | undefined)?.events;
      const refEvents = (ref.ribs as Reply | undefined)?.events;
      console.log(`plan-refs: ${name} ribs.events live ${JSON.stringify(liveEvents)}`);
      console.log(`plan-refs: ${name} ribs.events abeb0353 ${JSON.stringify(refEvents)}`);
      const live = stripClock(reply);
      const stored = stripClock(ref);
      if (process === "resin" && !ventsNonEmpty(stored)) {
        const refused = allowResinVents(name, live, stored);
        if (refused) found.push(refused);
      } else console.log(`plan-refs: ${name} allowed keys: none`);
      if (!found.length) diffs(name, live, stored, found);
    }
    if (found.length) {
      failed += 1;
      console.error(`plan-refs FAIL ${name}`);
      for (const line of found) console.error(`  ${line}`);
    } else console.log(`plan-refs: ${name} matches the captured reply aside from the clock fields and the allowed keys printed above`);
  }
}
if (failed) {
  console.error(`plan-refs: ${failed} replies differ from abeb0353`);
  process.exit(1);
}
console.log("plan-refs: ok");
process.exit(0);
