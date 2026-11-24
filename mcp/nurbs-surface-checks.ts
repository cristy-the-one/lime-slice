/**
 * Organic surfaces S6: what the op schema cannot say about a nurbsSurface's knot insertion, refused in one sentence.
 * The rest (grid, weights, degrees, knot vectors, closed grids) is refused by bake's `surfaceRefusal`, the kernel's own
 * sentences; insertion is checked here first because its limits depend on the degree and the knots: `times` is a whole
 * number from 1 to the degree, the parameter lies inside the surface's knot range, and an existing knot there can take
 * only as many more copies as bring it to the degree (full multiplicity, a crease).
 */
import { resolveCurveKnots } from "../src/modeling/nurbs-eval.ts";

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value);

/** Knot pairs at most this far apart are the same knot (the evaluator's span test). */
const SAME_KNOT = 1e-12;

function axisProblem(op: Rec, path: string, axis: "U" | "V"): string | null {
  const list = op[`insert${axis}`];
  if (!Array.isArray(list) || list.length === 0) return null;
  const field = `${path}.insert${axis}`;
  if (op.periodicU === true || op.periodicV === true) return `${field}: knot insertion is for a clamped NURBS surface, not a closed one.`;
  const poles = Array.isArray(op.poles) ? op.poles : [];
  const count = axis === "U" ? poles.length : (Array.isArray(poles[0]) ? (poles[0] as unknown[]).length : 0);
  const degree = typeof op[`degree${axis}`] === "number" ? (op[`degree${axis}`] as number) : 3;
  if (count < degree + 1) return null; // bake says the grid is too small for its degree
  let range: { knots: number[]; mults: number[]; uMin: number; uMax: number };
  try {
    const knots = Array.isArray(op[`knots${axis}`]) ? (op[`knots${axis}`] as number[]) : undefined;
    const mults = Array.isArray(op[`mults${axis}`]) ? (op[`mults${axis}`] as number[]) : undefined;
    range = resolveCurveKnots(count, degree, knots, mults, false);
  } catch {
    return null; // bake refuses knots that do not fit, with the kernel's sentence
  }
  const added = new Map<number, number>();
  for (let i = 0; i < list.length; i += 1) {
    const pair = list[i];
    const at = `${field}[${i}]`;
    if (!Array.isArray(pair) || pair.length !== 2) return `${at} is [parameter, times].`;
    const [param, times] = pair as number[];
    if (!Number.isInteger(times) || times! < 1 || times! > degree) {
      return `${at} inserts ${times} times; times is a whole number from 1 to the ${axis} degree, ${degree}.`;
    }
    if (!(param! > range.uMin) || !(param! < range.uMax)) {
      return `${at} is at ${param}, outside this surface's ${axis} range; insert inside ${range.uMin} to ${range.uMax}, not at an end.`;
    }
    const known = range.knots.findIndex((knot) => Math.abs(knot - param!) <= SAME_KNOT);
    const before = (known >= 0 ? range.mults[known]! : 0) + (added.get(param!) ?? 0);
    if (before + times! > degree) {
      return `${at} would raise the ${axis} knot at ${param} to multiplicity ${before + times!}; a degree ${degree} surface takes at most ${degree} there (a full crease), so insert it at most ${Math.max(0, degree - before)} more times.`;
    }
    added.set(param!, (added.get(param!) ?? 0) + times!);
  }
  return null;
}

/** The insertion checks of a nurbsSurface op, after the schema has passed. Null when there is nothing to refuse. */
export function nurbsSurfaceProblem(value: unknown, path: string): string | null {
  if (!isRec(value) || value.kind !== "nurbsSurface") return null;
  if ((value.elevateU !== undefined || value.elevateV !== undefined) && (value.periodicU === true || value.periodicV === true)) {
    return `${path}.elevate${value.elevateU !== undefined ? "U" : "V"}: degree elevation is for a clamped NURBS surface, not a closed one.`;
  }
  return axisProblem(value, path, "U") ?? axisProblem(value, path, "V");
}
