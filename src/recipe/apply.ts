/**
 * --- The Plugins panel's run (docs/plan-recipe-plugins.md D13, milestone 7). A plugin from the library or the project
 * runs fresh: on the part on screen from its shown step, or with no part when it makes its own, its calls answered by
 * the app (`./app-calls.ts`) as a rebuild's are. At `done` the run is stamped (D8) so the step can change later: on the
 * part's new branch, and on the root of every part it made, one run id shared by them all (as the MCP stamps them).
 * Preview shows those solids and takes the run back; Apply keeps them as one History row on the given part and one new
 * object per made part, all one undo step.
 */
import { gotoRequest } from "../model-request.ts";
import type { ModelTree, NodeId, PluginStamp, PluginValue } from "../model-tree.ts";
import { plainModelError } from "../app/model-error.ts";
import { solidView, type SolidView } from "../modeling/model-calls.ts";
import { markedRun, stampValue } from "../plugin-step.ts";
import { AppRecipeCalls, runSteps, type AppEngine, type AppRecipePart, type AppRunEnv, type RunPart } from "./app-calls.ts";
import { DEFAULT_LIMITS, MAX_APP_RECIPE_PARTS, type RecipeLimits } from "./host.ts";
import { carriedEnv, splitPluginData } from "./plugin-data.ts";
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
  params: Record<string, PluginValue>;
  context: { bedMm: [number, number, number]; nozzleMm: number };
  recipes: RecipeRunner;
  engine: AppEngine;
  env: AppRunEnv;
  limits?: RecipeLimits;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
  runId: string;
}

/** What a run left in the engine, for the caller to take out: steps on the given part, and trees it opened. */
export interface RunTrace {
  dropFrom?: NodeId;
  nextId?: number;
  close?: string[];
}

/** At most this many parts one run keeps (made, and the given part): more is a count gone wrong, not a plate. */
export const MAX_RUN_PARTS = MAX_APP_RECIPE_PARTS;

/** One part a run kept: its tree with the run stamped, the engine's reply for its shown step, and its solid. */
export interface KeptPart {
  part: RunPart;
  tree: ModelTree;
  body: Record<string, unknown>;
  solid: SolidView;
  stamp: PluginStamp;
  /** The run's steps on it: a made part's whole path, the given part's steps after where it stood. */
  ids: NodeId[];
}

export type PluginRunOutcome =
  | ({
      ok: true;
      /** The part the run ended on (`done`): its tree with the run stamped, showing its last step. */
      tree: ModelTree;
      /** The engine's reply for that step: the solid to show. */
      body: Record<string, unknown>;
      solid: SolidView;
      stamp: PluginStamp;
      ids: NodeId[];
      /** The part the run ended on, when the run made it. */
      made: RunPart | null;
      /** Every part the run kept: the given part first when the run changed it, then each part it made, in order. */
      kept: KeptPart[];
      /** Other trees the kept steps name: a split's half, a split to print's pieces, a joined tool. */
      others: RunPart[];
      notes: string[];
    } & RunTrace)
  | ({ ok: false; reason: string; line?: number; notes: string[] } & RunTrace);

/** Build the plugin and run it. On a failure the engine shows the given part's step again. */
export async function runPluginFresh(input: PluginRunInput): Promise<PluginRunOutcome> {
  const { part, engine } = input;
  const chordMm = input.env.chordMm;
  // The host builds the code; the data a kept plugin carries answers `data {name}` after the step's own.
  const split = splitPluginData(input.body);
  if (split.problem) return { ok: false, reason: split.problem, notes: [] };
  const env = carriedEnv(input.env, input.plugin.version, split.data);
  const built = await input.recipes.build(input.plugin.id, split.code, false, input.suffix ?? "");
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
    calls = new AppRecipeCalls({ ...part, solid: startSolid }, engine, env);
  } else calls = new AppRecipeCalls(null, engine, env);
  calls.params = input.params;
  const start = { params: input.params, context: { units: "mm", host: "app", limits: { maxParts: MAX_APP_RECIPE_PARTS, canAssemble: false, canCheckpoint: false, timeLimitS: (input.limits ?? DEFAULT_LIMITS).timeoutS }, ...(part ? { object: part.id } : {}), bedMm: input.context.bedMm, nozzleMm: input.context.nozzleMm } };
  const out = await input.recipes.run(built.exe, start, calls.call, input.limits ?? DEFAULT_LIMITS, input.signal, input.onProgress);
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
  // --- Several parts (O4 as built in the window): every part the run made is kept, and the given part when the run
  // changed it, each stamped with the same run id and values and its own fingerprint, as the MCP stamps them.
  const made = calls.all.filter((row) => row.origin === "made" && !row.consumed);
  const changedGiven = !!given && runSteps(given).length > 0;
  const parts = [...(changedGiven ? [given!] : []), ...made];
  if (parts.length === 0) {
    if (given) return refuse(`The plugin changed nothing on ${given.name}. Check that ${given.name} is the kind of part this plugin works on (its description says what it needs), or change a value and run it again.`);
    return refuse("The plugin made no part. Change a value, then run it again.");
  }
  if (parts.length > MAX_RUN_PARTS) return refuse(`With these values the plugin makes ${parts.length} parts, more than the ${MAX_RUN_PARTS} one run may keep. Lower the count it makes, then run it again.`);
  const target = parts.find((row) => row.id === out.done!.object);
  if (!target) return refuse(`The plugin ended on ${out.done.object || "no part"}, not on ${parts.length === 1 ? parts[0]!.name : "a part it made or changed"}, so nothing was kept. Run it on the part it makes or changes.`);
  const unread = parts.find((row) => !row.solid);
  if (unread) return refuse(`The solid the plugin built for ${unread.name} could not be read. Run it again.`);
  const params = Object.fromEntries(Object.entries({ ...input.params, ...calls.picked }).filter(([, v]) => stampValue(v))) as PluginStamp["params"];
  const fields: Omit<PluginStamp, "fingerprint"> = { plugin: input.plugin.id, version: input.plugin.version, sha256: input.plugin.sha256, api: input.plugin.api, params, context: { bedMm: [...input.context.bedMm], nozzleMm: input.context.nozzleMm } };
  const kept: KeptPart[] = parts.map((row) => {
    const ids = runSteps(row);
    const stamp: PluginStamp = { ...fields, fingerprint: row.solid!.fingerprint ?? null };
    return { part: row, tree: markedRun(row.tree, ids, input.runId, stamp), body: row.body ?? {}, solid: row.solid!, stamp, ids };
  });
  const shown = kept[parts.indexOf(target)]!;
  const others = calls.all.filter((row) => !parts.includes(row) && row.origin !== "given" && (row.origin !== "made" || row.consumed));
  return { ok: true, tree: shown.tree, body: shown.body, solid: shown.solid, stamp: shown.stamp, ids: shown.ids, made: target.origin === "made" ? target : null, kept, others, notes, ...trace };
}
