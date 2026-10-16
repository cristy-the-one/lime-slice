import { deflateSync } from "node:zlib";

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

/** Where the camera sits, so the nearest face wins and a face turned toward it is brighter. */
function viewDirection(camera: Camera): [number, number, number] {
  if (camera === "top") return [0, 0, 1];
  if (camera === "front") return [0, -1, 0];
  const scale = 1 / Math.sqrt(3);
  return [scale, -scale, scale];
}

function cameraPoint(x: number, y: number, z: number, camera: Camera): [number, number, number] {
  if (camera === "top") return [x, -y, z];
  if (camera === "front") return [x, z, -y];
  return [(x - y) * 0.866, z * 0.9 + (x + y) * 0.25, x - y + z];
}

export function renderMesh(positions: Float32Array, camera: Camera, longEdge = 768): { png: Uint8Array; width: number; height: number } {
  const edge = Math.max(32, Math.min(1024, Math.round(longEdge)));
  const width = edge;
  const height = edge;
  const depth = new Float32Array(width * height);
  depth.fill(-Infinity);
  const color = new Uint8Array(width * height);
  const light = viewDirection(camera);
  const projected: [number, number, number][] = [];
  for (let i = 0; i < positions.length; i += 3) {
    projected.push(cameraPoint(positions[i]!, positions[i + 1]!, positions[i + 2]!, camera));
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of projected) {
    if (point[0] < minX) minX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] > maxY) maxY = point[1];
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const margin = edge * 0.08;
  const fit = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const toPixel = (point: [number, number, number]): [number, number, number] => [
    (point[0] - midX) * fit + width / 2,
    height / 2 - (point[1] - midY) * fit,
    point[2],
  ];
  const paint = (a: [number, number, number], b: [number, number, number], c: [number, number, number], shade: number) => {
    const [x0, y0, z0] = toPixel(a);
    const [x1, y1, z1] = toPixel(b);
    const [x2, y2, z2] = toPixel(c);
    const px = [x0, x1, x2];
    const py = [y0, y1, y2];
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
        if (z > depth[at]!) {
          depth[at] = z;
          color[at] = shade;
        }
      }
    }
  };
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i]!;
    const ay = positions[i + 1]!;
    const az = positions[i + 2]!;
    const bx = positions[i + 3]!;
    const by = positions[i + 4]!;
    const bz = positions[i + 5]!;
    const cx = positions[i + 6]!;
    const cy = positions[i + 7]!;
    const cz = positions[i + 8]!;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    const facing = Math.max(0, (nx * light[0] + ny * light[1] + nz * light[2]) / length);
    const shade = 40 + Math.round(180 * (0.25 + 0.75 * facing));
    paint(cameraPoint(ax, ay, az, camera), cameraPoint(bx, by, bz, camera), cameraPoint(cx, cy, cz, camera), shade);
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
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return { png, width, height };
}
