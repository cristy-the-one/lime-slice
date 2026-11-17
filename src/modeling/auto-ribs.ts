/**
 * Auto ribs, between the planner and the rib network (docs/plan-auto-ribs.md, sections 7.1, 7.5 and 7.6): the rules a
 * plan starts from, the section each planned rib is built with, and the `ribNet` op that builds a plan.
 *
 * - Defaults from the process and the wall (`ribRules`): filament ribs are whole beads wide, resin and moulded ribs a
 *   share of the wall; the greatest height is three walls; spacing and least length follow the wall's narrow width.
 * - The section (`chooseSection`): moulded and resin ribs are drafted; a filament rib is straight, or a tee where it is
 *   tall enough for a flange and the flange's underside prints in this pose. The underside is a 46° chamfer or square,
 *   whichever is not an overhang for the printer's build direction along that rib (read the way `model_check` reads an
 *   overhang: a face is one when it looks more than 45° down against the build direction). Neither prints: straight.
 * - The network (`ribNetOf`): each rib a path; a rib whose height changes along it (a capped zone, a facing part) is
 *   split where it changes, each stretch its own path at its own height, the pieces meeting end to end as joints.
 *
 * Shared module: no Node builtins, no DOM, no MCP session. Same input, same output.
 */
import { RibSurface, ribShape, type RibProfileKind } from "./rib-net.ts";
import { ribPathsFromPlan, type RibWall, type RibWallSolid } from "./rib-wall.ts";

type V3 = [number, number, number];

export type RibProcess = "filament" | "resin" | "moulded";

/** One bead of a nozzle, as the stress smear lays it: 1.125 × the nozzle. */
export function beadWidth(nozzleMm: number): number {
  return Math.min(1.2, Math.max(0.2, nozzleMm * 1.125));
}

export interface RibRuleInput {
  process: RibProcess;
  nozzleMm: number;
  /** The wall's median thickness, mm. */
  thicknessMm: number;
  /** The wall's area and its longest border's length, for its narrow width. */
  areaMm2: number;
  outerLoopMm: number;
  given: { width?: number; maxHeight?: number; minHeight?: number; minSpacing?: number; minLength?: number };
}

export interface RibRulesChosen {
  width: number;
  maxHeight: number;
  minHeight: number;
  minSpacing: number;
  minLength: number;
  /** The wall's narrow width the spacing and length came from, mm. */
  narrowMm: number;
  /** Each value and where it came from, in a sentence. */
  defaults: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The narrow width of a wall from its area and its outer border's length: the short side of the rectangle with that
 * area and perimeter (a 196 × 96 floor gives 96), or the square root of the area where no rectangle fits.
 */
export function narrowWidth(areaMm2: number, outerLoopMm: number): number {
  const half = outerLoopMm / 2;
  const disc = half * half - 4 * areaMm2;
  if (!(areaMm2 > 0)) return 0;
  if (!(outerLoopMm > 0) || disc < 0) return Math.sqrt(areaMm2);
  return (half - Math.sqrt(disc)) / 2;
}

/** The rules a plan starts from: what was given, and a default for the rest, each said in `defaults`. */
export function ribRules(input: RibRuleInput): RibRulesChosen {
  const defaults: string[] = [];
  const t = input.thicknessMm;
  let width: number;
  if (input.process === "filament") {
    const bead = beadWidth(input.nozzleMm);
    if (input.given.width !== undefined) {
      const beads = Math.max(2, Math.round(input.given.width / bead));
      width = beads * bead;
      if (Math.abs(width - input.given.width) > 1e-6) defaults.push(`width ${r2(input.given.width)} mm rounded to ${beads} beads of ${r2(bead)} mm: ${r2(width)} mm`);
    } else {
      width = 3 * bead;
      defaults.push(`width ${r2(width)} mm: 3 beads of ${r2(bead)} mm (1.125 × the ${input.nozzleMm} mm nozzle)`);
    }
  } else if (input.given.width !== undefined) width = input.given.width;
  else {
    const share = input.process === "moulded" ? 0.6 : 0.8;
    width = Math.max(0.4, share * t);
    defaults.push(`width ${r2(width)} mm: ${share} × the wall's ${r2(t)} mm (${input.process})`);
  }
  let maxHeight = input.given.maxHeight;
  if (maxHeight === undefined) {
    maxHeight = Math.max(1, 3 * t);
    defaults.push(`greatest height ${r2(maxHeight)} mm: 3 × the wall's median ${r2(t)} mm, less where something faces the wall or a zone caps it`);
  }
  let minHeight = input.given.minHeight;
  if (minHeight === undefined) {
    minHeight = Math.min(1, maxHeight);
    defaults.push(`least height ${r2(minHeight)} mm`);
  }
  const narrow = narrowWidth(input.areaMm2, input.outerLoopMm);
  let minSpacing = input.given.minSpacing;
  if (minSpacing === undefined) {
    minSpacing = clamp(narrow / 6, Math.max(5, 4 * width), 60);
    defaults.push(`spacing ${r2(minSpacing)} mm: a sixth of the wall's ${r2(narrow)} mm narrow width, from max(5, 4 × width) to 60`);
  }
  let minLength = input.given.minLength;
  if (minLength === undefined) {
    minLength = clamp(narrow / 8, 5, 40);
    defaults.push(`least length ${r2(minLength)} mm: an eighth of the narrow width, from 5 to 40`);
  }
  return { width, maxHeight, minHeight, minSpacing, minLength, narrowMm: narrow, defaults };
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => mul(a, 1 / (len(a) || 1));

/**
 * The chamfer a chamfered flange is built with, degrees from the wall. 45° sits exactly on model_check's 45° limit, and
 * the kernel's float tessellation tips some of those faces over it: three 116 mm tees 1.35 mm wide counted 871 to
 * 1329 mm² of overhang on a flat bed at 45°, none at 46° (mcp/auto-ribs-occt.test.ts, the flange table).
 */
export const CHAMFER_DEG = 46;

/** model_check's overhang rule: a face looking more than `deg` down against the build direction (src/modeling/inspect.ts). */
export function isOverhang(normal: V3, build: V3, deg = 45): boolean {
  return -dot(unit(normal), unit(build)) > Math.sin((deg * Math.PI) / 180) + 1e-6;
}

export type FlangeUnderside = "chamfer" | "square";

/**
 * The flange undersides that print along a rib: for each stretch, the rib's run `t`, the wall's normal `n` (the rib
 * stands along it) and across it `b`; a square underside looks along −n, a chamfer of `chamferDeg` from the wall along
 * ±b·sin − n·cos. An underside prints when no stretch has it as an overhang.
 */
export function flangeUndersides(points: readonly V3[], normals: readonly V3[], build: V3, chamferDeg = CHAMFER_DEG): Record<FlangeUnderside, boolean> {
  const c = Math.cos((chamferDeg * Math.PI) / 180);
  const s = Math.sin((chamferDeg * Math.PI) / 180);
  let square = true;
  let chamfer = true;
  for (let k = 0; k + 1 < points.length; k += 1) {
    const t = sub(points[k + 1]!, points[k]!);
    if (len(t) < 1e-9) continue;
    const n = unit(add(normals[k]!, normals[k + 1]!));
    const b = unit(cross(n, unit(t)));
    if (isOverhang(mul(n, -1), build)) square = false;
    if (isOverhang(sub(mul(b, s), mul(n, c)), build) || isOverhang(sub(mul(b, -s), mul(n, c)), build)) chamfer = false;
  }
  return { chamfer, square };
}

export interface SectionChoice {
  profile: RibProfileKind;
  /** For a tee: 45 (chamfered) or 0 (square). */
  flangeChamferDeg?: number;
  why: string;
}

/** The fields of a typed profile that ribNet reads (rib-net.ts profileOf). */
export interface ProfileFields {
  draftDeg?: number;
  rootRadius?: number;
  flangeWidth?: number;
  flangeThickness?: number;
  flangeChamferDeg?: number;
}

/**
 * The least height a tee is built at: its section needs the root, the chamfer and the flange (ribShape refuses below),
 * and a web at least one width tall under the flange.
 */
export function teeMinHeight(width: number, fields: ProfileFields, chamferDeg: number): number {
  const flange = fields.flangeWidth ?? 3 * width;
  const ft = fields.flangeThickness ?? width;
  const root = fields.rootRadius ?? 0.5 * width;
  const c = Math.max(0, (flange / 2 - width / 2) * Math.tan((chamferDeg * Math.PI) / 180));
  return root + c + ft + 0.1 + width;
}

/**
 * The section of one rib. `asked` is the profile typed (auto when absent); `points` and `normals` are the rib on the
 * wall's face; `build` the printer's build direction in the same frame.
 */
export function chooseSection(asked: "auto" | RibProfileKind, process: RibProcess, width: number, height: number, points: readonly V3[], normals: readonly V3[], build: V3, fields: ProfileFields): SectionChoice {
  if (asked === "straight" || asked === "drafted") return { profile: asked, why: "as asked" };
  if (asked === "auto" && process !== "filament") return { profile: "drafted", why: `${process}: drafted, with a flared root` };
  const prints = flangeUndersides(points, normals, build);
  const typed = fields.flangeChamferDeg;
  if (asked === "tee") {
    if (typed !== undefined) return { profile: "tee", flangeChamferDeg: typed, why: "as asked" };
    if (prints.chamfer) return { profile: "tee", flangeChamferDeg: CHAMFER_DEG, why: `as asked; the ${CHAMFER_DEG}° chamfered underside prints along this rib` };
    if (prints.square) return { profile: "tee", flangeChamferDeg: 0, why: "as asked; the square underside prints along this rib, the chamfer does not" };
    return { profile: "tee", flangeChamferDeg: CHAMFER_DEG, why: "as asked, but neither flange underside prints without support along this rib" };
  }
  const chamfer = typed ?? (prints.chamfer ? CHAMFER_DEG : prints.square ? 0 : null);
  if (chamfer === null) return { profile: "straight", why: "neither a chamfered nor a square flange prints without support along this rib in this pose" };
  if (typed !== undefined && !(typed === 0 ? prints.square : prints.chamfer)) return { profile: "straight", why: `a flange with a ${typed}° underside does not print along this rib in this pose` };
  const least = teeMinHeight(width, fields, chamfer);
  if (height < least) return { profile: "straight", why: `${Math.round(height * 100) / 100} mm is under the ${Math.round(least * 100) / 100} mm a tee needs` };
  return { profile: "tee", flangeChamferDeg: chamfer, why: chamfer > 0 ? `tall enough for a flange; its ${chamfer}° chamfered underside prints along this rib` : "tall enough for a flange; its square underside prints along this rib, a chamfered one would not" };
}

type P2 = [number, number];

/** The area of a rib's section over the wall (v ≥ 0), mm²: rib volume per mm. */
export function sectionArea(profile: RibProfileKind, width: number, height: number, fields: ProfileFields = {}): number {
  if (profile === "straight" && !(fields.rootRadius && fields.rootRadius > 0)) return width * height;
  const draftDeg = profile === "drafted" ? fields.draftDeg ?? 1 : 0;
  const top = width - height * Math.tan((draftDeg * Math.PI) / 180);
  const shape = ribShape({
    kind: profile,
    width,
    draftDeg,
    rootRadius: fields.rootRadius ?? (profile === "straight" ? 0 : 0.5 * (profile === "tee" ? width : Math.max(0, top))),
    flangeWidth: profile === "tee" ? fields.flangeWidth ?? 3 * width : 0,
    flangeThickness: profile === "tee" ? fields.flangeThickness ?? width : 0,
    flangeChamferDeg: profile === "tee" ? fields.flangeChamferDeg ?? 45 : 0,
  }, height, 0.5, 0.05);
  if ("reason" in shape) return width * height;
  const poly = shape.section(height);
  const over: P2[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    if (p[1] >= 0) over.push(p);
    if ((p[1] >= 0) !== (q[1] >= 0)) over.push([p[0] + ((q[0] - p[0]) * -p[1]) / (q[1] - p[1]), 0]);
  }
  let area = 0;
  over.forEach((p, i) => {
    const q = over[(i + 1) % over.length]!;
    area += (p[0] * q[1] - q[0] * p[1]) / 2;
  });
  return Math.abs(area);
}

/** One stretch's section as ribNet takes a path's: its profile, its width and the profile's fields. */
export interface Section extends ProfileFields {
  profile: RibProfileKind;
  width: number;
}

/** A rib to build: points on the wall's face, its height per stretch and its section per stretch (or one for all). */
export interface BuiltRib {
  points: V3[];
  heights: number[];
  width: number;
  profile: RibProfileKind;
  fields?: ProfileFields;
  /** One per stretch, as the planner gives them; absent, every stretch is `profile` with `fields`. */
  sections?: Section[];
}

const sectionKey = (s: Section | undefined) => (s ? JSON.stringify([s.profile, s.width, s.draftDeg, s.rootRadius, s.flangeWidth, s.flangeThickness, s.flangeChamferDeg]) : "");

/**
 * Runs of one height (within `tol` mm) and one section: each piece's points (sharing the point where either changes),
 * its height (the lowest of the run) and its section.
 */
export function splitByHeight(points: readonly V3[], heights: readonly number[], tol = 0.05, sections?: readonly Section[]): { points: V3[]; height: number; section?: Section }[] {
  if (points.length < 2) return [];
  const pieces: { points: V3[]; height: number; section?: Section }[] = [];
  let start = 0;
  for (let k = 1; k <= heights.length; k += 1) {
    if (k < heights.length && Math.abs(heights[k]! - heights[start]!) <= tol && sectionKey(sections?.[k]) === sectionKey(sections?.[start])) continue;
    const run = heights.slice(start, k);
    pieces.push({ points: points.slice(start, k + 1).map((p) => [...p] as V3), height: Math.min(...run), ...(sections?.[start] ? { section: sections[start] } : {}) });
    start = k;
  }
  return pieces;
}

/** The least height a section stands at in ribNet (its root, chamfer and flange, plus 0.1 mm); 0 for a plain one. */
export function sectionLeast(s: Section): number {
  const root = s.rootRadius ?? (s.profile === "straight" ? 0 : 0.5 * s.width);
  if (s.profile === "straight" && !(root > 0)) return 0;
  if (s.profile !== "tee") return root + 0.1;
  const flange = s.flangeWidth ?? 3 * s.width;
  const c = Math.max(0, (flange / 2 - s.width / 2) * Math.tan(((s.flangeChamferDeg ?? 45) * Math.PI) / 180));
  return root + c + (s.flangeThickness ?? s.width) + 0.1;
}

/**
 * Which flange underside prints over a wall, for ribs in any direction on it: `samples` are wall normals spread over
 * it, each tried with ribs every 15° round it. "chamfered" when the chamfer prints everywhere, else "square" when the
 * square one does, else whichever prints for most (and at least half), else null. The share of each is returned.
 */
export function planFlange(samples: readonly V3[], build: V3): { flange: "chamfered" | "square" | null; chamfered: number; square: number } {
  let chamfer = 0;
  let square = 0;
  let total = 0;
  for (const n0 of samples) {
    const n = unit(n0);
    const seed: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = unit(cross(n, seed));
    const v = cross(n, u);
    for (let k = 0; k < 12; k += 1) {
      const a = (k * Math.PI) / 12;
      const t = add(mul(u, Math.cos(a)), mul(v, Math.sin(a)));
      const row = flangeUndersides([[0, 0, 0], t], [n, n], build);
      total += 1;
      if (row.chamfer) chamfer += 1;
      if (row.square) square += 1;
    }
  }
  const c = total ? chamfer / total : 0;
  const s = total ? square / total : 0;
  const flange = c >= 1 ? "chamfered" : s >= 1 ? "square" : Math.max(c, s) >= 0.5 ? (c >= s ? "chamfered" : "square") : null;
  return { flange, chamfered: Math.round(c * 1000) / 1000, square: Math.round(s * 1000) / 1000 };
}

/**
 * The planner's sections along one rib, checked against this rib's direction: a tee stretch whose flange underside does
 * not print along the rib takes the other underside when that one prints and the stretch is tall enough for it, else it
 * is built straight. Returns the sections to build and a sentence for each change.
 */
export function fitFlanges(points: readonly V3[], normals: readonly V3[], heights: readonly number[], sections: readonly Section[], build: V3): { sections: Section[]; notes: string[] } {
  const out: Section[] = [];
  const notes = new Set<string>();
  for (let k = 0; k < sections.length; k += 1) {
    const s = sections[k]!;
    if (s.profile !== "tee") {
      out.push(s);
      continue;
    }
    const chamfered = (s.flangeChamferDeg ?? 45) > 0;
    // The planner's 45° chamfer is built at CHAMFER_DEG, off model_check's limit, where the stretch stands it.
    const steeper: Section = { ...s, flangeChamferDeg: CHAMFER_DEG };
    const own: Section = chamfered && s.flangeChamferDeg === 45 && heights[k]! >= sectionLeast(steeper) ? steeper : s;
    const prints = flangeUndersides([points[k]!, points[k + 1]!], [normals[k]!, normals[k + 1]!], build, chamfered ? own.flangeChamferDeg ?? CHAMFER_DEG : CHAMFER_DEG);
    if (chamfered ? prints.chamfer : prints.square) {
      out.push(own);
      continue;
    }
    const other: Section = { ...s, flangeChamferDeg: chamfered ? 0 : CHAMFER_DEG };
    if ((chamfered ? prints.square : prints.chamfer) && heights[k]! >= sectionLeast(other)) {
      out.push(other);
      notes.add(chamfered ? "the chamfered flange does not print along this rib, so its tee stretches have a square flange" : `the square flange does not print along this rib, so its tee stretches have a ${CHAMFER_DEG}° chamfered flange`);
      continue;
    }
    out.push({ profile: "straight", width: s.width });
    notes.add("no flange prints along this rib in this pose, so it is straight where the plan had a tee");
  }
  return { sections: out, notes: [...notes] };
}

/**
 * The ribNet op for a set of ribs: a path per run of one height and section. A run with no height left (under 0.1 mm)
 * is left out. Refused in a sentence when it would take more than ribNet's 400 paths.
 */
export function ribNetOf(ribs: readonly BuiltRib[], label: string, auto: unknown): Record<string, unknown> | { reason: string } {
  const paths: Record<string, unknown>[] = [];
  for (const rib of ribs) {
    for (const piece of splitByHeight(rib.points, rib.heights, 0.05, rib.sections)) {
      if (!(piece.height >= 0.1)) continue;
      const section: Section = piece.section ?? { profile: rib.profile, width: rib.width, ...(rib.fields ?? {}) };
      // A stretch too low for its root and flange is built straight, as the planner solved it.
      const built: Section = piece.height >= sectionLeast(section) ? section : { profile: "straight", width: section.width };
      paths.push({ points: piece.points, height: Math.round(piece.height * 1e4) / 1e4, ...built });
    }
  }
  if (paths.length === 0) return { reason: "The plan has no rib tall enough to build (every stretch is under 0.1 mm)." };
  if (paths.length > 400) return { reason: `The plan splits into ${paths.length} runs of one height; a rib network takes at most 400. Plan with fewer ribs (a budget or a lighter goal), or fewer height caps.` };
  const width = Math.max(...paths.map((row) => row.width as number));
  const height = Math.max(...paths.map((row) => row.height as number));
  return { kind: "ribNet", label, width, height, paths, ...(auto === undefined ? {} : { auto }) };
}

/**
 * Faces of one solid named again on another made from it (a rib step splits a floor into strips and renumbers): each
 * triangle of the old faces, by its centroid, finds the new triangles within `tol` mm turned within 10°, and their faces.
 */
export function remapFaces(before: { positions: ArrayLike<number>; faceOf: ArrayLike<number> }, faces: readonly number[], after: { positions: ArrayLike<number>; faceOf: ArrayLike<number> }, tol = 0.05): number[] {
  const want = new Set(faces);
  const tri = (pos: ArrayLike<number>, t: number) => {
    const a: V3 = [pos[t * 9]!, pos[t * 9 + 1]!, pos[t * 9 + 2]!];
    const b: V3 = [pos[t * 9 + 3]!, pos[t * 9 + 4]!, pos[t * 9 + 5]!];
    const c: V3 = [pos[t * 9 + 6]!, pos[t * 9 + 7]!, pos[t * 9 + 8]!];
    return { a, b, c, n: unit(cross(sub(b, a), sub(c, a))), centre: mul(add(add(a, b), c), 1 / 3) };
  };
  const nb = Math.floor(before.positions.length / 9);
  const na = Math.floor(after.positions.length / 9);
  const afterTris = Array.from({ length: na }, (_, t) => tri(after.positions, t));
  const cell = 5;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  afterTris.forEach((row, t) => {
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(row.a[k]!, row.b[k]!, row.c[k]!) - tol) / cell));
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(row.a[k]!, row.b[k]!, row.c[k]!) + tol) / cell));
    for (let x = lo[0]!; x <= hi[0]!; x += 1) for (let y = lo[1]!; y <= hi[1]!; y += 1) for (let z = lo[2]!; z <= hi[2]!; z += 1) {
      const k = key(x, y, z);
      const list = grid.get(k);
      if (list) list.push(t);
      else grid.set(k, [t]);
    }
  });
  const out = new Set<number>();
  const cos10 = Math.cos((10 * Math.PI) / 180);
  for (let t = 0; t < nb; t += 1) {
    if (!want.has(Number(before.faceOf[t]))) continue;
    const row = tri(before.positions, t);
    const near = grid.get(key(Math.floor(row.centre[0] / cell), Math.floor(row.centre[1] / cell), Math.floor(row.centre[2] / cell))) ?? [];
    for (const u of near) {
      const other = afterTris[u]!;
      if (dot(other.n, row.n) < cos10) continue;
      if (Math.abs(dot(sub(row.centre, other.a), other.n)) > tol) continue;
      if (!insideTriangle(row.centre, other, tol)) continue;
      out.add(Number(after.faceOf[u]));
    }
  }
  return [...out].sort((x, y) => x - y);
}

function insideTriangle(p: V3, t: { a: V3; b: V3; c: V3; n: V3 }, tol: number): boolean {
  const edges: [V3, V3][] = [[t.a, t.b], [t.b, t.c], [t.c, t.a]];
  return edges.every(([u, v]) => {
    const e = sub(v, u);
    const inward = unit(cross(t.n, e));
    return dot(sub(p, u), inward) >= -tol;
  });
}

// --- Ends on a free edge (moved from mcp/session/ribs.ts so the panel shares them). ---

/** What a rib sunk into the wall must find under it: ribNet's 0.5 mm sink and 0.2 mm skin, and a little more. */
export const WALL_UNDER_MM = 0.8;

/** The wall under a rib's foot at p, across it ±half: the least depth a ray straight in finds, 0 off the part. */
export function wallUnder(all: RibSurface, p: V3, n: V3, b: V3, half: number): number {
  let least = Infinity;
  for (const u of [-half, 0, half]) {
    // From 0.3 mm in: a point between two snapped ones on a curved wall sits a chord's depth off the facets.
    const q: V3 = [p[0] + b[0] * u - n[0] * 0.3, p[1] + b[1] * u - n[1] * 0.3, p[2] + b[2] * u - n[2] * 0.3];
    const hit = all.ray(q, [-n[0], -n[1], -n[2]], 50);
    least = Math.min(least, hit && hit.leaving ? hit.distance + 0.3 : 0);
  }
  return least;
}

/**
 * A planned rib that ends on a free edge of the wall (a panel's cut side, an open rim) is refused by ribNet: either the
 * wall under its foot runs out there, or its end runs into the thin rim and out past the part. Such an end starts a
 * rib width back from the edge, and is then drawn back 0.25 mm at a time, at most 4 mm, to where the wall under the
 * foot is WALL_UNDER_MM deep. An end against a wall (a box's side) is kept. Heights and sections keep their stretches.
 */
export function trimThinEnds(points: V3[], heights: number[], sections: Section[], wallSurface: RibSurface, all: RibSurface, width: number): { points: V3[]; heights: number[]; sections: Section[]; trimmedMm: [number, number] } {
  const trimmedMm: [number, number] = [0, 0];
  let pts = points.map((p) => [...p] as V3);
  let hs = [...heights];
  let ss = [...sections];
  for (const end of [0, 1] as const) {
    if (pts.length < 2) break;
    const order = end === 0 ? pts : [...pts].reverse();
    let walked = 0;
    let k = 0;
    let found: { at: V3; k: number } | null = null;
    // An end with no wall in front of it, half its height up and within 2 mm, is on a free edge: ribNet would run it
    // into the rim there and out past the part. It starts a width back from the edge.
    const e0 = order[0]!;
    // The rib's way out at this end, read over its last 2 mm or more: the last stretch alone can be a sliver.
    let e1 = order[1]!;
    for (let j = 1; j < order.length && dist(e0, order[j]!) < 2; j += 1) e1 = order[j]!;
    const run = dist(e0, e1);
    const n0 = wallSurface.closest(e0, 5)?.normal ?? ([0, 0, 1] as V3);
    const lift = Math.min(2, Math.max(0.5, (end === 0 ? heights[0] ?? 1 : heights.at(-1) ?? 1) / 2));
    const out: V3 = run > 1e-9 ? [(e0[0] - e1[0]) / run, (e0[1] - e1[1]) / run, (e0[2] - e1[2]) / run] : [0, 0, 0];
    // From 1 mm back along the rib: an end on a side wall's foot starts on that wall's plane, where a ray sees nothing.
    const free = run > 1e-9 && !all.ray([e0[0] + n0[0] * lift - out[0], e0[1] + n0[1] * lift - out[1], e0[2] + n0[2] * lift - out[2]], out, 3);
    const start = free ? Math.min(4, Math.max(0.25, Math.ceil(width / 0.25) * 0.25)) : 0;
    for (let s = start; s <= 4 + 1e-9; s += 0.25) {
      while (k + 1 < order.length - 1 && walked + dist(order[k]!, order[k + 1]!) < s) {
        walked += dist(order[k]!, order[k + 1]!);
        k += 1;
      }
      const a = order[k]!;
      const b = order[k + 1]!;
      const seg = dist(a, b);
      if (seg < 1e-9) break;
      const f = Math.min(1, (s - walked) / seg);
      const at: V3 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      const n = wallSurface.closest(at, 5)?.normal ?? ([0, 0, 1] as V3);
      const t: V3 = [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg, (b[2] - a[2]) / seg];
      const across: V3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
      if (wallUnder(all, at, n, across, width / 2) >= WALL_UNDER_MM) {
        found = s === 0 ? null : { at, k };
        if (s > 0) trimmedMm[end] = s;
        break;
      }
      if (f >= 1 && k + 1 >= order.length - 1) break;
    }
    if (!found) continue;
    // Keep the stretch the cut falls in, from the cut point on.
    const n = pts.length;
    if (end === 0) {
      pts = [found.at, ...pts.slice(found.k + 1)];
      hs = hs.slice(found.k);
      ss = ss.slice(found.k);
    } else {
      const j = n - 1 - found.k;
      pts = [...pts.slice(0, j), found.at];
      hs = hs.slice(0, j);
      ss = ss.slice(0, j);
    }
  }
  return { points: pts, heights: hs, sections: ss, trimmedMm };
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// --- From the plan to ribs on the wall's face (shared by ribs_plan and the Auto ribs panel). ---

/** The wall's own triangles as a surface, for the normal under each point (a rib stands along it). */
export function wallSurfaceOf(solid: RibWallSolid, faces: readonly number[]): RibSurface {
  const wallSet = new Set(faces);
  const own: number[] = [];
  const ownFace: number[] = [];
  const count = Math.floor(solid.positions.length / 9);
  for (let t = 0; t < count; t += 1) {
    if (!wallSet.has(Number(solid.faceOf[t]))) continue;
    for (let i = 0; i < 9; i += 1) own.push(solid.positions[t * 9 + i]!);
    ownFace.push(Number(solid.faceOf[t]));
  }
  return new RibSurface({ positions: own, faceOf: ownFace });
}

/** A planned rib taken onto the wall's face, with the sections it is built with and why. */
export interface FaceRib {
  points: V3[];
  heights: number[];
  sections: Section[];
  normals: V3[];
  width: number;
  height: number;
  /** One profile, or "straight+tee" when it changes along the rib. */
  profile: string;
  flangeChamferDeg?: number;
  /** For a rib with tee stretches: their length, mm. */
  teeMm?: number;
  /** How far each end was drawn back from a free edge, mm, when either was. */
  trimmedMm?: [number, number];
  why: string;
}

/** What a planned rib carries: points on the mid-surface, heights and sections per stretch. */
export interface PlanRibIn {
  points: V3[];
  heights?: number[];
  sections?: Section[];
  width?: number;
  height?: number;
}

/**
 * The plan's ribs on the wall's face: each taken off the mid-surface (`ribPathsFromPlan`), its ends drawn back from a
 * free edge (`trimThinEnds`), and each tee stretch checked against the rib's own direction (`fitFlanges`).
 */
export function ribsOnFace(solid: RibWallSolid, wall: Pick<RibWall, "request" | "skin" | "faces">, planned: readonly PlanRibIn[], build: V3, fallbackWidth: number): { ribs: FaceRib[]; snapMaxMm: number } {
  const onSkin = ribPathsFromPlan(solid, wall, planned.map((row) => ({ points: row.points })));
  const surface = wallSurfaceOf(solid, wall.faces);
  const whole = new RibSurface({ positions: solid.positions, faceOf: solid.faceOf });
  const ribs = planned.map((row, i): FaceRib => {
    const width = row.width ?? fallbackWidth;
    const trimmed = trimThinEnds(onSkin.paths[i]!.points, row.heights ?? [], (row.sections ?? []).map((s) => ({ ...s })), surface, whole, width);
    const points = trimmed.points;
    const heights = trimmed.heights;
    const height = row.height ?? Math.max(0, ...heights);
    const normals = points.map((p) => surface.closest(p, 5)?.normal ?? ([0, 0, 1] as V3));
    const fitted = fitFlanges(points, normals, heights, trimmed.sections, build);
    const length = (kind: string) => fitted.sections.reduce((sum, s, k) => sum + (s.profile === kind ? dist(points[k + 1]!, points[k]!) : 0), 0);
    const kinds = [...new Set(fitted.sections.map((s) => s.profile))];
    const tee = fitted.sections.find((s) => s.profile === "tee");
    const cut = trimmed.trimmedMm.some((mm) => mm > 0);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const why = fitted.notes.length || cut
      ? [...fitted.notes, ...(cut ? [`an end stood on a free edge of the wall (nothing to run into, or too thin to sink into), so it was drawn back ${trimmed.trimmedMm.map(r2).join(" and ")} mm`] : [])].join("; ")
      : tee ? `a tee with a ${(tee.flangeChamferDeg ?? 45) > 0 ? "45° chamfered" : "square"} flange where the rib's height is held under the greatest, straight elsewhere` : kinds[0] === "drafted" ? "drafted, as the process asks" : "straight";
    return {
      points,
      heights,
      sections: fitted.sections,
      normals,
      width,
      height,
      profile: kinds.length === 1 ? kinds[0]! : kinds.join("+"),
      ...(tee ? { flangeChamferDeg: tee.flangeChamferDeg ?? 45, teeMm: length("tee") } : {}),
      ...(cut ? { trimmedMm: trimmed.trimmedMm } : {}),
      why,
    };
  });
  return { ribs, snapMaxMm: onSkin.snapMaxMm };
}

/** The planner's profile on the wire (`WireProfile`) for what was asked, the process and the flange that prints here. */
export function wireProfileOf(asked: "auto" | RibProfileKind, process: RibProcess, flange: "chamfered" | "square" | null, extra: Record<string, number> = {}): Record<string, unknown> {
  if (asked === "straight") return { kind: "straight" };
  if (asked === "drafted" || (asked === "auto" && process === "resin")) return { kind: "drafted", ...extra };
  if (asked === "tee") return { kind: "tee", flange: flange ?? "chamfered", ...extra };
  return { kind: "auto", process, flange };
}

// --- The material card the shell model uses (moved from mcp/session/ribs.ts so the panel names the same card). ---

/** The card fields the planner and its sentence read. */
export interface RibCardIn {
  id: string;
  polymer: string;
  provisional: boolean;
  EInPlaneMPa: number;
  nu: number;
}

/**
 * The card the shell model and the verify study use: the library card for the selected filament's polymer when there
 * is one, else `fallback` (the default card), and a row saying which, so a placeholder is never presented as the
 * filament's. `note` is the sentence ribs_plan and the panel show.
 */
export function ribCardFor<C extends RibCardIn>(cards: readonly C[], filament: { name: string; material?: string | null }, fallback: C): { card: C; row: { card: string; polymer: string; eMPa: number; nu: number; provisional: boolean; filament: string; forFilament: boolean; note: string } } {
  const wanted = String(filament.material ?? "").trim().toLowerCase();
  const own = wanted ? cards.find((card) => card.polymer.trim().toLowerCase() === wanted) : undefined;
  const card = own ?? fallback;
  const values = `E ${card.EInPlaneMPa} MPa, ν ${card.nu}`;
  return {
    card,
    row: {
      card: card.id,
      polymer: card.polymer,
      eMPa: card.EInPlaneMPa,
      nu: card.nu,
      provisional: card.provisional,
      filament: filament.name,
      forFilament: own !== undefined,
      note: own
        ? `${card.id}, the library's ${card.polymer} card for ${filament.name} (${values})${card.provisional ? ": a provisional placeholder, not measured for this filament, so the numbers are relative" : ""}.`
        : `No card in the library is for ${filament.name}'s ${filament.material || "material"}; the default ${card.id} (${card.polymer}, ${values}) stands in, so the numbers are relative and not this material's.`,
    },
  };
}
