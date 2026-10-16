import { deflateRawSync } from "node:zlib";

/** A small PNG of the mesh. The tool result is the file path, not the pixels. */

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
  const crc = crc32(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc);
  return out;
}

export type Camera = "top" | "front" | "iso";

export function renderMesh(positions: Float32Array, camera: Camera, longEdge = 768): { png: Uint8Array; width: number; height: number } {
  const edge = Math.max(32, Math.min(1024, Math.round(longEdge)));
  const width = edge;
  const height = edge;
  const depth = new Float32Array(width * height);
  depth.fill(Infinity);
  const color = new Uint8Array(width * height);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const project = (x: number, y: number, z: number): [number, number, number] => {
    const nx = (x - minX) / span;
    const ny = (y - minY) / span;
    const nz = (z - minZ) / span;
    if (camera === "top") return [nx, 1 - ny, nz];
    if (camera === "front") return [nx, 1 - nz, ny];
    const ix = nx * 0.86 - ny * 0.5;
    const iy = nz + ny * 0.25 + nx * 0.15;
    return [ix * 0.7 + 0.15, 1 - (iy * 0.7 + 0.1), nx + ny + nz];
  };
  const paint = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) => {
    const [x0, y0, z0] = project(ax, ay, az);
    const [x1, y1, z1] = project(bx, by, bz);
    const [x2, y2, z2] = project(cx, cy, cz);
    const px = [x0 * (width - 1), x1 * (width - 1), x2 * (width - 1)];
    const py = [y0 * (height - 1), y1 * (height - 1), y2 * (height - 1)];
    const minPx = Math.max(0, Math.floor(Math.min(...px)));
    const maxPx = Math.min(width - 1, Math.ceil(Math.max(...px)));
    const minPy = Math.max(0, Math.floor(Math.min(...py)));
    const maxPy = Math.min(height - 1, Math.ceil(Math.max(...py)));
    const area = (px[1]! - px[0]!) * (py[2]! - py[0]!) - (px[2]! - px[0]!) * (py[1]! - py[0]!);
    if (Math.abs(area) < 1e-6) return;
    for (let y = minPy; y <= maxPy; y += 1) {
      for (let x = minPx; x <= maxPx; x += 1) {
        const w0 = ((px[1]! - x) * (py[2]! - y) - (px[2]! - x) * (py[1]! - y)) / area;
        const w1 = ((px[2]! - x) * (py[0]! - y) - (px[0]! - x) * (py[2]! - y)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;
        const z = w0 * z0 + w1 * z1 + w2 * z2;
        const at = y * width + x;
        if (z < depth[at]!) {
          depth[at] = z;
          color[at] = 40 + Math.round(180 * (0.35 + 0.65 * Math.min(1, Math.max(0, z))));
        }
      }
    }
  };
  for (let i = 0; i + 8 < positions.length; i += 9) {
    paint(
      positions[i]!, positions[i + 1]!, positions[i + 2]!,
      positions[i + 3]!, positions[i + 4]!, positions[i + 5]!,
      positions[i + 6]!, positions[i + 7]!, positions[i + 8]!,
    );
  }
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const shade = color[y * width + x]! || 248;
      const at = row + 1 + x * 3;
      raw[at] = shade;
      raw[at + 1] = shade;
      raw[at + 2] = Math.min(255, shade + 8);
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", deflateRawSync(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return { png, width, height };
}
