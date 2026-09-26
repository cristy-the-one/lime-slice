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

export interface LayerGcode {
  /** Lines of the `;LAYER:<index>` block, or none when the G-code has no such block. */
  layer(index: number): GcodeLine[];
}

const LAYER_MARK = ";LAYER:";

/**
 * Finds every layer block once so a lookup slices one block instead of
 * splitting the whole file. Keeps the last parsed layer, since playback
 * asks for the same layer on every tick.
 */
export function indexLayerGcode(gcode: string): LayerGcode {
  const spans = new Map<number, [number, number]>();
  let at = gcode.indexOf(LAYER_MARK);
  while (at >= 0) {
    const next = gcode.indexOf(LAYER_MARK, at + LAYER_MARK.length);
    const index = layerNumber(gcode, at + LAYER_MARK.length);
    if (index != null && !spans.has(index)) spans.set(index, [at, next < 0 ? gcode.length : next]);
    at = next;
  }
  let cachedIndex = -1;
  let cachedLines: GcodeLine[] = [];
  return {
    layer(index) {
      if (index !== cachedIndex) {
        const span = spans.get(index);
        cachedLines = span ? parseBlock(gcode.slice(span[0], span[1])) : [];
        cachedIndex = index;
      }
      return cachedLines;
    },
  };
}

/** The layer number after the marker, when a space or line break ends it. */
function layerNumber(gcode: string, from: number): number | null {
  let end = from;
  while (end < gcode.length && gcode.charCodeAt(end) >= 48 && gcode.charCodeAt(end) <= 57) end++;
  const after = gcode[end];
  if (end === from || (after !== " " && after !== "\n")) return null;
  return Number(gcode.slice(from, end));
}

const WORD_X = /\sX(-?[0-9.]+)/;
const WORD_Y = /\sY(-?[0-9.]+)/;
const WORD_E = /\sE(-?[0-9.]+)/;
const WORD_F = /\sF(-?[0-9.]+)/;

function parseBlock(block: string): GcodeLine[] {
  let kind = "travel";
  const lines: GcodeLine[] = [];
  for (const raw of block.split("\n")) {
    const text = raw.trimEnd();
    if (!text) continue;
    const type = text.match(/^;\s*TYPE:(.+)$/i);
    if (type) kind = type[1].trim().toLowerCase();
    const move = /^G[0-3]\s/i.test(text) && /\sX[-0-9.]/.test(` ${text}`);
    const word = (re: RegExp) => {
      const hit = text.match(re);
      return hit ? Number(hit[1]) : undefined;
    };
    const feed = word(WORD_F);
    lines.push({ text, kind, move, x: word(WORD_X), y: word(WORD_Y), e: word(WORD_E), feed: feed != null ? feed / 60 : undefined });
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
