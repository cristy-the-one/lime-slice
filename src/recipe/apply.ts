/**
 * --- The Plugins panel's run on a part (docs/plan-recipe-plugins.md D13, milestone 7). A plugin from the library or
 * the project runs on the part on screen, from the shown step, its calls answered by the app (`./app-calls.ts`) as a
 * rebuild's are. The run grows a branch in a copy of the part's tree; at `done` it is stamped (D8) so the step can
 * change later. Preview shows that branch's solid and drops it; Apply keeps it as one History row and one undo step.
 */
import { gotoRequest } from "../model-request.ts";
import type { ModelTree, NodeId, PluginStamp } from "../model-tree.ts";
import { plainModelError } from "../app/model-error.ts";
import { solidView, type SolidView } from "../modeling/model-calls.ts";
import { markedRun } from "../plugin-step.ts";
import { AppRecipeCalls, type AppRecipePart, type AppTreeCall } from "./app-calls.ts";
import { DEFAULT_LIMITS, type RecipeLimits } from "./host.ts";
import type { RecipeRunner } from "./rebuild.ts";

export interface PluginRunInput {
  /** The part as it stands: the run starts on `tree.current`. */
  part: Omit<AppRecipePart, "solid">;
  /** What the stamp names: the plugin, its version, its body's hash and recipe API level. */
  plugin: { id: string; version: number; sha256: string; api: string };
  body: string;
  suffix?: string;
  /** The values the run is given (the form's, where they differ from the defaults). */
  params: Record<string, number | boolean | string>;
  context: { bedMm: [number, number, number]; nozzleMm: number };
  recipes: RecipeRunner;
  engine: AppTreeCall;
  chordMm: number;
  limits?: RecipeLimits;
  signal?: AbortSignal;
  runId: string;
}

export type PluginRunOutcome =
  | {
      ok: true;
      /** The part's tree with the new run, showing its last step. */
      tree: ModelTree;
      /** The engine's reply for that step: the solid to show. */
      body: Record<string, unknown>;
      solid: SolidView;
      stamp: PluginStamp;
      ids: NodeId[];
      notes: string[];
    }
  | { ok: false; reason: string; line?: number; notes: string[]; dropFrom?: NodeId; nextId?: number };

/** Build the plugin and run it on the part from the shown step. On a failure the engine shows that step again. */
export async function runPluginOnPart(input: PluginRunInput): Promise<PluginRunOutcome> {
  const { part, engine } = input;
  const tree = part.tree;
  const from = tree.current;
  const built = await input.recipes.build(input.plugin.id, input.body, false, input.suffix ?? "");
  if (!built.ok || !built.exe) {
    const first = built.diagnostics[0];
    return { ok: false, reason: built.reason ?? (first ? `The plugin did not build: line ${first.line}: ${first.message}` : "The plugin did not build."), ...(first ? { line: first.line } : {}), notes: [] };
  }
  const back = async () => {
    await engine(from, gotoRequest(tree.key, from, input.chordMm));
  };
  const startReply = await engine(from, gotoRequest(tree.key, from, input.chordMm));
  const startSolid = typeof startReply.error === "string" && startReply.error ? null : solidView(startReply);
  if (!startSolid) return { ok: false, reason: `The part could not be shown: ${typeof startReply.error === "string" ? plainModelError(startReply.error) : "the engine did not answer."}`, notes: [] };
  const calls = new AppRecipeCalls({ ...part, tree, solid: startSolid }, engine, { chordMm: input.chordMm });
  const start = { params: input.params, context: { units: "mm", object: part.id, bedMm: input.context.bedMm, nozzleMm: input.context.nozzleMm } };
  const out = await input.recipes.run(built.exe, start, calls.call, input.limits ?? DEFAULT_LIMITS, input.signal);
  const notes = [...calls.notes, ...(out.notes ?? [])];
  const left = calls.firstReserved !== null ? { dropFrom: calls.firstReserved, nextId: calls.result.tree.nextId } : {};
  if (!out.ok || !out.done) {
    await back();
    return { ok: false, reason: out.reason ?? "The plugin failed.", ...(out.line !== undefined ? { line: out.line } : {}), notes, ...left };
  }
  if (out.done.object !== part.id) {
    await back();
    return { ok: false, reason: `The plugin ended on ${out.done.object || "no part"}, not on ${part.id}, so nothing was changed. Run it on the part it makes or changes.`, notes, ...left };
  }
  if (calls.added.length === 0) {
    await back();
    return { ok: false, reason: "With these values the plugin changed nothing. Change a value, then run it again.", notes, ...left };
  }
  const ran = calls.result;
  const params = Object.fromEntries(Object.entries(input.params).filter(([, v]) => typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))) as PluginStamp["params"];
  const fingerprint = ran.solid.fingerprint ?? null;
  const stamp: PluginStamp = { plugin: input.plugin.id, version: input.plugin.version, sha256: input.plugin.sha256, api: input.plugin.api, params, context: { bedMm: [...input.context.bedMm], nozzleMm: input.context.nozzleMm }, fingerprint };
  return { ok: true, tree: markedRun(ran.tree, calls.added, input.runId, stamp), body: ran.body ?? startReply, solid: ran.solid, stamp, ids: [...calls.added], notes };
}
