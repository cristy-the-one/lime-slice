// Loops and named parts in an op list, expanded before anything else reads it. `each` repeats its ops once per value
// with a loop name the ops' expressions may use; `use` places a part that model_define stored, with its parameters.
// Both become plain ops, so the schema, the probe, and the history see only those.

import { ExprError, resolveNumbers } from "./expr.ts";

/** A part model_define stored: its default parameters (numbers or expressions) and its ops, unexpanded. */
export interface PartDef {
  params: Record<string, unknown>;
  ops: unknown[];
}

/** The most ops one call may expand to. */
export const MAX_EXPANDED = 1000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function labelled(op: unknown, swap: (label: string) => string): unknown {
  if (!op || typeof op !== "object" || Array.isArray(op)) return op;
  const record = op as Record<string, unknown>;
  return typeof record.label === "string" ? { ...record, label: swap(record.label).slice(0, 80) } : op;
}

/**
 * A part's op as a `use` with a label places it: its own label follows the use's, and an op with none takes the use's
 * label alone, so a step the part made can be found by the name the part was placed under.
 */
function placed(op: unknown, prefix: string, params: Record<string, number>): unknown {
  if (!op || typeof op !== "object" || Array.isArray(op)) return op;
  const record = op as Record<string, unknown>;
  if (typeof record.label === "string") return { ...record, label: (prefix ? `${prefix} ${fill(record.label, params)}` : fill(record.label, params)).slice(0, 80) };
  return prefix && record.kind !== "each" ? { ...record, label: prefix.slice(0, 80) } : op;
}

/** `{i}` in a label becomes the loop value, so each copy is named apart. */
function fill(text: string, params: Record<string, number>): string {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => (name in params ? String(Math.round(params[name]! * 1e6) / 1e6) : whole));
}

/**
 * The op list with every `each` and `use` expanded and every number resolved. Throws ExprError, naming the op, on a
 * bad loop, an unknown part, or an expression that does not evaluate.
 */
export function expandOps(ops: unknown[], params: Record<string, number>, parts: ReadonlyMap<string, PartDef>, words: ReadonlySet<string>, path = "ops", depth = 0): unknown[] {
  if (depth > 6) throw new ExprError(`${path}: each and use nest at most 6 deep.`);
  const out: unknown[] = [];
  const push = (items: unknown[]) => {
    out.push(...items);
    if (out.length > MAX_EXPANDED) throw new ExprError(`${path} expands to more than ${MAX_EXPANDED} ops. Split it into several calls.`);
  };
  ops.forEach((op, index) => {
    const at = `${path}[${index}]`;
    const record = op && typeof op === "object" && !Array.isArray(op) ? (op as Record<string, unknown>) : null;
    if (record?.kind === "each") {
      const name = typeof record.var === "string" ? record.var : "i";
      if (!NAME.test(name)) throw new ExprError(`${at}.var is a name of letters, digits, and underscores.`);
      if (!Array.isArray(record.ops) || record.ops.length === 0) throw new ExprError(`${at}.ops lists the ops to repeat.`);
      const values = loopValues(record, params, at);
      for (const value of values) {
        const inner = { ...params, [name]: value };
        push(expandOps((record.ops as unknown[]).map((child) => labelled(child, (label) => fill(label, inner))), inner, parts, words, `${at}.ops`, depth + 1));
      }
      return;
    }
    if (record?.kind === "use") {
      const name = String(record.part ?? "");
      const part = parts.get(name);
      if (!part) throw new ExprError(`${at}.part: no part is named "${name}". model_define stores one; parts: ${[...parts.keys()].join(", ") || "none yet"}.`);
      const extra = Object.keys(record).find((key) => key !== "kind" && key !== "part" && key !== "with" && key !== "label");
      if (extra) throw new ExprError(`${at}.${extra} is not a field of use. Use part, with, and label.`);
      const inner: Record<string, number> = { ...params };
      for (const [key, value] of Object.entries(part.params)) inner[key] = numberOf(value, inner, `${at} (${name}.${key})`);
      const given = record.with && typeof record.with === "object" ? (record.with as Record<string, unknown>) : {};
      for (const [key, value] of Object.entries(given)) {
        if (!NAME.test(key)) throw new ExprError(`${at}.with.${key} is not a parameter name.`);
        inner[key] = numberOf(value, { ...params, ...inner }, `${at}.with.${key}`);
      }
      const prefix = typeof record.label === "string" && record.label.trim() ? fill(record.label.trim(), inner) : "";
      const ops = part.ops.map((child) => placed(child, prefix, inner));
      push(expandOps(ops, inner, parts, words, `${at}(${name})`, depth + 1));
      return;
    }
    push([resolveNumbers(op, params, at, words)]);
  });
  return out;
}

function numberOf(value: unknown, params: Record<string, number>, path: string): number {
  const n = resolveNumbers(value, params, path) as unknown;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ExprError(`${path} is not a number.`);
  return n;
}

/** values: a list; or count (0 to count − 1); or from, to, and step (to included). */
function loopValues(record: Record<string, unknown>, params: Record<string, number>, at: string): number[] {
  if (record.values !== undefined) {
    if (!Array.isArray(record.values) || record.values.length === 0) throw new ExprError(`${at}.values lists the numbers to repeat for.`);
    return record.values.map((value, i) => numberOf(value, params, `${at}.values[${i}]`));
  }
  if (record.count !== undefined) {
    const count = numberOf(record.count, params, `${at}.count`);
    if (!Number.isInteger(count) || count < 1 || count > MAX_EXPANDED) throw new ExprError(`${at}.count is a whole number from 1 to ${MAX_EXPANDED}.`);
    return Array.from({ length: count }, (_, i) => i);
  }
  if (record.from !== undefined && record.to !== undefined) {
    const from = numberOf(record.from, params, `${at}.from`);
    const to = numberOf(record.to, params, `${at}.to`);
    const step = record.step === undefined ? (to >= from ? 1 : -1) : numberOf(record.step, params, `${at}.step`);
    if (step === 0 || Math.sign(step) !== Math.sign(to - from || step)) throw new ExprError(`${at}.step must move from toward to.`);
    const values: number[] = [];
    for (let v = from; step > 0 ? v <= to + 1e-9 : v >= to - 1e-9; v += step) {
      values.push(Math.round(v * 1e9) / 1e9);
      if (values.length > MAX_EXPANDED) throw new ExprError(`${at} repeats more than ${MAX_EXPANDED} times.`);
    }
    return values;
  }
  throw new ExprError(`${at} needs values, count, or from and to.`);
}
