/** Client-side mesh placement. Positions are XYZ triples in millimetres. */
import { crc32 } from "./png-rgba.ts";

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
  const pos = readStl(bytes);
  return pos && settle(pos);
}

/** The vertices of an STL as written, before `settle` lowers them onto Z = 0. */
export function readStl(bytes: ArrayBuffer): Float32Array | null {
  const view = new DataView(bytes);
  if (bytes.byteLength >= 84) {
    const count = view.getUint32(80, true);
    if (bytes.byteLength === 84 + count * 50 && count > 0) {
      const pos = new Float32Array(count * 9);
      for (let i = 0; i < count; i++) {
        const base = 84 + i * 50 + 12;
        for (let v = 0; v < 9; v++) pos[i * 9 + v] = view.getFloat32(base + v * 4, true);
      }
      return pos;
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
  return new Float32Array(verts);
}

export function settle(pos: Float32Array) {
  settleBy(pos);
  return pos;
}

/** Lower `pos` in place so its lowest vertex sits on Z = 0. Returns how far it went down: its seat. */
export function settleBy(pos: Float32Array): number {
  let minZ = Infinity;
  for (let i = 2; i < pos.length; i += 3) if (pos[i] < minZ) minZ = pos[i];
  if (!Number.isFinite(minZ) || Math.abs(minZ) <= 1e-6) return 0;
  for (let i = 2; i < pos.length; i += 3) pos[i] -= minZ;
  return minZ;
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

export interface EulerDeg {
  rx: number;
  ry: number;
  rz: number;
}

/** Degrees into −180..180. A half turn is shown as 180. */
export function wrapDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let x = ((deg + 180) % 360 + 360) % 360 - 180;
  if (x === -180) return 180;
  return x === 0 ? 0 : x;
}

/** One decimal, the rotation field's step. */
export function formatDeg(deg: number): string {
  const rounded = Math.round(wrapDeg(deg) * 10) / 10;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(1);
}

/**
 * World-axis pose the rotate rings compose: Z, then Y, then X, applied on the left.
 * Typing Rx/Ry/Rz rebuilds this product. A ring drag is still one world-axis step;
 * the fields then show this decomposition of the matrix.
 */
export function eulerOrient(rx: number, ry: number, rz: number): Mat3 {
  return matMul(rotZ(rz), matMul(rotY(ry), rotX(rx)));
}

/**
 * Rx, Ry, Rz such that `eulerOrient` rebuilds `orient`.
 * At ±90° pitch, X and Z share one degree of freedom, so Rz is 0 and Rx holds the rest.
 */
export function orientEuler(orient: Mat3): EulerDeg {
  const sy = -orient[6];
  const cy = Math.hypot(orient[0], orient[3]);
  const toDeg = (rad: number) => wrapDeg((rad * 180) / Math.PI);
  if (cy > 1e-6) {
    return {
      rx: toDeg(Math.atan2(orient[7], orient[8])),
      ry: toDeg(Math.atan2(sy, cy)),
      rz: toDeg(Math.atan2(orient[3], orient[0])),
    };
  }
  return {
    rx: toDeg(Math.atan2(-orient[5], orient[4])),
    ry: toDeg(Math.atan2(sy, cy)),
    rz: 0,
  };
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

export function rotAbout(axis: [number, number, number], angle: number): Mat3 {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / len, y = axis[1] / len, z = axis[2] / len;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

/** Millimetres applied after the part is dropped onto Z = 0. Ignored while centered. */
export interface MeshShift {
  x: number;
  y: number;
  z: number;
}

/** Rigid move the slicer applies after load. Scale is already in the vertices. */
export interface RigidPose {
  rotation: Mat3;
  pivot: [number, number, number];
  translation: [number, number, number];
}

/** Scale about the source bounds center. Rotation and bed placement stay out of these vertices. */
export function scaledCanonical(source: Float32Array, scale: number) {
  const b = boundsOf(source);
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    out[i] = (source[i] - cx) * scale + cx;
    out[i + 1] = (source[i + 1] - cy) * scale + cy;
    out[i + 2] = (source[i + 2] - cz) * scale + cz;
  }
  return out;
}

/** The mesh as placed on the bed, with its bounds and the pose the slicer applies to [`scaledCanonical`]. */
export interface Placement {
  positions: Float32Array;
  bounds: Bounds;
  pose: RigidPose;
}

/** A placement with the scaled, unposed vertices it poses: what a renderer draws under `pose`. */
export interface PlacedPart extends Placement {
  canonical: Float32Array;
}

/**
 * [`transformPositions`] plus what every reader of the placed mesh needs.
 * The pose's translation is recovered from the placed mesh so settle and bed shift stay in one place.
 */
export function placeMesh(
  source: Float32Array,
  matrix: Mat3,
  scale: number,
  bedX: number,
  bedY: number,
  centered: boolean,
  shift?: MeshShift,
): Placement {
  const p = parked(source, matrix, scale);
  const move = bedMove(p, bedX, bedY, centered, shift);
  const d = [move.x, move.y, move.z];
  // A float32 sum is monotonic, so these are the bounds and first vertex of the shifted copy without making it.
  const at = (v: number, a: number) => (d[a] ? Math.fround(v + d[a]!) : v);
  const pivot = p.pivot;
  const x = (source[0] - pivot[0]) * scale;
  const y = (source[1] - pivot[1]) * scale;
  const z = (source[2] - pivot[2]) * scale;
  const rx = matrix[0] * x + matrix[1] * y + matrix[2] * z;
  const ry = matrix[3] * x + matrix[4] * y + matrix[5] * z;
  const rz = matrix[6] * x + matrix[7] * y + matrix[8] * z;
  let positions: Float32Array | undefined;
  return {
    get positions() {
      return (positions ??= shifted(p.positions, move));
    },
    bounds: {
      min: [at(p.bounds.min[0], 0), at(p.bounds.min[1], 1), at(p.bounds.min[2], 2)],
      max: [at(p.bounds.max[0], 0), at(p.bounds.max[1], 1), at(p.bounds.max[2], 2)],
    },
    pose: {
      rotation: matrix,
      pivot,
      translation: [at(p.positions[0]!, 0) - rx, at(p.positions[1]!, 1) - ry, at(p.positions[2]!, 2) - rz],
    },
  };
}

/** `pose` as the rows of a 3x4 affine matrix, so a renderer can apply it to the canonical mesh. */
export function poseAffine(pose: RigidPose): [number, number, number, number, number, number, number, number, number, number, number, number] {
  const m = pose.rotation;
  const [px, py, pz] = pose.pivot;
  const [tx, ty, tz] = pose.translation;
  return [
    m[0], m[1], m[2], tx - (m[0] * px + m[1] * py + m[2] * pz),
    m[3], m[4], m[5], ty - (m[3] * px + m[4] * py + m[5] * pz),
    m[6], m[7], m[8], tz - (m[6] * px + m[7] * py + m[8] * pz),
  ];
}

export function applyRigidPose(pos: Float32Array, pose: RigidPose) {
  const out = new Float32Array(pos.length);
  const m = pose.rotation;
  const [px, py, pz] = pose.pivot;
  const [tx, ty, tz] = pose.translation;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i] - px;
    const y = pos[i + 1] - py;
    const z = pos[i + 2] - pz;
    out[i] = m[0] * x + m[1] * y + m[2] * z + tx;
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z + ty;
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z + tz;
  }
  return out;
}

export function transformPositions(
  source: Float32Array,
  matrix: Mat3,
  scale: number,
  bedX: number,
  bedY: number,
  centered: boolean,
  shift?: MeshShift,
) {
  const p = parked(source, matrix, scale);
  return shifted(p.positions, bedMove(p, bedX, bedY, centered, shift));
}

/** XY shift that places the settled part's bounds on the bed center. Z stays on the plate. */
export function centeringShift(source: Float32Array, matrix: Mat3, scale: number, bedX: number, bedY: number): MeshShift {
  return bedMove(parked(source, matrix, scale), bedX, bedY, true);
}

/** The source scaled and turned about its bounds center, then settled on the plate: every placement before its bed shift. */
interface Parked {
  matrix: Mat3;
  scale: number;
  pivot: [number, number, number];
  positions: Float32Array;
  bounds: Bounds;
}

/**
 * The last parked mesh per source. An X/Y move reuses it, where re-turning the source took five passes over every
 * vertex, several times per move. Sources are never written after load, as the other per-source caches assume.
 */
const parkedBySource = new WeakMap<Float32Array, Parked>();

function parked(source: Float32Array, matrix: Mat3, scale: number): Parked {
  const held = parkedBySource.get(source);
  if (held && held.scale === scale && held.matrix.every((v, i) => v === matrix[i])) return held;
  const b = boundsOf(source);
  const pivot: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const [cx, cy, cz] = pivot;
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    const x = (source[i] - cx) * scale;
    const y = (source[i + 1] - cy) * scale;
    const z = (source[i + 2] - cz) * scale;
    out[i] = matrix[0] * x + matrix[1] * y + matrix[2] * z + cx;
    out[i + 1] = matrix[3] * x + matrix[4] * y + matrix[5] * z + cy;
    out[i + 2] = matrix[6] * x + matrix[7] * y + matrix[8] * z + cz;
  }
  settle(out);
  const next: Parked = { matrix: [...matrix] as Mat3, scale, pivot, positions: out, bounds: boundsOf(out) };
  parkedBySource.set(source, next);
  return next;
}

function bedMove(p: Parked, bedX: number, bedY: number, centered: boolean, shift?: MeshShift): MeshShift {
  if (centered) {
    return { x: bedX / 2 - (p.bounds.min[0] + p.bounds.max[0]) / 2, y: bedY / 2 - (p.bounds.min[1] + p.bounds.max[1]) / 2, z: 0 };
  }
  return { x: shift?.x ?? 0, y: shift?.y ?? 0, z: shift?.z ?? 0 };
}

function shifted(pos: Float32Array, move: MeshShift): Float32Array {
  const out = new Float32Array(pos);
  if (move.x || move.y || move.z) {
    for (let i = 0; i < out.length; i += 3) {
      out[i] += move.x;
      out[i + 1] += move.y;
      out[i + 2] += move.z;
    }
  }
  return out;
}

/**
 * What a placed part pokes out of. On a belt only the part's width across the
 * belt is a limit, as the engine checks it: the belt carries the part along Y,
 * and the run is checked against Max length when it slices. `bedX` is then the
 * belt width.
 */
export function offBed(b: Bounds, bedX: number, bedY: number, bedZ: number, belt = false) {
  const notes: string[] = [];
  if (belt) {
    if (b.max[0] - b.min[0] > bedX + 0.05) notes.push("wider than the belt");
    return notes;
  }
  if (b.min[0] < -0.05 || b.max[0] > bedX + 0.05) notes.push("outside the bed in X");
  if (b.min[1] < -0.05 || b.max[1] > bedY + 0.05) notes.push("outside the bed in Y");
  if (b.max[2] > bedZ + 0.05) notes.push("taller than the build volume");
  return notes;
}

/** `names`, when given, names each part's object in the file, as a split to print's export names its pieces. */
export function encode3mf(pos: Float32Array | readonly Float32Array[], names?: readonly string[]) {
  const parts = Array.isArray(pos) ? pos : [pos as Float32Array];
  const objectsXml: string[] = [];
  const itemsXml: string[] = [];
  let nextId = 1;
  for (const [index, part] of parts.entries()) {
    if (part.length < 9) continue;
    const verts: string[] = [];
    const tris: string[] = [];
    const vertIndex = new Map<string, number>();
    const addVert = (x: number, y: number, z: number) => {
      const key = `${x},${y},${z}`;
      const existing = vertIndex.get(key);
      if (existing !== undefined) return existing;
      const idx = verts.length;
      vertIndex.set(key, idx);
      verts.push(`<vertex x="${x}" y="${y}" z="${z}" />`);
      return idx;
    };
    for (let i = 0; i + 8 < part.length; i += 9) {
      const a = addVert(part[i], part[i + 1], part[i + 2]);
      const b = addVert(part[i + 3], part[i + 4], part[i + 5]);
      const c = addVert(part[i + 6], part[i + 7], part[i + 8]);
      if (a === b || b === c || a === c) continue;
      tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}" />`);
    }
    if (tris.length === 0) continue;
    const id = nextId++;
    const name = names?.[index];
    const named = name ? ` name="${name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"` : "";
    objectsXml.push(
      `<object id="${id}"${named} type="model"><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`,
    );
    itemsXml.push(`<item objectid="${id}" />`);
  }
  if (objectsXml.length === 0) {
    objectsXml.push(`<object id="1" type="model"><mesh><vertices></vertices><triangles></triangles></mesh></object>`);
    itemsXml.push(`<item objectid="1" />`);
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>${objectsXml.join("")}</resources>
  <build>${itemsXml.join("")}</build>
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
    // Each entry carries its CRC-32 and the version that reads it (2.0): a reader that checks them, as the slicer's
    // 3MF reader and PreForm's do, refused a file without them.
    const crc = crc32(data);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, named.length, true);
    local.set(named, 30);
    local.set(data, 30 + named.length);
    parts.push(local);
    const cen = new Uint8Array(46 + named.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
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
