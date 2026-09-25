/** Ribbon meshes for the 3D preview. Built off the main thread. */

export interface GeomPath {
  kind: string;
  pts: [number, number][];
  zs?: number[];
  width?: number;
  /** Vertical bead size. Falls back to the layer height. */
  beadHeight?: number;
  speed?: number;
  effectiveSpeed?: number;
  toughness?: number;
}

export interface GeomLayer {
  z: number;
  /** Layer height in millimetres. Beads extrude down by this much. */
  height?: number;
  paths: GeomPath[];
}

export interface GeomRequest {
  id: number;
  layers: GeomLayer[];
  min: number[];
  max: number[];
  hidden: string[];
  showTravel: boolean;
  colorMode: "feature" | "weight" | "speed";
}

export interface LayerRange {
  ribbonStart: number;
  ribbonCount: number;
  faceStart: number;
  faceCount: number;
  travelStart: number;
  travelCount: number;
}

/** Fraction of bead half-width kept as the bright face. The rest is the dark margin. */
export const INNER_HALF_SCALE = 0.78;
const MARGIN_SHADE = 0.38;

const FEATURE: Record<string, [number, number, number]> = {
  outer: [0.95, 0.64, 0.13],
  wall: [0.95, 0.64, 0.13],
  inner: [0.93, 0.45, 0.2],
  top: [0.96, 0.82, 0.35],
  solid: [0.55, 0.62, 0.28],
  sparse: [0.18, 0.62, 0.58],
  infill: [0.18, 0.62, 0.58],
  "gap-fill": [0.45, 0.55, 0.7],
  bridge: [0.85, 0.35, 0.45],
  support: [0.45, 0.48, 0.58],
  "support-interface": [0.62, 0.55, 0.75],
  skirt: [0.7, 0.7, 0.7],
  travel: [0.55, 0.58, 0.66],
  "thin-wall": [0.9, 0.55, 0.4],
};

/** Machine XY + nozzle Z → scene, matching the centered ribbon mesh (Y up). */
export function scenePoint(x: number, y: number, z: number, cx: number, cy: number): [number, number, number] {
  return [x - cx, z, -(y - cy)];
}

export function meshCenter(min: number[], max: number[]): { cx: number; cy: number } {
  return { cx: (min[0] + max[0]) / 2, cy: (min[1] + max[1]) / 2 };
}

export interface PreviewGeometry {
  ranges: LayerRange[];
  /** Full-width dark margin under each bead. */
  ribbon: number[];
  ribbonColor: number[];
  /** Narrower bright face. Drawn with a polygon offset so it stays on the margin. */
  face: number[];
  faceColor: number[];
  travel: number[];
  travelColor: number[];
}

export function buildPreviewGeometry(msg: Omit<GeomRequest, "id">): PreviewGeometry {
  const hidden = new Set(msg.hidden);
  const { cx, cy } = meshCenter(msg.min, msg.max);
  const ribbon: number[] = [];
  const ribbonColor: number[] = [];
  const face: number[] = [];
  const faceColor: number[] = [];
  const travel: number[] = [];
  const travelColor: number[] = [];
  const ranges: LayerRange[] = [];
  for (const layer of msg.layers) {
    const ribbonStart = ribbon.length / 3;
    const faceStart = face.length / 3;
    const travelStart = travel.length / 3;
    for (const path of layer.paths) {
      if (path.pts.length < 2 || hidden.has(path.kind)) continue;
      const isTravel = path.kind === "travel";
      if (isTravel && !msg.showTravel) continue;
      const rgb = colorOf(path, msg.colorMode);
      const half = Math.max(0.05, (path.width ?? 0.45) / 2);
      for (let i = 1; i < path.pts.length; i++) {
        const z0 = path.zs && path.zs.length === path.pts.length ? path.zs[i - 1] : layer.z;
        const z1 = path.zs && path.zs.length === path.pts.length ? path.zs[i] : layer.z;
        const x0 = path.pts[i - 1][0];
        const y0 = path.pts[i - 1][1];
        const x1 = path.pts[i][0];
        const y1 = path.pts[i][1];
        if (isTravel) {
          const a = scenePoint(x0, y0, z0, cx, cy);
          const b = scenePoint(x1, y1, z1, cx, cy);
          pushLine(travel, travelColor, a, b, rgb);
        } else {
          const beadH = path.beadHeight && path.beadHeight > 1e-6 ? path.beadHeight : layer.height;
          pushBead(
            ribbon,
            ribbonColor,
            face,
            faceColor,
            x0,
            y0,
            z0,
            x1,
            y1,
            z1,
            half,
            beadH && beadH > 1e-6 ? beadH : 0.2,
            rgb,
            cx,
            cy,
          );
        }
      }
    }
    ranges.push({
      ribbonStart,
      ribbonCount: ribbon.length / 3 - ribbonStart,
      faceStart,
      faceCount: face.length / 3 - faceStart,
      travelStart,
      travelCount: travel.length / 3 - travelStart,
    });
  }
  return { ranges, ribbon, ribbonColor, face, faceColor, travel, travelColor };
}

function colorOf(path: GeomPath, mode: GeomRequest["colorMode"]): [number, number, number] {
  if (mode === "weight") {
    const t = path.toughness ?? 0;
    return [0.94 * (1 - t) + 0.18 * t, 0.64 * (1 - t) + 0.77 * t, 0.13 * (1 - t) + 0.71 * t];
  }
  if (mode === "speed") {
    const s = Math.max(0, Math.min(1, ((path.effectiveSpeed ?? path.speed ?? 0) - 20) / 180));
    return [0.25 + 0.7 * s, 0.45 + 0.2 * (1 - s), 0.75 - 0.4 * s];
  }
  return FEATURE[path.kind] ?? [0.8, 0.8, 0.8];
}

function shade(rgb: [number, number, number], k: number): [number, number, number] {
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

function pushLine(
  pos: number[],
  color: number[],
  a: [number, number, number],
  b: [number, number, number],
  rgb: [number, number, number],
) {
  pos.push(...a, ...b);
  color.push(...rgb, ...rgb);
}

function pushQuad(
  pos: number[],
  color: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  rgb: [number, number, number],
) {
  pos.push(...a, ...b, ...d, ...b, ...c, ...d);
  for (let i = 0; i < 6; i++) color.push(...rgb);
}

/**
 * Bead with layer-height thickness. The dark margin is a short prism
 * (top, bottom, and both long sides). The bright face stays on the top
 * so same-color neighbors still separate in plan view.
 */
function pushBead(
  marginPos: number[],
  marginColor: number[],
  facePos: number[],
  faceColor: number[],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  half: number,
  height: number,
  rgb: [number, number, number],
  cx: number,
  cy: number,
) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * half;
  const py = (dx / len) * half;
  const inner = half * INNER_HALF_SCALE;
  const ix = (-dy / len) * inner;
  const iy = (dx / len) * inner;
  const h = Math.max(0.04, height);
  const top = quadCorners(x0, y0, z0, x1, y1, z1, px, py, cx, cy);
  const bot = quadCorners(x0, y0, z0 - h, x1, y1, z1 - h, px, py, cx, cy);
  const face = quadCorners(x0, y0, z0, x1, y1, z1, ix, iy, cx, cy);
  const margin = shade(rgb, MARGIN_SHADE);
  pushQuad(marginPos, marginColor, top[0], top[1], top[2], top[3], margin);
  pushQuad(marginPos, marginColor, bot[0], bot[3], bot[2], bot[1], margin);
  pushQuad(marginPos, marginColor, top[0], bot[0], bot[3], top[3], margin);
  pushQuad(marginPos, marginColor, top[1], top[2], bot[2], bot[1], margin);
  pushQuad(facePos, faceColor, face[0], face[1], face[2], face[3], rgb);
}

function quadCorners(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  px: number,
  py: number,
  cx: number,
  cy: number,
): [[number, number, number], [number, number, number], [number, number, number], [number, number, number]] {
  const a = scenePoint(x0 + px, y0 + py, z0, cx, cy);
  const b = scenePoint(x0 - px, y0 - py, z0, cx, cy);
  const c = scenePoint(x1 - px, y1 - py, z1, cx, cy);
  const d = scenePoint(x1 + px, y1 + py, z1, cx, cy);
  return [a, b, c, d];
}
