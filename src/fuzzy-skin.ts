/**
 * Noise on the outer walls.
 *
 * The slice request's `fuzzySkin` is omitted when off, so a slice that does
 * not ask for it keeps its bytes and its recipe key. `{}` is on, at 0.3 mm
 * thickness and 0.8 mm between points. A key is sent only when it differs
 * from that default.
 */

export const FUZZY_THICKNESS = 0.3;
export const FUZZY_POINT_DISTANCE = 0.8;

export interface FuzzyChoice {
  on: boolean;
  /** Peak offset either side of the wall, millimetres. */
  thickness: number;
  /** Millimetres between the offset points. */
  pointDistance: number;
}

export interface FuzzyWire {
  thickness?: number;
  pointDistance?: number;
}

export function defaultFuzzy(): FuzzyChoice {
  return { on: false, thickness: FUZZY_THICKNESS, pointDistance: FUZZY_POINT_DISTANCE };
}

/** The request object the engine reads. Off is omitted. Defaults are omitted keys. */
export function fuzzyRequest(choice: FuzzyChoice): { fuzzySkin: FuzzyWire } | Record<string, never> {
  if (!choice.on) return {};
  const wire: FuzzyWire = {};
  if (choice.thickness !== FUZZY_THICKNESS) wire.thickness = choice.thickness;
  if (choice.pointDistance !== FUZZY_POINT_DISTANCE) wire.pointDistance = choice.pointDistance;
  return { fuzzySkin: wire };
}

/** Fields added to a slice request. */
export function sliceFuzzyFields(choice: FuzzyChoice): { fuzzySkin: FuzzyWire } | Record<string, never> {
  return fuzzyRequest(choice);
}

function finiteOrBlank(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function clamp(text: string, lo: number, hi: number, fallback: number): number {
  const value = finiteOrBlank(text);
  if (value === null) return fallback;
  return Math.round(Math.min(hi, Math.max(lo, value)) * 100) / 100;
}

export function readFuzzyThickness(text: string): number {
  return clamp(text, 0.05, 1, FUZZY_THICKNESS);
}

export function readFuzzyPointDistance(text: string): number {
  return clamp(text, 0.1, 5, FUZZY_POINT_DISTANCE);
}
