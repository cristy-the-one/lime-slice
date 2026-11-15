/**
 * --- Recipes that use plugins (recipe API 1.16, docs/plan-plugin-recipes.md). The rules of a nested plugin run, shared
 * by the MCP server and the app: what `plugin_run` takes, cycles and depth, the limits the outer run hands down, which
 * version of the plugin runs (the pinned one, an asked one, or the library's current), and what the outer recipe gets
 * back. Each host reads its own library and project and runs the plugin its own way; nothing here touches either.
 */
import type { PluginPin, PluginPins } from "../model-tree.ts";
import type { RecipeLimits, RunOutcome } from "./host.ts";

/** How deep plugins may run plugins: the outer recipe, then at most this many nested runs inside one another. */
export const MAX_PLUGIN_DEPTH = 3;

/** What a recipe's `plugin_run` call asks for. */
export interface PluginRunAsk {
  id: string;
  /** A version the recipe named (`run_plugin_version`); none runs the pinned one, else the library's current. */
  version?: number;
  params: Record<string, unknown>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** The call's arguments, or the sentence that refuses them. */
export function readPluginRun(args: Record<string, unknown>): PluginRunAsk | { reason: string } {
  const extra = Object.keys(args).filter((key) => key !== "plugin" && key !== "params" && key !== "version");
  if (extra.length) return { reason: `plugin_run takes plugin, params and version, not ${extra.join(", ")}.` };
  const id = args.plugin;
  if (typeof id !== "string" || !id) return { reason: "plugin_run needs plugin: the id of a kept plugin." };
  if (id.startsWith("draft:") || !SLUG.test(id)) return { reason: `${id} is not a kept plugin's id. A recipe runs plugins kept in the library: keep it first (nugget {action:"save", kind:"plugin"}).` };
  if (args.version !== undefined && (!Number.isInteger(args.version) || (args.version as number) < 1)) return { reason: "version is a whole number from 1." };
  if (args.params !== undefined && (args.params === null || typeof args.params !== "object" || Array.isArray(args.params))) return { reason: "params is an object of the plugin's values by name." };
  return { id, ...(args.version !== undefined ? { version: args.version as number } : {}), params: (args.params as Record<string, unknown> | undefined) ?? {} };
}

/**
 * The sentence that refuses running `id` from inside the runs in `stack` (outermost first, the caller last): a plugin
 * that would run itself, directly or through others, and one nested deeper than `MAX_PLUGIN_DEPTH`. Null when it may run.
 */
export function nestingRefusal(stack: readonly string[], id: string): string | null {
  const at = stack.indexOf(id);
  if (at >= 0) {
    const loop = [...stack.slice(at), id].join(" runs ");
    return `${loop}: a plugin cannot run itself, directly or through other plugins, so nothing ran.`;
  }
  if (stack.length > MAX_PLUGIN_DEPTH) return `${stack.join(" runs ")} runs ${id}: plugins may run plugins ${MAX_PLUGIN_DEPTH} deep, so ${id} did not run.`;
  return null;
}

/**
 * What the outer run hands down: one budget of calls and one deadline for the whole tree of runs. The nested run gets
 * the time left, and counts its calls in the same `spent`. A sentence when nothing is left.
 */
export function nestedLimits(outer: RecipeLimits, deadline: number, now = Date.now()): RecipeLimits | { reason: string } {
  const leftS = (deadline - now) / 1000;
  if (leftS <= 0.05) return { reason: `The run has used its ${outer.timeoutS} s, so the plugin did not run.` };
  const spent = outer.spent ?? { calls: 0 };
  if (spent.calls >= outer.maxCalls) return { reason: `The run has made its ${outer.maxCalls} calls, so the plugin did not run.` };
  return { ...outer, timeoutS: Math.round(leftS * 1000) / 1000, spent };
}

/** One version of a plugin's code a host can run. */
export interface PluginCode {
  version: number;
  sha256: string;
  /** The whole plugin file (header and body): what the project keeps. */
  text: string;
}

/** Where a host looks for a plugin's code. */
export interface PluginSources {
  /** The project's copy of the code with this hash. */
  project(sha256: string): PluginCode | null;
  /** The library's file of the plugin: its current version, or the file of `version`. */
  library(version?: number): PluginCode | null;
  /** The versions of the older files the library keeps (`<id>.vN.rs`). */
  olderVersions(): number[];
}

/**
 * The code a nested run of `ask` runs. A version the recipe named runs that version. Otherwise a pin (the version this
 * recipe ran before, recorded with its parts) runs the same code again, found by its hash in the project, then the
 * library's current and older files, and the reply says when the library has moved on; with no pin, the library's
 * current version. A sentence when the code is nowhere.
 */
export function pickPluginCode(ask: PluginRunAsk, pin: PluginPin | undefined, sources: PluginSources): { code: PluginCode; note?: string } | { reason: string } {
  const bySha = (sha256: string): PluginCode | null => {
    const kept = sources.project(sha256);
    if (kept) return kept;
    const current = sources.library();
    if (current?.sha256 === sha256) return current;
    for (const version of sources.olderVersions()) {
      const old = sources.library(version);
      if (old?.sha256 === sha256) return old;
    }
    return null;
  };
  if (ask.version !== undefined) {
    const pinned = pin && pin.version === ask.version ? bySha(pin.sha256) : null;
    const code = pinned ?? sources.library(ask.version);
    if (!code || code.version !== ask.version) return { reason: `Your library has no version ${ask.version} of ${ask.id}, and this project keeps none, so it did not run.` };
    return { code };
  }
  if (pin) {
    const code = bySha(pin.sha256);
    if (!code) return { reason: `This recipe ran v${pin.version} of ${ask.id} before, and that code is in neither this project nor your library, so nothing ran. Run the recipe as a new run to use the library's version.` };
    const current = sources.library();
    const note = current && current.sha256 !== pin.sha256 && current.version > pin.version ? `v${current.version} of ${ask.id} is in your library; this run used v${pin.version}, the version this recipe ran before. Run the recipe as a new run to use v${current.version}.` : undefined;
    return { code, ...(note ? { note } : {}) };
  }
  const current = sources.library();
  if (!current) return { reason: `No plugin is named ${ask.id} in your library, so it did not run.` };
  return { code: current };
}

/** The pin of each plugin a run ran from inside it, from the codes it ran (`used`); undefined when it ran none. */
export function pinsOf(used: ReadonlyMap<string, PluginCode>): PluginPins | undefined {
  if (used.size === 0) return undefined;
  return Object.fromEntries([...used].map(([id, code]) => [id, { version: code.version, sha256: code.sha256 }]));
}

/** What a nested run that reached `done` hands the outer recipe: the part it ended on, every part it made, its numbers. */
export function nestedResult(id: string, version: number, out: RunOutcome, made: readonly string[]): Record<string, unknown> {
  return { ok: true, object: out.done?.object ?? made[made.length - 1] ?? "", objects: [...made], metrics: out.done?.metrics ?? {}, plugin: { id, version } };
}

/** A nested run's refusal as the outer recipe reads it: the plugin's title, then its own sentence. */
export function nestedRefusal(title: string, reason: string): string {
  return `${title}: ${reason}`;
}
