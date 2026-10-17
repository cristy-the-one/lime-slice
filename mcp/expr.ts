/**
 * Numbers typed as text: "wallH + 2", "sqrt(2) * 24", "-roofW / 2". Plus, minus, times, divide, power, brackets,
 * named parameters, and a few functions in degrees. Nothing is evaluated as code: a small parser reads the text.
 */

export type Params = Readonly<Record<string, number>>;

const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sin: (deg) => Math.sin((deg * Math.PI) / 180),
  cos: (deg) => Math.cos((deg * Math.PI) / 180),
  tan: (deg) => Math.tan((deg * Math.PI) / 180),
};

const CONSTANTS: Record<string, number> = { pi: Math.PI };

/** A parameter name: a letter or underscore, then letters, digits, underscores. */
export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

export class ExprError extends Error {}

/** The value of `text`, or an ExprError with a sentence. */
export function evaluate(text: string, params: Params): number {
  let at = 0;
  const peek = () => {
    while (text[at] === " ") at += 1;
    return text[at] ?? "";
  };
  const fail = (why: string): never => {
    throw new ExprError(why);
  };

  const primary = (): number => {
    const c = peek();
    if (c === "(") {
      at += 1;
      const value = sum();
      if (peek() !== ")") fail(`"${text}" is missing a closing bracket.`);
      at += 1;
      return value;
    }
    if (c === "-" || c === "+") {
      at += 1;
      const value = power();
      return c === "-" ? -value : value;
    }
    const number = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(text.slice(at));
    if (number) {
      at += number[0].length;
      return Number(number[0]);
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at));
    if (name) {
      at += name[0].length;
      const word = name[0];
      if (peek() === "(") {
        const fn = FUNCTIONS[word];
        if (!fn) fail(`"${word}" is not a function here. Use ${Object.keys(FUNCTIONS).join(", ")}.`);
        at += 1;
        const arg = sum();
        if (peek() !== ")") fail(`"${text}" is missing a closing bracket.`);
        at += 1;
        return fn!(arg);
      }
      if (Object.hasOwn(params, word)) return params[word]!;
      if (Object.hasOwn(CONSTANTS, word)) return CONSTANTS[word]!;
      return fail(`"${word}" is not a parameter. Set it with model_params first.`);
    }
    return fail(`"${text}" is not a number or an expression.`);
  };

  const power = (): number => {
    const base = primary();
    if (peek() === "^") {
      at += 1;
      return base ** power();
    }
    return base;
  };

  const product = (): number => {
    let value = power();
    for (;;) {
      const c = peek();
      if (c !== "*" && c !== "/") return value;
      at += 1;
      const right = power();
      value = c === "*" ? value * right : value / right;
    }
  };

  const sum = (): number => {
    let value = product();
    for (;;) {
      const c = peek();
      if (c !== "+" && c !== "-") return value;
      at += 1;
      const right = product();
      value = c === "+" ? value + right : value - right;
    }
  };

  const value = sum();
  if (peek() !== "") fail(`"${text}" has extra text at "${text.slice(at)}".`);
  if (!Number.isFinite(value)) fail(`"${text}" is not a finite number.`);
  return value;
}

/** Fields that hold text on purpose. Every other string in an op is read as a number. */
const TEXT_FIELDS = new Set([
  "kind", "op", "primitive", "label", "keep", "screw", "toolObject", "shape", "pattern", "plane", "onError", "filter", "object", "name", "from", "fromNode",
]);

/**
 * `value` with every numeric string replaced by its number: op fields, vector entries, nested ops. Text fields such
 * as `kind` and `label` stay text. Throws ExprError naming the field.
 */
export function resolveNumbers(value: unknown, params: Params, path = "op"): unknown {
  if (typeof value === "string") {
    try {
      return evaluate(value, params);
    } catch (err) {
      throw new ExprError(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (Array.isArray(value)) return value.map((item, i) => resolveNumbers(item, params, `${path}[${i}]`));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = TEXT_FIELDS.has(key) && typeof child === "string" ? child : resolveNumbers(child, params, `${path}.${key}`);
    }
    return out;
  }
  return value;
}
