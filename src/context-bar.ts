/**
 * P3. The selection bar's actions and where it sits.
 *
 * This module is the extension point. The bar renders whatever is registered.
 * It does not know Sketch, Pocket, Pattern, or Section by name.
 *
 * Plan A and Plan B add a button by calling `registerContextAction` from their
 * own module (import this file once from that module so the call runs):
 *
 * - Sketch on a face, and Sketch on the bed (S2): `when: ["flat-face"]` and `["empty"]`.
 * - Pocket, Boss, Text, and the other group features (A3): one action on `flat-face`
 *   whose `menu` lists them, the same shape as New primitive.
 * - Pattern (A4): `when: ["faces"]`.
 * - Hole through an axis, and Use as an axis: `when: ["cylinder"]` and `["edges"]`.
 * - Paste, once a model clipboard exists: `when: ["empty"]`.
 * - Section view (A10): whichever kind it belongs on.
 *
 * `toolbar` is the button the action clicks, so it runs the toolbar's own code.
 * `command` is that button's id in `src/ui/commands.ts`; the tooltip shows its shortcut.
 */

import { PRIMITIVES } from "./model-primitive.ts";

export const CONTEXT_KINDS = ["flat-face", "faces", "cylinder", "curved", "edges", "empty", "mixed"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

/** 24 px above the pointer, and the same gap kept from the solid and from chrome. */
export const CONTEXT_GAP_PX = 24;
/** The bar fades after this long with no pointer movement, and returns on hover. */
export const CONTEXT_FADE_MS = 3000;
/** How close a hover must be to the selection, in pixels, to bring a faded bar back. */
export const CONTEXT_HOVER_PX = 48;

export type FaceSurface = "cylinder" | "cone" | "sphere";

export interface ContextFaceInfo {
  index: number;
  /** Absent on a flat face. The reply only sets this for a cylinder, a cone, or a sphere. */
  surface?: FaceSurface;
}

export interface ContextPick {
  kind: "face" | "edge";
  index: number;
}

/**
 * What the selection is, or null when nothing is selected.
 * An empty click is not a selection: the caller passes `"empty"` itself.
 * Several faces stay `"faces"` even when one of them is a cylinder.
 * A face and an edge together are `"mixed"`.
 */
export function contextKind(picks: readonly ContextPick[], faces: readonly ContextFaceInfo[]): ContextKind | null {
  let faceCount = 0;
  let edgeCount = 0;
  let onlyFace: number | null = null;
  for (const pick of picks) {
    if (pick.kind === "face") {
      faceCount += 1;
      onlyFace = pick.index;
    } else edgeCount += 1;
  }
  if (faceCount === 0 && edgeCount === 0) return null;
  if (faceCount > 0 && edgeCount > 0) return "mixed";
  if (edgeCount > 0) return "edges";
  if (faceCount > 1) return "faces";
  const surface = faces.find((face) => face.index === onlyFace)?.surface;
  if (surface === "cylinder") return "cylinder";
  if (surface === "cone" || surface === "sphere") return "curved";
  return "flat-face";
}

export type Vec3 = [number, number, number];

/** The middle of an edge polyline, or null when it has no segment. */
export function polylineMid(points: ArrayLike<number> | null | undefined): Vec3 | null {
  if (!points || points.length < 6) return null;
  const count = Math.floor(points.length / 3);
  const start = Math.floor((count - 1) / 2) * 3;
  const end = Math.min(start + 3, (count - 1) * 3);
  return [
    ((points[start] ?? 0) + (points[end] ?? 0)) / 2,
    ((points[start + 1] ?? 0) + (points[end + 1] ?? 0)) / 2,
    ((points[start + 2] ?? 0) + (points[end + 2] ?? 0)) / 2,
  ];
}

/** The mean of the points. Null when there are none. */
export function averagePoint(points: readonly Vec3[]): Vec3 | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const point of points) {
    x += point[0];
    y += point[1];
    z += point[2];
  }
  return [x / points.length, y / points.length, z / points.length];
}

export interface ContextMenuItem {
  id: string;
  label: string;
  /** Clicked instead of, or before, `run`. */
  toolbar?: string;
  /** A second button, clicked once `toolbar` has opened its tool. A primitive in the New solid row. */
  then?: string;
  tip?: string;
  /** Extra work after the toolbar button. Absent for a plain toolbar action. */
  run?: () => void;
}

export interface ContextAction {
  /** Stable id. Also the button's `data-action`. Registering the same id replaces the old one. */
  id: string;
  label: string;
  /** Selection kinds this button appears for. */
  when: readonly ContextKind[];
  /** Lower comes first. The default is 100. */
  order?: number;
  /** Sentence in the tooltip. The shortcut is added from `command`. */
  tip?: string;
  /** Command id in `src/ui/commands.ts`. The tooltip shows that command's first chord. */
  command?: string;
  /** Toolbar button this action clicks. The same handler as a press on that button. */
  toolbar?: string;
  /** A caret of further choices. New primitive, and later Pocket / Boss / Text. */
  menu?: readonly ContextMenuItem[];
  /** When this returns false the action is left off the bar. */
  enabled?: () => boolean;
  /** Extra work after the toolbar button. Absent when the toolbar button is the whole action. */
  run?: () => void;
}

export interface ContextBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContextSeat {
  /** Where the click landed, in the same space as `bounds` and the boxes. */
  pointer: { x: number; y: number };
  bar: { width: number; height: number };
  /** The canvas, origin of this space. */
  bounds: { width: number; height: number };
  /** The solid's screen box. The bar must not cover it. Null when there is no solid. */
  solid: ContextBox | null;
  /** Toolbar, readout, titles, and other chrome the bar must not sit under. */
  obstacles: readonly ContextBox[];
  gap?: number;
  /** `beside` puts a faded chip on a side of the solid. The open bar stays above the pointer. */
  place?: "above" | "beside";
}

const MARGIN_PX = 8;
const POINTER_CLEAR_PX = 8;

export function boxesOverlap(a: ContextBox, b: ContextBox): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function containsPoint(box: ContextBox, point: { x: number; y: number }): boolean {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
}

/**
 * Where the bar sits. The first choice is `gap` px above the pointer, centred on it.
 * A place that would cover the pointer, the solid, or a message is refused, and the
 * next place — still beside the selection — is tried. The result stays on the canvas.
 */
export function seatContextBar(input: ContextSeat): { x: number; y: number } {
  const gap = input.gap ?? CONTEXT_GAP_PX;
  const { bar, bounds, pointer } = input;
  const width = Math.max(0, bar.width);
  const height = Math.max(0, bar.height);
  const pointerBox: ContextBox = {
    x: pointer.x - POINTER_CLEAR_PX,
    y: pointer.y - POINTER_CLEAR_PX,
    width: POINTER_CLEAR_PX * 2,
    height: POINTER_CLEAR_PX * 2,
  };
  const blocked = [pointerBox, ...(input.solid ? [input.solid] : []), ...input.obstacles];

  const clamp = (point: { x: number; y: number }) => ({
    x: Math.max(MARGIN_PX, Math.min(Math.max(MARGIN_PX, bounds.width - width - MARGIN_PX), point.x)),
    y: Math.max(MARGIN_PX, Math.min(Math.max(MARGIN_PX, bounds.height - height - MARGIN_PX), point.y)),
  });

  const clear = (point: { x: number; y: number }) => {
    const box = { x: point.x, y: point.y, width, height };
    if (containsPoint(box, pointer)) return false;
    return blocked.every((obstacle) => !boxesOverlap(box, obstacle));
  };

  const prefer = { x: pointer.x - width / 2, y: pointer.y - height - gap };
  const solidFirst = input.solid;
  if (input.place === "beside" && solidFirst) {
    const sides = [
      { x: solidFirst.x - width - gap, y: solidFirst.y },
      { x: solidFirst.x + solidFirst.width + gap, y: solidFirst.y },
    ];
    for (const raw of sides) {
      const point = clamp(raw);
      if (clear(point)) return point;
    }
  }
  const candidates: { x: number; y: number }[] = [prefer, { x: pointer.x - width / 2, y: pointer.y + gap }];
  const solid = input.solid;
  if (solid) {
    candidates.push(
      { x: pointer.x - width / 2, y: solid.y - height - gap },
      { x: solid.x + solid.width / 2 - width / 2, y: solid.y - height - gap },
      { x: solid.x - width - gap, y: pointer.y - height / 2 },
      { x: solid.x + solid.width + gap, y: pointer.y - height / 2 },
      { x: solid.x - width - gap, y: solid.y },
      { x: solid.x + solid.width + gap, y: solid.y },
      { x: pointer.x - width / 2, y: solid.y + solid.height + gap },
    );
  }

  const score = (point: { x: number; y: number }, index: number) => {
    const dx = point.x + width / 2 - pointer.x;
    const dy = point.y + height + gap - pointer.y;
    const below = point.y >= pointer.y ? 10_000 : 0;
    return dx * dx + dy * dy + below + index;
  };

  let best: { x: number; y: number } | null = null;
  let bestScore = Infinity;
  const consider = (raw: { x: number; y: number }, index: number) => {
    const point = clamp(raw);
    if (!clear(point)) return;
    const next = score(point, index);
    if (next < bestScore) {
      bestScore = next;
      best = point;
    }
  };
  candidates.forEach(consider);

  if (!best) {
    const step = 16;
    const maxX = Math.max(MARGIN_PX, bounds.width - width - MARGIN_PX);
    const maxY = Math.max(MARGIN_PX, bounds.height - height - MARGIN_PX);
    for (let y = MARGIN_PX; y <= maxY; y += step) {
      for (let x = MARGIN_PX; x <= maxX; x += step) consider({ x, y }, 1_000);
    }
  }
  if (best) return best;

  const fallback = clamp(prefer);
  if (containsPoint({ ...fallback, width, height }, pointer)) {
    const below = clamp({ x: pointer.x - width / 2, y: pointer.y + gap });
    if (!containsPoint({ ...below, width, height }, pointer)) return below;
  }
  return fallback;
}

interface StoredAction extends ContextAction {
  seq: number;
}

const actions: StoredAction[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Add a button, or replace the one with this id. The returned function removes it.
 * Call this from the feature's own module. Do not edit the bar to add a button.
 */
export function registerContextAction(action: ContextAction): () => void {
  const at = actions.findIndex((item) => item.id === action.id);
  if (at >= 0) actions.splice(at, 1);
  const stored: StoredAction = { ...action, when: [...action.when], menu: action.menu?.map((item) => ({ ...item })), seq: seq++ };
  actions.push(stored);
  actions.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.seq - b.seq);
  emit();
  return () => {
    const index = actions.findIndex((item) => item.seq === stored.seq);
    if (index >= 0) actions.splice(index, 1);
    emit();
  };
}

/** Fires after a register or an unregister, so a bar already on screen can rebuild. */
export function onContextActions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The actions for one kind, in order, skipping any whose `enabled` is false. */
export function actionsFor(kind: ContextKind): ContextAction[] {
  const out: ContextAction[] = [];
  for (const action of actions) {
    if (!action.when.includes(kind)) continue;
    if (action.enabled && !action.enabled()) continue;
    out.push(action);
  }
  return out;
}

/** Every registered action, in order. Tests use this to see that a package landed. */
export function registeredContextActions(): ContextAction[] {
  return actions.map((action) => action);
}

// --- P3 built-in actions. These click the toolbar. Sketch, Pocket, Pattern, Paste, and Use as axis register themselves. ---

registerContextAction({
  id: "push-pull",
  label: "Push/Pull",
  when: ["flat-face"],
  order: 10,
  tip: "Push or pull this face",
  command: "model-pushpull",
  toolbar: "#modelToolPull",
});

registerContextAction({
  id: "move-faces",
  label: "Move faces",
  when: ["faces"],
  order: 10,
  tip: "Move these faces together",
  command: "model-pushpull",
  toolbar: "#modelToolPull",
});

registerContextAction({
  id: "change-diameter",
  label: "Change diameter",
  when: ["cylinder"],
  order: 10,
  tip: "Offset this cylinder. The distance field is the same Push/Pull distance",
  command: "model-pushpull",
  toolbar: "#modelToolPull",
});

registerContextAction({
  id: "push-pull-curved",
  label: "Push/Pull",
  when: ["curved"],
  order: 10,
  tip: "Offset this face along its normal",
  command: "model-pushpull",
  toolbar: "#modelToolPull",
});

registerContextAction({
  id: "hole",
  label: "Hole",
  when: ["flat-face"],
  order: 30,
  tip: "Cut a hole into this face",
  command: "model-hole",
  toolbar: "#modelToolHole",
});

registerContextAction({
  id: "shell-face",
  label: "Shell (open this face)",
  when: ["flat-face"],
  order: 40,
  tip: "Hollow the solid and leave this face open",
  command: "model-shell",
  toolbar: "#modelToolShell",
});

registerContextAction({
  id: "shell-faces",
  label: "Shell (open these)",
  when: ["faces"],
  order: 40,
  tip: "Hollow the solid and leave these faces open",
  command: "model-shell",
  toolbar: "#modelToolShell",
});

registerContextAction({
  id: "fillet",
  label: "Fillet",
  when: ["edges"],
  order: 10,
  tip: "Round the selected edges",
  command: "model-fillet",
  toolbar: "#modelToolFillet",
});

registerContextAction({
  id: "chamfer",
  label: "Chamfer",
  when: ["edges"],
  order: 20,
  tip: "Chamfer the selected edges",
  command: "model-chamfer",
  toolbar: "#modelToolChamfer",
});

registerContextAction({
  id: "new-primitive",
  label: "New primitive",
  when: ["empty"],
  order: 20,
  tip: "Start a solid. The menu picks the primitive; its sizes are typed in the panel",
  command: "model-new",
  toolbar: "#modelToolNew",
  menu: PRIMITIVES.map((entry) => ({
    id: entry.kind,
    label: entry.label,
    toolbar: "#modelToolNew",
    then: `#modelPrim [data-kind="${entry.kind}"]`,
  })),
});
