/** Split to print: the card's frame, its check, and the exported-part notes. */
import { base64ToBytes } from "../../base64";
import { toSolidOp } from "../../model-space";
import { decodeSolid, type ParsedSolid } from "../../model-reply";
import { pathTo, type ModelTree, type NodeId, type PartitionModelOp, type Vec3 } from "../../model-tree";
import { probeRequest } from "../../model-request";
import { addMeshBytes } from "../files";
import { plainModelError } from "../model-error";
import { freshTreeKey, modelTrees } from "../model-trees";
import { state } from "../state";
import { printerTarget, selection, targetPrinter, targetPrinters } from "../../ui/machine-library.ts";
import { setSplitPrintCheck, type PrintOn, type SplitPrintCheck } from "../../ui/split-print.ts";
import {
  bedFrame,
  exportTarget,
  exportedCommit,
  exportsPieces,
  fitOnBed,
  plateUp,
  profileSlice,
  sectionSpan,
  storedPartition,
  type CardFrame,
  type FitOnBed,
  type LabelSizes,
  type PieceCheck,
  type Placement,
} from "../../split-print.ts";
import {
  clampPieces,
  defaultsFor,
  fillConnector,
  type ConnectorSpec,
  type FillContext,
  type PartitionOp,
  type Target,
} from "../../modeling/partition.ts";
import {
  couponFileName,
  couponInputFor,
  fitCoupon,
  fitCouponRequest,
  readCouponReply,
} from "../../modeling/fit-coupon.ts";
import { loadMachineLibrary } from "../machine-library.ts";
import { axesOf, isIdentityFrame } from "../../workplane";
import { S } from "./shared";
import { treeOf } from "./edges";
import { post, text, treeCall } from "./engine";
import { saveStepFile } from "./export";
import { readout } from "./pick";
import { probeName } from "./probe";
import { sentence } from "./run-edit";
import type { Body } from "./shared";
import { kernelNotes } from "./split-apply";
import { boxOf, openPose, viewed } from "./view";
import { plateObjectOpen, workplaneOfOpen } from "./workplane";
import { lastFace } from "../../model-blend";
import { planeFor } from "../../model-plane";
import { enterMeasured, resetMeasured } from "../../modeling/partition.ts";
import { chainFromSketch } from "../../modeling/sketch-profile.ts";
import { cutTraces } from "../../split-print.ts";
import { setMeasuredFits } from "../../ui/machine-library.ts";
import { mountSplitPrint } from "../../ui/split-print.ts";
import { fx } from "../fx";
import { storeMachineLibrary } from "../machine-library.ts";
import { closeSketchSession, openProfileSketch } from "../sketch";
import { cancelEdit } from "./edit";
import { exportPieceFiles } from "./export";
import { flatFace, kernelBox, modelExtent } from "./geometry";
import { currentParams } from "./parameters";
import { syncUndo } from "./undo";
import { openBox } from "./view";
import { posedFace } from "./workplane";

// --- Split to print (docs/plan-split-connectors.md, milestone 4): the card's frame, its check, its Apply, and the
// pencil's Update. Keep this block together. ---

/** The planner's context: the plate's printer as the target, its nozzle, the layer, the filament, the brim, the box. */
export function partitionContext(solid: ParsedSolid): FillContext {
  const picked = selection(loadMachineLibrary());
  const box = boxOf(solid.positions);
  return {
    plateTarget: { printer: picked?.printer.id ?? "plate", process: "fdm", volumeMm: [state.profile.bedX, state.profile.bedY, state.profile.bedZ] },
    featureMm: state.profile.nozzleDiameter,
    layerMm: state.layerHeight,
    material: picked?.filament.material ?? "",
    adhesion: state.adhesion,
    brimWidthMm: state.brimWidthMm,
    fits: loadMachineLibrary().measuredFits,
    box: { min: [...box.min], max: [...box.max] },
  };
}

/** The open object's local workplane as the card reads it, or null in model space. */
export function splitPrintFrame(): CardFrame | null {
  const plane = workplaneOfOpen();
  return isIdentityFrame(plane) ? null : { origin: [plane.origin[0], plane.origin[1], plane.origin[2]], axes: axesOf(plane) };
}

/** The Print on list: the plate's printer first, with no target of its own, then the library's others, the Form 4 last. */
export function splitPrinters(): PrintOn[] {
  const library = loadMachineLibrary();
  const picked = selection(library);
  const plate = picked?.printer.id ?? "plate";
  const others = targetPrinters(library).filter((row) => row.id !== plate);
  return [{ id: plate, name: picked?.printer.name ?? state.profile.name, target: null }, ...others.map((row) => ({ id: row.id, name: row.name, target: printerTarget(row) }))];
}

/** The number height and depth Part numbers writes: the target process's `partitionDefaults`. */
export function labelSizes(target: Target | null): LabelSizes {
  const solid = viewed();
  if (!solid) return { height: 4, depth: 0.4 };
  const ctx = partitionContext(solid);
  const defaults = defaultsFor(target ?? ctx.plateTarget, ctx);
  return { height: defaults.numberHeightMm, depth: defaults.numberDepthMm };
}

/**
 * Print a fit coupon… (plan section 2): the fit coupon for the dowel on the card, built by the engine from the planner's
 * layout. The plate's printer gets the plate and its pin as two plate objects, STEP files Model can open; an export target
 * gets both saved as STEP files. The answer is the card's sentence.
 */
export async function printFitCoupon(target: Target | null, spec: ConnectorSpec): Promise<string> {
  const solid = viewed();
  if (!solid) return "Open a part first.";
  const ctx = partitionContext(solid);
  const aimed = target ?? ctx.plateTarget;
  const coupon = fitCoupon(couponInputFor(fillConnector(spec, defaultsFor(aimed, ctx)), { process: aimed.process, material: ctx.material, featureMm: ctx.featureMm, layerMm: ctx.layerMm, fits: ctx.fits }));
  if ("reason" in coupon) return coupon.reason;
  readout("Building the fit coupon…");
  const reply = readCouponReply(await post(fitCouponRequest(coupon)));
  if (typeof reply === "string") {
    readout(reply);
    return reply;
  }
  const files = [{ name: couponFileName(coupon), b64: reply.plate.stepB64 }, ...(reply.pins ? [{ name: couponFileName(coupon, true), b64: reply.pins.stepB64 }] : [])];
  const bytes = files.map((file) => base64ToBytes(file.b64));
  if (bytes.some((one) => !one)) return "The engine did not write the coupon.";
  if (exportTarget(target)) {
    for (const [index, file] of files.entries()) await saveStepFile(bytes[index]!.slice().buffer as ArrayBuffer, file.name);
    const said = `Saved ${files.map((file) => file.name).join(" and ")}. ${coupon.sentence}`;
    readout(said);
    return said;
  }
  for (const [index, file] of files.entries()) await addMeshBytes(file.name, bytes[index]!.slice().buffer as ArrayBuffer, true);
  const said = `Added ${files.map((file) => file.name).join(" and ")} to the plate. ${coupon.sentence}`;
  readout(said);
  return said;
}

/** Fit the bed, or the printer `target` is: the planner's cuts for the open part as the plate prints it, in model space. */
export function fitSplitPrint(target: Target | null): FitOnBed | null {
  const solid = viewed();
  const obj = plateObjectOpen();
  if (!solid?.editable || !obj || solid.positions.length < 9) return null;
  const ctx = partitionContext(solid);
  const aimed = target ?? ctx.plateTarget;
  const defaults = defaultsFor(aimed, ctx);
  const selected = obj.id === state.plate.selectedId;
  const frame = bedFrame(solid.positions, selected ? state.orient : obj.orient, selected ? state.partScale : obj.partScale, openPose());
  const picked = selection(loadMachineLibrary());
  const own = aimed.printer === ctx.plateTarget.printer;
  const name = own ? picked?.printer.name ?? state.profile.name : targetPrinter(loadMachineLibrary(), aimed.printer)?.name ?? aimed.printer;
  return fitOnBed(frame, aimed, defaults.bedMarginMm, defaults.maxPieces, name, own && picked?.printer.kind === "belt");
}

/** The name a split to print's sentences give its target printer. */
export function targetName(op: PartitionModelOp): string {
  const id = op.target?.printer ?? selection(loadMachineLibrary())?.printer.id ?? "";
  return targetPrinter(loadMachineLibrary(), id)?.name ?? id;
}

/** Whether a split to print for an export target is on the way to `node`: the part is cut for a printer this app does not slice for. */
export function exportCutTo(tree: ModelTree, node: NodeId): PartitionModelOp | null {
  for (const id of pathTo(tree, node)) {
    const op = tree.nodes.get(id)?.op;
    if (op?.kind === "partition" && exportsPieces(op)) return op;
  }
  return null;
}

/**
 * --- D12. The sentence for the first plate object whose step is past a cut for an export target, or null. The plate keeps
 * the part as it was before the cut; a slice and the plate's 3MF refuse with this, as a commit does.
 */
export function exportedPart(): string | null {
  for (const obj of state.plate.objects) {
    const tree = obj.modelTree ? modelTrees.get(obj.modelTree) : undefined;
    const cut = tree && !exportSplitEnds(tree) ? exportCutTo(tree, tree.current) : null;
    if (cut) return exportedCommit(obj.name, targetName(cut));
  }
  return null;
}

/**
 * A tree whose shown step is a split to print for an export target and nothing more: the plate holds the root, which is
 * the part whole, and the pieces never reach it, so Model is not ahead of the plate. Any step after the cut, or a second
 * cut before it, is.
 */
function exportSplitEnds(tree: ModelTree): { op: PartitionModelOp; parts: number } | null {
  const path = pathTo(tree, tree.current);
  const node = tree.nodes.get(path.at(-1)!);
  if (node?.op?.kind !== "partition" || !exportsPieces(node.op)) return null;
  const earlier = path.slice(0, -1).some((id) => {
    const op = tree.nodes.get(id)?.op;
    return op?.kind === "partition" && exportsPieces(op);
  });
  return earlier ? null : { op: node.op, parts: (node.pieces?.length ?? 0) + 1 };
}

/**
 * Prepare's note on a plate object whose Model step is a split to print for an export target: the pieces are held in
 * Model, off the plate, so nothing in Prepare says the part is split. Null for any other object.
 */
export function exportSplitNote(objectId: string): string | null {
  const key = state.plate.objects.find((obj) => obj.id === objectId)?.modelTree;
  const tree = key ? modelTrees.get(key) : undefined;
  const split = tree ? exportSplitEnds(tree) : null;
  return split ? `Split for the ${targetName(split.op)} in Model, ${split.parts} parts. The plate prints it whole.` : null;
}

/**
 * --- Milestone 10. What a sketched cut's profile is drawn against, in model space: the part cut across the profile plane
 * through the middle of the section, each loop closed, and the cut's own trace across the section.
 */
export function profileRefs(plane: { origin: Vec3; normal: Vec3 }, u: Vec3): { points: number[] }[] {
  const solid = viewed();
  if (!solid) return [];
  const own = (toSolidOp({ kind: "partition", cuts: [{ origin: plane.origin, normal: plane.normal, u }] }, openPose()) as PartitionModelOp).cuts[0]!;
  const cut = { origin: own.origin, normal: own.normal, u: own.u! };
  const span = sectionSpan(solid.positions, cut);
  if (!span) return [];
  const length = Math.hypot(...plane.normal) || 1;
  const w: Vec3 = [plane.normal[0] / length, plane.normal[1] / length, plane.normal[2] / length];
  const at = (p: readonly number[]) => [0, 1, 2].map((k) => plane.origin[k]! + u[k]! * p[0]! + w[k]! * p[1]!);
  const slice = profileSlice(solid.positions, cut, span);
  const loops = slice ? [slice.outer, ...(slice.holes ?? [])].map((ring) => ({ points: [...ring, ring[0]!].flatMap(at) })) : [];
  return [...loops, { points: [...at([span.u0, 0]), ...at([span.u1, 0])] }];
}

/** The op the tree stores for the card's cuts, in the solid's own frame, or why it cannot be cut. */
export function splitStored(typed: PartitionOp): ({ op: PartitionModelOp } & Placement) | { reason: string } | null {
  const solid = viewed();
  const obj = plateObjectOpen();
  if (!solid) return null;
  const orient = obj && obj.id !== state.plate.selectedId ? obj.orient : state.orient;
  return storedPartition(typed, partitionContext(solid), openPose(), { positions: solid.positions, up: plateUp(orient) });
}

let splitCheckTimer = 0;

let splitCheckSerial = 0;

/** Kernel answers for the card, by `probeName`, so going back to cuts just checked asks nothing. */
const splitAnswers = new Map<string, SplitPrintCheck>();

/** The card's cuts changed: the kernel cuts a copy once they rest `wait` ms. No call while a plane is dragged. */
export function checkSplitPrint(typed: PartitionOp | null, wait: number) {
  window.clearTimeout(splitCheckTimer);
  const serial = ++splitCheckSerial;
  const at = S.open;
  const tree = treeOf(at);
  const stored = typed && at && tree ? splitStored(typed) : null;
  if (!stored || !at || !tree) {
    setSplitPrintCheck(null);
    return;
  }
  if ("reason" in stored) {
    setSplitPrintCheck({ phase: "done", ok: false, error: stored.reason });
    return;
  }
  const node = tree.current;
  const key = probeName(at.key, node, stored.op);
  const known = splitAnswers.get(key);
  if (known) {
    setSplitPrintCheck(known);
    return;
  }
  setSplitPrintCheck({ phase: "checking" });
  splitCheckTimer = window.setTimeout(() => void sendSplitCheck(serial, key, at.key, node, stored.op), wait);
}

async function sendSplitCheck(serial: number, key: string, treeKey: string, node: NodeId, op: PartitionModelOp) {
  if (serial !== splitCheckSerial || state.stage !== "model") return;
  const body = await treeCall(treeKey, node, probeRequest(treeKey, node, op));
  const view: SplitPrintCheck = body.ok === true
    ? { phase: "done", ok: true, parts: readParts(body.parts), notes: kernelNotes(body), ...readPinsCheck(body.pins), ...readPlacedIds(body.connectors) }
    : { phase: "done", ok: false, error: sentence(plainModelError(text(body.error) || "These planes do not cut this solid.")) };
  if (typeof body.ok === "boolean") {
    if (splitAnswers.size >= 64) splitAnswers.clear();
    splitAnswers.set(key, view);
  }
  if (serial === splitCheckSerial && state.stage === "model") setSplitPrintCheck(view);
}

/** A probe's pins: how many, and their volume. Nothing when the cut has none. */
function readPinsCheck(value: unknown): { pins?: { count: number; volumeMm3: number } } {
  if (!value || typeof value !== "object") return {};
  const row = value as { count?: unknown; volumeMm3?: unknown };
  return { pins: { count: Number(row.count) || 0, volumeMm3: Number(row.volumeMm3) || 0 } };
}

/** The ids of the connectors the kernel built, from a probe's `connectors`. Nothing when the cut has none on. */
function readPlacedIds(value: unknown): { placed?: string[] } {
  const placed = value && typeof value === "object" ? (value as { placed?: unknown }).placed : undefined;
  if (!Array.isArray(placed)) return {};
  return { placed: placed.map((row) => String((row as { id?: unknown } | null)?.id ?? "")) };
}

/** An apply's or an edit's `pins`: the pins' key and solid, null with none, or a string when they could not be read. */
export function readPins(value: unknown): { key: string; solid: ParsedSolid } | null | string {
  if (!value || typeof value !== "object") return null;
  const solid = decodeSolid(value as Body);
  return typeof solid === "string" ? solid : { key: String((value as Body).key), solid };
}

/** The key the pins' tree opens under, when a cut of `op` has a dowel placed (plan section 10). */
export function pinsKeyFor(objectId: string, op: PartitionModelOp): string | null {
  const dowels = op.cuts.some((cut) => cut.connectors?.on && (cut.connectors.placed ?? []).some((row) => row.type === "dowel"));
  return dowels ? freshTreeKey(`${objectId}-pins`) : null;
}

/** A probe's pieces, as the kernel cut them: each one's volume and box. */
function readParts(value: unknown): PieceCheck[] {
  if (!Array.isArray(value)) return [];
  const vec = (v: unknown): Vec3 | undefined => (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number") ? (v as Vec3) : undefined);
  return value.map((part) => {
    const row = (part ?? {}) as { volumeMm3?: unknown; min?: unknown; max?: unknown };
    const min = vec(row.min);
    const max = vec(row.max);
    return { volumeMm3: Number(row.volumeMm3) || 0, ...(min && max ? { min, max } : {}) };
  });
}

/** The keys the kernel opens each piece's tree under, one for every piece Max pieces allows after the first. */
export function partKeys(objectId: string, op: PartitionModelOp): string[] {
  return Array.from({ length: clampPieces(op.maxPieces ?? 12) - 1 }, () => freshTreeKey(`${objectId}-part`));
}

type PieceReply = { key: string; solid: ParsedSolid } | null;

/** An apply's or an edit's `pieces`, in partition order from piece 2; a string when one could not be read. */
export function readPieces(value: unknown): PieceReply[] | string {
  if (!Array.isArray(value)) return [];
  const out: PieceReply[] = [];
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== "object") {
      out.push(null);
      continue;
    }
    const solid = decodeSolid(entry as Body);
    if (typeof solid === "string") return solid;
    out.push({ key: String((entry as Body).key), solid });
  }
  return out;
}

export function bindSplitPrint() {
  // --- Split to print: the Features menu's card.
  mountSplitPrint({
    undoChanged: () => syncUndo(),
    solidBox: () => (viewed()?.editable && !S.lens ? openBox() : null),
    frame: splitPrintFrame,
    plan(base, cut) {
      const at = viewed();
      if (!at) return null;
      const pose = openPose();
      return planeFor(base, cut.value, [cut.tiltA, cut.tiltB], (normal) => modelExtent(at, pose, normal), kernelBox(at, pose));
    },
    fit: fitSplitPrint,
    printers: splitPrinters,
    plate: () => selection(loadMachineLibrary())?.printer.id ?? null,
    numberSizes: labelSizes,
    exportPieces: () => void exportPieceFiles(),
    pickedFace() {
      const solid = viewed();
      const face = lastFace(S.picks);
      if (!solid || face == null) return null;
      return posedFace(flatFace(solid, face)) ?? "curved";
    },
    check: checkSplitPrint,
    connectors(typed) {
      const stored = splitStored(typed);
      return stored && !("reason" in stored) ? { notes: stored.notes, fits: stored.fits, marks: stored.marks, dropped: stored.dropped } : null;
    },
    refusal(typed) {
      const stored = splitStored(typed);
      return stored && "reason" in stored ? stored.reason : "";
    },
    shaped(typed) {
      const stored = splitStored(typed);
      return stored && !("reason" in stored) ? (stored.shaped ?? []) : [];
    },
    traces(typed) {
      const solid = viewed();
      return solid ? cutTraces(typed, partitionContext(solid), openPose(), solid.positions) : [];
    },
    profileSketch(plane, u, sketch, check, done) {
      openProfileSketch({
        sketch,
        refs: profileRefs(plane, u),
        check(drawn) {
          const chain = chainFromSketch(drawn);
          return ("reason" in chain ? chain.reason : check(chain)).replace(/^Cut \d+: /, "");
        },
        done,
      });
    },
    endProfileSketch: () => closeSketchSession(),
    defaults(target) {
      const solid = viewed();
      if (!solid) return null;
      const ctx = partitionContext(solid);
      return defaultsFor(target ?? ctx.plateTarget, ctx);
    },
    holeCompensation: () => state.xyHoleCompensationMm,
    printCoupon: printFitCoupon,
    material: () => selection(loadMachineLibrary())?.filament.material ?? "",
    fits: () => loadMachineLibrary().measuredFits,
    enterFits(key, results) {
      storeMachineLibrary(setMeasuredFits(loadMachineLibrary(), enterMeasured(loadMachineLibrary().measuredFits, key, results)));
    },
    resetFits(key) {
      storeMachineLibrary(setMeasuredFits(loadMachineLibrary(), resetMeasured(loadMachineLibrary().measuredFits, key)));
    },
    cancelled: cancelEdit,
    parameters: () => currentParams(),
    view: () => fx.model ?? null,
    readout,
  });
}
