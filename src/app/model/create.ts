/** Creating a new solid: the primitive, the feature solid, its placement, and the empty state. */
import { boundsOf, encodeStl, settleBy, type Bounds } from "../../mesh-place";
import {
  boxUnder,
  inversePose,
  isIdentity,
  newSolidPose,
  fromSolidOp,
  toSolidOp,
  type Affine,
} from "../../model-space";
import { primitiveBounds, primitiveName, rootSpec, type PrimitiveSpec } from "../../model-primitive";
import { unionBox } from "../../measure";
import { decodeSolid, type ParsedSolid } from "../../model-reply";
import {
  ROOT,
  newTree,
  rootLabel,
  featureObjectName,
  sweepObjectName,
  withNode,
  type FeatureOp,
  type ModelOp,
  type ModelRoot,
  type NodeId,
  type PlateMesh,
} from "../../model-tree";
import { newSolidRequest, openRequest } from "../../model-request";
import { closeModelTool, fieldPrimitive, panelExprs, openModelTool, refreshModelCheck } from "../../ui/model-chrome";
import { addedSolid, addedSplit, freshPlateId, meshToModel, meshTokenOf, setMeshSeat } from "../../plate";
import { livePlate, place } from "../files";
import { flushEdit, markModelEdit, noteEdit } from "../history";
import { fx } from "../fx";
import { freshTreeKey, modelTrees } from "../model-trees";
import { applySelectedToState, syncPlateFromState } from "../plate-sync";
import { state } from "../state";
import { S } from "./shared";
import { keepSolid } from "./apply";
import { commitModel } from "./commit";
import { post } from "./engine";
import { stlName } from "./geometry";
import { noteMadeObject } from "./history";
import { about, readout } from "./pick";
import { forgetPlaceSteps } from "./place";
import type { Opened } from "./shared";
import { syncUndo } from "./undo";
import { boxOf, openBox, openPose, openQueuedCheck, present, viewFrame } from "./view";
import { forgetWorkplaneSteps } from "./workplane";

/**
 * New solid: the primitive the panel describes becomes a plate object of its own, the root of a tree of its own,
 * so no file is read. It stands at the origin of an empty model space, else beside the other objects, goes on the
 * plate as an added file does, and opens at once. Creating it is one Prepare step, which Prepare undo takes back.
 */
export async function createSolid() {
  if (S.busy || S.jumping || state.stage !== "model") return;
  const typed = fieldPrimitive();
  const root = rootSpec(typed);
  const exprs = panelExprs();
  const from: ModelRoot = exprs ? { kind: "primitive", solid: root, exprs } : { kind: "primitive", solid: root };
  await finishNewSolid({
    request: (key, chord) => newSolidRequest(key, typed, chord),
    name: (names) => primitiveName(names, typed.primitive),
    root: from,
    // The primitive's box, from its numbers, as before the mesh is read.
    bounds: () => primitiveBounds(root),
  });
}

/**
 * A new plate object whose root is an extrude, a revolve, or a loft, with no primitive under it (K2). The sketch
 * editor (F1) calls this for "New object". Cut and intersect are refused: the feature is the solid.
 */
export async function createFeatureSolid(op: FeatureOp, pose?: Affine): Promise<boolean> {
  if (S.busy || S.jumping || state.stage !== "model") return false;
  if (op.op !== "fuse") {
    const noun = op.kind === "extrude" ? "extrude" : op.kind === "revolve" ? "revolve" : "loft";
    readout(`A new solid is the ${noun} itself. Cut and intersect need a part that is already there.`);
    return false;
  }
  const from: ModelRoot = { kind: "feature", op };
  return finishNewSolid({
    request: (key, chord) => openRequest(key, from, chord),
    name: (names) => (op.kind === "loft" && op.drawing?.sweep ? sweepObjectName(names) : featureObjectName(names, op.kind)),
    root: from,
    bounds: (positions) => boundsOf(positions),
    ...(pose ? { pose } : {}),
  });
}

/** A new plate object from an `open` that is its own root: a primitive, or a sketch feature. */
async function finishNewSolid(made: {
  request: (key: string, chord: number) => ReturnType<typeof newSolidRequest>;
  name: (names: Iterable<string>) => string;
  root: Exclude<ModelRoot, { kind: "piece" }>;
  bounds: (positions: Float32Array) => Bounds;
  /** Where the solid's own frame sits in model space. Absent stands it beside the other objects. */
  pose?: Affine;
}): Promise<boolean> {
  const id = freshPlateId();
  const key = freshTreeKey(id);
  const chord = state.stepTolerance;
  const mine = S.ticket;
  S.busy = true;
  syncUndo();
  const feature = made.root.kind === "feature" ? made.root.op : null;
  readout(feature?.kind === "loft" ? (feature.drawing?.sweep ? "Sweeping…" : "Lofting…") : "Building the solid…");
  const body = await post(made.request(key, chord));
  if (mine === S.ticket) S.busy = false;
  syncUndo();
  const parsed = decodeSolid(body);
  if (mine !== S.ticket || state.stage !== "model" || typeof parsed === "string") {
    // An open the engine answered left a tree there.
    if (typeof body.error !== "string") void post({ call: "close", key });
    if (mine === S.ticket && state.stage === "model" && typeof parsed === "string") readout(parsed);
    return false;
  }
  // The open object's edits reach the plate first. The new object then joins the visit's Prepare step, as an edit does.
  const others = plateBoxes();
  commitModel();
  forgetPlaceSteps();
  forgetWorkplaneSteps();
  flushEdit();
  noteEdit();
  syncPlateFromState();
  const first = state.plate.objects.length === 0;
  const name = made.name(state.plate.objects.map((obj) => obj.name));
  const positions = new Float32Array(parsed.positions);
  const seat = settleBy(positions);
  const fileName = `${name}.stl`;
  const bytes = encodeStl(positions, fileName);
  setMeshSeat(bytes, seat);
  const mesh: PlateMesh = { name: fileName, bytes, sourcePos: positions, token: meshTokenOf(bytes) };
  const pose = made.pose ?? newSolidPose(others, made.bounds(positions));
  const { bedX, bedY } = state.profile;
  state.plate = addedSolid(state.plate, { name, fileName, bytes, sourcePos: positions, stepTolerance: chord }, id, key, pose, bedX, bedY);
  applySelectedToState(state.plate);
  modelTrees.set(key, withNode(newTree(key, made.root, rootLabel(made.root, name), parsed.fingerprint), ROOT, { mesh }));
  keepSolid(key, ROOT, chord, parsed);
  place(first ? "load" : "transform");
  flushEdit();
  markModelEdit();
  noteMadeObject(id);
  S.ticket += 1;
  S.picks = [];
  S.parked = null;
  S.shownFor = id;
  closeModelTool();
  S.open = { objectId: id, key, solid: parsed };
  present(parsed, `${name}. ${about(parsed)} Pick a face or an edge.`);
  return true;
}

/** Where New solid puts `spec` in model space: its root, standing at the origin or beside every object in `others`. */
function newSolidAt(spec: PrimitiveSpec, others = plateBoxes()): PrimitiveSpec {
  const root = rootSpec(spec);
  if (S.editing?.op.kind === "root") {
    // An edited root stands where the part's root stands: in its own frame, at the part's pose.
    const { kind: _kind, op: _op, ...placed } = fromSolidOp({ kind: "boolean", op: "fuse", ...root }, openPose()) as Extract<ModelOp, { kind: "boolean" }>;
    return placed;
  }
  const { t } = newSolidPose(others, primitiveBounds(root));
  return { ...root, origin: [root.origin[0] + t[0], root.origin[1] + t[1], root.origin[2] + t[2]] };
}

/** --- Assemblies M10. Where New solid puts `spec`, drawn in the view: turned with the others when a part is open in its own frame. */
export function newSolidInView(spec: PrimitiveSpec, others = plateBoxes()): PrimitiveSpec {
  const placed = newSolidAt(spec, others);
  const frame = viewFrame();
  if (S.editing?.op.kind === "root" || isIdentity(frame)) return placed;
  const { kind: _kind, op: _op, ...shown } = toSolidOp({ kind: "boolean", op: "fuse", ...placed }, inversePose(frame)) as Extract<ModelOp, { kind: "boolean" }>;
  return shown;
}

/**
 * Every plate object's box in model space, the open one as the view shows it: an edit not yet on the plate can
 * have grown it. Each mesh's own box is read once.
 */
export function plateBoxes(): Bounds[] {
  const box = openBox();
  const frame = viewFrame();
  const shown = box && !isIdentity(frame) ? boxUnder(box, inversePose(frame)) : box;
  return livePlate().map((obj) => (shown && obj.id === S.open?.objectId ? shown : boxUnder(boxOf(obj.sourcePos), meshToModel(obj))));
}

/** No solid to show: the view says so plainly, with New solid at hand, and shows whatever model space holds. */
export function showEmpty(mesh: boolean) {
  readout("");
  const card = document.querySelector<HTMLElement>("#modelEmpty");
  const title = document.querySelector("#modelEmptyTitle");
  const text = document.querySelector("#modelEmptyText");
  if (title) title.textContent = mesh ? "This object is a mesh" : "No solid open";
  if (text) text.textContent = mesh ? "Model edits STEP solids. Start a new solid from a primitive, or add a STEP file." : "Start a solid from a primitive, or open a STEP file.";
  const fileButton = document.querySelector("#modelEmptyOpen");
  if (fileButton) fileButton.textContent = state.plate.objects.length > 0 ? "Add a file" : "Open a file";
  if (card) card.hidden = false;
  S.framedFor = null;
  const boxes = plateBoxes();
  if (boxes.length > 0) fx.model?.frame(unionBox(boxes)!);
  // --- A7 model check ---
  if (S.checkQueued) openQueuedCheck();
  else if (openModelTool() === "check") refreshModelCheck();
}

export function hideEmpty() {
  document.querySelector<HTMLElement>("#modelEmpty")?.toggleAttribute("hidden", true);
}

/** The split-off piece goes on the plate at once, in its parent's place, as the root of its own tree. */
export function addPiece(at: Opened, other: ParsedSolid, key: string, split: NodeId): boolean {
  if (!state.mesh) return false;
  noteEdit();
  syncPlateFromState();
  const positions = new Float32Array(other.positions);
  const seat = settleBy(positions);
  const fileName = `${stlName(state.mesh.name).replace(/\.stl$/i, "")} split.stl`;
  const bytes = encodeStl(positions, fileName);
  setMeshSeat(bytes, seat);
  const mesh: PlateMesh = { name: fileName, bytes, sourcePos: positions, token: meshTokenOf(bytes) };
  const name = placePiece(key, mesh);
  if (!name) {
    flushEdit();
    return false;
  }
  modelTrees.set(key, withNode(newTree(key, { kind: "piece", tree: at.key, node: split }, name, other.fingerprint), ROOT, { mesh }));
  keepSolid(key, ROOT, state.stepTolerance, other);
  place();
  flushEdit();
  markModelEdit();
  return true;
}

/** A split piece with `mesh` joins the plate in the selected object's place, carrying its tree's key. Its plate name, or null. */
export function placePiece(key: string, mesh: PlateMesh): string | null {
  const selected = state.plate.selectedId;
  const prev = new Set(state.plate.objects.map((obj) => obj.id));
  const next = selected
    ? addedSplit(state.plate, { name: mesh.name.replace(/\.stl$/i, ""), fileName: mesh.name, bytes: mesh.bytes, sourcePos: new Float32Array(mesh.sourcePos), stepTolerance: state.stepTolerance })
    : null;
  const piece = next?.objects.find((obj) => !prev.has(obj.id));
  if (!next || !selected || !piece) return null;
  const step = mesh.step ? { brep: mesh.step } : {};
  state.plate = { objects: next.objects.map((obj) => (obj.id === piece.id ? { ...obj, ...step, modelTree: key } : obj)), selectedId: selected };
  applySelectedToState(state.plate);
  return piece.name;
}
