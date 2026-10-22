/**
 * Layer paths as a file in the workspace. Coordinates stay in millimetres.
 */
import { deflateSync } from "node:zlib";

import { colorForPath, colorForReading, readsStress, type ColorMode } from "../src/colors.ts";
import { cellPieces, type StressCells } from "../src/sim/stress-cells.ts";
import { decodePaths, type PreviewPath } from "../src/preview-wire.ts";
import type { PathColumns } from "../src/preview-wire.ts";

export function layerPaths(columns: PathColumns, layerZ: number, simplifyMm: number): PreviewPath[] {
  return decodePaths(columns, layerZ).map((path) => ({
    ...path,
    pts: simplify(path.pts, simplifyMm),
  }));
}

function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3 || !(tol > 0)) return pts;
  const out: [number, number][] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = out[out.length - 1]!;
    const p = pts[i]!;
    if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= tol) out.push(p);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

export function pathsSvg(paths: readonly PreviewPath[]): string {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const [x, y] of path.pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }
  const pad = 1;
  const lines = paths.map((path) => {
    const points = path.pts.map(([x, y]) => `${x},${y}`).join(" ");
    return `<polyline data-kind="${path.kind}" fill="none" stroke="${colorForPath(path.kind, "feature")}" stroke-width="0.45" points="${points}" />`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}">`,
    ...lines,
    "</svg>",
  ].join("\n");
}

function hex(color: string): [number, number, number] {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A top view of the layer. `longEdge` is pixels on the longer side. */
/**
 * A sliced stress result to colour by: its cells, which plate objects it is
 * of, and the layer's height, for each bead's middle.
 */
export interface LayerStress {
  cells: StressCells;
  studied: (object: number) => boolean;
  layerZ: number;
}

export function pathsPng(paths: readonly PreviewPath[], longEdge: number, colourBy: ColorMode, stress?: LayerStress): Uint8Array {
  const edge = Math.max(32, Math.min(1024, Math.round(longEdge)));
  const width = edge;
  const height = edge;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const [x, y] of path.pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const fit = (edge - 8) / span;
  const px = (x: number, y: number): [number, number] => [
    Math.round(4 + (x - minX) * fit),
    Math.round(edge - 4 - (y - minY) * fit),
  ];
  const rgb = new Uint8Array(width * height * 3);
  rgb.fill(248);
  const plot = (x: number, y: number, color: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 3;
    rgb[at] = color[0];
    rgb[at + 1] = color[1];
    rgb[at + 2] = color[2];
  };
  const line = (a: [number, number], b: [number, number], color: [number, number, number]) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      plot(Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), color);
    }
  };
  for (const path of paths) {
    if (stress && readsStress(colourBy) && path.kind !== "travel" && stress.studied(path.object ?? 0)) {
      // Each bead cut where it crosses a cell line, each piece by its own cell.
      const z = stress.layerZ - (path.beadHeight || 0.2) / 2;
      for (let i = 1; i < path.pts.length; i += 1) {
        const a = path.pts[i - 1]!;
        const b = path.pts[i]!;
        for (const { t0, t1, reading } of cellPieces(stress.cells, a, b, z)) {
          const at = (t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          line(px(...at(t0)), px(...at(t1)), hex(colorForReading(colourBy, reading, stress.cells.peakMpa)));
        }
      }
      continue;
    }
    const color = hex(colorForPath(path.kind, colourBy, path.toughness, path.effectiveSpeed));
    for (let i = 1; i < path.pts.length; i += 1) line(px(...path.pts[i - 1]!), px(...path.pts[i]!), color);
  }
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), row + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
