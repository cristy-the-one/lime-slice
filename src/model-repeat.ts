/**
 * Pattern and Mirror of history steps (A4).
 * A source is one or more Boolean steps, holes, or groups of those. Each copy is that step moved by the same
 * motions the MCP uses (`patternMotions`, `pathMotions`, `mirrorMotion`, `movedSpec`). The result is one group.
 */
import { registerContextAction } from "./context-bar.ts";
import { align, orientEuler } from "./mesh-place.ts";
import { MAX_PIECES, mirrorMotion, movedSpec, patternMotions, type Motion, type Piece } from "./modeling/compose.ts";
import { isPrimitiveKind, type PrimitiveSpec } from "./model-primitive.ts";
import { fromSolidOp, type Affine } from "./model-space.ts";
import { groupFromPieces } from "./model-features.ts";
import type { BooleanKind, GroupOp, HoleOp, ModelOp } from "./model-tree.ts";
import { GLOBAL_WORKPLANE } from "./workplane.ts";

export const REPEAT_TOOLS = ["pattern", "mirror"] as const;
export type RepeatTool = (typeof REPEAT_TOOLS)[number];

export type PatternMode = "linear" | "polar" | "path";
export type PatternAxis = "x" | "y" | "z" | "pick";
export type MirrorPlane = "x" | "y" | "z" | "face";

/** A through hole's length depends on the solid it cuts, so it is not a cylinder that can be copied yet. */
export const HOLES_NOT_YET = "Holes cannot be patterned yet.";

/** A fillet, a split, a shell, or anything else this package does not copy. */
export const REPEAT_ONLY = "Only a Boolean, a hole, or a feature can be repeated.";

/** Shown when the steps named in `source.of` are no longer in the history. */
export const REPEAT_DELETED = "A step this repeats was deleted.";

/** Shown until a history row is chosen. Ctrl-click adds another; the last step is the one the tool opens on. */
export const REPEAT_PICK = "Ctrl-click history rows to choose steps.";

export const REPEAT_AXIS = "Pick an edge or a round face for the axis, or choose X, Y, or Z.";

export const REPEAT_FACE = "Pick a flat face, or choose X, Y, or Z.";

const STILL: Motion = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], reflect: false };

type Vec3 = [number, number, number];

export function isRepeatTool(tool: unknown): tool is RepeatTool {
  return tool === "pattern" || tool === "mirror";
}

export function repeatName(tool: RepeatTool): string {
  return tool === "pattern" ? "Pattern" : "Mirror";
}

/** The panel's choices, which are not number fields. `of` is the history steps, in the order they were picked. */
export interface RepeatChoices {
  mode: PatternMode;
  axis: PatternAxis;
  /** The picked axis, when Edge is on and a pick or a saved pattern has one. */
  axisVec: Vec3 | null;
  align: boolean;
  plane: MirrorPlane;
  /** The picked face's normal, when Face is on. */
  normal: Vec3 | null;
  keep: boolean;
  points: Vec3[];
  of: number[];
}

export const REPEAT_CHOICE_DEFAULTS: RepeatChoices = {
  mode: "linear",
  axis: "z",
  axisVec: null,
  align: true,
  plane: "z",
  normal: null,
  keep: true,
  points: [],
  of: [],
};

function numOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function vec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const [x, y, z] = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return fallback;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return fallback;
  return [x, y, z];
}

function namedAxis(axis: Vec3): PatternAxis | null {
  const [x, y, z] = axis;
  if (x === 1 && y === 0 && z === 0) return "x";
  if (x === 0 && y === 1 && z === 0) return "y";
  if (x === 0 && y === 0 && z === 1) return "z";
  return null;
}

function axisVector(choices: RepeatChoices): Vec3 | { reason: string } {
  if (choices.axis === "x") return [1, 0, 0];
  if (choices.axis === "y") return [0, 1, 0];
  if (choices.axis === "z") return [0, 0, 1];
  if (!choices.axisVec) return { reason: REPEAT_AXIS };
  const length = Math.hypot(...choices.axisVec);
  if (!(length > 1e-9)) return { reason: REPEAT_AXIS };
  return [choices.axisVec[0] / length, choices.axisVec[1] / length, choices.axisVec[2] / length];
}

/**
 * The spec stored on the group: `{kind, of, ...fields}`. A count of 1 in the second direction is left out.
 * `read` is one panel field. The caller has already put the solid's centre into the centre fields.
 */
export function readRepeatSpec(tool: RepeatTool, read: (id: string) => number, choices: RepeatChoices): Record<string, unknown> | { reason: string } {
  const spec: Record<string, unknown> = { kind: tool, of: [...choices.of] };
  if (tool === "mirror") {
    const origin: Vec3 = [read("modelMirX"), read("modelMirY"), read("modelMirZ")];
    if (choices.plane === "face") {
      if (!choices.normal) return { reason: REPEAT_FACE };
      const length = Math.hypot(...choices.normal);
      if (!(length > 1e-9)) return { reason: REPEAT_FACE };
      spec.normal = [choices.normal[0] / length, choices.normal[1] / length, choices.normal[2] / length];
      spec.origin = origin;
    } else {
      spec.plane = choices.plane;
      spec.origin = origin;
    }
    if (!choices.keep) spec.keepOriginal = false;
    return spec;
  }
  if (choices.mode === "polar") {
    const axis = axisVector(choices);
    if ("reason" in axis) return axis;
    spec.polar = {
      count: Math.round(read("modelPatCount")),
      centre: [read("modelPatCx"), read("modelPatCy"), read("modelPatCz")] as Vec3,
      axis,
      angleDeg: read("modelPatAngle"),
    };
    return spec;
  }
  if (choices.mode === "path") {
    if (choices.points.length < 2) return { reason: "A path needs at least two points. Click the solid, or type a point and add it." };
    const path: Record<string, unknown> = { points: choices.points.map((point) => [...point]), count: Math.round(read("modelPatCount")) };
    if (!choices.align) path.align = false;
    spec.path = path;
    return spec;
  }
  const count2 = Math.round(read("modelPatCount2"));
  const linear: Record<string, unknown> = {
    step: [read("modelPatSx"), read("modelPatSy"), read("modelPatSz")] as Vec3,
    count: Math.round(read("modelPatCount")),
  };
  if (count2 > 1) {
    linear.step2 = [read("modelPatS2x"), read("modelPatS2y"), read("modelPatS2z")];
    linear.count2 = count2;
  }
  spec.linear = linear;
  return spec;
}

function axisWord(axis: Vec3): string {
  return namedAxis(axis)?.toUpperCase() ?? "an axis";
}

/** The history row: "Pattern × 6 around Z", "Pattern 3 × 2", "Mirror". */
export function repeatLabel(spec: Record<string, unknown>): string {
  if (spec.kind === "mirror") return "Mirror";
  const polar = spec.polar as { count?: unknown; axis?: unknown } | undefined;
  if (polar) return `Pattern × ${Math.round(numOf(polar.count, 0))} around ${axisWord(vec3(polar.axis, [0, 0, 1]))}`;
  const linear = spec.linear as { count?: unknown; count2?: unknown } | undefined;
  if (linear) {
    const count = Math.round(numOf(linear.count, 0));
    const count2 = Math.round(numOf(linear.count2, 1));
    return count2 > 1 ? `Pattern ${count} × ${count2}` : `Pattern × ${count}`;
  }
  const path = spec.path as { count?: unknown } | undefined;
  if (path) return `Pattern × ${Math.round(numOf(path.count, 0))} on a path`;
  return "Pattern";
}

/** The choices an edited pattern or mirror reopens with. */
export function repeatPanel(source: Record<string, unknown>): { tool: RepeatTool; fields: Record<string, number>; repeat: RepeatChoices } {
  const tool: RepeatTool = source.kind === "mirror" ? "mirror" : "pattern";
  const linear = (source.linear ?? {}) as Record<string, unknown>;
  const polar = (source.polar ?? {}) as Record<string, unknown>;
  const path = (source.path ?? {}) as Record<string, unknown>;
  const step = vec3(linear.step, [10, 0, 0]);
  const step2 = vec3(linear.step2, [0, 0, 0]);
  const centre = vec3(polar.centre, [0, 0, 0]);
  const origin = vec3(source.origin, [0, 0, 0]);
  const points = Array.isArray(path.points) ? path.points.map((point) => vec3(point, [0, 0, 0])) : [];
  const last = points.at(-1) ?? [0, 0, 0];
  const axis = vec3(polar.axis, [0, 0, 1]);
  const named = namedAxis(axis);
  const mode: PatternMode = source.polar ? "polar" : source.path ? "path" : "linear";
  const plane: MirrorPlane = source.plane === "x" || source.plane === "y" || source.plane === "z" ? source.plane : source.normal ? "face" : "z";
  const fields: Record<string, number> = {
    modelPatSx: step[0],
    modelPatSy: step[1],
    modelPatSz: step[2],
    modelPatCount: Math.round(numOf(mode === "polar" ? polar.count : mode === "path" ? path.count : linear.count, 6)),
    modelPatS2x: step2[0],
    modelPatS2y: step2[1],
    modelPatS2z: step2[2],
    modelPatCount2: Math.round(numOf(linear.count2, 1)),
    modelPatAngle: numOf(polar.angleDeg, 360),
    modelPatCx: centre[0],
    modelPatCy: centre[1],
    modelPatCz: centre[2],
    modelPatPx: last[0],
    modelPatPy: last[1],
    modelPatPz: last[2],
    modelMirX: origin[0],
    modelMirY: origin[1],
    modelMirZ: origin[2],
  };
  const of = Array.isArray(source.of) ? source.of.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id >= 0) : [];
  const repeat: RepeatChoices = {
    mode,
    axis: named ?? "pick",
    axisVec: named ? null : axis,
    align: path.align !== false,
    plane,
    normal: plane === "face" ? vec3(source.normal, [0, 0, 1]) : null,
    keep: source.keepOriginal !== false,
    points,
    of,
  };
  return { tool, fields, repeat };
}

/** A group's pattern or mirror, when it is one of these tools. */
export function repeatSource(op: ModelOp): Record<string, unknown> | null {
  if (op.kind !== "group" || !op.source || typeof op.source !== "object") return null;
  const source = op.source as Record<string, unknown>;
  return source.kind === "pattern" || source.kind === "mirror" ? source : null;
}

function round6(value: number): number {
  const out = Math.round(value * 1e6) / 1e6;
  return Object.is(out, -0) ? 0 : out;
}

function unit(value: Vec3): Vec3 | null {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 1e-9 ? [value[0] / length, value[1] / length, value[2] / length] : null;
}

/** A cylinder whose local +Z follows `axis`, starting at `origin`. */
function cylinderCut(origin: Vec3, radius: number, height: number, axis: Vec3): Piece {
  const euler = orientEuler(align([0, 0, 1], axis));
  const spec: PrimitiveSpec = {
    primitive: "cylinder",
    origin: [...origin],
    size: [0, 0, 0],
    radius,
    height,
    turn: [round6(euler.rx), round6(euler.ry), round6(euler.rz)],
  };
  return { op: "cut", spec };
}

/** A blind hole as the cylinder (and counterbore) it cuts. A through hole has no fixed length. */
function holePieces(hole: HoleOp): Piece[] | { reason: string } {
  if (hole.through || !(hole.radius > 0) || !(hole.depth > 0)) return { reason: HOLES_NOT_YET };
  const axis = unit(hole.axis) ?? [0, 0, -1];
  const pieces = [cylinderCut(hole.origin, hole.radius, hole.depth, axis)];
  const wider = hole.counterboreRadius;
  const bore = hole.counterboreDepth;
  if (wider == null && bore == null) return pieces;
  if (!(wider! > hole.radius) || !(bore! > 0) || !(bore! < hole.depth)) return { reason: HOLES_NOT_YET };
  pieces.push(cylinderCut(hole.origin, wider!, bore!, axis));
  return pieces;
}

function booleanPiece(op: ModelOp): Piece | { reason: string } {
  if (op.kind !== "boolean" || !isPrimitiveKind(op.primitive)) return { reason: REPEAT_ONLY };
  const { kind: _kind, op: which, ...spec } = op;
  return { op: which, spec };
}

/** The Boolean pieces one step contributes. A group contributes each of its steps. */
export function piecesOfStep(op: ModelOp): Piece[] | { reason: string } {
  if (op.kind === "boolean") {
    const piece = booleanPiece(op);
    return "reason" in piece ? piece : [piece];
  }
  if (op.kind === "hole") return holePieces(op);
  if (op.kind === "group") {
    const out: Piece[] = [];
    for (const step of op.steps) {
      const part = piecesOfStep(step);
      if ("reason" in part) return part;
      out.push(...part);
    }
    return out.length > 0 ? out : { reason: REPEAT_ONLY };
  }
  return { reason: REPEAT_ONLY };
}

function still(motion: Motion): boolean {
  return !motion.reflect && motion.t.every((value) => value === 0) && motion.m.every((value, index) => value === (index % 4 === 0 ? 1 : 0));
}

function inverse(op: BooleanKind): BooleanKind | { reason: string } {
  if (op === "cut") return "fuse";
  if (op === "fuse") return "cut";
  return { reason: "Keep the original on for a common." };
}

export interface ExpandedRepeat {
  note: string | null;
  pieces: Piece[] | null;
  group: GroupOp | null;
}

function emptyRepeat(note: string): ExpandedRepeat {
  return { note, pieces: null, group: null };
}

/**
 * One group for `spec`, from the source steps' ops (in the solid's frame). `pose` brings them into model space,
 * where the panel's distances are typed; `toSolidOp` puts the group back. A missing id is the caller's to refuse
 * before this runs. The count includes the original, so the first copy sits on the step that is already there.
 */
export function expandRepeat(spec: Record<string, unknown>, steps: readonly { id: number; op: ModelOp }[], pose: Affine): ExpandedRepeat {
  if (steps.length === 0) return emptyRepeat(REPEAT_PICK);
  const pieces: Piece[] = [];
  for (const step of steps) {
    const part = piecesOfStep(fromSolidOp(step.op, pose));
    if ("reason" in part) return emptyRepeat(part.reason);
    pieces.push(...part);
  }
  let motions: Motion[];
  if (spec.kind === "pattern") {
    const made = patternMotions(spec, GLOBAL_WORKPLANE);
    if ("reason" in made) return emptyRepeat(made.reason);
    motions = made;
  } else if (spec.kind === "mirror") {
    const made = mirrorMotion(spec, GLOBAL_WORKPLANE);
    if ("reason" in made) return emptyRepeat(made.reason);
    motions = spec.keepOriginal === false ? [made] : [STILL, made];
  } else {
    return emptyRepeat(REPEAT_ONLY);
  }
  const out: Piece[] = [];
  if (spec.kind === "mirror" && spec.keepOriginal === false) {
    for (const piece of [...pieces].reverse()) {
      const flipped = inverse(piece.op);
      if (typeof flipped !== "string") return emptyRepeat(flipped.reason);
      out.push({ op: flipped, spec: piece.spec });
    }
  }
  for (const motion of motions) {
    for (const piece of pieces) {
      if (still(motion)) {
        out.push(piece);
      } else {
        const moved = movedSpec(piece.spec, motion);
        if ("reason" in moved) return emptyRepeat(moved.reason);
        out.push({ op: piece.op, spec: moved });
      }
      if (out.length > MAX_PIECES) return emptyRepeat(`This makes more than ${MAX_PIECES} steps. Split it into smaller edits.`);
    }
  }
  const label = repeatLabel(spec);
  return { note: null, pieces: out, group: groupFromPieces(label, spec, out) };
}

/** "Repeating Pocket 10 × 10", or how many steps, for the panel line above the dry-run. */
export function repeatingText(labels: readonly string[]): string {
  if (labels.length === 0) return REPEAT_PICK;
  if (labels.length === 1) return `Repeating ${labels[0]}.`;
  return `Repeating ${labels.length} steps.`;
}

/** A missing id is a step that was deleted. None chosen yet asks for a Ctrl-click. */
export function repeatTargets(of: readonly number[], has: (id: number) => boolean): string | null {
  if (of.length === 0) return REPEAT_PICK;
  return of.some((id) => !has(id)) ? REPEAT_DELETED : null;
}

/** The panel's picks, apart from the number fields: the steps, the path, and a saved axis or face normal. */
let axisVec: Vec3 | null = null;
let mirrorNormal: Vec3 | null = null;
let mirrorFaceLock = false;
let pathPoints: Vec3[] = [];
let sourceIds: number[] = [];

function pressed(group: string, attr: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  return document.querySelector<HTMLElement>(`#${group} [aria-pressed="true"]`)?.dataset[attr] || fallback;
}

/** What the open panel has chosen. Number fields are read separately. */
export function panelRepeatChoices(): RepeatChoices {
  const mode = pressed("modelPatMode", "pat", "linear");
  const axis = pressed("modelPatAxis", "axis", "z");
  const plane = pressed("modelMirPlane", "plane", "z");
  const align = typeof document === "undefined" || document.querySelector<HTMLInputElement>("#modelPatAlign")?.checked !== false;
  const keep = typeof document === "undefined" || document.querySelector<HTMLInputElement>("#modelMirKeep")?.checked !== false;
  return {
    mode: mode === "polar" || mode === "path" ? mode : "linear",
    axis: axis === "x" || axis === "y" || axis === "pick" ? axis : "z",
    axisVec: axisVec ? [...axisVec] : null,
    align,
    plane: plane === "x" || plane === "y" || plane === "face" ? plane : "z",
    normal: mirrorNormal ? [...mirrorNormal] : null,
    keep,
    points: pathPoints.map((point) => [...point]),
    of: [...sourceIds],
  };
}

export function repeatModeNow(): PatternMode {
  return panelRepeatChoices().mode;
}

/** An edit, or Cancel of an edit, puts these choices back. The buttons are painted by the panel. */
export function setRepeatDraft(next: RepeatChoices) {
  axisVec = next.axisVec ? [...next.axisVec] : null;
  mirrorNormal = next.normal ? [...next.normal] : null;
  mirrorFaceLock = next.plane === "face" && next.normal != null;
  pathPoints = next.points.map((point) => [...point]);
  sourceIds = [...next.of];
}

/** A fresh Pattern or Mirror: the steps, the path, and a picked axis or face start empty. The number fields stay. */
export function resetRepeatDraft() {
  axisVec = null;
  mirrorNormal = null;
  mirrorFaceLock = false;
  pathPoints = [];
  sourceIds = [];
}

export function repeatSourceIds(): readonly number[] {
  return sourceIds;
}

export function setRepeatSources(ids: readonly number[]) {
  sourceIds = [...ids];
}

export function toggleRepeatSource(id: number) {
  const at = sourceIds.indexOf(id);
  if (at >= 0) sourceIds.splice(at, 1);
  else sourceIds.push(id);
}

export function pushPathPoint(point: Vec3) {
  pathPoints.push([point[0], point[1], point[2]]);
}

/** Drops the last path point and returns the one now last, or null when none remain. */
export function dropPathPoint(): Vec3 | null {
  pathPoints.pop();
  const last = pathPoints.at(-1);
  return last ? [...last] : null;
}

export function pathPointCount(): number {
  return pathPoints.length;
}

/** A typed or dragged path point edits the last one. With none yet, it becomes the first. */
export function setLastPathPoint(point: Vec3) {
  const next: Vec3 = [point[0], point[1], point[2]];
  if (pathPoints.length === 0) pathPoints.push(next);
  else pathPoints[pathPoints.length - 1] = next;
}

export function setHeldAxis(axis: Vec3 | null) {
  axisVec = axis ? [axis[0], axis[1], axis[2]] : null;
}

export function lockMirrorFace(normal: Vec3) {
  mirrorNormal = [normal[0], normal[1], normal[2]];
  mirrorFaceLock = true;
}

export function mirrorFaceLocked(): boolean {
  return mirrorFaceLock;
}

/** A drag of the plane point keeps the face's normal and leaves the face. */
export function unlockMirrorFace() {
  mirrorFaceLock = false;
}

// --- A4. Several faces offer Pattern and Mirror. The bar clicks the Features menu items. ---
registerContextAction({
  id: "pattern",
  label: "Pattern",
  when: ["faces"],
  order: 50,
  tip: "Repeat history steps",
  command: "model-pattern",
  toolbar: "#modelMenuPattern",
});
registerContextAction({
  id: "mirror",
  label: "Mirror",
  when: ["faces"],
  order: 55,
  tip: "Mirror history steps",
  command: "model-mirror",
  toolbar: "#modelMenuMirror",
});
