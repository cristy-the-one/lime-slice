/**
 * --- A6. Bring a stored op up to a new parameter table: its numbers, then a sketch whose
 * driving dimensions name a parameter, then a feature or pattern whose source changed.
 */
import { IDENTITY_POSE, toSolidOp, type Affine } from "./model-space.ts";
import { replayChain } from "./model-edit.ts";
import { expandFeature, featureSource, type FeatureSolid } from "./model-features.ts";
import { expandRepeat, repeatSource } from "./model-repeat.ts";
import { ROOT, isSketchExtrudeGroup, isSketchRevolveGroup, pathTo, type ModelOp, type ModelTree, type NodeId } from "./model-tree.ts";
import { evaluate, type Params } from "./modeling/expr.ts";
import { patchOpNumbers, stepOutOfDate, type ParamTable } from "./modeling/params.ts";
import { commitDriving } from "./sketch/constrain.ts";
import { buildSketchExtrude, chooseRegions, featureOutlines, presetOf, regionsOfOutlines, sketchForFeature } from "./sketch/extrude.ts";
import { holesInModel, pointsFromSource, sketchHoleSource, type HoleSizes } from "./sketch/holes.ts";
import type { SketchData } from "./sketch/model.ts";
import { buildSketchRevolve, revolveOutlines, revolvePresetOf, sketchForRevolve } from "./sketch/revolve.ts";

export interface RefreshContext {
  pose?: Affine;
  /** The solid the feature was built on, in the solid's frame. */
  solid?: FeatureSolid | null;
  /** The ops a pattern or mirror repeats, in the solid's frame. */
  repeated?: readonly { id: number; op: ModelOp }[];
}

function dimExprs(sketch: SketchData): { id: number; expr: string; value: unknown }[] {
  const found: { id: number; expr: string; value: unknown }[] = [];
  for (const dim of sketch.dims ?? []) {
    if (typeof dim.expr === "string" && dim.expr.trim()) found.push({ id: dim.id, expr: dim.expr, value: dim.value });
  }
  return found;
}

function refreshSketch(sketch: SketchData, after: Params): { sketch: SketchData; error?: string; changed: boolean } {
  let next = sketch;
  let changed = false;
  for (const dim of dimExprs(sketch)) {
    let value: number;
    try {
      value = evaluate(dim.expr, after);
    } catch (err) {
      return { sketch, changed: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!Number.isFinite(value)) return { sketch, changed: false, error: `"${dim.expr}" is not a finite number.` };
    if (typeof dim.value === "number" && Math.abs(dim.value - value) <= 1e-6) continue;
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

/**
 * The regions the step was applied to, found again in the re-solved sketch by outline or by a point inside it, so a
 * group of several regions rebuilds all of them. A step with no stored outline takes the only outer region.
 */
function sameRegions(sketch: SketchData, outlines: Parameters<typeof regionsOfOutlines>[1]) {
  const found = outlines.length > 0 ? regionsOfOutlines(sketch, outlines) : [];
  return found.length > 0 ? found : chooseRegions(sketch, [], null);
}

function rebuildExtrude(op: ModelOp, sketch: SketchData): { op: ModelOp; error?: string } {
  const preset = presetOf(op, false);
  if (!preset) return { op, error: "This extrude cannot be rebuilt from its sketch." };
  const regions = sameRegions(sketch, featureOutlines(op));
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
  const regions = sameRegions(sketch, revolveOutlines(op));
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

function sketchChanged(op: ModelOp, after: Params, pose: Affine): { op: ModelOp; error?: string; toSolid?: boolean } {
  // A group of several regions from one sketch is rebuilt whole, each region found again, not step by step.
  const extrudeGroup: boolean = isSketchExtrudeGroup(op);
  const revolveGroup: boolean = isSketchRevolveGroup(op);
  if (op.kind === "extrude" || op.kind === "revolve" || extrudeGroup || revolveGroup) {
    const extruded = op.kind === "extrude" || extrudeGroup;
    const sketch = extruded ? sketchForFeature(op) : sketchForRevolve(op);
    if (!sketch) return { op };
    const refreshed = refreshSketch(sketch, after);
    if (refreshed.error) return { op, error: refreshed.error };
    if (!refreshed.changed) return { op };
    return extruded ? rebuildExtrude(op, refreshed.sketch) : rebuildRevolve(op, refreshed.sketch);
  }
  if (op.kind === "group" && sketchHoleSource(op)) {
    const source = sketchHoleSource(op);
    if (!source) return { op };
    const refreshed = refreshSketch(source.sketch, after);
    if (refreshed.error) return { op, error: refreshed.error };
    if (!refreshed.changed) return { op };
    const holes = rebuildHoles(op, refreshed.sketch, pose);
    return holes.error ? holes : { ...holes, toSolid: true };
  }
  if (op.kind === "group") {
    const steps: ModelOp[] = [];
    for (const step of op.steps) {
      const child = sketchChanged(step, after, pose);
      if (child.error) return { op, error: child.error };
      steps.push(child.op);
    }
    return steps.some((step, index) => step !== op.steps[index]) ? { op: { ...op, steps } } : { op };
  }
  if (op.kind === "loft" && op.drawing?.sketches) {
    for (const sketch of op.drawing.sketches) {
      if (!sketch) continue;
      const refreshed = refreshSketch(sketch, after);
      if (refreshed.error) return { op, error: refreshed.error };
      if (refreshed.changed) return { op, error: "This loft's sketch changed. Edit the loft to rebuild its sections." };
    }
  }
  if (op.kind === "loft" && op.drawing?.sweep?.profile) {
    const refreshed = refreshSketch(op.drawing.sweep.profile, after);
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
export function refreshOp(op: ModelOp, after: Params, ctx: RefreshContext = {}): { op: ModelOp; error?: string; toSolid?: boolean } {
  const numbers = patchOpNumbers(op, after);
  if (numbers.error) return numbers;
  const drawn = sketchChanged(numbers.op, after, ctx.pose ?? IDENTITY_POSE);
  if (drawn.error) return drawn;
  const expanded = reexpand(drawn.op, op, ctx);
  if (expanded.error) return expanded;
  return { op: expanded.op, toSolid: drawn.toSolid === true || expanded.toSolid === true };
}

/** History steps on the shown branch whose stored numbers no longer match `after`, the new solid's root first. */
export function outOfDateSteps(tree: ModelTree, after: Params): NodeId[] {
  const path = pathTo(tree, tree.current);
  const rootOnPath = path.some((id) => tree.nodes.get(id)?.op?.kind === "root");
  const hits: NodeId[] = [];
  if (!rootOnPath && tree.root.kind === "primitive" && tree.root.exprs) {
    const rootOp: ModelOp = { kind: "root", ...tree.root.solid, exprs: tree.root.exprs };
    if (stepOutOfDate(rootOp, after)) hits.push(ROOT);
  }
  for (const id of path) {
    const op = tree.nodes.get(id)?.op;
    if (!op || (id === ROOT && hits.includes(ROOT))) continue;
    if (stepOutOfDate(op, after)) hits.push(id);
  }
  return hits;
}

/** What a parameter rebuild replays: the earliest out-of-date step, edited as `supplied[0]`, then the shown branch under it. */
export interface BranchRebuild {
  node: NodeId;
  parent: NodeId;
  /** The step shown when the plan was made. */
  from: NodeId;
  replay: NodeId[];
  supplied: ModelOp[];
}

export interface RebuildContext {
  /** The solid's pose in model space. */
  pose: Affine;
  /** The solid step `parent` built, which a feature step re-expands on, or why it could not be had. */
  builtOn(parent: NodeId): Promise<FeatureSolid | string>;
  /** False once the history moved on while the plan waited for a solid: the plan is dropped. */
  current?(): boolean;
}

/** `refreshOp` on a stored step, with what its feature or pattern re-expands on, in the solid's own frame. */
async function refreshStep(op: ModelOp, after: Params, tree: ModelTree, parent: NodeId, ctx: RebuildContext): Promise<{ op: ModelOp; error?: string }> {
  let solid: FeatureSolid | null = null;
  if (op.kind === "group" && featureSource(op)) {
    const found = await ctx.builtOn(parent);
    if (typeof found === "string") return { op, error: found };
    solid = found;
  }
  let repeated: { id: number; op: ModelOp }[] | undefined;
  if (op.kind === "group") {
    const source = repeatSource(op);
    const of = source && Array.isArray(source.of) ? source.of : null;
    if (of) {
      repeated = [];
      for (const id of of) {
        if (typeof id !== "number") continue;
        const step = tree.nodes.get(id)?.op;
        if (step) repeated.push({ id, op: step });
      }
    }
  }
  const next = refreshOp(op, after, { pose: ctx.pose, solid, repeated });
  if (next.error || !next.toSolid) return next;
  return { op: toSolidOp(next.op, ctx.pose) };
}

/**
 * --- Gaps A5. The Parameters panel's Rebuild, as data: the shown branch replayed from the earliest step `after` reaches,
 * each step brought up to it. Null when nothing is out of date, "stale" when the history moved on while it waited, and
 * an error sentence when a step cannot follow. The app's Rebuild and the MCP's model_params rebuild both run it.
 */
export async function planRebuild(tree: ModelTree, after: Params, ctx: RebuildContext): Promise<BranchRebuild | { error: string } | "stale" | null> {
  const hits = outOfDateSteps(tree, after);
  if (hits.length === 0) return null;
  const earliest = hits[0]!;
  const node = tree.nodes.get(earliest);
  if (!node) return { error: "This step is no longer in the history." };
  const from = tree.current;
  const parent = node.parent ?? ROOT;
  const replay = replayChain(tree, earliest, from);
  const startOp = node.op ?? (tree.root.kind === "primitive" ? { kind: "root" as const, ...tree.root.solid, ...(tree.root.exprs ? { exprs: tree.root.exprs } : {}) } : null);
  if (!startOp) return { error: "This step cannot be rebuilt." };
  const supplied: ModelOp[] = [];
  const first = await refreshStep(startOp, after, tree, parent, ctx);
  if (ctx.current && !ctx.current()) return "stale";
  if (first.error) return { error: first.error };
  supplied.push(first.op);
  for (const id of replay) {
    const step = tree.nodes.get(id)?.op;
    if (!step) return { error: "This step is no longer in the history." };
    const next = await refreshStep(step, after, tree, tree.nodes.get(id)?.parent ?? ROOT, ctx);
    if (ctx.current && !ctx.current()) return "stale";
    if (next.error) return { error: next.error };
    supplied.push(next.op);
  }
  return { node: earliest, parent, from, replay, supplied };
}

export type { ParamTable };
