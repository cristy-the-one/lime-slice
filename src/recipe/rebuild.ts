/**
 * --- Plugin steps (docs/plan-recipe-plugins.md D8, milestone 6). A plugin step rebuilt from new values in the app:
 * the plugin runs again from the step before its run, on a new branch, its calls answered by the app
 * (`./app-calls.ts`); the new run is stamped with the values; the steps that followed the old run are built again on
 * it in one engine edit. Nothing on the old branch changes, so the caller makes the whole thing one undo step back to
 * where the part stood.
 *
 * The replay is the MCP session's too (`replayOps`, `replayedTree`), so a rebuild lands on the same tree either way.
 */
import { editRequest, gotoRequest, keepSketch } from "../model-request.ts";
import { forked, stepIds, type ForkStep } from "../model-edit.ts";
import { jumped, pathTo, renumberedSteps, reserveId, withNode, type ModelOp, type ModelTree, type NodeId, type PluginStamp } from "../model-tree.ts";
import { plainModelError } from "../app/model-error.ts";
import { readBroken, readBuilt, solidView, type SolidView } from "../modeling/model-calls.ts";
import { markedRun, sameFingerprint, sameValues, type StampedRun } from "../plugin-step.ts";
import { AppRecipeCalls, type AppRecipePart, type AppTreeCall, type KeptData } from "./app-calls.ts";
import { DEFAULT_LIMITS, type BuildResult, type RecipeCall, type RecipeLimits, type RunOutcome } from "./host.ts";

/** The steps on the way to the shown step that came after a run: what a rebuild of it replays. */
export function laterSteps(tree: ModelTree, run: StampedRun): NodeId[] {
  const shown = pathTo(tree, tree.current);
  const at = shown.indexOf(run.last);
  return at < 0 ? [] : shown.slice(at + 1);
}

/** The ops of steps `ids` of `from`, renumbered for their new ids `fresh` (and `renamed`, the run's own steps). */
export function replayOps(from: ModelTree, ids: readonly NodeId[], fresh: readonly NodeId[], renamed: ReadonlyMap<NodeId, NodeId>): ModelOp[] {
  const map = new Map([...renamed, ...stepIds(ids, fresh)]);
  return ids.map((id) => renumberedSteps(from.nodes.get(id)!.op!, map));
}

/**
 * The tree with the replayed steps `fresh` as a branch under `parent`, as the engine's edit `reply` built them: each
 * with its op as the kernel stored it, its fingerprint, and the old step's label, name, stamp and run marks; a step the
 * engine could not build is kept broken, with the ones under it. The shown step is the last that built.
 */
export function replayedTree(tree: ModelTree, parent: NodeId, fresh: readonly NodeId[], ops: readonly ModelOp[], reply: Record<string, unknown>, from: ModelTree, ids: readonly NodeId[]): { tree: ModelTree; broken: { id: NodeId; error: string } | null } {
  const built = readBuilt(reply.built);
  const broken = readBroken(reply.broken);
  const steps: ForkStep[] = fresh.map((id, i) => {
    const made = built?.get(id);
    return { id, op: made ? keepSketch(made.op, ops[i]!) : ops[i]!, fingerprint: made?.fingerprint ?? null, ...(broken?.id === id ? { broken: broken.error } : {}) };
  });
  const tip = [...steps].reverse().find((step) => !step.broken)?.id ?? fresh[0]!;
  let next = forked(tree, parent, steps, tip);
  fresh.forEach((id, i) => {
    const old = from.nodes.get(ids[i]!)!;
    next = withNode(next, id, { label: old.label, ...(old.name ? { name: old.name } : {}), ...(old.plugin ? { plugin: old.plugin } : {}), ...(old.run ? { run: old.run } : {}) });
  });
  return { tree: next, broken };
}

/** What a rebuild needs of the app's recipes: a build and a run (`AppRecipes`, or a scripted stand-in in tests). */
export interface RecipeRunner {
  build(name: string, source: string, autofix: boolean, suffix?: string): Promise<BuildResult>;
  run(exe: string, start: Record<string, unknown>, call: RecipeCall, limits?: RecipeLimits, signal?: AbortSignal): Promise<RunOutcome>;
}

export interface RebuildInput {
  /** The part as it stands: `tree.current` is the shown step, the run is on the way to it. */
  part: Omit<AppRecipePart, "solid">;
  run: StampedRun & { stamp: PluginStamp };
  /** The code to run, and its ingredients built after it. */
  body: string;
  suffix?: string;
  /** Every value the run is given: the stamped ones with the person's changes over them. */
  params: Record<string, number | boolean | string>;
  /** What the run reads of the printer now. */
  context: { bedMm: [number, number, number]; nozzleMm: number };
  data?: KeptData;
  recipes: RecipeRunner;
  engine: AppTreeCall;
  chordMm: number;
  limits?: RecipeLimits;
  signal?: AbortSignal;
  /** A fresh run id (eight hex characters, as the MCP writes them). */
  runId: string;
}

export type RebuildResult =
  | {
      ok: true;
      /** The part's tree with the new run and the replayed steps, showing the last step that built. */
      tree: ModelTree;
      /** The engine's reply for the shown step: the solid to show. */
      body: Record<string, unknown>;
      solid: SolidView;
      stamp: PluginStamp;
      /** The new run's steps. */
      ids: NodeId[];
      replayed: number;
      broken: { id: NodeId; error: string } | null;
      /** With the same values: whether the plugin built the solid the stamp recorded. */
      sameSolid?: boolean;
      notes: string[];
    }
  | {
      ok: false;
      reason: string;
      line?: number;
      notes: string[];
      /**
       * What the attempt left in the engine, for the caller to take out: the first step it added there (dropped with
       * everything under it), and the tree's next free id, which the caller keeps so no id is handed out twice.
       */
      dropFrom?: NodeId;
      nextId?: number;
    };

/**
 * Builds the plugin and runs it from the step before its run, then replays the later steps. On any failure the engine
 * shows the step the part stood on again and nothing of the attempt is kept (the caller keeps its own tree).
 */
export async function rebuildPluginStep(input: RebuildInput): Promise<RebuildResult> {
  const { part, run, engine } = input;
  const tree = part.tree;
  const from = tree.current;
  const before = run.before;
  if (before === null) return { ok: false, reason: "This part was made by the plugin; the app rebuilds plugin steps on a part it was given. Change these values over MCP (recipe_run {object, params}) for now.", notes: [] };
  const later = laterSteps(tree, run);
  if (later.some((id) => tree.nodes.get(id)?.op?.kind === "partition")) {
    return { ok: false, reason: "A split to print follows this plugin step, and a rebuild cannot cut its pieces again. Undo to before the split, rebuild, then split again.", notes: [] };
  }
  const built = await input.recipes.build(run.stamp.plugin, input.body, false, input.suffix ?? "");
  if (!built.ok || !built.exe) {
    const first = built.diagnostics[0];
    return { ok: false, reason: built.reason ?? (first ? `The plugin did not build: line ${first.line}: ${first.message}` : "The plugin did not build."), ...(first ? { line: first.line } : {}), notes: [] };
  }
  const back = async () => {
    await engine(from, gotoRequest(tree.key, from, input.chordMm));
  };
  /** The attempt's trace, for the caller to drop: set once the run took ids. */
  let left: { dropFrom?: NodeId; nextId?: number } = {};
  // The run starts on the step before the old one: a new branch from there.
  const startReply = await engine(before, gotoRequest(tree.key, before, input.chordMm));
  const startSolid = typeof startReply.error === "string" && startReply.error ? null : solidView(startReply);
  if (!startSolid) {
    await back();
    return { ok: false, reason: `The step before the plugin's run could not be shown: ${typeof startReply.error === "string" ? plainModelError(startReply.error) : "the engine did not answer."}`, notes: [] };
  }
  const calls = new AppRecipeCalls({ ...part, tree: jumped(tree, before), solid: startSolid }, engine, { chordMm: input.chordMm, ...(input.data ? { data: input.data } : {}) });
  const start = { params: input.params, context: { units: "mm", object: part.id, bedMm: input.context.bedMm, nozzleMm: input.context.nozzleMm } };
  const out = await input.recipes.run(built.exe, start, calls.call, input.limits ?? DEFAULT_LIMITS, input.signal);
  const notes = [...calls.notes, ...(out.notes ?? [])];
  if (calls.firstReserved !== null) left = { dropFrom: calls.firstReserved, nextId: calls.result.tree.nextId };
  if (!out.ok || !out.done) {
    await back();
    return { ok: false, reason: out.reason ?? "The plugin failed.", ...(out.line !== undefined ? { line: out.line } : {}), notes, ...left };
  }
  if (out.done.object !== part.id) {
    await back();
    return { ok: false, reason: `The plugin ended on ${out.done.object || "no part"}, not on ${part.id}; nothing was changed.`, notes, ...left };
  }
  const ran = calls.result;
  if (calls.added.length === 0) {
    await back();
    return { ok: false, reason: "With these values the plugin changed nothing, so the step was left as it was.", notes, ...left };
  }
  const values = Object.fromEntries(Object.entries(input.params).filter(([, v]) => typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))) as PluginStamp["params"];
  const stamp: PluginStamp = { ...run.stamp, params: values, context: { bedMm: [...input.context.bedMm], nozzleMm: input.context.nozzleMm }, fingerprint: ran.solid.fingerprint ?? run.stamp.fingerprint };
  let next = markedRun(ran.tree, calls.added, input.runId, stamp);
  const sameSolid = sameValues(run.stamp.params, values) ? sameFingerprint(ran.solid.fingerprint ?? null, run.stamp.fingerprint) : undefined;
  if (sameSolid === false) notes.push("This plugin built a different solid from the same values; the plugin or the app changed since.");
  let body = ran.body ?? startReply;
  let solid = ran.solid;
  let broken: { id: NodeId; error: string } | null = null;
  if (later.length > 0) {
    const tip = next.current;
    const fresh: NodeId[] = [];
    for (let i = 0; i < later.length; i += 1) {
      const [reserved, id] = reserveId(next);
      next = reserved;
      fresh.push(id);
    }
    const renamed = new Map(run.ids.length === calls.added.length ? run.ids.map((id, i) => [id, calls.added[i]!] as const) : []);
    const ops = replayOps(tree, later, fresh, renamed);
    left = { ...left, nextId: next.nextId };
    const reply = await engine(tip, editRequest(tree.key, tip, fresh[0]!, ops[0]!, fresh.slice(1).map((id, i) => ({ id, op: ops[i + 1]! })), input.chordMm));
    if (typeof reply.error === "string" && reply.error) {
      await back();
      return { ok: false, reason: `The plugin ran, but the steps after it could not be built again: ${plainModelError(reply.error)} The rebuild was taken back.`, notes, ...left };
    }
    const replayed = replayedTree(next, tip, fresh, ops, reply, tree, later);
    next = replayed.tree;
    broken = replayed.broken;
    const view = solidView(reply);
    if (view) {
      body = reply;
      solid = view;
    }
  }
  return { ok: true, tree: next, body, solid, stamp, ids: [...calls.added], replayed: later.length, broken, ...(sameSolid !== undefined ? { sameSolid } : {}), notes };
}

/** A run id as the MCP writes them: eight hex characters. */
export function freshRunId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
