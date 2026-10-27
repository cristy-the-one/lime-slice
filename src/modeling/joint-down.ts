/**
 * Split to print, milestone 7 (docs/plan-split-connectors.md, D4 and section 10): Joint down. A piece keeps the
 * orientation the cuts were planned in unless it is set to joint: then its larger cut face, its joint, lies on the bed.
 * Pure TypeScript on a piece's mesh and the op's cuts; the plate applies the matrix it gives.
 */
import type { Vec3 } from "./partition.ts";

/** A row-major 3×3 matrix, as the plate keeps an object's orientation. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export type OrientChoice = "keep" | "joint";

/** A cut face of a piece: the cut it is on, its outward normal in the piece's frame, and its area in mm². */
export interface JointFace {
  /** Zero-based index of the cut. */
  cut: number;
  outward: Vec3;
  area: number;
}

/** A plane of the op, in the piece's own frame. */
export interface JointPlane {
  origin: Vec3;
  normal: Vec3;
}

/** Float32 mesh coordinates of a 500 mm part are good to a few 1e-5 mm; a face is on its plane to this. */
const ON_PLANE_MM = 1e-3;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/**
 * The faces of the piece that lie on a cut plane and face along or against its normal, from the mesh's triangles: each
 * face's area is the sum of its triangles'. A piece against a cut has one per cut it touches (two for a piece between
 * two cuts), largest first.
 */
export function jointFaces(positions: ArrayLike<number>, planes: readonly JointPlane[]): JointFace[] {
  const found = new Map<string, JointFace>();
  const units = planes.map((plane) => unit(plane.normal));
  for (let at = 0; at + 8 < positions.length; at += 9) {
    const a: Vec3 = [positions[at]!, positions[at + 1]!, positions[at + 2]!];
    const b: Vec3 = [positions[at + 3]!, positions[at + 4]!, positions[at + 5]!];
    const c: Vec3 = [positions[at + 6]!, positions[at + 7]!, positions[at + 8]!];
    const twice = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    const area = length(twice) / 2;
    if (area < 1e-12) continue;
    const facing = unit(twice);
    planes.forEach((plane, cut) => {
      const n = units[cut]!;
      const side = dot(facing, n);
      if (Math.abs(side) < 1 - 1e-6) return;
      for (const p of [a, b, c]) {
        if (Math.abs(dot([p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]], n)) > ON_PLANE_MM) return;
      }
      const sign = side > 0 ? 1 : -1;
      const key = `${cut}:${sign}`;
      const row = found.get(key) ?? { cut, outward: [n[0] * sign, n[1] * sign, n[2] * sign] as Vec3, area: 0 };
      row.area += area;
      found.set(key, row);
    });
  }
  return [...found.values()].sort((x, y) => y.area - x.area || x.cut - y.cut);
}

/** The orientation matrix whose third row is `up` and whose first row is `along` made square to it, right-handed. */
function frameOf(up: Vec3, along: Vec3): Mat3 {
  const z = unit(up);
  let x = unit([along[0] - z[0] * dot(along, z), along[1] - z[1] * dot(along, z), along[2] - z[2] * dot(along, z)]);
  if (length(x) < 0.5) x = unit(Math.abs(z[0]) < 0.9 ? cross(z, [1, 0, 0]) : cross(z, [0, 1, 0]));
  const y = cross(z, x);
  return [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]];
}

/**
 * The direction in the plane square to `up` that the piece's vertices spread along most: the long way of the piece as it
 * lies. A piece that spreads alike every way (a cube) has no long way, and `fallback` stands.
 */
function longWay(positions: ArrayLike<number>, up: Vec3, fallback: Vec3): Vec3 {
  const first = unit(Math.abs(up[0]) < 0.9 ? cross(up, [1, 0, 0]) : cross(up, [0, 1, 0]));
  const second = cross(up, first);
  // Each distinct vertex once: a triangulated square counts its diagonal's corners twice, which would tilt the axis.
  const seen = new Set<string>();
  const points: Vec3[] = [];
  for (let at = 0; at + 2 < positions.length; at += 3) {
    const key = `${Math.round(positions[at]! * 1e3)},${Math.round(positions[at + 1]! * 1e3)},${Math.round(positions[at + 2]! * 1e3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push([positions[at]!, positions[at + 1]!, positions[at + 2]!]);
  }
  const n = points.length;
  if (n === 0) return fallback;
  let mu = 0;
  let mv = 0;
  for (const p of points) {
    mu += dot(p, first);
    mv += dot(p, second);
  }
  mu /= n;
  mv /= n;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  for (const p of points) {
    const u = dot(p, first) - mu;
    const v = dot(p, second) - mv;
    suu += u * u;
    svv += v * v;
    suv += u * v;
  }
  if (Math.hypot(suu - svv, 2 * suv) < 1e-3 * Math.max(suu + svv, 1)) return fallback;
  const angle = 0.5 * Math.atan2(2 * suv, suu - svv);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [first[0] * c + second[0] * s, first[1] * c + second[1] * s, first[2] * c + second[2] * s];
}

export interface JointDown {
  /** The plate orientation (row-major, the third row the plate's up in the piece's frame). */
  orient: Mat3;
  /** The cut face that lies on the bed. */
  face: JointFace;
  /** More than one cut face, and the larger was chosen: the other's cut, for the sentence. */
  other: JointFace | null;
}

/**
 * The orientation that puts the piece's larger cut face on the bed, its outward normal along −Z. The piece's long way
 * lies along the bed's X, or along Y on a belt printer, whose length is unbounded and whose width is not. Null when the
 * piece has no cut face (a plain piece of a plane that missed it).
 */
export function jointDown(positions: ArrayLike<number>, planes: readonly JointPlane[], belt = false): JointDown | null {
  const faces = jointFaces(positions, planes);
  const face = faces[0];
  if (!face) return null;
  const up: Vec3 = [-face.outward[0], -face.outward[1], -face.outward[2]];
  const long = longWay(positions, up, belt ? [0, 1, 0] : [1, 0, 0]);
  // The long way lies along X, or along Y on a belt: the first row for the plate's X, so it is the second row for Y.
  const x = belt ? cross(long, up) : long;
  return { orient: frameOf(up, x), face, other: faces[1] ?? null };
}

/** The choice for piece `index` (zero-based): a single `"keep"` or `"joint"` is every piece's, a list is each piece's. */
export function choiceAt(orient: "keep" | readonly OrientChoice[] | undefined, index: number): OrientChoice {
  if (orient === undefined || orient === "keep") return "keep";
  return orient[index] === "joint" ? "joint" : "keep";
}

/** The piece orientation the card stores: "keep" when no piece is set to joint, else one choice a piece. */
export function storedOrient(choices: readonly OrientChoice[]): "keep" | OrientChoice[] {
  return choices.some((one) => one === "joint") ? [...choices] : "keep";
}

/** A matrix as the plate keeps it, with its rows read back: the rotation that puts `outward` along −Z, for the sentence. */
export function facesDown(orient: Mat3, outward: Vec3): number {
  return orient[6] * outward[0] + orient[7] * outward[1] + orient[8] * outward[2];
}
