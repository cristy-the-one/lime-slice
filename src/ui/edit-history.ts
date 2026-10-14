/** Undo stack for placement and settings. One gesture is one step. */
import type { BeltSettings, PrinterKind } from "../belt.ts";
import type { Firmware } from "../settings-rules.ts";
import type { OverrideDocument } from "../overrides.ts";
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
  /** Absent on snaps from before sequential printing, which means all-at-once. */
  printOrder?: "all-at-once" | "sequential";
  sequentialClearanceMm?: number;
  sequentialGantryMm?: number;
  /** Which mesh bytes each object had. Absent on snaps from before Model edits joined this history. */
  meshPins?: MeshPin[];
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

/** The Model tree keys and mesh tokens the steps hold: what an undo or redo can bring back to the plate. */
export function historyRefs(history: EditHistory): { keys: Set<string>; tokens: Set<string> } {
  const keys = new Set<string>();
  const tokens = new Set<string>();
  for (const snap of [...history.undo, ...history.redo, ...(history.pending ? [history.pending] : [])]) {
    for (const row of snap.plate?.objects ?? []) if (row.modelTree) keys.add(row.modelTree);
    for (const pin of snap.meshPins ?? []) tokens.add(pin.token);
  }
  return { keys, tokens };
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
