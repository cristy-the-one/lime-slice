import { deflateSync } from "node:zlib";
import { applyPose, type Affine } from "../src/model-space.ts";
import { BACKGROUND_REFUSAL, isBackground } from "../src/pose-anim.ts";

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
  /** A fixed box in the same space as the mesh, projected for this camera. */
  fit?: { min: Vec; max: Vec };
  /** Convert rendered positions back to the frame of tint boxes. */
  tintFrame?: Affine;
  /** Shading blended across a curved surface's facets (default true); creases stay sharp. */
  smooth?: boolean;
  tints?: Tint[];
  /** Triangle ranges in the joined mesh; unlike tint boxes these do not bleed between overlapping parts. */
  partTints?: { start: number; end: number; rgb: Vec }[];
  /** Each triangle's face, as the solid's reply numbers them: a tint then takes whole faces, mostly inside its box. */
  faces?: ArrayLike<number>;
  /** Only the side of the plane the normal points away from is drawn; the inside shows where it is cut, in red. */
  section?: { point: Vec; normal: Vec };
  /** Empty pixels stay transparent (RGBA). The default preview is opaque RGB, which `render_view` keeps. */
  transparent?: boolean;
  /** Return RGB pixels too, for animation encoding. */
  pixels?: boolean;
  /** The colour of empty pixels; default BACKGROUND. `transparent` still leaves them empty. */
  background?: Vec;
  /** Size the picture to what is drawn, the long side `longEdge`, in place of a square. Not with `fit`. */
  crop?: boolean;
}

/** Empty pixels unless a caller chooses: the pale paper every preview has always had. */
export const BACKGROUND: Vec = [248, 248, 255];

/** A caller's `background`, or why it is refused. */
export function readBackground(raw: unknown): { rgb: Vec } | { reason: string } {
  if (!isBackground(raw)) return { reason: BACKGROUND_REFUSAL };
  const n = parseInt(raw.slice(1), 16);
  return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255] };
}

/**
 * Parts drawn together with no colour of their own take these, by their place in the assembly: an animation's frames
 * tell the parts apart. Ten muted hues that stay apart under the shading and through a GIF's 3/3/2 palette; an
 * eleventh part takes the first again.
 */
export const PART_PALETTE: readonly Vec[] = [
  [78, 121, 167], [242, 142, 43], [89, 161, 79], [225, 87, 89], [118, 183, 178],
  [237, 201, 72], [176, 122, 161], [255, 157, 167], [156, 117, 95], [186, 176, 172],
];
/** The palette colour of the part at `index` (0-based) of the parts drawn. */
export const partPaletteColour = (index: number): Vec => PART_PALETTE[index % PART_PALETTE.length]!;

/** The colour the inside of a part shows where a section cuts it. */
const CUT: Vec = [205, 70, 60];
/** Facets that meet at less than this many degrees share their shading. */
const SMOOTH_DEG = 35;

export function renderMesh(positions: Float32Array, camera: Camera | CameraSpec, longEdge = 768, ghost?: Float32Array, options: RenderOptions = {}): { png: Uint8Array; width: number; height: number; rgb?: Uint8Array } {
  const basis = cameraBasis(camera);
  if ("reason" in basis) throw new Error(basis.reason);
  const { eye, right, up } = basis;
  const r0 = right[0], r1 = right[1], r2 = right[2];
  const u0 = up[0], u1 = up[1], u2 = up[2];
  const e0 = eye[0], e1 = eye[1], e2 = eye[2];
  const edge = Math.max(32, Math.min(1024, Math.round(longEdge)));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number, z: number) => {
    const px = x * r0 + y * r1 + z * r2;
    const py = x * u0 + y * u1 + z * u2;
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  };
  if (options.fit) {
    for (const x of [options.fit.min[0], options.fit.max[0]])
      for (const y of [options.fit.min[1], options.fit.max[1]])
        for (const z of [options.fit.min[2], options.fit.max[2]]) include(x, y, z);
  } else {
    for (const mesh of ghost ? [positions, ghost] : [positions])
      for (let i = 0; i + 2 < mesh.length; i += 3) include(mesh[i]!, mesh[i + 1]!, mesh[i + 2]!);
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const margin = edge * 0.08;
  // Cropped, the long side of what is drawn takes the long edge and the short side takes what it needs: a plate
  // seen from the front is a strip, not a square that is nine tenths paper. The scale is the square picture's.
  const scale = (edge - margin * 2) / Math.max(spanX, spanY);
  const crop = options.crop === true && !options.fit;
  const width = crop ? Math.max(32, Math.min(edge, Math.ceil(spanX * scale + margin * 2))) : edge;
  const height = crop ? Math.max(32, Math.min(edge, Math.ceil(spanY * scale + margin * 2))) : edge;
  const pixels = width * height;
  const depth = new Float32Array(pixels);
  depth.fill(-Infinity);
  const color = new Uint8Array(pixels);
  /** 0, or 1 + the tint index; 0xffffffff for the inside of a cut. */
  const tintAt = new Uint32Array(pixels);
  const ghostDepth = ghost ? new Float32Array(pixels).fill(-Infinity) : null;
  const ghostShade = ghost ? new Uint8Array(pixels) : null;
  /** The part's triangle in front at each pixel, or -1: an edge line is drawn only where one of its own triangles shows. */
  const owner = new Int32Array(pixels).fill(-1);
  const fit = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const halfW = width / 2;
  const halfH = height / 2;
  const paintTri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    sh0: number, sh1: number, sh2: number,
    zbuf: Float32Array,
    out: Uint8Array,
    isPart: boolean,
    tint: number,
    hasSide: boolean,
    sd0: number, sd1: number, sd2: number,
    id: number,
  ) => {
    const x0 = (ax * r0 + ay * r1 + az * r2 - midX) * fit + halfW;
    const y0 = halfH - (ax * u0 + ay * u1 + az * u2 - midY) * fit;
    const z0 = ax * e0 + ay * e1 + az * e2;
    const x1 = (bx * r0 + by * r1 + bz * r2 - midX) * fit + halfW;
    const y1 = halfH - (bx * u0 + by * u1 + bz * u2 - midY) * fit;
    const z1 = bx * e0 + by * e1 + bz * e2;
    const x2 = (cx * r0 + cy * r1 + cz * r2 - midX) * fit + halfW;
    const y2 = halfH - (cx * u0 + cy * u1 + cz * u2 - midY) * fit;
    const z2 = cx * e0 + cy * e1 + cz * e2;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area > -1e-6 && area < 1e-6) return;
    let loX = x0 < x1 ? x0 : x1;
    if (x2 < loX) loX = x2;
    let hiX = x0 > x1 ? x0 : x1;
    if (x2 > hiX) hiX = x2;
    let loY = y0 < y1 ? y0 : y1;
    if (y2 < loY) loY = y2;
    let hiY = y0 > y1 ? y0 : y1;
    if (y2 > hiY) hiY = y2;
    const minPx = loX > 0 ? Math.floor(loX) : 0;
    const maxPx = hiX < width - 1 ? Math.ceil(hiX) : width - 1;
    const minPy = loY > 0 ? Math.floor(loY) : 0;
    const maxPy = hiY < height - 1 ? Math.ceil(hiY) : height - 1;
    if (minPx > maxPx || minPy > maxPy) return;
    const invArea = 1 / area;
    const dw0dx = (y1 - y2) * invArea;
    const dw0dy = (x2 - x1) * invArea;
    const dw1dx = (y2 - y0) * invArea;
    const dw1dy = (x0 - x2) * invArea;
    let w0Row = ((x1 - minPx) * (y2 - minPy) - (x2 - minPx) * (y1 - minPy)) * invArea;
    let w1Row = ((x2 - minPx) * (y0 - minPy) - (x0 - minPx) * (y2 - minPy)) * invArea;
    for (let y = minPy; y <= maxPy; y += 1) {
      let w0 = w0Row;
      let w1 = w1Row;
      const rowBase = y * width;
      for (let x = minPx; x <= maxPx; x += 1) {
        const w2 = 1 - w0 - w1;
        if (w0 >= -0.01 && w1 >= -0.01 && w2 >= -0.01) {
          if (!hasSide || w0 * sd0 + w1 * sd1 + w2 * sd2 <= 0) {
            const z = w0 * z0 + w1 * z1 + w2 * z2;
            const at = rowBase + x;
            if (z > zbuf[at]!) {
              zbuf[at] = z;
              const s = Math.round(w0 * sh0 + w1 * sh1 + w2 * sh2);
              out[at] = s > 1 ? s : 1;
              if (isPart) {
                tintAt[at] = tint;
                owner[at] = id;
              }
            }
          }
        }
        w0 += dw0dx;
        w1 += dw1dx;
      }
      w0Row += dw0dy;
      w1Row += dw1dy;
    }
  };
  // Light from the upper left and a little in front, a weaker fill from the right, and a sky term: faces that look
  // the same way to the camera still read apart, a top from a side and one slope from the next.
  const toWorld = (r: number, u: number, e: number): Vec => unit([
    r0 * r + u0 * u + e0 * e,
    r1 * r + u1 * u + e1 * e,
    r2 * r + u2 * u + e2 * e,
  ])!;
  const key = toWorld(-0.5, 0.65, 0.6);
  const fill = toWorld(0.7, -0.1, 0.7);
  const kx = key[0], ky = key[1], kz = key[2];
  const fx = fill[0], fy = fill[1], fz = fill[2];
  const shade3 = (nx: number, ny: number, nz: number) => {
    const dk = nx * kx + ny * ky + nz * kz;
    const df = nx * fx + ny * fy + nz * fz;
    const lit = 0.22 + 0.55 * (dk > 0 ? dk : 0) + 0.18 * (df > 0 ? df : 0) + 0.12 * (0.5 + 0.5 * nz);
    return 50 + Math.round(190 * (lit < 1 ? lit : 1));
  };
  // Compute welded vertex IDs and facet normals once, shared by smooth shading and CAD edge ink.
  const triCount = Math.floor(positions.length / 9);
  const topo = buildMeshTopology(positions, triCount);
  const corners = options.smooth === false ? null : cornerNormalsFrom(topo, triCount);
  const tints = options.tints ?? [];
  const partTints = options.partTints ?? [];
  const pads = tints.map((box) => Math.max(0.3, 0.06 * Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2])));
  const inBox = (i: number, b: number) => [0, 3, 6].every((o) => {
    const p: Vec = [positions[i + o]!, positions[i + o + 1]!, positions[i + o + 2]!];
    const point = options.tintFrame ? applyPose(options.tintFrame, p) : p;
    return [0, 1, 2].every((k) => point[k]! >= tints[b]!.min[k]! - pads[b]! && point[k]! <= tints[b]!.max[k]! + pads[b]!);
  });
  // With faces, a face takes the first tint whose box holds most of its area: a step's own faces lie in its box, and
  // a big face it only touches, a head beside a bill or a floor round a plinth, keeps its grey.
  const faceTint = new Map<number, number>();
  if (tints.length && options.faces) {
    const area = new Map<number, number[]>();
    for (let i = 0; i + 8 < positions.length; i += 9) {
      const face = options.faces[i / 9]!;
      const row = area.get(face) ?? new Array(tints.length + 1).fill(0);
      const e1x = positions[i + 3]! - positions[i]!, e1y = positions[i + 4]! - positions[i + 1]!, e1z = positions[i + 5]! - positions[i + 2]!;
      const e2x = positions[i + 6]! - positions[i]!, e2y = positions[i + 7]! - positions[i + 1]!, e2z = positions[i + 8]! - positions[i + 2]!;
      const a = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
      row[tints.length] += a;
      for (let b = 0; b < tints.length; b += 1) if (inBox(i, b)) row[b] += a;
      area.set(face, row);
    }
    for (const [face, row] of area) {
      const hit = tints.findIndex((_, b) => row[b]! >= 0.6 * row[tints.length]!);
      if (hit >= 0) faceTint.set(face, Math.min(hit + 1, 254));
    }
  }
  const section = options.section ? { point: options.section.point, normal: unit(options.section.normal) ?? ([0, 0, 1] as Vec) } : null;
  const spx = section ? section.point[0] : 0, spy = section ? section.point[1] : 0, spz = section ? section.point[2] : 0;
  const snx = section ? section.normal[0] : 0, sny = section ? section.normal[1] : 0, snz = section ? section.normal[2] : 0;
  const fNormals = topo.facetNormals;
  for (let t = 0; t < triCount; t += 1) {
    const i = t * 9;
    const ax = positions[i]!, ay = positions[i + 1]!, az = positions[i + 2]!;
    const bx = positions[i + 3]!, by = positions[i + 4]!, bz = positions[i + 5]!;
    const cx = positions[i + 6]!, cy = positions[i + 7]!, cz = positions[i + 8]!;
    const nx = fNormals[t * 3]!, ny = fNormals[t * 3 + 1]!, nz = fNormals[t * 3 + 2]!;
    let sh0: number, sh1: number, sh2: number;
    if (corners) {
      const ci = t * 9;
      sh0 = shade3(corners[ci]!, corners[ci + 1]!, corners[ci + 2]!);
      sh1 = shade3(corners[ci + 3]!, corners[ci + 4]!, corners[ci + 5]!);
      sh2 = shade3(corners[ci + 6]!, corners[ci + 7]!, corners[ci + 8]!);
    } else {
      sh0 = sh1 = sh2 = shade3(nx, ny, nz);
    }
    let tint = 0;
    if (tints.length) {
      // All three corners inside, a little padded: a long sliver of a floor that only crosses the box stays as it is,
      // and a smooth curve that bulges past its points' box still takes the colour.
      if (options.faces) tint = faceTint.get(options.faces[t]!) ?? 0;
      else {
        for (let b = 0; b < tints.length; b += 1) {
          if (inBox(i, b)) { tint = Math.min(b + 1, 254); break; }
        }
      }
    }
    if (partTints.length) {
      for (let p = 0; p < partTints.length; p += 1) {
        if (t >= partTints[p]!.start && t < partTints[p]!.end) { tint = tints.length + p + 1; break; }
      }
    }
    let sd0 = 0, sd1 = 0, sd2 = 0;
    if (section) {
      sd0 = (ax - spx) * snx + (ay - spy) * sny + (az - spz) * snz;
      sd1 = (bx - spx) * snx + (by - spy) * sny + (bz - spz) * snz;
      sd2 = (cx - spx) * snx + (cy - spy) * sny + (cz - spz) * snz;
      if (sd0 > 0 && sd1 > 0 && sd2 > 0) continue;
      // A facet facing away from the camera is the part's inside, seen through the cut.
      if (nx * e0 + ny * e1 + nz * e2 < 0) tint = 0xffffffff;
    }
    paintTri(ax, ay, az, bx, by, bz, cx, cy, cz, sh0, sh1, sh2, depth, color, true, tint, section !== null, sd0, sd1, sd2, t);
  }
  if (ghost && ghostDepth && ghostShade) {
    for (let i = 0; i + 8 < ghost.length; i += 9) {
      const ax = ghost[i]!, ay = ghost[i + 1]!, az = ghost[i + 2]!;
      const bx = ghost[i + 3]!, by = ghost[i + 4]!, bz = ghost[i + 5]!;
      const cx = ghost[i + 6]!, cy = ghost[i + 7]!, cz = ghost[i + 8]!;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const cnx = uy * vz - uz * vy, cny = uz * vx - ux * vz, cnz = ux * vy - uy * vx;
      const clen = Math.hypot(cnx, cny, cnz);
      const s = clen > 1e-9 ? shade3(cnx / clen, cny / clen, cnz / clen) : shade3(0, 0, 1);
      paintTri(ax, ay, az, bx, by, bz, cx, cy, cz, s, s, s, ghostDepth, ghostShade, false, 0, false, 0, 0, 0, -1);
    }
  }
  const ink = edgeInk(positions, topo, triCount, r0, r1, r2, u0, u1, u2, e0, e1, e2, midX, midY, fit, halfW, halfH, owner, depth, options.faces ?? null, width, height, section);
  const transparent = options.transparent === true;
  const background = options.background ?? BACKGROUND;
  const bg0 = background[0], bg1 = background[1], bg2 = background[2];
  const channels = transparent ? 4 : 3;
  const raw = new Uint8Array((width * channels + 1) * height);
  const rgbPixels = options.pixels ? new Uint8Array(pixels * 3) : undefined;
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * channels + 1);
    raw[row] = 0;
    const rowBase = y * width;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * channels;
      const pixel = rowBase + x;
      const shade = color[pixel]!;
      const gTint = ghostShade ? ghostShade[pixel]! : 0;
      if (transparent && shade === 0 && gTint === 0) continue;
      const dark = 1 - 0.78 * ink[pixel]! / 255;
      let rVal: number, gVal: number, bVal: number;
      const tinted = shade ? tintAt[pixel]! : 0;
      if (tinted) {
        const hue = tinted === 0xffffffff ? CUT : tinted <= tints.length ? tints[tinted - 1]!.rgb : partTints[tinted - tints.length - 1]!.rgb;
        const lit = tinted === 0xffffffff ? 0.85 : Math.min(1.15, shade / 200);
        rVal = Math.round(Math.min(255, hue[0] * lit) * dark);
        gVal = Math.round(Math.min(255, hue[1] * lit) * dark);
        bVal = Math.round(Math.min(255, hue[2] * lit) * dark);
      } else if (shade) {
        rVal = Math.round(shade * dark);
        gVal = Math.round(shade * dark);
        bVal = Math.round(Math.min(255, shade + 8) * dark);
      } else {
        rVal = Math.round(bg0 * dark);
        gVal = Math.round(bg1 * dark);
        bVal = Math.round(bg2 * dark);
      }
      if (gTint && ghostDepth) {
        // The tool shape shows through the part, fainter where the part is in front of it.
        const hidden = shade > 0 && depth[pixel]! > ghostDepth[pixel]!;
        const alpha = hidden ? 0.35 : 0.7;
        const invAlpha = 1 - alpha;
        const litAlpha = (gTint / 220) * alpha;
        rVal = Math.round(rVal * invAlpha + GHOST[0] * litAlpha);
        gVal = Math.round(gVal * invAlpha + GHOST[1] * litAlpha);
        bVal = Math.round(bVal * invAlpha + GHOST[2] * litAlpha);
      }
      raw[at] = rVal;
      raw[at + 1] = gVal;
      raw[at + 2] = bVal;
      if (rgbPixels) {
        const p3 = pixel * 3;
        rgbPixels[p3] = rVal;
        rgbPixels[p3 + 1] = gVal;
        rgbPixels[p3 + 2] = bVal;
      }
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
  return { png, width, height, ...(rgbPixels ? { rgb: rgbPixels } : {}) };
}

/** Shared welded vertex topology and facet normals for smooth shading and CAD edge extraction. */
interface MeshTopology {
  /** Welded vertex index for each triangle corner (length = triCount * 3). */
  vertId: Int32Array;
  /** Number of unique quantized vertices. */
  uniqueVerts: number;
  /** Linked list head per unique vertex into corner-triangle list (`triNext`). */
  vertHead: Int32Array;
  /** Triangle index for each corner slot (length = triCount * 3). */
  cornerTri: Int32Array;
  /** Next corner index in the same unique vertex's list, or -1. */
  triNext: Int32Array;
  /** Unit facet normal per triangle (length = triCount * 3), or [0,0,1] for degenerate triangles. */
  facetNormals: Float32Array;
  /** 1 if triangle has a valid non-zero normal, 0 if degenerate. */
  facetValid: Uint8Array;
}

function buildMeshTopology(mesh: Float32Array, triCount: number): MeshTopology {
  const cornerCount = triCount * 3;
  const vertId = new Int32Array(cornerCount);
  const facetNormals = new Float32Array(cornerCount);
  const facetValid = new Uint8Array(triCount);
  const cornerTri = new Int32Array(cornerCount);
  const triNext = new Int32Array(cornerCount).fill(-1);

  // Open-addressed hash table over quantized integer coordinates (1 µm grid): zero string allocations.
  let tableSize = 64;
  while (tableSize < cornerCount * 2) tableSize <<= 1;
  const mask = tableSize - 1;
  const slots = new Int32Array(tableSize).fill(-1);
  const qx = new Int32Array(cornerCount);
  const qy = new Int32Array(cornerCount);
  const qz = new Int32Array(cornerCount);
  const vertHead = new Int32Array(cornerCount).fill(-1);
  let uniqueVerts = 0;

  for (let t = 0; t < triCount; t += 1) {
    const i = t * 9;
    const ax = mesh[i]!, ay = mesh[i + 1]!, az = mesh[i + 2]!;
    const ux = mesh[i + 3]! - ax, uy = mesh[i + 4]! - ay, uz = mesh[i + 5]! - az;
    const vx = mesh[i + 6]! - ax, vy = mesh[i + 7]! - ay, vz = mesh[i + 8]! - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    const nBase = t * 3;
    if (len > 1e-9 && Number.isFinite(len)) {
      facetNormals[nBase] = nx / len;
      facetNormals[nBase + 1] = ny / len;
      facetNormals[nBase + 2] = nz / len;
      facetValid[t] = 1;
    } else {
      facetNormals[nBase] = 0;
      facetNormals[nBase + 1] = 0;
      facetNormals[nBase + 2] = 1;
    }
    for (let k = 0; k < 3; k += 1) {
      const ci = nBase + k;
      const p = i + k * 3;
      const x = Math.round(mesh[p]! * 1000) | 0;
      const y = Math.round(mesh[p + 1]! * 1000) | 0;
      const z = Math.round(mesh[p + 2]! * 1000) | 0;
      let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
      let id = -1;
      for (;;) {
        const cur = slots[h]!;
        if (cur === -1) {
          id = uniqueVerts++;
          slots[h] = id;
          qx[id] = x;
          qy[id] = y;
          qz[id] = z;
          break;
        }
        if (qx[cur] === x && qy[cur] === y && qz[cur] === z) {
          id = cur;
          break;
        }
        h = (h + 1) & mask;
      }
      vertId[ci] = id;
      cornerTri[ci] = t;
      triNext[ci] = vertHead[id]!;
      vertHead[id] = ci;
    }
  }
  return { vertId, uniqueVerts, vertHead, cornerTri, triNext, facetNormals, facetValid };
}

/** Each triangle corner's normal: the mean of the facets at that point within SMOOTH_DEG of the corner's own facet. */
function cornerNormalsFrom(topo: MeshTopology, triCount: number): Float32Array {
  const limit = Math.cos((SMOOTH_DEG * Math.PI) / 180);
  const { vertId, vertHead, cornerTri, triNext, facetNormals } = topo;
  const out = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t += 1) {
    const nBase = t * 3;
    const ox = facetNormals[nBase]!, oy = facetNormals[nBase + 1]!, oz = facetNormals[nBase + 2]!;
    for (let k = 0; k < 3; k += 1) {
      const vid = vertId[nBase + k]!;
      let sx = 0, sy = 0, sz = 0;
      for (let node = vertHead[vid]!; node !== -1; node = triNext[node]!) {
        const other = cornerTri[node]!;
        const ob = other * 3;
        const nx = facetNormals[ob]!, ny = facetNormals[ob + 1]!, nz = facetNormals[ob + 2]!;
        if (nx * ox + ny * oy + nz * oz < limit) continue;
        sx += nx;
        sy += ny;
        sz += nz;
      }
      const len = Math.hypot(sx, sy, sz);
      const o = t * 9 + k * 3;
      if (len > 1e-9 && Number.isFinite(len)) {
        out[o] = sx / len;
        out[o + 1] = sy / len;
        out[o + 2] = sz / len;
      } else {
        out[o] = ox;
        out[o + 1] = oy;
        out[o + 2] = oz;
      }
    }
  }
  return out;
}

/** Faces that meet at more than this many degrees draw their edge. A tessellated curve's facets meet at less. */
const CREASE_DEG = 25;

/**
 * How dark each pixel's edge line is, 0 to 255: a CAD drawing's lines over the shading. Edges come from the mesh: an
 * open boundary, a crease sharper than CREASE_DEG, or a silhouette, where one face looks at the camera and the other
 * away. Each is drawn where one of its own triangles is the one in front, at that pixel or the next; else only where
 * nothing is clearly nearer (a couple of pixels' depth) and, with `faces`, the triangle in front is on one of its own
 * faces. --- 3.1 F5. The depth margin alone let an inner rib's edge through where it ends a wall's thickness behind a
 * rounded outer face seen edge-on.
 */
function edgeInk(
  mesh: Float32Array,
  topo: MeshTopology,
  triCount: number,
  r0: number, r1: number, r2: number,
  u0: number, u1: number, u2: number,
  e0: number, e1: number, e2: number,
  midX: number, midY: number, fit: number, halfW: number, halfH: number,
  owner: Int32Array,
  depth: Float32Array,
  faces: ArrayLike<number> | null,
  width: number,
  height: number,
  section: { point: Vec; normal: Vec } | null = null,
): Uint8Array {
  const spx = section ? section.point[0] : 0, spy = section ? section.point[1] : 0, spz = section ? section.point[2] : 0;
  const snx = section ? section.normal[0] : 0, sny = section ? section.normal[1] : 0, snz = section ? section.normal[2] : 0;
  const away = (x: number, y: number, z: number) => section !== null && (x - spx) * snx + (y - spy) * sny + (z - spz) * snz > 0;
  const ink = new Uint8Array(width * height);
  const { vertId, uniqueVerts, facetNormals, facetValid } = topo;
  const stride = Math.max(1, uniqueVerts);
  const edges = new Map<number, { a: number; b: number; t1: number; t2: number; extra?: number[] }>();
  for (let t = 0; t < triCount; t += 1) {
    if (!facetValid[t]) continue;
    const base = t * 9;
    const vBase = t * 3;
    const c0 = base, c1 = base + 3, c2 = base + 6;
    const v0 = vertId[vBase]!, v1 = vertId[vBase + 1]!, v2 = vertId[vBase + 2]!;
    for (let k = 0; k < 3; k += 1) {
      const a = k === 0 ? c0 : k === 1 ? c1 : c2;
      const b = k === 0 ? c1 : k === 1 ? c2 : c0;
      const va = k === 0 ? v0 : k === 1 ? v1 : v2;
      const vb = k === 0 ? v1 : k === 1 ? v2 : v0;
      const key = va < vb ? va * stride + vb : vb * stride + va;
      const row = edges.get(key);
      if (row) {
        if (row.t2 === -1) row.t2 = t;
        else (row.extra ??= []).push(t);
      } else {
        edges.set(key, { a, b, t1: t, t2: -1 });
      }
    }
  }
  const crease = Math.cos((CREASE_DEG * Math.PI) / 180);
  const smoothSeams = seamPartners(mesh, edges, facetNormals, crease);
  const bias = 2.5 / fit;
  for (const [key, { a, b, t1, t2, extra }] of edges) {
    let strength = 0;
    if (t2 === -1) {
      if (smoothSeams.has(key)) continue;
      strength = 230;
    } else if (extra !== undefined) {
      strength = 230;
    } else {
      const n1 = t1 * 3, n2 = t2 * 3;
      const n1x = facetNormals[n1]!, n1y = facetNormals[n1 + 1]!, n1z = facetNormals[n1 + 2]!;
      const n2x = facetNormals[n2]!, n2y = facetNormals[n2 + 1]!, n2z = facetNormals[n2 + 2]!;
      const f1 = n1x * e0 + n1y * e1 + n1z * e2;
      const f2 = n2x * e0 + n2y * e1 + n2z * e2;
      if (f1 * f2 < 0) strength = 230;
      else if (n1x * n2x + n1y * n2y + n1z * n2z < crease && (f1 > 0 || f2 > 0)) strength = 170;
    }
    if (!strength) continue;
    const ax = mesh[a]!, ay = mesh[a + 1]!, az = mesh[a + 2]!;
    const bx = mesh[b]!, by = mesh[b + 1]!, bz = mesh[b + 2]!;
    // A section's cut-away side draws no lines.
    if (away(ax, ay, az) || away(bx, by, bz)) continue;
    const px = (ax * r0 + ay * r1 + az * r2 - midX) * fit + halfW;
    const py = halfH - (ax * u0 + ay * u1 + az * u2 - midY) * fit;
    const pz = ax * e0 + ay * e1 + az * e2;
    const qx = (bx * r0 + by * r1 + bz * r2 - midX) * fit + halfW;
    const qy = halfH - (bx * u0 + by * u1 + bz * u2 - midY) * fit;
    const qz = bx * e0 + by * e1 + bz * e2;
    const f1Face = faces ? faces[t1]! : -1;
    const f2Face = faces && t2 !== -1 ? faces[t2]! : -1;
    const extraFaces = faces && extra ? extra.map((tri) => faces[tri]!) : null;
    const shows = (at: number, exact: boolean): boolean => {
      const front = owner[at]!;
      if (front < 0) return false;
      if (front === t1 || front === t2 || (extra !== undefined && extra.includes(front))) return true;
      if (exact || faces === null) return false;
      const ff = faces[front]!;
      return ff === f1Face || ff === f2Face || (extraFaces !== null && extraFaces.includes(ff));
    };
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(qx - px), Math.abs(qy - py)) * 1.5));
    const invSteps = 1 / steps;
    const dpx = qx - px, dpy = qy - py, dpz = qz - pz;
    for (let s = 0; s <= steps; s += 1) {
      const t = s * invSteps;
      const x = Math.round(px + dpx * t);
      const y = Math.round(py + dpy * t);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const at = y * width + x;
      if (strength <= ink[at]!) continue;
      let hitExact = false;
      let hitFace = false;
      const yLo = y > 0 ? y - 1 : 0;
      const yHi = y + 1 < height ? y + 1 : height - 1;
      const xLo = x > 0 ? x - 1 : 0;
      const xHi = x + 1 < width ? x + 1 : width - 1;
      for (let ny = yLo; ny <= yHi && !hitExact; ny += 1) {
        const rOff = ny * width;
        for (let nx = xLo; nx <= xHi; nx += 1) {
          const nat = rOff + nx;
          if (shows(nat, true)) { hitExact = true; break; }
          if (!hitFace && faces !== null && shows(nat, false)) hitFace = true;
        }
      }
      if (!hitExact) {
        const z = pz + dpz * t;
        if (!(z + bias >= depth[at]! && (faces === null || hitFace))) continue;
      }
      ink[at] = strength;
    }
  }
  return ink;
}

/**
 * The one-sided edges that are really a smooth join: two kernel faces tessellated apart meet along an edge whose points
 * do not match, so each side's edge has no partner by position. An edge is a smooth seam when an edge of another
 * triangle lies along it (parallel, on the same line, overlapping) and the two triangles meet at less than the crease.
 */
function seamPartners(mesh: Float32Array, edges: Map<number, { a: number; b: number; t1: number; t2: number }>, facetNormals: Float32Array, crease: number): Set<number> {
  const open: { key: number; p: Vec; q: Vec; n: Vec }[] = [];
  for (const [key, row] of edges) {
    if (row.t2 !== -1) continue;
    const nb = row.t1 * 3;
    open.push({
      key,
      p: [mesh[row.a]!, mesh[row.a + 1]!, mesh[row.a + 2]!],
      q: [mesh[row.b]!, mesh[row.b + 1]!, mesh[row.b + 2]!],
      n: [facetNormals[nb]!, facetNormals[nb + 1]!, facetNormals[nb + 2]!],
    });
  }
  const smooth = new Set<number>();
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
