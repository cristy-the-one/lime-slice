/**
 * --- Gaps A3. Which stored numbers follow which typed expressions. An op is typed in the MCP's frame (a workplane, a
 * face, a mirror's image, a moved part), and the engine stores it in the solid's own frame: a typed `u` may land in
 * `origin[1]` shifted by the plane's origin, in two copies of a mirror, or nowhere. Each stored number is found to be a
 * fixed sum of the typed expressions by moving one typed number at a time and reading the stored op again, and a
 * number that does not move in step (a turn on a tilted plane) is left unlinked. What comes out is the app's own
 * `op.exprs`: a panel field's id where the field holds exactly the typed text, else the number's place (`pathKey`).
 */
import type { ModelOp } from "../model-tree.ts";
import { cleanOp } from "./compose.ts";
import { pathKey } from "./params.ts";

type Path = readonly (string | number)[];

/** One number typed as an expression, where it sits on the typed op, and its value now. */
export interface ExprLeaf {
  path: Path;
  text: string;
  value: number;
}

/**
 * The numbers of `resolved` whose twin (`resolveTexts`) is text that `linked` accepts: an expression in project names.
 * Anchors, face selectors, and plain numbers are not leaves.
 */
export function exprLeaves(resolved: unknown, twin: unknown, linked: (text: string) => boolean, path: Path = []): ExprLeaf[] {
  if (typeof resolved === "number") {
    return typeof twin === "string" && Number.isFinite(resolved) && linked(twin) ? [{ path, text: twin, value: resolved }] : [];
  }
  if (Array.isArray(resolved)) {
    if (!Array.isArray(twin)) return [];
    return resolved.flatMap((item, i) => exprLeaves(item, twin[i], linked, [...path, i]));
  }
  if (resolved && typeof resolved === "object") {
    if (!twin || typeof twin !== "object" || Array.isArray(twin)) return [];
    const other = twin as Record<string, unknown>;
    return Object.entries(resolved as Record<string, unknown>).flatMap(([key, child]) => (key === "label" ? [] : exprLeaves(child, other[key], linked, [...path, key])));
  }
  return [];
}

/** A copy of `value` with the number at `path` set to `next`. */
export function withLeaf(value: unknown, path: Path, next: number): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (Array.isArray(value) && typeof head === "number") {
    const copy = value.slice();
    copy[head] = withLeaf(copy[head], rest, next);
    return copy;
  }
  if (value && typeof value === "object" && typeof head === "string") {
    const record = value as Record<string, unknown>;
    return { ...record, [head]: withLeaf(record[head], rest, next) };
  }
  return value;
}

/** Every number of a stored op with its place, and the op's shape with the numbers taken out. */
function numbersOf(op: unknown): { numbers: Map<string, { path: Path; value: number }>; shape: string } {
  const numbers = new Map<string, { path: Path; value: number }>();
  const walk = (value: unknown, path: (string | number)[]): unknown => {
    if (typeof value === "number") {
      numbers.set(path.join("."), { path: [...path], value });
      return 0;
    }
    if (Array.isArray(value)) return value.map((item, i) => walk(item, [...path, i]));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === "exprs" || key === "label" || key === "sketch") continue;
        out[key] = walk(child, [...path, key]);
      }
      return out;
    }
    return value;
  };
  // A primitive's fields its kind does not read (a box's radius) are left out: no panel shows them.
  const read = op && typeof op === "object" && !Array.isArray(op) ? cleanOp(op as Record<string, unknown>) : op;
  const shape = JSON.stringify(walk(read, []));
  return { numbers, shape };
}

/** The panel field that holds a stored number as typed, by op kind and place. */
const PANEL_KEYS: Record<string, Record<string, string>> = (() => {
  const primitive = {
    "size.0": "modelDx", "size.1": "modelDy", "size.2": "modelDz", radius: "modelRadius", height: "modelHeight", topRadius: "modelTopR",
    tubeRadius: "modelTube", innerRadius: "modelInnerR", topX: "modelTopX", sides: "modelSides", across: "modelAcross",
    "origin.0": "modelX", "origin.1": "modelY", "origin.2": "modelZ",
  };
  return {
    boolean: primitive,
    root: primitive,
    hole: { radius: "modelHoleR", depth: "modelHoleD", counterboreRadius: "modelBoreR", counterboreDepth: "modelBoreD" },
    fillet: { size: "modelBlend" },
    chamfer: { size: "modelBlend" },
    shell: { thickness: "modelShell" },
    scale: { factor: "modelFactor" },
    extrude: { depth: "depth", depth2: "depth2", draftDeg: "draftDeg" },
    revolve: { angleDeg: "angle" },
    faceExtrude: { distance: "modelPull" },
  };
})();

/** Panel fields that show a diameter of the radius stored, so a halved text is still the field's own. */
const HALVED = new Set(["modelHoleR", "modelBoreR", "modelRadius"]);

function plain(n: number): string {
  const rounded = Number(n.toPrecision(12));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** `b + Σ a·text`, written as a person would: `w`, `(w) / 2`, `12.5 - (u)`, `3 + 0.5 * (w) + (h)`. */
export function linearText(b: number, terms: readonly { a: number; text: string }[]): string {
  if (terms.length === 1 && b === 0) {
    const { a, text } = terms[0]!;
    if (a === 1) return text;
    if (a === -1) return `-(${text})`;
    const n = Math.round(1 / a);
    if (n >= 2 && n <= 1000 && Math.abs(1 / a - n) < 1e-9) return `(${text}) / ${n}`;
  }
  let out = b === 0 ? "" : plain(b);
  for (const { a, text } of terms) {
    const size = Math.abs(a);
    const body = size === 1 ? `(${text})` : `${plain(size)} * (${text})`;
    if (!out) out = a < 0 ? `-${body}` : body;
    else out += a < 0 ? ` - ${body}` : ` + ${body}`;
  }
  return out || "0";
}

function snap(a: number): number {
  const rounded = Math.round(a * 1e9) / 1e9;
  return Math.abs(rounded) < 1e-9 ? 0 : rounded;
}

/** What `linkedExprs` found: each stored op's `exprs`, and the leaves no stored number could follow. */
export interface Links {
  exprs: (Record<string, string> | undefined)[];
  /** Leaves that change the stored op other than as a fixed sum (a count, a turn on a tilted plane, a sweep's path): unlinked. */
  unlinked: ExprLeaf[];
}

/**
 * The `exprs` of each op `produce` makes from the typed numbers, for the ops as they were stored (`stored`, by the same
 * index; null for one left out). `produce` is the server's own typed-to-stored path, called with the leaves' values in
 * order; it answers null when those numbers make no op.
 *
 * A leaf is linked only when every stored number moves with it as a fixed sum, by a small step and by a whole one, and
 * the op keeps its shape. A leaf that fails that (a count adds pieces, a sweep's path turns its sections) is left out
 * whole, and so is every number it feeds: a half-followed op would rebuild as a shape nobody typed, so it is better kept
 * as built, and the caller is told which expressions it could not follow.
 */
export function linkedExprs(leaves: readonly ExprLeaf[], produce: (values: number[]) => readonly ModelOp[] | null, stored: readonly (ModelOp | null)[]): Links {
  const none: Links = { exprs: stored.map(() => undefined), unlinked: [] };
  if (leaves.length === 0) return none;
  const values = leaves.map((leaf) => leaf.value);
  const read = (next: number[]) => {
    try {
      const ops = produce(next);
      return ops ? ops.map(numbersOf) : null;
    } catch {
      return null;
    }
  };
  const base = read(values);
  if (!base || base.length !== stored.length) return { ...none, unlinked: [...leaves] };
  const sameShape = (other: ReturnType<typeof read>): other is NonNullable<ReturnType<typeof read>> => !!other && other.length === base.length && other.every((row, k) => row.shape === base[k]!.shape);
  const moved = (i: number, by: number) => read(values.map((v, j) => (j === i ? v + by : v)));
  /** Whether `row` is `base` moved by `by` along `slope`, place by place. */
  const follows = (row: NonNullable<ReturnType<typeof read>>, slope: Map<string, number>[], by: number, tolerance: number) =>
    base.every((op, k) => [...op.numbers].every(([place, { value }]) => Math.abs(row[k]!.numbers.get(place)!.value - (value + (slope[k]!.get(place) ?? 0) * by)) <= tolerance * Math.max(1, Math.abs(value))));
  // slopes[i][k] maps a stored number's place to how far it moves per unit of leaf i; null when leaf i is unlinked.
  const slopes: (Map<string, number>[] | null)[] = [];
  for (let i = 0; i < leaves.length; i += 1) {
    const step = 1e-3 * Math.max(1, Math.abs(values[i]!));
    const once = moved(i, step);
    if (!sameShape(once)) {
      slopes.push(null);
      continue;
    }
    const slope = base.map((op, k) => {
      const out = new Map<string, number>();
      for (const [place, { value }] of op.numbers) {
        const a = snap((once[k]!.numbers.get(place)!.value - value) / step);
        if (a !== 0) out.set(place, a);
      }
      return out;
    });
    const twice = moved(i, 2 * step);
    // A whole step, either way: a count or a rounded number moves nothing by a small step and jumps by a whole one.
    const whole = [1, -1].map((by) => ({ by, row: moved(i, by) })).find(({ row }) => sameShape(row));
    const integral = Number.isInteger(values[i]!);
    const linear = sameShape(twice) && follows(twice, slope, 2 * step, 1e-9) && (whole ? follows(whole.row!, slope, whole.by, 1e-7) : !integral);
    slopes.push(linear ? slope : null);
  }
  // Leaves moved together: numbers that depend on two leaves jointly, not as a sum, unlink both.
  const linked = slopes.map((slope, i) => (slope ? i : -1)).filter((i) => i >= 0);
  if (linked.length > 1) {
    const steps = values.map((v) => 1e-3 * Math.max(1, Math.abs(v)));
    const together = read(values.map((v, i) => (slopes[i] ? v + steps[i]! : v)));
    const expected = base.map((op, k) => new Map([...op.numbers].map(([place, { value }]) => [place, linked.reduce((sum, i) => sum + (slopes[i]![k]!.get(place) ?? 0) * steps[i]!, value)])));
    const fine = sameShape(together) && base.every((op, k) => [...op.numbers.keys()].every((place) => Math.abs(together[k]!.numbers.get(place)!.value - expected[k]!.get(place)!) <= 1e-7 * Math.max(1, Math.abs(expected[k]!.get(place)!))));
    if (!fine) for (const i of linked) slopes[i] = null;
  }
  const unlinked = leaves.filter((_, i) => slopes[i] === null);
  /**
   * Places an unlinked leaf feeds, by a small step or a whole one. One that changes the op's shape at every step (a
   * pattern's count) leaves nothing known, so the op keeps no links at all.
   */
  const fedByUnlinked = base.map(() => new Set<string>());
  let blind = false;
  slopes.forEach((slope, i) => {
    if (slope) return;
    const rows = [1e-3 * Math.max(1, Math.abs(values[i]!)), 1, -1].map((by) => moved(i, by)).filter(sameShape);
    if (rows.length === 0) {
      blind = true;
      return;
    }
    for (const row of rows) {
      base.forEach((op, k) => {
        for (const [place, { value }] of op.numbers) if (row[k]!.numbers.get(place)!.value !== value) fedByUnlinked[k]!.add(place);
      });
    }
  });
  const exprs = stored.map((op, k) => {
    if (!op || blind) return undefined;
    const actual = numbersOf(op).numbers;
    const kind = typeof op.kind === "string" ? op.kind : "";
    const out: Record<string, string> = {};
    for (const [place, { path }] of base[k]!.numbers) {
      if (fedByUnlinked[k]!.has(place)) continue;
      const terms: { a: number; text: string; leaf: number }[] = [];
      slopes.forEach((slope, i) => {
        const a = slope?.[k]!.get(place);
        if (a) terms.push({ a, text: leaves[i]!.text, leaf: i });
      });
      if (terms.length === 0) continue;
      const now = actual.get(place)?.value;
      if (now === undefined) continue;
      const b = snap(now - terms.reduce((sum, term) => sum + term.a * leaves[term.leaf]!.value, 0));
      const text = linearText(b, terms);
      const panel = PANEL_KEYS[kind]?.[place];
      const own = terms.length === 1 && b === 0 && (terms[0]!.a === 1 || (terms[0]!.a === 0.5 && panel !== undefined && HALVED.has(panel)));
      out[panel && own ? panel : pathKey(path)] = text;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  });
  return { exprs, unlinked: blind ? [...leaves] : unlinked };
}
