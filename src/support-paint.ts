/**
 * Support paint: enforce and block disks the brush leaves on a part. Pure: no three.js, no DOM.
 *
 * The app keeps each disk in the object's source frame, the vertices as loaded, so paint
 * follows the part through moves, turns, and scale changes. The slice request sends the
 * disks in the mesh frame the engine is sent, the source scaled about its bounds centre,
 * before the pose (`docs/multi-object-and-support-painting.md`).
 */
import type { Mat3, RigidPose } from "./mesh-place.ts";

export type PaintKind = "enforce" | "block";

export type Vec3 = [number, number, number];

/** One dab of the brush in the source frame. `n` is the outward unit normal there. */
export interface PaintDisk {
  kind: PaintKind;
  p: Vec3;
  n: Vec3;
  r: number;
}

/** The engine's cap per object. */
export const MAX_PAINT_DISKS = 20000;
/** Radii the engine takes, mm on the placed part. */
export const PAINT_R_MIN_MM = 0.2;
export const PAINT_R_MAX_MM = 40;
/** The brush slider's range and default, mm on the placed part. */
export const BRUSH_R_MIN_MM = 0.5;
export const BRUSH_R_MAX_MM = 20;
export const BRUSH_R_DEFAULT_MM = 3;
/** A drag leaves a new disk once the hit moves this many radii from the last one. */
export const STROKE_STEP_R = 0.5;

/** How the source frame maps onto the mesh the engine is sent: scaled by `scale` about `centre`. */
export interface SourceFrame {
  centre: Vec3;
  scale: number;
}

const transposeTimes = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

function unit(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1];
}

/**
 * The disk a brush hit leaves. `point` and `normal` are in print millimetres on the bed,
 * `radius` is in millimetres on the placed part. Inverting `pose` gives the mesh frame,
 * and undoing the scale gives the source frame.
 */
export function diskFromHit(kind: PaintKind, point: Vec3, normal: Vec3, radius: number, pose: RigidPose, frame: SourceFrame): PaintDisk {
  const t = pose.translation;
  const mesh = transposeTimes(pose.rotation, [point[0] - t[0], point[1] - t[1], point[2] - t[2]]);
  const c = frame.centre;
  const p: Vec3 = [
    (mesh[0] + pose.pivot[0] - c[0]) / frame.scale + c[0],
    (mesh[1] + pose.pivot[1] - c[1]) / frame.scale + c[1],
    (mesh[2] + pose.pivot[2] - c[2]) / frame.scale + c[2],
  ];
  return { kind, p, n: unit(transposeTimes(pose.rotation, normal)), r: radius / frame.scale };
}

/** True when a drag that last left `last` should leave `next`: the first dab, or far enough along. */
export function strokeTakes(last: PaintDisk | undefined, next: PaintDisk): boolean {
  if (!last) return true;
  const d = Math.hypot(next.p[0] - last.p[0], next.p[1] - last.p[1], next.p[2] - last.p[2]);
  return d >= STROKE_STEP_R * Math.min(last.r, next.r);
}

/** `list` with `disk` appended, or `list` itself when the object already holds the cap. */
export function addDisk(list: readonly PaintDisk[], disk: PaintDisk): readonly PaintDisk[] {
  return list.length >= MAX_PAINT_DISKS ? list : [...list, disk];
}

/** A disk as the slice request sends it, in the engine's mesh frame. */
export interface WireDisk {
  kind: PaintKind;
  p: Vec3;
  n: Vec3;
  r: number;
}

const round = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** `d` in the mesh frame the engine is sent and the prepare view poses. */
export function inMeshFrame(d: PaintDisk, frame: SourceFrame): PaintDisk {
  const c = frame.centre;
  return {
    kind: d.kind,
    p: [(d.p[0] - c[0]) * frame.scale + c[0], (d.p[1] - c[1]) * frame.scale + c[1], (d.p[2] - c[2]) * frame.scale + c[2]],
    n: d.n,
    r: d.r * frame.scale,
  };
}

/**
 * `supportPaint` for the slice request, in the mesh frame. `{}` when there is no paint,
 * so the recipe key is untouched. Radii are clamped to what the engine takes.
 */
export function paintRequestFields(list: readonly PaintDisk[], frame: SourceFrame): { supportPaint?: WireDisk[] } {
  if (list.length === 0) return {};
  return {
    supportPaint: list.slice(0, MAX_PAINT_DISKS).map((source) => {
      const d = inMeshFrame(source, frame);
      return {
        kind: d.kind,
        p: d.p.map((v) => round(v, 4)) as Vec3,
        n: d.n.map((v) => round(v, 5)) as Vec3,
        r: round(Math.min(PAINT_R_MAX_MM, Math.max(PAINT_R_MIN_MM, d.r)), 4),
      };
    }),
  };
}

/** How the engine says the paint landed. */
export interface PaintTally {
  enforce: number;
  block: number;
  enforceUnhit: number;
  blockUnhit: number;
  supportsOff?: true;
}

export function paintCounts(list: readonly PaintDisk[]): { enforce: number; block: number } {
  let enforce = 0;
  for (const d of list) if (d.kind === "enforce") enforce += 1;
  return { enforce, block: list.length - enforce };
}

const disks = (n: number, kind = "") => `${n} ${kind}${kind ? " " : ""}disk${n === 1 ? "" : "s"}`;

/** One line for after a slice: what the paint did, and a warning when it cannot print or missed. */
export function tallyText(tally: PaintTally): { text: string; warn: boolean } {
  const missed = tally.enforceUnhit + tally.blockUnhit;
  const landed = `Paint: ${disks(tally.enforce, "enforce")}, ${disks(tally.block, "block")}.`;
  if (tally.supportsOff) return { text: `${landed} Supports are off, so the paint is kept but nothing prints.`, warn: true };
  if (missed > 0) return { text: `${landed} ${disks(missed)} missed the part and changed nothing there.`, warn: true };
  return { text: landed, warn: false };
}

/** Parse paint from a project file. `[]` when absent; a damaged entry fails the open. */
export function readPaint(value: unknown): PaintDisk[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PAINT_DISKS) return "The support paint in this project is damaged.";
  const out: PaintDisk[] = [];
  const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === "number" && Number.isFinite(c));
  for (const item of value) {
    const row = item as Partial<PaintDisk> | null;
    if (!row || (row.kind !== "enforce" && row.kind !== "block") || !vec(row.p) || !vec(row.n) || typeof row.r !== "number" || !(row.r > 0)) {
      return "The support paint in this project is damaged.";
    }
    out.push({ kind: row.kind, p: [...row.p], n: [...row.n], r: row.r });
  }
  return out;
}
