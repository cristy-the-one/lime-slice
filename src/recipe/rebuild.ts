/**
 * --- Plugin steps (docs/plan-recipe-plugins.md D8, milestone 6). A plugin step rebuilt from new values in the app:
 * the plugin runs again from the step before its run, on a new branch, or, when it made the part, as a new tree for
 * the same object; its calls are answered by the app (`./app-calls.ts`); the new run is stamped with the values; the
 * steps that followed the old run are built again on it in one engine edit. Nothing of the old history changes, so the
 * caller makes the whole thing one undo step back to where the part stood.
 *
 * The replay is the MCP session's too (`replayOps`, `replayedTree`), so a rebuild lands on the same tree either way.
 */
import { editRequest, gotoRequest, keepSketch } from "../model-request.ts";
import { forked, stepIds, type ForkStep } from "../model-edit.ts";
import { jumped, pathTo, renumberedSteps, reserveId, withNode, type ModelOp, type ModelTree, type NodeId, type PluginStamp, type PluginValue } from "../model-tree.ts";
import { plainModelError } from "../app/model-error.ts";
import { readBroken, readBuilt, solidView, type SolidView } from "../modeling/model-calls.ts";
import { markedRun, sameFingerprint, sameValues, stampValue, type StampedRun } from "../plugin-step.ts";
import { AppRecipeCalls, runSteps, type AppEngine, type AppRecipePart, type AppRunEnv, type RunPart } from "./app-calls.ts";
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
  /** The code to run, and its ingredients built after it (`inlineIngredients`). */
  body: string;
  suffix?: string;
  /** Every value the run is given: the stamped ones with the person's changes over them. */
  params: Record<string, PluginValue>;
  /** What the run reads of the printer now. */
  context: { bedMm: [number, number, number]; nozzleMm: number };
  recipes: RecipeRunner;
  engine: AppEngine;
  /** The window the run reads: chord, recipe data, printer, settings, and ids for what it makes. */
  env: AppRunEnv;
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
      /**
       * The plugin made the part: `tree` is a new tree (its own key) for the same plate object, and `part` holds where the
       * run placed it (`posed`, `placed`). Null when the run grew a branch of the part's own tree.
       */
      made: RunPart | null;
      /** Other trees the run left that the part's steps name: a split's half, a split to print's pieces, a joined tool. */
      others: RunPart[];
    }
  | {
      ok: false;
      reason: string;
      line?: number;
      notes: string[];
      /**
       * What the attempt left in the engine, for the caller to take out: the first step it added to the part (dropped with
       * everything under it), the tree's next free id, which the caller keeps so no id is handed out twice, and the new
       * trees it opened (closed).
       */
      dropFrom?: NodeId;
      nextId?: number;
      close?: string[];
    };

/**
 * Builds the plugin and runs it again: from the step before its run on a new branch, or, for a part the plugin made,
 * as a new tree for the same object. Then replays the later steps. On any failure the engine shows the step the part
 * stood on again and nothing of the attempt is kept (the caller keeps its own tree).
 */
export async function rebuildPluginStep(input: RebuildInput): Promise<RebuildResult> {
  const { part, run, engine } = input;
  const tree = part.tree;
  const from = tree.current;
  const chordMm = input.env.chordMm;
  const madeIt = run.before === null;
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
    await engine.tree(tree.key, from, gotoRequest(tree.key, from, chordMm));
  };
  // A part the plugin was given runs from the step before the old run, a new branch from there; a part it made is
  // made again, from nothing, as the MCP's rerun makes it.
  let calls: AppRecipeCalls;
  let startReply: Record<string, unknown> | null = null;
  if (!madeIt) {
    startReply = await engine.tree(tree.key, run.before!, gotoRequest(tree.key, run.before!, chordMm));
    const startSolid = typeof startReply.error === "string" && startReply.error ? null : solidView(startReply);
    if (!startSolid) {
      await back();
      return { ok: false, reason: `The step before the plugin's run could not be shown: ${typeof startReply.error === "string" ? plainModelError(startReply.error) : "the engine did not answer."}`, notes: [] };
    }
    calls = new AppRecipeCalls({ ...part, tree: jumped(tree, run.before!), solid: startSolid }, engine, input.env);
  } else calls = new AppRecipeCalls(null, engine, input.env);
  calls.params = input.params;
  const start = { params: input.params, context: { units: "mm", ...(madeIt ? {} : { object: part.id }), bedMm: input.context.bedMm, nozzleMm: input.context.nozzleMm } };
  const out = await input.recipes.run(built.exe, start, calls.call, input.limits ?? DEFAULT_LIMITS, input.signal);
  const notes = [...calls.notes, ...(out.notes ?? [])];
  const given = calls.given;
  const opened = calls.all.filter((row) => row.origin !== "given").map((row) => row.tree.key);
  /** The attempt's trace, for the caller to drop. */
  const left = (next?: ModelTree) => ({
    ...(given?.firstReserved != null ? { dropFrom: given.firstReserved, nextId: (next ?? given.tree).nextId } : {}),
    ...(opened.length ? { close: opened } : {}),
  });
  const refuse = async (reason: string, extra: { line?: number } = {}) => {
    await back();
    return { ok: false as const, reason, ...extra, notes, ...left() };
  };
  if (!out.ok || !out.done) return refuse(out.reason ?? "The plugin failed.", out.line !== undefined ? { line: out.line } : {});
  // --- O4. A stamped run made at most one part and changed at most the part it was given: so must its rebuild.
  const made = calls.all.filter((row) => row.origin === "made" && !row.consumed);
  let target: RunPart;
  if (madeIt) {
    if (made.length !== 1) return refuse(made.length === 0 ? "With these values the plugin made no part, so the part was left as it was." : `With these values the plugin makes ${made.length} parts; a plugin step stands for one. Run it again from Plugins to make them.`);
    target = made[0]!;
  } else {
    if (made.length > 0) return refuse(`With these values the plugin also makes ${made.map((row) => row.name).join(", ")}; a plugin step changes only its own part. Run it again from Plugins to make ${made.length === 1 ? "it" : "them"}.`);
    target = given!;
  }
  if (out.done.object !== target.id) return refuse(`The plugin ended on ${out.done.object || "no part"}, not on ${madeIt ? "the part it made" : part.id}; nothing was changed.`);
  const ids = runSteps(target);
  if (ids.length === 0) return refuse("With these values the plugin changed nothing, so the step was left as it was.");
  if (!target.solid) return refuse("The solid the plugin built could not be read.");
  const values = Object.fromEntries(Object.entries({ ...input.params, ...calls.picked }).filter(([, v]) => stampValue(v))) as PluginStamp["params"];
  const stamp: PluginStamp = { ...run.stamp, params: values, context: { bedMm: [...input.context.bedMm], nozzleMm: input.context.nozzleMm }, fingerprint: target.solid.fingerprint ?? run.stamp.fingerprint };
  let next = markedRun(target.tree, ids, input.runId, stamp);
  const sameSolid = sameValues(run.stamp.params, values) ? sameFingerprint(target.solid.fingerprint ?? null, run.stamp.fingerprint) : undefined;
  if (sameSolid === false) notes.push("This plugin built a different solid from the same values; the plugin or the app changed since.");
  let body = target.body ?? startReply ?? {};
  let solid = target.solid;
  let broken: { id: NodeId; error: string } | null = null;
  if (later.length > 0) {
    const tip = next.current;
    const fresh: NodeId[] = [];
    for (let i = 0; i < later.length; i += 1) {
      const [reserved, id] = reserveId(next);
      next = reserved;
      fresh.push(id);
    }
    const renamed = new Map(run.ids.length === ids.length ? run.ids.map((id, i) => [id, ids[i]!] as const) : []);
    const ops = replayOps(tree, later, fresh, renamed);
    const reply = await engine.tree(next.key, tip, editRequest(next.key, tip, fresh[0]!, ops[0]!, fresh.slice(1).map((id, i) => ({ id, op: ops[i + 1]! })), chordMm));
    if (typeof reply.error === "string" && reply.error) {
      await back();
      return { ok: false, reason: `The plugin ran, but the steps after it could not be built again: ${plainModelError(reply.error)} The rebuild was taken back.`, notes, ...left(next) };
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
  const others = calls.all.filter((row) => row !== target && row.origin !== "given" && (row.origin !== "made" || row.consumed));
  return { ok: true, tree: next, body, solid, stamp, ids, replayed: later.length, broken, ...(sameSolid !== undefined ? { sameSolid } : {}), notes, made: madeIt ? target : null, others };
}

/** A run id as the MCP writes them: eight hex characters. */
export function freshRunId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
