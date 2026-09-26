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
export const MARGIN_SHADE = 0.38;

/** Kind slots the preview shader can color and hide. Later kinds share the last slot. */
export const MAX_KINDS = 32;

export const FEATURE_RGB: Record<string, [number, number, number]> = {
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
export const OTHER_RGB: [number, number, number] = [0.8, 0.8, 0.8];

/** Blend weight 0 to 1 and speed 20 to 200 mm/s map linearly between these. */
export const WEIGHT_RAMP: [number, number, number][] = [[0.94, 0.64, 0.13], [0.18, 0.77, 0.71]];
export const SPEED_RAMP: [number, number, number][] = [[0.25, 0.65, 0.75], [0.95, 0.45, 0.35]];

/** Machine XY + nozzle Z → scene, matching the centered ribbon mesh (Y up). */
export function scenePoint(x: number, y: number, z: number, cx: number, cy: number): [number, number, number] {
  return [x - cx, z, -(y - cy)];
}

export function meshCenter(min: number[], max: number[]): { cx: number; cy: number } {
  return { cx: (min[0] + max[0]) / 2, cy: (min[1] + max[1]) / 2 };
}

/**
 * Positions plus one (kind slot, blend weight, speed) triple per vertex.
 * The shader turns the triple into a color, so color mode and hidden
 * kinds change without rebuilding.
 */
export interface PreviewGeometry {
  ranges: LayerRange[];
  /** Kind name per slot in the info triples. */
  kinds: string[];
  /** Full-width dark margin under each bead. */
  ribbon: number[];
  ribbonInfo: number[];
  /** Narrower bright face. Drawn with a polygon offset so it stays on the margin. */
  face: number[];
  faceInfo: number[];
  travel: number[];
  travelInfo: number[];
}

export function buildPreviewGeometry(msg: Omit<GeomRequest, "id">): PreviewGeometry {
  const { cx, cy } = meshCenter(msg.min, msg.max);
  const kinds: string[] = [];
  const slot = (kind: string) => {
    let i = kinds.indexOf(kind);
    if (i < 0 && kinds.length < MAX_KINDS) i = kinds.push(kind) - 1;
    return i < 0 ? MAX_KINDS - 1 : i;
  };
  const ribbon: number[] = [];
  const ribbonInfo: number[] = [];
  const face: number[] = [];
  const faceInfo: number[] = [];
  const travel: number[] = [];
  const travelInfo: number[] = [];
  const ranges: LayerRange[] = [];
  for (const layer of msg.layers) {
    const ribbonStart = ribbon.length / 3;
    const faceStart = face.length / 3;
    const travelStart = travel.length / 3;
    for (const path of layer.paths) {
      if (path.pts.length < 2) continue;
      const isTravel = path.kind === "travel";
      const info: [number, number, number] = [slot(path.kind), path.toughness ?? 0, path.effectiveSpeed ?? path.speed ?? 0];
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
          pushLine(travel, travelInfo, a, b, info);
        } else {
          const beadH = path.beadHeight && path.beadHeight > 1e-6 ? path.beadHeight : layer.height;
          pushBead(
            ribbon,
            ribbonInfo,
            face,
            faceInfo,
            x0,
            y0,
            z0,
            x1,
            y1,
            z1,
            half,
            beadH && beadH > 1e-6 ? beadH : 0.2,
            info,
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
  return { ranges, kinds, ribbon, ribbonInfo, face, faceInfo, travel, travelInfo };
}

type Info = [number, number, number];

function pushLine(
  pos: number[],
  infos: number[],
  a: [number, number, number],
  b: [number, number, number],
  info: Info,
) {
  pos.push(...a, ...b);
  infos.push(...info, ...info);
}

function pushQuad(
  pos: number[],
  infos: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  info: Info,
) {
  pos.push(...a, ...b, ...d, ...b, ...c, ...d);
  for (let i = 0; i < 6; i++) infos.push(...info);
}

/**
 * Bead with layer-height thickness. The dark margin is a short prism
 * (top, bottom, and both long sides). The bright face stays on the top
 * so same-color neighbors still separate in plan view.
 */
function pushBead(
  marginPos: number[],
  marginInfo: number[],
  facePos: number[],
  faceInfo: number[],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  half: number,
  height: number,
  info: Info,
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
  pushQuad(marginPos, marginInfo, top[0], top[1], top[2], top[3], info);
  pushQuad(marginPos, marginInfo, bot[0], bot[3], bot[2], bot[1], info);
  pushQuad(marginPos, marginInfo, top[0], bot[0], bot[3], top[3], info);
  pushQuad(marginPos, marginInfo, top[1], top[2], bot[2], bot[1], info);
  pushQuad(facePos, faceInfo, face[0], face[1], face[2], face[3], info);
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
