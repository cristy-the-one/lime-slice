/// Build one merged ribbon mesh plus travel lines off the main thread.

export interface GeomPath {
  kind: string;
  pts: [number, number][];
  zs?: number[];
  width?: number;
  speed?: number;
  effectiveSpeed?: number;
  toughness?: number;
}

export interface GeomLayer {
  z: number;
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

interface Range {
  ribbonStart: number;
  ribbonCount: number;
  travelStart: number;
  travelCount: number;
}

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

self.onmessage = (event: MessageEvent<GeomRequest>) => {
  const msg = event.data;
  const hidden = new Set(msg.hidden);
  const cx = (msg.min[0] + msg.max[0]) / 2;
  const cy = (msg.min[1] + msg.max[1]) / 2;
  const ribbon: number[] = [];
  const ribbonColor: number[] = [];
  const travel: number[] = [];
  const travelColor: number[] = [];
  const ranges: Range[] = [];
  for (const layer of msg.layers) {
    const ribbonStart = ribbon.length / 3;
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
        const x0 = path.pts[i - 1][0] - cx;
        const y0 = path.pts[i - 1][1] - cy;
        const x1 = path.pts[i][0] - cx;
        const y1 = path.pts[i][1] - cy;
        if (isTravel) {
          pushLine(travel, travelColor, x0, z0, -y0, x1, z1, -y1, rgb);
        } else {
          pushRibbon(ribbon, ribbonColor, x0, y0, z0, x1, y1, z1, half, rgb);
        }
      }
    }
    ranges.push({
      ribbonStart,
      ribbonCount: ribbon.length / 3 - ribbonStart,
      travelStart,
      travelCount: travel.length / 3 - travelStart,
    });
  }
  const ribbonPos = new Float32Array(ribbon);
  const ribbonCol = new Float32Array(ribbonColor);
  const travelPos = new Float32Array(travel);
  const travelCol = new Float32Array(travelColor);
  const payload = { id: msg.id, ranges, ribbonPos, ribbonCol, travelPos, travelCol };
  (self as unknown as Worker).postMessage(payload, [
    ribbonPos.buffer,
    ribbonCol.buffer,
    travelPos.buffer,
    travelCol.buffer,
  ]);
};

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

function pushLine(pos: number[], color: number[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, rgb: [number, number, number]) {
  pos.push(x0, y0, z0, x1, y1, z1);
  color.push(...rgb, ...rgb);
}

function pushRibbon(
  pos: number[],
  color: number[],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  half: number,
  rgb: [number, number, number],
) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * half;
  const py = (dx / len) * half;
  const a: [number, number, number] = [x0 + px, z0, -(y0 + py)];
  const b: [number, number, number] = [x0 - px, z0, -(y0 - py)];
  const c: [number, number, number] = [x1 - px, z1, -(y1 - py)];
  const d: [number, number, number] = [x1 + px, z1, -(y1 + py)];
  pos.push(...a, ...b, ...d, ...b, ...c, ...d);
  for (let i = 0; i < 6; i++) color.push(...rgb);
}
