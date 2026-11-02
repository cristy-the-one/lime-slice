/**
 * --- The Plugins panel's run (docs/plan-recipe-plugins.md D13, milestone 7). A plugin from the library or the project
 * runs fresh: on the part on screen from its shown step, or with no part when it makes its own, its calls answered by
 * the app (`./app-calls.ts`) as a rebuild's are. At `done` the run is stamped (D8) so the step can change later: on the
 * part's new branch, or on the root of the one part it made. Preview shows that solid and takes the run back; Apply
 * keeps it as one History row (or one new object) and one undo step.
 */
import { gotoRequest } from "../model-request.ts";
import type { ModelTree, NodeId, PluginStamp } from "../model-tree.ts";
import { plainModelError } from "../app/model-error.ts";
import { solidView, type SolidView } from "../modeling/model-calls.ts";
import { markedRun } from "../plugin-step.ts";
import { AppRecipeCalls, runSteps, type AppEngine, type AppRecipePart, type AppRunEnv, type RunPart } from "./app-calls.ts";
import { DEFAULT_LIMITS, type RecipeLimits } from "./host.ts";
import type { RecipeRunner } from "./rebuild.ts";

export interface PluginRunInput {
  /** The part on screen, when the run is given one: it starts on `tree.current`. Null runs with no part. */
  part: Omit<AppRecipePart, "solid"> | null;
  /** What the stamp names: the plugin, its version, its body's hash and recipe API level. */
  plugin: { id: string; version: number; sha256: string; api: string };
  body: string;
  /** Its ingredients, built after it (`inlineIngredients`). */
  suffix?: string;
  /** The values the run is given (the form's, where they differ from the defaults). */
  params: Record<string, number | boolean | string>;
  context: { bedMm: [number, number, number]; nozzleMm: number };
  recipes: RecipeRunner;
  engine: AppEngine;
  env: AppRunEnv;
  limits?: RecipeLimits;
  signal?: AbortSignal;
  runId: string;
}

/** What a run left in the engine, for the caller to take out: steps on the given part, and trees it opened. */
export interface RunTrace {
  dropFrom?: NodeId;
  nextId?: number;
  close?: string[];
}

export type PluginRunOutcome =
  | ({
      ok: true;
      /** The kept part's tree with the run stamped, showing its last step: the given part's, or the made part's. */
      tree: ModelTree;
      /** The engine's reply for that step: the solid to show. */
      body: Record<string, unknown>;
      solid: SolidView;
      stamp: PluginStamp;
      ids: NodeId[];
      /** The part the run made, when it made one (then the given part, if any, is unchanged). */
      made: RunPart | null;
      /** Other trees the kept steps name: a split's half, a split to print's pieces, a joined tool. */
      others: RunPart[];
      notes: string[];
    } & RunTrace)
  | ({ ok: false; reason: string; line?: number; notes: string[] } & RunTrace);

/** Build the plugin and run it. On a failure the engine shows the given part's step again. */
export async function runPluginFresh(input: PluginRunInput): Promise<PluginRunOutcome> {
  const { part, engine } = input;
  const chordMm = input.env.chordMm;
  const built = await input.recipes.build(input.plugin.id, input.body, false, input.suffix ?? "");
  if (!built.ok || !built.exe) {
    const first = built.diagnostics[0];
    return { ok: false, reason: built.reason ?? (first ? `The plugin did not build: line ${first.line}: ${first.message}` : "The plugin did not build."), ...(first ? { line: first.line } : {}), notes: [] };
  }
  const from = part?.tree.current ?? null;
  const back = async () => {
    if (part && from !== null) await engine.tree(part.tree.key, from, gotoRequest(part.tree.key, from, chordMm));
  };
  let calls: AppRecipeCalls;
  if (part) {
    const startReply = await engine.tree(part.tree.key, from!, gotoRequest(part.tree.key, from!, chordMm));
    const startSolid = typeof startReply.error === "string" && startReply.error ? null : solidView(startReply);
    if (!startSolid) return { ok: false, reason: `The part could not be shown: ${typeof startReply.error === "string" ? plainModelError(startReply.error) : "the engine did not answer."}`, notes: [] };
    calls = new AppRecipeCalls({ ...part, solid: startSolid }, engine, input.env);
  } else calls = new AppRecipeCalls(null, engine, input.env);
  const start = { params: input.params, context: { units: "mm", ...(part ? { object: part.id } : {}), bedMm: input.context.bedMm, nozzleMm: input.context.nozzleMm } };
  const out = await input.recipes.run(built.exe, start, calls.call, input.limits ?? DEFAULT_LIMITS, input.signal);
  const notes = [...calls.notes, ...(out.notes ?? [])];
  const given = calls.given;
  const opened = calls.all.filter((row) => row.origin !== "given").map((row) => row.tree.key);
  const trace: RunTrace = {
    ...(given?.firstReserved != null ? { dropFrom: given.firstReserved, nextId: given.tree.nextId } : {}),
    ...(opened.length ? { close: opened } : {}),
  };
  const refuse = async (reason: string, extra: { line?: number } = {}) => {
    await back();
    return { ok: false as const, reason, ...extra, notes, ...trace };
  };
  if (!out.ok || !out.done) return refuse(out.reason ?? "The plugin failed.", out.line !== undefined ? { line: out.line } : {});
  // --- O4. A plugin step stands for one part: the one it made, or the one it was given.
  const made = calls.all.filter((row) => row.origin === "made" && !row.consumed);
  const changedGiven = !!given && runSteps(given).length > 0;
  if (made.length > 1) return refuse(`With these values the plugin makes ${made.length} parts, and the window keeps one part per run for now. Run it over MCP (recipe_run {plugin}) to make them all.`);
  if (made.length === 1 && changedGiven) return refuse(`The plugin both changed ${given!.name} and made ${made[0]!.name}, and the window keeps one part per run for now. Run it over MCP (recipe_run {plugin}).`);
  const target = made[0] ?? given;
  if (!target) return refuse("The plugin made no part. Change a value, then run it again.");
  if (out.done.object !== target.id) return refuse(`The plugin ended on ${out.done.object || "no part"}, not on ${target.name}, so nothing was kept. Run it on the part it makes or changes.`);
  const ids = runSteps(target);
  if (ids.length === 0) return refuse("With these values the plugin changed nothing. Change a value, then run it again.");
  if (!target.solid) return refuse("The solid the plugin built could not be read. Run it again.");
  const params = Object.fromEntries(Object.entries(input.params).filter(([, v]) => typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))) as PluginStamp["params"];
  const stamp: PluginStamp = { plugin: input.plugin.id, version: input.plugin.version, sha256: input.plugin.sha256, api: input.plugin.api, params, context: { bedMm: [...input.context.bedMm], nozzleMm: input.context.nozzleMm }, fingerprint: target.solid.fingerprint ?? null };
  const others = calls.all.filter((row) => row !== target && row.origin !== "given" && (row.origin !== "made" || row.consumed));
  return { ok: true, tree: markedRun(target.tree, ids, input.runId, stamp), body: target.body ?? {}, solid: target.solid, stamp, ids, made: made[0] ?? null, others, notes, ...trace };
}
