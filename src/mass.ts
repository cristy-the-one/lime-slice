/**
 * Mass properties of closed triangle meshes (docs/plan-mass-properties.md): volume, centre of gravity and the inertia
 * tensor by the exact polyhedral integrals, bodies made of several parts at their poses, the moment of inertia about an
 * axis line, and the compound-pendulum period about a hinge. Shared by the window and the MCP server: no DOM.
 *
 * Units: mm, mm³, g, g·mm², s. A density is in g/cm³ where it is typed and read, g/mm³ inside.
 */
import type { Assembly } from "./assembly.ts";
import { closeCracks, edgeReport } from "./mesh-check.ts";
import type { Affine } from "./model-space.ts";

type Vec3 = [number, number, number];
/** A 3×3 matrix, row by row. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Standard gravity, mm/s². Gravity points along −Z of model space. */
export const G_MM_S2 = 9806.65;
/** Model space's down. */
export const DOWN: Vec3 = [0, 0, -1];

/** A mesh's integrals in one frame: ∫1 dV, ∫x dV, and ∫x xᵀ dV (row by row), in mm³, mm⁴ and mm⁵. */
export interface Integrals {
  volume: number;
  first: Vec3;
  second: Mat3;
}

export interface Refusal {
  reason: string;
}

/** The sums of signed tetrahedra over a soup of triangles, about `c` (Eberly, "Polyhedral Mass Properties"). */
function aboutPoint(positions: ArrayLike<number>, c: Vec3): Integrals {
  let v = 0, x = 0, y = 0, z = 0, xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0;
  const sub = (w0: number, w1: number, w2: number) => {
    const t0 = w0 + w1, f1 = t0 + w2, t1 = w0 * w0, t2 = t1 + w1 * t0, f2 = t2 + w2 * f1, f3 = w0 * t1 + w1 * t2 + w2 * f2;
    return { f1, f2, f3, g0: f2 + w0 * (f1 + w0), g1: f2 + w1 * (f1 + w1), g2: f2 + w2 * (f1 + w2) };
  };
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const x0 = positions[i]! - c[0], y0 = positions[i + 1]! - c[1], z0 = positions[i + 2]! - c[2];
    const x1 = positions[i + 3]! - c[0], y1 = positions[i + 4]! - c[1], z1 = positions[i + 5]! - c[2];
    const x2 = positions[i + 6]! - c[0], y2 = positions[i + 7]! - c[1], z2 = positions[i + 8]! - c[2];
    const a1 = x1 - x0, b1 = y1 - y0, c1 = z1 - z0, a2 = x2 - x0, b2 = y2 - y0, c2 = z2 - z0;
    const d0 = b1 * c2 - b2 * c1, d1 = a2 * c1 - a1 * c2, d2 = a1 * b2 - a2 * b1;
    const sx = sub(x0, x1, x2), sy = sub(y0, y1, y2), sz = sub(z0, z1, z2);
    v += d0 * sx.f1;
    x += d0 * sx.f2; y += d1 * sy.f2; z += d2 * sz.f2;
    xx += d0 * sx.f3; yy += d1 * sy.f3; zz += d2 * sz.f3;
    xy += d0 * (y0 * sx.g0 + y1 * sx.g1 + y2 * sx.g2);
    yz += d1 * (z0 * sy.g0 + z1 * sy.g1 + z2 * sy.g2);
    zx += d2 * (x0 * sz.g0 + x1 * sz.g1 + x2 * sz.g2);
  }
  v /= 6; x /= 24; y /= 24; z /= 24; xx /= 60; yy /= 60; zz /= 60; xy /= 120; yz /= 120; zx /= 120;
  return { volume: v, first: [x, y, z], second: [xx, xy, zx, xy, yy, yz, zx, yz, zz] };
}

/** Integrals about `c` moved to the origin: F = F_c + c V, S = S_c + c F_cᵀ + F_c cᵀ + V c cᵀ. */
function shifted(about: Integrals, c: Vec3): Integrals {
  const { volume: v, first: f, second: s } = about;
  const second = s.map((value, k) => {
    const i = Math.floor(k / 3), j = k % 3;
    return value + c[i]! * f[j]! + f[i]! * c[j]! + v * c[i]! * c[j]!;
  }) as Mat3;
  return { volume: v, first: [f[0] + c[0] * v, f[1] + c[1] * v, f[2] + c[2] * v], second };
}

function scaled(row: Integrals, k: number): Integrals {
  return { volume: row.volume * k, first: row.first.map((value) => value * k) as Vec3, second: row.second.map((value) => value * k) as Mat3 };
}

/**
 * A closed mesh's integrals in its own frame, or why it has none. The mesh is checked as model_check checks it: cracks
 * a commit mends are mended first, and any edge still open refuses it. Inside out is weighed with its sign turned.
 */
export function meshIntegrals(positions: ArrayLike<number>, name = "This part"): Integrals | Refusal {
  if (positions.length < 36) return { reason: `${name} has no closed mesh to weigh.` };
  const raw = edgeReport(positions, 1);
  let soup: ArrayLike<number> = positions;
  if (raw.open > 0 || raw.degenerate > 0) {
    soup = closeCracks(positions);
    const mended = edgeReport(soup, 1);
    if (mended.open > 0) {
      const at = mended.openAt[0]?.at;
      return { reason: `${name}'s mesh has ${mended.open} open edge${mended.open === 1 ? "" : "s"}${at ? `, the first at (${at.join(", ")})` : ""}, so it encloses no volume to weigh. model_check lists them.` };
    }
  }
  // About the middle of the mesh's box, so a part far from its origin keeps its digits.
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < soup.length; i += 3) for (let k = 0; k < 3; k += 1) {
    const value = soup[i + k]!;
    if (value < min[k]!) min[k] = value;
    if (value > max[k]!) max[k] = value;
  }
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let about = aboutPoint(soup, c);
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(Math.abs(about.volume) > 1e-9 * Math.max(1, size ** 3))) return { reason: `${name}'s mesh encloses no volume to weigh.` };
  if (about.volume < 0) about = scaled(about, -1);
  return shifted(about, c);
}

const kept = new WeakMap<object, Integrals | Refusal>();

/** meshIntegrals, kept per mesh array: a mesh is read once, however often its part is turned. */
export function partIntegrals(positions: ArrayLike<number>, name = "This part"): Integrals | Refusal {
  let held = kept.get(positions as object);
  if (!held) {
    held = meshIntegrals(positions, NAME);
    kept.set(positions as object, held);
  }
  return "reason" in held ? { reason: held.reason.replaceAll(NAME, name) } : held;
}
const NAME = "\u0000part\u0000";

const det3 = (m: Mat3) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
const mul3 = (a: Mat3, b: Mat3): Mat3 => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => {
  const i = Math.floor(k / 3), j = k % 3;
  return a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
}) as Mat3;
const transpose3 = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const apply3 = (m: Mat3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Integrals moved by `pose` (x' = A x + t): what the posed mesh would give, without reading it again. */
export function posedIntegrals(row: Integrals, pose: Affine): Integrals {
  const a = pose.m as Mat3, t = pose.t as Vec3;
  const j = Math.abs(det3(a));
  const af = apply3(a, row.first);
  const asa = mul3(mul3(a, row.second), transpose3(a));
  const second = asa.map((value, k) => {
    const i = Math.floor(k / 3), l = k % 3;
    return j * (value + af[i]! * t[l]! + t[i]! * af[l]! + row.volume * t[i]! * t[l]!);
  }) as Mat3;
  return { volume: j * row.volume, first: [j * (af[0] + t[0] * row.volume), j * (af[1] + t[1] * row.volume), j * (af[2] + t[2] * row.volume)], second };
}

/** A body's mass properties: in model axes, about its centre of gravity. */
export interface MassBody {
  volumeMm3: number;
  massG: number;
  centreMm: Vec3;
  /** The inertia tensor about the centre of gravity, g·mm², row by row. */
  inertiaGmm2: Mat3;
}

/** One part of a body: its integrals in its own frame, its pose into model space, and its density in g/cm³. */
export interface BodyPart {
  integrals: Integrals;
  pose: Affine;
  densityGCm3: number;
}

/** The parts summed at their poses, each at its density. */
export function bodyOf(parts: readonly BodyPart[]): MassBody {
  let volume = 0, mass = 0;
  const first: Vec3 = [0, 0, 0];
  const second: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const part of parts) {
    const posed = posedIntegrals(part.integrals, part.pose);
    const rho = part.densityGCm3 / 1000;
    volume += posed.volume;
    mass += rho * posed.volume;
    for (let k = 0; k < 3; k += 1) first[k] += rho * posed.first[k]!;
    for (let k = 0; k < 9; k += 1) second[k] += rho * posed.second[k]!;
  }
  const c: Vec3 = mass > 0 ? [first[0] / mass, first[1] / mass, first[2] / mass] : [0, 0, 0];
  // Second moments about the centre: S_G = S − m c cᵀ; inertia I = tr(S_G) 1 − S_G.
  const sg = second.map((value, k) => value - mass * c[Math.floor(k / 3)]! * c[k % 3]!) as Mat3;
  const trace = sg[0] + sg[4] + sg[8];
  const inertia = sg.map((value, k) => (k % 4 === 0 ? trace - value : -value)) as Mat3;
  return { volumeMm3: volume, massG: mass, centreMm: c, inertiaGmm2: inertia };
}

/** The body with its mass scaled to `grams`, spread as before: the inertia scales with it, the centre stays. */
export function withMass(body: MassBody, grams: number): MassBody {
  const k = body.massG > 0 ? grams / body.massG : 0;
  return { ...body, massG: grams, inertiaGmm2: body.inertiaGmm2.map((value) => value * k) as Mat3 };
}

/** Principal moments (ascending, g·mm²) and their unit axes, by Jacobi rotations of the symmetric tensor. */
export function principal(tensor: Mat3): { momentsGmm2: Vec3; axes: [Vec3, Vec3, Vec3] } {
  const a = [...tensor];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    const off = Math.abs(a[1]!) + Math.abs(a[2]!) + Math.abs(a[5]!);
    if (off <= 1e-15 * (Math.abs(a[0]!) + Math.abs(a[4]!) + Math.abs(a[8]!) + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p * 3 + q]!;
      if (apq === 0) continue;
      const app = a[p * 3 + p]!, aqq = a[q * 3 + q]!;
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < 3; k += 1) {
        const akp = a[k * 3 + p]!, akq = a[k * 3 + q]!;
        a[k * 3 + p] = cs * akp - sn * akq;
        a[k * 3 + q] = sn * akp + cs * akq;
      }
      for (let k = 0; k < 3; k += 1) {
        const apk = a[p * 3 + k]!, aqk = a[q * 3 + k]!;
        a[p * 3 + k] = cs * apk - sn * aqk;
        a[q * 3 + k] = sn * apk + cs * aqk;
      }
      for (let k = 0; k < 3; k += 1) {
        const vkp = v[k * 3 + p]!, vkq = v[k * 3 + q]!;
        v[k * 3 + p] = cs * vkp - sn * vkq;
        v[k * 3 + q] = sn * vkp + cs * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i * 4]! - a[j * 4]!);
  return {
    momentsGmm2: order.map((i) => a[i * 4]!) as Vec3,
    axes: order.map((i) => [v[i]!, v[3 + i]!, v[6 + i]!] as Vec3) as [Vec3, Vec3, Vec3],
  };
}

/** The moment of inertia about the line through `point` along `axis` (parallel axes), and its distance to the centre. */
export function aboutAxis(body: MassBody, point: readonly number[], axis: readonly number[]): { inertiaGmm2: number; leverMm: number } | Refusal {
  const length = Math.hypot(axis[0]!, axis[1]!, axis[2]!);
  if (!(length > 0)) return { reason: "The axis has no direction." };
  const n: Vec3 = [axis[0]! / length, axis[1]! / length, axis[2]! / length];
  const r: Vec3 = [body.centreMm[0] - point[0]!, body.centreMm[1] - point[1]!, body.centreMm[2] - point[2]!];
  const along = dot(r, n);
  const leverMm = Math.hypot(r[0] - along * n[0], r[1] - along * n[1], r[2] - along * n[2]);
  return { inertiaGmm2: dot(n, apply3(body.inertiaGmm2, n)) + body.massG * leverMm * leverMm, leverMm };
}

/** A simple pendulum's period, s, for a length in mm. */
export function pendulumPeriod(lengthMm: number, gravity = G_MM_S2): number {
  return 2 * Math.PI * Math.sqrt(lengthMm / gravity);
}

/** The simple pendulum's length, mm, for a period in s. */
export function pendulumLength(periodS: number, gravity = G_MM_S2): number {
  const k = periodS / (2 * Math.PI);
  return gravity * k * k;
}

/** A compound pendulum's small-swing period, s: T = 2π √(I / (m g d)). */
export function compoundPeriod(inertiaGmm2: number, massG: number, leverMm: number, gravity = G_MM_S2): number {
  return 2 * Math.PI * Math.sqrt(inertiaGmm2 / (massG * gravity * leverMm));
}

export interface Swing {
  periodS: number;
  /** The simple pendulum with the same period: I / (m d), mm. */
  lengthMm: number;
  /** Gravity across the axis, mm/s²: all of it for a level axis. */
  gravityMmS2: number;
  inertiaGmm2: number;
  leverMm: number;
  /** How far the current pose is turned from rest (the centre of gravity straight below the axis), degrees. */
  offRestDeg: number;
}

/**
 * The body as a compound pendulum on the line through `point` along `axis`, under gravity along `down`. Only gravity's
 * part across the axis swings it. A vertical axis, or a centre of gravity on the axis, has no period.
 */
export function swing(body: MassBody, point: readonly number[], axis: readonly number[], down: readonly number[] = DOWN, gravity = G_MM_S2): Swing | Refusal {
  const about = aboutAxis(body, point, axis);
  if ("reason" in about) return about;
  const length = Math.hypot(axis[0]!, axis[1]!, axis[2]!);
  const n: Vec3 = [axis[0]! / length, axis[1]! / length, axis[2]! / length];
  const g: Vec3 = [down[0]!, down[1]!, down[2]!];
  const along = dot(g, n);
  const across: Vec3 = [g[0] - along * n[0], g[1] - along * n[1], g[2] - along * n[2]];
  const share = Math.hypot(...across);
  if (share < 1e-6) return { reason: "The axis is vertical, so gravity does not swing the part about it: there is no period." };
  if (about.leverMm < 1e-6) return { reason: "The centre of gravity lies on the axis, so the part balances at any angle: there is no period." };
  const r: Vec3 = [body.centreMm[0] - point[0]!, body.centreMm[1] - point[1]!, body.centreMm[2] - point[2]!];
  const ra = dot(r, n);
  const lever: Vec3 = [r[0] - ra * n[0], r[1] - ra * n[1], r[2] - ra * n[2]];
  const cos = Math.max(-1, Math.min(1, dot(lever, across) / (about.leverMm * share)));
  const effective = gravity * share;
  return {
    periodS: compoundPeriod(about.inertiaGmm2, body.massG, about.leverMm, effective),
    lengthMm: about.inertiaGmm2 / (body.massG * about.leverMm),
    gravityMmS2: effective,
    inertiaGmm2: about.inertiaGmm2,
    leverMm: about.leverMm,
    offRestDeg: (Math.acos(cos) * 180) / Math.PI,
  };
}

/**
 * The part that moves with `object` in its assembly: up through members seated without a joint to the first member
 * with one (or the root), then that member and every member seated on it without a joint. Null outside the assembly.
 */
export function movingBody(assembly: Assembly, object: string): { body: string; parts: string[] } | null {
  const memberOf = (id: string) => assembly.members.find((row) => row.object === id);
  let at = memberOf(object);
  for (const seen = new Set<string>(); at && !at.joint && at.parent !== null && !seen.has(at.object); at = memberOf(at.parent)) seen.add(at.object);
  if (!at) return null;
  const parts = [at.object];
  for (let i = 0; i < parts.length; i += 1) {
    for (const row of assembly.members) if (row.parent === parts[i] && !row.joint && !parts.includes(row.object)) parts.push(row.object);
  }
  return { body: at.object, parts };
}
