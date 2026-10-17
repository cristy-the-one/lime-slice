import { deflateSync } from "node:zlib";

/** A small PNG of the mesh. The tool result is the file path, and the same pixels inline. */

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

export const CAMERAS = ["front", "back", "left", "right", "top", "bottom", "iso"] as const;
export type Camera = (typeof CAMERAS)[number];
type Vec = [number, number, number];

/** A camera by direction: `direction` runs from the part to the camera, and `up` is the way up the picture. */
export interface CameraSpec {
  direction: Vec;
  up?: Vec;
}

const ISO = 1 / Math.sqrt(3);

/** Named cameras sit on the part's own axes: front looks at the −Y face, from −Y toward +Y. */
const NAMED: Record<Camera, CameraSpec> = {
  front: { direction: [0, -1, 0] },
  back: { direction: [0, 1, 0] },
  left: { direction: [-1, 0, 0] },
  right: { direction: [1, 0, 0] },
  top: { direction: [0, 0, 1], up: [0, 1, 0] },
  bottom: { direction: [0, 0, -1], up: [0, 1, 0] },
  iso: { direction: [ISO, -ISO, ISO] },
};

function unit(v: Vec): Vec | null {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-9 && Number.isFinite(length) ? [v[0] / length, v[1] / length, v[2] / length] : null;
}

function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function isCamera(value: unknown): value is Camera {
  return typeof value === "string" && (CAMERAS as readonly string[]).includes(value);
}

/** The orthographic basis of a camera, or why it cannot look at the part. */
export function cameraBasis(camera: Camera | CameraSpec): { eye: Vec; right: Vec; up: Vec } | { reason: string } {
  const spec = typeof camera === "string" ? NAMED[camera] : camera;
  const eye = unit(spec.direction);
  if (!eye) return { reason: "A camera direction needs three numbers that are not all zero." };
  let up = spec.up ? unit(spec.up) : unit([0, 0, 1]);
  if (!up) return { reason: "A camera up needs three numbers that are not all zero." };
  if (Math.abs(dot(up, eye)) > 0.999) {
    if (spec.up) return { reason: "The up direction points along the camera direction." };
    up = [0, 1, 0];
  }
  const forward: Vec = [-eye[0], -eye[1], -eye[2]];
  const right = unit(cross(forward, up))!;
  return { eye, right, up: cross(right, forward) };
}

/** Orange, so a tool shape reads against the grey part. */
const GHOST: Vec = [255, 120, 20];

export function renderMesh(positions: Float32Array, camera: Camera | CameraSpec, longEdge = 768, ghost?: Float32Array): { png: Uint8Array; width: number; height: number } {
  const basis = cameraBasis(camera);
  if ("reason" in basis) throw new Error(basis.reason);
  const { eye, right, up } = basis;
  const edge = Math.max(32, Math.min(1024, Math.round(longEdge)));
  const width = edge;
  const height = edge;
  const depth = new Float32Array(width * height);
  depth.fill(-Infinity);
  const color = new Uint8Array(width * height);
  const ghostDepth = new Float32Array(width * height);
  ghostDepth.fill(-Infinity);
  const ghostShade = new Uint8Array(width * height);
  const project = (x: number, y: number, z: number): Vec => [
    x * right[0] + y * right[1] + z * right[2],
    x * up[0] + y * up[1] + z * up[2],
    x * eye[0] + y * eye[1] + z * eye[2],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const mesh of ghost ? [positions, ghost] : [positions]) {
    for (let i = 0; i + 2 < mesh.length; i += 3) {
      const point = project(mesh[i]!, mesh[i + 1]!, mesh[i + 2]!);
      if (point[0] < minX) minX = point[0];
      if (point[1] < minY) minY = point[1];
      if (point[0] > maxX) maxX = point[0];
      if (point[1] > maxY) maxY = point[1];
    }
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const margin = edge * 0.08;
  const fit = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const toPixel = (point: Vec): Vec => [
    (point[0] - midX) * fit + width / 2,
    height / 2 - (point[1] - midY) * fit,
    point[2],
  ];
  const paint = (a: Vec, b: Vec, c: Vec, shade: number, zbuf: Float32Array, out: Uint8Array) => {
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
        if (z > zbuf[at]!) {
          zbuf[at] = z;
          out[at] = shade;
        }
      }
    }
  };
  // Light from the upper left and a little in front, a weaker fill from the right, and a sky term: faces that look
  // the same way to the camera still read apart, a top from a side and one slope from the next.
  const toWorld = (r: number, u: number, e: number): Vec => unit([
    right[0] * r + up[0] * u + eye[0] * e,
    right[1] * r + up[1] * u + eye[1] * e,
    right[2] * r + up[2] * u + eye[2] * e,
  ])!;
  const key = toWorld(-0.5, 0.65, 0.6);
  const fill = toWorld(0.7, -0.1, 0.7);
  const shadeOf = (n: Vec) => {
    const lit = 0.22 + 0.55 * Math.max(0, dot(n, key)) + 0.18 * Math.max(0, dot(n, fill)) + 0.12 * (0.5 + 0.5 * n[2]);
    return 50 + Math.round(190 * Math.min(1, lit));
  };
  const normalAt = (mesh: Float32Array, i: number): Vec => {
    const ux = mesh[i + 3]! - mesh[i]!;
    const uy = mesh[i + 4]! - mesh[i + 1]!;
    const uz = mesh[i + 5]! - mesh[i + 2]!;
    const vx = mesh[i + 6]! - mesh[i]!;
    const vy = mesh[i + 7]! - mesh[i + 1]!;
    const vz = mesh[i + 8]! - mesh[i + 2]!;
    return unit([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]) ?? [0, 0, 1];
  };
  const draw = (mesh: Float32Array, zbuf: Float32Array, out: Uint8Array) => {
    for (let i = 0; i + 8 < mesh.length; i += 9) {
      const shade = shadeOf(normalAt(mesh, i));
      paint(project(mesh[i]!, mesh[i + 1]!, mesh[i + 2]!), project(mesh[i + 3]!, mesh[i + 4]!, mesh[i + 5]!), project(mesh[i + 6]!, mesh[i + 7]!, mesh[i + 8]!), shade, zbuf, out);
    }
  };
  draw(positions, depth, color);
  if (ghost) draw(ghost, ghostDepth, ghostShade);
  const ink = edgeInk(positions, project, toPixel, depth, width, height, fit, eye);
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      const pixel = y * width + x;
      const shade = color[pixel]! || 248;
      const dark = 1 - 0.78 * ink[pixel]! / 255;
      let rgb: Vec = [Math.round(shade * dark), Math.round(shade * dark), Math.round(Math.min(255, shade + 8) * dark)];
      const tint = ghostShade[pixel]!;
      if (tint) {
        // The tool shape shows through the part, fainter where the part is in front of it.
        const hidden = color[pixel]! > 0 && depth[pixel]! > ghostDepth[pixel]!;
        const alpha = hidden ? 0.35 : 0.7;
        const lit = tint / 220;
        rgb = [0, 1, 2].map((k) => Math.round(rgb[k]! * (1 - alpha) + GHOST[k]! * lit * alpha)) as Vec;
      }
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
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

/** Faces that meet at more than this many degrees draw their edge. A tessellated curve's facets meet at less. */
const CREASE_DEG = 25;

/**
 * How dark each pixel's edge line is, 0 to 255: a CAD drawing's lines over the shading. Edges come from the mesh: an
 * open boundary, a crease sharper than CREASE_DEG, or a silhouette, where one face looks at the camera and the other
 * away. Each is drawn only where nothing nearer covers it, against the depth buffer the faces left.
 */
function edgeInk(
  mesh: Float32Array,
  project: (x: number, y: number, z: number) => Vec,
  toPixel: (point: Vec) => Vec,
  depth: Float32Array,
  width: number,
  height: number,
  fit: number,
  eye: Vec,
): Uint8Array {
  const ink = new Uint8Array(width * height);
  const keyOf = (i: number) => `${Math.round(mesh[i]! * 1000)},${Math.round(mesh[i + 1]! * 1000)},${Math.round(mesh[i + 2]! * 1000)}`;
  const edges = new Map<string, { a: number; b: number; normals: Vec[] }>();
  for (let t = 0; t + 8 < mesh.length; t += 9) {
    const ux = mesh[t + 3]! - mesh[t]!;
    const uy = mesh[t + 4]! - mesh[t + 1]!;
    const uz = mesh[t + 5]! - mesh[t + 2]!;
    const vx = mesh[t + 6]! - mesh[t]!;
    const vy = mesh[t + 7]! - mesh[t + 1]!;
    const vz = mesh[t + 8]! - mesh[t + 2]!;
    const n = unit([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
    if (!n) continue;
    const corners = [t, t + 3, t + 6];
    for (let k = 0; k < 3; k += 1) {
      const a = corners[k]!;
      const b = corners[(k + 1) % 3]!;
      const ka = keyOf(a);
      const kb = keyOf(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const row = edges.get(key);
      if (row) row.normals.push(n);
      else edges.set(key, { a, b, normals: [n] });
    }
  }
  const crease = Math.cos((CREASE_DEG * Math.PI) / 180);
  // A line is hidden only behind something clearly nearer than it, more than a couple of pixels' depth.
  const bias = 2.5 / fit;
  for (const { a, b, normals } of edges.values()) {
    let strength = 0;
    if (normals.length !== 2) strength = 230;
    else {
      const [n1, n2] = normals as [Vec, Vec];
      const f1 = dot(n1, eye);
      const f2 = dot(n2, eye);
      if (f1 * f2 < 0) strength = 230;
      else if (dot(n1, n2) < crease && (f1 > 0 || f2 > 0)) strength = 170;
    }
    if (!strength) continue;
    const p = toPixel(project(mesh[a]!, mesh[a + 1]!, mesh[a + 2]!));
    const q = toPixel(project(mesh[b]!, mesh[b + 1]!, mesh[b + 2]!));
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])) * 1.5));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = Math.round(p[0] + (q[0] - p[0]) * t);
      const y = Math.round(p[1] + (q[1] - p[1]) * t);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const z = p[2] + (q[2] - p[2]) * t;
      const at = y * width + x;
      if (z + bias < depth[at]!) continue;
      if (strength > ink[at]!) ink[at] = strength;
    }
  }
  return ink;
}

function triple(value: unknown): Vec | null {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? value as Vec : null;
}

/** A camera from a name, or from `{camera}` or `{direction, up?}`. The label names the file and the view in the result. */
export function readCamera(raw: unknown): { label: string; camera: Camera | CameraSpec } | { reason: string } {
  if (raw === undefined || raw === null) return { label: "top", camera: "top" };
  const spec = typeof raw === "string" ? { camera: raw } : raw as { camera?: unknown; direction?: unknown; up?: unknown };
  if (!spec || typeof spec !== "object") return { reason: "A view is a camera name or a direction." };
  if (spec.direction !== undefined) {
    const direction = triple(spec.direction);
    if (!direction) return { reason: "A camera direction needs three numbers." };
    const up = spec.up === undefined ? undefined : triple(spec.up);
    if (spec.up !== undefined && !up) return { reason: "A camera up needs three numbers." };
    const made: CameraSpec = { direction, ...(up ? { up } : {}) };
    const basis = cameraBasis(made);
    return "reason" in basis ? basis : { label: "custom", camera: made };
  }
  if (spec.camera === undefined) return { label: "top", camera: "top" };
  if (!isCamera(spec.camera)) return { reason: `A camera is one of ${CAMERAS.join(", ")}.` };
  return { label: spec.camera, camera: spec.camera };
}
