/**
 * The Auto ribs plan call (src/auto-ribs-plan.ts): the binding against the desktop's commands as src-tauri/src/lib.rs
 * declares them (read here, so a renamed command or argument fails this test), the wire the bridge writes
 * (crates/lime-sim-bridge/src/ribs.rs, also read here) through the engine source with a scripted transport, the serve
 * routes, and the stand-in: deterministic, honouring a "no ribs" zone, and stopping with the plan so far.
 */
import { readFileSync } from "node:fs";
import { ribWall } from "./modeling/rib-wall.ts";
import { RIB_PLAN_COMMANDS, RIB_PLAN_ROUTE, STAGE_NAMES, enginePlanSource, fakePlanSource, httpPlanTransport, readEvent, readPlan, stageName, tauriPlanTransport, type PlanProgress, type RibPlanBody } from "./auto-ribs-plan.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const eq = (name: string, a: unknown, b: unknown) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// --- The desktop's commands, as lib.rs declares and registers them.
const lib = read("../src-tauri/src/lib.rs");
const handler = /generate_handler!\[([\s\S]*?)\]/.exec(lib)?.[1] ?? "";
const signatures = new Map<string, { param: string; type: string }>();
for (const [key, row] of Object.entries(RIB_PLAN_COMMANDS)) {
  const sig = new RegExp(`#\\[tauri::command\\]\\s*(?:async\\s+)?fn ${row.command}\\((\\w+): (\\w+)\\) -> String \\{\\s*lime_sim_bridge::ribs::${row.command}\\((\\w+)\\)`).exec(lib);
  check(`lib.rs declares ${row.command}(${row.arg}) -> String over lime_sim_bridge::ribs`, !!sig, key);
  if (!sig) continue;
  // Tauri reads a command's arguments by name (camelCase in the window for snake_case in Rust): one word is the same.
  eq(`${row.command}'s argument is named as the binding sends it`, sig[1], row.arg);
  eq(`${row.command} passes its argument on`, sig[3], sig[1]);
  check(`${row.command} is registered in generate_handler!`, new RegExp(`\\b${row.command}\\b`).test(handler));
  signatures.set(row.command, { param: sig[1]!, type: sig[2]! });
}
eq("start takes the body as text, poll and cancel a job id", [...signatures.values()].map((s) => s.type), ["String", "usize", "usize"]);

// --- The bridge's wire: what start, poll and each event carry.
const bridge = read("../crates/lime-sim-bridge/src/ribs.rs");
for (const key of ["status", "stage", "fraction", "events", "dropped", "totals", "cancelled", "seconds", "result"]) check(`poll's reply has ${key}`, bridge.includes(`"${key}":`), key);
check("start answers {id} or {error}", bridge.includes('json!({ "id": id })') && bridge.includes('json!({ "error": err })'));
const eventKeys = ["kind", "change", "id", "points", "heights", "ribs", "ribVolumeMm3", "compliance", "stiffnessFactor", "fraction"];
for (const key of eventKeys) check(`a rib event has ${key}`, bridge.includes(`"${key}":`), key);
for (const key of ["ribs", "ribVolumeMm3", "bare", "ribbed", "stiffnessFactor", "goalMet", "thickening", "grid", "notBetterThanBaseline", "stoppedEarly", "sections", "maxDeflectionMm", "addedThicknessMm", "addedVolumeMm3", "pitchMm", "volumeMm3", "gridVolumeMm3", "reached", "peakFactor", "complianceFactor", "pinned", "pinnedGain", "needsRigidBorders", "taperMm", "builtHeights"]) check(`the plan has ${key}`, bridge.includes(`"${key}":`), key);
// Every stage name the bridge writes has a name on screen.
const stages = [...(/fn stage_name[\s\S]*?\n\}/.exec(bridge)?.[0] ?? "").matchAll(/=> "([^"]+)"/g)].map((m) => m[1]!);
check("the bridge's stage names were read", stages.length === 10, stages);
for (const stage of stages) check(`stage "${stage}" has a name on screen`, Object.hasOwn(STAGE_NAMES, stage) && stageName(stage) === STAGE_NAMES[stage as keyof typeof STAGE_NAMES], stage);

// --- The serve routes the browser binding posts to.
const serve = read("../crates/lime-slice/src/main.rs");
check("serve routes /api/ribs/", serve.includes(`path.starts_with("${RIB_PLAN_ROUTE}")`));
for (const route of ["start", "poll", "cancel"]) check(`serve answers ${route}`, serve.includes(`"${route}" =>`), route);
check("serve reads {id} for poll and cancel", serve.includes('v["id"].as_u64()'));
const posted: [string, string][] = [];
const httpT = httpPlanTransport(async (route, body) => {
  posted.push([route, body]);
  return "{}";
}, async () => {});
await httpT.start("{}");
await httpT.poll(3);
await httpT.cancel(3);
eq("the browser binding posts the body, then {id}", posted, [["/api/ribs/start", "{}"], ["/api/ribs/poll", '{"id":3}'], ["/api/ribs/cancel", '{"id":3}']]);

// --- The engine source over a scripted desktop: every invoke is checked against lib.rs's signature.
const plan = {
  ok: true,
  ribs: [{ points: [[0, 0, 1], [10, 0, 1]], width: 1.35, height: 6, heights: [6], profile: { kind: "straight" }, sections: [{ profile: "straight", width: 1.35, rootRadius: 0 }], ends: ["boundary", "free"], family: "major", lengthMm: 10, volumeMm3: 81, gain: 0.3, energyShare: 0.5 }],
  ribVolumeMm3: 81,
  bare: { compliance: 2, maxDeflectionMm: 0.8 },
  ribbed: { compliance: 1, maxDeflectionMm: 0.4 },
  stiffnessFactor: 2,
  goalMet: true,
  thickening: { addedThicknessMm: 0.3, addedVolumeMm3: 200, compliance: 1, solves: 4 },
  grid: { reached: true, pitchMm: 20, lines: [2, 3], gridVolumeMm3: 150, compliance: 1, volumeMm3: 140, solves: 5 },
  notBetterThanBaseline: false,
  stoppedEarly: false,
};
const rib = (id: number, fraction: number, change = "added") => ({ kind: "rib", change, id, points: change === "removed" ? [] : [[0, 0, 1], [10, 0, 1]], heights: change === "removed" ? [] : [6], ribs: 1, ribVolumeMm3: 81, compliance: 1, stiffnessFactor: 2, fraction });
const polls = [
  { status: "running", stage: "choosing ribs", fraction: 0.3, events: [{ kind: "stage", stage: "bare solve", fraction: 0 }, { kind: "stage", stage: "choosing ribs", fraction: 0.08 }, rib(4, 0.3)], dropped: 0, totals: null, cancelled: false, seconds: 0.1, result: null },
  // An event older than one already shown: the bar must not go back.
  { status: "running", stage: "choosing ribs", fraction: 0.2, events: [rib(5, 0.2), rib(5, 0.25, "removed")], dropped: 0, totals: null, cancelled: false, seconds: 0.2, result: null },
  { status: "done", stage: "done", fraction: 1, events: [{ kind: "stage", stage: "done", fraction: 1 }], dropped: 0, totals: null, cancelled: false, seconds: 0.3, result: plan },
];
const calls: { command: string; args: Record<string, unknown> }[] = [];
const invoke = async (command: string, args: Record<string, unknown>) => {
  calls.push({ command, args });
  const sig = signatures.get(command);
  if (!sig) throw new Error(`no such command ${command}`);
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== sig.param) throw new Error(`${command} takes {${sig.param}}, got {${keys.join(", ")}}`);
  const value = args[sig.param];
  if (sig.type === "String" ? typeof value !== "string" : !Number.isInteger(value) || (value as number) < 0) throw new Error(`${command}'s ${sig.param} is not a ${sig.type}`);
  if (command === "rib_plan_start") return JSON.stringify({ id: 7 });
  if (command === "rib_plan_cancel") return JSON.stringify({ ok: true });
  return JSON.stringify(polls.shift() ?? polls[polls.length - 1]);
};
const seen: PlanProgress[] = [];
const source = enginePlanSource(tauriPlanTransport(invoke, async () => {}), 0);
const job = source.start({ request: { mesh: { vertices: [], triangles: [], thickness: [] }, holds: { kind: "allBoundary" }, loadCases: [], zones: [], clearance: [], side: "positive" }, rules: { width: 1.35, maxHeight: 6, minSpacing: 15, minLength: 10 } }, (event) => seen.push(event));
const reply = await job.done;
eq("the commands the binding sent", calls.map((c) => c.command), ["rib_plan_start", "rib_plan_poll", "rib_plan_poll", "rib_plan_poll"]);
check("start sent the body as JSON text", typeof calls[0]!.args.body === "string" && JSON.parse(calls[0]!.args.body as string).rules.width === 1.35);
eq("every event came through, in order", seen.map((e) => (e.kind === "stage" ? e.stage : `${e.change} ${e.id}`)), ["bare solve", "choosing ribs", "added 4", "added 5", "removed 5", "done"]);
check("the fraction never goes back", seen.every((e, i) => i === 0 || e.fraction >= seen[i - 1]!.fraction), seen.map((e) => e.fraction));
check("the plan came back", reply.ok && reply.plan.ribs.length === 1 && reply.plan.stiffnessFactor === 2 && reply.plan.grid?.volumeMm3 === 140 && reply.plan.ribs[0]!.sections[0]!.profile === "straight", reply);
eq("a refusal in the result is the sentence", readPlan({ ok: false, reason: "The wall has no triangles to plan on." }), { ok: false, reason: "The wall has no triangles to plan on." });
eq("an event of another kind is skipped", readEvent({ kind: "later" }), null);

// A cancel goes once, and the plan so far comes back.
const cancelCalls: string[] = [];
let pollsLeft = 3;
const cancelling = enginePlanSource(tauriPlanTransport(async (command, args) => {
  cancelCalls.push(command);
  if (command === "rib_plan_start") return JSON.stringify({ id: 1 });
  if (command === "rib_plan_cancel") return JSON.stringify({ ok: true, ...args });
  pollsLeft -= 1;
  return JSON.stringify(pollsLeft > 0 ? { status: "running", events: [], fraction: 0.1 } : { status: "done", events: [], fraction: 1, result: { ...plan, stoppedEarly: true, thickening: null, grid: null } });
}, async () => {}), 0).start({} as RibPlanBody, () => {});
cancelling.cancel();
const stopped = await cancelling.done;
eq("the cancel was sent once", cancelCalls.filter((c) => c === "rib_plan_cancel").length, 1);
check("the plan so far, marked stopped early", stopped.ok && stopped.plan.stoppedEarly && stopped.plan.grid === null);

// A start the engine refuses, and a job it lost.
const refused = await enginePlanSource(tauriPlanTransport(async () => JSON.stringify({ error: "The rib plan request could not be read." }), async () => {}), 0).start({} as RibPlanBody, () => {}).done;
eq("a refused start is its sentence", refused, { ok: false, reason: "The rib plan request could not be read." });

// --- The stand-in: an open box's floor, read as the panel reads it.
type V = [number, number, number];
const pos: number[] = [];
const face: number[] = [];
const quad = (f: number, a: V, b: V, c: V, d: V, want: V) => {
  const tri = (p: V, q: V, r: V) => {
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const flip = n[0]! * want[0] + n[1]! * want[1] + n[2]! * want[2] < 0;
    pos.push(...p, ...(flip ? r : q), ...(flip ? q : r));
    face.push(f);
  };
  tri(a, b, c);
  tri(a, c, d);
};
const [X, Y, Z, T] = [120, 80, 30, 2];
quad(0, [0, 0, 0], [X, 0, 0], [X, Y, 0], [0, Y, 0], [0, 0, -1]);
quad(6, [T, T, T], [X - T, T, T], [X - T, Y - T, T], [T, Y - T, T], [0, 0, 1]);
quad(2, [0, 0, 0], [0, Y, 0], [0, Y, Z], [0, 0, Z], [-1, 0, 0]);
quad(3, [X, 0, 0], [X, Y, 0], [X, Y, Z], [X, 0, Z], [1, 0, 0]);
quad(4, [0, 0, 0], [X, 0, 0], [X, 0, Z], [0, 0, Z], [0, -1, 0]);
quad(5, [0, Y, 0], [X, Y, 0], [X, Y, Z], [0, Y, Z], [0, 1, 0]);
quad(8, [T, T, T], [T, Y - T, T], [T, Y - T, Z], [T, T, Z], [1, 0, 0]);
quad(9, [X - T, T, T], [X - T, Y - T, T], [X - T, Y - T, Z], [X - T, T, Z], [-1, 0, 0]);
quad(10, [T, T, T], [X - T, T, T], [X - T, T, Z], [T, T, Z], [0, 1, 0]);
quad(11, [T, Y - T, T], [X - T, Y - T, T], [X - T, Y - T, Z], [T, Y - T, Z], [0, -1, 0]);
const solid = { positions: Float32Array.from(pos), faceOf: Uint32Array.from(face) };
const bodyOf = (zones: Parameters<typeof ribWall>[1]["zones"] = []): RibPlanBody => {
  const wall = ribWall(solid, { picked: [6], zones });
  if ("reason" in wall) throw new Error(wall.reason);
  return { request: wall.request, rules: { width: 1.2, maxHeight: 6, minHeight: 1, minSpacing: 13, minLength: 10 }, goal: { kind: "balanced" } };
};
const runFake = async (body: RibPlanBody, knobs = {}) => {
  const events: PlanProgress[] = [];
  const reply = await fakePlanSource(() => ({ tickMs: 0, ...knobs })).start(body, (e) => events.push(e)).done;
  return { events, reply };
};
const plain = bodyOf();
const one = await runFake(plain);
const two = await runFake(plain);
eq("the stand-in is deterministic", one, two);
check("it adds, joins, prunes and sizes", ["added", "changed", "removed"].every((c) => one.events.some((e) => e.kind === "rib" && e.change === c)));
check("its fraction never goes back", one.events.every((e, i) => i === 0 || e.fraction >= one.events[i - 1]!.fraction));
check("it plans three ribs at balanced", one.reply.ok && one.reply.plan.ribs.length === 3, one.reply);
const boxed = await runFake(bodyOf([{ region: { box: { centre: [60, 40, 2], size: [40, 30, 10] } }, mode: "noRibs" }]));
const inBox = boxed.reply.ok ? boxed.reply.plan.ribs.flatMap((r) => r.points).filter((p) => Math.abs(p[0] - 60) < 20 && Math.abs(p[1] - 40) < 15) : ["refused"];
eq("no rib point in a no-ribs box", inBox, []);
const capped = await runFake(bodyOf([{ region: { box: { centre: [60, 40, 2], size: [200, 200, 10] } }, mode: "maxHeight", maxHeightMm: 2 }]));
check("a height cap holds every stretch under it", capped.reply.ok && capped.reply.plan.ribs.every((r) => r.heights.every((h) => h <= 2 + 1e-9)), capped.reply);
const neither = await runFake(plain, { beatsNeither: true });
check("beatsNeither marks the plan", neither.reply.ok && neither.reply.plan.notBetterThanBaseline);
const nope = await runFake(plain, { refuse: "No." });
eq("a refusal knob refuses", nope.reply, { ok: false, reason: "No." });
// Stopped after the first rib: a valid plan, stopped early, without comparisons.
const early: PlanProgress[] = [];
const fakeJob = fakePlanSource(() => ({ tickMs: 5 })).start(plain, (e) => {
  early.push(e);
  if (e.kind === "rib") fakeJob.cancel();
});
const cut = await fakeJob.done;
check("Stop returns the plan so far", cut.ok && cut.plan.stoppedEarly && cut.plan.ribs.length === 1 && cut.plan.thickening === null, cut);

if (failed) {
  console.error(`auto-ribs-plan: ${failed} failed`);
  process.exit(1);
}
console.log("auto-ribs-plan: ok");
