/**
 * Byte compare of ribs_plan replies against the real planner at abeb0353.
 *
 * Fixtures: mcp/fixtures/plan-refs-abeb0353.json
 * Commit: abeb0353e755ba679f81de52298842d089e7057f
 * Run: https://github.com/cristy-the-one/lime-slice/actions/runs/44734038583
 * Generator branch: ribs-next/tmp-refs-abeb0353 (3acd7934). Do not merge it. Do not regenerate these files.
 *
 * The walls are the vent tests' walls, each 3 mm. At abeb0353 resin venting is off (no vent field).
 * Clock fields stripped before the compare, and named here:
 * - reply.seconds: wall, plan, total, and planner.bare, planner.field, planner.trace, planner.embed,
 *   planner.select, planner.connect, planner.prune, planner.size, planner.baselines, planner.solver, planner.total
 * - reply.wall.ms: select, remesh, measure, total
 * - reply.ribs.events: the progress events still queued when the slice_wait that returns the finished plan drains
 *   them. Each wait takes what has arrived, so the array is whichever stages and rib changes fell in that wait.
 *   Both arrays are printed in full before they are dropped.
 * A number that is not finite is compared as null, because the fixtures were stored with JSON.stringify and JSON
 * has no Infinity or NaN. The log names the two raw values when they differ in JavaScript and match as JSON.
 * Everything else is compared field by field. A difference fails the test and prints the path and both values.
 * Resin notes and plan.vents are not stripped: they are this branch's output and a difference there fails.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
if (fixture.commit !== "abeb0353e755ba679f81de52298842d089e7057f") {
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
      diffs(name, stripClock(reply), stripClock(ref), found);
    }
    if (found.length) {
      failed += 1;
      console.error(`plan-refs FAIL ${name}`);
      for (const line of found) console.error(`  ${line}`);
    } else console.log(`plan-refs: ${name} matches abeb0353 aside from seconds and wall.ms`);
  }
}
if (failed) {
  console.error(`plan-refs: ${failed} replies differ from abeb0353`);
  process.exit(1);
}
console.log("plan-refs: ok");
process.exit(0);
