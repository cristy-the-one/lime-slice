/**
 * --- Plugin steps (docs/plan-recipe-plugins.md D8). A recipe run's steps stay ordinary nodes; its first node carries
 * the stamp of what ran, and every node of it the run's id and its place in it. These read and write those marks, for
 * the MCP session and the app alike. Nothing here asks the engine anything.
 */
import { pathTo, redoTarget, type ModelNode, type ModelTree, type NodeId, type PluginStamp } from "./model-tree.ts";

/** The recipe API level this app's plugins are built against: `lime_recipe::API` (checked by `src/plugin-step.test.ts`). */
export const RECIPE_API: readonly [number, number] = [1, 9];

/** A whole run on one chain: its first and last nodes, the step before it (null when it starts at the root) and its stamp. */
export interface StampedRun {
  id: string;
  first: NodeId;
  last: NodeId;
  ids: NodeId[];
  before: NodeId | null;
  stamp: PluginStamp | null;
}

/** The nodes `ids`, in order, marked as one run, the first stamped. */
export function markedRun(tree: ModelTree, ids: readonly NodeId[], runId: string, stamp: PluginStamp | null): ModelTree {
  if (ids.length === 0) return tree;
  const nodes = new Map(tree.nodes);
  ids.forEach((id, i) => {
    const node = nodes.get(id);
    if (!node) return;
    const { plugin: _plugin, run: _run, ...rest } = node;
    nodes.set(id, { ...rest, ...(i === 0 && stamp ? { plugin: stamp } : {}), run: { id: runId, k: i + 1, n: ids.length } });
  });
  return { ...tree, nodes };
}

/** The run that ends at `id`, when its nodes run 1 … n up the parents with nothing missing. */
export function runEndingAt(tree: ModelTree, id: NodeId): StampedRun | null {
  const last = tree.nodes.get(id);
  const run = last?.run;
  if (!last || !run || run.k !== run.n) return null;
  const chain: ModelNode[] = [];
  let at: ModelNode | undefined = last;
  for (let k = run.n; k >= 1; k -= 1) {
    if (!at || at.run?.id !== run.id || at.run.k !== k || at.run.n !== run.n) return null;
    chain.push(at);
    at = k === 1 || at.parent === null ? undefined : tree.nodes.get(at.parent);
  }
  chain.reverse();
  const first = chain[0]!;
  return { id: run.id, first: first.id, last: id, ids: chain.map((node) => node.id), before: first.parent, stamp: first.plugin ?? null };
}

/** The run Redo would walk whole: the next step is a run's first, and the followed children reach its last. */
export function runRedoFrom(tree: ModelTree): StampedRun | null {
  const next = redoTarget(tree);
  let at = next == null ? undefined : tree.nodes.get(next);
  const run = at?.run;
  if (!at || !run || run.k !== 1) return null;
  for (let k = 1; k < run.n; k += 1) {
    const child: NodeId | undefined = tree.lastChild.get(at.id);
    at = child == null ? undefined : tree.nodes.get(child);
    if (!at || at.run?.id !== run.id || at.run.k !== k + 1) return null;
  }
  return runEndingAt(tree, at.id);
}

/** The whole runs on the way to `to` (the shown step by default), oldest first. */
export function runsOnPath(tree: ModelTree, to: NodeId = tree.current): StampedRun[] {
  const out: StampedRun[] = [];
  for (const id of pathTo(tree, to)) {
    const found = runEndingAt(tree, id);
    if (found) out.push(found);
  }
  return out;
}

/** The newest stamped run of `plugin` on the way to the shown step, the one a rebuild changes. */
export function stampedRunOf(tree: ModelTree, plugin: string): StampedRun | null {
  return [...runsOnPath(tree)].reverse().find((row) => row.stamp?.plugin === plugin) ?? null;
}

/** Whether two fingerprints name the same solid: the same faces and edges, and the volume within a millionth. */
export function sameFingerprint(a: { volumeMm3: number; faces: number; edges: number } | null, b: { volumeMm3: number; faces: number; edges: number } | null): boolean {
  if (!a || !b) return false;
  return a.faces === b.faces && a.edges === b.edges && Math.abs(a.volumeMm3 - b.volumeMm3) <= 1e-6 * Math.max(1, Math.abs(b.volumeMm3));
}

/** Whether two parameter sets hold the same values, by name. A picked face or outline (API 1.2) compares by its JSON. */
export function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (x === y) continue;
    if (x && y && typeof x === "object" && typeof y === "object" && JSON.stringify(x) === JSON.stringify(y)) continue;
    return false;
  }
  return true;
}

/** A stamp's value: a number, toggle, choice or text, or a picked face or outline as JSON (API 1.2). */
export function stampValue(value: unknown): boolean {
  if (typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return !!value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(value).length <= 200_000;
}
