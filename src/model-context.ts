import { boundsOf, type Bounds, type Mat3 } from "./mesh-place.ts";
import { placeObject, type PlateObject } from "./plate.ts";

type Vec3 = [number, number, number];

/** `q = m·p + t`. A rigid pose with its scale folded into `m`. */
export interface Affine {
  m: Mat3;
  t: Vec3;
}

/** A plate object Model mode draws as grey context. `matrix` takes its source vertices into the open solid's frame. */
export interface ContextPart {
  id: string;
  positions: Float32Array;
  matrix: Affine;
}

/** Source vertices to bed: `R·s·(p − c) + t`, with `c` the source bounds centre and `t` where that centre lands. */
function sourceToBed(obj: PlateObject, bedX: number, bedY: number): Affine {
  const { pose } = placeObject(obj, bedX, bedY);
  const r = pose.rotation;
  const s = obj.partScale;
  const m = r.map((value) => value * s) as Mat3;
  const [cx, cy, cz] = pose.pivot;
  return {
    m,
    t: [
      pose.translation[0] - (m[0] * cx + m[1] * cy + m[2] * cz),
      pose.translation[1] - (m[3] * cx + m[4] * cy + m[5] * cz),
      pose.translation[2] - (m[6] * cx + m[7] * cy + m[8] * cz),
    ],
  };
}

/** Bed back to the open solid's frame, which is its source frame moved so its bounds minimum is `solidBox.min`. */
function bedToSolid(open: PlateObject, solidBox: Bounds, bedX: number, bedY: number): Affine {
  const { m, t } = sourceToBed(open, bedX, bedY);
  // m is a rotation times a scale, so its inverse is its transpose over the scale squared.
  const scale2 = m[0] * m[0] + m[3] * m[3] + m[6] * m[6];
  const inverse = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]].map((value) => value / scale2) as Mat3;
  const source = boundsOf(open.sourcePos);
  const t0: Vec3 = [
    -(inverse[0] * t[0] + inverse[1] * t[1] + inverse[2] * t[2]),
    -(inverse[3] * t[0] + inverse[4] * t[1] + inverse[5] * t[2]),
    -(inverse[6] * t[0] + inverse[7] * t[1] + inverse[8] * t[2]),
  ];
  return {
    m: inverse,
    t: [t0[0] + solidBox.min[0] - source.min[0], t0[1] + solidBox.min[1] - source.min[1], t0[2] + solidBox.min[2] - source.min[2]],
  };
}

function then(first: Affine, second: Affine): Affine {
  const a = first.m;
  const b = second.m;
  const m = [] as number[];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) m.push(b[r * 3]! * a[c]! + b[r * 3 + 1]! * a[3 + c]! + b[r * 3 + 2]! * a[6 + c]!);
  }
  const t = [0, 1, 2].map((r) => b[r * 3]! * first.t[0] + b[r * 3 + 1]! * first.t[1] + b[r * 3 + 2]! * first.t[2] + second.t[r]!) as Vec3;
  return { m: m as Mat3, t };
}

/**
 * Every plate object except the open one, placed where it sits relative to the open solid.
 * The solid is drawn in its own CAD frame, so the open object's pose is undone and the others keep theirs.
 */
export function contextParts(objects: readonly PlateObject[], openId: string | null, solidBox: Bounds, bedX: number, bedY: number): ContextPart[] {
  const open = objects.find((obj) => obj.id === openId);
  if (!open || objects.length < 2) return [];
  const back = bedToSolid(open, solidBox, bedX, bedY);
  return objects
    .filter((obj) => obj.id !== open.id && obj.sourcePos.length >= 9)
    .map((obj) => ({ id: obj.id, positions: obj.sourcePos, matrix: then(sourceToBed(obj, bedX, bedY), back) }));
}

/** The box a part's source bounds take once `matrix` is applied. Exact for turns in quarter steps, a bound otherwise. */
export function partBox(source: Bounds, matrix: Affine): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner += 1) {
    const p = [corner & 1 ? source.max[0] : source.min[0], corner & 2 ? source.max[1] : source.min[1], corner & 4 ? source.max[2] : source.min[2]];
    for (let axis = 0; axis < 3; axis += 1) {
      const value = matrix.m[axis * 3]! * p[0]! + matrix.m[axis * 3 + 1]! * p[1]! + matrix.m[axis * 3 + 2]! * p[2]! + matrix.t[axis]!;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return { min, max };
}
