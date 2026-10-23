/**
 * Split to print on the MCP server (docs/plan-split-connectors.md, section 13): the typed op read and checked, the op the
 * tree stores, and model_probe's plan. Every default and every proposal comes from the planner,
 * `src/modeling/partition.ts`; nothing here has a number of its own.
 */
import { printFrame } from "../src/model-check.ts";
import { applyPose, toSolidOp, turnDir, type Affine } from "../src/model-space.ts";
import type { ModelOp, PartitionModelOp, Vec3 } from "../src/model-tree.ts";
import { boundsOf, type Mat3 } from "../src/mesh-place.ts";
import { fillPartition, fitPrinter, notBuiltYet, profileRefusals, defaultsFor, shapedCutsSentence, type Axis, type Box, type CutInput, type FillContext, type PartitionOp, type Profile, type Target } from "../src/modeling/partition.ts";

/** The planner's sentence when model_probe is asked to plan an op of another kind. */
export const PLAN_KIND = "plan: true plans a partition. Other kinds are probed without it.";
export const NEEDS_CUTS = "A partition needs at least one cut. model_probe with plan: true proposes them.";

function vec3(value: unknown): Vec3 | null {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? [value[0], value[1], value[2]] : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The op as typed, in model space, checked field by field. `cuts` may be absent or empty only for a plan. A target that
 * names only its printer takes the process and the build volume from `library` (D11): `{printer: "formlabs-form-4"}`.
 */
export function readPartition(raw: Record<string, unknown>, library: (printer: string) => Target | null = () => null): PartitionOp | { reason: string } {
  const cuts: CutInput[] = [];
  if (raw.cuts !== undefined && !Array.isArray(raw.cuts)) return { reason: "cuts is a list of {origin, normal}." };
  for (const [index, value] of ((raw.cuts as unknown[] | undefined) ?? []).entries()) {
    const cut = record(value);
    const origin = vec3(cut?.origin);
    const normal = vec3(cut?.normal);
    if (!cut || !origin || !normal) return { reason: `cuts[${index}] needs an origin and a normal, each [x, y, z].` };
    if (Math.hypot(...normal) < 1e-9) return { reason: `cuts[${index}]: the normal needs a direction.` };
    const u = cut.u === undefined ? undefined : vec3(cut.u);
    if (u === null) return { reason: `cuts[${index}].u is [x, y, z].` };
    const profile = cut.profile === undefined ? undefined : record(cut.profile);
    if (profile === null || (profile && typeof profile.kind !== "string")) return { reason: `cuts[${index}].profile is {kind}.` };
    const connectors = cut.connectors === undefined ? undefined : record(cut.connectors);
    if (connectors === null) return { reason: `cuts[${index}].connectors is {on}.` };
    cuts.push({ origin, normal, ...(u ? { u } : {}), ...(profile ? { profile: profile as unknown as Profile } : {}), ...(connectors ? { connectors: connectors as CutInput["connectors"] } : {}) });
  }
  let target: Target | undefined;
  if (raw.target !== undefined) {
    const typed = record(raw.target);
    if (typed && typeof typed.printer === "string" && typed.process === undefined && typed.volumeMm === undefined) {
      const known = library(typed.printer);
      if (!known) return { reason: `No printer in the library is ${typed.printer}. Give target {printer, process, volumeMm}, or a printer id machine_list shows, or formlabs-form-4.` };
      target = known;
    } else {
      const volumeMm = vec3(typed?.volumeMm);
      if (!typed || typeof typed.printer !== "string" || (typed.process !== "fdm" && typed.process !== "resin") || !volumeMm) {
        return { reason: "target is {printer}, or {printer, process: fdm or resin, volumeMm: [x, y, z]}." };
      }
      target = { printer: typed.printer, process: typed.process, volumeMm };
    }
  }
  const orient = raw.orient;
  if (orient !== undefined && orient !== "keep" && !(Array.isArray(orient) && orient.every((one) => one === "keep" || one === "joint"))) {
    return { reason: "orient is keep, or one of keep and joint per piece." };
  }
  if (raw.arrange !== undefined && typeof raw.arrange !== "boolean") return { reason: "arrange is true or false." };
  const labels = raw.labels === undefined ? undefined : record(raw.labels);
  if (labels === null) return { reason: "labels is {on, face, height, depth}." };
  for (const key of ["bedMarginMm", "maxPieces"] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) return { reason: `${key} is a number.` };
  }
  return {
    cuts,
    ...(target ? { target } : {}),
    ...(orient !== undefined ? { orient: orient as PartitionOp["orient"] } : {}),
    ...(typeof raw.arrange === "boolean" ? { arrange: raw.arrange } : {}),
    ...(labels ? { labels: labels as PartitionOp["labels"] } : {}),
    ...(typeof raw.bedMarginMm === "number" ? { bedMarginMm: raw.bedMarginMm } : {}),
    ...(typeof raw.maxPieces === "number" ? { maxPieces: raw.maxPieces } : {}),
  };
}

/**
 * The op the tree stores, in the solid's own frame: each cut a straight plane with its U, connectors off, and the
 * target, orientation, layout, margin and Max pieces filled as at Apply (D11), so a replay cuts the same pieces after
 * the library or the settings change. Labels are written in full, `on: true` unless typed off: only an explicit `on`
 * cuts part numbers, so an op stored before milestone 3b, with none, gains no digits on a replay. Null with the sentence
 * when this milestone does not build the op.
 */
export function storedPartition(op: PartitionOp, ctx: FillContext, pose: Affine): { op: PartitionModelOp } | { reason: string } {
  if (op.cuts.length === 0) return { reason: NEEDS_CUTS };
  const later = notBuiltYet(op);
  if (later) return { reason: later };
  const filled = fillPartition(op, ctx);
  const typed: PartitionModelOp = {
    kind: "partition",
    cuts: filled.cuts.map((cut) => ({ origin: [...cut.origin], normal: [...cut.normal], u: [...cut.u], profile: { kind: "straight" }, connectors: { on: false } })),
    target: filled.target,
    orient: filled.orient,
    arrange: filled.arrange,
    labels: { ...filled.labels },
    bedMarginMm: filled.bedMarginMm,
    maxPieces: filled.maxPieces,
  };
  return { op: toSolidOp(typed, pose) as PartitionModelOp };
}

/**
 * --- D12. A split to print for a printer this app does not slice for (a resin target): its pieces stay in Model, off
 * the plate, and are exported; none of them, and not the part as cut, reaches the slicer.
 */
export function exportsPieces(op: ModelOp | null | undefined): boolean {
  return op?.kind === "partition" && op.target !== undefined && op.target.process !== "fdm";
}

/** What model_apply says of an export target's pieces. */
export function exportedNote(printer: string): string {
  return `These pieces are for the ${printer}: they stay in Model, off the plate. Export them with export_3mf or model_export_step, the part as object and pieces: true.`;
}

/** Why a part cut for an export target is not put on the plate (model_commit, a slice, the plate's 3MF). */
export function exportedCommit(name: string, printer: string): string {
  return `${name} is cut for the ${printer}, which this app does not slice for. Export its pieces with export_3mf or model_export_step and pieces: true, or model_goto a step before the cut to print it here.`;
}

/** The part as it stands on the bed: its box in the print frame, and the way back to model space for a cut planned there. */
export interface PrintFrame {
  box: Box;
  point: (p: Vec3) => Vec3;
  direction: (d: Vec3) => Vec3;
}

/** The solid's `positions` as the plate places them (`printFrame`, which `model_check` reads too): the frame Fit the printer plans in. */
export function bedFrame(positions: Float32Array, orient: Mat3, scale: number, pose: Affine): PrintFrame {
  const placed = printFrame(positions, orient, scale > 0 ? scale : 1);
  const bounds = boundsOf(placed.positions);
  const own = placed.toSource;
  return {
    box: { min: [...bounds.min], max: [...bounds.max] },
    point: (p) => applyPose(pose, applyPose(own, p)),
    direction: (d) => turnDir(pose, turnDir(own, d)),
  };
}

export interface PlanPrinter {
  name: string;
  belt: boolean;
  /** The target's own name when it is not the plate's printer: "Formlabs Form 4". */
  targetName?: string;
}

/**
 * model_probe with plan: true. No kernel call: with no cuts typed, Fit the printer proposes them on the part as it stands
 * on the bed; with cuts, they come back filled. Either way the reply has the cuts in model space, ready for model_apply,
 * the pieces the planner counts, and its sentences.
 */
export function planPartition(op: PartitionOp, ctx: FillContext, frame: PrintFrame, printer: PlanPrinter): Record<string, unknown> {
  const filled = fillPartition(op, ctx);
  const round = (v: Vec3): Vec3 => v.map((n) => Math.round(n * 1e4) / 1e4 + 0) as Vec3;
  const later = notBuiltYet(op);
  const target = filled.target;
  let cuts: CutInput[];
  let notes: string[];
  let pieces: number | null;
  if (op.cuts.length === 0) {
    const belt = printer.belt && target.printer === ctx.plateTarget.printer ? { belt: { axis: 1 as Axis } } : {};
    const fit = fitPrinter({ box: frame.box, target, marginMm: filled.bedMarginMm, maxPieces: filled.maxPieces, printerName: target.printer === ctx.plateTarget.printer ? printer.name : (printer.targetName ?? target.printer), ...belt });
    cuts = fit.cuts.map((cut) => ({ origin: round(frame.point(cut.origin)), normal: round(frame.direction(cut.normal)), u: round(frame.direction(cut.u)), profile: { kind: "straight" }, connectors: { on: false } }));
    notes = fit.notes;
    pieces = fit.pieces;
  } else {
    cuts = filled.cuts.map((cut) => ({ origin: cut.origin, normal: round(cut.normal), u: round(cut.u), profile: cut.profile as Profile, connectors: { on: cut.connectors.on } }));
    const d = defaultsFor(target, ctx);
    notes = [shapedCutsSentence(filled.cuts), ...op.cuts.flatMap((cut) => (cut.profile ? profileRefusals(cut.profile, d) : []))].filter((note): note is string => !!note);
    pieces = null;
  }
  const proposal = { kind: "partition", cuts, ...(op.target ? { target: op.target } : {}), labels: { ...filled.labels }, ...(op.maxPieces !== undefined ? { maxPieces: op.maxPieces } : {}), ...(op.bedMarginMm !== undefined ? { bedMarginMm: op.bedMarginMm } : {}) };
  return {
    ok: later === null,
    plan: true,
    reason: later ?? (notes[0] ?? (cuts.length === 0 ? "No cut is proposed." : `${cuts.length} ${cuts.length === 1 ? "cut" : "cuts"}.`)),
    cuts,
    ...(pieces !== null ? { pieces } : {}),
    notes,
    target,
    bedMarginMm: filled.bedMarginMm,
    maxPieces: filled.maxPieces,
    op: proposal,
  };
}
