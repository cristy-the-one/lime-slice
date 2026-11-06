/**
 * Several parts from one plugin run (docs/plan-recipe-plugins.md, O4 as built in the window): where the made parts go,
 * the one shape a Preview draws for them, the sentence naming them, and the parts that share a run.
 */
import { IDENTITY_POSE, type Affine } from "./model-space.ts";
import { newTree, withChild, type ModelOp, type ModelTree } from "./model-tree.ts";
import { madePoses, mergedSolid, partNames, runSiblings } from "./plugin-parts.ts";
import { markedRun } from "./plugin-step.ts";

let failed = 0;
function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** A 10 × 10 × 10 box's corners as a flat mesh (two triangles are enough for bounds and merging). */
const cube = (s = 10) => new Float32Array([0, 0, 0, s, 0, 0, s, s, s, 0, 0, 0, s, s, s, 0, s, 0]);
const moved = (t: [number, number, number]): Affine => ({ m: [...IDENTITY_POSE.m] as Affine["m"], t });

// --- Poses: on an empty plate the first part stays at the origin; the next ones line up beside it along X.
{
  const poses = madePoses([{ positions: cube(), posed: null }, { positions: cube(), posed: null }, { positions: cube(), posed: null }], []);
  eq("first part at the origin", poses[0]!.t, [0, 0, 0]);
  eq("second beside the first along X", poses[1]!.t[0] > 10, true);
  eq("third beside the second", poses[2]!.t[0] > poses[1]!.t[0] + 10, true);
  eq("they share Y and Z", [poses[1]!.t[1], poses[1]!.t[2], poses[2]!.t[1], poses[2]!.t[2]], [0, 0, 0, 0]);
}
// A placed part keeps the plugin's pose; an unplaced one goes beside it and the plate, never on top.
{
  const lid = moved([0, 0, 30]);
  const poses = madePoses([{ positions: cube(), posed: null }, { positions: cube(), posed: lid }], [{ min: [0, 0, 0], max: [40, 10, 10] }]);
  eq("a placed part keeps its pose", poses[1], lid);
  eq("an unplaced part clears the plate's parts", poses[0]!.t[0] >= 40, true);
}

// --- One shape: positions moved by each pose, faces numbered on, edges moved, volumes added.
{
  const a = { volumeMm3: 1000, positions: cube(), triangles: new Uint32Array([0, 1]), edges: [{ id: 0, lengthMm: 10, points: new Float32Array([0, 0, 0, 10, 0, 0]) }] };
  const merged = mergedSolid([{ solid: a, pose: IDENTITY_POSE }, { solid: a, pose: moved([20, 0, 0]) }]);
  eq("volumes add", merged.volumeMm3, 2000);
  eq("every vertex is kept", merged.positions.length, 36);
  eq("the second part moved", Array.from(merged.positions.slice(18, 21)), [20, 0, 0]);
  eq("faces numbered on", Array.from(merged.triangles), [0, 1, 2, 3]);
  eq("edges moved with their part", Array.from(merged.edges[1]!.points), [20, 0, 0, 30, 0, 0]);
  eq("edge ids are their order", merged.edges.map((edge) => edge.id), [0, 1]);
}

// --- Names.
eq("one name", partNames(["Lid"]), "Lid");
eq("two names", partNames(["Lid", "Base"]), "Lid and Base");
eq("three names", partNames(["Lid", "Base", "Gear"]), "Lid, Base and Gear");
eq("many names", partNames(["Lid", "Base", "Gear", "Pin", "Dial"]), "Lid, Base, Gear and 2 more");

// --- Parts of one run: the plate objects whose shown history holds a step of that run, not the one asked about.
{
  const op: ModelOp = { kind: "boolean", op: "cut", primitive: "box", size: [1, 1, 1], origin: [0, 0, 0] } as unknown as ModelOp;
  const made = (key: string, run: string | null): ModelTree => {
    const t = newTree(key, { kind: "primitive", solid: { primitive: "box", size: [10, 10, 10] } } as never, "box", null);
    const root = t.current;
    const grown = withChild(t, root, { id: t.nextId, op, label: "cut", fingerprint: null });
    return run ? markedRun(grown, [root, t.nextId], run, null) : grown;
  };
  const parts = [
    { id: "a", tree: made("a-tree", "c0ffee01") },
    { id: "b", tree: made("b-tree", "c0ffee01") },
    { id: "c", tree: made("c-tree", "deadbeef") },
    { id: "d", tree: made("d-tree", null) },
    { id: "e", tree: undefined },
  ];
  eq("the run's other parts", runSiblings(parts, "c0ffee01", "a"), ["b"]);
  eq("a run of one part has none", runSiblings(parts, "deadbeef", "c"), []);
}

if (failed) {
  console.error(`plugin-parts: ${failed} failed`);
  process.exit(1);
}
console.log("plugin-parts: ok");
