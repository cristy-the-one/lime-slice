/**
 * MOCK. Not a slicer, and not printable.
 *
 * Belt printers stop here until the engine can rotate a mesh, slice it, and
 * map the toolpaths back (`docs/belt-slicing.md`). This builds a few tilted
 * outlines so the preview has a shape. `gcode` is always empty. Do not send it.
 */
import { beltAdvanceMm, type BeltSettings } from "./belt.ts";
import type { SliceResponse } from "./app/state.ts";
import { encodePaths, type PreviewPath } from "./preview-wire.ts";

export const BELT_MOCK_LAYER_NOTE = "Mock belt layer. Not a toolpath.";

const MAX_PLANES = 28;

export interface MockBeltInput {
  bounds: { min: number[]; max: number[] } | null;
  layerHeight: number;
  belt: BeltSettings;
  triangles: number;
}

/** A preview of slanted layer outlines. `gcode` is "" and `beltMock` is set. */
export function mockBeltSlice(input: MockBeltInput): SliceResponse {
  const box = input.bounds ?? { min: [0, 0, 0], max: [20, 20, 20] };
  const min = box.min.slice(0, 3);
  const max = box.max.slice(0, 3);
  if (max[0] - min[0] < 1) max[0] = min[0] + 20;
  if (max[1] - min[1] < 1) max[1] = min[1] + 20;
  if (max[2] - min[2] < 1) max[2] = min[2] + 20;
  const height = Math.min(0.4, Math.max(0.08, input.layerHeight || 0.2));
  const angle = (input.belt.angleDeg * Math.PI) / 180;
  const advance = beltAdvanceMm(height, input.belt.angleDeg);
  const depth = max[1] - min[1];
  const stride = depth + Math.max(0, input.belt.gapMm);
  const sign = input.belt.direction >= 0 ? 1 : -1;
  const copies = Math.max(1, Math.round(input.belt.copies));
  const planes = planeStations(min, max, angle, advance);
  const layers = planes.map((yC, index) => {
    const loop = clipBeltPlane(min, max, yC, angle) ?? fallbackQuad(min, max, angle);
    const paths: Partial<PreviewPath>[] = [];
    for (let copy = 0; copy < copies; copy++) {
      const dy = sign * copy * stride;
      paths.push({
        kind: "wall",
        strategy: "speed",
        pts: loop.map((p) => [p[0], p[1] + dy]),
        zs: loop.map((p) => p[2]),
        width: 0.45,
        speed: 30,
        effectiveSpeed: 30,
        toughness: 0,
        beadHeight: height,
      });
    }
    const zs = paths.flatMap((p) => p.zs ?? []);
    const z = zs.reduce((sum, value) => sum + value, 0) / Math.max(1, zs.length);
    return {
      index,
      z,
      height,
      note: BELT_MOCK_LAYER_NOTE,
      seconds: 0,
      speedWalls: 0,
      toughnessWalls: 0,
      supportPaths: 0,
      paths: encodePaths(paths),
    };
  });
  let maxY = max[1];
  let minY = min[1];
  if (sign > 0) maxY = max[1] + (copies - 1) * stride;
  else minY = min[1] - (copies - 1) * stride;
  return {
    coreMs: 0,
    baselineMs: 0,
    blend: "Mock belt preview",
    beltMock: true,
    mesh: {
      triangles: Math.max(0, input.triangles),
      min: [min[0], minY, min[2]],
      max: [max[0], maxY, max[2]],
    },
    sanity: { ok: true, notes: [], layers: layers.length, finalE: 0, extrusionLengthMm: 0 },
    gcode: "",
    layers,
  };
}

/** Contact stations along the belt, capped so the mock stays a sketch. */
function planeStations(min: number[], max: number[], angle: number, advance: number): number[] {
  const tan = Math.tan(angle);
  const first = min[1] + min[2] / tan;
  const last = max[1] + max[2] / tan;
  const span = Math.max(advance, last - first);
  const count = Math.min(MAX_PLANES, Math.max(1, Math.ceil(span / advance)));
  const step = span / count;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(first + (i + 0.5) * step);
  return out;
}

/**
 * The tilted plane `z = (yC - y) * tan(α)` clipped to the box.
 * Points wind around the plane. Null when the plane misses.
 */
export function clipBeltPlane(min: number[], max: number[], yC: number, angle: number): [number, number, number][] | null {
  const tan = Math.tan(angle);
  const f = (y: number, z: number) => (yC - y) * tan - z;
  const xs = [min[0], max[0]];
  const ys = [min[1], max[1]];
  const zs = [min[2], max[2]];
  const corners: [number, number, number][] = [];
  for (const x of xs) for (const y of ys) for (const z of zs) corners.push([x, y, z]);
  const hits: [number, number, number][] = [];
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      let diff = 0;
      for (let k = 0; k < 3; k++) if (corners[i][k] !== corners[j][k]) diff += 1;
      if (diff !== 1) continue;
      hits.push(...edgeHits(corners[i], corners[j], f(corners[i][1], corners[i][2]), f(corners[j][1], corners[j][2])));
    }
  }
  const unique = dedupe(hits);
  if (unique.length < 3) return null;
  const cx = unique.reduce((s, p) => s + p[0], 0) / unique.length;
  const cy = unique.reduce((s, p) => s + p[1], 0) / unique.length;
  const cz = unique.reduce((s, p) => s + p[2], 0) / unique.length;
  unique.sort((a, b) => {
    const au = a[0] - cx;
    const av = (a[1] - cy) + (a[2] - cz) * -tan;
    const bu = b[0] - cx;
    const bv = (b[1] - cy) + (b[2] - cz) * -tan;
    return Math.atan2(av, au) - Math.atan2(bv, bu);
  });
  unique.push(unique[0]);
  return unique;
}

function edgeHits(
  a: [number, number, number],
  b: [number, number, number],
  fa: number,
  fb: number,
): [number, number, number][] {
  const eps = 1e-9;
  if (Math.abs(fa) <= eps && Math.abs(fb) <= eps) return [a, b];
  if (Math.abs(fa) <= eps) return [a];
  if (Math.abs(fb) <= eps) return [b];
  if (fa * fb > 0) return [];
  const t = fa / (fa - fb);
  return [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]];
}

function dedupe(points: [number, number, number][]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const p of points) {
    if (out.some((q) => Math.abs(q[0] - p[0]) < 1e-4 && Math.abs(q[1] - p[1]) < 1e-4 && Math.abs(q[2] - p[2]) < 1e-4)) continue;
    out.push(p);
  }
  return out;
}

/** A tilted rectangle through the box when the clip misses. */
function fallbackQuad(min: number[], max: number[], angle: number): [number, number, number][] {
  const rise = Math.min(max[2] - min[2], (max[1] - min[1]) * Math.tan(angle));
  const z0 = min[2];
  const z1 = z0 + Math.max(rise, 0.5);
  return [
    [min[0], min[1], z1],
    [max[0], min[1], z1],
    [max[0], max[1], z0],
    [min[0], max[1], z0],
    [min[0], min[1], z1],
  ];
}
