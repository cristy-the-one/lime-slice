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

/** A box drawn in a colour: a highlighted or coloured label. A triangle whose centre is inside takes the colour. */
export interface Tint {
  min: Vec;
  max: Vec;
  rgb: Vec;
}

export interface RenderOptions {
  /** Shading blended across a curved surface's facets (default true); creases stay sharp. */
  smooth?: boolean;
  tints?: Tint[];
  /** Each triangle's face, as the solid's reply numbers them: a tint then takes whole faces, mostly inside its box. */
  faces?: ArrayLike<number>;
  /** Only the side of the plane the normal points away from is drawn; the inside shows where it is cut, in red. */
  section?: { point: Vec; normal: Vec };
  /** Empty pixels stay transparent (RGBA). The default preview is opaque RGB, which `render_view` keeps. */
  transparent?: boolean;
}

/** The colour the inside of a part shows where a section cuts it. */
const CUT: Vec = [205, 70, 60];
/** Facets that meet at less than this many degrees share their shading. */
const SMOOTH_DEG = 35;

export function renderMesh(positions: Float32Array, camera: Camera | CameraSpec, longEdge = 768, ghost?: Float32Array, options: RenderOptions = {}): { png: Uint8Array; width: number; height: number } {
  const basis = cameraBasis(camera);
  if ("reason" in basis) throw new Error(basis.reason);
  const { eye, right, up } = basis;
  const edge = Math.max(32, Math.min(1024, Math.round(longEdge)));
  const width = edge;
  const height = edge;
  const depth = new Float32Array(width * height);
  depth.fill(-Infinity);
  const color = new Uint8Array(width * height);
  /** 0, or 1 + the tint index; 255 for the inside of a cut. */
  const tintAt = new Uint8Array(width * height);
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
  const paint = (a: Vec, b: Vec, c: Vec, shade: number | Vec, zbuf: Float32Array, out: Uint8Array, tint = 0, side?: Vec) => {
    const shades: Vec = typeof shade === "number" ? [shade, shade, shade] : shade;
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
        if (side && w0 * side[0] + w1 * side[1] + w2 * side[2] > 0) continue;
        if (z > zbuf[at]!) {
          zbuf[at] = z;
          out[at] = Math.max(1, Math.round(w0 * shades[0] + w1 * shades[1] + w2 * shades[2]));
          if (out === color) tintAt[at] = tint;
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
  // The part: each corner shaded by the normals of the facets round it that bend less than SMOOTH_DEG from its own,
  // so a sweep or a sphere reads round and a box's edge stays sharp.
  const corners = options.smooth === false ? null : cornerNormals(positions);
  const tints = options.tints ?? [];
  const pads = tints.map((box) => Math.max(0.3, 0.06 * Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2])));
  const inBox = (i: number, b: number) => [0, 3, 6].every((o) => [0, 1, 2].every((k) => positions[i + o + k]! >= tints[b]!.min[k]! - pads[b]! && positions[i + o + k]! <= tints[b]!.max[k]! + pads[b]!));
  // With faces, a face takes the first tint whose box holds most of its area: a step's own faces lie in its box, and
  // a big face it only touches, a head beside a bill or a floor round a plinth, keeps its grey.
  const faceTint = new Map<number, number>();
  if (tints.length && options.faces) {
    const area = new Map<number, number[]>();
    for (let i = 0; i + 8 < positions.length; i += 9) {
      const face = options.faces[i / 9]!;
      const row = area.get(face) ?? new Array(tints.length + 1).fill(0);
      const e1 = [positions[i + 3]! - positions[i]!, positions[i + 4]! - positions[i + 1]!, positions[i + 5]! - positions[i + 2]!];
      const e2 = [positions[i + 6]! - positions[i]!, positions[i + 7]! - positions[i + 1]!, positions[i + 8]! - positions[i + 2]!];
      const a = Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!);
      row[tints.length] += a;
      tints.forEach((_, b) => { if (inBox(i, b)) row[b] += a; });
      area.set(face, row);
    }
    for (const [face, row] of area) {
      const hit = tints.findIndex((_, b) => row[b]! >= 0.6 * row[tints.length]!);
      if (hit >= 0) faceTint.set(face, Math.min(hit + 1, 254));
    }
  }
  const section = options.section ? { point: options.section.point, normal: unit(options.section.normal) ?? ([0, 0, 1] as Vec) } : null;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const own = normalAt(positions, i);
    const shades = (corners ? [0, 1, 2].map((k) => shadeOf(corners[i / 3 + k]!)) : [shadeOf(own), shadeOf(own), shadeOf(own)]) as Vec;
    let tint = 0;
    if (tints.length) {
      // All three corners inside, a little padded: a long sliver of a floor that only crosses the box stays as it is,
      // and a smooth curve that bulges past its points' box still takes the colour.
      if (options.faces) tint = faceTint.get(options.faces[i / 9]!) ?? 0;
      else {
        const hit = tints.findIndex((_, b) => inBox(i, b));
        if (hit >= 0) tint = Math.min(hit + 1, 254);
      }
    }
    let side: Vec | undefined;
    if (section) {
      side = [0, 1, 2].map((k) => (positions[i + 3 * k]! - section.point[0]) * section.normal[0] + (positions[i + 3 * k + 1]! - section.point[1]) * section.normal[1] + (positions[i + 3 * k + 2]! - section.point[2]) * section.normal[2]) as Vec;
      if (side.every((d) => d > 0)) continue;
      // A facet facing away from the camera is the part's inside, seen through the cut.
      if (dot(own, eye) < 0) tint = 255;
    }
    paint(project(positions[i]!, positions[i + 1]!, positions[i + 2]!), project(positions[i + 3]!, positions[i + 4]!, positions[i + 5]!), project(positions[i + 6]!, positions[i + 7]!, positions[i + 8]!), shades, depth, color, tint, side);
  }
  if (ghost) draw(ghost, ghostDepth, ghostShade);
  const ink = edgeInk(positions, project, toPixel, depth, width, height, fit, eye, section);
  const transparent = options.transparent === true;
  const channels = transparent ? 4 : 3;
  const raw = new Uint8Array((width * channels + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * channels + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * channels;
      const pixel = y * width + x;
      if (transparent && color[pixel]! === 0 && ghostShade[pixel]! === 0) continue;
      const shade = color[pixel]! || 248;
      const dark = 1 - 0.78 * ink[pixel]! / 255;
      let rgb: Vec = [Math.round(shade * dark), Math.round(shade * dark), Math.round(Math.min(255, shade + 8) * dark)];
      const tinted = color[pixel] ? tintAt[pixel]! : 0;
      if (tinted) {
        const hue = tinted === 255 ? CUT : tints[tinted - 1]!.rgb;
        const lit = tinted === 255 ? 0.85 : Math.min(1.15, shade / 200);
        rgb = [0, 1, 2].map((k) => Math.round(Math.min(255, hue[k]! * lit) * dark)) as Vec;
      }
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
      if (transparent) raw[at + 3] = 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = transparent ? 6 : 2;
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

/** Each triangle corner's normal: the mean of the facets at that point within SMOOTH_DEG of the corner's own facet. */
function cornerNormals(mesh: Float32Array): Vec[] {
  const count = Math.floor(mesh.length / 9);
  const facet: Vec[] = [];
  for (let t = 0; t < count; t += 1) {
    const i = t * 9;
    const u = [mesh[i + 3]! - mesh[i]!, mesh[i + 4]! - mesh[i + 1]!, mesh[i + 5]! - mesh[i + 2]!];
    const v = [mesh[i + 6]! - mesh[i]!, mesh[i + 7]! - mesh[i + 1]!, mesh[i + 8]! - mesh[i + 2]!];
    facet.push(unit([u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]) ?? [0, 0, 1]);
  }
  const at = new Map<string, number[]>();
  const keyOf = (i: number) => `${Math.round(mesh[i]! * 1000)},${Math.round(mesh[i + 1]! * 1000)},${Math.round(mesh[i + 2]! * 1000)}`;
  for (let t = 0; t < count; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const key = keyOf(t * 9 + k * 3);
      const row = at.get(key);
      if (row) row.push(t);
      else at.set(key, [t]);
    }
  }
  const limit = Math.cos((SMOOTH_DEG * Math.PI) / 180);
  const out: Vec[] = new Array(count * 3);
  for (let t = 0; t < count; t += 1) {
    const own = facet[t]!;
    for (let k = 0; k < 3; k += 1) {
      const sum: Vec = [0, 0, 0];
      for (const other of at.get(keyOf(t * 9 + k * 3)) ?? [t]) {
        const n = facet[other]!;
        if (dot(n, own) < limit) continue;
        sum[0] += n[0];
        sum[1] += n[1];
        sum[2] += n[2];
      }
      out[t * 3 + k] = unit(sum) ?? own;
    }
  }
  return out;
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
  section: { point: Vec; normal: Vec } | null = null,
): Uint8Array {
  const away = (x: number, y: number, z: number) => !!section && (x - section.point[0]) * section.normal[0] + (y - section.point[1]) * section.normal[1] + (z - section.point[2]) * section.normal[2] > 0;
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
  const smoothSeams = seamPartners(mesh, edges, crease);
  // A line is hidden only behind something clearly nearer than it, more than a couple of pixels' depth.
  const bias = 2.5 / fit;
  for (const [key, { a, b, normals }] of edges) {
    let strength = 0;
    if (normals.length === 1 && smoothSeams.has(key)) continue;
    if (normals.length !== 2) strength = 230;
    else {
      const [n1, n2] = normals as [Vec, Vec];
      const f1 = dot(n1, eye);
      const f2 = dot(n2, eye);
      if (f1 * f2 < 0) strength = 230;
      else if (dot(n1, n2) < crease && (f1 > 0 || f2 > 0)) strength = 170;
    }
    if (!strength) continue;
    // A section's cut-away side draws no lines.
    if (away(mesh[a]!, mesh[a + 1]!, mesh[a + 2]!) || away(mesh[b]!, mesh[b + 1]!, mesh[b + 2]!)) continue;
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

/**
 * The one-sided edges that are really a smooth join: two kernel faces tessellated apart meet along an edge whose points
 * do not match, so each side's edge has no partner by position. An edge is a smooth seam when an edge of another
 * triangle lies along it (parallel, on the same line, overlapping) and the two triangles meet at less than the crease.
 */
function seamPartners(mesh: Float32Array, edges: Map<string, { a: number; b: number; normals: Vec[] }>, crease: number): Set<string> {
  const open: { key: string; p: Vec; q: Vec; n: Vec }[] = [];
  for (const [key, row] of edges) {
    if (row.normals.length !== 1) continue;
    open.push({ key, p: [mesh[row.a]!, mesh[row.a + 1]!, mesh[row.a + 2]!], q: [mesh[row.b]!, mesh[row.b + 1]!, mesh[row.b + 2]!], n: row.normals[0]! });
  }
  const smooth = new Set<string>();
  if (open.length < 2) return smooth;
  let longest = 0;
  for (const e of open) longest = Math.max(longest, Math.hypot(e.q[0] - e.p[0], e.q[1] - e.p[1], e.q[2] - e.p[2]));
  const cell = Math.max(longest, 1e-3);
  const keyOf = (v: Vec) => `${Math.floor(v[0] / cell)},${Math.floor(v[1] / cell)},${Math.floor(v[2] / cell)}`;
  const grid = new Map<string, number[]>();
  open.forEach((e, i) => {
    const mid: Vec = [(e.p[0] + e.q[0]) / 2, (e.p[1] + e.q[1]) / 2, (e.p[2] + e.q[2]) / 2];
    const k = keyOf(mid);
    const row = grid.get(k);
    if (row) row.push(i);
    else grid.set(k, [i]);
  });
  const off = (x: Vec, p: Vec, d: Vec, len: number) => {
    const t = ((x[0] - p[0]) * d[0] + (x[1] - p[1]) * d[1] + (x[2] - p[2]) * d[2]) / len;
    const c: Vec = [p[0] + d[0] * t / len, p[1] + d[1] * t / len, p[2] + d[2] * t / len];
    return { t, gap: Math.hypot(x[0] - c[0], x[1] - c[1], x[2] - c[2]) };
  };
  open.forEach((e, i) => {
    if (smooth.has(e.key)) return;
    const d: Vec = [e.q[0] - e.p[0], e.q[1] - e.p[1], e.q[2] - e.p[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 1e-9)) return;
    const mid: Vec = [(e.p[0] + e.q[0]) / 2, (e.p[1] + e.q[1]) / 2, (e.p[2] + e.q[2]) / 2];
    const [cx, cy, cz] = keyOf(mid).split(",").map(Number) as [number, number, number];
    const tol = Math.max(1e-3, len * 0.02);
    for (let x = cx - 1; x <= cx + 1; x += 1) for (let y = cy - 1; y <= cy + 1; y += 1) for (let z = cz - 1; z <= cz + 1; z += 1) {
      for (const j of grid.get(`${x},${y},${z}`) ?? []) {
        if (j === i) continue;
        const o = open[j]!;
        const sp = off(o.p, e.p, d, len);
        const sq = off(o.q, e.p, d, len);
        // On the same line, and overlapping this edge by more than a sliver.
        if (sp.gap > tol || sq.gap > tol) continue;
        const lo = Math.max(0, Math.min(sp.t, sq.t));
        const hi = Math.min(len, Math.max(sp.t, sq.t));
        if (hi - lo < len * 0.2) continue;
        if (dot(e.n, o.n) < crease) continue;
        smooth.add(e.key);
        smooth.add(o.key);
      }
    }
  });
  return smooth;
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
