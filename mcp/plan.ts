/**
 * plan_run: tool calls in order, in one request. Declarative only: a plan is a list of {tool, args}, and the one thing
 * it computes is a reference, a string "$N.path" replaced by step N's result at that path. No caller code runs.
 */

export const MAX_PLAN_STEPS = 25;

export interface PlanStep {
  tool: string;
  args?: Record<string, unknown>;
}

/** "$N" or "$N.a.0.b": N is a 1-based step number, the path is field names and list indexes split by dots. */
const REFERENCE = /^\$([0-9]+)((?:\.[^.]+)*)$/;

export const PLAN_HELP = [
  `Run up to ${MAX_PLAN_STEPS} tool calls in order, in one call. Each step is checked and applied as if called alone (same refusals, undo, and autosave).`,
  "A string argument that is exactly \"$N.path\" becomes step N's result at that path: N is an earlier step's number, from 1; the path is field names and list indexes split by dots, e.g. \"$1.object\" or \"$2.faces.0.index\". \"$N\" alone is the whole result; a string starting \"$$\" is a literal \"$\".",
  "The plan stops at the first refused or failed step and returns every step's result so far and failedStep.",
  "plan_run cannot be a step. A plan past about 45 s answers with a job, like a long call: slice_wait {job} returns its result. guide {topic:\"plans\"}.",
].join(" ");

function isReference(text: string): boolean {
  return text.startsWith("$") && !text.startsWith("$$");
}

/** Every string in a value, with its path under args. */
function strings(value: unknown, path: string, out: { text: string; path: string }[]): void {
  if (typeof value === "string") out.push({ text: value, path });
  else if (Array.isArray(value)) value.forEach((item, i) => strings(item, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) strings(child, `${path}.${key}`, out);
}

/** A sentence for a plan that cannot run as written: a nested plan, or a reference that is malformed or points ahead. */
export function planProblem(steps: PlanStep[]): string | null {
  for (let i = 0; i < steps.length; i += 1) {
    const n = i + 1;
    if (steps[i]!.tool === "plan_run") return `Step ${n}: plan_run cannot run inside a plan. Put its steps in this plan instead.`;
    const found: { text: string; path: string }[] = [];
    strings(steps[i]!.args ?? {}, "args", found);
    for (const { text, path } of found) {
      if (!isReference(text)) continue;
      const match = REFERENCE.exec(text);
      if (!match) return `Step ${n}: ${JSON.stringify(text)} at ${path} is not a reference. Write "$N.path" with N an earlier step's number, e.g. "$1.object", or start with "$$" for a literal "$".`;
      const target = Number(match[1]);
      if (target < 1 || target >= n) return `Step ${n}: ${text} at ${path} refers to step ${target}, which does not run before step ${n}. A reference names an earlier step, from 1.`;
    }
  }
  return null;
}

/** One reference's value from the results so far, or a sentence naming the step and the path that holds nothing. */
function lookUp(text: string, results: unknown[], n: number): { value: unknown } | { reason: string } {
  const match = REFERENCE.exec(text)!;
  const target = Number(match[1]);
  const segments = match[2] ? match[2].slice(1).split(".") : [];
  let node: unknown = results[target - 1];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const next = Array.isArray(node) && /^[0-9]+$/.test(segment)
      ? node[Number(segment)]
      : node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>)[segment] : undefined;
    if (next === undefined) {
      const held = segments.slice(0, i).join(".");
      return { reason: `Step ${n}: ${text} names nothing: step ${target}'s result${held ? ` at ${held}` : ""} has no ${segment}.` };
    }
    node = next;
  }
  return { value: node };
}

/** The step's arguments with every reference replaced, or the sentence for the first that names nothing. */
export function resolveReferences(value: unknown, results: unknown[], n: number): { value: unknown } | { reason: string } {
  if (typeof value === "string") {
    if (value.startsWith("$$")) return { value: value.slice(1) };
    return isReference(value) ? lookUp(value, results, n) : { value };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const resolved = resolveReferences(item, results, n);
      if ("reason" in resolved) return resolved;
      out.push(resolved.value);
    }
    return { value: out };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const resolved = resolveReferences(child, results, n);
      if ("reason" in resolved) return resolved;
      out[key] = resolved.value;
    }
    return { value: out };
  }
  return { value };
}
