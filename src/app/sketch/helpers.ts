/** Small helpers and constants the sketch modules share. */
import { type IconNode } from "lucide";
import { keyOf, chordGlyphs } from "../../ui/commands";
import { type Vec3 } from "../../sketch/model";
import { type SketchFrame } from "../../sketch/frame";
import { type EditButton, type MakeButton } from "../../sketch/reasons";
import { type RevolveAxis } from "../../sketch/revolve";

/** A quarter-arc in the Lucide style, so sketch Arc is not the fillet radius. */
export const ARC_ICON: IconNode = [
  ["path", { d: "M19 19a12 12 0 0 0-12-12" }],
  ["path", { d: "M19 19h-4" }],
  ["path", { d: "M19 19v-4" }],
];

/** The steps the profile sketch's How shows. */
export const PROFILE_SKETCH_STEPS: readonly string[] = [
  "Draw one open chain of lines and arcs across the part, from past one side of the section to past the other. The faint outline is the part cut across the profile.",
  "Dimension it with Constrain. A size can be an expression that names a parameter.",
  "Use profile sends the chain to the cut; Apply on the Split to print card cuts along it.",
];

/** P2: how large a demo is framed, in millimetres, whatever the size of the part. */
export const DEMO_EXTENT_MM = 60;

export function ghostSpan(distance: number, depth2: number | null): { from: number; to: number } {
  if (depth2 != null && depth2 > 0 && Math.abs(depth2 - Math.abs(distance)) <= 1e-4) return { from: -Math.abs(distance), to: Math.abs(distance) };
  if (depth2 != null && depth2 > 0) return distance >= 0 ? { from: -depth2, to: distance } : { from: distance, to: depth2 };
  return distance >= 0 ? { from: 0, to: distance } : { from: distance, to: 0 };
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale3(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function unit3(value: Vec3): Vec3 | null {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > 1e-9)) return null;
  return [value[0] / length, value[1] / length, value[2] / length];
}

/** H1: the status line and the chooser's first line while Start on a face waits for the face. */
export const FACE_FOR_HOLES = "Your sketch is kept as a card. Click a face of the part to draw the holes on.";

/** V1: the model axis a plane direction runs along, for "the vertical axis (Y)". Undefined for a tilted plane. */
export function modelAxisName(direction: readonly number[]): string | undefined {
  const index = [0, 1, 2].find((i) => Math.abs(direction[i] ?? 0) > 0.999);
  return index == null ? undefined : ["X", "Y", "Z"][index];
}

/** V1: one axis as a key, so the card is rebuilt when another listed axis is pressed. */
export function axisKey(axis: RevolveAxis): string {
  return `${axis.origin.map((value) => value.toFixed(3)).join(",")}:${axis.dir.map((value) => value.toFixed(3)).join(",")}`;
}

/** S2: a pipe opens at this diameter, a size people type over (the tutorial's bent pipe is 8). */
export const PIPE_DIAMETER_MM = 5;

/** The Edit row's labels and commands. The tool value is the button's `data-sketch-tool`. */
export const EDIT_LABELS: Record<Exclude<EditButton, "constrain">, { label: string; command: string | null }> = {
  select: { label: "Select", command: null },
  trim: { label: "Trim", command: "sketch-trim" },
  offset: { label: "Offset", command: "sketch-offset" },
  // C1 and U1: named for what they do. The tool values, commands, keys and the saved `construction` field are unchanged.
  construction: { label: "Helper line", command: "sketch-construction" },
  fillet: { label: "Fillet corner", command: "sketch-fillet" },
  use: { label: "Copy edge", command: "sketch-use" },
};

/** The Make row's labels, commands and data attributes. */
export const MAKE_LABELS: Record<MakeButton, { label: string; command: string; data: string }> = {
  extrude: { label: "Extrude", command: "sketch-extrude", data: "sketchExtrude" },
  revolve: { label: "Revolve", command: "sketch-revolve", data: "sketchRevolve" },
  loft: { label: "Loft", command: "sketch-loft", data: "sketchLoft" },
  sweep: { label: "Sweep", command: "sketch-sweep", data: "sketchSweep" },
  holes: { label: "Holes", command: "sketch-holes", data: "sketchHoles" },
};

/** The card's label, with the registry's chord: "Loft (⇧L)". */
export function sketchKeyLabel(name: string, id: string): string {
  const key = keyOf(id);
  return key ? `${name} (${chordGlyphs(key)})` : name;
}

/** A text field, a list, or editable content: a key there is typing, not a sketch command. */
export function typingTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable ? target : null;
}

export function framesMatch(a: SketchFrame, b: SketchFrame): boolean {
  const origin = Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]);
  const normal = Math.abs(a.w[0] * b.w[0] + a.w[1] * b.w[1] + a.w[2] * b.w[2]);
  return origin < 0.5 && normal > 0.999;
}

/** A height as the field shows it: two decimals at most. */
export function formatHeight(value: number): string {
  return String(Math.round(value * 100) / 100);
}
