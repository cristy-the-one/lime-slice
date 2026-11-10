/**
 * docs/plan-native-recipes.md 7.1: the queue of booleans a recipe run keeps, against a stand-in port. Grouping (same
 * kind, boxes apart, moves only past tools it misses), what flushes a part's queue, the explicit queue's refusals, and
 * a late refusal that asks for the run to be built again one by one.
 */
import type { Box } from "../modeling/anchors.ts";
import type { RecipeCallSite, RecipeReply } from "./host.ts";
import type { ModelOp } from "../model-tree.ts";
import type { SolidView } from "../modeling/model-calls.ts";
import { groupSkipsMesh, guardReadsBefore, liteSolid, planGroups, queuedGuard, queueSummary, RecipeQueue, type QueueKind, type QueuePort } from "./queue.ts";

let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  failed += 1;
  console.error(`FAIL ${name}: ${a} vs ${b}`);
}

const box = (x: number, w = 2): Box => ({ min: [x, 0, 0], max: [x + w, 2, 2] });
const tool = (kind: QueueKind, x: number, w = 2) => ({ kind, box: box(x, w) });

// --- Grouping.
// gears-on-sphere: per gear a fuse (the gear), a fuse on it (the hub) and a cut in the hub (the bore); gears apart.
const gears = [0, 10, 20].flatMap((x) => [tool("fuse", x, 4), tool("fuse", x + 1, 2), tool("cut", x + 1.5, 1)]);
eq("gears, hubs and bores become three booleans", planGroups(gears), [[0, 3, 6], [1, 4, 7], [2, 5, 8]]);
eq("tools apart of one kind are one boolean", planGroups([tool("cut", 0), tool("cut", 5), tool("cut", 10)]), [[0, 1, 2]]);
eq("an overlapping cut after a fuse keeps its place", planGroups([tool("fuse", 0), tool("cut", 1), tool("fuse", 5)]), [[0, 2], [1]]);
eq("a fuse over that cut does not move ahead of it", planGroups([tool("fuse", 0), tool("cut", 1), tool("fuse", 1.5)]), [[0], [1], [2]]);
eq("overlapping tools of one kind stay apart", planGroups([tool("fuse", 0), tool("fuse", 1)]), [[0], [1]]);
const merged = (kind: QueueKind, x: number) => ({ ...tool(kind, x), merge: true });
eq("a merging boolean never joins an extrude's group", planGroups([merged("fuse", 0), tool("fuse", 5), merged("fuse", 10)]), [[0, 2], [1]]);
eq("merging booleans apart are one boolean", planGroups([merged("cut", 0), merged("cut", 5)]), [[0, 1]]);

// --- The queue, against a port that records what it was asked.
interface Seen { kind: string; detail: unknown }
function stand(opts: { refuseGroup?: { reason: string; index?: number }; refuseOne?: (site: RecipeCallSite) => string | null } = {}) {
  const seen: Seen[] = [];
  const port: QueuePort = {
    tool: async (_object, op) => (op.kind === "boolean" ? { kind: op.op === "cut" ? "cut" : "fuse", box: box(Number(op.x ?? 0)) } : null),
    partBox: () => ({ min: [-100, -100, -100], max: [100, 100, 100] }),
    build: async (_object, ops, groups) => {
      seen.push({ kind: "build", detail: { lines: ops.map((q) => q.site.line), groups } });
      return opts.refuseGroup ? { ok: false, ...opts.refuseGroup } : { ok: true };
    },
    applyOne: async (site) => {
      seen.push({ kind: "one", detail: site.line });
      const no = opts.refuseOne?.(site);
      return no ? { ok: false, error: no } : { ok: true, result: { ok: true } };
    },
  };
  return { port, seen };
}
let id = 0;
const site = (tool: string, line: number, args: Record<string, unknown>): RecipeCallSite => ({ id: ++id, tool, line, args });
const cut = (line: number, x: number, extra: Record<string, unknown> = {}) => site("model_apply", line, { object: "obj_1", op: { kind: "boolean", op: "cut", x }, probe: true, ...extra });
const inner = (seen: Seen[]) => async (s: RecipeCallSite): Promise<RecipeReply> => {
  seen.push({ kind: "inner", detail: `${s.tool}@${s.line}` });
  return { ok: true, result: { ok: true } };
};

{
  const { port, seen } = stand();
  const q = new RecipeQueue(port, new Set([10]), { silent: true, timeLimitS: 30 });
  const a = await q.call(cut(10, 0), inner(seen));
  const b = await q.call(cut(10, 5), inner(seen));
  eq("an unread line is answered queued", [a, b].map((r) => r.ok && (r.result as { queued?: boolean }).queued), [true, true]);
  eq("nothing is built yet", seen, []);
  await q.call(site("faces_find", 20, { object: "obj_1" }), inner(seen));
  eq("a read of the part builds its queue first, as one boolean", seen, [{ kind: "build", detail: { lines: [10, 10], groups: [[0, 1]] } }, { kind: "inner", detail: "faces_find@20" }]);
  await q.call(cut(10, 0), inner(seen));
  await q.call(site("faces_find", 20, { object: "obj_2" }), inner(seen));
  eq("a read of another part does not", seen.slice(2), [{ kind: "inner", detail: "faces_find@20" }]);
  await q.call(cut(30, 9), inner(seen));
  eq("a line whose reply is read builds the queue, then itself in its place", seen.slice(3), [{ kind: "one", detail: 10 }, { kind: "inner", detail: "model_apply@30" }]);
  await q.call(cut(10, 0), inner(seen));
  await q.call(cut(10, 4), inner(seen));
  await q.call(site("faces_find", 21, { object: "obj_1" }), inner(seen));
  await q.call(cut(10, 0), inner(seen));
  await q.call(site("faces_find", 21, { object: "obj_1" }), inner(seen));
  const summary = queueSummary(q.report);
  eq("the reply counts what queued and how many booleans it took", summary.queued, { applies: 6, booleans: 4 });
  eq("a read that kept building the queue is a hint", summary.queueHints?.[0], "faces_find at line 21 built the queue 2 times (3 applies); read before the loop of applies so they build together.");
}

{
  const { port, seen } = stand();
  const q = new RecipeQueue(port, new Set([10]), { silent: true, timeLimitS: 30 });
  await q.call(site("queue", 5, { silent: false }), inner(seen));
  await q.call(cut(10, 0), inner(seen));
  eq("queue(false) builds every apply in its place", seen, [{ kind: "inner", detail: "model_apply@10" }]);
}

{
  // The explicit queue: refusals come back from flush, each with its line, built one by one to say which.
  const { port, seen } = stand({ refuseGroup: { reason: "Open CASCADE did not complete the boolean" }, refuseOne: (s) => (s.line === 41 ? "The cut does not change the part." : null) });
  const q = new RecipeQueue(port, new Set(), { silent: true, timeLimitS: 30 });
  await q.call(cut(40, 0, { queue: "later" }), inner(seen));
  await q.call(cut(41, 5, { queue: "later" }), inner(seen));
  const flushed = await q.call(site("flush", 50, { object: "obj_1" }), inner(seen));
  eq("flush reports the refused op by its place and line", flushed, { ok: true, result: { ok: true, applied: 1, failures: [{ index: 1, reason: "The cut does not change the part.", line: 41 }] } });
  eq("and the run goes on", q.replay, null);
}

{
  // A silent op refused inside a group: the run must be built again one by one, naming the op's line.
  const { port, seen } = stand({ refuseGroup: { reason: "The cut does not change the part.", index: 1 } });
  const q = new RecipeQueue(port, new Set([10, 11]), { silent: true, timeLimitS: 30 });
  await q.call(cut(10, 0), inner(seen));
  await q.call(cut(11, 5), inner(seen));
  const done = await q.flushAll();
  eq("a late refusal ends the run for its replay", done?.ok === false && (done as { fatal?: boolean }).fatal, true);
  eq("naming the op the engine named", q.replay, { line: 11, reason: "The cut does not change the part." });
}

{
  // Not a plain tool: built in its place, so its own answer comes back at its line.
  const { port, seen } = stand();
  const q = new RecipeQueue(port, new Set([10, 12]), { silent: true, timeLimitS: 30 });
  await q.call(cut(10, 0), inner(seen));
  await q.call(site("model_apply", 12, { object: "obj_1", op: { kind: "fillet" }, probe: true }), inner(seen));
  eq("a fillet builds the queue, then itself", seen, [{ kind: "one", detail: 10 }, { kind: "inner", detail: "model_apply@12" }]);
}

{
  // A cancel, or the run's time limit, stops the build before the next boolean: the run ends, with no replay.
  const { port, seen } = stand();
  const abort = new AbortController();
  const q = new RecipeQueue(port, new Set([10]), { silent: true, timeLimitS: 30, signal: abort.signal });
  await q.call(cut(10, 0), inner(seen));
  abort.abort();
  const done = await q.flushAll();
  eq("a cancel stops the queue's build", [done?.ok, (done as { error?: string })?.error, q.replay, seen.length], [false, "The recipe was cancelled.", null, 0]);
  const late = new RecipeQueue(port, new Set([10]), { silent: true, timeLimitS: 0.001 });
  await late.call(cut(10, 0), inner(seen));
  await new Promise((resolve) => setTimeout(resolve, 5));
  eq("so does the time limit", (await late.flushAll() as { error?: string })?.error, "The recipe ran past its 0.001 s limit and was stopped.");
}

// --- A flush meshes only what is read: every group but the last skips its mesh unless it holds a primitive boolean.
{
  const prim = (op: "fuse" | "cut", x: number) => ({ kind: "boolean", op, primitive: "box", origin: [x, 0, 0], size: [2, 2, 2], radius: 0, height: 0, turn: [0, 0, 0] }) as unknown as ModelOp;
  const extrude = { kind: "extrude", op: "fuse" } as unknown as ModelOp;
  const skips = (groups: ModelOp[][]) => groups.map((_, g) => groupSkipsMesh(groups, g));
  eq("gears, hubs, bores: only the gears' extrudes skip the mesh", skips([[extrude, extrude], [prim("fuse", 0)], [prim("cut", 0)]]), [true, false, false]);
  eq("the last group is always meshed", skips([[extrude]]), [false]);
  eq("extrudes before extrudes skip it", skips([[extrude], [extrude], [extrude]]), [true, true, false]);
  eq("a group with one primitive boolean among extrudes is meshed", skips([[extrude, prim("fuse", 0)], [extrude]]), [false, false]);

  // Three triangles on one edge: pieces meeting along a line, inside the box of a primitive at x 0.
  const fan = (x: number) => [x, 1, 0, x, 1, 2, x + 1, 0, 1, x, 1, 0, x, 1, 2, x + 1, 2, 1, x, 1, 0, x, 1, 2, x - 1, 1, 1];
  const clean = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const solid = (positions: number[], volumeMm3 = 100) => ({ volumeMm3, positions });
  eq("the guard reads the solid before only when pieces meet along an edge after", [guardReadsBefore([prim("fuse", 0)], solid(clean)), guardReadsBefore([prim("fuse", 0)], solid(fan(1))), guardReadsBefore([extrude], solid(fan(1))), guardReadsBefore([prim("fuse", 0)], null)], [false, true, false, false]);
  // The same verdict with the mesh before left out whenever the guard does not read it.
  const meshes = [clean, fan(1), [...fan(1), ...fan(1.5)]];
  const opSets = [[prim("fuse", 0)], [prim("cut", 0)], [extrude], [extrude, prim("fuse", 0)], [prim("fuse", 0), prim("fuse", 40)]];
  let same = 0;
  let asked = 0;
  for (const ops of opSets) {
    for (const before of meshes) {
      for (const after of meshes) {
        for (const volumes of [[100, 101], [100, 50]]) {
          const full = queuedGuard(ops, solid(before, volumes[0]), solid(after, volumes[1]));
          const reads = guardReadsBefore(ops, solid(after, volumes[1]));
          if (reads) asked += 1;
          const lean = queuedGuard(ops, solid(reads ? before : [], volumes[0]), solid(after, volumes[1]));
          if (full === lean) same += 1;
        }
      }
    }
  }
  eq("the guard's verdict is the same without the mesh before, whenever it is not read", [same, asked > 0 && asked < 90], [90, true]);
  eq("and a touching edge that was there before is still not this group's", queuedGuard([prim("fuse", 0)], solid(fan(1)), solid(fan(1))), null);

  const prior = { id: 3, volumeMm3: 8000, editable: true, fingerprint: { volumeMm3: 8000, faces: 6, edges: 12 }, positions: new Float32Array(9), triangles: new Uint32Array(3), faces: [], edges: [], lines: [], bounds: { min: [0, 0, 0], max: [20, 20, 20] } } as unknown as SolidView;
  const lite = liteSolid({ id: 7, format: "lime-solid-lite", fingerprint: { volumeMm3: 8100, faces: 10, edges: 24 } }, prior, [{ min: [18, 0, 0], max: [25, 5, 5] }, { min: [-3, 0, 0], max: [1, 5, 30] }]);
  eq("an unmeshed group's solid: its step, volume and fingerprint, no faces, the box grown by its fuse tools", lite && [lite.id, lite.volumeMm3, lite.fingerprint, lite.positions.length, lite.bounds], [7, 8100, { volumeMm3: 8100, faces: 10, edges: 24 }, 0, { min: [-3, 0, 0], max: [25, 20, 30] }]);
  eq("a cut group keeps the part's box", liteSolid({ id: 7, format: "lime-solid-lite", fingerprint: { volumeMm3: 7000, faces: 10, edges: 24 } }, prior, [])?.bounds, { min: [0, 0, 0], max: [20, 20, 20] });
  eq("a meshed reply, or no solid before, is not a light solid", [liteSolid({ id: 7, format: "lime-solid", fingerprint: { volumeMm3: 1, faces: 1, edges: 1 } }, prior, []), liteSolid({ id: 7, format: "lime-solid-lite", fingerprint: { volumeMm3: 1, faces: 1, edges: 1 } }, null, [])], [null, null]);
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("queue: all passed");
