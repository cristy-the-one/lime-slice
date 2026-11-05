/** Split to print: Apply and Update, and the laying out of the pieces they make. */
import { type Mat3 } from "../../mesh-place";
import { forked, stepIds, type EditLevel, type ForkStep } from "../../model-edit";
import { DAMAGED, decodeSolid, type ParsedSolid } from "../../model-reply";
import {
  ROOT,
  keptSteps,
  newTree,
  opLabel,
  pathTo,
  renumberedSteps,
  reserveId,
  withChild,
  withNode,
  type ModelTree,
  type NodeId,
  type PartitionModelOp,
} from "../../model-tree";
import { applyRequest, crossEditRequest, editRequest, keepSketch } from "../../model-request";
import { stepLabel } from "../../model-history";
import { arrangedObjects, withPieceMesh, withoutObject } from "../../plate";
import { place } from "../files";
import { flushEdit, markModelEdit, noteEdit } from "../history";
import { plainModelError } from "../model-error";
import { freshTreeKey, modelTrees } from "../model-trees";
import { applySelectedToState, syncPlateFromState } from "../plate-sync";
import { state } from "../state";
import { groupAsBuilt } from "../assemblies.ts";
import { selection } from "../../ui/machine-library.ts";
import {
  setSplitPrintWaiting,
  splitPrintApplied,
  showSplitPrintDone,
  type SplitPrintDone,
} from "../../ui/split-print.ts";
import { exportsPieces } from "../../split-print.ts";
import { pieceNames, pinsName } from "../../modeling/partition-export.ts";
import { mm as mmText, type PartitionOp } from "../../modeling/partition.ts";
import { choiceAt, jointDown, jointPlanes, noJointSentence } from "../../modeling/joint-down.ts";
import { loadMachineLibrary } from "../machine-library.ts";
import { S } from "./shared";
import { failed, keepSolid, leavingNotes } from "./apply";
import { meshOf } from "./commit";
import { placePiece } from "./create";
import { treeOf } from "./edges";
import { dropInEngine, isOp, post, text, treeCall } from "./engine";
import { stlName } from "./geometry";
import { followSelection } from "./lifecycle";
import { about, readout } from "./pick";
import { brokenStep, builtSteps, forkSteps, sentence } from "./run-edit";
import type { Body, Editing, Opened } from "./shared";
import { partKeys, pinsKeyFor, readPieces, readPins, splitStored, targetName } from "./split-print";
import { syncUndo } from "./undo";
import { present, refreshModelContext } from "./view";
import { sameMat } from "./workplane";

/**
 * Apply of Split to print's card: the part keeps its plate id and the first piece (D8); every other piece is a new plate
 * object in the part's place and pose, the root of its own tree, and with Lay out on the bed the new ones go around what
 * is already on the plate. One step in History, and one Prepare step for the visit.
 */
export async function applySplitPrint(typed: PartitionOp) {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || S.busy || S.jumping || !state.mesh) return;
  if (at.objectId !== state.plate.selectedId) {
    followSelection();
    return;
  }
  const stored = splitStored(typed);
  if (!stored) return;
  if ("reason" in stored) {
    readout(stored.reason);
    return;
  }
  const op = stored.op;
  S.parked = null;
  S.editBack = null;
  const parent = tree.current;
  const [reserved, node] = reserveId(tree);
  modelTrees.set(at.key, reserved);
  const keys = partKeys(at.objectId, op);
  const pinsKey = pinsKeyFor(at.objectId, op);
  const chord = state.stepTolerance;
  const mine = S.ticket;
  S.busy = true;
  setSplitPrintWaiting(true);
  syncUndo();
  readout("Cutting the part…");
  const body = await treeCall(at.key, parent, applyRequest(at.key, parent, node, op, chord, null, keys, pinsKey));
  if (mine === S.ticket) S.busy = false;
  setSplitPrintWaiting(false);
  syncUndo();
  const latest = modelTrees.get(at.key);
  if (mine !== S.ticket || state.stage !== "model" || !latest) return;
  if (failed(at.key, body)) return;
  const parsed = decodeSolid(body);
  const pieces = readPieces(body.pieces);
  const pins = readPins(body.pins);
  if (typeof parsed === "string" || typeof pieces === "string" || typeof pins === "string") {
    void dropInEngine(at.key, node);
    for (const key of [...keys, ...(pinsKey ? [pinsKey] : [])]) void post({ call: "close", key });
    readout(typeof parsed === "string" ? parsed : typeof pieces === "string" ? pieces : (pins as string));
    return;
  }
  const storedOp = isOp(body.op) ? body.op : op;
  // --- D12. An export target's pieces are held in Model with their trees and never go on the plate.
  const held = exportsPieces(op);
  const placed = putPieces(at, node, parsed, pieces.map((piece) => (piece ? { ...piece, was: null } : null)), op.arrange !== false && !held, held, pins ? { ...pins, was: null } : null, storedOp as PartitionModelOp);
  modelTrees.set(at.key, withChild(modelTrees.get(at.key) ?? latest, parent, { id: node, op: storedOp, label: opLabel(storedOp, placed.keys.length + 1), fingerprint: parsed.fingerprint, pieces: placed.keys, ...(placed.pins ? { pins: placed.pins } : {}) }));
  keepSolid(at.key, node, chord, parsed);
  S.open = { ...at, solid: parsed };
  const sentences = kernelNotes(body);
  splitPrintApplied();
  const where = held ? heldSentence(targetName(storedOp as PartitionModelOp)) : laidSentence(op, placed.fresh.length);
  present(parsed, `${opLabel(storedOp, placed.keys.length + 1)}. ${about(parsed)} ${where}${sentences.map((note) => ` ${note}`).join("")}${placed.notes.map((note) => ` ${note}`).join("")}${placed.notes.map((note) => ` ${note}`).join("")}${leavingNotes(false)}`);
  if (held) showSplitPrintDone(heldResult(storedOp as PartitionModelOp, placed.keys.length + 1, sentences));
}

/** The sentences the kernel adds to a cut's reply, such as a part number with no room. */
export function kernelNotes(body: Body): string[] {
  return Array.isArray(body.notes) ? body.notes.filter((note): note is string => typeof note === "string") : [];
}

/** What the card says an export Apply left in Model. */
function heldResult(op: PartitionModelOp, count: number, notes: string[]): SplitPrintDone {
  const pins = op.cuts.some((cut) => (cut.connectors?.placed ?? []).some((row) => row.type === "dowel"));
  const source = state.mesh?.name ?? "part";
  return { printer: targetName(op), names: pieceNames(source, count), ...(pins ? { pins: pinsName(source) } : {}), notes };
}

/** What the readout says of an export target's pieces: in Model, off the plate, until they are exported. */
function heldSentence(printer: string): string {
  return `The pieces are for the ${printer}, which this app does not slice for: they stay in Model, off the plate. Export… saves them.`;
}

/** The cut for an export target being cut again, by tree and step, so a jump and an Export… on it share one cut. */
const cuttingAgain = new Map<string, Promise<void>>();

/**
 * --- D12. The open step's split to print for an export target, when pieces of it are not held (a project 3.8.0 saved
 * kept the cut but not its pieces): those pieces are cut again from the stored op on a spare step, as the MCP's export
 * does (`partitionPieces`), and held as Apply holds them. The plate and Undo do not change; the next save keeps them.
 */
export function cutHeldAgain(mine: number): Promise<void> {
  const at = S.open;
  const tree = treeOf(at);
  const node = tree ? [...pathTo(tree, tree.current)].reverse().find((id) => exportsPieces(tree.nodes.get(id)?.op)) : undefined;
  const step = node == null ? undefined : tree?.nodes.get(node);
  if (!at || !tree || node == null || !step?.pieces || step.op?.kind !== "partition" || step.parent === null) return Promise.resolve();
  const name = `${at.key}#${node}`;
  const running = cuttingAgain.get(name);
  if (running) return running;
  const missing = step.pieces.map((key) => !key || !modelTrees.has(key));
  const { op, parent } = step;
  // The pins of a dowelled cut are made again with the pieces, under a key of their own.
  const pinsGone = !!pinsKeyFor(at.objectId, op) && (!step.pins || !modelTrees.has(step.pins));
  if ((!missing.some(Boolean) && !pinsGone) || S.busy) return Promise.resolve();
  const known = step.pieces;
  const run = (async () => {
    const [reserved, spare] = reserveId(tree);
    modelTrees.set(at.key, reserved);
    const fresh = missing.map((gone) => (gone ? freshTreeKey(`${at.objectId}-part`) : null));
    const pinsKey = pinsGone ? pinsKeyFor(at.objectId, op) : null;
    S.busy = true;
    syncUndo();
    readout("Cutting the pieces again…");
    const body = await treeCall(at.key, parent, applyRequest(at.key, parent, spare, op, state.stepTolerance, null, fresh, pinsKey));
    void dropInEngine(at.key, spare);
    if (mine === S.ticket) S.busy = false;
    syncUndo();
    const pieces = readPieces(body.pieces);
    const pins = pinsKey ? readPins(body.pins) : null;
    const shown = S.open;
    const dropFresh = () => {
      for (const key of [...fresh, pinsKey]) if (key) void post({ call: "close", key });
    };
    if (mine !== S.ticket || state.stage !== "model" || shown?.key !== at.key || !modelTrees.has(at.key)) {
      dropFresh();
      return;
    }
    const problem = text(body.error) ? sentence(plainModelError(text(body.error))) : typeof pieces === "string" ? pieces : typeof pins === "string" ? pins : pieces.length !== known.length ? "This cut no longer makes the pieces its step names. Edit the cut and Update." : "";
    if (problem || typeof pieces === "string" || typeof pins === "string") {
      dropFresh();
      readout(`${problem} Only Part 1 is in Model.`);
      return;
    }
    const placed = putPieces(shown, node, shown.solid, pieces.map((piece, i) => (piece && fresh[i] ? { ...piece, was: null } : null)), false, true, pins ? { ...pins, was: null } : null);
    modelTrees.set(at.key, withNode(modelTrees.get(at.key)!, node, { pieces: known.map((key, i) => placed.keys[i] ?? key), ...(placed.pins ? { pins: placed.pins } : {}) }));
    refreshModelContext();
    readout(`${about(shown.solid)} This project was saved without the pieces of its cut for the ${targetName(op)}, so they were cut again from the step. Saving keeps them.`);
  })().finally(() => cuttingAgain.delete(name));
  cuttingAgain.set(name, run);
  return run;
}

/** What the readout says of the new pieces on the plate. */
function laidSentence(op: PartitionModelOp, fresh: number): string {
  if (fresh === 0) return "";
  if (op.arrange === false) return "On the plate the new pieces share one spot: Arrange lays them side by side.";
  return fresh === 1 ? "The new piece is laid out on the bed, around the other objects." : "The new pieces are laid out on the bed, around the other objects.";
}

/**
 * The pieces on the plate, in one Prepare step: a piece with `was`, an object that held the same part number before an
 * edit, takes the new mesh and tree in place; any other is a new object in the part's place, and with `layout` the new
 * ones are laid out around every object already there, the part's own first piece where its new mesh will land. The
 * keys each piece's tree has, in order, and the new objects' ids. With `held`, an export target's (D12), no piece goes on
 * the plate: each is the root of a tree of its own, held in Model, and the plate does not change.
 */
function putPieces(at: Opened, node: NodeId, first: ParsedSolid, pieces: ({ key: string; solid: ParsedSolid; was: string | null; tree?: ModelTree; shown?: ParsedSolid } | null)[], layout: boolean, held = false, pins: { key: string; solid: ParsedSolid; was: string | null } | null = null, op?: PartitionModelOp): { keys: (string | null)[]; fresh: string[]; pins: string | null; notes: string[] } {
  const keys: (string | null)[] = [];
  const fresh: string[] = [];
  if (!state.mesh) return { keys: pieces.map(() => null), fresh, pins: null, notes: [] };
  if (!held) {
    noteEdit();
    syncPlateFromState();
  }
  const stem = stlName(state.mesh.name).replace(/\.stl$/i, "");
  pieces.forEach((piece, at2) => {
    if (!piece) {
      keys.push(null);
      return;
    }
    const index = at2 + 2;
    const shown = piece.shown ?? piece.solid;
    const owner = piece.was ? state.plate.objects.find((obj) => obj.modelTree === piece.was) : undefined;
    const mesh = meshOf(shown, `${owner ? stlName(owner.name).replace(/\.stl$/i, "") : `${stem} part ${index}`}.stl`);
    let name = owner?.name ?? null;
    if (held) name = mesh.name;
    else if (owner) state.plate = withPieceMesh(state.plate, owner.id, { fileName: mesh.name, bytes: mesh.bytes, sourcePos: new Float32Array(mesh.sourcePos) }, piece.key);
    else name = placePiece(piece.key, mesh);
    if (!name) {
      keys.push(null);
      return;
    }
    const root = newTree(piece.key, { kind: "piece", tree: at.key, node, index }, `Part ${index}`, piece.solid.fingerprint);
    const tree = piece.tree ?? root;
    // A piece's tree is saved from its root's STEP, so the root keeps its mesh when later steps were replayed on it.
    const rooted = tree.current === ROOT ? tree : withNode(tree, ROOT, { mesh: meshOf(piece.solid, mesh.name) });
    modelTrees.set(piece.key, { ...withNode(rooted, tree.current, { mesh }), committed: tree.current });
    keepSolid(piece.key, tree.current, state.stepTolerance, shown);
    keys.push(piece.key);
    if (!owner && !held) fresh.push(state.plate.objects.find((obj) => obj.modelTree === piece.key)!.id);
  });
  const pinned = pins ? putPinsObject(at, node, pins, stem, held, fresh) : null;
  if (held) return { keys, fresh, pins: pinned, notes: [] };
  // --- Milestone 7. Joint down turns its pieces before the lay out, so the layout is of the turned footprints.
  const turned = op ? orientPieces(at.objectId, first.positions, keys, pinned, op) : { turned: [] as string[], notes: [] as string[] };
  const moving = [...new Set([...fresh, ...turned.turned])];
  if (layout && moving.length > 0) layOutPieces(at.objectId, first, moving);
  // --- Assemblies M8 (D7). The pieces and the pins sit where they were cut: with the card's Group the parts, one
  // assembly with the part as its root. A cut edited later seats its new pieces in the same one.
  if (op && document.querySelector<HTMLInputElement>("#modelPartGroup")?.checked !== false) {
    const made = new Set([...keys, pinned].filter((key): key is string => !!key));
    const ids = state.plate.objects.filter((obj) => obj.modelTree && made.has(obj.modelTree)).map((obj) => obj.id);
    const part = state.plate.objects.find((obj) => obj.id === at.objectId);
    groupAsBuilt(at.objectId, ids, stlName(part?.name ?? stem).replace(/\.stl$/i, ""));
  }
  applySelectedToState(state.plate);
  place();
  flushEdit();
  markModelEdit();
  return { keys, fresh, pins: pinned, notes: turned.notes };
}

/** A belt printer's length is unbounded (decision 11): a lay out stacks the pieces along it, so none goes off the bed. */
const BELT_LENGTH_MM = 1e6;

/** Whether the plate's printer is a belt printer. */
function onBelt(): boolean {
  return selection(loadMachineLibrary())?.printer.kind === "belt";
}

/** Each plate object Joint down turned, by id, and the orientation it had before: Keep puts it back. */
const keptOrients = new Map<string, Mat3>();

/**
 * --- Milestone 7 (plan D4, section 10). The orientation each piece of a split to print has on the plate: Keep is the part's
 * own, from before any Joint down; Joint down turns the piece so its larger cut face lies on the bed (`jointDown`), its long
 * way along X, or along the belt on a belt printer. The pins object always stands in the part's own orientation, so it stays
 * upright. Part 1 is the part itself. The ids of what turned, and a sentence for each piece that joints down.
 */
function orientPieces(partId: string, first: Float32Array, keys: readonly (string | null)[], pins: string | null, op: PartitionModelOp): { turned: string[]; notes: string[] } {
  const out = { turned: [] as string[], notes: [] as string[] };
  if (exportsPieces(op)) return out;
  const part = state.plate.objects.find((obj) => obj.id === partId);
  if (!part) return out;
  const base = keptOrients.get(part.id) ?? part.orient;
  const planes = jointPlanes(op.cuts);
  const belt = onBelt();
  const rows: { id: string; positions: Float32Array; index: number | null }[] = [{ id: part.id, positions: first, index: 0 }];
  keys.forEach((key, at) => {
    const obj = key ? state.plate.objects.find((row) => row.modelTree === key) : undefined;
    if (obj) rows.push({ id: obj.id, positions: obj.sourcePos, index: at + 1 });
  });
  const pinsObj = pins ? state.plate.objects.find((row) => row.modelTree === pins) : undefined;
  if (pinsObj) rows.push({ id: pinsObj.id, positions: pinsObj.sourcePos, index: null });
  const next = new Map<string, Mat3>();
  const turnedPart = keptOrients.has(part.id);
  for (const row of rows) {
    const obj = state.plate.objects.find((one) => one.id === row.id)!;
    // What Keep means for this object: the orientation from before Joint down, else its own, which a piece copied from a
    // part that is joint down gets from the part's own.
    const own = keptOrients.get(obj.id) ?? (obj.id !== part.id && turnedPart && sameMat(obj.orient, part.orient) ? base : obj.orient);
    const wanted = row.index === null ? "keep" : choiceAt(op.orient, row.index);
    let orient: Mat3 = own;
    if (wanted === "joint") {
      const joint = jointDown(row.positions, planes, belt);
      if (!joint) out.notes.push(noJointSentence(row.index! + 1, op.cuts));
      else {
        orient = joint.orient;
        keptOrients.set(obj.id, own);
        out.notes.push(`Part ${row.index! + 1} is joint down on cut ${joint.face.cut + 1}, its ${joint.other ? "larger" : "only"} cut face, ${mmText(joint.face.area)} mm².`);
      }
    }
    if (orient === own) keptOrients.delete(obj.id);
    if (!sameMat(orient, obj.orient)) {
      next.set(obj.id, orient);
      out.turned.push(obj.id);
    }
  }
  if (next.size > 0) state.plate = { ...state.plate, objects: state.plate.objects.map((obj) => (next.has(obj.id) ? { ...obj, orient: [...next.get(obj.id)!] as Mat3 } : obj)) };
  return out;
}

/**
 * --- Milestone 5. The pins of a dowelled cut, in the same Prepare step as the pieces (plan section 10): on the plate's
 * printer one more plate object in the part's orientation, which stands each pin along the plate's Z, laid out with
 * the new pieces; for an export target a tree held in Model, exported as `<source>-pins`. The object that held the pins
 * before an Update takes the new ones in place. Their tree's key, or null.
 */
function putPinsObject(at: Opened, node: NodeId, pins: { key: string; solid: ParsedSolid; was: string | null }, stem: string, held: boolean, fresh: string[]): string | null {
  const owner = pins.was ? state.plate.objects.find((obj) => obj.modelTree === pins.was) : undefined;
  const mesh = meshOf(pins.solid, `${owner ? stlName(owner.name).replace(/\.stl$/i, "") : `${stem} pins`}.stl`);
  let name: string | null = owner?.name ?? null;
  if (held) name = mesh.name;
  else if (owner) state.plate = withPieceMesh(state.plate, owner.id, { fileName: mesh.name, bytes: mesh.bytes, sourcePos: new Float32Array(mesh.sourcePos) }, pins.key);
  else name = placePiece(pins.key, mesh);
  if (!name) return null;
  const root = newTree(pins.key, { kind: "piece", tree: at.key, node, pins: true }, "Pins", pins.solid.fingerprint);
  modelTrees.set(pins.key, { ...withNode(root, ROOT, { mesh }), committed: ROOT });
  keepSolid(pins.key, ROOT, state.stepTolerance, pins.solid);
  if (!owner && !held) fresh.push(state.plate.objects.find((obj) => obj.modelTree === pins.key)!.id);
  return pins.key;
}

/**
 * Lay out (plan section 10): the new pieces only, around the objects already on the plate, which stay; the part itself
 * counts where its first piece will land once the plate takes it.
 */
function layOutPieces(partId: string, first: ParsedSolid, fresh: readonly string[]) {
  const objects = state.plate.objects.map((obj) => (obj.id === partId ? { ...obj, sourcePos: first.positions } : obj));
  const moving = new Set(fresh);
  const keep = new Set(objects.filter((obj) => !moving.has(obj.id)).map((obj) => obj.id));
  const laid = new Map(arrangedObjects(objects, state.profile.bedX, onBelt() ? BELT_LENGTH_MM : state.profile.bedY, undefined, keep).map((obj) => [obj.id, obj]));
  state.plate = { ...state.plate, objects: state.plate.objects.map((obj) => (moving.has(obj.id) ? { ...obj, centered: laid.get(obj.id)!.centered, offset: { ...laid.get(obj.id)!.offset } } : obj)) };
}

/**
 * --- D9. A rebuilt piece's later steps, replayed on the new piece under its new key: those on the way to the step its
 * object showed, and a branch an earlier rebuild kept broken. A step that no longer builds is kept, broken, with the rest
 * under it, and its row says why; the piece on the plate is the last step that built. The tree, the solid it shows, and
 * a sentence when a step broke.
 */
async function replayPiece(key: string, parentKey: string, node: NodeId, index: number, solid: ParsedSolid, before: ModelTree | undefined, name: string): Promise<{ tree: ModelTree; shown: ParsedSolid; note: string | null }> {
  const root = newTree(key, { kind: "piece", tree: parentKey, node, index }, name, solid.fingerprint);
  modelTrees.set(key, withNode(root, ROOT, {}));
  const later = before ? keptSteps(before) : [];
  if (!before || later.length === 0) return { tree: root, shown: solid, note: null };
  const ids = later.map((_, at) => at + 1);
  const renamed = stepIds(later, ids);
  const ops = later.map((id) => renumberedSteps(before.nodes.get(id)!.op!, renamed));
  const replay = ops.slice(1).map((op, at) => ({ id: ids[at + 1]!, op }));
  const body = await treeCall(key, ROOT, { ...editRequest(key, ROOT, ids[0]!, ops[0]!, replay, state.stepTolerance), keepBroken: true });
  const error = text(body.error);
  const parsed = error ? null : decodeSolid(body);
  const built = builtSteps(body.built);
  if (!parsed || typeof parsed === "string" || !built) return { tree: root, shown: solid, note: `${name}'s later steps did not build on the new cut (${sentence(plainModelError(error || DAMAGED))}), so it is the new piece as cut.` };
  const broken = brokenStep(body.broken);
  const steps: ForkStep[] = ids.map((id, at) => {
    const old = before.nodes.get(later[at]!);
    return {
      id,
      op: keepSketch(built.get(id)?.op ?? ops[at]!, ops[at]!),
      fingerprint: built.get(id)?.fingerprint ?? null,
      ...(old?.name ? { name: old.name } : {}),
      ...(broken?.id === id ? { broken: broken.error } : {}),
    };
  });
  const tree = forked(root, ROOT, steps, parsed.id);
  const failure = broken ? tree.nodes.get(broken.id) : undefined;
  const note = broken && failure ? `${name}'s step ${pathTo(tree, broken.id).length - 1}, “${stepLabel(failure)}”, did not build on the new cut: ${sentence(plainModelError(broken.error))} It stays in that piece's history.` : null;
  return { tree, shown: parsed, note };
}

/**
 * Update of a split to print from its card (D9): the step built again as a sibling, the part's later steps replayed on
 * it, and every piece of it rebuilt in the same Prepare step. The object of each part number that is still there takes
 * its new piece, with its own later steps replayed; a new part number is a new object, laid out; a part number gone
 * takes its object off the plate.
 */
export async function updateSplitPrint(run: Editing, typed: PartitionOp) {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || at.key !== run.target || S.busy || S.jumping || !state.mesh) return;
  if (at.objectId !== state.plate.selectedId) {
    followSelection();
    return;
  }
  const stored = splitStored(typed);
  if (!stored) return;
  if ("reason" in stored) {
    readout(stored.reason);
    return;
  }
  const op = stored.op;
  const olds = [run.node, ...run.replay].map((id) => tree.nodes.get(id));
  if (olds.some((old) => !old)) {
    readout("This step is no longer in the history.");
    return;
  }
  let reserved = tree;
  const ids: NodeId[] = [];
  while (ids.length < olds.length) {
    const [next, id] = reserveId(reserved);
    reserved = next;
    ids.push(id);
  }
  modelTrees.set(at.key, reserved);
  const renamed = stepIds([run.node, ...run.replay], ids);
  const replay = run.replay.map((id, i) => ({ id: ids[i + 1]!, op: renumberedSteps(tree.nodes.get(id)!.op!, renamed) }));
  const keys = partKeys(at.objectId, op);
  const pinsKey = pinsKeyFor(at.objectId, op);
  const held = exportsPieces(op);
  const level: EditLevel = { key: at.key, parent: run.parent, node: ids[0]!, op, replay, old: [run.node, ...run.replay] };
  const chord = state.stepTolerance;
  const mine = S.ticket;
  S.busy = true;
  setSplitPrintWaiting(true);
  syncUndo();
  readout(ids.length === 1 ? "Cutting the part again…" : `Rebuilding ${ids.length} steps…`);
  const body = await treeCall(at.key, run.parent, crossEditRequest([level], chord, keys, pinsKey));
  const pieces = readPieces(body.pieces);
  const pins = readPins(body.pins);
  const old = tree.nodes.get(run.node)?.pieces ?? [];
  const oldPins = tree.nodes.get(run.node)?.pins ?? null;
  // Each part number still there replays its own later steps on its new piece, before the plate changes at all.
  const rebuilt: ({ key: string; solid: ParsedSolid; was: string | null; tree?: ModelTree; shown?: ParsedSolid } | null)[] = [];
  const notes: string[] = [];
  if (typeof body.error !== "string" && typeof pieces !== "string") {
    for (const [i, piece] of pieces.entries()) {
      if (!piece) {
        rebuilt.push(null);
        continue;
      }
      const was = old[i] ?? null;
      const owner = was ? state.plate.objects.find((obj) => obj.modelTree === was) : undefined;
      if (!owner || held) {
        rebuilt.push({ ...piece, was: null });
        continue;
      }
      const replayed = await replayPiece(piece.key, at.key, ids[0]!, i + 2, piece.solid, modelTrees.get(was!), owner.name);
      if (replayed.note) notes.push(replayed.note);
      rebuilt.push({ ...piece, was, tree: replayed.tree, shown: replayed.shown });
    }
  }
  if (mine === S.ticket) S.busy = false;
  setSplitPrintWaiting(false);
  syncUndo();
  const latest = modelTrees.get(at.key);
  if (S.editing !== run || mine !== S.ticket || state.stage !== "model" || !latest) {
    if (typeof body.error !== "string") void dropInEngine(at.key, ids[0]!);
    return;
  }
  if (failed(at.key, body)) return;
  const parsed = decodeSolid(body);
  const built = builtSteps(body.built);
  if (typeof parsed === "string" || typeof pieces === "string" || typeof pins === "string" || !built?.has(parsed.id)) {
    void dropInEngine(at.key, ids[0]!);
    readout(typeof parsed === "string" ? parsed : typeof pieces === "string" ? pieces : typeof pins === "string" ? pins : DAMAGED);
    return;
  }
  const broken = brokenStep(body.broken);
  const placed = putPieces(at, ids[0]!, parsed, rebuilt, op.arrange !== false && !held, held, pins ? { ...pins, was: held ? null : oldPins } : null, op);
  // A part number the new cut no longer makes takes its object off the plate, and every one does when the cut is now for
  // an export target; so do the pins when the new cut has none, or is for an export target.
  const leaving = [...(held ? old : old.slice(pieces.length)), ...(oldPins && (held || !pins) ? [oldPins] : [])];
  const gone = leaving.flatMap((key) => state.plate.objects.filter((obj) => key && obj.modelTree === key).map((obj) => obj.id));
  if (gone.length > 0) {
    noteEdit();
    syncPlateFromState();
    for (const id of gone) state.plate = withoutObject(state.plate, id);
    applySelectedToState(state.plate);
    place();
    flushEdit();
    markModelEdit();
  }
  const steps = forkSteps(latest, level, built, broken);
  steps[0] = { ...steps[0]!, pieces: placed.keys, ...(placed.pins ? { pins: placed.pins } : {}) };
  const next = forked(latest, run.parent, steps, parsed.id);
  modelTrees.set(at.key, next);
  keepSolid(at.key, parsed.id, chord, parsed);
  S.open = { ...at, solid: parsed };
  S.editing = null;
  S.editBack = { key: at.key, tip: parsed.id, back: run.from, undone: false };
  const sentences = kernelNotes(body);
  splitPrintApplied();
  const label = (id: NodeId) => stepLabel(next.nodes.get(id)!);
  const after = replay.length === 0 ? "" : replay.length === 1 ? " and rebuilt the step after it" : ` and rebuilt ${replay.length} steps after it`;
  const failure = broken ? ` Step ${pathTo(next, broken.id).length - 1}, “${label(broken.id)}”, could not be rebuilt: ${sentence(broken.error)}` : "";
  const left = gone.length === 0 ? "" : gone.length === 1 ? " One piece left the plate." : ` ${gone.length} pieces left the plate.`;
  present(parsed, [`Updated “${label(ids[0]!)}”${after}. ${about(parsed)}${failure} ${held ? heldSentence(targetName(op)) : laidSentence(op, placed.fresh.length)}${left}`.replace(/\s+/g, " ").trim(), ...sentences, ...placed.notes, ...notes].join(" "));
  if (held) showSplitPrintDone(heldResult(next.nodes.get(ids[0]!)!.op as PartitionModelOp, placed.keys.length + 1, sentences));
}

// --- end Split to print ---
