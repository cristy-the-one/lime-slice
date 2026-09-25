/** Client-side mesh placement. Positions are XYZ triples in millimetres. */

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function boundsOf(pos: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = pos[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

export function parseStl(bytes: ArrayBuffer): Float32Array | null {
  const view = new DataView(bytes);
  if (bytes.byteLength >= 84) {
    const count = view.getUint32(80, true);
    if (bytes.byteLength === 84 + count * 50 && count > 0) {
      const pos = new Float32Array(count * 9);
      for (let i = 0; i < count; i++) {
        const base = 84 + i * 50 + 12;
        for (let v = 0; v < 9; v++) pos[i * 9 + v] = view.getFloat32(base + v * 4, true);
      }
      return settle(pos);
    }
  }
  const head = new TextDecoder().decode(bytes.slice(0, 64)).trim().toLowerCase();
  if (!head.startsWith("solid")) return null;
  const text = new TextDecoder().decode(bytes);
  const verts: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith("vertex")) continue;
    const nums = trimmed.split(/\s+/).slice(1).map(Number);
    if (nums.length >= 3 && nums.every((n) => Number.isFinite(n))) verts.push(nums[0], nums[1], nums[2]);
  }
  if (verts.length < 9 || verts.length % 9 !== 0) return null;
  return settle(new Float32Array(verts));
}

export function settle(pos: Float32Array) {
  let minZ = Infinity;
  for (let i = 2; i < pos.length; i += 3) if (pos[i] < minZ) minZ = pos[i];
  if (Number.isFinite(minZ) && Math.abs(minZ) > 1e-6) {
    for (let i = 2; i < pos.length; i += 3) pos[i] -= minZ;
  }
  return pos;
}

export function encodeStl(pos: Float32Array, name: string) {
  const count = pos.length / 9;
  const out = new ArrayBuffer(84 + count * 50);
  const view = new DataView(out);
  const header = new TextEncoder().encode(`lime-slice ${name}`).slice(0, 80);
  new Uint8Array(out, 0, 80).set(header);
  view.setUint32(80, count, true);
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50;
    const ax = pos[i * 9], ay = pos[i * 9 + 1], az = pos[i * 9 + 2];
    const bx = pos[i * 9 + 3], by = pos[i * 9 + 4], bz = pos[i * 9 + 5];
    const cx = pos[i * 9 + 6], cy = pos[i * 9 + 7], cz = pos[i * 9 + 8];
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(base, nx / len, true);
    view.setFloat32(base + 4, ny / len, true);
    view.setFloat32(base + 8, nz / len, true);
    for (let v = 0; v < 9; v++) view.setFloat32(base + 12 + v * 4, pos[i * 9 + v], true);
  }
  return out;
}

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const ID_MATRIX: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ID: Mat3 = ID_MATRIX;

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const o = [] as number[];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
    }
  }
  return o as Mat3;
}

export function rotX(deg: number): Mat3 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(deg: number): Mat3 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(deg: number): Mat3 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Rotate `from` onto `to`. Both should be unit vectors. */
export function align(from: [number, number, number], to: [number, number, number]): Mat3 {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (dot > 0.9999) return [...ID];
  if (dot < -0.9999) {
    const axis: [number, number, number] = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return rotAbout(axis, Math.PI);
  }
  const axis: [number, number, number] = [
    from[1] * to[2] - from[2] * to[1],
    from[2] * to[0] - from[0] * to[2],
    from[0] * to[1] - from[1] * to[0],
  ];
  return rotAbout(axis, Math.acos(Math.max(-1, Math.min(1, dot))));
}

function rotAbout(axis: [number, number, number], angle: number): Mat3 {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / len, y = axis[1] / len, z = axis[2] / len;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

export function layFlatMatrix(pos: Float32Array): Mat3 {
  const areas = new Map<string, { n: [number, number, number]; area: number }>();
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
    const cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const area = Math.hypot(nx, ny, nz);
    if (area < 1e-8) continue;
    nx /= area; ny /= area; nz /= area;
    const key = `${nx.toFixed(2)},${ny.toFixed(2)},${nz.toFixed(2)}`;
    const hit = areas.get(key);
    if (hit) hit.area += area;
    else areas.set(key, { n: [nx, ny, nz], area });
  }
  let best: { n: [number, number, number]; area: number } | null = null;
  for (const entry of areas.values()) if (!best || entry.area > best.area) best = entry;
  if (!best) return [...ID];
  return align(best.n, [0, 0, -1]);
}

export function transformPositions(source: Float32Array, matrix: Mat3, scale: number, bedX: number, bedY: number, centered: boolean) {
  const out = new Float32Array(source.length);
  const b = boundsOf(source);
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  for (let i = 0; i < source.length; i += 3) {
    const x = (source[i] - cx) * scale;
    const y = (source[i + 1] - cy) * scale;
    const z = (source[i + 2] - cz) * scale;
    out[i] = matrix[0] * x + matrix[1] * y + matrix[2] * z + cx;
    out[i + 1] = matrix[3] * x + matrix[4] * y + matrix[5] * z + cy;
    out[i + 2] = matrix[6] * x + matrix[7] * y + matrix[8] * z + cz;
  }
  settle(out);
  if (centered) {
    const placed = boundsOf(out);
    const dx = bedX / 2 - (placed.min[0] + placed.max[0]) / 2;
    const dy = bedY / 2 - (placed.min[1] + placed.max[1]) / 2;
    for (let i = 0; i < out.length; i += 3) {
      out[i] += dx;
      out[i + 1] += dy;
    }
  }
  return out;
}

export function offBed(pos: Float32Array, bedX: number, bedY: number, bedZ: number) {
  const b = boundsOf(pos);
  const notes: string[] = [];
  if (b.min[0] < -0.05 || b.max[0] > bedX + 0.05) notes.push("outside the bed in X");
  if (b.min[1] < -0.05 || b.max[1] > bedY + 0.05) notes.push("outside the bed in Y");
  if (b.max[2] > bedZ + 0.05) notes.push("taller than the build volume");
  return notes;
}

export function encode3mf(pos: Float32Array) {
  const verts: string[] = [];
  const tris: string[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    const index = i / 3;
    verts.push(`<vertex x="${pos[i]}" y="${pos[i + 1]}" z="${pos[i + 2]}" />`);
    if (index % 3 === 2) {
      const a = index - 2;
      tris.push(`<triangle v1="${a}" v2="${a + 1}" v3="${a + 2}" />`);
    }
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1" type="model"><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object></resources>
  <build><item objectid="1" /></build>
</model>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  return storeZip([
    ["[Content_Types].xml", types],
    ["_rels/.rels", rels],
    ["3D/3dmodel.model", model],
  ]);
}

function storeZip(files: [string, string][]) {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = enc.encode(text);
    const named = enc.encode(name);
    const local = new Uint8Array(30 + named.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, 0, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, named.length, true);
    local.set(named, 30);
    local.set(data, 30 + named.length);
    parts.push(local);
    const cen = new Uint8Array(46 + named.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, named.length, true);
    cv.setUint32(42, offset, true);
    cen.set(named, 46);
    central.push(cen);
    offset += local.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
