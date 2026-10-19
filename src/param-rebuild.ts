/**
 * --- A6. Bring a stored op up to a new parameter table: its numbers, then a sketch whose
 * driving dimensions name a parameter, then a feature or pattern whose source changed.
 */
import { IDENTITY_POSE, type Affine } from "./model-space.ts";
import { expandFeature, featureSource, type FeatureSolid } from "./model-features.ts";
import { expandRepeat, repeatSource } from "./model-repeat.ts";
import type { ModelOp } from "./model-tree.ts";
import { evaluate, type Params } from "./modeling/expr.ts";
import { expressionChanged, patchOpNumbers, type ParamTable } from "./modeling/params.ts";
import { commitDriving } from "./sketch/constrain.ts";
import { buildSketchExtrude, chooseRegions, presetOf, sketchForFeature } from "./sketch/extrude.ts";
import { holesInModel, pointsFromSource, sketchHoleSource, type HoleSizes } from "./sketch/holes.ts";
import type { SketchData } from "./sketch/model.ts";
import { buildSketchRevolve, revolvePresetOf, sketchForRevolve } from "./sketch/revolve.ts";

export interface RefreshContext {
  pose?: Affine;
  /** The solid the feature was built on, in the solid's frame. */
  solid?: FeatureSolid | null;
  /** The ops a pattern or mirror repeats, in the solid's frame. */
  repeated?: readonly { id: number; op: ModelOp }[];
  /**
   * Write each expression's new value even when the stored number was not the old evaluation.
   * Used when a file's numbers and its parameter table have drifted apart.
   */
  absolute?: boolean;
}

function dimExprs(sketch: SketchData): { id: number; expr: string }[] {
  const found: { id: number; expr: string }[] = [];
  for (const dim of sketch.dims ?? []) {
    if (typeof dim.expr === "string" && dim.expr.trim()) found.push({ id: dim.id, expr: dim.expr });
  }
  return found;
}

function refreshSketch(sketch: SketchData, before: Params, after: Params): { sketch: SketchData; error?: string; changed: boolean } {
  let next = sketch;
  let changed = false;
  for (const dim of dimExprs(sketch)) {
    if (!expressionChanged(dim.expr, before, after)) continue;
    let value: number;
    try {
      value = evaluate(dim.expr, after);
    } catch (err) {
      return { sketch, changed: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!Number.isFinite(value)) return { sketch, changed: false, error: `"${dim.expr}" is not a finite number.` };
    const built = commitDriving(next, dim.id, value, dim.expr);
    if (!built.sketch) return { sketch, changed: false, error: built.error ?? "That dimension could not be rebuilt." };
    next = built.sketch;
    changed = true;
  }
  return { sketch: next, changed };
}

function copyExprs(op: ModelOp, exprs: ModelOp["exprs"]): ModelOp {
  return exprs ? { ...op, exprs } : op;
}

function rebuildExtrude(op: ModelOp, sketch: SketchData): { op: ModelOp; error?: string } {
  const preset = presetOf(op, false);
  if (!preset) return { op, error: "This extrude cannot be rebuilt from its sketch." };
  const regions = chooseRegions(sketch, [], null);
  if (regions.length === 0) return { op, error: "This extrude's sketch has no region to rebuild." };
  const built = buildSketchExtrude({
    sketch,
    regions,
    distance: preset.distance,
    depth2: preset.depth2,
    draftDeg: preset.draftDeg,
    upTo: preset.upTo,
    mode: preset.choice === "cut" || preset.choice === "common" || preset.choice === "fuse" || preset.choice === "new" ? preset.choice : "fuse",
  });
  if ("error" in built) return { op, error: built.error };
  return { op: copyExprs(built.op, op.exprs) };
}

function rebuildRevolve(op: ModelOp, sketch: SketchData): { op: ModelOp; error?: string } {
  const preset = revolvePresetOf(op, false);
  if (!preset) return { op, error: "This revolve cannot be rebuilt from its sketch." };
  const regions = chooseRegions(sketch, [], null);
  if (regions.length === 0) return { op, error: "This revolve's sketch has no region to rebuild." };
  const built = buildSketchRevolve({
    sketch,
    regions,
    axis: preset.axis,
    angleDeg: preset.angleDeg,
    mode: preset.choice === "cut" || preset.choice === "common" || preset.choice === "fuse" || preset.choice === "new" ? preset.choice : "fuse",
  });
  if ("error" in built) return { op, error: built.error };
  return { op: copyExprs(built.op, op.exprs) };
}

function rebuildHoles(op: ModelOp, sketch: SketchData, pose: Affine): { op: ModelOp; error?: string } {
  const source = sketchHoleSource(op);
  if (!source || op.kind !== "group") return { op };
  const points = pointsFromSource({ ...source, sketch });
  if (points.length === 0) return { op, error: "This hole's sketch points are no longer there." };
  const sizes: HoleSizes = {
    radius: source.radius,
    depth: source.depth,
    through: source.through === true,
    counterboreRadius: source.counterboreRadius ?? null,
    counterboreDepth: source.counterboreDepth ?? null,
  };
  const built = holesInModel({ sketch, points, pose, sizes });
  if ("error" in built) return { op, error: built.error };
  return { op: copyExprs(built.op, op.exprs) };
}

function sketchChanged(op: ModelOp, before: Params, after: Params, pose: Affine): { op: ModelOp; error?: string; toSolid?: boolean } {
  if (op.kind === "extrude" || op.kind === "revolve") {
    const sketch = op.kind === "extrude" ? sketchForFeature(op) : sketchForRevolve(op);
    if (!sketch) return { op };
    const refreshed = refreshSketch(sketch, before, after);
    if (refreshed.error) return { op, error: refreshed.error };
    if (!refreshed.changed) return { op };
    return op.kind === "extrude" ? rebuildExtrude(op, refreshed.sketch) : rebuildRevolve(op, refreshed.sketch);
  }
  if (op.kind === "group" && sketchHoleSource(op)) {
    const source = sketchHoleSource(op);
    if (!source) return { op };
    const refreshed = refreshSketch(source.sketch, before, after);
    if (refreshed.error) return { op, error: refreshed.error };
    if (!refreshed.changed) return { op };
    const holes = rebuildHoles(op, refreshed.sketch, pose);
    return holes.error ? holes : { ...holes, toSolid: true };
  }
  if (op.kind === "group") {
    const steps: ModelOp[] = [];
    for (const step of op.steps) {
      const child = sketchChanged(step, before, after, pose);
      if (child.error) return { op, error: child.error };
      steps.push(child.op);
    }
    return steps.some((step, index) => step !== op.steps[index]) ? { op: { ...op, steps } } : { op };
  }
  if (op.kind === "loft" && op.drawing?.sketches) {
    for (const sketch of op.drawing.sketches) {
      if (!sketch) continue;
      const refreshed = refreshSketch(sketch, before, after);
      if (refreshed.error) return { op, error: refreshed.error };
      if (refreshed.changed) return { op, error: "This loft's sketch changed. Edit the loft to rebuild its sections." };
    }
  }
  if (op.kind === "loft" && op.drawing?.sweep?.profile) {
    const refreshed = refreshSketch(op.drawing.sweep.profile, before, after);
    if (refreshed.error) return { op, error: refreshed.error };
    if (refreshed.changed) return { op, error: "This sweep's sketch changed. Edit the sweep to rebuild it." };
  }
  return { op };
}

function reexpand(op: ModelOp, before: ModelOp, ctx: RefreshContext): { op: ModelOp; error?: string; toSolid?: boolean } {
  if (op.kind !== "group" || op === before) return { op };
  const feature = featureSource(op);
  if (feature) {
    if (!ctx.solid) return { op, error: "Show the step this feature was built on, then rebuild." };
    const face = typeof feature.faceIndex === "number" ? feature.faceIndex : null;
    const expanded = expandFeature(feature, ctx.solid, ctx.pose ?? IDENTITY_POSE, face);
    if (!expanded.group) return { op, error: expanded.note ?? "This feature could not be rebuilt." };
    return { op: copyExprs(expanded.group, op.exprs), toSolid: true };
  }
  const repeated = repeatSource(op);
  const beforeSource = before.kind === "group" ? before.source : undefined;
  if (repeated && ctx.repeated && JSON.stringify(op.source) !== JSON.stringify(beforeSource)) {
    const expanded = expandRepeat(repeated, ctx.repeated, ctx.pose ?? IDENTITY_POSE);
    if (!expanded.group) return { op, error: expanded.note ?? "This pattern could not be rebuilt." };
    return { op: copyExprs(expanded.group, op.exprs), toSolid: true };
  }
  return { op };
}

/** `op` evaluated again at `after`. `error` is the evaluator's sentence, or why the sketch could not rebuild. `toSolid` means the op is in model space and still needs the solid's frame. */
export function refreshOp(op: ModelOp, before: Params, after: Params, ctx: RefreshContext = {}): { op: ModelOp; error?: string; toSolid?: boolean } {
  const numbers = patchOpNumbers(op, before, after, ctx.absolute === true);
  if (numbers.error) return numbers;
  const drawn = sketchChanged(numbers.op, before, after, ctx.pose ?? IDENTITY_POSE);
  if (drawn.error) return drawn;
  const expanded = reexpand(drawn.op, op, ctx);
  if (expanded.error) return expanded;
  return { op: expanded.op, toSolid: drawn.toSolid === true || expanded.toSolid === true };
}

export type { ParamTable };
