/**
 * --- Recipes that use plugins in the app (recipe API 1.16, docs/plan-plugin-recipes.md). A plugin run in the window
 * (`./apply.ts`, `./rebuild.ts`) that calls `plugin_run` runs the kept plugin it names as a nested run: built by the
 * app's runner in a slot of its own, its calls answered by an `AppRecipeCalls` of its own (its own parts only), inside
 * the outer run's time and calls. The parts a nested run made become the outer run's (`AppRecipeCalls.adopt`), which
 * the window keeps or takes back with the rest. The rules are the MCP server's (`./nested.ts`); the code comes from the
 * project's copies and the library the window read, and a plugin that needs its first run approved never runs hidden.
 */
import { RECIPE_API } from "../plugin-step.ts";
import { readPluginFile, type PluginFileInfo } from "../plugin-file.ts";
import type { PluginPins } from "../model-tree.ts";
import { apiVerdict } from "./api-level.ts";
import { AppRecipeCalls, type AppEngine, type AppRunEnv } from "./app-calls.ts";
import { DEFAULT_LIMITS, MAX_APP_RECIPE_PARTS, unreadKeys, type RecipeLimits, type RecipeReply } from "./host.ts";
import { inlineIngredients } from "./ingredients.ts";
import { nestedLimits, nestedRefusal, nestedResult, nestingRefusal, pickPluginCode, readPluginRun, type PluginCode, type PluginSources } from "./nested.ts";
import { splitPluginData } from "./plugin-data.ts";
import type { RecipeRunner } from "./rebuild.ts";
import { strictQueueFailure } from "./strict.ts";

/** Where the window finds a plugin's code, and whether a person must see it first. */
export interface AppPluginSources {
  /** The code of `id` (`PluginSources`): the project's copies, the library's current and older files. */
  sources(id: string): PluginSources;
  /** A sentence when `file` must be shown to a person before it runs (`needsFirstRun`); null when it may run. */
  untrusted(file: PluginFileInfo, sha256: string): string | null;
}

/** What a run of the window hands its nested runs, and collects from them. */
export interface AppNestedRun {
  recipes: RecipeRunner;
  engine: AppEngine;
  env: AppRunEnv;
  plugins: AppPluginSources;
  context: { bedMm: [number, number, number]; nozzleMm: number };
  /** The runs around the next one, outermost first. */
  stack: string[];
  /** The pins of the outermost run's stamp. */
  pins: PluginPins;
  limits: RecipeLimits;
  deadline: number;
  signal?: AbortSignal;
  /** Every plugin a nested run ran, with its code, for the stamp's pins and the project's copies. */
  used: Map<string, PluginCode>;
}

/** The `plugin_run` answer for a run of the window: the nested run, its parts adopted by `parent` when it reached done. */
export async function runNestedInApp(args: Record<string, unknown>, parent: AppRecipeCalls, run: AppNestedRun): Promise<RecipeReply> {
  const ask = readPluginRun(args);
  if ("reason" in ask) return { ok: false, error: ask.reason };
  const loop = nestingRefusal(run.stack, ask.id);
  if (loop) return { ok: false, error: loop };
  const picked = pickPluginCode(ask, run.pins[ask.id], run.plugins.sources(ask.id));
  if ("reason" in picked) return { ok: false, error: picked.reason };
  const file = readPluginFile(picked.code.text);
  if (!file) return { ok: false, error: `The file of ${ask.id} could not be read.` };
  if (file.kind === "animation") return { ok: false, error: `${file.title} is an animation; a recipe runs plugins that make parts.` };
  if (file.target === "object") return { ok: false, error: `${file.title} changes a part it is given, and a plugin run from a recipe makes its own parts, so it did not run.` };
  const verdict = apiVerdict(file.api, [[RECIPE_API[0], RECIPE_API[1]]]);
  if (!verdict.ok) return { ok: false, error: verdict.reason };
  const untrusted = run.plugins.untrusted(file, picked.code.sha256);
  if (untrusted) return { ok: false, error: untrusted };
  const limits = nestedLimits(run.limits, run.deadline);
  if ("reason" in limits) return { ok: false, error: limits.reason };
  const split = splitPluginData(file.body);
  if (split.problem) return { ok: false, error: nestedRefusal(file.title, split.problem) };
  const resolved = inlineIngredients(split.code, (ref) => ({ reason: `${file.title} imports the ingredient ${ref.module} from your library, which the window does not build in yet.` }));
  if ("reason" in resolved) return { ok: false, error: nestedRefusal(file.title, resolved.reason) };
  const built = await run.recipes.build(ask.id, split.code, false, resolved.suffix);
  if (!built.ok || !built.exe) {
    const first = built.diagnostics[0];
    return { ok: false, error: nestedRefusal(file.title, built.reason ?? (first ? `It did not build: line ${first.line}: ${first.message}` : "It did not build.")) };
  }
  // Its own data only: the outer run's kept data and the data its plugin carries are not this plugin's.
  const { data: _data, carried: _carried, ...env } = run.env;
  const child = new AppRecipeCalls(null, run.engine, { ...env, carried: split.data });
  child.params = ask.params;
  const deeper: AppNestedRun = { ...run, env: { ...env, carried: split.data }, stack: [...run.stack, ask.id], limits };
  child.onPluginRun = (inner) => runNestedInApp(inner, child, deeper);
  const queue = child.useQueue(unreadKeys(built.unread), true, limits.timeoutS, run.signal);
  const start = { params: ask.params, context: { units: "mm", host: "app", nativeGeometry: true, limits: { maxParts: MAX_APP_RECIPE_PARTS, canAssemble: true, canCheckpoint: false, timeLimitS: limits.timeoutS }, bedMm: run.context.bedMm, nozzleMm: run.context.nozzleMm } };
  const out = await run.recipes.run(built.exe, start, child.call, limits, run.signal);
  if (out.ok && out.done && queue.holding) {
    const flushed = await queue.flushAll();
    const stop = flushed && !flushed.ok ? flushed.error : queue.stopped();
    if (stop) {
      out.ok = false;
      out.reason = stop;
    }
  }
  // A nested run reads its own stored source, not the recipe that ran it.
  const queued = strictQueueFailure(file.body, queue.unreported(), child.notes);
  if (queued) {
    out.ok = false;
    out.reason = queued;
  }
  const made = child.all.filter((row) => row.origin === "made" && !row.consumed);
  if (!out.ok || !out.done || made.length === 0) {
    // Nothing of a refused nested run is left: the trees it opened close.
    for (const row of child.all) await run.engine.open({ call: "close", key: row.tree.key }).catch(() => null);
    return { ok: false, error: nestedRefusal(file.title, out.reason ?? (made.length === 0 ? "It made no part." : "The plugin failed.")) };
  }
  for (const note of out.notes ?? []) child.notes.push(note);
  parent.adopt(child, ask.id);
  if (picked.note) parent.notes.push(picked.note);
  if (!run.used.has(ask.id)) run.used.set(ask.id, picked.code);
  return { ok: true, result: nestedResult(ask.id, file.version, out, made.map((row) => row.id)) };
}

/** The deadline and limits a top run of the window starts its nested runs with. */
export function topNested(limits: RecipeLimits | undefined): { limits: RecipeLimits; deadline: number } {
  const base = limits ?? DEFAULT_LIMITS;
  const own: RecipeLimits = { ...base, spent: base.spent ?? { calls: 0 } };
  return { limits: own, deadline: Date.now() + own.timeoutS * 1000 };
}
