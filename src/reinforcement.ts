/**
 * Reinforcement: surface paint regions (with depth or fill-through) and box/cylinder
 * volumes that raise infill density locally up to 100% (`docs/reinforcement.md`).
 * Pure: no three.js, no DOM.
 *
 * The app stores disks and volumes in the object's source frame, the vertices as loaded,
 * so reinforcement follows the part through moves, turns, and scale changes. The slice
 * request sends them in the mesh frame the engine receives, the source scaled about its
 * bounds centre, before the pose.
 */
import type { Mat3, RigidPose } from "./mesh-place.ts";
import { resolved } from "./strategy.ts";
import {
  BRUSH_R_DEFAULT_MM,
  BRUSH_R_MAX_MM,
  BRUSH_R_MIN_MM,
  MAX_PAINT_DISKS,
  PAINT_R_MAX_MM,
  PAINT_R_MIN_MM,
  STROKE_STEP_R,
  type SourceFrame,
  type Vec3,
} from "./support-paint.ts";

export { BRUSH_R_DEFAULT_MM, BRUSH_R_MAX_MM, BRUSH_R_MIN_MM, MAX_PAINT_DISKS };

/** Engine cap on reinforcement regions per object. */
export const MAX_REINFORCE_REGIONS = 64;
/** Engine bounds on paint depth in millimetres. */
export const REINFORCE_DEPTH_MIN_MM = 0.2;
export const REINFORCE_DEPTH_MAX_MM = 100;
export const REINFORCE_DEPTH_DEFAULT_MM = 5;
/** Engine bounds on box/cylinder dimensions in millimetres. */
export const REINFORCE_VOL_MIN_MM = 0.2;
export const REINFORCE_VOL_MAX_MM = 10_000;
/** Default density for a newly created reinforcement region (100% solid). */
export const REINFORCE_DENSITY_DEFAULT = 1;
/** Density slider step in UI (5%). */
export const REINFORCE_DENSITY_STEP = 0.05;

/** One dab of the reinforce brush in the source frame. `n` is the outward unit normal there. */
export interface ReinforceDisk {
  p: Vec3;
  n: Vec3;
  r: number;
}

export interface ReinforcePaintRegion {
  kind: "paint";
  density: number;
  depthMm: number;
  fillThrough?: boolean;
  disks: readonly ReinforceDisk[];
}

export interface ReinforceVolumeRegion {
  kind: "box" | "cylinder";
  density: number;
  center: Vec3;
  size: Vec3;
}

export type ReinforceRegion = ReinforcePaintRegion | ReinforceVolumeRegion;

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
 * The disk a reinforce brush hit leaves. `point` and `normal` are in print millimetres
 * on the bed, `radius` is in millimetres on the placed part. Inverting `pose` gives the
 * mesh frame, and undoing the scale gives the source frame.
 */
export function reinforceDiskFromHit(point: Vec3, normal: Vec3, radius: number, pose: RigidPose, frame: SourceFrame): ReinforceDisk {
  const t = pose.translation;
  const mesh = transposeTimes(pose.rotation, [point[0] - t[0], point[1] - t[1], point[2] - t[2]]);
  const c = frame.centre;
  const p: Vec3 = [
    (mesh[0] + pose.pivot[0] - c[0]) / frame.scale + c[0],
    (mesh[1] + pose.pivot[1] - c[1]) / frame.scale + c[1],
    (mesh[2] + pose.pivot[2] - c[2]) / frame.scale + c[2],
  ];
  return { p, n: unit(transposeTimes(pose.rotation, normal)), r: radius / frame.scale };
}

/** True when a drag that last left `last` should leave `next`: the first dab, or far enough along. */
export function reinforceStrokeTakes(last: ReinforceDisk | undefined, next: ReinforceDisk): boolean {
  if (!last) return true;
  const d = Math.hypot(next.p[0] - last.p[0], next.p[1] - last.p[1], next.p[2] - last.p[2]);
  return d >= STROKE_STEP_R * Math.min(last.r, next.r);
}

/** Total paint disks across all paint regions on the object. */
export function totalReinforceDisks(regions: readonly ReinforceRegion[]): number {
  let n = 0;
  for (const r of regions) {
    if (r.kind === "paint") n += r.disks.length;
  }
  return n;
}

/** Flatten all paint disks across all paint regions in `regions`. */
export function allReinforceDisks(regions: readonly ReinforceRegion[]): ReinforceDisk[] {
  const out: ReinforceDisk[] = [];
  for (const r of regions) {
    if (r.kind === "paint") out.push(...r.disks);
  }
  return out;
}

/** Create a new empty paint region at defaults (`density: 1`, `depthMm: 5`, `fillThrough: false`). */
export function emptyPaintRegion(
  density = REINFORCE_DENSITY_DEFAULT,
  depthMm = REINFORCE_DEPTH_DEFAULT_MM,
  fillThrough = false,
): ReinforcePaintRegion {
  return {
    kind: "paint",
    density: Math.min(1, Math.max(0, density)),
    depthMm: Math.min(REINFORCE_DEPTH_MAX_MM, Math.max(REINFORCE_DEPTH_MIN_MM, depthMm)),
    ...(fillThrough ? { fillThrough: true } : {}),
    disks: [],
  };
}

/**
 * Append `disk` to the active paint region at `activeIndex` (or create a first/new paint region
 * when `regions` has none or `activeIndex` is not a paint region). Respects `MAX_PAINT_DISKS`
 * and `MAX_REINFORCE_REGIONS`.
 */
export function addDiskToRegion(
  regions: readonly ReinforceRegion[],
  activeIndex: number,
  disk: ReinforceDisk,
  defaults?: { depthMm?: number; fillThrough?: boolean },
): { regions: readonly ReinforceRegion[]; activeIndex: number } {
  if (totalReinforceDisks(regions) >= MAX_PAINT_DISKS) {
    return { regions, activeIndex };
  }
  const current = regions[activeIndex];
  if (current && current.kind === "paint") {
    const updated: ReinforcePaintRegion = {
      ...current,
      disks: [...current.disks, disk],
    };
    const next = [...regions];
    next[activeIndex] = updated;
    return { regions: next, activeIndex };
  }
  if (regions.length >= MAX_REINFORCE_REGIONS) {
    return { regions, activeIndex };
  }
  const created: ReinforcePaintRegion = {
    ...emptyPaintRegion(REINFORCE_DENSITY_DEFAULT, defaults?.depthMm ?? REINFORCE_DEPTH_DEFAULT_MM, defaults?.fillThrough ?? false),
    disks: [disk],
  };
  return {
    regions: [...regions, created],
    activeIndex: regions.length,
  };
}

/** Drop empty paint regions (`kind === "paint" && disks.length === 0`). */
export function dropEmptyReinforce(regions: readonly ReinforceRegion[]): ReinforceRegion[] {
  return regions.filter((r) => r.kind !== "paint" || r.disks.length > 0);
}

/** `d` in the mesh frame the engine receives and the prepare view poses. */
export function reinforceInMeshFrame(d: ReinforceDisk, frame: SourceFrame): ReinforceDisk {
  const c = frame.centre;
  return {
    p: [(d.p[0] - c[0]) * frame.scale + c[0], (d.p[1] - c[1]) * frame.scale + c[1], (d.p[2] - c[2]) * frame.scale + c[2]],
    n: d.n,
    r: d.r * frame.scale,
  };
}

/** Volume region mapped from source frame to the mesh frame the engine receives. */
export function volumeInMeshFrame(v: ReinforceVolumeRegion, frame: SourceFrame): ReinforceVolumeRegion {
  const c = frame.centre;
  return {
    kind: v.kind,
    density: v.density,
    center: [
      (v.center[0] - c[0]) * frame.scale + c[0],
      (v.center[1] - c[1]) * frame.scale + c[1],
      (v.center[2] - c[2]) * frame.scale + c[2],
    ],
    size: [v.size[0] * frame.scale, v.size[1] * frame.scale, v.size[2] * frame.scale],
  };
}

export type WireReinforceRegion =
  | {
      kind: "paint";
      density: number;
      depthMm: number;
      fillThrough?: boolean;
      disks: { p: Vec3; n: Vec3; r: number }[];
    }
  | {
      kind: "box" | "cylinder";
      density: number;
      center: Vec3;
      size: Vec3;
    };

const round = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/**
 * The sparser strategy infill density on the object (0..1), used as the `Normal` end of
 * the per-region density slider and to decide whether every region is at or below the
 * strategy floor (`docs/reinforcement.md`).
 */
export function normalInfillDensity(opts: {
  blendKind: "single" | "weight" | "byLayer" | "byRegion";
  strategy: "speed" | "toughness";
  toughness: number;
  objectInfill?: number;
}): number {
  if (opts.objectInfill !== undefined && Number.isFinite(opts.objectInfill)) {
    return Math.min(1, Math.max(0, opts.objectInfill));
  }
  if (opts.blendKind === "single") {
    return opts.strategy === "toughness" ? 0.48 : 0.12;
  }
  if (opts.blendKind === "weight") {
    return resolved(opts.toughness).density;
  }
  return 0.12;
}

/**
 * `reinforcement` for the slice request, in the mesh frame. `{}` when there are no
 * non-empty regions or when every region's density is at or below `normalDensity`,
 * so the recipe key and G-code bytes are untouched when reinforcement has no effect.
 */
export function reinforcementRequestFields(
  list: readonly ReinforceRegion[],
  frame: SourceFrame,
  normalDensity = 0,
): { reinforcement?: WireReinforceRegion[] } {
  const nonEmpty = dropEmptyReinforce(list).slice(0, MAX_REINFORCE_REGIONS);
  if (nonEmpty.length === 0) return {};
  if (nonEmpty.every((r) => r.density <= normalDensity + 1e-6)) return {};

  let remainingDisks = MAX_PAINT_DISKS;
  const out: WireReinforceRegion[] = [];
  for (const reg of nonEmpty) {
    const density = round(Math.min(1, Math.max(0, reg.density)), 4);
    if (reg.kind === "paint") {
      const slice = reg.disks.slice(0, remainingDisks);
      remainingDisks -= slice.length;
      if (slice.length === 0) continue;
      const depthMm = round(Math.min(REINFORCE_DEPTH_MAX_MM, Math.max(REINFORCE_DEPTH_MIN_MM, reg.depthMm * frame.scale)), 4);
      out.push({
        kind: "paint",
        density,
        depthMm,
        ...(reg.fillThrough ? { fillThrough: true } : {}),
        disks: slice.map((source) => {
          const d = reinforceInMeshFrame(source, frame);
          return {
            p: d.p.map((v) => round(v, 4)) as Vec3,
            n: d.n.map((v) => round(v, 5)) as Vec3,
            r: round(Math.min(PAINT_R_MAX_MM, Math.max(PAINT_R_MIN_MM, d.r)), 4),
          };
        }),
      });
    } else {
      const m = volumeInMeshFrame(reg, frame);
      out.push({
        kind: m.kind,
        density,
        center: m.center.map((v) => round(v, 4)) as Vec3,
        size: m.size.map((v) => round(Math.min(REINFORCE_VOL_MAX_MM, Math.max(REINFORCE_VOL_MIN_MM, v)), 4)) as Vec3,
      });
    }
  }
  if (out.length === 0) return {};
  return { reinforcement: out };
}

/** Parse reinforcement from a `.lime` project file. `[]` when absent; a damaged entry fails the open. */
export function readReinforcement(value: unknown): ReinforceRegion[] | string {
  if (value === undefined) return [];
  const err = "The reinforcement in this project is damaged.";
  if (!Array.isArray(value) || value.length > MAX_REINFORCE_REGIONS) return err;
  const vec = (v: unknown): v is Vec3 =>
    Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === "number" && Number.isFinite(c));
  const out: ReinforceRegion[] = [];
  let totalDisks = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return err;
    const row = item as Record<string, unknown>;
    if (typeof row.density !== "number" || !Number.isFinite(row.density) || row.density < 0 || row.density > 1) {
      return err;
    }
    if (row.kind === "paint") {
      if (
        typeof row.depthMm !== "number" ||
        !Number.isFinite(row.depthMm) ||
        row.depthMm < REINFORCE_DEPTH_MIN_MM ||
        row.depthMm > REINFORCE_DEPTH_MAX_MM
      ) {
        return err;
      }
      if (row.fillThrough !== undefined && typeof row.fillThrough !== "boolean") {
        return err;
      }
      if (!Array.isArray(row.disks) || row.disks.length === 0) {
        return err;
      }
      totalDisks += row.disks.length;
      if (totalDisks > MAX_PAINT_DISKS) return err;
      const disks: ReinforceDisk[] = [];
      for (const d of row.disks) {
        const disk = d as Partial<ReinforceDisk> | null;
        if (
          !disk ||
          !vec(disk.p) ||
          !vec(disk.n) ||
          typeof disk.r !== "number" ||
          !Number.isFinite(disk.r) ||
          !(disk.r >= PAINT_R_MIN_MM && disk.r <= PAINT_R_MAX_MM)
        ) {
          return err;
        }
        const nLen = Math.hypot(disk.n[0], disk.n[1], disk.n[2]);
        if (!(nLen > 1e-6)) return err;
        disks.push({ p: [...disk.p], n: [...disk.n], r: disk.r });
      }
      out.push({
        kind: "paint",
        density: row.density,
        depthMm: row.depthMm,
        ...(row.fillThrough ? { fillThrough: true } : {}),
        disks,
      });
    } else if (row.kind === "box" || row.kind === "cylinder") {
      if (!vec(row.center) || !vec(row.size)) return err;
      if (!row.size.every((s) => s >= REINFORCE_VOL_MIN_MM && s <= REINFORCE_VOL_MAX_MM)) {
        return err;
      }
      out.push({
        kind: row.kind,
        density: row.density,
        center: [...row.center],
        size: [...row.size],
      });
    } else {
      return err;
    }
  }
  return out;
}
