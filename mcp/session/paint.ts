/**
 * Support, seam, and reinforcement paint.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import type { RigidPose } from "../../src/mesh-place.ts";
import { boundsOf } from "../../src/modeling/model-calls.ts";
import { appendEdit, GROW_DEFAULT, GROW_MAX } from "../../src/support-edit-list.ts";
import { growFor, indexSkeleton, selectLimbs, sitesOf } from "../../src/support-pick.ts";
import type { CoverageGap, EditOutcome, SupportSkeleton } from "../../src/support-edits.ts";
import { diskFromHit, MAX_PAINT_DISKS, paintCounts, type PaintDisk, type PaintKind } from "../../src/support-paint.ts";
import { addDiskToRegion, MAX_REINFORCE_REGIONS, totalReinforceDisks, type ReinforceDisk } from "../../src/reinforcement.ts";
import { coverRegion, onSelection, selectTriangles, type RegionQuery } from "../../src/paint-region.ts";
import { sourceFrame } from "../../src/plate.ts";
import { readVec3 } from "../../src/modeling/compose.ts";
import { type PlateObject, type ToolHandler, UNKNOWN_OBJECT, isObject, roundTo } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

function wanted(this: Session, input: Record<string, unknown>): PlateObject | { ok: false; reason: string } {
  if (typeof input.object === "string" && input.object !== "") {
    const named = this.find(input.object);
    if (!named) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
    return named;
  }
  const obj = this.selectedObject();
  if (!obj) return refuse("no-mesh", "Load a mesh first.", undefined, NEXT.mesh);
  return obj;
}

function readRegionMethod(this: Session, value: unknown): RegionQuery | { reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "Name a face, an overhang, a box, a sphere, or a stroke." };
  const row = value as Record<string, unknown>;
  const region: RegionQuery = {};
  if (Array.isArray(row.faces)) region.faces = row.faces.filter((item): item is number => typeof item === "number" && Number.isInteger(item));
  if (typeof row.overhangBelowDeg === "number") region.overhangBelowDeg = row.overhangBelowDeg;
  if (Array.isArray(row.zRangeMm) && row.zRangeMm.length >= 2 && typeof row.zRangeMm[0] === "number" && typeof row.zRangeMm[1] === "number") {
    region.zRangeMm = [row.zRangeMm[0], row.zRangeMm[1]];
  }
  if (row.box && typeof row.box === "object") {
    const box = row.box as { min?: unknown; max?: unknown };
    const min = readVec3(box.min, [Number.NaN, Number.NaN, Number.NaN]);
    const max = readVec3(box.max, [Number.NaN, Number.NaN, Number.NaN]);
    if (min.some((item) => !Number.isFinite(item)) || max.some((item) => !Number.isFinite(item))) return { reason: "A box needs min and max, in millimetres." };
    region.box = { min, max };
  }
  if (row.sphere && typeof row.sphere === "object") {
    const sphere = row.sphere as { centre?: unknown; radiusMm?: unknown };
    const centre = readVec3(sphere.centre, [Number.NaN, Number.NaN, Number.NaN]);
    if (centre.some((item) => !Number.isFinite(item)) || typeof sphere.radiusMm !== "number" || !(sphere.radiusMm > 0)) {
      return { reason: "A sphere needs a centre and a radius, in millimetres." };
    }
    region.sphere = { centre, radiusMm: sphere.radiusMm };
  }
  if (row.stroke && typeof row.stroke === "object") {
    const stroke = row.stroke as { points?: unknown; radiusMm?: unknown };
    const points = Array.isArray(stroke.points) ? stroke.points.map((point) => readVec3(point, [Number.NaN, Number.NaN, Number.NaN])) : [];
    if (points.length < 2 || points.some((point) => point.some((item) => !Number.isFinite(item))) || typeof stroke.radiusMm !== "number") {
      return { reason: "A stroke needs points and a radius, in millimetres." };
    }
    region.stroke = { points, radiusMm: stroke.radiusMm };
  }
  return region;
}

function paintFrame(this: Session, input: Record<string, unknown>): "part" | "bed" | { reason: string } {
  if (input.frame === undefined || input.frame === "part" || input.frame === "bed") return input.frame === "bed" ? "bed" : "part";
  return { reason: "Paint on the part or the bed. The workplane is for model edits." };
}

function paintPositions(this: Session, obj: PlateObject, frame: "part" | "bed"): Float32Array {
  return frame === "bed" ? this.placed(obj).positions : obj.source;
}

function sourceDisks(this: Session, obj: PlateObject, disks: { p: [number, number, number]; n: [number, number, number]; r: number }[], kind: PaintKind, frame: "part" | "bed"): PaintDisk[] {
  if (frame === "bed") {
    const placed = this.placed(obj);
    const src = sourceFrame(obj.source, obj.scale);
    return disks.map((disk) => diskFromHit(kind, disk.p, disk.n, disk.r, placed.pose, src));
  }
  const scale = obj.scale || 1;
  return disks.map((disk) => ({ kind, p: disk.p, n: disk.n, r: disk.r / scale }));
}

function pointInFrame(this: Session, obj: PlateObject, point: [number, number, number], frame: "part" | "bed"): [number, number, number] {
  if (frame === "part") return point;
  const pose: RigidPose = this.placed(obj).pose;
  const centre = sourceFrame(obj.source, obj.scale).centre;
  const scale = obj.scale || 1;
  const mesh = [
    (point[0] - centre[0]) * scale + centre[0] - pose.pivot[0],
    (point[1] - centre[1]) * scale + centre[1] - pose.pivot[1],
    (point[2] - centre[2]) * scale + centre[2] - pose.pivot[2],
  ];
  const rotation = pose.rotation;
  return [
    rotation[0] * mesh[0]! + rotation[1] * mesh[1]! + rotation[2] * mesh[2]! + pose.translation[0],
    rotation[3] * mesh[0]! + rotation[4] * mesh[1]! + rotation[5] * mesh[2]! + pose.translation[1],
    rotation[6] * mesh[0]! + rotation[7] * mesh[1]! + rotation[8] * mesh[2]! + pose.translation[2],
  ];
}

function bedPointToSource(this: Session, obj: PlateObject, point: [number, number, number]): [number, number, number] {
  const placed = this.placed(obj);
  return diskFromHit("enforce", point, [0, 0, 1], 1, placed.pose, sourceFrame(obj.source, obj.scale)).p;
}

function paintSupports(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const obj = this.wanted(input);
  if (!isObject(obj)) return obj;
  const mode: PaintKind | "erase" = input.mode === "block" || input.mode === "erase" ? input.mode : "enforce";
  return this.paintDisks(obj, input, mode === "erase" ? "erase" : mode, "supports");
}

function paintSeam(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const obj = this.wanted(input);
  if (!isObject(obj)) return obj;
  return this.paintDisks(obj, input, input.erase === true ? "erase" : "enforce", "seam");
}

function paintDisks(this: Session, obj: PlateObject, input: Record<string, unknown>, mode: PaintKind | "erase", layer: "supports" | "seam"): Record<string, unknown> {
  const frame = this.paintFrame(input);
  if (typeof frame !== "string") return refuse("bad-frame", frame.reason);
  const region = this.readRegion(input.region);
  if ("reason" in region) return refuse("bad-region", region.reason);
  const radius = typeof input.radiusMm === "number" ? input.radiusMm : 3;
  const positions = this.paintPositions(obj, frame);
  const covered = coverRegion(positions, region, radius, this.faceOf(obj));
  if ("reason" in covered) return refuse("bad-region", covered.reason);
  const kind: PaintKind = mode === "block" ? "block" : "enforce";
  const made = this.sourceDisks(obj, covered.disks, kind, frame);
  const existing = layer === "supports" ? obj.supportPaint : obj.seamPaint;
  if (mode === "erase") {
    const picked = selectTriangles(positions, region, this.faceOf(obj));
    const removed = existing.filter((disk) => onSelection(positions, picked, this.pointInFrame(obj, disk.p, frame), Math.max(radius, disk.r))).length;
    if (input.dryRun === true) return { ok: true, dryRun: true, disks: removed, areaMm2: roundTo(covered.areaMm2, 2) };
    if (removed === 0) return refuse("no-paint", "No paint is inside that region.");
    this.remember(layer === "supports" ? "Support paint" : "Seam paint");
    if (layer === "supports") {
      obj.supportPaint = obj.supportPaint.filter((disk) => !onSelection(positions, picked, this.pointInFrame(obj, disk.p, frame), Math.max(radius, disk.r)));
    } else {
      obj.seamPaint = obj.seamPaint.filter((disk) => !onSelection(positions, picked, this.pointInFrame(obj, disk.p, frame), Math.max(radius, disk.r)));
    }
    return { ok: true, disks: removed, areaMm2: roundTo(covered.areaMm2, 2), stale: true, label: layer === "supports" ? "Support paint" : "Seam paint" };
  }
  if (existing.length + made.length > MAX_PAINT_DISKS) {
    return refuse("paint-limit", `That needs ${existing.length + made.length} disks; the limit is ${MAX_PAINT_DISKS}. Use a larger radius.`);
  }
  const warnings = mode === "enforce" && layer === "supports" && obj.objectSettings.supports !== true && !this.settings.supports
    ? ["Paint is kept but not used while supports are off."]
    : [];
  const total = paintCounts(layer === "supports" ? [...obj.supportPaint, ...made] : []);
  if (input.dryRun === true) {
    return { ok: true, dryRun: true, disks: made.length, areaMm2: roundTo(covered.areaMm2, 2), ...(layer === "supports" ? { total } : { seams: existing.length + made.length }), ...(warnings.length ? { warnings } : {}) };
  }
  this.remember(layer === "supports" ? "Support paint" : "Seam paint");
  if (layer === "supports") obj.supportPaint = [...obj.supportPaint, ...made];
  else obj.seamPaint = [...obj.seamPaint, ...made.map(({ p, n, r }) => ({ p, n, r }))];
  const after = layer === "supports" ? paintCounts(obj.supportPaint) : { seams: obj.seamPaint.length };
  return {
    ok: true,
    disks: made.length,
    areaMm2: roundTo(covered.areaMm2, 2),
    total: after,
    limit: MAX_PAINT_DISKS,
    ...(warnings.length ? { warnings } : {}),
    stale: true,
    label: layer === "supports" ? "Support paint" : "Seam paint",
  };
}

function faceOf(this: Session, obj: PlateObject): ((index: number) => number) | undefined {
  const triangles = obj.solid?.triangles;
  if (!triangles) return undefined;
  return (index) => triangles[index] ?? -1;
}

function reinforceAdd(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const obj = this.wanted(input);
  if (!isObject(obj)) return obj;
  const kind = input.kind === "paint" || input.kind === "box" || input.kind === "cylinder" ? input.kind : null;
  if (!kind) return refuse("bad-action", "kind is paint, box, or cylinder.");
  const density = typeof input.density === "number" ? Math.min(1, Math.max(0, input.density)) : 1;
  if (kind === "paint") {
    const frame = this.paintFrame(input);
    if (typeof frame !== "string") return refuse("bad-frame", frame.reason);
    const region = this.readRegion(input.region);
    if ("reason" in region) return refuse("bad-region", region.reason);
    const radius = typeof input.radiusMm === "number" ? input.radiusMm : 3;
    const covered = coverRegion(this.paintPositions(obj, frame), region, radius, this.faceOf(obj));
    if ("reason" in covered) return refuse("bad-region", covered.reason);
    const disks: ReinforceDisk[] = this.sourceDisks(obj, covered.disks, "enforce", frame).map(({ p, n, r }) => ({ p, n, r }));
    if (totalReinforceDisks(obj.reinforcement) + disks.length > MAX_PAINT_DISKS) {
      return refuse("paint-limit", `That needs ${totalReinforceDisks(obj.reinforcement) + disks.length} disks; the limit is ${MAX_PAINT_DISKS}. Use a larger radius.`);
    }
    if (input.dryRun === true) return { ok: true, dryRun: true, disks: disks.length, areaMm2: roundTo(covered.areaMm2, 2) };
    const depthMm = typeof input.depthMm === "number" ? input.depthMm : 5;
    let regions = obj.reinforcement;
    let active = regions.findIndex((item) => item.kind === "paint");
    for (const disk of disks) {
      const next = addDiskToRegion(regions, active, disk, { depthMm, fillThrough: input.fillThrough === true });
      if (next.regions === regions) return refuse("paint-limit", `One object holds at most ${MAX_REINFORCE_REGIONS} reinforcement regions.`);
      regions = [...next.regions];
      active = next.activeIndex;
      const painted = regions[active];
      if (painted && painted.kind === "paint") {
        regions[active] = { ...painted, density, depthMm, ...(input.fillThrough === true ? { fillThrough: true } : {}) };
      }
    }
    this.remember("Reinforcement");
    obj.reinforcement = regions;
    return { ok: true, disks: disks.length, areaMm2: roundTo(covered.areaMm2, 2), stale: true, label: "Reinforcement" };
  }
  const frame = this.paintFrame(input);
  if (typeof frame !== "string") return refuse("bad-frame", frame.reason);
  const centre = readVec3(input.centre, [Number.NaN, Number.NaN, Number.NaN]);
  const size = readVec3(input.sizeMm, [Number.NaN, Number.NaN, Number.NaN]);
  if (centre.some((value) => !Number.isFinite(value)) || size.some((value) => !(value > 0))) {
    return refuse("bad-region", "The volume needs a centre and a size, in millimetres.");
  }
  const bounds = frame === "bed" ? this.placed(obj).bounds : boundsOf(obj.source);
  const box = { min: [centre[0] - size[0] / 2, centre[1] - size[1] / 2, centre[2] - size[2] / 2], max: [centre[0] + size[0] / 2, centre[1] + size[1] / 2, centre[2] + size[2] / 2] };
  const touches = box.min.every((value, axis) => value <= bounds.max[axis] && box.max[axis] >= bounds.min[axis]);
  if (!touches) return refuse("outside-part", "That volume does not touch the part.");
  if (obj.reinforcement.length >= MAX_REINFORCE_REGIONS) return refuse("paint-limit", `One object holds at most ${MAX_REINFORCE_REGIONS} reinforcement regions.`);
  const scale = obj.scale || 1;
  const center = frame === "bed" ? this.bedPointToSource(obj, centre) : centre;
  const stored = size.map((value) => value / (frame === "bed" ? scale : 1)) as [number, number, number];
  if (input.dryRun === true) return { ok: true, dryRun: true, kind };
  this.remember("Reinforcement");
  obj.reinforcement = [...obj.reinforcement, { kind, density, center, size: stored }];
  return { ok: true, kind, stale: true, label: "Reinforcement" };
}

function paintList(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const obj = this.wanted(input);
  if (!isObject(obj)) return obj;
  const layer = input.layer === "seam" || input.layer === "reinforce" ? input.layer : "supports";
  const limit = typeof input.limit === "number" ? Math.min(100, Math.max(1, Math.round(input.limit))) : 20;
  const start = typeof input.cursor === "string" ? Number(input.cursor) : 0;
  if (layer === "reinforce") {
    return { ok: true, object: obj.id, layer, regions: obj.reinforcement.length, total: totalReinforceDisks(obj.reinforcement) };
  }
  const disks = layer === "seam" ? obj.seamPaint : obj.supportPaint;
  const page = disks.slice(start, start + limit);
  return {
    ok: true,
    object: obj.id,
    layer,
    total: disks.length,
    disks: page,
    ...(start + limit < disks.length ? { nextCursor: String(start + limit) } : {}),
  };
}

function paintClear(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const obj = this.wanted(input);
  if (!isObject(obj)) return obj;
  const layer = input.layer === "seam" || input.layer === "reinforce" ? input.layer : "supports";
  this.remember("Clear paint");
  if (layer === "seam") obj.seamPaint = [];
  else if (layer === "reinforce") obj.reinforcement = [];
  else obj.supportPaint = [];
  return { ok: true, layer, stale: true, label: "Clear paint" };
}

function supportEdit(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const obj = this.wanted(input);
  if (!isObject(obj)) return obj;
  const action = input.action === "regrow" || input.action === "prune" || input.action === "grow" ? input.action : null;
  if (!action) return refuse("bad-action", "action is prune, regrow, or grow.");
  const job = this.latest;
  const skeleton = job?.wire?.skeleton as SupportSkeleton | undefined;
  if (!skeleton?.id?.length) return refuse("not-sliced", "Slice with tree supports first.", undefined, NEXT.slice);
  const site = input.site as { xy?: unknown; zMm?: unknown } | undefined;
  const xy = readVec3(site?.xy ? [ ...(Array.isArray(site.xy) ? site.xy : []), 0] : undefined, [Number.NaN, Number.NaN, Number.NaN]);
  const zMm = typeof site?.zMm === "number" ? site.zMm : Number.NaN;
  if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1]) || !Number.isFinite(zMm)) return refuse("bad-argument", "site needs xy and zMm, in millimetres.");
  if (action === "regrow") {
    const gaps = Array.isArray(job?.wire?.coverage) ? job?.wire?.coverage as CoverageGap[] : [];
    const gap = gaps.find((row) => zMm + 0.5 >= row.z[0] && zMm - 0.5 <= row.z[1]);
    if (!gap) return refuse("no-support", "Nothing unheld to regrow here.");
    if (input.dryRun === true) return { ok: true, dryRun: true, action, areaMm2: gap.areaMm2 };
    const id = obj.supportEdits.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
    this.remember("Support edit");
    obj.supportEdits = appendEdit(obj.supportEdits, { id, edit: { kind: "regrow", region: gap.outline, z: gap.z }, areaMm2: gap.areaMm2 });
    return { ok: true, action, areaMm2: gap.areaMm2, stale: true, label: "Support edit" };
  }
  const index = indexSkeleton(skeleton);
  let best = -1;
  let bestD = Infinity;
  skeleton.id.forEach((_, limb) => {
    if (skeleton.live[limb] !== 1) return;
    const d = Math.hypot((skeleton.siteX[limb] ?? 0) - xy[0], (skeleton.siteY[limb] ?? 0) - xy[1], (skeleton.siteZ[limb] ?? 0) - zMm);
    if (d < bestD) {
      bestD = d;
      best = limb;
    }
  });
  if (best < 0 || bestD > 15) return refuse("no-support", "No support is at that point.");
  if (action === "grow") {
    const count = input.count === undefined ? GROW_DEFAULT : input.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > GROW_MAX) return refuse("bad-argument", `count is 1 to ${GROW_MAX} branches.`);
    const edit = growFor(index, best, count);
    if (edit.sites.length === 0) return refuse("no-support", "No support is at that point.");
    if (input.dryRun === true) return { ok: true, dryRun: true, action, tree: skeleton.tree[best], count };
    const id = obj.supportEdits.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
    this.remember("Support edit");
    obj.supportEdits = appendEdit(obj.supportEdits, { id, edit, tips: edit.sites.length });
    return { ok: true, action, tree: skeleton.tree[best], count, stale: true, label: "Support edit" };
  }
  const scope = input.scope === "branch" ? "branch" : "tree";
  const sites = sitesOf(index, selectLimbs(index, best, scope));
  if (sites.length === 0) return refuse("no-support", "No support is at that point.");
  if (input.dryRun === true) return { ok: true, dryRun: true, action, sites: sites.length, scope };
  const id = obj.supportEdits.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
  this.remember("Support edit");
  obj.supportEdits = appendEdit(obj.supportEdits, { id, edit: { kind: "prune", sites }, scope });
  return { ok: true, action, sites: sites.length, scope, stale: true, label: "Support edit" };
}

function supportTrees(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const job = this.finished(typeof input.job === "string" ? input.job : undefined);
  const skeleton = job?.wire?.skeleton as SupportSkeleton | undefined;
  if (!job?.wire || !skeleton?.id?.length) return refuse("not-sliced", "Slice with tree supports first.", undefined, NEXT.slice);
  const stale = this.staleReason(job);
  if (stale) return refuse("stale-slice", stale, undefined, NEXT.slice);
  const groups = new Map<number, { id: number; baseXY: [number, number]; tipZ: number; branches: number }>();
  skeleton.id.forEach((id, limb) => {
    const tree = skeleton.tree[limb] ?? id;
    const row = groups.get(tree) ?? { id: tree, baseXY: [skeleton.siteX[limb] ?? 0, skeleton.siteY[limb] ?? 0] as [number, number], tipZ: skeleton.siteZ[limb] ?? 0, branches: 0 };
    row.branches += 1;
    const tip = skeleton.zs.slice(skeleton.start[limb] ?? 0, skeleton.start[limb + 1] ?? 0).reduce((max, value) => Math.max(max, value), row.tipZ);
    row.tipZ = tip;
    if ((skeleton.into[limb] ?? 0) === 0) row.baseXY = [skeleton.siteX[limb] ?? 0, skeleton.siteY[limb] ?? 0];
    groups.set(tree, row);
  });
  const trees = [...groups.values()];
  const start = typeof input.cursor === "string" ? Number(input.cursor) : 0;
  const limit = typeof input.limit === "number" ? Math.min(100, Math.max(1, Math.round(input.limit))) : 20;
  // What each support edit did on this slice, in edit order: a grow says how many branches it added.
  const outcomes = Array.isArray(job.wire.supportEdits) ? job.wire.supportEdits as EditOutcome[] : [];
  const edits = outcomes.map((row) => ({ status: row.status, newlyFloatingMm2: row.newlyFloatingMm2, ...(row.grown ? { grown: row.grown.length } : {}) }));
  return {
    ok: true,
    total: trees.length,
    trees: trees.slice(start, start + limit),
    ...(edits.length ? { edits } : {}),
    ...(start + limit < trees.length ? { nextCursor: String(start + limit) } : {}),
  };
}

/** The methods this module adds to Session. */
export const paintMethods = {
  wanted,
  readRegion: readRegionMethod,
  paintFrame,
  paintPositions,
  sourceDisks,
  pointInFrame,
  bedPointToSource,
  paintSupports,
  paintSeam,
  paintDisks,
  faceOf,
  reinforceAdd,
  paintList,
  paintClear,
  supportEdit,
  supportTrees,
};

export const paintHandlers: Record<string, ToolHandler> = {
  paint_supports: (s, input) => s.paintSupports(input),
  paint_seam: (s, input) => s.paintSeam(input),
  reinforce_add: (s, input) => s.reinforceAdd(input),
  paint_list: (s, input) => s.paintList(input),
  paint_clear: (s, input) => s.paintClear(input),
  support_edit: (s, input) => s.supportEdit(input),
  support_trees: (s, input) => s.supportTrees(input),
};
