/** Undo stack for placement and settings. One gesture is one step. */
import type { BeltSettings, PrinterKind } from "../belt.ts";
import type { Firmware } from "../settings-rules.ts";
import type { OverrideDocument } from "../overrides.ts";
import type { TreeRef } from "../model-tree.ts";
import type { MeshPin, PlateSnap } from "../plate.ts";
import type { SettingsLevel } from "../project.ts";

export interface PlacementSnap {
  orient: number[];
  partScale: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
  stepTolerance: number;
}

export interface ProfileSnap {
  nozzleDiameter: number;
  bedX: number;
  bedY: number;
  bedZ: number;
  maxVolumetricMm3S: number;
  maxAccel: number;
  filamentDensityGCm3: number;
  filamentCostPerKg: number;
  name?: string;
  filamentDiameter?: number;
  nozzleTemp?: number;
  bedTemp?: number;
  /** Absent on snaps from before the Klipper limits. */
  squareCornerVelocity?: number;
  minimumCruiseRatio?: number;
  extruderCornerVelocity?: number;
  maxVelocity?: number;
  maxZVelocity?: number;
  maxZAccel?: number;
  /** The filament fan. Absent on snaps from before fan settings. */
  fanPercent?: number;
  overhangFanPercent?: number;
  fanOffLayers?: number;
  /** `null` while supports follow the fan. */
  supportFanPercent?: number | null;
}

export interface MachineSnap {
  printerId: string;
  filamentId: string;
  nozzleMm: number;
  /** The active printer's kind and belt. Absent on snaps from before belt undo. */
  kind?: PrinterKind;
  belt?: BeltSettings;
  /** The active printer's firmware. Absent on snaps from before it was stored. */
  firmware?: Firmware;
  /** The active printer's own G2/G3 answer; `null` when it has none and follows its firmware. Absent on snaps from before it was stored. */
  firmwareArcs?: boolean | null;
}

export interface EditSnap {
  placement: PlacementSnap;
  /** Preset fields, including blend. */
  settings: Record<string, string | number | boolean>;
  splitCustom: boolean;
  profile: ProfileSnap;
  /** Settings panel level. A profile switch restores this with the preset. */
  level: SettingsLevel;
  /** Active printer, filament, and nozzle. Absent on snaps from before the machine library. */
  machine?: MachineSnap;
  /** Height ranges and volumes. Absent on snaps from before that editor. */
  overrides?: OverrideDocument;
  selectedVolumeId?: string | null;
  /** Plate list and which object is selected. Absent on snaps from before the plate. */
  plate?: PlateSnap;
  /** No mesh was loaded: the plate was empty before any file, as before Model's New solid on an empty plate. */
  meshless?: boolean;
  /** Absent on snaps from before sequential printing, which means all-at-once. */
  printOrder?: "all-at-once" | "sequential";
  sequentialClearanceMm?: number;
  sequentialGantryMm?: number;
  /** Assemblies M5: the plate's assemblies, so Attach, Ungroup, and a move in the assembly view undo with the poses. */
  assemblies?: unknown[];
  /** Which mesh bytes each object had. Absent on snaps from before Model edits joined this history. */
  meshPins?: MeshPin[];
  /**
   * The step's name, when it has one: the change that left this state ("Assistant: Fuse Ornament gear on Glasses
   * frame", a Tandem swap). Undo and Redo say it. Absent on a person's own steps.
   */
  label?: string;
}

export interface EditHistory {
  undo: EditSnap[];
  redo: EditSnap[];
  /** State from before the open gesture. Null when nothing is in progress. */
  pending: EditSnap | null;
}

const LIMIT = 40;

export function emptyHistory(): EditHistory {
  return { undo: [], redo: [], pending: null };
}

/** A deep copy, except each object's STEP buffer: it is never written in place, so every step shares it. */
export function cloneSnap(snap: EditSnap): EditSnap {
  if (!snap.plate) return structuredClone(snap);
  const breps = snap.plate.objects.map((row) => row.brep);
  const copy: EditSnap & { plate: PlateSnap } = structuredClone({ ...snap, plate: { ...snap.plate, objects: snap.plate.objects.map(({ brep: _, ...row }) => row) } });
  copy.plate.objects.forEach((row, i) => {
    if (breps[i]) row.brep = breps[i];
    else delete row.brep;
  });
  return copy;
}

export function sameSnap(a: EditSnap, b: EditSnap): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Remember `current` as the start of a gesture. A second call keeps the first start. */
export function beginGesture(history: EditHistory, current: EditSnap): EditHistory {
  if (history.pending) return history;
  return { ...history, pending: cloneSnap(current) };
}

/** Close the gesture. No change leaves the stacks alone and clears the redo stack only when a step lands. */
export function commitGesture(history: EditHistory, current: EditSnap): EditHistory {
  if (!history.pending) return history;
  const before = history.pending;
  if (sameSnap(before, current)) return { ...history, pending: null };
  const undo = [...history.undo, cloneSnap(before)];
  if (undo.length > LIMIT) undo.shift();
  return { undo, redo: [], pending: null };
}

/** Land `before` as a finished step named `label`, as `commitGesture` lands one: the redo steps go. */
export function pushStep(history: EditHistory, before: EditSnap, label: string): EditHistory {
  const undo = [...history.undo, { ...cloneSnap(before), label }];
  if (undo.length > LIMIT) undo.shift();
  return { undo, redo: [], pending: history.pending };
}

export function canUndo(history: EditHistory, current: EditSnap): boolean {
  if (history.pending && !sameSnap(history.pending, current)) return true;
  return history.undo.length > 0;
}

export function canRedo(history: EditHistory, current: EditSnap): boolean {
  if (history.pending && !sameSnap(history.pending, current)) return false;
  return history.redo.length > 0;
}

export function undoSnap(history: EditHistory, current: EditSnap): { history: EditHistory; restore: EditSnap } | null {
  const committed = history.pending ? commitGesture(history, current) : history;
  const restore = committed.undo.at(-1);
  if (!restore) return null;
  return {
    history: {
      undo: committed.undo.slice(0, -1),
      redo: [...committed.redo, cloneSnap(current)],
      pending: null,
    },
    restore: cloneSnap(restore),
  };
}

export function redoSnap(history: EditHistory, current: EditSnap): { history: EditHistory; restore: EditSnap } | null {
  const committed = history.pending ? commitGesture(history, current) : history;
  const restore = committed.redo.at(-1);
  if (!restore) return null;
  return {
    history: {
      undo: [...committed.undo, cloneSnap(current)],
      redo: committed.redo.slice(0, -1),
      pending: null,
    },
    restore: cloneSnap(restore),
  };
}

/**
 * Fold the steps taken since `before` was recorded into one: the first of them stays, the later ones
 * and the redo stack go. The states in between can no longer be restored.
 */
export function foldSince(history: EditHistory, before: WeakSet<EditSnap>): EditHistory {
  const first = history.undo.findIndex((snap) => !before.has(snap));
  return { undo: first < 0 ? history.undo : history.undo.slice(0, first + 1), redo: [], pending: history.pending };
}

/** Each object of every step, by id, Model tree key, and mesh: what an undo or redo can bring back to the plate. */
export function historyRefs(history: EditHistory): TreeRef[] {
  const refs: TreeRef[] = [];
  for (const snap of [...history.undo, ...history.redo, ...(history.pending ? [history.pending] : [])]) {
    const tokens = new Map((snap.meshPins ?? []).map((pin) => [pin.id, pin.token]));
    for (const row of snap.plate?.objects ?? []) {
      const token = tokens.get(row.id);
      refs.push({ id: row.id, ...(row.modelTree ? { key: row.modelTree } : {}), ...(token ? { token } : {}) });
    }
  }
  return refs;
}

/**
 * A short name for the change from `before` to `after`, when that change is one known kind.
 * A named step (`label` on the earlier snap) is the caller's to read. This only looks at the states.
 * Null when the two snaps differ by more than one kind, or by something this does not name.
 */
export function namePlateChange(before: EditSnap, after: EditSnap): string | null {
  if (stable(before.settings) !== stable(after.settings)) return null;
  if (stable(before.profile) !== stable(after.profile)) return null;
  if (stable(before.machine) !== stable(after.machine)) return null;
  if (stable(before.overrides) !== stable(after.overrides)) return null;
  if (before.level !== after.level) return null;
  if (before.printOrder !== after.printOrder) return null;
  if (before.splitCustom !== after.splitCustom) return null;
  if ((before.selectedVolumeId ?? null) !== (after.selectedVolumeId ?? null)) return null;
  if ((before.sequentialClearanceMm ?? 0) !== (after.sequentialClearanceMm ?? 0)) return null;
  if ((before.sequentialGantryMm ?? 0) !== (after.sequentialGantryMm ?? 0)) return null;
  if (stable(tokensOf(before)) !== stable(tokensOf(after))) return null;
  const grown = (after.assemblies?.length ?? 0) - (before.assemblies?.length ?? 0);
  if (grown !== 0) return grown > 0 ? "Link" : "Ungroup";
  if (stable(before.assemblies) !== stable(after.assemblies)) return null;
  const bPlate = before.plate;
  const aPlate = after.plate;
  if (!bPlate || !aPlate || bPlate.objects.length !== aPlate.objects.length) return null;
  const afterById = new Map(aPlate.objects.map((row) => [row.id, row]));
  let kind: string | null = null;
  for (const row of bPlate.objects) {
    const next = afterById.get(row.id);
    if (!next) return null;
    const change = objectPoseChange(row, next);
    if (change === "same") continue;
    if (change === "other" || change === "mixed") return null;
    if (kind && kind !== change) return null;
    kind = change;
  }
  if (!placementAgrees(before, after)) return null;
  return kind;
}

function stable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function tokensOf(snap: EditSnap): [string, string][] {
  return (snap.meshPins ?? []).map((pin): [string, string] => [pin.id, pin.token]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Print-layout and design-space fields aside, plus whether a solid STEP is kept. */
function poseRest(row: PlateSnap["objects"][number]): string {
  const { modelPose, offset, orient, partScale, centered, brep, ...keep } = row;
  return stable({ ...keep, hasBrep: brep != null });
}

function objectPoseChange(before: PlateSnap["objects"][number], after: PlateSnap["objects"][number]): "same" | "Move" | "Rotate" | "Scale" | "mixed" | "other" {
  if (poseRest(before) !== poseRest(after)) return "other";
  const pose = stable(before.modelPose) !== stable(after.modelPose);
  const offset = stable(before.offset) !== stable(after.offset) || before.centered !== after.centered;
  const orient = stable(before.orient) !== stable(after.orient);
  const scale = before.partScale !== after.partScale;
  if (pose && offset) return "mixed";
  const kinds = [...new Set([pose || offset ? "Move" : "", orient ? "Rotate" : "", scale ? "Scale" : ""].filter(Boolean))];
  if (kinds.length === 0) return "same";
  if (kinds.length > 1) return "mixed";
  return kinds[0] as "Move" | "Rotate" | "Scale";
}

/** The selected object's print layout and the snap's placement move together, or neither does. */
function placementAgrees(before: EditSnap, after: EditSnap): boolean {
  if (before.placement.stepTolerance !== after.placement.stepTolerance) return false;
  const id = after.plate?.selectedId ?? before.plate?.selectedId ?? null;
  const earlier = before.plate?.objects.find((row) => row.id === id);
  const later = after.plate?.objects.find((row) => row.id === id);
  if (!earlier || !later) return stable(before.placement) === stable(after.placement);
  const same = (left: unknown, right: unknown) => stable(left) === stable(right);
  const offset = !same(earlier.offset, later.offset) || earlier.centered !== later.centered;
  const orient = !same(earlier.orient, later.orient);
  const scale = earlier.partScale !== later.partScale;
  const pOffset = !same(before.placement.offset, after.placement.offset) || before.placement.centered !== after.placement.centered;
  const pOrient = !same(before.placement.orient, after.placement.orient);
  const pScale = before.placement.partScale !== after.placement.partScale;
  return offset === pOffset && orient === pOrient && scale === pScale;
}

/**
 * Every step whose object has mesh `token` gets `brep` for that object. Undefined removes it.
 * Steps are changed in place, so a step stays the same step (`foldSince` tells them apart by identity).
 */
export function putBrepFor(history: EditHistory, token: string, brep: ArrayBuffer | undefined) {
  for (const snap of [...history.undo, ...history.redo, ...(history.pending ? [history.pending] : [])]) {
    const ids = new Set((snap.meshPins ?? []).filter((pin) => pin.token === token).map((pin) => pin.id));
    for (const row of snap.plate?.objects ?? []) {
      if (!ids.has(row.id)) continue;
      if (brep) row.brep = brep;
      else delete row.brep;
    }
  }
}
