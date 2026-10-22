/**
 * Model's view look: a section plane and colour by step. Pure, so the menu and the tests
 * share one reading of the plane. The cut-away side is the side the normal points toward.
 */
import { mixHex } from "./model-select.ts";

export type Vec3 = [number, number, number];
export type SectionAxis = "x" | "y" | "z" | "face";

export interface Plane {
  origin: Vec3;
  /** Unit normal. The side it points toward is cut away. */
  normal: Vec3;
}

export interface LookState {
  section: boolean;
  axis: SectionAxis;
  /** Millimetres along the base axis or the face normal, before Flip. */
  offset: number;
  flip: boolean;
  colourByStep: boolean;
  /** The picked face, in model space. Used while `axis` is `face`. */
  face: Plane | null;
}

const IDLE = 0x5c6750;
const IDLE_LIFT = 0x7d8870;

export function idleLook(): LookState {
  return { section: false, axis: "z", offset: 0, flip: false, colourByStep: false, face: null };
}

function axisNormal(axis: "x" | "y" | "z"): Vec3 {
  if (axis === "x") return [1, 0, 0];
  if (axis === "y") return [0, 1, 0];
  return [0, 0, 1];
}

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!(length > 0)) return [0, 0, 1];
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * The section plane in model space. An axis plane passes through `centre` (the part's centre).
 * A face plane passes through the picked face. Offset slides along that base normal; Flip only
 * swaps which side is cut away. Null when section is off, or a face is asked for and none is picked.
 */
export function sectionPlane(state: LookState, centre: Vec3): Plane | null {
  if (!state.section) return null;
  let origin: Vec3;
  let normal: Vec3;
  if (state.axis === "face") {
    if (!state.face) return null;
    origin = [state.face.origin[0], state.face.origin[1], state.face.origin[2]];
    normal = unit(state.face.normal);
  } else {
    origin = [centre[0], centre[1], centre[2]];
    normal = axisNormal(state.axis);
  }
  origin = [
    origin[0] + normal[0] * state.offset,
    origin[1] + normal[1] * state.offset,
    origin[2] + normal[2] * state.offset,
  ];
  if (state.flip) normal = [-normal[0], -normal[1], -normal[2]];
  return { origin, normal };
}

/** A drag of `mm` along the cut normal, which points the opposite way once Flip is on. */
export function offsetAfterDrag(offset: number, mm: number, flip: boolean): number {
  return offset + mm * (flip ? -1 : 1);
}

/**
 * Stable per node: a golden-angle hue, so undo does not reshuffle the colours. --- D34. The hues stay out of the reds
 * (325° to 35°), which mean danger and the section cap, and the root starts on blue.
 */
export function stepHex(id: number): string {
  const hue = STEP_HUE_FROM + ((((id * 137.508 + STEP_HUE_ROOT) % STEP_HUE_SPAN) + STEP_HUE_SPAN) % STEP_HUE_SPAN);
  const saturation = 0.58;
  const light = 0.48;
  const chroma = saturation * Math.min(light, 1 - light);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = light - chroma * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

const STEP_HUE_FROM = 35;
const STEP_HUE_SPAN = 290;
/** The root's hue, 215° (blue), from STEP_HUE_FROM. */
const STEP_HUE_ROOT = 180;

export function stepColour(id: number): number {
  return Number.parseInt(stepHex(id).slice(1), 16);
}

export function facePaint(args: {
  index: number;
  owner: number | null;
  selected: boolean;
  pickHover: boolean;
  stepHover: boolean;
  colourByStep: boolean;
  accent: number;
  /** A Stress hold or load tint. It shows over the step colours. */
  study?: number | null;
}): { hex: number; stepHex: string | null } {
  if (args.selected) return { hex: args.accent, stepHex: null };
  if (args.study != null) return { hex: args.pickHover ? mixHex(args.study, 0xffffff, 0.3) : args.study, stepHex: null };
  const wobble = (Math.abs(args.index) * 17) % 7;
  const idle = mixHex(IDLE, IDLE_LIFT, wobble / 6);
  if (args.colourByStep && args.owner != null) {
    const base = stepColour(args.owner);
    const hex = args.stepHover || args.pickHover ? mixHex(base, 0xffffff, 0.35) : base;
    return { hex, stepHex: stepHex(args.owner) };
  }
  if (args.stepHover && args.owner != null) {
    return { hex: mixHex(idle, stepColour(args.owner), 0.55), stepHex: stepHex(args.owner) };
  }
  if (args.pickHover) return { hex: mixHex(idle, args.accent, 0.4), stepHex: null };
  return { hex: idle, stepHex: null };
}
