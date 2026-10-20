/**
 * --- S4 constraints and driving dimensions ---
 * Geometric constraints and driving dimensions on a sketch. The numbers are solved by
 * `solve.ts`. Coincident joins two points into one shared point. A typed size is a plain
 * number until parameters (plan A, A6) install an evaluator.
 */
import { arcFrom3, type Pt } from "./geom.ts";
import { prunePoints, sketchEntity, sketchPoint, type Dimension, type SketchData, type SketchEntity } from "./model.ts";
import { constraintStatus, hasSolvableConstraints, parseConstraints, solveSketch, type ConstraintStatus, type SketchConstraint } from "./solve.ts";

export type { ConstraintStatus, SketchConstraint };
export { constraintStatus, hasSolvableConstraints };

export const CONSTRAIN_TOOLS = [
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "tangent",
  "equal",
  "concentric",
  "fixed",
  "midpoint",
  "coincident",
  "distance",
  "length",
  "radius",
  "diameter",
  "angle",
] as const;

export type ConstrainTool = (typeof CONSTRAIN_TOOLS)[number];
export type ConstrainAction = ConstrainTool | "remove";

export function isConstrainTool(tool: string): tool is ConstrainTool {
  return (CONSTRAIN_TOOLS as readonly string[]).includes(tool);
}

export const CONSTRAIN_MENU: { action: ConstrainAction; label: string; group: "geom" | "size" | "edit" }[] = [
  { action: "coincident", label: "Coincident", group: "geom" },
  { action: "horizontal", label: "Horizontal", group: "geom" },
  { action: "vertical", label: "Vertical", group: "geom" },
  { action: "parallel", label: "Parallel", group: "geom" },
  { action: "perpendicular", label: "Perpendicular", group: "geom" },
  { action: "tangent", label: "Tangent", group: "geom" },
  { action: "equal", label: "Equal", group: "geom" },
  { action: "concentric", label: "Concentric", group: "geom" },
  { action: "midpoint", label: "Midpoint", group: "geom" },
  { action: "fixed", label: "Fixed", group: "geom" },
  { action: "distance", label: "Distance", group: "size" },
  { action: "length", label: "Length", group: "size" },
  { action: "radius", label: "Radius", group: "size" },
  { action: "diameter", label: "Diameter", group: "size" },
  { action: "angle", label: "Angle", group: "size" },
  { action: "remove", label: "Remove constraint", group: "edit" },
];

export interface ConstrainPick {
  point: number | null;
  entity: number | null;
}

export interface ConstrainState {
  picks: ConstrainPick[];
  /** Driving dimension the heads-up box is editing. */
  hud: number | null;
  /** Label that should open as an input. The view clears this after focusing it. */
  focus: number | null;
  /** Dimension Delete removes, when a label is selected. */
  selected: number | null;
  note: string | null;
}

export function freshConstrain(): ConstrainState {
  return { picks: [], hud: null, focus: null, selected: null, note: null };
}

export function idleConstrain(state: ConstrainState): ConstrainState {
  return { picks: [], hud: null, focus: null, selected: state.selected, note: null };
}

export interface ConstrainBuild {
  sketch?: SketchData;
  focus?: number | null;
  hint?: string;
  error?: string;
}

export interface DimLabel {
  id: number;
  text: string;
  at: Pt;
  title: string;
  /** What a screen reader says: the kind and the value with its unit, "Length 12 mm". */
  spoken: string;
  /** The expression, when the dimension was not typed as a plain number. */
  expr?: string;
}

/** A number, a refusal in the evaluator's words, or null when the text is not an expression this hook accepts. */
export type DrivingResult = number | { error: string } | null;

type DrivingEval = (text: string) => DrivingResult;

let drivingEval: DrivingEval = plainDrivingValue;

/** A plain number. "12", "-3.5" and "1e-2" pass. Words do not, until an evaluator is installed. */
export function plainDrivingValue(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * The project's expression evaluator. A hook that returns only a number still works.
 * The app installs one that reads Parameters.
 */
export function setDrivingEvaluator(evaluate: DrivingEval): void {
  drivingEval = evaluate;
}

export function drivingValue(text: string): DrivingResult {
  return drivingEval(text);
}

export function constrainReadout(tool: ConstrainTool, note: string | null): string {
  const hint = note ? ` ${note}` : "";
  switch (tool) {
    case "horizontal":
      return `Horizontal. Click a line, or two points. With lines selected, each one is made horizontal.${hint}`;
    case "vertical":
      return `Vertical. Click a line, or two points. With lines selected, each one is made vertical.${hint}`;
    case "parallel":
      return `Parallel. Click two lines.${hint}`;
    case "perpendicular":
      return `Perpendicular. Click two lines.${hint}`;
    case "tangent":
      return `Tangent. Click a line and a circle or arc, or two circles or arcs.${hint}`;
    case "equal":
      return `Equal. Click two lines, or two circles or arcs.${hint}`;
    case "concentric":
      return `Concentric. Click two circles or arcs.${hint}`;
    case "fixed":
      return `Fixed. Click a point or a line to keep it where it is.${hint}`;
    case "midpoint":
      return `Midpoint. Click a point and a line.${hint}`;
    case "coincident":
      return `Coincident. Click two points, and they become one; or a point and a line, circle or arc, and it stays on it.${hint}`;
    case "distance":
      return `Distance. Click two points, or a point and a line. Type the distance on the label.${hint}`;
    case "length":
      return `Length. Click a line. Type the length on the label.${hint}`;
    case "radius":
      return `Radius. Click a circle or an arc. Type the radius on the label.${hint}`;
    case "diameter":
      return `Diameter. Click a circle or an arc. Type the diameter on the label.${hint}`;
    case "angle":
      return `Angle. Click two lines. Type the angle on the label.${hint}`;
  }
}

export function applyConstrainAction(sketch: SketchData, action: ConstrainAction, selection: { entities: number[]; points: number[] }, selectedDim: number | null): ConstrainBuild {
  if (action === "remove") {
    const next = removeConstraints(sketch, selection, selectedDim);
    if (next !== sketch) return { sketch: next, focus: null };
    // With nothing chosen, the constraints that cannot be met go, so a sketch that conflicts can be freed in one step.
    const unmet = selection.entities.length === 0 && selection.points.length === 0 && selectedDim == null ? constraintStatus(sketch)?.conflicting ?? [] : [];
    if (unmet.length > 0) {
      const count = unmet.length === 1 ? "the constraint" : `${unmet.length} constraints`;
      return { sketch: dropDimIds(sketch, new Set(unmet)), focus: null, hint: `Removed ${count} that could not be met.` };
    }
    return { error: "Select a constraint, or the geometry it is on." };
  }
  return finishDraft(sketch, fromSelection(sketch, action, selection), false);
}

export function constrainFromPick(sketch: SketchData, tool: ConstrainTool, picks: readonly ConstrainPick[]): ConstrainBuild & { needMore?: boolean } {
  const built = fromSelection(sketch, tool, selectionFromPicks(picks));
  if (built.constraint || built.coincide) return finishDraft(sketch, built, true);
  if (picks.length >= picksNeeded(tool)) return { error: built.error ?? built.hint ?? "That selection cannot take this constraint." };
  return { needMore: true, hint: built.hint };
}

function finishDraft(sketch: SketchData, built: Draft, strict: boolean): ConstrainBuild {
  if (built.coincide) return { sketch: coincide(sketch, built.coincide[0], built.coincide[1]), focus: null };
  if (built.constraint) return commitAdded(sketch, built.constraint, built.extras ?? [], built.more ?? []);
  if (strict && built.error) return { error: built.error };
  return { hint: built.hint ?? built.error };
}

export function commitDriving(sketch: SketchData, id: number, value: number, expr?: string | null): ConstrainBuild {
  const current = parseConstraints(sketch).find((item) => item.id === id);
  if (!current || !("value" in current)) return { error: "That label is not a driving dimension." };
  if (!Number.isFinite(value)) return { error: "Type a number." };
  if ((current.kind === "length" || current.kind === "radius" || current.kind === "diameter") && !(value > 0)) {
    return { error: "Type a distance greater than zero." };
  }
  if (current.kind === "distance" && value < 0) return { error: "Type a distance of zero or more." };
  const kept = expr != null && plainDrivingValue(expr) == null && expr.trim() ? expr.trim() : "";
  const dims = (sketch.dims ?? []).map((dim) => {
    if (dim.id !== id) return dim;
    const next: Dimension = { ...dim, value };
    if (kept) next.expr = kept;
    else delete next.expr;
    return next;
  });
  const solved = solveOrRefuse(sketch, { ...sketch, dims });
  if (!solved) return { error: VALUE_CONFLICT };
  return { sketch: solved, focus: null };
}

/** A driving value the other constraints cannot meet is refused, and the old value stays. */
export const VALUE_CONFLICT = "That value cannot be met with the other constraints. The old value stays.";
/** A constraint that over-constrains the sketch is not added. */
export const ADD_CONFLICT = "That constraint cannot be met with the others, so it was not added.";

/**
 * The sketch with `withDims` solved, or null when the solve cannot meet a constraint that `before` could: a new
 * conflict, or a solve that does not converge. A conflict the sketch already had does not block an unrelated change.
 */
function solveOrRefuse(before: SketchData, withDims: SketchData): SketchData | null {
  const solved = solveSketch(withDims);
  if (solved.ok) return solved.sketch;
  const had = constraintStatus(before)?.conflicting ?? [];
  const fresh = solved.conflicting.filter((id) => !had.includes(id));
  if (fresh.length > 0 || solved.conflicting.length === 0) return null;
  return solveKeeping(before, withDims);
}

/**
 * The dimensions after an edit replaced or reshaped geometry (trim, fillet corner, offset). One that names a point or
 * an entity that is gone is dropped. On an entity whose end points the edit moved, only the directional constraints
 * stay (horizontal, vertical, parallel, perpendicular, angle); a size or a position there would now fight the edit
 * and lock the sketch, so it goes. A fillet keeps its own geometry, and the solver is not run.
 */
export function carryDims(before: SketchData, after: SketchData): SketchData {
  if (!after.dims?.length) return after;
  const points = new Set(after.points.map((point) => point.id));
  const entities = new Map(after.entities.map((entity) => [entity.id, entity]));
  const reshaped = new Set<number>();
  for (const old of before.entities) {
    const now = entities.get(old.id);
    if (now && JSON.stringify(entityEnds(old)) !== JSON.stringify(entityEnds(now))) reshaped.add(old.id);
  }
  const keepOnReshaped = new Set(["horizontal", "vertical", "parallel", "perpendicular", "angle"]);
  const drop = new Set<number>();
  for (const constraint of parseConstraints(after)) {
    const ids = namedIds(constraint);
    if (ids.points.some((id) => !points.has(id)) || ids.entities.some((id) => !entities.has(id))) drop.add(constraint.id);
    else if (ids.entities.some((id) => reshaped.has(id)) && !keepOnReshaped.has(constraint.kind)) drop.add(constraint.id);
  }
  return drop.size > 0 ? dropDimIds(after, drop) : after;
}

function entityEnds(entity: SketchEntity): number[] {
  if (entity.kind === "line" || entity.kind === "arc") return [entity.a, entity.b];
  if (entity.kind === "circle") return [entity.centre];
  return [...entity.through];
}

function dropDimIds(sketch: SketchData, drop: ReadonlySet<number>): SketchData {
  const kept = (sketch.dims ?? []).filter((dim) => !drop.has(dim.id));
  const released = new Set(parseConstraints(sketch).filter((item) => drop.has(item.id) && item.kind === "fixed").map((item) => (item.kind === "fixed" ? item.point : -1)));
  const next: SketchData = { ...sketch };
  if (kept.length) next.dims = kept;
  else delete next.dims;
  const still = new Set(parseConstraints(next).filter((item) => item.kind === "fixed").map((item) => (item.kind === "fixed" ? item.point : -1)));
  next.points = next.points.map((point) => {
    if (!released.has(point.id) || still.has(point.id) || !point.fixed) return point;
    const copy = { ...point };
    delete copy.fixed;
    return copy;
  });
  return next;
}

/**
 * A drawn rectangle's sides: its first and third lines horizontal, its second and fourth vertical, as the two-point
 * rectangle carries them in Fusion, so a width typed on one side and a dragged corner keep it square.
 */
export function withRectangleConstraints(sketch: SketchData, sides: readonly [number, number, number, number]): SketchData {
  let next = sketch;
  sides.forEach((line, index) => {
    next = addOne(next, { id: 0, kind: index % 2 === 0 ? "horizontal" : "vertical", line }).sketch;
  });
  return next;
}

/** A geometric constraint's mark beside the geometry it is on, which a click picks. */
export interface ConstraintGlyph {
  id: number;
  /** Several marks at one place sit side by side: this is the mark's place in that row. */
  slot: number;
  at: Pt;
  text: string;
  title: string;
}

const GLYPHS: Partial<Record<SketchConstraint["kind"], [string, string]>> = {
  horizontal: ["H", "Horizontal"],
  vertical: ["V", "Vertical"],
  parallel: ["∥", "Parallel"],
  perpendicular: ["⊥", "Perpendicular"],
  tangent: ["T", "Tangent"],
  equal: ["=", "Equal"],
  concentric: ["◎", "Concentric"],
  fixed: ["⊡", "Fixed"],
  midpoint: ["M", "Midpoint"],
  coincident: ["○", "On the curve"],
};

/** The marks of every constraint without a value, at each line's middle, each curve's top, or each point. */
export function constraintGlyphs(sketch: SketchData): ConstraintGlyph[] {
  const out: ConstraintGlyph[] = [];
  const slots = new Map<string, number>();
  const place = (id: number, at: Pt | null, mark: [string, string]) => {
    if (!at) return;
    const key = `${at[0].toFixed(3)},${at[1].toFixed(3)}`;
    const slot = slots.get(key) ?? 0;
    slots.set(key, slot + 1);
    out.push({ id, slot, at, text: mark[0], title: `${mark[1]}. Click to select it. Delete removes it.` });
  };
  const entityAt = (id: number): Pt | null => {
    const ends = lineEnds(sketch, id);
    if (ends) return [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2];
    const circle = entityCircle(sketch, id);
    return circle ? [circle.centre[0], circle.centre[1] + circle.radius] : null;
  };
  for (const constraint of parseConstraints(sketch)) {
    const mark = GLYPHS[constraint.kind];
    if (!mark || "value" in constraint) continue;
    const ids = namedIds(constraint);
    for (const entity of ids.entities) place(constraint.id, entityAt(entity), mark);
    if (ids.entities.length === 0) for (const point of ids.points) place(constraint.id, sketchPoint(sketch, point)?.at ?? null, mark);
  }
  return out;
}

export function dimensionLabels(sketch: SketchData): DimLabel[] {
  const labels: DimLabel[] = [];
  for (const constraint of parseConstraints(sketch)) {
    if (!("value" in constraint)) continue;
    const at = labelAnchor(sketch, constraint);
    if (!at) continue;
    const raw = sketch.dims?.find((dim) => dim.id === constraint.id);
    const expr = typeof raw?.expr === "string" && raw.expr.trim() ? raw.expr : undefined;
    labels.push({ id: constraint.id, text: labelText(constraint), at, title: labelTitle(constraint), spoken: labelSpoken(constraint), ...(expr ? { expr } : {}) });
  }
  return labels;
}

/** Degrees of freedom of the geometry as it stands. Null when there is nothing to solve. */
export function placedStatus(sketch: SketchData): ConstraintStatus | null {
  return constraintStatus(sketch);
}

export function dropConstraints(sketch: SketchData, entityIds: ReadonlySet<number>, pointIds: ReadonlySet<number>): SketchData {
  if (!sketch.dims?.length) return sketch;
  const kept: Dimension[] = [];
  for (const dim of sketch.dims) {
    const parsed = parseConstraints({ ...sketch, dims: [dim] })[0];
    if (!parsed) {
      kept.push(dim);
      continue;
    }
    if (constraintHits(parsed, entityIds, pointIds)) continue;
    kept.push(dim);
  }
  const next = kept.length === sketch.dims.length ? sketch : { ...sketch, ...(kept.length ? { dims: kept } : { dims: undefined }) };
  return clearFixed(next, pointIds);
}

function clearFixed(sketch: SketchData, pointIds: ReadonlySet<number>): SketchData {
  const still = new Set(parseConstraints(sketch).filter((item) => item.kind === "fixed").map((item) => (item.kind === "fixed" ? item.point : -1)));
  let changed = false;
  const points = sketch.points.map((point) => {
    if (!pointIds.has(point.id) || !point.fixed || still.has(point.id)) return point;
    changed = true;
    const copy = { ...point };
    delete copy.fixed;
    return copy;
  });
  return changed ? { ...sketch, points } : sketch;
}

function removeConstraints(sketch: SketchData, selection: { entities: number[]; points: number[] }, selectedDim: number | null): SketchData {
  const dims = sketch.dims ?? [];
  if (dims.length === 0) return sketch;
  const drop = new Set<number>();
  if (selectedDim != null) drop.add(selectedDim);
  const entities = new Set(selection.entities);
  const points = new Set(selection.points);
  if (drop.size === 0) {
    for (const constraint of parseConstraints(sketch)) {
      if (constraintHits(constraint, entities, points)) drop.add(constraint.id);
    }
  }
  if (drop.size === 0) return sketch;
  const kept = dims.filter((dim) => !drop.has(dim.id));
  let next: SketchData = kept.length ? { ...sketch, dims: kept } : { ...sketch };
  if (!kept.length) delete next.dims;
  const released = new Set<number>();
  for (const constraint of parseConstraints(sketch)) {
    if (drop.has(constraint.id) && constraint.kind === "fixed") released.add(constraint.point);
  }
  const still = new Set(parseConstraints(next).filter((item) => item.kind === "fixed").map((item) => (item.kind === "fixed" ? item.point : -1)));
  next = {
    ...next,
    points: next.points.map((point) => {
      if (!released.has(point.id) || still.has(point.id) || !point.fixed) return point;
      const copy = { ...point };
      delete copy.fixed;
      return copy;
    }),
  };
  return prunePoints(next);
}

function constraintHits(constraint: SketchConstraint, entities: ReadonlySet<number>, points: ReadonlySet<number>): boolean {
  const ids = namedIds(constraint);
  return ids.entities.some((id) => entities.has(id)) || ids.points.some((id) => points.has(id));
}

function namedIds(constraint: SketchConstraint): { entities: number[]; points: number[] } {
  if ((constraint.kind === "horizontal" || constraint.kind === "vertical") && "line" in constraint) {
    return { entities: [constraint.line], points: [] };
  }
  if ((constraint.kind === "horizontal" || constraint.kind === "vertical") && "a" in constraint) {
    return { entities: [], points: [constraint.a, constraint.b] };
  }
  if (constraint.kind === "fixed") return { entities: [], points: [constraint.point] };
  if (constraint.kind === "midpoint") return { entities: [constraint.line], points: [constraint.point] };
  if (constraint.kind === "coincident") return { entities: [constraint.entity], points: [constraint.point] };
  if (constraint.kind === "distance" && "point" in constraint && "line" in constraint) {
    return { entities: [constraint.line], points: [constraint.point] };
  }
  if (constraint.kind === "distance" && "a" in constraint) return { entities: [], points: [constraint.a, constraint.b] };
  if (constraint.kind === "length") return { entities: [constraint.line], points: [] };
  if (constraint.kind === "radius" || constraint.kind === "diameter") return { entities: [constraint.entity], points: [] };
  if ("a" in constraint && "b" in constraint) return { entities: [constraint.a, constraint.b], points: [] };
  return { entities: [], points: [] };
}

interface Draft {
  constraint?: SketchConstraint;
  /** More of the same kind, one for each further line selected. */
  more?: SketchConstraint[];
  extras?: number[];
  coincide?: [number, number];
  error?: string;
  hint?: string;
}

function fromSelection(sketch: SketchData, tool: ConstrainTool, selection: { entities: number[]; points: number[] }): Draft {
  const lines = selection.entities.filter((id) => sketchEntity(sketch, id)?.kind === "line");
  const rounds = selection.entities.filter((id) => {
    const kind = sketchEntity(sketch, id)?.kind;
    return kind === "circle" || kind === "arc";
  });
  const points = selection.points.filter((id) => sketchPoint(sketch, id));
  if (tool === "horizontal" || tool === "vertical") {
    // Every selected line that is not already this way takes it, as Fusion does with several lines selected.
    const already = new Set(parseConstraints(sketch).flatMap((item) => (item.kind === tool && "line" in item ? [item.line] : [])));
    const fresh = lines.filter((id) => !already.has(id));
    if (lines.length >= 1 && fresh.length === 0) return { error: tool === "horizontal" ? "Those lines are already horizontal." : "Those lines are already vertical." };
    if (fresh.length >= 1) {
      const [first, ...rest] = fresh.map((line): SketchConstraint => ({ id: 0, kind: tool, line }));
      return { constraint: first!, more: rest };
    }
    if (points.length === 2) return { constraint: { id: 0, kind: tool, a: points[0]!, b: points[1]! } };
    return { hint: tool === "horizontal" ? "Horizontal needs a line, or two points." : "Vertical needs a line, or two points." };
  }
  if (tool === "parallel" || tool === "perpendicular" || tool === "angle") {
    if (lines.length >= 2) {
      const constraint = tool === "angle" ? angleConstraint(sketch, lines[0]!, lines[1]!) : ({ id: 0, kind: tool, a: lines[0]!, b: lines[1]! } as SketchConstraint);
      return constraint ? { constraint } : { error: "Those lines need a direction." };
    }
    return { hint: tool === "angle" ? "Angle needs two lines." : `${labelOf(tool)} needs two lines.` };
  }
  if (tool === "tangent") {
    const pair = tangentPair(selection.entities.map((id) => sketchEntity(sketch, id)));
    if (!pair) return { hint: "Tangent needs a line and a circle or arc, or two circles or arcs." };
    return { constraint: tangentConstraint(sketch, pair[0], pair[1]) };
  }
  if (tool === "equal") {
    if (lines.length >= 2) return { constraint: { id: 0, kind: "equal", a: lines[0]!, b: lines[1]! } };
    if (rounds.length >= 2) return { constraint: { id: 0, kind: "equal", a: rounds[0]!, b: rounds[1]! } };
    return { hint: "Equal needs two lines, or two circles or arcs." };
  }
  if (tool === "concentric") {
    if (rounds.length >= 2) return { constraint: { id: 0, kind: "concentric", a: rounds[0]!, b: rounds[1]! } };
    return { hint: "Concentric needs two circles or arcs." };
  }
  if (tool === "fixed") {
    const ids = new Set<number>(points);
    for (const id of selection.entities) {
      const entity = sketchEntity(sketch, id);
      if (!entity) continue;
      if (entity.kind === "line" || entity.kind === "arc") {
        ids.add(entity.a);
        ids.add(entity.b);
      } else if (entity.kind === "circle") ids.add(entity.centre);
      else for (const point of entity.through) ids.add(point);
    }
    if (ids.size === 0) return { hint: "Fixed needs a point or a line." };
    const [first, ...extras] = [...ids];
    return { constraint: { id: 0, kind: "fixed", point: first! }, extras };
  }
  if (tool === "midpoint") {
    if (points.length >= 1 && lines.length >= 1) return { constraint: { id: 0, kind: "midpoint", point: points[0]!, line: lines[0]! } };
    return { hint: "Midpoint needs a point and a line." };
  }
  if (tool === "coincident") {
    if (points.length >= 2 && points[0] !== points[1]) return { coincide: [points[0]!, points[1]!] };
    // A point and a curve: the point stays on the line, circle or arc, anywhere along it.
    const curve = selection.entities.find((id) => {
      const entity = sketchEntity(sketch, id);
      if (!entity || entity.kind === "spline" || points.length !== 1) return false;
      const ends = entity.kind === "circle" ? [entity.centre] : [entity.a, entity.b];
      return !ends.includes(points[0]!);
    });
    if (points.length === 1 && curve != null) return { constraint: { id: 0, kind: "coincident", point: points[0]!, entity: curve } };
    return { hint: "Coincident needs two points, or a point and a line, circle or arc." };
  }
  if (tool === "distance") {
    if (points.length >= 2) return draftOf(distancePoints(sketch, points[0]!, points[1]!), "Those points are missing.");
    if (points.length === 1 && lines.length >= 1) return draftOf(distanceLine(sketch, points[0]!, lines[0]!), "That point and line cannot take a distance.");
    return { hint: "Distance needs two points, or a point and a line." };
  }
  if (tool === "length") {
    if (lines.length === 1) return draftOf(lengthOf(sketch, lines[0]!), "That line has no length.");
    return { hint: "Length needs a line." };
  }
  if (tool === "radius" || tool === "diameter") {
    if (rounds.length === 1) return draftOf(radial(sketch, rounds[0]!, tool), "That curve has no radius.");
    return { hint: `${labelOf(tool)} needs a circle or an arc.` };
  }
  return { hint: "Pick the geometry for this constraint." };
}

function selectionFromPicks(picks: readonly ConstrainPick[]): { entities: number[]; points: number[] } {
  const entities: number[] = [];
  const points: number[] = [];
  for (const pick of picks) {
    if (pick.point != null) points.push(pick.point);
    else if (pick.entity != null) entities.push(pick.entity);
  }
  return { entities, points };
}

function picksNeeded(tool: ConstrainTool): number {
  if (tool === "fixed" || tool === "length" || tool === "radius" || tool === "diameter") return 1;
  return 2;
}

function draftOf(constraint: SketchConstraint | null, error: string): Draft {
  return constraint ? { constraint } : { error };
}

function commitAdded(sketch: SketchData, constraint: SketchConstraint, extras: readonly number[], more: readonly SketchConstraint[] = []): ConstrainBuild {
  // A point put on a curve moves onto it first, so the solve starts met and the curve stays where it is.
  let next = addOne(constraint.kind === "coincident" ? ontoCurve(sketch, constraint.point, constraint.entity) : sketch, constraint);
  const focus = "value" in constraint ? next.id : null;
  for (const point of extras) next = { sketch: addOne(next.sketch, { id: 0, kind: "fixed", point }).sketch, id: next.id };
  for (const extra of more) next = { sketch: addOne(next.sketch, extra).sketch, id: next.id };
  const solved = solveOrRefuse(sketch, next.sketch);
  if (!solved) return { error: ADD_CONFLICT };
  return { sketch: solved, focus };
}

/** `point` moved to the nearest place on the line through `entity`, or on its circle. */
function ontoCurve(sketch: SketchData, point: number, entity: number): SketchData {
  const at = sketchPoint(sketch, point)?.at;
  if (!at || sketchPoint(sketch, point)?.fixed) return sketch;
  let to: Pt | null = null;
  const ends = lineEnds(sketch, entity);
  if (ends) {
    const dir = unit(sub(ends[1], ends[0]));
    if (dir) {
      const along = (at[0] - ends[0][0]) * dir[0] + (at[1] - ends[0][1]) * dir[1];
      to = [ends[0][0] + dir[0] * along, ends[0][1] + dir[1] * along];
    }
  } else {
    const circle = entityCircle(sketch, entity);
    const dir = circle ? unit(sub(at, circle.centre)) : null;
    if (circle && dir) to = [circle.centre[0] + dir[0] * circle.radius, circle.centre[1] + dir[1] * circle.radius];
  }
  if (!to) return sketch;
  return { ...sketch, points: sketch.points.map((item) => (item.id === point ? { ...item, at: to! } : item)) };
}

function addOne(sketch: SketchData, constraint: SketchConstraint): { sketch: SketchData; id: number } {
  const id = nextDimId(sketch);
  const { extra: _extra, coincide: _coincide, ...rest } = constraint as SketchConstraint & { extra?: number[]; coincide?: [number, number] };
  const stored = { ...rest, id } as Dimension;
  const dims = [...(sketch.dims ?? []), stored];
  let next: SketchData = { ...sketch, dims };
  if (constraint.kind === "fixed") {
    next = {
      ...next,
      points: next.points.map((point) => (point.id === constraint.point ? { ...point, fixed: true as const } : point)),
    };
  }
  return { sketch: next, id };
}

function solveKeeping(before: SketchData, withDims: SketchData): SketchData {
  const solved = solveSketch(withDims);
  if (solved.ok) return solved.sketch;
  const points = before.points.map((point) => {
    const locked = (withDims.dims ?? []).some((dim) => dim.kind === "fixed" && dim.point === point.id);
    if (!locked || point.fixed) return { ...point, at: [point.at[0], point.at[1]] as Pt };
    return { ...point, at: [point.at[0], point.at[1]] as Pt, fixed: true as const };
  });
  return { ...before, points, entities: before.entities.map((entity) => ({ ...entity })), dims: withDims.dims };
}

function coincide(sketch: SketchData, a: number, b: number): SketchData {
  if (a === b) return sketch;
  const pa = sketchPoint(sketch, a);
  const pb = sketchPoint(sketch, b);
  if (!pa || !pb) return sketch;
  const keep = pb.fixed && !pa.fixed ? b : a;
  const drop = keep === a ? b : a;
  const keptAt = sketchPoint(sketch, keep)!.at;
  const droppedAt = sketchPoint(sketch, drop)!.at;
  const at: Pt = sketchPoint(sketch, keep)!.fixed ? keptAt : sketchPoint(sketch, drop)!.fixed ? droppedAt : keptAt;
  const points = sketch.points
    .filter((point) => point.id !== drop)
    .map((point) => (point.id === keep ? { ...point, at: [at[0], at[1]] as Pt, ...(point.fixed || sketchPoint(sketch, drop)?.fixed ? { fixed: true as const } : {}) } : point));
  const entities = sketch.entities.map((entity) => retarget(entity, drop, keep));
  const dims = (sketch.dims ?? []).map((dim) => retargetDim(dim, drop, keep));
  const next: SketchData = { ...sketch, points, entities, ...(dims.length ? { dims } : {}) };
  return prunePoints(next);
}

function retarget(entity: SketchEntity, drop: number, keep: number): SketchEntity {
  const swap = (id: number) => (id === drop ? keep : id);
  if (entity.kind === "line" || entity.kind === "arc") return { ...entity, a: swap(entity.a), b: swap(entity.b) };
  if (entity.kind === "circle") return { ...entity, centre: swap(entity.centre) };
  return { ...entity, through: entity.through.map(swap) };
}

function retargetDim(dim: Dimension, drop: number, keep: number): Dimension {
  const swap = (value: unknown) => (value === drop ? keep : value);
  const next: Dimension = { ...dim };
  for (const key of ["a", "b", "point", "line", "entity"]) {
    if (key in next) next[key] = swap(next[key]);
  }
  return next;
}

function angleConstraint(sketch: SketchData, a: number, b: number): SketchConstraint | null {
  const value = angleBetween(sketch, a, b);
  if (value == null) return null;
  return { id: 0, kind: "angle", a, b, value };
}

function distancePoints(sketch: SketchData, a: number, b: number): SketchConstraint | null {
  const pa = sketchPoint(sketch, a)?.at;
  const pb = sketchPoint(sketch, b)?.at;
  if (!pa || !pb) return null;
  return { id: 0, kind: "distance", a, b, value: Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) };
}

function distanceLine(sketch: SketchData, point: number, line: number): SketchConstraint | null {
  const at = sketchPoint(sketch, point)?.at;
  const ends = lineEnds(sketch, line);
  if (!at || !ends) return null;
  const dx = ends[1][0] - ends[0][0];
  const dy = ends[1][1] - ends[0][1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;
  const cross = (dx * (at[1] - ends[0][1]) - dy * (at[0] - ends[0][0])) / length;
  return { id: 0, kind: "distance", point, line, value: Math.abs(cross), side: (Math.sign(cross) || 1) as 1 | -1 };
}

function lengthOf(sketch: SketchData, line: number): SketchConstraint | null {
  const ends = lineEnds(sketch, line);
  if (!ends) return null;
  return { id: 0, kind: "length", line, value: Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]) };
}

function radial(sketch: SketchData, entityId: number, kind: "radius" | "diameter"): SketchConstraint | null {
  const radius = entityRadius(sketch, entityId);
  if (radius == null) return null;
  return { id: 0, kind, entity: entityId, value: kind === "diameter" ? radius * 2 : radius };
}

function tangentConstraint(sketch: SketchData, a: number, b: number): SketchConstraint {
  const lineId = sketchEntity(sketch, a)?.kind === "line" ? a : sketchEntity(sketch, b)?.kind === "line" ? b : null;
  const other = lineId === a ? b : lineId === b ? a : null;
  if (lineId != null && other != null) {
    const ends = lineEnds(sketch, lineId);
    const circle = entityCircle(sketch, other);
    if (ends && circle) {
      const dx = ends[1][0] - ends[0][0];
      const dy = ends[1][1] - ends[0][1];
      const length = Math.hypot(dx, dy) || 1;
      const signed = (dx * (circle.centre[1] - ends[0][1]) - dy * (circle.centre[0] - ends[0][0])) / length;
      return { id: 0, kind: "tangent", a, b, side: (Math.sign(signed) || 1) as 1 | -1 };
    }
  }
  const ca = entityCircle(sketch, a);
  const cb = entityCircle(sketch, b);
  if (ca && cb) {
    const gap = Math.hypot(ca.centre[0] - cb.centre[0], ca.centre[1] - cb.centre[1]);
    const inner = Math.abs(gap - Math.abs(ca.radius - cb.radius)) <= Math.abs(gap - (ca.radius + cb.radius));
    return { id: 0, kind: "tangent", a, b, inner };
  }
  return { id: 0, kind: "tangent", a, b };
}

function tangentPair(entities: (SketchEntity | undefined)[]): [number, number] | null {
  const usable = entities.filter((entity): entity is SketchEntity => !!entity && (entity.kind === "line" || entity.kind === "circle" || entity.kind === "arc"));
  if (usable.length < 2) return null;
  return [usable[0]!.id, usable[1]!.id];
}

function labelAnchor(sketch: SketchData, constraint: SketchConstraint): Pt | null {
  if (constraint.kind === "length") {
    const ends = lineEnds(sketch, constraint.line);
    if (!ends) return null;
    return offsetMid(ends[0], ends[1], 6);
  }
  if (constraint.kind === "distance" && "a" in constraint && !("point" in constraint)) {
    const ends = pointPair(sketch, constraint.a, constraint.b);
    if (!ends) return null;
    return offsetMid(ends[0], ends[1], 6);
  }
  if (constraint.kind === "distance" && "point" in constraint && "line" in constraint) {
    const at = sketchPoint(sketch, constraint.point)?.at;
    const ends = lineEnds(sketch, constraint.line);
    if (!at || !ends) return null;
    return [(at[0] + (ends[0][0] + ends[1][0]) / 2) / 2, (at[1] + (ends[0][1] + ends[1][1]) / 2) / 2];
  }
  if (constraint.kind === "radius" || constraint.kind === "diameter") {
    const circle = entityCircle(sketch, constraint.entity);
    if (!circle) return null;
    const reach = circle.radius + 4;
    return [circle.centre[0] + reach * Math.SQRT1_2, circle.centre[1] + reach * Math.SQRT1_2];
  }
  if (constraint.kind === "angle") {
    const a = lineEnds(sketch, constraint.a);
    const b = lineEnds(sketch, constraint.b);
    if (!a || !b) return null;
    const hit = lineHit(a[0], a[1], b[0], b[1]);
    return hit ?? offsetMid(a[0], a[1], 6);
  }
  return null;
}

function labelText(constraint: SketchConstraint): string {
  const value = "value" in constraint && typeof constraint.value === "number" ? constraint.value : 0;
  const text = formatDim(value);
  if (constraint.kind === "angle") return `${text}°`;
  if (constraint.kind === "diameter") return `⌀${text}`;
  if (constraint.kind === "radius") return `R${text}`;
  return text;
}

function labelSpoken(constraint: SketchConstraint): string {
  const value = formatDim("value" in constraint && typeof constraint.value === "number" ? constraint.value : 0);
  if (constraint.kind === "angle") return `Angle ${value}°`;
  const noun = constraint.kind === "diameter" ? "Diameter" : constraint.kind === "radius" ? "Radius" : constraint.kind === "distance" ? "Distance" : "Length";
  return `${noun} ${value} mm`;
}

function labelTitle(constraint: SketchConstraint): string {
  if (constraint.kind === "angle") return "Angle. Click to type a new one.";
  if (constraint.kind === "diameter") return "Diameter. Click to type a new one.";
  if (constraint.kind === "radius") return "Radius. Click to type a new one.";
  if (constraint.kind === "distance") return "Distance. Click to type a new one.";
  return "Length. Click to type a new one.";
}

function formatDim(value: number): string {
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round(value * 100) / 100;
  let text = rounded.toFixed(2);
  text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

function labelOf(tool: ConstrainTool): string {
  return tool.charAt(0).toUpperCase() + tool.slice(1);
}

function nextDimId(sketch: SketchData): number {
  return (sketch.dims ?? []).reduce((max, dim) => Math.max(max, dim.id), 0) + 1;
}

function lineEnds(sketch: SketchData, id: number): [Pt, Pt] | null {
  const entity = sketchEntity(sketch, id);
  if (entity?.kind !== "line") return null;
  const a = sketchPoint(sketch, entity.a)?.at;
  const b = sketchPoint(sketch, entity.b)?.at;
  return a && b ? [a, b] : null;
}

function pointPair(sketch: SketchData, a: number, b: number): [Pt, Pt] | null {
  const pa = sketchPoint(sketch, a)?.at;
  const pb = sketchPoint(sketch, b)?.at;
  return pa && pb ? [pa, pb] : null;
}

function entityRadius(sketch: SketchData, id: number): number | null {
  return entityCircle(sketch, id)?.radius ?? null;
}

function entityCircle(sketch: SketchData, id: number): { centre: Pt; radius: number } | null {
  const entity = sketchEntity(sketch, id);
  if (entity?.kind === "circle") {
    const centre = sketchPoint(sketch, entity.centre)?.at;
    return centre ? { centre, radius: entity.radius } : null;
  }
  if (entity?.kind === "arc") {
    const a = sketchPoint(sketch, entity.a)?.at;
    const b = sketchPoint(sketch, entity.b)?.at;
    if (!a || !b) return null;
    const arc = arcFrom3(a, entity.through, b);
    return arc ? { centre: arc.centre, radius: arc.radius } : null;
  }
  return null;
}

function angleBetween(sketch: SketchData, a: number, b: number): number | null {
  const la = lineEnds(sketch, a);
  const lb = lineEnds(sketch, b);
  if (!la || !lb) return null;
  const ua = unit(sub(la[1], la[0]));
  const ub = unit(sub(lb[1], lb[0]));
  if (!ua || !ub) return null;
  return (Math.atan2(ua[0] * ub[1] - ua[1] * ub[0], ua[0] * ub[0] + ua[1] * ub[1]) * 180) / Math.PI;
}

function offsetMid(a: Pt, b: Pt, gap: number): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy) || 1;
  return [(a[0] + b[0]) / 2 + (-dy / length) * gap, (a[1] + b[1]) / 2 + (dx / length) * gap];
}

function lineHit(a0: Pt, a1: Pt, b0: Pt, b1: Pt): Pt | null {
  const dax = a1[0] - a0[0];
  const day = a1[1] - a0[1];
  const dbx = b1[0] - b0[0];
  const dby = b1[1] - b0[1];
  const det = dax * dby - day * dbx;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((b0[0] - a0[0]) * dby - (b0[1] - a0[1]) * dbx) / det;
  return [a0[0] + t * dax, a0[1] + t * day];
}

function sub(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]];
}

function unit(v: Pt): Pt | null {
  const length = Math.hypot(v[0], v[1]);
  if (length < 1e-12) return null;
  return [v[0] / length, v[1] / length];
}

/** The first line's length and rise, so a test can see that a driving length landed. */
export function firstLineMeasure(sketch: SketchData): { length: number; rise: number } | null {
  const line = sketch.entities.find((entity) => entity.kind === "line");
  if (line?.kind !== "line") return null;
  const ends = lineEnds(sketch, line.id);
  if (!ends) return null;
  return { length: Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]), rise: ends[1][1] - ends[0][1] };
}

export function drivingField(sketch: SketchData, id: number): { id: string; label: string; unit: string; value: number } | null {
  const constraint = parseConstraints(sketch).find((item) => item.id === id);
  if (!constraint || !("value" in constraint)) return null;
  const unit = constraint.kind === "angle" ? "°" : "mm";
  const label = constraint.kind === "diameter" ? "Diameter" : constraint.kind === "radius" ? "Radius" : constraint.kind === "angle" ? "Angle" : constraint.kind === "distance" ? "Distance" : "Length";
  return { id: String(constraint.id), label, unit, value: constraint.value };
}
