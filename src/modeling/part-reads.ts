/**
 * The reading calls a recipe makes of one part, as the MCP session and the app's recipe calls both answer them
 * (docs/plan-recipe-plugins.md D16): model_history, model_check, measure, and the box an anchor names. Nothing here
 * changes a part.
 */
import { closeCracks, edgeReport } from "../mesh-check.ts";
import { printFrame } from "../model-check.ts";
import { applyPose, type Affine } from "../model-space.ts";
import type { ModelOp, ModelTree, NodeId } from "../model-tree.ts";
import { extentAlong, splitBase, splitNote, tiltRings, type SplitPlan, type Vec3 as PlaneVec } from "../model-plane.ts";
import { localPoint, type Workplane } from "../workplane.ts";
import { movedBox, opBox, unionBox, type Box } from "./anchors.ts";
import { checkInSource, printCheck } from "./inspect.ts";
import { nodeHandle, page } from "./model-calls.ts";
import { thinWalls } from "./thin.ts";

/** model_history's reply for a tree: each step with its parent, label, marks, and a plugin step's stamp and run. */
export function historyReply(tree: ModelTree, input: Record<string, unknown>): Record<string, unknown> {
  const rows = [...tree.nodes.values()].sort((a, b) => a.id - b.id).map((node) => ({
    id: nodeHandle(node.id),
    parent: node.parent === null ? null : nodeHandle(node.parent),
    label: node.label,
    current: node.id === tree.current,
    committed: node.id === tree.committed,
    broken: node.broken ?? false,
    // --- Plugin steps (D8): the run a step belongs to, and on its first step what ran with which values.
    ...(node.plugin ? { plugin: { id: node.plugin.plugin, version: node.plugin.version, params: node.plugin.params } } : {}),
    ...(node.run ? { run: `${node.run.id} ${node.run.k}/${node.run.n}` } : {}),
    // --- docs/plan-native-recipes.md 7.1: a recipe's queued step names the first step it was built with.
    ...(node.builtWith !== undefined ? { builtWith: nodeHandle(node.builtWith) } : {}),
  }));
  const listed = page(rows, input.cursor, input.limit);
  return { ok: true, nodes: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}) };
}

/** What model_check reads of the plate: the printer and its nozzle. */
export interface CheckPrinter {
  name: string;
  bedMm: [number, number, number];
  nozzleMm: number;
}

/**
 * model_check's reply for a solid as it prints (the plate's turn and scale, lowest point on the bed): overhangs, the
 * build volume, thin walls, and the edges a commit refuses. Places come back in the solid's frame.
 */
export function checkReply(positions: Float32Array, orient: readonly number[], scale: number, printer: CheckPrinter, input: Record<string, unknown>): Record<string, unknown> {
  const printed = printFrame(positions, orient, scale);
  const checked = checkInSource(printCheck({ positions: printed.positions, overhangDeg: typeof input.overhangDeg === "number" ? input.overhangDeg : 45, buildMm: printer.bedMm }), printed.toSource);
  // Two lines of the nozzle's width is the thinnest wall a slicer fills; thinner prints as one line or not at all.
  const nozzle = printer.nozzleMm || 0.4;
  const minWallMm = typeof input.minWallMm === "number" ? input.minWallMm : Math.round(nozzle * 2 * 100) / 100;
  const thin = thinWalls(positions, minWallMm);
  // In the solid's frame, as the overhang regions are.
  const regions = thin.regions;
  const warnings = [...(checked.warnings as string[])];
  if (regions.length) {
    const worst = regions.reduce((a, b) => (b.thinnestMm < a.thinnestMm ? b : a));
    warnings.push(`Walls thinner than ${minWallMm} mm cover ${thin.areaMm2} mm², thinnest ${worst.thinnestMm} mm at (${worst.centre.join(", ")})${worst.thinnestMm < nozzle ? ": thinner than the nozzle, so it will not print" : ""}.`);
  }
  // Edges, as the plate mesh would have them: cracks a commit mends are counted apart from what stays open.
  const raw = edgeReport(positions, 8);
  const mended = raw.open === 0 && raw.degenerate === 0 ? raw : edgeReport(closeCracks(positions), 8);
  const closedEdges = {
    open: mended.open,
    nonManifold: mended.nonManifold,
    ...(mended.openAt.length ? { openAt: mended.openAt } : {}),
    ...(mended.nonManifoldAt.length ? { nonManifoldAt: mended.nonManifoldAt } : {}),
    ...(raw.open > mended.open ? { crackEdgesMended: raw.open - mended.open } : {}),
  };
  if (mended.open > 0) warnings.push(`The mesh has ${mended.open} open edges, the first at (${mended.openAt[0]!.at.join(", ")}). model_commit refuses it until they close.`);
  if (mended.nonManifold > 0) warnings.push(`${mended.nonManifold} edges are where pieces meet only along a line, the first at (${mended.nonManifoldAt[0]!.at.join(", ")}). model_commit refuses it until they overlap or part.`);
  return {
    ...checked,
    edges: closedEdges,
    thinWalls: { minWallMm, nozzleMm: nozzle, areaMm2: thin.areaMm2, regions, sampledPoints: thin.sampled },
    warnings,
    notChecked: [],
    printer: printer.name,
  };
}

/**
 * measure's reply: two faces of the solid (the kernel's distance, `distance`), or two points in model space or in the
 * part's workplane (`plane`, the workplane in model space).
 */
export async function measureReply(solid: { faces: readonly unknown[] } | null, plane: Workplane, input: Record<string, unknown>, distance: (faceA: number, faceB: number) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  if (typeof input.faceA === "number" || typeof input.faceB === "number") {
    if (typeof input.faceA !== "number" || typeof input.faceB !== "number") return { ok: false, reason: "Name both faces." };
    if (!solid) return { ok: false, reason: "This solid could not be read." };
    if (!solid.faces[input.faceA] || !solid.faces[input.faceB]) return { ok: false, reason: "That face is not on this solid." };
    const reply = await distance(input.faceA, input.faceB);
    if (reply.ok === false) return reply;
    if (typeof reply.distanceMm !== "number") return { ok: false, reason: "Could not measure that distance." };
    return { ok: true, distanceMm: reply.distanceMm, frame: "model" };
  }
  const a = input.a;
  const b = input.b;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) {
    return { ok: false, reason: "Name two points, or two faces from the solid." };
  }
  const frame = input.frame === "workplane" ? "workplane" : "model";
  const left = frame === "workplane" ? localPoint(plane, a as [number, number, number]) : (a as [number, number, number]);
  const right = frame === "workplane" ? localPoint(plane, b as [number, number, number]) : (b as [number, number, number]);
  const dx = right[0] - left[0];
  const dy = right[1] - left[1];
  const dz = right[2] - left[2];
  return { ok: true, distanceMm: Math.hypot(dx, dy, dz), dx, dy, dz, frame };
}

/** A run of steps one undo takes back, under one label. */
export interface StepGroup {
  start: NodeId;
  end: NodeId;
  label: string;
}

/**
 * The box, in the frame ops are typed in (`toTyped` from the solid's frame), of the tools the steps a label names
 * applied: a step's own label, every step named under it ("label body" of a placed part, or an older file's "label
 * k/n"), a group's own label, or a batch's label, on the path to the current step. "part" is the solid's box.
 */
export function labelBox(tree: ModelTree, solidBounds: Box | null, label: string, groups: readonly StepGroup[], toTyped: (p: [number, number, number]) => [number, number, number]): Box | null {
  if (label.trim().toLowerCase() === "part") return solidBounds ? movedBox(solidBounds, toTyped) : null;
  const wanted = label.trim().toLowerCase();
  const path: number[] = [];
  for (let node: number | null = tree.current; node !== null; node = tree.nodes.get(node)?.parent ?? null) path.push(node);
  const onPath = new Set(path);
  const grouped = new Set<number>();
  for (const group of groups) {
    if (group.label.toLowerCase() !== wanted || !onPath.has(group.end) || !onPath.has(group.start)) continue;
    for (let node: number | null = group.end; node !== null && node !== group.start; node = tree.nodes.get(node)?.parent ?? null) grouped.add(node);
  }
  let box: Box | null = null;
  for (const node of path) {
    const row = tree.nodes.get(node);
    if (!row?.op) continue;
    const name = row.label.toLowerCase();
    // "fish 0" names "fish 0 body" and "fish 0 tail". An older file's "label k/n" still matches; a group matches its own label.
    const piece = name.startsWith(`${wanted} `);
    if (name !== wanted && !piece && !grouped.has(node)) continue;
    const own = opBox(row.op);
    if (own) box = unionBox(box, movedBox(own, toTyped));
  }
  return box;
}

/** A solid-frame point as the part's ops are typed: model space under `pose`, then the typed plane's own frame. */
export function typedFrom(pose: Affine, toPlane: (p: [number, number, number]) => [number, number, number]): (p: [number, number, number]) => [number, number, number] {
  return (p) => toPlane(applyPose(pose, p));
}

/** A split as the history stores it. */
type SplitOp = Extract<ModelOp, { kind: "split" }>;

/** Whether a split's plane crosses the solid, as a sentence: the probe's answer, and why it would not cut. */
export function splitCheck(solid: { positions: Float32Array; bounds: { min: number[]; max: number[] } } | null, op: SplitOp): { text: string; bad: boolean } {
  const positions = solid?.positions;
  const box = solid?.bounds;
  if (!positions || !box) return splitNote({ why: "This solid is too thin to split.", wait: false });
  const length = Math.hypot(op.normal[0], op.normal[1], op.normal[2]) || 1;
  const normal: PlaneVec = [op.normal[0] / length, op.normal[1] / length, op.normal[2] / length];
  const extent = extentAlong(positions, normal);
  if (!extent || !(extent.max > extent.min)) return splitNote({ why: "This solid is too thin to split.", wait: false });
  const center: PlaneVec = [(box.min[0]! + box.max[0]!) / 2, (box.min[1]! + box.max[1]!) / 2, (box.min[2]! + box.max[2]!) / 2];
  const axis = Math.abs(normal[0]) >= Math.abs(normal[1]) && Math.abs(normal[0]) >= Math.abs(normal[2]) ? 0 : Math.abs(normal[1]) >= Math.abs(normal[2]) ? 1 : 2;
  const mode = axis === 0 ? "x" : axis === 1 ? "y" : "z";
  const base = splitBase(mode, center, null);
  if (!base) return splitNote({ why: "This solid is too thin to split.", wait: false });
  const depth = op.origin[0] * normal[0] + op.origin[1] * normal[1] + op.origin[2] * normal[2];
  const margin = 1e-4;
  const range = { min: extent.min, max: extent.max, mid: (extent.min + extent.max) / 2 };
  const inside = extent.min + margin < depth && depth < extent.max - margin;
  const plan: SplitPlan = { base, value: depth, origin: [...op.origin] as PlaneVec, normal, range, inside, rings: tiltRings(base.normal, 0) };
  return splitNote({ plan });
}

/** Which half a split keeps, as typed: both, or the one above or below its plane. */
export function splitKeep(raw: unknown): "both" | "above" | "below" {
  if (!raw || typeof raw !== "object") return "both";
  const keep = (raw as { keep?: unknown }).keep;
  return keep === "above" || keep === "below" ? keep : "both";
}

/** The half whose centre is on the positive side of the plane is above. */
export function keptSide(bounds: { min: number[]; max: number[] } | null | undefined, op: SplitOp): "above" | "below" {
  if (!bounds) return "above";
  const length = Math.hypot(op.normal[0], op.normal[1], op.normal[2]) || 1;
  const centre = [(bounds.min[0]! + bounds.max[0]!) / 2, (bounds.min[1]! + bounds.max[1]!) / 2, (bounds.min[2]! + bounds.max[2]!) / 2];
  const depth = centre[0]! * op.normal[0] + centre[1]! * op.normal[1] + centre[2]! * op.normal[2];
  const plane = op.origin[0] * op.normal[0] + op.origin[1] * op.normal[1] + op.origin[2] * op.normal[2];
  return depth / length >= plane / length ? "above" : "below";
}
