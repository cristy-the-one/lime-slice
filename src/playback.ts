/** In-layer playback built from preview paths, with G-code lines when the body is present. */

export interface PlayPoint {
  kind: string;
  x: number;
  y: number;
  z: number;
  /** Commanded feed, mm/s. */
  feed: number;
  /** Cumulative extrusion along this layer, mm of filament. */
  e: number;
  path: number;
  seg: number;
}

export interface GcodeLine {
  text: string;
  kind: string;
  move: boolean;
  x?: number;
  y?: number;
  e?: number;
  feed?: number;
}

const FILAMENT_AREA = Math.PI * (1.75 / 2) ** 2;

export function layerMoves(
  paths: { kind: string; pts: [number, number][]; zs?: number[]; width?: number; speed?: number; effectiveSpeed?: number }[],
  layerZ: number,
  layerH: number,
): PlayPoint[] {
  const out: PlayPoint[] = [];
  let e = 0;
  paths.forEach((path, pathIndex) => {
    const feed = path.effectiveSpeed || path.speed || 0;
    const width = path.width || 0.45;
    for (let i = 1; i < path.pts.length; i++) {
      const a = path.pts[i - 1];
      const b = path.pts[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (path.kind !== "travel" && len > 0) {
        e += (len * width * layerH) / FILAMENT_AREA;
      }
      const z = path.zs && path.zs.length === path.pts.length ? path.zs[i] : layerZ;
      out.push({ kind: path.kind, x: b[0], y: b[1], z, feed, e, path: pathIndex, seg: i });
    }
  });
  return out;
}

export function parseLayerGcode(gcode: string, layerIndex: number): GcodeLine[] {
  if (!gcode.includes(";LAYER:")) return [];
  const blocks = gcode.split(/(?=;LAYER:)/);
  const block = blocks.find((part) => part.startsWith(`;LAYER:${layerIndex} `) || part.startsWith(`;LAYER:${layerIndex}\n`));
  if (!block) return [];
  let kind = "travel";
  const lines: GcodeLine[] = [];
  for (const raw of block.split("\n")) {
    const text = raw.trimEnd();
    if (!text) continue;
    if (text.startsWith(";LAYER:") && lines.length > 0) break;
    const type = text.match(/^;\s*TYPE:(.+)$/i);
    if (type) kind = type[1].trim().toLowerCase();
    const move = /^G[0-3]\s/i.test(text) && /\sX[-0-9.]/.test(` ${text}`);
    const word = (name: string) => {
      const hit = text.match(new RegExp(`\\s${name}(-?[0-9.]+)`));
      return hit ? Number(hit[1]) : undefined;
    };
    lines.push({
      text,
      kind: text.startsWith(";") ? kind : kind,
      move,
      x: word("X"),
      y: word("Y"),
      e: word("E"),
      feed: word("F") != null ? (word("F") as number) / 60 : undefined,
    });
  }
  return lines;
}

/** Nearest XY motion line for a preview point. Arcs collapse several segments onto one command. */
export function matchGcodeLine(lines: GcodeLine[], point: PlayPoint | undefined): number {
  if (!point || lines.length === 0) return -1;
  let best = -1;
  let bestD = 1.5;
  lines.forEach((line, i) => {
    if (!line.move || line.x == null || line.y == null) return;
    const d = Math.hypot(line.x - point.x, line.y - point.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * Slow: above twice the median layer. Too fast: under the 8 s cooling floor.
 * The planner has no min-layer-time, so a small part can flag almost every layer.
 */
export function layerClass(seconds: number[], index: number, floorS = 8): "slow" | "fast" | "ok" {
  if (seconds.length === 0) return "ok";
  const sorted = [...seconds].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const value = seconds[index] ?? 0;
  if (value > Math.max(mid * 2, mid + 1)) return "slow";
  if (value > 0 && value < floorS) return "fast";
  return "ok";
}
