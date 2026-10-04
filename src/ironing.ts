/**
 * Ironing on the part's top skins.
 *
 * The slice request's `ironing` is omitted when off, so a slice that does not
 * iron keeps its bytes and its recipe key. `{}` is on, at 10% flow, 20 mm/s,
 * and 0.1 mm spacing. A key is sent only when it differs from that default.
 * The choice is stored in presets, settings profiles, and `.lime` projects,
 * and undo restores it.
 */

export const IRONING_FLOW = 0.1;
export const IRONING_SPEED = 20;
export const IRONING_SPACING = 0.1;

export interface IroningChoice {
  on: boolean;
  /** Fraction of a normal top line. 0.1 is 10%. */
  flow: number;
  /** Millimetres per second. */
  speed: number;
  /** Millimetres between ironing lines. */
  spacing: number;
}

export interface IroningWire {
  flow?: number;
  speed?: number;
  spacing?: number;
}

export function defaultIroning(): IroningChoice {
  return { on: false, flow: IRONING_FLOW, speed: IRONING_SPEED, spacing: IRONING_SPACING };
}

/** The request object the engine reads. Off is omitted. Defaults are omitted keys. */
export function ironingRequest(choice: IroningChoice): { ironing: IroningWire } | Record<string, never> {
  if (!choice.on) return {};
  const wire: IroningWire = {};
  if (choice.flow !== IRONING_FLOW) wire.flow = choice.flow;
  if (choice.speed !== IRONING_SPEED) wire.speed = choice.speed;
  if (choice.spacing !== IRONING_SPACING) wire.spacing = choice.spacing;
  return { ironing: wire };
}

/** Fields added to a slice request. */
export function sliceIroningFields(choice: IroningChoice): { ironing: IroningWire } | Record<string, never> {
  return ironingRequest(choice);
}

function finiteOrBlank(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function readIroningFlowPercent(text: string): number {
  const percent = finiteOrBlank(text);
  if (percent === null) return IRONING_FLOW;
  return Math.min(1, Math.max(0.01, percent / 100));
}

export function readIroningSpeed(text: string): number {
  const speed = finiteOrBlank(text);
  if (speed === null) return IRONING_SPEED;
  return Math.min(200, Math.max(1, speed));
}

export function readIroningSpacing(text: string): number {
  const spacing = finiteOrBlank(text);
  if (spacing === null) return IRONING_SPACING;
  return Math.min(1, Math.max(0.05, spacing));
}

/** Whole percent for the flow field. 0.1 is 10. */
export function ironingFlowPercent(flow: number): number {
  return Math.round(flow * 100);
}
