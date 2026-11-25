/**
 * Organic surfaces S2–S5: what the op schema cannot say about the new ops, refused in one sentence that names the
 * field. Without these the kernel changed or dropped such a field with no word: a radius on an apex section, a path
 * beside a spine, weights or knots that do not fit the poles (truncated), a degree the poles cannot carry (clamped), a
 * scale station outside the spine (clamped), rho on a fillet that is not conic. The kernel refuses some of these too;
 * these come first and say which field. Caps follow the kernel's own (crates/lime-model-occt/cpp/kernel.cpp
 * `decode_curve3d`, tree.cpp `decode_surface_blob`), plus one on the whole op so a request stays a request.
 */

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value);
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isPoint = (value: unknown, size: number): value is number[] => Array.isArray(value) && value.length === size && value.every(isNum);

/** The kernel's `kProfileMm`: a profile segment that ends this close to where it starts is closed. */
const SAME_MM = 1e-6;
/** Control points, through points and polyline points in all the curves of one op, together. */
export const MAX_OP_CURVE_POINTS = 2000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Weights, knots, multiplicities and degree of one NURBS curve of `poles` poles, against each other. `where` names
 * the curve's field. Null when they fit, which is when Open CASCADE builds exactly what was asked.
 */
export function nurbsProblem(where: string, piece: Rec, poles: number, periodic: boolean): string | null {
  if (periodic && poles < 3) return `${where} is closed, and a closed NURBS curve needs at least 3 poles; it has ${poles}.`;
  const asked = piece.degree;
  const most = periodic ? poles : poles - 1;
  if (isNum(asked) && asked > most) {
    return `${where}.degree is ${asked}, but ${plural(poles, "pole")} carry at most degree ${most}${periodic ? " on a closed curve" : ""}. Lower the degree or add poles.`;
  }
  const degree = Math.max(1, Math.min(isNum(asked) ? asked : 3, most));
  const weights = piece.weights;
  if (Array.isArray(weights) && weights.length !== poles) {
    return `${where}.weights has ${plural(weights.length, "value")} for ${plural(poles, "pole")}; give one weight per pole${piece.kind === "nurbs" && "to" in piece ? ", the start and the end included" : ""}.`;
  }
  const knots = piece.knots;
  const mults = piece.mults;
  if (knots === undefined && mults === undefined) return null;
  if (!Array.isArray(knots) || !Array.isArray(mults)) return `${where} has ${knots === undefined ? "mults without knots" : "knots without mults"}; give both, one multiplicity per knot, or neither.`;
  if (knots.length !== mults.length) return `${where}.knots has ${plural(knots.length, "value")} and mults ${mults.length}; give one multiplicity per knot.`;
  for (let i = 1; i < knots.length; i += 1) {
    if (isNum(knots[i]) && isNum(knots[i - 1]) && !((knots[i] as number) > (knots[i - 1] as number))) return `${where}.knots must rise: ${knots[i]} follows ${knots[i - 1]}.`;
  }
  const m = mults.map((value) => (isNum(value) ? value : 0));
  const last = m.length - 1;
  for (let i = 0; i <= last; i += 1) {
    const end = !periodic && (i === 0 || i === last);
    const cap = end ? degree + 1 : degree;
    if (m[i]! > cap) return `${where}.mults[${i}] is ${m[i]}; ${end ? "an end knot" : "an inner knot"} of a degree ${degree} curve takes at most ${cap}.`;
  }
  const sum = m.reduce((a, b) => a + b, 0);
  if (periodic) {
    if (m[0] !== m[last]) return `${where}: a closed curve's first and last multiplicities match; they are ${m[0]} and ${m[last]}.`;
    if (sum - m[last]! !== poles) return `${where}: the multiplicities, less the last, add up to ${sum - m[last]!}; a closed curve of ${plural(poles, "pole")} needs ${poles}.`;
    return null;
  }
  if (sum !== poles + degree + 1) {
    return `${where}: the multiplicities add up to ${sum}; ${plural(poles, "pole")} of degree ${degree} need ${poles} + ${degree} + 1 = ${poles + degree + 1}.`;
  }
  return null;
}

const samePoint = (a: number[], b: number[]) => a.every((value, i) => Math.abs(value - (b[i] ?? NaN)) <= SAME_MM);

/** One loop of a profile: each nurbs segment from the previous end, closed when it ends where it started. */
function loopProblem(where: string, loop: unknown): string | null {
  if (!isRec(loop) || !Array.isArray(loop.segments) || !isPoint(loop.start, 2)) return null;
  let from = loop.start;
  for (let s = 0; s < loop.segments.length; s += 1) {
    const seg = loop.segments[s];
    if (!isRec(seg)) continue;
    const at = `${where}.segments[${s}]`;
    if (seg.kind === "nurbs") {
      const inner = Array.isArray(seg.poles) ? seg.poles.length : 0;
      const closed = isPoint(seg.to, 2) && samePoint(from, seg.to) && inner >= 2;
      const problem = nurbsProblem(at, seg, closed ? inner + 1 : inner + 2, closed);
      if (problem) return problem;
    }
    if (isPoint(seg.to, 2)) from = seg.to;
  }
  return null;
}

function loopsProblem(where: string, loops: unknown): string | null {
  if (!Array.isArray(loops)) return null;
  for (let i = 0; i < loops.length; i += 1) {
    const problem = loopProblem(`${where}[${i}]`, loops[i]);
    if (problem) return problem;
  }
  return null;
}

/** Points a Curve3D carries, for the whole-op cap. */
function curvePoints(curve: unknown): number {
  if (!isRec(curve)) return 0;
  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  if (curve.kind === "polyline") return count(curve.points);
  if (curve.kind === "spline") return count(curve.through);
  if (curve.kind === "nurbs") return count(curve.poles);
  if (curve.kind === "segments" && Array.isArray(curve.segments)) {
    return 1 + curve.segments.reduce((sum: number, seg) => sum + 1 + (isRec(seg) ? (Array.isArray(seg.through) ? seg.through.length : 0) + count(seg.poles) : 0), 0);
  }
  return 0;
}

/** A Curve3D: its NURBS parts against their poles. */
function curveProblem(where: string, curve: unknown): string | null {
  if (!isRec(curve)) return null;
  if (curve.kind === "nurbs") {
    const poles = Array.isArray(curve.poles) ? curve.poles.length : 0;
    return nurbsProblem(where, curve, poles, curve.closed === true);
  }
  if (curve.kind === "segments" && Array.isArray(curve.segments) && isPoint(curve.start, 3)) {
    let from = curve.start;
    const single = curve.segments.length === 1;
    for (let s = 0; s < curve.segments.length; s += 1) {
      const seg = curve.segments[s];
      if (!isRec(seg)) continue;
      if (seg.kind === "nurbs") {
        const inner = Array.isArray(seg.poles) ? seg.poles.length : 0;
        const closed = single && isPoint(seg.to, 3) && samePoint(from, seg.to) && inner >= 2;
        const problem = nurbsProblem(`${where}.segments[${s}]`, seg, closed ? inner + 1 : inner + 2, closed);
        if (problem) return problem;
      }
      if (isPoint(seg.to, 3)) from = seg.to;
    }
  }
  return null;
}

/** Every Curve3D an op carries, with the field that holds it. */
function curvesOf(op: Rec, path: string): [string, unknown][] {
  const out: [string, unknown][] = [];
  const list = (field: string, value: unknown) => {
    if (Array.isArray(value)) value.forEach((curve, i) => out.push([`${field}[${i}]`, curve]));
  };
  if (op.spine !== undefined) out.push([`${path}.spine`, op.spine]);
  if (isRec(op.mode) && op.mode.spine !== undefined) out.push([`${path}.mode.spine`, op.mode.spine]);
  list(`${path}.guides`, op.guides);
  list(`${path}.curves`, op.curves);
  if (isRec(op.sheet)) list(`${path}.sheet.curves`, op.sheet.curves);
  if (op.curve !== undefined) out.push([`${path}.curve`, op.curve]);
  if (Array.isArray(op.boundaries)) op.boundaries.forEach((side, i) => isRec(side) && side.curve !== undefined && out.push([`${path}.boundaries[${i}].curve`, side.curve]));
  for (const side of ["a", "b"]) if (isRec(op[side]) && (op[side] as Rec).curve !== undefined) out.push([`${path}.${side}.curve`, (op[side] as Rec).curve]);
  return out;
}

const FACE_SENTENCE = "is a face index (0 or more) or a selector {normal:[x, y, z], nearPoint:[x, y, z]}";

/** A face field the schema now types: an index or a selector. */
function faceProblem(where: string, face: unknown): string | null {
  if (face === undefined) return null;
  if (Number.isInteger(face) && (face as number) >= 0) return null;
  if (isRec(face) && (Number.isInteger(face.index) || isPoint(face.normal, 3)) && (face.nearPoint === undefined || isPoint(face.nearPoint, 3))) return null;
  return `${where} ${FACE_SENTENCE}.`;
}

/** A list longer than the kernel takes, with both numbers. */
function tooMany(where: string, list: unknown, most: number, what: string): string | null {
  return Array.isArray(list) && list.length > most ? `${where} has ${list.length} ${what}; the most is ${most}.` : null;
}

/** Edge lists of a side and of an edge curve, against the kernel's caps (64 a side, 500 a curve). */
function edgeCapProblem(value: Rec, path: string): string | null {
  for (const [where, curve] of curvesOf(value, path)) {
    if (isRec(curve) && curve.kind === "edges") {
      const problem = tooMany(`${where}.edges`, curve.edges, 500, "edges");
      if (problem) return problem;
    }
  }
  if (Array.isArray(value.boundaries)) {
    for (let i = 0; i < value.boundaries.length; i += 1) {
      const side = value.boundaries[i];
      const problem = isRec(side) ? tooMany(`${path}.boundaries[${i}].edges`, side.edges, 64, "edges") : null;
      if (problem) return problem;
    }
  }
  for (const side of ["a", "b"]) {
    const problem = isRec(value[side]) ? tooMany(`${path}.${side}.edges`, (value[side] as Rec).edges, 64, "edges") : null;
    if (problem) return problem;
  }
  return null;
}

/**
 * Checked before the schema, so the refusal is this sentence and not the schema's "must be a number" or "is too
 * long": face fields (an index or a selector), and list caps with the count and the most.
 */
export function organicFirstProblem(value: unknown, path: string): string | null {
  if (!isRec(value)) return null;
  const caps = tooMany(`${path}.curves`, value.curves, 20, "curves")
    ?? (isRec(value.sheet) ? tooMany(`${path}.sheet.curves`, value.sheet.curves, 20, "curves") : null)
    ?? edgeCapProblem(value, path);
  if (caps) return caps;
  if (value.kind === "loft") {
    for (const field of ["startCondition", "endCondition"]) {
      const condition = value[field];
      if (isRec(condition) && condition.kind === "curvature") {
        return `${path}.${field} kind "curvature" is not built: a loft steers an end by its direction only. Use "normal" or "tangent".`;
      }
    }
  }
  if (value.kind === "replaceFace") return faceProblem(`${path}.face`, value.face);
  if (value.kind === "splitFace" && Array.isArray(value.faces)) {
    for (let i = 0; i < value.faces.length; i += 1) {
      const problem = faceProblem(`${path}.faces[${i}]`, value.faces[i]);
      if (problem) return problem;
    }
  }
  if (value.kind === "patch" && Array.isArray(value.boundaries)) {
    for (let i = 0; i < value.boundaries.length; i += 1) {
      const side = value.boundaries[i];
      const problem = isRec(side) ? faceProblem(`${path}.boundaries[${i}].face`, side.face) : null;
      if (problem) return problem;
    }
  }
  if (value.kind === "blendSurface") {
    for (const side of ["a", "b"]) {
      const problem = isRec(value[side]) ? faceProblem(`${path}.${side}.face`, (value[side] as Rec).face) : null;
      if (problem) return problem;
    }
  }
  return null;
}

/** Fields of the path sweep, which a spine sweep does not read, and the other way round. */
const PATH_ONLY = ["radius", "radiusV", "profile", "smooth", "corners", "up", "steps"];
const SPINE_ONLY = ["sections", "mode", "transition", "twistDeg"];

function sweepProblem(op: Rec, path: string): string | null {
  const hasPath = op.path !== undefined;
  const hasSpine = op.spine !== undefined;
  if (!hasPath && !hasSpine) return "A sweep needs a path (a tube through points) or a spine (a kernel sweep of sections along a curve).";
  if (hasPath && hasSpine) return `A sweep takes a path or a spine, not both: ${path}.path and ${path}.spine were both given.`;
  if (hasSpine) {
    const stray = PATH_ONLY.find((field) => op[field] !== undefined);
    if (stray) return `${path}.${stray} is for a sweep along a path; a sweep along a spine takes its size from its sections.`;
    if (op.sections === undefined) return `${path}.sections is required with a spine: the cross-sections to sweep along it.`;
    if (op.scale !== undefined) {
      const stations = op.scale;
      if (!Array.isArray(stations) || stations.length < 2 || !stations.every((row) => isPoint(row, 2))) {
        return `${path}.scale along a spine is [[u, factor], ...]: at least two stations, u from 0 at the spine's start to 1 at its end.`;
      }
      for (let i = 0; i < stations.length; i += 1) {
        const [u, factor] = stations[i] as number[];
        if (u! < 0 || u! > 1) return `${path}.scale[${i}] is at u ${u}; a station's u is from 0 at the spine's start to 1 at its end.`;
        if (!(factor! > 0)) return `${path}.scale[${i}] has factor ${factor}; a scale factor is above 0.`;
      }
    }
    return null;
  }
  const stray = SPINE_ONLY.find((field) => op[field] !== undefined);
  if (stray) return `${path}.${stray} is for a sweep along a spine; a sweep along a path does not read it.`;
  if (op.scale !== undefined && !isNum(op.scale) && !(Array.isArray(op.scale) && op.scale.every(isNum))) {
    return `${path}.scale along a path is one number or one per path point; [u, factor] stations are for a spine.`;
  }
  return null;
}

const APEX_ONLY = ["origin", "turn", "radius", "radiusV", "profile", "loops", "smooth", "corners"];

function loftProblem(op: Rec, path: string): string | null {
  if (!Array.isArray(op.sections)) return null;
  for (let i = 0; i < op.sections.length; i += 1) {
    const section = op.sections[i];
    if (!isRec(section)) continue;
    const at = `${path}.sections[${i}]`;
    if (section.apex !== undefined) {
      const stray = APEX_ONLY.find((field) => section[field] !== undefined);
      if (stray) return `${at}.${stray} does not apply to an apex section, which is only the point; give apex alone.`;
      continue;
    }
    if (section.origin === undefined) return `${at}.origin is required.`;
    const problem = loopsProblem(`${at}.loops`, section.loops);
    if (problem) return problem;
  }
  return null;
}

function filletProblem(op: Rec, path: string): string | null {
  if (op.rho !== undefined && op.continuity !== "conic") return `${path}.rho is the fullness of a conic fillet; add continuity:"conic", or leave rho out.`;
  if (Array.isArray(op.variable)) {
    for (let i = 0; i < op.variable.length; i += 1) {
      const row = op.variable[i];
      if (!isPoint(row, 2)) continue;
      const [u, radius] = row as number[];
      if (u! < 0 || u! > 1) return `${path}.variable[${i}] is at u ${u}; a station's u is from 0 at the edge's start to 1 at its end.`;
      if (!(radius! > 0)) return `${path}.variable[${i}] has radius ${radius}; a radius is above 0.`;
    }
  }
  return null;
}

/** The cross-field checks of the organic ops, after the schema has passed. Null when there is nothing to refuse. */
export function organicProblem(value: unknown, path: string): string | null {
  if (!isRec(value)) return null;
  const kind = value.kind;
  if (kind === "fillet") return filletProblem(value, path);
  if (kind === "sweep") {
    const problem = sweepProblem(value, path);
    if (problem) return problem;
    if (Array.isArray(value.sections)) {
      for (let i = 0; i < value.sections.length; i += 1) {
        const section = value.sections[i];
        const loops = isRec(section) ? loopsProblem(`${path}.sections[${i}].loops`, section.loops) : null;
        if (loops) return loops;
      }
    }
  }
  if (kind === "loft") {
    const problem = loftProblem(value, path);
    if (problem) return problem;
  }
  if (kind === "extrude" || kind === "revolve") {
    const problem = loopsProblem(`${path}.loops`, value.loops);
    if (problem) return problem;
  }
  const curves = curvesOf(value, path);
  let points = 0;
  for (const [where, curve] of curves) {
    const problem = curveProblem(where, curve);
    if (problem) return problem;
    points += curvePoints(curve);
  }
  if (points > MAX_OP_CURVE_POINTS) {
    return `This ${String(kind)} carries ${points} curve points across its curves; one op takes at most ${MAX_OP_CURVE_POINTS}. Use fewer points or split it into steps.`;
  }
  return null;
}

/** The kernel lists at most this many shared edges in `continuity.edges` (kernel.cpp, surface inspect). */
export const KERNEL_EDGE_ROWS = 256;
/** Sharp vertices model_check lists; the kernel sends every one it finds. */
export const MAX_SHARP_VERTICES = 64;

/**
 * model_check's continuity, saying when a list is cut short. The kernel samples every shared edge it can and counts
 * each in g0, g1, g2 or gaps, but lists only the 256 worst (largest gap, then angle, then curvature jump), in edge
 * order. Their sum is the true total, so a shorter list says how many there were. Sharp vertices are capped here.
 */
export function listedContinuity<T extends { g0: number; g1: number; g2: number; gaps: number; edges?: unknown[]; sharpVertices?: unknown[] }>(continuity: T): T & Record<string, unknown> {
  const out: Record<string, unknown> = { ...continuity };
  const sampled = [continuity.g0, continuity.g1, continuity.g2, continuity.gaps].reduce((sum, n) => sum + (isNum(n) ? n : 0), 0);
  const notes: string[] = [];
  if (Array.isArray(continuity.edges) && continuity.edges.length < sampled) {
    out.edgesTotal = sampled;
    notes.push(`continuity.edges lists ${continuity.edges.length} of the ${sampled} sampled shared edges: the worst by gap, then angle, then curvature jump. The counts g0, g1, g2 and gaps cover all ${sampled}.`);
  }
  if (Array.isArray(continuity.sharpVertices) && continuity.sharpVertices.length > MAX_SHARP_VERTICES) {
    out.sharpVerticesTotal = continuity.sharpVertices.length;
    out.sharpVertices = continuity.sharpVertices.slice(0, MAX_SHARP_VERTICES);
    notes.push(`continuity.sharpVertices lists the first ${MAX_SHARP_VERTICES} of ${continuity.sharpVertices.length}.`);
  }
  if (notes.length > 0) out.note = notes.join(" ");
  return out as T & Record<string, unknown>;
}
