/** Undo stack for placement and settings. One gesture is one step. */
import type { BeltSettings, PrinterKind } from "../belt.ts";
import type { OverrideDocument } from "../overrides.ts";
import type { PlateSnap } from "../plate.ts";
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
}

export interface MachineSnap {
  printerId: string;
  filamentId: string;
  nozzleMm: number;
  /** The active printer's kind and belt. Absent on snaps from before belt undo. */
  kind?: PrinterKind;
  belt?: BeltSettings;
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

export function cloneSnap(snap: EditSnap): EditSnap {
  return JSON.parse(JSON.stringify(snap)) as EditSnap;
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
