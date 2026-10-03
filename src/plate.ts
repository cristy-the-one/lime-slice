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
 */
import type { EditEntry } from "./support-edit-list.ts";
import {
  boundsOf,
  centeringShift,
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
  infillCombine?: boolean;
  variableWidth?: boolean;
  scarfSeam?: string;
  gyroid3d?: string;
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
  /** Omitted when empty. Not sent on the slice request. */
  settings?: PlateObjectSettings;
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
  settings: PlateObjectSettings;
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
  settings: PlateObjectSettings;
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
  "infillCombine",
  "variableWidth",
  "scarfSeam",
  "gyroid3d",
]);

const held = new Map<string, { fileName: string; bytes: ArrayBuffer; sourcePos: Float32Array }>();
let seq = 0;

export function emptyPlate(): PlateState {
  return { objects: [], selectedId: null };
}

export function resetHeldGeometry() {
  held.clear();
}

export function settingsEmpty(settings: PlateObjectSettings | undefined): boolean {
  return !settings || Object.keys(settings).length === 0;
}

/** Version 2 is a plate with more than one object, or one object that has its own settings. */
export function plateFileIsVersion2(objects: { settings?: PlateObjectSettings }[]): boolean {
  if (objects.length !== 1) return objects.length > 1;
  return !settingsEmpty(objects[0]?.settings);
}

/** One object of the slice request's `objects`, less its mesh bytes, which go on when it is sent. */
export interface PlateRequestObject {
  id: string;
  filename: string;
  pose: RigidPose;
  stepToleranceMm: number;
  settings?: PlateObjectSettings;
  supportEdits?: EditEntry["edit"][];
}

/** The slice request sends `objects`: two or more objects, or one with its own settings. */
export function plateListed(plate: PlateState): boolean {
  return plate.objects.length > 1 || (plate.objects.length === 1 && !settingsEmpty(plate.objects[0].settings));
}

/**
 * `objects` for the slice request, in plate order. `poseOf` places one object on the bed.
 * Support edits go only with an object that prints tree supports, as for one object.
 */
export function slicePlateFields(
  objects: readonly PlateObject[],
  poseOf: (obj: PlateObject) => RigidPose,
  plateTree: { supports: boolean; supportStyle: string },
): { objects: PlateRequestObject[] } {
  return {
    objects: objects.map((obj) => {
      const tree = (obj.settings.supports ?? plateTree.supports) && (obj.settings.supportStyle ?? plateTree.supportStyle) === "tree";
      return {
        id: obj.id,
        filename: obj.fileName.replace(/\.(3mf|step|stp)$/i, ".stl"),
        pose: poseOf(obj),
        stepToleranceMm: obj.stepTolerance,
        ...(settingsEmpty(obj.settings) ? {} : { settings: { ...obj.settings } }),
        ...(tree && obj.supportEdits.length > 0 ? { supportEdits: obj.supportEdits.map((entry) => entry.edit) } : {}),
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
        },
  );
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
    settings: {},
  };
  hold(obj);
  return { objects: [obj], selectedId: obj.id };
}

export function addedCopy(plate: PlateState): PlateState | null {
  const source = selectedObject(plate);
  if (!source) return null;
  const copy: PlateObject = {
    ...source,
    id: freshPlateId(),
    name: nextObjectName(plate.objects, source.name),
    orient: [...source.orient] as Mat3,
    offset: { ...source.offset },
    supportEdits: source.supportEdits.map((entry) => structuredClone(entry)),
    settings: { ...source.settings },
  };
  hold(copy);
  return { objects: [...plate.objects, copy], selectedId: copy.id };
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
      settings: { ...obj.settings },
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
      settings: { ...row.settings },
    });
  }
  const selectedId = objects.some((obj) => obj.id === snap.selectedId) ? snap.selectedId : objects[0]?.id ?? null;
  return { objects, selectedId };
}

export function assemblePlate(rows: Array<PlateFileObject & { bytes: ArrayBuffer; sourcePos: Float32Array }>): PlateState {
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
      settings: { ...(row.settings ?? {}) },
    };
    hold(obj);
    return obj;
  });
  return { objects, selectedId: objects[0]?.id ?? null };
}

export function placeObject(obj: PlateObject, bedX: number, bedY: number) {
  return placeMesh(obj.sourcePos, obj.orient, obj.partScale, bedX, bedY, obj.centered, obj.offset);
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

export function arrangedObjects(objects: PlateObject[], bedX: number, bedY: number): PlateObject[] {
  const placed = objects.map((obj) => ({ obj, part: placeObject(obj, bedX, bedY) }));
  const moves = arrangeBoxes(placed.map(({ obj, part }) => ({
    id: obj.id,
    minX: part.bounds.min[0],
    minY: part.bounds.min[1],
    maxX: part.bounds.max[0],
    maxY: part.bounds.max[1],
  })), bedX);
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
    if (key === "scarfSeam" || key === "gyroid3d") {
      if (typeof got !== "string") return "This project file is incomplete.";
      settings[key] = got;
    }
  }
  return settingsEmpty(settings) ? undefined : settings;
}

export function boundsSize(bounds: Bounds): string {
  return bounds.max.map((value, index) => (value - bounds.min[index]).toFixed(1)).join(" × ");
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
  return boundsOf(placeObject(obj, bedX, bedY).positions);
}
