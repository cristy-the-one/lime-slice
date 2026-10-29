/**
 * Split to print on the MCP server (docs/plan-split-connectors.md, section 13): the typed op read and checked, the op the
 * tree stores, and model_probe's plan. Every default and every proposal comes from the planner,
 * `src/modeling/partition.ts`; nothing here has a number of its own.
 */
import type { Vec3 } from "../src/model-tree.ts";
import type { Affine } from "../src/model-space.ts";
import { fillPartition, fitPrinter, notBuiltYet, profileRefusals, defaultsFor, shapedCutsSentence, type Axis, type CutInput, type FillContext, type PartitionOp, type Profile, type Target } from "../src/modeling/partition.ts";
import { storedPartition, type PartitionSolid, type PrintFrame } from "../src/split-print.ts";

// The op the tree stores, the frame Fit the printer plans in, and what an export target's pieces say are the card's too
// (`src/split-print.ts`).
export { bedFrame, exportedCommit, exportedNote, exportsPieces, NEEDS_CUTS, plateUp, storedPartition, type PrintFrame } from "../src/split-print.ts";

/** The planner's sentence when model_probe is asked to plan an op of another kind. */
export const PLAN_KIND = "plan: true plans a partition, or finds the edges a print transition would fix. Other kinds are probed without it.";

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
    const problem = connectors ? readConnectors(connectors, index) : null;
    if (problem) return { reason: problem };
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

/** The connector types `model_apply` takes, and the sizes each may carry: every one a number of millimetres. */
const CONNECTOR_SIZES: Record<string, readonly string[]> = {
  dowel: ["radius", "depth", "endGap", "margin"],
  plug: ["radius", "depth", "endGap", "margin"],
  hardware: ["diameter", "depth", "endGap", "margin"],
  key: ["width", "height", "depth", "endGap", "margin"],
  dovetail: ["width", "angle", "depth", "endGap", "margin"],
};

/** Why a cut's connectors cannot be read, or null: `on`, and `types` of known kinds with positive sizes. */
function readConnectors(connectors: Record<string, unknown>, index: number): string | null {
  if (connectors.on !== undefined && typeof connectors.on !== "boolean") return `cuts[${index}].connectors.on is true or false.`;
  if (connectors.types === undefined) return null;
  if (!Array.isArray(connectors.types)) return `cuts[${index}].connectors.types is a list of {type, …}.`;
  for (const raw of connectors.types as unknown[]) {
    const spec = record(raw);
    const sizes = spec && typeof spec.type === "string" ? CONNECTOR_SIZES[spec.type] : undefined;
    if (!spec || !sizes) return `cuts[${index}].connectors.types: each type is dowel, plug, hardware, key, or dovetail.`;
    for (const size of sizes) {
      const value = spec[size];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) return `cuts[${index}]: ${spec.type} ${size} is a number of millimetres.`;
    }
    const count = spec.count;
    if (count !== undefined && count !== "fit" && !(typeof count === "number" && Number.isInteger(count) && count >= 0)) return `cuts[${index}]: count is "fit" or a whole number.`;
    const clearance = spec.clearance;
    if (clearance !== undefined && !["snug", "loose", "press"].includes(String(clearance)) && !(typeof clearance === "number" && clearance >= 0)) return `cuts[${index}]: clearance is snug, loose, press, or millimetres each side.`;
    if (spec.hole !== undefined && spec.hole !== "round" && spec.hole !== "teardrop") return `cuts[${index}]: hole is round or teardrop.`;
    if (spec.side !== undefined && spec.side !== "positive" && spec.side !== "negative") return `cuts[${index}]: side is positive or negative.`;
    if (spec.place !== undefined && spec.place !== "fit" && spec.place !== "fixed") return `cuts[${index}]: place is fit or fixed.`;
    if (spec.at !== undefined && !(Array.isArray(spec.at) && spec.at.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n))))) return `cuts[${index}]: at is a list of [u, v] in millimetres on the cut.`;
  }
  return null;
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
export function planPartition(op: PartitionOp, ctx: FillContext, frame: PrintFrame, printer: PlanPrinter, solid?: PartitionSolid & { pose: Affine }): Record<string, unknown> {
  const filled = fillPartition(op, ctx);
  const round = (v: Vec3): Vec3 => v.map((n) => Math.round(n * 1e4) / 1e4 + 0) as Vec3;
  const later = notBuiltYet(op);
  const target = filled.target;
  let cuts: CutInput[];
  let notes: string[];
  let pieces: number | null;
  let placed: { id: string; at: Vec3 }[] | null = null;
  let dropped: { id: string; sentence: string }[] = [];
  if (op.cuts.length === 0) {
    const belt = printer.belt && target.printer === ctx.plateTarget.printer ? { belt: { axis: 1 as Axis } } : {};
    const fit = fitPrinter({ box: frame.box, target, marginMm: filled.bedMarginMm, maxPieces: filled.maxPieces, printerName: target.printer === ctx.plateTarget.printer ? printer.name : (printer.targetName ?? target.printer), ...belt });
    cuts = fit.cuts.map((cut) => ({ origin: round(frame.point(cut.origin)), normal: round(frame.direction(cut.normal)), u: round(frame.direction(cut.u)), profile: { kind: "straight" }, connectors: { on: false } }));
    notes = fit.notes;
    pieces = fit.pieces;
  } else {
    cuts = filled.cuts.map((cut, at) => ({ origin: cut.origin, normal: round(cut.normal), u: round(cut.u), profile: cut.profile as Profile, connectors: cut.connectors.on ? { on: true, types: op.cuts[at]?.connectors?.types ?? [{ type: "dowel" }] } : { on: false } }));
    const d = defaultsFor(target, ctx);
    notes = [shapedCutsSentence(filled.cuts), ...op.cuts.flatMap((cut) => (cut.profile ? profileRefusals(cut.profile, d) : []))].filter((note): note is string => !!note);
    pieces = null;
    // --- Milestone 5. The planner's connectors on each cut's section (plan section 9): what it placed and left out.
    if (later === null && filled.cuts.some((cut) => cut.connectors.on) && solid) {
      const stored = storedPartition(op, ctx, solid.pose, solid);
      if (!("reason" in stored)) {
        placed = stored.marks.map((mark) => ({ id: mark.id, at: round(mark.at) }));
        dropped = stored.dropped;
        notes.push(...stored.notes);
      }
    }
  }
  const proposal = { kind: "partition", cuts, ...(op.target ? { target: op.target } : {}), labels: { ...filled.labels }, ...(op.maxPieces !== undefined ? { maxPieces: op.maxPieces } : {}), ...(op.bedMarginMm !== undefined ? { bedMarginMm: op.bedMarginMm } : {}) };
  return {
    ok: later === null,
    plan: true,
    reason: later ?? (notes[0] ?? (cuts.length === 0 ? "No cut is proposed." : `${cuts.length} ${cuts.length === 1 ? "cut" : "cuts"}.`)),
    cuts,
    ...(pieces !== null ? { pieces } : {}),
    ...(placed ? { connectors: { placed, dropped } } : {}),
    notes,
    target,
    bedMarginMm: filled.bedMarginMm,
    maxPieces: filled.maxPieces,
    op: proposal,
  };
}
