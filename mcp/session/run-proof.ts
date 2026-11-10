/**
 * recipe_run {keep}: what the apply that just reached done proves about the plugin it is kept as.
 *
 * Keeping a run checks the plugin once more (`pluginCheck`, plugin.ts): a describe run for its parameters, then a dry
 * run with its defaults on the part as it stood before the run. When the run being kept was that very run, the dry run
 * builds the same part a second time and tells nothing new. A `RunProof` is what the apply was; `runProves` says
 * whether the dry run would be the same run: the same text built, the same values (each given value is the declared
 * default), the same data, the same part at the same step, the same printer, nozzle, settings and project values, and
 * a start context the recipe could not tell apart. Anything else keeps the dry run.
 *
 * A run is deterministic: its calls follow from its text, its start line and the replies, and the replies from the
 * part and the engine. So equal inputs are the proof; nothing about the outcome is assumed.
 */
import { builtText } from "../../src/recipe/host.ts";
import { splitPluginData } from "../../src/recipe/plugin-data.ts";
import { resolveIngredients } from "../ingredients.ts";
import { bodyHash, type PluginParam } from "../plugins.ts";
import { lfOnly } from "../recipe.ts";
import { checkpointJson } from "../recipe-checkpoint.ts";
import type { Session } from "../session.ts";

export interface RunProof {
  /** The text lust built (the recipe and its ingredients as one file), hashed without its trailing newlines. */
  text: string;
  /** The values the run started with: what the caller, a preset or an earlier run of the name gave. */
  params: Record<string, unknown>;
  /** The recipe data the run read, by name: a hash of each value. */
  data: Record<string, string>;
  /** The part the run was given, its tree's key, and the step it stood at when the run began. */
  object?: string;
  treeKey?: string;
  from: number | null;
  /** The printer, nozzle, settings and project values (`environmentOf`). */
  environment: string;
  /** The start line's context, as sent. */
  context: string;
  /** The run's time, the queue built at done included. */
  runMs: number;
}

/** The printer, nozzle, settings and project values a run reads, as one hash: a checkpoint's test, and a proof's. */
export function environmentOf(session: Session): string {
  return bodyHash(checkpointJson({ settings: session.settings, printer: session.printer(), nozzleMm: session.library.nozzleMm, params: session.params, paramText: session.paramText }));
}

/** A built text's hash for a proof: trailing newlines build the same program. */
export function proofText(text: string): string {
  return bodyHash(lfOnly(text).replace(/\n+$/, ""));
}

/** A data value's hash for a proof. */
export function proofData(value: unknown): string {
  return bodyHash(JSON.stringify(value) ?? "");
}

/** The context a run's start line carries. The key order is the one sent. */
export function startContext(session: Session, limits: { canCheckpoint: boolean; timeLimitS: number }, object: string | undefined): Record<string, unknown> {
  const printer = session.printer();
  return { units: "mm", host: "mcp", nativeGeometry: true, limits: { canAssemble: true, canCheckpoint: limits.canCheckpoint, timeLimitS: limits.timeLimitS }, ...(object ? { object } : {}), bedMm: [printer.bedX, printer.bedY, printer.bedZ], nozzleMm: session.library.nozzleMm };
}

/**
 * Whether the dry run `pluginCheck` would make of `body` is the run `proof` records. `object` is the part the check
 * would run on and `startAt` the step it would start from (`treeKey` its tree); `timeoutS` the check's limit.
 */
export function runProves(session: Session, proof: RunProof, body: string, params: readonly PluginParam[], object: string | undefined, treeKey: string | undefined, startAt: number | null, timeoutS: number): boolean {
  // The same text: the plugin's code with its ingredients inside, as the check would build it.
  const split = splitPluginData(body);
  if (split.problem) return false;
  const resolved = resolveIngredients(split.code);
  if ("reason" in resolved) return false;
  const text = builtText(lfOnly(split.code), resolved.suffix);
  if (proofText(text) !== proof.text) return false;
  // The same data: every name the run read is carried by the plugin with the value it read.
  for (const [name, hash] of Object.entries(proof.data)) {
    const carried = split.data[name];
    if (!carried || proofData(carried.value) !== hash) return false;
  }
  // The same values: the check runs the defaults, so each value the run was given must be its parameter's default.
  const defaults = new Map(params.map((row) => [row.name, row.default]));
  for (const [name, value] of Object.entries(proof.params)) {
    if (!defaults.has(name) || defaults.get(name) === null || JSON.stringify(value) !== JSON.stringify(defaults.get(name))) return false;
  }
  // The same part at the same step.
  if (proof.object !== object) return false;
  if (object !== undefined && (startAt === null || proof.from !== startAt || proof.treeKey === undefined || proof.treeKey !== treeKey)) return false;
  // The same printer, nozzle, settings and project values.
  if (proof.environment !== environmentOf(session)) return false;
  // The start context differs between an apply and a dry run only in its limits (a dry run cannot checkpoint, and has
  // the check's time limit). The crate reads the context for its object and native geometry alone, so a recipe sees
  // the limits only through `s.context()`: a text that never says `context` cannot tell the two apart.
  const dry = JSON.stringify(startContext(session, { canCheckpoint: false, timeLimitS: timeoutS }, object));
  if (proof.context !== dry && /\bcontext\b/.test(text)) return false;
  // Inside the check's time limit, on the run's own clock.
  return proof.runMs < timeoutS * 1000;
}
