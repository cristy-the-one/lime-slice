/**
 * Seam paint: disks that pull a wall's start into the painted ball. Pure: no three.js, no DOM.
 *
 * Disks live in the object's source frame, like support paint, and the slice request sends
 * them in the mesh frame. An empty list is omitted, so the recipe key is untouched.
 */
import type { RigidPose } from "./mesh-place.ts";
import {
  addDisk,
  diskFromHit,
  inMeshFrame,
  MAX_PAINT_DISKS,
  PAINT_R_MAX_MM,
  PAINT_R_MIN_MM,
  strokeTakes,
  type PaintDisk,
  type SourceFrame,
  type Vec3,
} from "./support-paint.ts";

export type SeamDisk = Omit<PaintDisk, "kind">;

export { MAX_PAINT_DISKS, PAINT_R_MAX_MM, PAINT_R_MIN_MM, strokeTakes };

const round = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

export function seamDiskFromHit(point: Vec3, normal: Vec3, radius: number, pose: RigidPose, frame: SourceFrame): SeamDisk {
  const disk = diskFromHit("enforce", point, normal, radius, pose, frame);
  return { p: disk.p, n: disk.n, r: disk.r };
}

export function addSeamDisk(list: readonly SeamDisk[], disk: SeamDisk): readonly SeamDisk[] {
  const next = addDisk(list.map((d) => ({ ...d, kind: "enforce" as const })), { ...disk, kind: "enforce" });
  return next.length === list.length ? list : next.map(({ p, n, r }) => ({ p, n, r }));
}

export function seamInMeshFrame(d: SeamDisk, frame: SourceFrame): SeamDisk {
  const placed = inMeshFrame({ ...d, kind: "enforce" }, frame);
  return { p: placed.p, n: placed.n, r: placed.r };
}

export interface SeamWireDisk {
  p: Vec3;
  n: Vec3;
  r: number;
}

/** `seamPaint` for the slice request. `{}` when there is no paint. */
export function seamRequestFields(list: readonly SeamDisk[], frame: SourceFrame): { seamPaint?: SeamWireDisk[] } {
  if (list.length === 0) return {};
  return {
    seamPaint: list.slice(0, MAX_PAINT_DISKS).map((source) => {
      const d = seamInMeshFrame(source, frame);
      return {
        p: d.p.map((v) => round(v, 4)) as Vec3,
        n: d.n.map((v) => round(v, 5)) as Vec3,
        r: round(Math.min(PAINT_R_MAX_MM, Math.max(PAINT_R_MIN_MM, d.r)), 4),
      };
    }),
  };
}

/** Parse seam paint from a project file. `[]` when absent; a damaged entry fails the open. */
export function readSeamPaint(value: unknown): SeamDisk[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PAINT_DISKS) return "The seam paint in this project is damaged.";
  const out: SeamDisk[] = [];
  const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === "number" && Number.isFinite(c));
  for (const item of value) {
    const row = item as Partial<SeamDisk> | null;
    if (!row || !vec(row.p) || !vec(row.n) || typeof row.r !== "number" || !(row.r > 0)) {
      return "The seam paint in this project is damaged.";
    }
    out.push({ p: [...row.p], n: [...row.n], r: row.r });
  }
  return out;
}
