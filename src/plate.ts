/**
 * Multi-object plate: the object list, selection, placement, axis-aligned
 * bounds, box overlap, arrange, `.lime` save, and undo. Overlap is the
 * overlap of two axis-aligned boxes in XY, not a mesh intersection.
 *
 * A plate with one object and no per-object settings slices with today's
 * body: `filename`, `dataB64`, and `pose`. Any other plate sends `objects`,
 * each with its own mesh and pose, and the engine slices each in its own
 * part frame (`docs/multi-object-and-support-painting.md`).
 * A one-object project with no per-object settings is written as version 1
 * and omits `objects`.
 * Adding a file builds a new object and parks it clear of the others.
 * A split half stays in the selected object's place instead.
 * Duplicate copies the selected object only.
 */
import type { SavedTree } from "./model-tree-file.ts";
import { IDENTITY_POSE, boxUnder, duplicatePose, inversePose, isIdentity, seatLift, thenPose, type Affine } from "./model-space.ts";
import type { EditEntry } from "./support-edit-list.ts";
import {
  dropEmptyReinforce,
  normalInfillDensity,
  reinforcementRequestFields,
  type ReinforceRegion,
  type WireReinforceRegion,
} from "./reinforcement.ts";
import { seamRequestFields, type SeamDisk, type SeamWireDisk } from "./seam-paint.ts";
import { paintRequestFields, type PaintDisk, type WireDisk } from "./support-paint.ts";
import {
  boundsOf,
  centeringShift,
  encodeStl,
  ID_MATRIX,
  placeMesh,
  type Bounds,
  type Mat3,
  type MeshShift,
  type RigidPose,
} from "./mesh-place.ts";

/** Id `migrations[1]` gives the single object in a version 1 file. */
export const PRIMARY_OBJECT_ID = "part";

/** Gap between arranged boxes, millimetres. Arrange does not rotate. */
export const ARRANGE_GAP_MM = 2;

/** Touching faces are not an overlap. Matches the bed warning slack. */
export const OVERLAP_EPS_MM = 0.05;

/** Keys the plate may store per object. Layer height is not one of them. */
export interface PlateObjectSettings {
  supports?: boolean;
  supportAngle?: number;
  supportStyle?: string;
  /** "paint" asks for supports only where Enforce paint does. Absent follows the plate. */
  supportSource?: "auto" | "paint";
  infillCombine?: boolean;
  variableWidth?: boolean;
  scarfSeam?: string;
  gyroid3d?: string;
  /** Sparse infill, 0 to 1. Absent keeps the strategy. */
  infill?: number;
  /** Wall count, 1 to 12. Absent keeps the strategy. */
  walls?: number;
  /** Speed cap, mm/s. Absent keeps the strategy. */
  speed?: number;
}

export interface PlateFileObject {
  id: string;
  name: string;
  mesh: {
    name: string;
    bytesBase64: string;
    byteLength: number;
    hash: string;
  };
  placement: {
    orient: [number, number, number, number, number, number, number, number, number];
    scale: number;
    centered: boolean;
    offset: { x: number; y: number; z: number };
    stepTolerance: number;
  };
  supportEdits: EditEntry[];
  /** Omitted when empty. In the source frame, as `PlateObject.supportPaint`. */
  supportPaint?: PaintDisk[];
  /** Omitted when empty. In the source frame, as `PlateObject.seamPaint`. */
  seamPaint?: SeamDisk[];
  /** Omitted when empty. In the source frame, as `PlateObject.reinforcement`. */
  reinforcement?: ReinforceRegion[];
  /** Omitted when empty. Not sent on the slice request. */
  settings?: PlateObjectSettings;
  /**
   * Optional STEP B-rep, the same shape as `mesh`. Omitted when Model has no session.
   * An older app ignores the key, slices the mesh, and drops it on the next save.
   */
  brep?: {
    name: string;
    bytesBase64: string;
    byteLength: number;
    hash: string;
  };
  /**
   * Optional Model history tree. A root STEP without `bytesBase64` has the bytes of another record
   * in the file with the same hash and length. An older app ignores the key and drops it on the next save.
   */
  modelTree?: SavedTree<{ name: string; bytesBase64?: string; byteLength: number; hash: string }>;
  /** Optional pose from the object's CAD frame into Model's shared space. Omitted for identity, which is how an older file reads. */
  modelPose?: Affine;
  /** Optional: how far the mesh was lowered onto Z = 0 when it was read. Omitted while unknown. */
  meshSeatMm?: number;
}

/** One solid on the plate. Geometry stays in the session, not in the undo JSON. */
export interface PlateObject {
  id: string;
  name: string;
  fileName: string;
  bytes: ArrayBuffer;
  sourcePos: Float32Array;
  orient: Mat3;
  partScale: number;
  centered: boolean;
  offset: MeshShift;
  stepTolerance: number;
  supportEdits: EditEntry[];
  /** Enforce and block disks in this object's source frame, in paint order. */
  supportPaint: readonly PaintDisk[];
  /** Seam disks in this object's source frame. */
  seamPaint: readonly SeamDisk[];
  /** Reinforcement regions (paint or volumes) in this object's source frame. */
  reinforcement?: readonly ReinforceRegion[];
  settings: PlateObjectSettings;
  /** STEP bytes for Model mode. Absent when this object was never opened there. */
  brep?: ArrayBuffer;
  /** Key of this object's Model history tree. Absent until Model opens it. */
  modelTree?: string;
  /** From the object's CAD frame into Model's shared space. Absent is identity: where its file put it. The plate never reads it. */
  modelPose?: Affine;
}

export interface PlateState {
  objects: PlateObject[];
  selectedId: string | null;
}

/** Placement of the selected object, written into an undo snap. */
export interface PlateSnapObject {
  id: string;
  name: string;
  fileName: string;
  orient: number[];
  partScale: number;
  centered: boolean;
  offset: MeshShift;
  stepTolerance: number;
  supportEdits: EditEntry[];
  supportPaint: PaintDisk[];
  seamPaint: SeamDisk[];
  reinforcement?: ReinforceRegion[];
  settings: PlateObjectSettings;
  brep?: ArrayBuffer;
  modelTree?: string;
  modelPose?: Affine;
}

export interface PlateSnap {
  selectedId: string | null;
  objects: PlateSnapObject[];
}

export interface PlateBound {
  id: string;
  min: [number, number, number];
  max: [number, number, number];
  selected: boolean;
  overlap: boolean;
}

export interface ArrangeBox {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ArrangeMove {
  id: string;
  minX: number;
  minY: number;
}

const ALLOWED_SETTINGS = new Set([
  "supports",
  "supportAngle",
  "supportStyle",
  "supportSource",
  "infillCombine",
  "variableWidth",
  "scarfSeam",
  "gyroid3d",
  "infill",
  "walls",
  "speed",
]);

interface HeldGeo {
  fileName: string;
  bytes: ArrayBuffer;
  sourcePos: Float32Array;
}

const held = new Map<string, HeldGeo>();
/** Mesh buffer identity. A copied undo buffer shares the token of the live one. */
const tokenOf = new WeakMap<ArrayBuffer, string>();
/** How far each mesh, by token, was lowered onto Z = 0 when it was read. Unknown only from an engine that did not say. */
const seats = new Map<string, number>();
/** Bytes captured for undo. Not cleared with the live session, so a step can still restore them. */
const pinned = new Map<string, HeldGeo>();
let pinSeq = 0;
let seq = 0;

export interface MeshPin {
  id: string;
  token: string;
}

export function emptyPlate(): PlateState {
  return { objects: [], selectedId: null };
}

export function resetHeldGeometry() {
  held.clear();
}

function copyHeld(geo: HeldGeo): HeldGeo {
  return {
    fileName: geo.fileName,
    bytes: geo.bytes.slice(0),
    sourcePos: new Float32Array(geo.sourcePos),
  };
}

/** The identity of these mesh bytes. Copies pinned for undo share it, so it names one shape however often it is copied. */
export function meshTokenOf(bytes: ArrayBuffer): string {
  let token = tokenOf.get(bytes);
  if (!token) {
    token = `m${(pinSeq += 1)}`;
    tokenOf.set(bytes, token);
  }
  return token;
}

/** How far these mesh bytes were lowered onto Z = 0 when read: their CAD frame is the mesh moved up by this. Undefined when unknown. */
export function meshSeat(bytes: ArrayBuffer): number | undefined {
  return seats.get(meshTokenOf(bytes));
}

export function setMeshSeat(bytes: ArrayBuffer, seat: number) {
  if (Number.isFinite(seat)) seats.set(meshTokenOf(bytes), seat);
}

export function modelPoseOf(obj: { modelPose?: Affine }): Affine {
  return obj.modelPose ?? IDENTITY_POSE;
}

/** The object's plate mesh into model space: up to its CAD frame by its seat, then its pose. An unknown seat counts as 0. */
export function meshToModel(obj: PlateObject): Affine {
  const seat = meshSeat(obj.bytes) ?? 0;
  return seat === 0 ? modelPoseOf(obj) : thenPose(seatLift(seat), modelPoseOf(obj));
}

/** The plate with object `id` at `pose` in model space. Identity drops the key. The plate pose and the mesh stay. */
export function withModelPose(plate: PlateState, id: string, pose: Affine): PlateState {
  return {
    ...plate,
    objects: plate.objects.map((obj) => {
      if (obj.id !== id) return obj;
      const next = { ...obj };
      if (isIdentity(pose)) delete next.modelPose;
      else next.modelPose = pose;
      return next;
    }),
  };
}

/** Every object whose mesh is `token` gets `brep`. Undefined removes it. */
export function withBrepFor(plate: PlateState, token: string, brep: ArrayBuffer | undefined): PlateState {
  let changed = false;
  const objects = plate.objects.map((obj) => {
    if (tokenOf.get(obj.bytes) !== token || obj.brep === brep) return obj;
    changed = true;
    const next = { ...obj };
    if (brep) next.brep = brep;
    else delete next.brep;
    return next;
  });
  return changed ? { ...plate, objects } : plate;
}

/** Remember each object's mesh so a later undo can put those bytes back. */
export function pinPlateMeshes(plate: PlateState): MeshPin[] {
  const pins: MeshPin[] = [];
  for (const obj of plate.objects) {
    const token = meshTokenOf(obj.bytes);
    if (!pinned.has(token)) {
      pinned.set(token, copyHeld({ fileName: obj.fileName, bytes: obj.bytes, sourcePos: obj.sourcePos }));
    }
    pins.push({ id: obj.id, token });
  }
  return pins;
}

/** Put pinned meshes into the live session before a snap is revived. */
export function recallPlateMeshes(pins: readonly MeshPin[] | undefined) {
  if (!pins) return;
  for (const pin of pins) {
    const geo = pinned.get(pin.token);
    if (!geo) continue;
    const copy = copyHeld(geo);
    tokenOf.set(copy.bytes, pin.token);
    held.set(pin.id, copy);
  }
}

export function settingsEmpty(settings: PlateObjectSettings | undefined): boolean {
  return !settings || Object.keys(settings).length === 0;
}

/** Version 2 is a plate with more than one object, or one object that has its own settings, paint, reinforcement, a B-rep, or a Model history. */
export function plateFileIsVersion2(objects: {
  settings?: PlateObjectSettings;
  supportPaint?: readonly PaintDisk[];
  seamPaint?: readonly SeamDisk[];
  reinforcement?: readonly ReinforceRegion[];
  brep?: unknown;
  modelTree?: unknown;
  modelPose?: Affine;
}[]): boolean {
  if (objects.length !== 1) return objects.length > 1;
  const one = objects[0];
  return (
    !settingsEmpty(one?.settings) ||
    (one?.supportPaint?.length ?? 0) > 0 ||
    (one?.seamPaint?.length ?? 0) > 0 ||
    dropEmptyReinforce(one?.reinforcement ?? []).length > 0 ||
    one?.brep != null ||
    one?.modelTree != null ||
    !isIdentity(one?.modelPose)
  );
}

/** One object of the slice request's `objects`, less its mesh bytes, which go on when it is sent. */
export interface PlateRequestObject {
  id: string;
  filename: string;
  pose: RigidPose;
  stepToleranceMm: number;
  settings?: PlateObjectSettings;
  supportEdits?: EditEntry["edit"][];
  supportPaint?: WireDisk[];
  seamPaint?: SeamWireDisk[];
  reinforcement?: WireReinforceRegion[];
}

/** The slice request sends `objects`: two or more objects, or one with its own settings. */
export function plateListed(plate: PlateState): boolean {
  return plate.objects.length > 1 || (plate.objects.length === 1 && !settingsEmpty(plate.objects[0].settings));
}

/**
 * `objects` for the slice request, in plate order. `poseOf` places one object on the bed.
 * Support edits go only with an object that prints tree supports, as for one object.
 * Paint goes with every object that has some, in that object's mesh frame.
 */
export function slicePlateFields(
  objects: readonly PlateObject[],
  poseOf: (obj: PlateObject) => RigidPose,
  plateTree: {
    supports: boolean;
    supportStyle: string;
    blendKind?: "single" | "weight" | "byLayer" | "byRegion";
    strategy?: "speed" | "toughness";
    toughness?: number;
  },
): { objects: PlateRequestObject[] } {
  return {
    objects: objects.map((obj) => {
      const tree = (obj.settings.supports ?? plateTree.supports) && (obj.settings.supportStyle ?? plateTree.supportStyle) === "tree";
      const frame = sourceFrame(obj.sourcePos, obj.partScale);
      const normalDensity = normalInfillDensity({
        blendKind: plateTree.blendKind ?? "single",
        strategy: plateTree.strategy ?? "speed",
        toughness: plateTree.toughness ?? 0.5,
        objectInfill: obj.settings.infill,
      });
      return {
        id: obj.id,
        filename: obj.fileName.replace(/\.(3mf|step|stp)$/i, ".stl"),
        pose: poseOf(obj),
        stepToleranceMm: obj.stepTolerance,
        ...(settingsEmpty(obj.settings) ? {} : { settings: { ...obj.settings } }),
        ...(tree && obj.supportEdits.length > 0 ? { supportEdits: obj.supportEdits.map((entry) => entry.edit) } : {}),
        ...paintRequestFields(obj.supportPaint, frame),
        ...seamRequestFields(obj.seamPaint, frame),
        ...reinforcementRequestFields(obj.reinforcement ?? [], frame, normalDensity),
      };
    }),
  };
}

/** The plate with the selected object's fields taken from the live pose tools. */
export function withLivePose(plate: PlateState, live: SelectedPose & { fileName: string; sourcePos: Float32Array }): PlateObject[] {
  return plate.objects.map((obj) =>
    obj.id !== plate.selectedId
      ? obj
      : {
          ...obj,
          fileName: live.fileName,
          sourcePos: live.sourcePos,
          orient: live.orient,
          partScale: live.partScale,
          centered: live.centered,
          offset: live.offset,
          stepTolerance: live.stepTolerance,
          supportEdits: live.supportEdits,
          supportPaint: live.supportPaint,
          seamPaint: live.seamPaint,
          reinforcement: live.reinforcement ?? obj.reinforcement ?? [],
        },
  );
}

const centres = new WeakMap<Float32Array, [number, number, number]>();

/** Where the engine's mesh frame sits in an object's source frame: scaled about its bounds centre. */
export function sourceFrame(sourcePos: Float32Array, partScale: number) {
  let centre = centres.get(sourcePos);
  if (!centre) {
    const b = boundsOf(sourcePos);
    centre = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    centres.set(sourcePos, centre);
  }
  return { centre, scale: partScale };
}

/** Set or clear one override on the selected object. An empty value deletes the key. */
export function setSelectedOverride(
  plate: PlateState,
  key: "infill" | "walls" | "speed",
  value: number | undefined,
): PlateState {
  if (!plate.selectedId) return plate;
  return {
    ...plate,
    objects: plate.objects.map((obj) => {
      if (obj.id !== plate.selectedId) return obj;
      const settings: PlateObjectSettings = { ...obj.settings };
      if (value === undefined) delete settings[key];
      else settings[key] = value;
      return { ...obj, settings };
    }),
  };
}

export function selectedObject(plate: PlateState): PlateObject | null {
  return plate.objects.find((obj) => obj.id === plate.selectedId) ?? plate.objects[0] ?? null;
}

export function freshPlateId(): string {
  seq += 1;
  return `obj-${seq}`;
}

export function oneObjectPlate(input: {
  name: string;
  fileName: string;
  bytes: ArrayBuffer;
  sourcePos: Float32Array;
  orient: Mat3;
  partScale: number;
  centered: boolean;
  offset: MeshShift;
  stepTolerance: number;
  supportEdits: EditEntry[];
  supportPaint: readonly PaintDisk[];
  seamPaint: readonly SeamDisk[];
  reinforcement?: readonly ReinforceRegion[];
}): PlateState {
  resetHeldGeometry();
  const obj: PlateObject = {
    id: PRIMARY_OBJECT_ID,
    name: input.name,
    fileName: input.fileName,
    bytes: input.bytes,
    sourcePos: input.sourcePos,
    orient: [...input.orient] as Mat3,
    partScale: input.partScale,
    centered: input.centered,
    offset: { ...input.offset },
    stepTolerance: input.stepTolerance,
    supportEdits: input.supportEdits,
    supportPaint: input.supportPaint,
    seamPaint: input.seamPaint,
    reinforcement: input.reinforcement ?? [],
    settings: {},
  };
  hold(obj);
  return { objects: [obj], selectedId: obj.id };
}

/** A second object with the selected object's mesh, pose, paint, overrides, and B-rep. Nothing is copied when nothing is selected. */
export function addedCopy(plate: PlateState): PlateState | null {
  const source = plate.objects.find((obj) => obj.id === plate.selectedId);
  if (!source) return null;
  const copy: PlateObject = {
    ...source,
    id: freshPlateId(),
    name: nextObjectName(plate.objects, source.name),
    orient: [...source.orient] as Mat3,
    offset: { ...source.offset },
    supportEdits: source.supportEdits.map((entry) => structuredClone(entry)),
    supportPaint: source.supportPaint.map((disk) => structuredClone(disk)),
    seamPaint: source.seamPaint.map((disk) => structuredClone(disk)),
    reinforcement: (source.reinforcement ?? []).map((reg) => structuredClone(reg)),
    settings: { ...source.settings },
    brep: source.brep ? source.brep.slice(0) : undefined,
    modelPose: duplicatePose(modelPoseOf(source), boxUnder(boundsOf(source.sourcePos), meshToModel(source))),
  };
  // The copy's edits are its own, so Model opens a tree of its own for it.
  delete copy.modelTree;
  hold(copy);
  return { objects: [...plate.objects, copy], selectedId: copy.id };
}

/** A mesh read from a file, not yet placed. */
export interface IncomingMesh {
  name: string;
  fileName: string;
  bytes: ArrayBuffer;
  sourcePos: Float32Array;
  stepTolerance: number;
}

/**
 * A new object from `mesh`, in the first clear shelf slot.
 * Objects already on the plate stay where they are. Null when the plate is empty.
 */
export function addedMesh(plate: PlateState, mesh: IncomingMesh, bedX: number, bedY: number): PlateState | null {
  if (plate.objects.length === 0) return null;
  const placed = parkClear(freshObject(freshPlateId(), nextObjectName(plate.objects, mesh.name), mesh), plate.objects, bedX, bedY);
  hold(placed);
  return { objects: [...plate.objects, placed], selectedId: placed.id };
}

/**
 * A new solid from Model, selected: centred on the bed when the plate is empty, else in the first clear shelf slot
 * as an added file is. It carries its history tree's key and its place in model space from the start.
 */
export function addedSolid(plate: PlateState, mesh: IncomingMesh, id: string, modelTree: string, modelPose: Affine, bedX: number, bedY: number): PlateState {
  const draft: PlateObject = { ...freshObject(id, mesh.name, mesh), modelTree, ...(isIdentity(modelPose) ? {} : { modelPose }) };
  const placed = plate.objects.length === 0 ? { ...draft, centered: true } : parkClear(draft, plate.objects, bedX, bedY);
  hold(placed);
  return { objects: [...plate.objects, placed], selectedId: placed.id };
}

/** An object as a mesh arrives: unturned, unscaled, unpainted. */
function freshObject(id: string, name: string, mesh: IncomingMesh): PlateObject {
  return {
    id,
    name,
    fileName: mesh.fileName,
    bytes: mesh.bytes,
    sourcePos: mesh.sourcePos,
    orient: [...ID_MATRIX],
    partScale: 1,
    centered: false,
    offset: { x: 0, y: 0, z: 0 },
    stepTolerance: mesh.stepTolerance,
    supportEdits: [],
    supportPaint: [],
    seamPaint: [],
    reinforcement: [],
    settings: {},
  };
}

/**
 * The other half of a split. It keeps the selected object's pose, so a cut
 * through a plate does not park the second piece beside the first.
 * Selection stays on the piece that was already on the plate.
 */
export function addedSplit(plate: PlateState, mesh: IncomingMesh): PlateState | null {
  const parent = plate.objects.find((obj) => obj.id === plate.selectedId);
  if (!parent) return null;
  const names = new Set(plate.objects.map((obj) => obj.name));
  const draft: PlateObject = {
    id: freshPlateId(),
    name: names.has(mesh.name) ? nextObjectName(plate.objects, mesh.name) : mesh.name,
    fileName: mesh.fileName,
    bytes: mesh.bytes,
    sourcePos: mesh.sourcePos,
    orient: [...parent.orient] as Mat3,
    partScale: parent.partScale,
    centered: parent.centered,
    offset: { ...parent.offset },
    stepTolerance: mesh.stepTolerance,
    supportEdits: [],
    supportPaint: [],
    seamPaint: [],
    settings: {},
    // Cut from the parent's solid in the parent's own frame, the piece sits in model space where it was cut.
    ...(parent.modelPose ? { modelPose: parent.modelPose } : {}),
  };
  hold(draft);
  return { objects: [...plate.objects, draft], selectedId: parent.id };
}

/** Every object's placed triangles, in plate order, so one 3MF mesh can carry the whole plate. */
export function platePlacedPositions(objects: readonly PlateObject[], bedX: number, bedY: number): Float32Array {
  const parts = objects.map((obj) => placeObject(obj, bedX, bedY).positions);
  let count = 0;
  for (const part of parts) count += part.length;
  const out = new Float32Array(count);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Each object's placed triangles as a separate array, so a 3MF can store one `<object>` per part. */
export function plateObjectPositions(objects: readonly PlateObject[], bedX: number, bedY: number): Float32Array[] {
  return objects.map((obj) => placeObject(obj, bedX, bedY).positions);
}

export function withoutObject(plate: PlateState, id: string): PlateState {
  if (plate.objects.length <= 1) return plate;
  const objects = plate.objects.filter((obj) => obj.id !== id);
  const selectedId = plate.selectedId === id ? objects[0]?.id ?? null : plate.selectedId;
  return { objects, selectedId };
}

export interface SelectedPose {
  orient: Mat3;
  partScale: number;
  centered: boolean;
  offset: MeshShift;
  stepTolerance: number;
  supportEdits: EditEntry[];
  supportPaint: readonly PaintDisk[];
  seamPaint: readonly SeamDisk[];
  reinforcement?: readonly ReinforceRegion[];
  fileName?: string;
  bytes?: ArrayBuffer;
  sourcePos?: Float32Array | null;
}

/** Write the live pose onto the selected object. Other objects stay put. */
export function withSelectedPose(plate: PlateState, pose: SelectedPose): PlateState {
  if (!plate.selectedId) return plate;
  let changed = false;
  const objects = plate.objects.map((obj) => {
    if (obj.id !== plate.selectedId) return obj;
    changed = true;
    const next: PlateObject = {
      ...obj,
      orient: [...pose.orient] as Mat3,
      partScale: pose.partScale,
      centered: pose.centered,
      offset: { ...pose.offset },
      stepTolerance: pose.stepTolerance,
      supportEdits: pose.supportEdits,
      supportPaint: pose.supportPaint,
      seamPaint: pose.seamPaint,
      reinforcement: pose.reinforcement ?? obj.reinforcement ?? [],
      settings: obj.settings,
    };
    if (pose.fileName) next.fileName = pose.fileName;
    if (pose.bytes) next.bytes = pose.bytes;
    if (pose.sourcePos) next.sourcePos = pose.sourcePos;
    hold(next);
    return next;
  });
  return changed ? { ...plate, objects } : plate;
}

export function snapPlate(plate: PlateState): PlateSnap {
  for (const obj of plate.objects) hold(obj);
  return {
    selectedId: plate.selectedId,
    objects: plate.objects.map((obj) => ({
      id: obj.id,
      name: obj.name,
      fileName: obj.fileName,
      orient: [...obj.orient],
      partScale: obj.partScale,
      centered: obj.centered,
      offset: { ...obj.offset },
      stepTolerance: obj.stepTolerance,
      supportEdits: obj.supportEdits.map((entry) => structuredClone(entry)),
      supportPaint: obj.supportPaint.map((disk) => structuredClone(disk)),
      seamPaint: obj.seamPaint.map((disk) => structuredClone(disk)),
      reinforcement: dropEmptyReinforce(obj.reinforcement ?? []).map((reg) => structuredClone(reg)),
      settings: { ...obj.settings },
      // A STEP buffer is never written in place, so every step shares it.
      brep: obj.brep,
      modelTree: obj.modelTree,
      ...(obj.modelPose ? { modelPose: obj.modelPose } : {}),
    })),
  };
}

/** Rebuild a plate from an undo snap. Geometry is the mesh held when the snap was taken. */
export function revivePlate(snap: PlateSnap): PlateState | null {
  const objects: PlateObject[] = [];
  for (const row of snap.objects) {
    const geo = held.get(row.id);
    if (!geo) return null;
    objects.push({
      id: row.id,
      name: row.name,
      fileName: geo.fileName,
      bytes: geo.bytes,
      sourcePos: geo.sourcePos,
      orient: row.orient as Mat3,
      partScale: row.partScale,
      centered: row.centered,
      offset: { ...row.offset },
      stepTolerance: row.stepTolerance,
      supportEdits: row.supportEdits.map((entry) => structuredClone(entry)),
      supportPaint: (row.supportPaint ?? []).map((disk) => structuredClone(disk)),
      seamPaint: (row.seamPaint ?? []).map((disk) => structuredClone(disk)),
      reinforcement: (row.reinforcement ?? []).map((reg) => structuredClone(reg)),
      settings: { ...row.settings },
      brep: row.brep,
      modelTree: row.modelTree,
      ...(row.modelPose ? { modelPose: row.modelPose } : {}),
    });
  }
  const selectedId = objects.some((obj) => obj.id === snap.selectedId) ? snap.selectedId : objects[0]?.id ?? null;
  return { objects, selectedId };
}

export function assemblePlate(rows: Array<PlateFileObject & { bytes: ArrayBuffer; sourcePos: Float32Array; brepBytes?: ArrayBuffer }>): PlateState {
  resetHeldGeometry();
  const objects: PlateObject[] = rows.map((row) => {
    const obj: PlateObject = {
      id: row.id,
      name: row.name,
      fileName: row.mesh.name,
      bytes: row.bytes,
      sourcePos: row.sourcePos,
      orient: [...row.placement.orient] as Mat3,
      partScale: row.placement.scale,
      centered: row.placement.centered,
      offset: { ...row.placement.offset },
      stepTolerance: row.placement.stepTolerance,
      supportEdits: row.supportEdits.map((entry) => structuredClone(entry)),
      supportPaint: (row.supportPaint ?? []).map((disk) => structuredClone(disk)),
      seamPaint: (row.seamPaint ?? []).map((disk) => structuredClone(disk)),
      reinforcement: (row.reinforcement ?? []).map((reg) => structuredClone(reg)),
      settings: { ...(row.settings ?? {}) },
      brep: row.brepBytes,
      ...(row.modelPose && !isIdentity(row.modelPose) ? { modelPose: row.modelPose } : {}),
    };
    if (row.meshSeatMm !== undefined) setMeshSeat(row.bytes, row.meshSeatMm);
    // A Model step's mesh was saved as an STL already lowered, so reading it says 0; from a file before seats, Model learns it again.
    else if ((row.brep || row.modelTree) && /\.stl$/i.test(row.mesh.name)) seats.delete(meshTokenOf(row.bytes));
    hold(obj);
    return obj;
  });
  return { objects, selectedId: objects[0]?.id ?? null };
}

export function placeObject(obj: PlateObject, bedX: number, bedY: number) {
  return placeMesh(obj.sourcePos, obj.orient, obj.partScale, bedX, bedY, obj.centered, obj.offset);
}

/** Source vertices to bed: `R·s·(p − c) + t`, with `c` the source bounds centre and `t` where that centre lands. */
export function sourceToBed(obj: PlateObject, bedX: number, bedY: number): Affine {
  const { pose } = placeObject(obj, bedX, bedY);
  const s = obj.partScale;
  const m = pose.rotation.map((value) => value * s) as Mat3;
  const [cx, cy, cz] = pose.pivot;
  return {
    m,
    t: [
      pose.translation[0] - (m[0] * cx + m[1] * cy + m[2] * cz),
      pose.translation[1] - (m[3] * cx + m[4] * cy + m[5] * cz),
      pose.translation[2] - (m[6] * cx + m[7] * cy + m[8] * cz),
    ],
  };
}

/** The box around every object in the bed frame: the extent of a plate-wide cut. Null with no objects. */
export function plateUnionBounds(objects: readonly PlateObject[], bedX: number, bedY: number): Bounds | null {
  let union: Bounds | null = null;
  for (const obj of objects) {
    const { min, max } = placeObject(obj, bedX, bedY).bounds;
    union = union
      ? {
          min: [Math.min(union.min[0], min[0]), Math.min(union.min[1], min[1]), Math.min(union.min[2], min[2])],
          max: [Math.max(union.max[0], max[0]), Math.max(union.max[1], max[1]), Math.max(union.max[2], max[2])],
        }
      : { min: [...min], max: [...max] };
  }
  return union;
}

export function boxesOverlapXY(a: Bounds, b: Bounds, eps = OVERLAP_EPS_MM): boolean {
  const overlapX = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const overlapY = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  return overlapX > eps && overlapY > eps;
}

export function overlapPairs(items: { id: string; name: string; bounds: Bounds }[]): { a: string; b: string; line: string }[] {
  const pairs: { a: string; b: string; line: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const left = items[i];
      const right = items[j];
      if (!left || !right || !boxesOverlapXY(left.bounds, right.bounds)) continue;
      pairs.push({ a: left.id, b: right.id, line: `${left.name} overlaps ${right.name}` });
    }
  }
  return pairs;
}

/**
 * REAL: pack boxes left to right, then a new row. Does not rotate and does
 * not call the engine. A box wider than the bed starts at the left edge.
 */
export function arrangeBoxes(boxes: ArrangeBox[], bedX: number, gap = ARRANGE_GAP_MM): ArrangeMove[] {
  let x = 0;
  let y = 0;
  let rowH = 0;
  const out: ArrangeMove[] = [];
  for (const box of boxes) {
    const w = Math.max(0, box.maxX - box.minX);
    const h = Math.max(0, box.maxY - box.minY);
    if (x > 0 && x + w > bedX + OVERLAP_EPS_MM) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    out.push({ id: box.id, minX: x, minY: y });
    x += w + gap;
    rowH = Math.max(rowH, h);
  }
  return out;
}

/** `gap` is the space left between objects; a one-at-a-time plate leaves its toolhead clearance. */
export function arrangedObjects(objects: PlateObject[], bedX: number, bedY: number, gap = ARRANGE_GAP_MM): PlateObject[] {
  const placed = objects.map((obj) => ({ obj, part: placeObject(obj, bedX, bedY) }));
  const moves = arrangeBoxes(placed.map(({ obj, part }) => ({
    id: obj.id,
    minX: part.bounds.min[0],
    minY: part.bounds.min[1],
    maxX: part.bounds.max[0],
    maxY: part.bounds.max[1],
  })), bedX, gap);
  const byId = new Map(moves.map((move) => [move.id, move]));
  return placed.map(({ obj, part }) => {
    const move = byId.get(obj.id);
    if (!move) return obj;
    const applied = obj.centered
      ? centeringShift(obj.sourcePos, obj.orient, obj.partScale, bedX, bedY)
      : obj.offset;
    return {
      ...obj,
      centered: false,
      offset: {
        x: round3(applied.x + (move.minX - part.bounds.min[0])),
        y: round3(applied.y + (move.minY - part.bounds.min[1])),
        z: round3(applied.z),
      },
    };
  });
}

export function boundEntries(plate: PlateState, bedX: number, bedY: number): PlateBound[] {
  const placed = plate.objects.map((obj) => ({ obj, bounds: placeObject(obj, bedX, bedY).bounds }));
  const pairs = overlapPairs(placed.map(({ obj, bounds }) => ({ id: obj.id, name: obj.name, bounds })));
  const hot = new Set<string>();
  for (const pair of pairs) {
    hot.add(pair.a);
    hot.add(pair.b);
  }
  return placed.map(({ obj, bounds }) => ({
    id: obj.id,
    min: bounds.min,
    max: bounds.max,
    selected: obj.id === plate.selectedId,
    overlap: hot.has(obj.id),
  }));
}

export function readPlateSettings(value: unknown): PlateObjectSettings | undefined | string {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "This project file is incomplete.";
  const row = value as Record<string, unknown>;
  if ("layerHeight" in row || "adaptive" in row || "adaptiveMin" in row || "adaptiveMax" in row) {
    return "Layer height is not a per-object setting. The slice has one layer height.";
  }
  const settings: PlateObjectSettings = {};
  for (const key of Object.keys(row)) {
    if (!ALLOWED_SETTINGS.has(key)) return "This project file is incomplete.";
    const got = row[key];
    if (key === "supports" || key === "infillCombine" || key === "variableWidth") {
      if (typeof got !== "boolean") return "This project file is incomplete.";
      settings[key] = got;
      continue;
    }
    if (key === "supportAngle") {
      if (typeof got !== "number" || !Number.isFinite(got)) return "This project file is incomplete.";
      settings.supportAngle = got;
      continue;
    }
    if (key === "supportStyle") {
      if (got !== "grid" && got !== "tree") return "This project file is incomplete.";
      settings.supportStyle = got;
      continue;
    }
    if (key === "supportSource") {
      if (got !== "auto" && got !== "paint") return "This project file is incomplete.";
      settings.supportSource = got;
      continue;
    }
    if (key === "scarfSeam" || key === "gyroid3d") {
      if (typeof got !== "string") return "This project file is incomplete.";
      settings[key] = got;
      continue;
    }
    if (key === "infill") {
      if (typeof got !== "number" || !Number.isFinite(got) || got < 0 || got > 1) {
        return "This project's object infill is not a fraction from 0 to 1.";
      }
      settings.infill = got;
      continue;
    }
    if (key === "walls") {
      if (typeof got !== "number" || !Number.isInteger(got) || got < 1 || got > 12) {
        return "This project's object walls are not a count from 1 to 12.";
      }
      settings.walls = got;
      continue;
    }
    if (key === "speed") {
      if (typeof got !== "number" || !Number.isFinite(got) || got <= 0 || got > 1000) {
        return "This project's object speed is not from 0 to 1000 mm/s.";
      }
      settings.speed = got;
    }
  }
  return settingsEmpty(settings) ? undefined : settings;
}

/** `20 × 20 × 20.5`: one decimal where the size has one, none where it does not. */
/**
 * One truncated line under the size. Omitted by the row when this is empty.
 * Only facts already stored on the solid. Not a slice field.
 */
export function objectMarks(obj: {
  supportPaint?: readonly unknown[];
  seamPaint?: readonly unknown[];
  reinforcement?: readonly ReinforceRegion[];
  settings?: PlateObjectSettings;
}): string {
  const marks: string[] = [];
  if ((obj.supportPaint?.length ?? 0) > 0) marks.push("paint");
  if ((obj.seamPaint?.length ?? 0) > 0) marks.push("seam");
  if (dropEmptyReinforce(obj.reinforcement ?? []).length > 0) marks.push("reinforce");
  const settings = obj.settings;
  if (settings?.supports === false) marks.push("supports off");
  if (settings?.infill !== undefined) marks.push(`infill ${Math.round(settings.infill * 100)}%`);
  if (settings?.walls !== undefined) marks.push(`walls ${settings.walls}`);
  if (settings?.speed !== undefined) marks.push(`speed ${settings.speed}`);
  return marks.join(" · ");
}

export function boundsSize(bounds: Bounds): string {
  return bounds.max.map((value, index) => String(Number((value - bounds.min[index]).toFixed(1)))).join(" × ");
}

function parkClear(incoming: PlateObject, existing: readonly PlateObject[], bedX: number, bedY: number): PlateObject {
  const parked = placeObject({ ...incoming, centered: false, offset: { x: 0, y: 0, z: 0 } }, bedX, bedY).bounds;
  const width = parked.max[0] - parked.min[0];
  const height = parked.max[1] - parked.min[1];
  const obstacles = existing.map((obj) => placeObject(obj, bedX, bedY).bounds);
  const spot = clearSpot(obstacles, width, height, bedX, bedY);
  return {
    ...incoming,
    centered: false,
    offset: {
      x: round3(spot.minX - parked.min[0]),
      y: round3(spot.minY - parked.min[1]),
      z: 0,
    },
  };
}

/** First shelf slot that clears `obstacles` by the arrange gap, preferring a spot that stays on the bed. */
function clearSpot(
  obstacles: readonly Bounds[],
  width: number,
  height: number,
  bedX: number,
  bedY: number,
  gap = ARRANGE_GAP_MM,
): { minX: number; minY: number } {
  const candidates: { minX: number; minY: number }[] = [{ minX: 0, minY: 0 }];
  for (const box of obstacles) {
    candidates.push({ minX: round3(box.max[0] + gap), minY: round3(box.min[1]) });
    candidates.push({ minX: round3(box.min[0]), minY: round3(box.max[1] + gap) });
  }
  candidates.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
  const onBed = candidates.filter((spot) => fitsBed(spot, width, height, bedX, bedY) && spotClears(spot, width, height, obstacles, gap));
  if (onBed[0]) return onBed[0];
  const anywhere = candidates.filter((spot) => spotClears(spot, width, height, obstacles, gap));
  if (anywhere[0]) return anywhere[0];
  let maxX = 0;
  for (const box of obstacles) maxX = Math.max(maxX, box.max[0]);
  return { minX: round3(maxX + gap), minY: 0 };
}

function fitsBed(spot: { minX: number; minY: number }, width: number, height: number, bedX: number, bedY: number): boolean {
  return spot.minX >= -OVERLAP_EPS_MM
    && spot.minY >= -OVERLAP_EPS_MM
    && spot.minX + width <= bedX + OVERLAP_EPS_MM
    && spot.minY + height <= bedY + OVERLAP_EPS_MM;
}

function spotClears(
  spot: { minX: number; minY: number },
  width: number,
  height: number,
  obstacles: readonly Bounds[],
  gap: number,
): boolean {
  const next: Bounds = {
    min: [spot.minX, spot.minY, 0],
    max: [spot.minX + width, spot.minY + height, 1],
  };
  return obstacles.every((box) => separatedBy(next, box, gap));
}

function separatedBy(a: Bounds, b: Bounds, gap: number): boolean {
  return axisGap(a.min[0], a.max[0], b.min[0], b.max[0]) >= gap - 1e-6
    || axisGap(a.min[1], a.max[1], b.min[1], b.max[1]) >= gap - 1e-6;
}

function axisGap(a0: number, a1: number, b0: number, b1: number): number {
  if (a1 <= b0) return b0 - a1;
  if (b1 <= a0) return a0 - b1;
  return -1;
}

/**
 * Replace `id` with one object per shell. `worlds` are that object's placed
 * triangles, largest shell first. Each piece keeps that bed position: identity
 * pose, scale 1, and a Z shift so settle does not drop a floating shell.
 * In model space each piece stays where it was in the parent.
 * Paint and the B-rep stay behind. The largest piece keeps the id.
 */
export function replaceWithShells(plate: PlateState, id: string, worlds: readonly Float32Array[], bedX: number, bedY: number): PlateState | null {
  if (worlds.length < 2) return null;
  const index = plate.objects.findIndex((obj) => obj.id === id);
  const parent = plate.objects[index];
  if (!parent) return null;
  const stem = parent.name.replace(/\.(stl|3mf|step|stp)$/i, "");
  const taken = new Set(plate.objects.filter((obj) => obj.id !== id).map((obj) => obj.name));
  // A shell's vertices are where the parent put it on the bed; this takes them back to where the parent sits in model space.
  const bedToModel = thenPose(inversePose(sourceToBed(parent, bedX, bedY)), meshToModel(parent));
  const pieces: PlateObject[] = worlds.map((world, nth) => {
    let minZ = Infinity;
    for (let i = 2; i < world.length; i += 3) if (world[i]! < minZ) minZ = world[i]!;
    const lift = Number.isFinite(minZ) && minZ > 1e-4 ? minZ : 0;
    const name = unusedName(taken, stem, nth + 1);
    taken.add(name);
    const fileName = `${name}.stl`;
    const sourcePos = new Float32Array(world);
    const piece: PlateObject = {
      id: nth === 0 ? parent.id : freshPlateId(),
      name,
      fileName,
      bytes: encodeStl(sourcePos, fileName),
      sourcePos,
      orient: [...ID_MATRIX],
      partScale: 1,
      centered: false,
      offset: { x: 0, y: 0, z: lift },
      stepTolerance: parent.stepTolerance,
      supportEdits: [],
      supportPaint: [],
      seamPaint: [],
      reinforcement: [],
      settings: { ...parent.settings },
      ...(isIdentity(bedToModel) ? {} : { modelPose: bedToModel }),
    };
    setMeshSeat(piece.bytes, 0);
    hold(piece);
    return piece;
  });
  return {
    objects: [...plate.objects.slice(0, index), ...pieces, ...plate.objects.slice(index + 1)],
    selectedId: pieces[0]!.id,
  };
}

function unusedName(taken: Set<string>, stem: string, start: number): string {
  let n = start;
  let candidate = `${stem} ${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${stem} ${n}`;
  }
  return candidate;
}

function hold(obj: PlateObject) {
  held.set(obj.id, { fileName: obj.fileName, bytes: obj.bytes, sourcePos: obj.sourcePos });
}

function nextObjectName(objects: { name: string }[], base: string): string {
  const names = new Set(objects.map((obj) => obj.name));
  let n = 2;
  let candidate = `${base} ${n}`;
  while (names.has(candidate)) {
    n += 1;
    candidate = `${base} ${n}`;
  }
  return candidate;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function placedBounds(obj: PlateObject, bedX: number, bedY: number): Bounds {
  return placeObject(obj, bedX, bedY).bounds;
}
