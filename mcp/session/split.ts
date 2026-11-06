/**
 * Split to print: partition ops, pieces, fit coupons, and the piece exports.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { writeFileSync } from "node:fs";
import { base64ToBytes } from "../../src/base64.ts";
import { plainModelError } from "../../src/app/model-error.ts";
import { encode3mf, ID_MATRIX, type Mat3 } from "../../src/mesh-place.ts";
import { probeKey } from "../../src/model-feasibility.ts";
import { forked, stepIds } from "../../src/model-edit.ts";
import { clampPieces, type FillContext, type Target } from "../../src/modeling/partition.ts";
import { couponFileName, fitCoupon, fitCouponRequest, readCouponReply } from "../../src/modeling/fit-coupon.ts";
import { choiceAt, jointDown, jointPlanes, noJointSentence } from "../../src/modeling/joint-down.ts";
import { bedFrame, exportedNote, exportsPieces, PLAN_KIND, planPartition, plateUp, readPartition } from "../partition.ts";
import { pieceNames, SUPPORT_NOTE } from "../../src/modeling/partition-export.ts";
import { formatMm } from "../../src/model-plane.ts";
import { applyRequest, editRequest, exportRequest, probeRequest } from "../../src/model-request.ts";
import { boundsOf, readBroken, readBuilt, nodeHandle, solidView } from "../../src/modeling/model-calls.ts";
import { keptSide, splitKeep } from "../../src/modeling/part-reads.ts";
import { applyPose, isIdentity, typedPoseOf, type Affine } from "../../src/model-space.ts";
import { keptSteps, newTree, opLabel, pathTo, renumberedSteps, reserveId, withChild, withNode, type PartitionModelOp, type ModelOp, type ModelTree } from "../../src/model-tree.ts";
import type { PaintDisk } from "../../src/support-paint.ts";
import { ARRANGE_GAP_MM, arrangedObjects } from "../../src/plate.ts";
import { checkAgainstSlice, findingSummary, fixableEdges, readFinding, readHoldPatches, sliceCheckSummary, type Finding, type SlicedPose, transitionAngleLimit, transitionFindRequest, transitionBuild, TRANSITION_MAX_DEG, TRANSITION_SIZE_MM, type TransitionFix } from "../../src/model-transition.ts";
import { sequentialClearance } from "../../src/settings-rules.ts";
import type { Workplane } from "../../src/workplane.ts";
import { printerTarget, targetPrinter } from "../../src/ui/machine-library.ts";
import { stlBytes } from "../request.ts";
import { cleanOp } from "../../src/modeling/compose.ts";
import { assemblyOf, attached } from "../../src/assembly.ts";
import { featureSolidInModel } from "../../src/model-features.ts";
import { resolveWrite } from "../workspace.ts";
import { CHORD, ModelRunaway, type PlateObject, SLICE_CHECK_MCP, STEP, UNKNOWN_OBJECT, joined, numberNotes, numbered, pinsOf, shownName } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

function splitKeepMethod(this: Session, raw: unknown): "both" | "above" | "below" {
  return splitKeep(raw);
}

/** The half whose centre is on the positive side of the plane is above. */
function keptSideMethod(this: Session, obj: PlateObject, op: Extract<ModelOp, { kind: "split" }>): "above" | "below" {
  return keptSide(obj.solid?.bounds, op);
}

function keepOtherHalf(this: Session, obj: PlateObject, otherKey: string, other: unknown, node: number): string | undefined {
  if (!other || typeof other !== "object") return undefined;
  const piece = solidView(other as Record<string, unknown>);
  if (!piece) return undefined;
  this.seq += 1;
  const id = `obj_${this.seq}`;
  const half: PlateObject = {
    ...obj,
    id,
    name: `${obj.name} split`,
    fileName: obj.fileName,
    bytes: new Uint8Array(),
    source: Float32Array.from(piece.positions),
    triangles: piece.positions.length / 9,
    orient: [...obj.orient] as Mat3,
    offset: { ...obj.offset },
    modelPose: { m: [...obj.modelPose.m] as Affine["m"], t: [...obj.modelPose.t] as Affine["t"] },
    workplane: { source: obj.workplane.source, origin: [...obj.workplane.origin] as Workplane["origin"], turn: [...obj.workplane.turn] as Workplane["turn"] },
    tree: newTree(otherKey, { kind: "piece", tree: obj.tree?.key ?? otherKey, node }, "Split", piece.fingerprint),
    solid: piece,
    probes: new Map(),
    platedNode: null,
    supportEdits: obj.supportEdits.map((entry) => structuredClone(entry)),
    supportPaint: obj.supportPaint.map((disk) => ({ ...disk, p: [...disk.p] as PaintDisk["p"], n: [...disk.n] as PaintDisk["n"] })),
    seamPaint: obj.seamPaint.map((disk) => structuredClone(disk)),
    reinforcement: obj.reinforcement.map((region) => structuredClone(region)),
    objectSettings: { ...obj.objectSettings },
    // The half has no STEP or build of its own until its first commit.
    brep: undefined,
    buildLog: undefined,
    recipe: undefined,
    rustRecipe: undefined,
  };
  this.objects.push(half);
  return id;
}

// --- Split to print (docs/plan-split-connectors.md, D8, D9, sections 10 and 13). Keep this block together. ---

/** What the planner fills defaults from: the plate's printer as the target, the nozzle, the layer, the filament, the brim. */
function partitionContext(this: Session, obj: PlateObject | null): FillContext {
  const printer = this.printer();
  const box = obj?.solid ? (isIdentity(typedPoseOf(obj)) ? obj.solid.bounds : boundsOf(featureSolidInModel(obj.solid, typedPoseOf(obj)).positions)) : null;
  return {
    plateTarget: { printer: printer.id, process: "fdm", volumeMm: [printer.bedX, printer.bedY, printer.bedZ] },
    featureMm: this.library.nozzleMm,
    layerMm: this.settings.layerHeight,
    material: this.filament().material,
    adhesion: this.settings.adhesion,
    brimWidthMm: this.settings.brimWidthMm,
    ...(this.library.measuredFits ? { fits: this.library.measuredFits } : {}),
    ...(box ? { box: { min: [...box.min], max: [...box.max] } } : {}),
  };
}

/** model_probe with plan: true. The planner alone: the solid is read, nothing is cut. */
async function planTool(this: Session, obj: PlateObject, raw: unknown): Promise<Record<string, unknown>> {
  const spec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (spec.kind === "transition") return this.planTransition(obj, spec);
  if (spec.kind !== "partition") return refuse("wrong-kind", PLAN_KIND);
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  const typed = readPartition(spec, (id) => this.partitionTarget(id));
  if ("reason" in typed) return refuse("bad-argument", typed.reason);
  if (!obj.solid) return refuse("solid-unreadable", "This solid could not be read.");
  const printer = this.printer();
  const frame = bedFrame(obj.solid.positions, obj.orient, obj.scale, typedPoseOf(obj));
  const targetName = typed.target ? targetPrinter(this.library, typed.target.printer)?.name : undefined;
  return planPartition(typed, this.partitionContext(obj), frame, { name: printer.name, belt: printer.kind === "belt", ...(targetName ? { targetName } : {}) }, { positions: obj.solid.positions, up: plateUp(obj.orient), pose: typedPoseOf(obj) });
}

/**
 * --- Print transitions, auto-find (docs/plan-belt-transitions.md, step 5). model_probe {op:{kind:"transition"},
 * plan:true}: the kernel lists the edges that start in the air on the current step, from this pose on the plate's
 * printer, and probes each row's fix as the op it would be. Nothing is applied. The ready op holds the rows whose fix
 * builds, as one step.
 */
async function planTransition(this: Session, obj: PlateObject, spec: Record<string, unknown>): Promise<Record<string, unknown>> {
  const extra = Object.keys(spec).find((key) => !["kind", "angleDeg", "size", "maxMm", "mode", "label"].includes(key));
  if (extra) return refuse("bad-argument", `plan:true finds the edges itself, from this pose: it takes angleDeg, size and maxMm, not ${extra}.`);
  if (spec.mode !== undefined && spec.mode !== "auto") return refuse("bad-argument", "plan:true proposes mode auto, which lets each edge's case decide.");
  const limit = transitionAngleLimit(this.settings.supportAngle);
  const angleDeg = spec.angleDeg === undefined ? limit : spec.angleDeg;
  if (typeof angleDeg !== "number" || !Number.isFinite(angleDeg) || angleDeg > TRANSITION_MAX_DEG) return refuse("bad-argument", `angleDeg is the new face's angle to the layers, at most ${TRANSITION_MAX_DEG}°.`);
  if (angleDeg < limit - 1e-9) return refuse("bad-argument", `angleDeg must be at least ${formatMm(limit)}°, the support limit of these settings, so the new face holds its own rows.`);
  const size = spec.size === undefined ? TRANSITION_SIZE_MM : spec.size;
  if (size !== "face" && (typeof size !== "number" || !(size > 0))) return refuse("bad-argument", "size is millimetres along the flatter face, or \"face\" to its end.");
  const maxMm = spec.maxMm;
  if (maxMm !== undefined && (typeof maxMm !== "number" || !(maxMm > 0))) return refuse("bad-argument", "maxMm must be above 0 mm.");
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  const printer = this.printer();
  const fix: TransitionFix = { mode: "auto", angleDeg, size: size as number | "face", ...(maxMm !== undefined ? { maxMm: maxMm as number } : {}) };
  const build = transitionBuild({ orient: obj.orient, belt: printer.kind === "belt" ? printer.belt : null });
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(transitionFindRequest(tree.key, tree.current, build, obj.orient, this.settings.supportAngle, fix), "transition");
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  const found = readFinding(reply, obj.orient, fix, (text) => plainModelError(text, "transition"));
  if (typeof found === "string") return refuse("kernel-refused", plainModelError(found, "transition"));
  const read = this.againstSlice(obj, found, build);
  const pose = typedPoseOf(obj);
  const typedAt = (p: readonly number[]) => this.typedPoint(obj, applyPose(pose, p)).map((value) => Math.round(value * 1000) / 1000 + 0);
  const typed = { kind: "transition", mode: "auto", angleDeg, size, ...(maxMm !== undefined ? { maxMm } : {}) };
  const rows = read.rows.map((row) => ({
    edges: [row.edge],
    case: row.case,
    lengthMm: Math.round(row.lengthMm * 100) / 100,
    ...(row.curved ? { curved: true } : {}),
    at: typedAt(row.mid),
    fix: { ...typed, edges: [row.edge] },
    ...(row.refused ? { refused: row.refused } : row.wedge ? { volumeMm3: row.wedge.volumeMm3 } : {}),
    ...(row.seen ? { seenInSlice: row.seen } : {}),
  }));
  const fixable = fixableEdges(read);
  const next = fixable.length > 0 ? ` The op fixes the ${fixable.length === 1 ? "row that builds" : `${fixable.length} rows that build`} as one step: model_probe it, then model_apply it, or apply one row's fix alone.` : "";
  const check = read.slice ? ` ${sliceCheckSummary(read) ?? ""}`.trimEnd() : ` ${SLICE_CHECK_MCP}`;
  const sliceOnly = (read.slice?.only ?? []).map((row) => ({ edges: [row.edge], distMm: row.distMm, at: typedAt(row.at), unheldMm: row.unheldMm, longestSpanMm: row.longestSpanMm, layers: row.layers }));
  return {
    ok: true,
    reason: `${findingSummary(read)}${next}${check}`,
    rows,
    ...(read.curvedSkipped > 0 ? { curvedSkipped: read.curvedSkipped, curvedEdges: read.curvedEdges } : {}),
    ...(fixable.length > 0 ? { op: { ...typed, edges: fixable } } : {}),
    ...(read.slice ? { slice: { patches: read.slice.patches, awayFromEdges: read.slice.faces }, ...(sliceOnly.length > 0 ? { sliceOnly } : {}) } : {}),
  };
}

/**
 * --- Print transitions, step 6b (plan decision 7). `finding` marked with what the latest slice saw hanging at its
 * edges, when that slice is still this plate as it is (the stamp `gcode_summary` reads); as it is otherwise.
 */
function againstSlice(this: Session, obj: PlateObject, finding: Finding, build: readonly number[]): Finding {
  const job = this.latest;
  const wire = job?.wire;
  if (!job || !wire || this.staleReason(job) || !wire.partHold || !obj.solid) return finding;
  const hold = readHoldPatches(wire.partHold);
  const placed = this.placed(obj);
  const sliced: SlicedPose = { id: obj.id, pose: placed.pose, scale: obj.scale, seatMm: obj.seatMm, key: "" };
  return checkAgainstSlice(finding, { patches: hold, objects: [sliced] }, sliced, obj.solid.lines, obj.solid.bounds, build);
}

/**
 * solid_new with a coupon (plan section 2, milestone 6): the fit coupon for a dowel, built from the planner's layout. On
 * the plate's printer the plate and its pin are two new objects (STEP solids, with their labels cut in); for an
 * export-only printer, the Form 4, they are written to the workspace as STEP files and never reach the plate.
 */
async function fitCouponNew(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = input.coupon && typeof input.coupon === "object" && !Array.isArray(input.coupon) ? (input.coupon as Record<string, unknown>) : null;
  if (!raw) return refuse("bad-coupon", "coupon is {printer, material, radius, depth, hole, startMm}; every field is optional.");
  if (Object.keys(input).some((key) => key !== "coupon" && key !== "name")) return refuse("bad-coupon", "solid_new takes a coupon or a primitive, not both. Only name goes with a coupon.");
  const sizes = (["radius", "depth", "startMm"] as const).filter((key) => raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key])));
  if (sizes.length > 0) return refuse("bad-coupon", `coupon.${sizes[0]} is a number of millimetres.`);
  if (raw.hole !== undefined && raw.hole !== "round" && raw.hole !== "teardrop") return refuse("bad-coupon", "coupon.hole is round or teardrop.");
  let target: Target | null = null;
  if (typeof raw.printer === "string") {
    target = this.partitionTarget(raw.printer);
    if (!target) return refuse("unknown-machine", `No printer in the library is ${raw.printer}. machine_list shows the ids; formlabs-form-4 is the resin printer.`);
  }
  const ctx = this.partitionContext(null);
  const aimed = target ?? ctx.plateTarget;
  const name = this.givenName(input.name);
  const coupon = fitCoupon({
    process: aimed.process,
    material: typeof raw.material === "string" ? raw.material : ctx.material,
    featureMm: ctx.featureMm,
    layerMm: ctx.layerMm,
    fits: ctx.fits,
    ...(typeof raw.radius === "number" ? { radiusMm: raw.radius } : {}),
    ...(typeof raw.depth === "number" ? { depthMm: raw.depth } : {}),
    ...(raw.hole ? { hole: raw.hole as "round" | "teardrop" } : {}),
    ...(typeof raw.startMm === "number" ? { startMm: raw.startMm } : {}),
    ...(name ? { name } : {}),
  });
  if ("reason" in coupon) return refuse("bad-coupon", coupon.reason);
  let reply: ReturnType<typeof readCouponReply>;
  try {
    reply = readCouponReply(JSON.parse(await this.ask(this.engine.modelTree(JSON.stringify(fitCouponRequest(coupon))))) as Record<string, unknown>);
  } catch (err) {
    return refuse("split-refused", err instanceof Error ? err.message : String(err));
  }
  if (typeof reply === "string") return refuse("kernel-refused", plainModelError(reply, "create"));
  const parts = [{ name: coupon.name, file: couponFileName(coupon), part: reply.plate }, ...(reply.pins ? [{ name: `${coupon.name} pins`, file: couponFileName(coupon, true), part: reply.pins }] : [])];
  const summary = {
    sentence: coupon.sentence,
    process: coupon.process,
    sizeMm: coupon.sizeMm,
    holes: coupon.holes.map((hole) => ({ label: hole.label, clearanceMm: hole.clearanceMm, radiusMm: hole.radiusMm, teardrop: hole.teardrop })),
    pins: coupon.pins.length,
    engravedMm3: reply.engravedMm3,
  };
  if (aimed.process !== "fdm") {
    const paths: string[] = [];
    for (const one of parts) {
      const path = resolveWrite(one.file, ".step");
      writeFileSync(path, base64ToBytes(one.part.stepB64) ?? new Uint8Array());
      paths.push(path);
    }
    return { ok: true, files: paths, ...summary, note: SUPPORT_NOTE };
  }
  const made: PlateObject[] = [];
  for (const one of parts) {
    const bytes = base64ToBytes(one.part.stepB64);
    if (!bytes) return refuse("export-failed", "The engine did not write the coupon.");
    const preview = await this.preview(one.file, bytes, STEP);
    made.push(this.addObject({ name: one.name, fileName: one.file, bytes, source: preview.source, triangles: preview.triangles, orient: [...ID_MATRIX], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, seatMm: preview.seatMm, stepTolerance: STEP }));
  }
  this.selected = made[0]!.id;
  return { ok: true, objects: made.map((obj) => obj.id), names: made.map((obj) => shownName(obj.name)), ...summary };
}

/** --- D11. A target typed by its printer alone: the library's printer, or an export-only one such as the Form 4. */
function partitionTarget(this: Session, id: string): Target | null {
  const row = targetPrinter(this.library, id);
  return row ? printerTarget(row) : null;
}

/** The name a target's sentences use: the library's, or the id when the library has no such printer. */
function targetName(this: Session, op: PartitionModelOp): string {
  const id = op.target?.printer ?? this.printer().id;
  return targetPrinter(this.library, id)?.name ?? id;
}

/** --- D12. The split to print for an export target on the way to the part's step, or on the way to a piece's root. */
function exportCut(this: Session, obj: PlateObject): PartitionModelOp | null {
  const tree = obj.tree;
  if (!tree) return null;
  for (const id of pathTo(tree, tree.current)) {
    const op = tree.nodes.get(id)?.op;
    if (op?.kind === "partition" && exportsPieces(op)) return op;
  }
  if (tree.root.kind === "piece") {
    const parent = this.byTreeKey(tree.root.tree)?.tree?.nodes.get(tree.root.node)?.op;
    if (parent?.kind === "partition" && exportsPieces(parent)) return parent;
  }
  return null;
}

/** The kernel cuts a copy: every piece's volume and box in model space. The solid does not change. */
async function probePartition(this: Session, obj: PlateObject, tree: ModelTree, at: number, op: PartitionModelOp, budgetMs?: number, planned: readonly string[] = []): Promise<Record<string, unknown>> {
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(probeRequest(tree.key, at, op), "partition", budgetMs);
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  if (reply.ok !== true) return refuse("kernel-refused", plainModelError(typeof reply.error === "string" ? reply.error : "This does not fit."));
  const parts = Array.isArray(reply.parts) ? (reply.parts as { volumeMm3?: unknown; min?: unknown; max?: unknown }[]) : [];
  const mm = (value: number) => Math.round(value * 100) / 100;
  const pieces = parts.map((part, index) => {
    const corners = Array.isArray(part.min) && Array.isArray(part.max) ? [part.min as number[], part.max as number[]] : null;
    const placed = corners ? boundsOf([0, 1, 2, 3, 4, 5, 6, 7].flatMap((k) => applyPose(typedPoseOf(obj), [corners[k & 1]![0]!, corners[(k >> 1) & 1]![1]!, corners[(k >> 2) & 1]![2]!]))) : null;
    return { part: index + 1, volumeMm3: mm(Number(part.volumeMm3)), ...(placed ? { min: placed.min.map(mm), max: placed.max.map(mm) } : {}) };
  });
  obj.probes.set(probeKey(String(at), op), true);
  // The planner's sentences first (a count that does not fit, a wall too thin), then the kernel's.
  const notes = [...new Set([...planned, ...numberNotes(reply)])];
  return { ok: true, reason: `This cut makes ${parts.length} pieces.`, parts: parts.length, pieces, ...pinsOf(reply), ...joined(reply, typedPoseOf(obj)), ...numbered(reply, typedPoseOf(obj)), ...(notes.length ? { notes } : {}) };
}

/** --- Milestone 5. The key the pins' tree opens under, when a cut of `op` has a dowel placed. */
function pinsKey(this: Session, obj: PlateObject, node: number, op: PartitionModelOp): string | null {
  const dowels = op.cuts.some((cut) => cut.connectors?.on && (cut.connectors.placed ?? []).some((row) => row.type === "dowel"));
  return dowels ? `mcp-pins-${obj.id}-${node}` : null;
}

/** The keys the kernel opens each piece's tree under, one for every piece Max pieces allows after the first. */
function pieceKeys(this: Session, obj: PlateObject, node: number, op: PartitionModelOp): string[] {
  return Array.from({ length: clampPieces(op.maxPieces ?? 12) - 1 }, (_, at) => `mcp-part-${obj.id}-${node}-${at + 2}`);
}

/**
 * model_apply of a split to print. The part keeps its plate id, its tree and its study, which goes stale by the solid's
 * fingerprint (D8); every other piece is a new plate object in the part's plate orientation and model pose, its own tree
 * rooted at this node, with no paint, seam, reinforcement or support edit of its own.
 */
async function applyPartition(this: Session, obj: PlateObject, tree: ModelTree, op: PartitionModelOp, typed: Record<string, unknown>, budgetMs?: number): Promise<Record<string, unknown>> {
  if (!obj.probes.has(probeKey(String(tree.current), op))) return refuse("not-probed", "Probe this edit first, or pass probe: true. It was not applied.", undefined, NEXT.probe);
  const [reserved, node] = reserveId(tree);
  obj.tree = reserved;
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(applyRequest(tree.key, tree.current, node, op, CHORD, null, this.pieceKeys(obj, node, op), this.pinsKey(obj, node, op)), "partition", budgetMs);
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  if (typeof reply.error === "string" && reply.error) return refuse("kernel-refused", plainModelError(reply.error));
  const keys: (string | null)[] = [];
  const objects: string[] = [];
  const listed = Array.isArray(reply.pieces) ? (reply.pieces as unknown[]) : [];
  const exported = exportsPieces(op);
  listed.forEach((entry, at) => {
    const id = entry && typeof entry === "object" ? this.partitionPiece(obj, entry as Record<string, unknown>, node, at + 2, exported) : null;
    keys.push(id ? String((entry as { key?: unknown }).key) : null);
    if (id) objects.push(id);
  });
  // --- Milestone 5. The pins of the cut's dowels: one more object, in the part's orientation, which stands them up.
  const pins = reply.pins && typeof reply.pins === "object" ? this.partitionPins(obj, reply.pins as Record<string, unknown>, node, exported) : null;
  const stored = reply.op && typeof reply.op === "object" && (reply.op as ModelOp).kind === "partition" ? (reply.op as PartitionModelOp) : op;
  obj.tree = withChild(obj.tree, tree.current, { id: node, op: stored, label: opLabel(stored, keys.length + 1), fingerprint: null, pieces: keys, ...(pins ? { pins: pins.key } : {}) });
  const solid = solidView(reply);
  if (solid) obj.solid = solid;
  obj.probes.clear();
  const followed = this.followPieces(obj);
  const notes = [...numberNotes(reply), ...followed.orient.notes];
  const assembly = exported ? null : this.groupPieces(obj, [...objects, ...(pins ? [pins.id] : [])]);
  const note = exported
    ? exportedNote(this.targetName(op))
    : op.arrange === false
      ? "On the plate the pieces share one spot: Arrange lays them side by side."
      : "model_commit puts every piece on the plate and lays them out.";
  return {
    ok: true,
    node: nodeHandle(node),
    parts: keys.length + 1,
    pieces: objects,
    ...(pins ? { pins: pins.id } : {}),
    ...(assembly ? { assembly } : {}),
    note,
    ...joined(reply, typedPoseOf(obj)),
    ...numbered(reply, typedPoseOf(obj)),
    ...(notes.length ? { notes } : {}),
    stored: cleanOp(stored as unknown as Record<string, unknown>),
    typed,
  };
}

/**
 * --- Milestone 5. The pins as one more object (plan section 10): the part's plate orientation, which stands each pin
 * along the plate's Z, its own tree rooted as this node's pins, held off the plate for an export target. Its id and key.
 */
function partitionPins(this: Session, obj: PlateObject, entry: Record<string, unknown>, node: number, exported: boolean): { id: string; key: string } | null {
  const id = this.partitionPiece(obj, entry, node, 0, exported);
  const made = id ? [...this.objects, ...this.piecesOffPlate].find((row) => row.id === id) : undefined;
  if (!made?.tree) return null;
  made.name = `${obj.name} pins`;
  made.tree = newTree(made.tree.key, { kind: "piece", tree: obj.tree!.key, node, pins: true }, "Pins", made.tree.nodes.get(0)?.fingerprint ?? null);
  return { id: made.id, key: made.tree.key };
}

/**
 * One piece after the first as a plate object: the part's orientation, pose and settings, its own tree, empty paint.
 * An export target's piece is held off the plate from the start (D12): it is exported, never sliced.
 */
function partitionPiece(this: Session, obj: PlateObject, entry: Record<string, unknown>, node: number, index: number, exported = false): string | null {
  const solid = solidView(entry);
  const key = typeof entry.key === "string" ? entry.key : "";
  if (!solid || !key || !obj.tree) return null;
  this.seq += 1;
  const id = `obj_${this.seq}`;
  (exported ? this.piecesOffPlate : this.objects).push({
    id,
    name: `${obj.name} part ${index}`,
    fileName: obj.fileName,
    bytes: new Uint8Array(),
    source: Float32Array.from(solid.positions),
    triangles: solid.positions.length / 9,
    orient: [...obj.orient] as Mat3,
    scale: obj.scale,
    centered: obj.centered,
    offset: { ...obj.offset },
    seatMm: obj.seatMm,
    stepTolerance: obj.stepTolerance,
    modelPose: { m: [...obj.modelPose.m] as Affine["m"], t: [...obj.modelPose.t] as Affine["t"] },
    ...(obj.frame ? { frame: obj.frame } : {}),
    workplane: { source: obj.workplane.source, origin: [...obj.workplane.origin] as Workplane["origin"], turn: [...obj.workplane.turn] as Workplane["turn"] },
    tree: newTree(key, { kind: "piece", tree: obj.tree.key, node, index }, `Part ${index}`, solid.fingerprint),
    solid,
    probes: new Map(),
    supportEdits: [],
    supportPaint: [],
    seamPaint: [],
    reinforcement: [],
    objectSettings: { ...obj.objectSettings },
    platedNode: null,
  });
  return id;
}

/**
 * --- Assemblies M8 (D7). A split to print's pieces and pins on the plate make one assembly with the part as its root,
 * each where it was cut. A cut edited later keeps that assembly and seats any new piece in it. Its name, or null when
 * nothing joined (an export target's pieces are off the plate).
 */
function groupPieces(this: Session, root: PlateObject, ids: readonly string[], name?: string): string | null {
  let next = this.liveAssemblies();
  const poseOf = (id: string) => this.find(id)?.modelPose;
  const stem = name ?? shownName(root.name).replace(/\.(stl|step|stp|3mf)$/i, "");
  let joined = false;
  for (const id of ids) {
    const piece = this.find(id);
    if (!piece || id === root.id) continue;
    const made = attached(next, id, root.id, poseOf, stem);
    if ("reason" in made) continue;
    next = made;
    joined = true;
    piece.frame = "part";
  }
  this.assemblies = next;
  return joined ? assemblyOf(next, root.id)?.name ?? null : null;
}

/** The object, on the plate or off it, whose tree is `key`; a reopened project's piece has none open yet, and goes by its id. */
function objectOfKey(this: Session, key: string): PlateObject | undefined {
  return this.byTreeKey(key) ?? [...this.objects, ...this.piecesOffPlate].find((row) => !row.tree && `mcp-${row.id}` === key);
}

/**
 * --- D9. A split to print's pieces are on the plate while that step is on the way to its part's current step, as a
 * join's tool is off it: model_undo or a goto above the cut takes them off, and a redo brings them back.
 */
function followPieces(this: Session, obj: PlateObject): { back: string[]; left: string[]; orient: { turned: string[]; notes: string[] } } {
  const tree = obj.tree;
  if (!tree) return { back: [], left: [], orient: { turned: [], notes: [] } };
  const path = new Set(pathTo(tree, tree.current));
  const wanted = new Map<string, boolean>();
  for (const node of tree.nodes.values()) {
    // An export target's pieces stay off the plate on every step (D12).
    const on = path.has(node.id) && !exportsPieces(node.op);
    for (const key of [...(node.pieces ?? []), node.pins ?? null]) if (key) wanted.set(key, wanted.get(key) === true || on);
  }
  const back: string[] = [];
  const left: string[] = [];
  for (const [key, on] of wanted) {
    const piece = this.objectOfKey(key);
    if (!piece) continue;
    const placed = this.objects.includes(piece);
    if (on && !placed) {
      this.piecesOffPlate.splice(this.piecesOffPlate.indexOf(piece), 1);
      this.objects.push(piece);
      back.push(piece.id);
    } else if (!on && placed) {
      this.objects.splice(this.objects.indexOf(piece), 1);
      this.piecesOffPlate.push(piece);
      if (this.selected === piece.id) this.selected = obj.id;
      left.push(piece.id);
    }
  }
  return { back, left, orient: this.settleOrients(obj) };
}

/**
 * --- Milestone 7 (plan D4, section 10). The plate orientation of a split to print's pieces from the cut on the way to
 * the part's step: a piece set to joint is turned so its larger cut face lies on the bed (`jointDown`, its long way
 * along X, or along the belt on a belt printer); every other piece, and the pins, keep the part's own orientation, which
 * is what a step above the cut gives back too. An export target's pieces keep as cut. Idempotent: the apply, an edit,
 * model_undo, a goto and a redo all end here. The ids it turned, and a sentence for each piece it jointed.
 */
function settleOrients(this: Session, obj: PlateObject): { turned: string[]; notes: string[] } {
  const out = { turned: [] as string[], notes: [] as string[] };
  const tree = obj.tree;
  if (!tree) return out;
  const path = new Set(pathTo(tree, tree.current));
  const live = [...path].reverse().find((id) => tree.nodes.get(id)?.op?.kind === "partition" && !exportsPieces(tree.nodes.get(id)?.op));
  const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 1e-12);
  const belt = this.printer().kind === "belt";
  const base = this.keptOrients.get(obj.id) ?? obj.orient;
  const parentTurned = this.keptOrients.has(obj.id);
  const turn = (row: PlateObject, orient: Mat3) => {
    if (same(row.orient, orient)) return;
    row.orient = [...orient] as Mat3;
    out.turned.push(row.id);
  };
  const settle = (row: PlateObject, op: PartitionModelOp | null, index: number | null, positions: Float32Array | null): void => {
    const choice = op && index !== null ? choiceAt(op.orient, index) : "keep";
    if (choice === "joint" && positions) {
      const joint = jointDown(positions, jointPlanes(op!.cuts), belt);
      if (joint) {
        if (row === obj && !this.keptOrients.has(obj.id)) this.keptOrients.set(obj.id, [...obj.orient] as Mat3);
        this.jointed.add(row.id);
        turn(row, joint.orient);
        out.notes.push(`Part ${index! + 1} is joint down on cut ${joint.face.cut + 1}, its ${joint.other ? "larger" : "only"} cut face, ${Math.round(joint.face.area * 100) / 100} mm².`);
        return;
      }
      out.notes.push(noJointSentence(index! + 1, op!.cuts));
    }
    // Keep: the part's own orientation, for an object Joint down turned or a piece copied from a part that is turned.
    if (row === obj) {
      if (this.jointed.has(row.id)) {
        this.jointed.delete(row.id);
        this.keptOrients.delete(row.id);
        turn(row, base);
      }
      return;
    }
    if (this.jointed.has(row.id) || (parentTurned && same(row.orient, obj.orient))) {
      this.jointed.delete(row.id);
      turn(row, base);
    }
  };
  const livePart = live !== undefined && tree.current === live ? tree.nodes.get(live)?.op : null;
  settle(obj, livePart?.kind === "partition" ? livePart : null, 0, obj.solid ? Float32Array.from(obj.solid.positions) : null);
  for (const node of tree.nodes.values()) {
    if (node.op?.kind !== "partition") continue;
    const on = node.id === live;
    (node.pieces ?? []).forEach((key, at) => {
      const piece = key ? this.objectOfKey(key) : undefined;
      if (!piece) return;
      settle(piece, on ? node.op as PartitionModelOp : null, at + 1, on ? Float32Array.from(piece.solid?.positions ?? piece.source) : null);
    });
    const pins = node.pins ? this.objectOfKey(node.pins) : undefined;
    if (pins) settle(pins, null, null, null);
  }
  return out;
}

/**
 * --- D9. The pieces of an edited split to print, from the edit's reply. The plate object of each part number that is
 * still there takes the new piece, with its later steps replayed on it; a piece past the old count is a new object; an
 * old piece past the new count leaves the plate.
 */
async function rebuildPieces(this: Session, obj: PlateObject, old: readonly (string | null)[], reply: Record<string, unknown>, node: number, exported: boolean): Promise<{ keys: (string | null)[]; objects: string[]; notes: string[] }> {
  const listed = Array.isArray(reply.pieces) ? (reply.pieces as unknown[]) : [];
  const keys: (string | null)[] = [];
  const objects: string[] = [];
  const notes: string[] = [];
  for (const [at, entry] of listed.entries()) {
    if (!entry || typeof entry !== "object") {
      keys.push(null);
      continue;
    }
    const row = entry as Record<string, unknown>;
    const was = old[at] ? this.objectOfKey(old[at]!) : undefined;
    const id = was ? await this.replayPiece(obj, was, row, node, at + 2, notes) : this.partitionPiece(obj, row, node, at + 2, exported);
    keys.push(id ? String(row.key) : null);
    if (id) objects.push(id);
  }
  for (const key of old.slice(listed.length)) {
    const gone = key ? this.objectOfKey(key) : undefined;
    if (!gone) continue;
    if (this.objects.includes(gone)) this.objects.splice(this.objects.indexOf(gone), 1);
    this.piecesOffPlate = this.piecesOffPlate.filter((row) => row !== gone);
    if (this.selected === gone.id) this.selected = obj.id;
    await this.closeTree(gone);
  }
  return { keys, objects, notes };
}

/** --- Milestone 5. The edited cut's pins: the old pins object leaves, and the reply's pins, if any, are a new one. */
async function rebuildPins(this: Session, obj: PlateObject, old: string | null, reply: Record<string, unknown>, node: number, exported: boolean): Promise<{ id: string; key: string } | null> {
  const gone = old ? this.objectOfKey(old) : undefined;
  if (gone) {
    if (this.objects.includes(gone)) this.objects.splice(this.objects.indexOf(gone), 1);
    this.piecesOffPlate = this.piecesOffPlate.filter((row) => row !== gone);
    if (this.selected === gone.id) this.selected = obj.id;
    await this.closeTree(gone);
  }
  return reply.pins && typeof reply.pins === "object" ? this.partitionPins(obj, reply.pins as Record<string, unknown>, node, exported) : null;
}

/** `piece` takes part `index` of the edited cut as its new root, and the steps it had after its root are built again on it. */
async function replayPiece(this: Session, obj: PlateObject, piece: PlateObject, entry: Record<string, unknown>, node: number, index: number, notes: string[]): Promise<string | null> {
  const solid = solidView(entry);
  const key = typeof entry.key === "string" ? entry.key : "";
  if (!solid || !key || !obj.tree) return null;
  const before = piece.tree;
  const later = before ? keptSteps(before) : [];
  if (before) await this.closeTree(piece);
  let tree = newTree(key, { kind: "piece", tree: obj.tree.key, node, index }, `Part ${index}`, solid.fingerprint);
  piece.solid = solid;
  piece.probes = new Map();
  piece.platedNode = null;
  if (before && later.length > 0) {
    const ids = later.map((_, at) => at + 1);
    const renamed = stepIds(later, ids);
    const ops = later.map((id) => renumberedSteps(before.nodes.get(id)!.op!, renamed));
    const replay = ops.slice(1).map((op, at) => ({ id: ids[at + 1]!, op }));
    let built: Record<string, unknown>;
    try {
      // D9: a later step that no longer builds is kept, broken, with the rest under it, the first one too.
      built = await this.treeCall({ ...editRequest(key, 0, ids[0]!, ops[0]!, replay, piece.stepTolerance || CHORD), keepBroken: true }, "edit", this.replayBudgetMs(ids.length));
    } catch (err) {
      if (!(err instanceof ModelRunaway)) throw err;
      built = { error: err.message };
    }
    if (typeof built.error === "string" && built.error) {
      notes.push(`${piece.name}'s later steps did not build on the new cut (${plainModelError(built.error)}), so it is the new piece as cut.`);
    } else {
      const made = readBuilt(built.built);
      const broken = readBroken(built.broken);
      const steps = ids.map((id, at) => ({
        id,
        op: made?.get(id)?.op ?? ops[at]!,
        fingerprint: made?.get(id)?.fingerprint ?? null,
        ...(before.nodes.get(later[at]!)?.name ? { name: before.nodes.get(later[at]!)!.name! } : {}),
        ...(broken?.id === id ? { broken: broken.error } : {}),
      }));
      const tip = [...ids].reverse().find((id) => made?.has(id)) ?? 0;
      tree = forked(tree, 0, steps, tip);
      const shown = solidView(built);
      if (shown) piece.solid = shown;
      if (broken) notes.push(`${piece.name}'s step ${steps.findIndex((step) => step.id === broken.id) + 1} did not build on the new cut: ${plainModelError(broken.error)}`);
    }
  }
  piece.tree = tree;
  return piece.id;
}

/**
 * --- D8. A commit of the part puts its split-to-print pieces on the plate as they now stand: each piece on the way to
 * the part's step that the plate does not hold at its own step is committed too. With the cut's arrange on, the plate is
 * then laid out, as Arrange does.
 */
async function commitPieces(this: Session, obj: PlateObject): Promise<{ committed: string[]; refused: { object: string; reason: string }[]; arranged: boolean }> {
  const tree = obj.tree;
  const out = { committed: [] as string[], refused: [] as { object: string; reason: string }[], arranged: false };
  if (!tree) return out;
  const laid: string[] = [];
  for (const id of pathTo(tree, tree.current)) {
    const node = tree.nodes.get(id);
    if (node?.op?.kind !== "partition") continue;
    for (const key of [...(node.pieces ?? []), node.pins ?? null]) {
      const piece = key ? this.objectOfKey(key) : undefined;
      if (!piece || !this.objects.includes(piece) || !piece.tree || (piece.platedNode === piece.tree.current && piece.bytes.byteLength > 0)) continue;
      const reason = await this.commitObject(piece);
      if (reason) {
        out.refused.push({ object: piece.id, reason });
        continue;
      }
      out.committed.push(piece.id);
      if (node.op.arrange !== false) laid.push(piece.id);
    }
  }
  if (laid.length > 0) out.arranged = this.layOutPieces(laid);
  return out;
}

/**
 * --- D12. Every piece of the last split to print on the way to the part's step, in assembly order: the part itself,
 * then each piece's object as it stands now. An export target's pieces are not saved with a project, so one that no
 * object holds any more is cut again from the stored op on a spare step, as the app's `rebuildPiece` does.
 */
async function partitionPieces(this: Session, obj: PlateObject): Promise<{ pieces: PlateObject[]; op: PartitionModelOp; pins: PlateObject | null } | { reason: string }> {
  const tree = await this.opened(obj);
  if ("reason" in tree) return tree;
  const at = [...pathTo(tree, tree.current)].reverse().find((id) => tree.nodes.get(id)?.op?.kind === "partition");
  const node = at === undefined ? undefined : tree.nodes.get(at);
  if (!node || node.op?.kind !== "partition" || node.parent === null) return { reason: "This part has no split to print on the way to its step. pieces: true exports a split to print's pieces." };
  const op = node.op;
  const keys = [...(node.pieces ?? [])];
  const pieces: (PlateObject | null)[] = [];
  for (const key of keys) {
    const piece = key ? this.objectOfKey(key) : undefined;
    const opened = piece ? await this.opened(piece) : null;
    pieces.push(piece && opened && !("reason" in opened) && piece.solid ? piece : null);
  }
  const missing = pieces.findIndex((piece) => !piece);
  // A plate piece the user removed is not made again by an export, which would put it back on the plate.
  if (missing >= 0 && !exportsPieces(op)) return { reason: `Part ${missing + 2} of this cut is no longer on the plate. model_edit the cut to make it again.` };
  if (missing >= 0) {
    const [reserved, spare] = reserveId(tree);
    obj.tree = reserved;
    const fresh = pieces.map((piece, index) => (piece ? null : `mcp-part-${obj.id}-${node.id}-${index + 2}-r${spare}`));
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(applyRequest(tree.key, node.parent, spare, op, CHORD, null, fresh), "partition");
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return { reason: String(lost.reason) };
      throw err;
    }
    await this.treeCall({ call: "drop", key: tree.key, node: spare }).catch(() => ({}));
    if (typeof reply.error === "string" && reply.error) return { reason: plainModelError(reply.error) };
    const listed = Array.isArray(reply.pieces) ? (reply.pieces as unknown[]) : [];
    if (listed.length !== keys.length) return { reason: "This cut no longer makes the pieces its step names. Edit it with model_edit." };
    for (const [index, key] of fresh.entries()) {
      const entry = listed[index];
      if (!key || !entry || typeof entry !== "object") continue;
      const id = this.partitionPiece(obj, entry as Record<string, unknown>, node.id, index + 2, true);
      const made = id ? this.objectOfKey(key) : undefined;
      if (!made) return { reason: `Part ${index + 2} could not be cut again.` };
      pieces[index] = made;
      keys[index] = key;
    }
    obj.tree = withNode(obj.tree ?? tree, node.id, { pieces: keys });
  }
  if (!obj.solid) return { reason: "This solid could not be read." };
  // --- Milestone 5. The pins, when the cut has dowels, export as one more part after the last piece.
  let pins: PlateObject | null = null;
  if (node.pins) {
    const held = this.objectOfKey(node.pins);
    const opened = held ? await this.opened(held) : null;
    if (held && opened && !("reason" in opened) && held.solid) pins = held;
    else if (exportsPieces(op)) {
      const [reserved, spare] = reserveId(obj.tree ?? tree);
      obj.tree = reserved;
      const key = `mcp-pins-${obj.id}-${node.id}-r${spare}`;
      let reply: Record<string, unknown>;
      try {
        reply = await this.treeCall(applyRequest(tree.key, node.parent, spare, op, CHORD, null, undefined, key), "partition");
      } catch (err) {
        const lost = this.lostReply(err);
        if (lost) return { reason: String(lost.reason) };
        throw err;
      }
      await this.treeCall({ call: "drop", key: tree.key, node: spare }).catch(() => ({}));
      if (typeof reply.error === "string" && reply.error) return { reason: plainModelError(reply.error) };
      const made = reply.pins && typeof reply.pins === "object" ? this.partitionPins(obj, reply.pins as Record<string, unknown>, node.id, true) : null;
      pins = made ? (this.objectOfKey(made.key) ?? null) : null;
      if (!pins) return { reason: "This cut's pins could not be cut again." };
      obj.tree = withNode(obj.tree ?? tree, node.id, { pins: made!.key });
    } else return { reason: "This cut's pins are no longer on the plate. model_edit the cut to make them again." };
  }
  return { pieces: [obj, ...(pieces as PlateObject[])], op, pins };
}

/** --- D12. export_3mf with pieces: true. One 3MF of every piece, named `<name>-<n>`, or with stl: true one STL each. */
async function exportPieceMeshes(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requested = typeof input.object === "string" ? input.object : "";
  const obj = this.find(requested !== "" ? requested : this.selected) ?? this.piecesOffPlate.find((row) => row.id === requested) ?? null;
  if (!obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  const got = await this.partitionPieces(obj);
  if ("reason" in got) return refuse("split-refused", got.reason);
  const name = String(input.name);
  const parts = got.pins ? [...got.pieces, got.pins] : got.pieces;
  const names = pieceNames(name, got.pieces.length, !!got.pins);
  const folder = name.slice(0, Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const meshes = parts.map((piece) => featureSolidInModel(piece.solid!, piece.modelPose).positions);
  const rows = this.pieceRows(parts, names);
  if (input.stl === true) {
    const files = meshes.map((mesh, index) => {
      const path = resolveWrite(`${folder}${names[index]}`, ".stl");
      const bytes = stlBytes(Float32Array.from(mesh), `${names[index]}.stl`);
      writeFileSync(path, bytes);
      return { path, bytes: bytes.byteLength };
    });
    return { ok: true, files, parts: got.pieces.length, pieces: rows, note: SUPPORT_NOTE };
  }
  const bytes = encode3mf(meshes.map((mesh) => Float32Array.from(mesh)), names);
  const path = resolveWrite(name, ".3mf");
  writeFileSync(path, bytes);
  return { ok: true, path, bytes: bytes.byteLength, parts: got.pieces.length, pieces: rows, note: SUPPORT_NOTE };
}

/** --- D12. model_export_step with pieces: true. One STEP file holding every piece as a named solid, in order. */
async function exportPieceStep(this: Session, obj: PlateObject, name: string): Promise<Record<string, unknown>> {
  const got = await this.partitionPieces(obj);
  if ("reason" in got) return refuse("split-refused", got.reason);
  const parts = got.pins ? [...got.pieces, got.pins] : got.pieces;
  const names = pieceNames(name, got.pieces.length, !!got.pins);
  const [first, ...rest] = parts.map((piece) => piece.tree!);
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(exportRequest(first!.key, first!.current, "step", rest.map((tree) => ({ key: tree.key, node: tree.current })), names), "export");
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  const step = this.stepBytes(reply);
  if (!step) return refuse("kernel-refused", typeof reply.error === "string" ? plainModelError(reply.error) : "The pieces were not exported.");
  const path = resolveWrite(name, ".step");
  writeFileSync(path, step);
  return {
    ok: true,
    path,
    bytes: step.byteLength,
    parts: got.pieces.length,
    solids: typeof reply.solids === "number" ? reply.solids : parts.length,
    pieces: this.pieceRows(parts, names),
    names: "The STEP file holds the pieces as separate named solids in this order, named as in the 3MF and the STL files.",
    note: SUPPORT_NOTE,
  };
}

function pieceRows(this: Session, pieces: readonly PlateObject[], names: readonly string[]): { part: number; name: string; object: string; volumeMm3: number }[] {
  return pieces.map((piece, index) => ({ part: index + 1, name: names[index]!, object: piece.id, volumeMm3: Math.round((piece.solid?.volumeMm3 ?? 0) * 1000) / 1000 }));
}

/**
 * --- Plan section 10. Lay out places only the new pieces, around what is already on the plate, the part's own first
 * piece included, which all stay where they are; Arrange would move every object.
 */
function layOutPieces(this: Session, ids: readonly string[]): boolean {
  const printer = this.printer();
  const fresh = new Set(ids);
  const keep = new Set(this.objects.filter((row) => !fresh.has(row.id)).map((row) => row.id));
  const clearance = sequentialClearance(this.sliceRules(this.objects.length), this.order());
  const gap = clearance === null ? ARRANGE_GAP_MM : clearance + 0.01;
  // A belt printer's length is unbounded (decision 11): the pieces stack along it, so none goes off the bed.
  const arranged = arrangedObjects(this.objects.map((obj) => this.asBed(obj)), printer.bedX, printer.kind === "belt" ? 1e6 : printer.bedY, gap, keep);
  for (const row of arranged) {
    const live = fresh.has(row.id) ? this.find(row.id) : undefined;
    if (!live) continue;
    live.centered = row.centered;
    live.offset = { ...row.offset };
  }
  return true;
}

/** The methods this module adds to Session. */
export const splitMethods = {
  splitKeep: splitKeepMethod,
  keptSide: keptSideMethod,
  keepOtherHalf,
  partitionContext,
  planTool,
  planTransition,
  againstSlice,
  fitCouponNew,
  partitionTarget,
  targetName,
  exportCut,
  probePartition,
  pinsKey,
  pieceKeys,
  applyPartition,
  partitionPins,
  partitionPiece,
  groupPieces,
  objectOfKey,
  followPieces,
  settleOrients,
  rebuildPieces,
  rebuildPins,
  replayPiece,
  commitPieces,
  partitionPieces,
  exportPieceMeshes,
  exportPieceStep,
  pieceRows,
  layOutPieces,
};
