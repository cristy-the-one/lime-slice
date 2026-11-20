/**
 * Vent notches for resin (docs/plan-auto-ribs.md, the resin row). A pocket is a cell of the rib
 * network on the wall, closed all round by ribs or by borders where a side wall stands.
 *
 * Formlabs, "Preventing suction cups in PreForm": "Pointing the opening of the cavity face upward
 * in PreForm traps air between the part and the resin tank as the build platform lowers the cavity
 * against the bottom of the resin tank." The air is trapped between the part and the tank, so the
 * opening that cups is the one that faces the tank. `buildAxis` points from the platform toward the
 * tank, the direction each new layer is added. A pocket cups when the side its ribs stand on points
 * along that axis.
 *
 * The notch is one full-height gap per cupping pocket, {@link RESIN_VENT_MM} wide, at the middle of
 * a rib stretch it shares with a cell that drains. Formlabs, Form 4 design specifications: "Minimum
 * drain hole diameter. Recommended: 0.75 mm/750 micron diameter." A root hole under a continuous rib
 * top is not a ribNet section: a height is the whole stretch, and the shortest height is 0.1 mm.
 *
 * A wall whose chords, projected along the opening, cross while staying apart in space is a fold.
 * Side-wall ribs would land on floor ribs, so venting is left undone and the note says so.
 */
import { turnDir, type Affine } from "../model-space.ts";

/** Formlabs' minimum drain hole, mm. Form 4 design specifications, "Minimum drain hole diameter". */
export const RESIN_VENT_MM = 0.75;

/** A cupping cell that can only reach cells walled in by side walls. */
export const PART_CUPS = "the part itself cups here; ribs cannot vent it";

/** A cupping cell has a way out, but no boundary rib can hold the gap. */
export const TOO_SHORT = "no boundary rib is long enough for a vent";

/** The finder chose a notch, and cutting it would leave a piece shorter than the minimum rib. */
export const CUT_REFUSED = "the notch would leave a piece shorter than the minimum rib";

/** Projection of a folded wall overlaps itself. */
export const FOLDED_NOTE = "This wall's projection overlaps itself, so a rib on one face would land on a rib on another. Venting is left undone.";

/** Resin, and the caller did not give a build axis. */
export const NO_RESIN_PRINTER = "The plate has no resin printer, so the build direction is the part as it sits, +Z.";

/** Resin, and the caller gave a build axis. */
export const GIVEN_AXIS = "Build direction is the one given, in the plate frame, turned into the wall's frame.";

export type V3 = readonly [number, number, number];
export type EndKind = "closed" | "free" | "hold" | "gap";

/** One rib run. A free end, a hold and a gap end do not drain: only an open border or a through hole does. Omitted ends are closed. */
export interface VentRib {
  points: readonly V3[];
  ends?: readonly [EndKind, EndKind];
  /** Rib width, mm. Ends within half of this of another rib or a border are joined. */
  widthMm?: number;
}

/**
 * A wall border in the same drawing. `rises` is a side wall, and it closes a cell. `open` is the
 * part's edge. `hole` is a through hole. An open edge or a hole drains the cell.
 */
export interface VentBorder {
  points: readonly V3[];
  kind: "rises" | "open" | "hole";
}

export interface VentInput {
  ribs: readonly VentRib[];
  borders?: readonly VentBorder[];
  /** The side the ribs stand on. */
  opening: V3;
  /** From the platform toward the tank. Default +Z. */
  buildAxis?: V3;
  /** The printer's XY pixel, mm. Absent: the vent is exactly {@link RESIN_VENT_MM}. */
  pixelMm?: number;
  /** Shortest rib piece a notch may leave, mm. */
  minLengthMm?: number;
}

/** One notch: the rib it cuts, the point the gap is centred on, and the gap. */
export interface VentPocket {
  rib: number;
  at: [number, number, number];
  sizeMm: number;
}

export interface VentUnvented {
  at: [number, number, number];
  message: string;
}

export interface VentReport {
  /** The ribs' side points along the build axis, so a closed cell cups. */
  cups: boolean;
  /** Geometrically sealed cells, whether or not the direction cups. */
  closed: number;
  pockets: VentPocket[];
  unvented: VentUnvented[];
  sizeMm: number;
  note?: string;
}

/** One run of a wall loop, already in the wall frame. */
export interface VentLoopSpan {
  class: "joined" | "free";
  from: V3;
  to: V3;
  /** The run, corner by corner. A closed loop of one class ends where it starts; `from` and `to` are then the same point. */
  points?: readonly V3[];
}

/** A wall loop. `hole` is every loop but the longest, which is the outer border. */
export interface VentLoop {
  hole: boolean;
  spans: readonly VentLoopSpan[];
}

/** The loops the panel and ribs_plan both hand to [`ventBodyOf`]. */
export function ventLoopsOf(wall: {
  loops: readonly { spans: readonly { class: "joined" | "free"; from: V3; to: V3; points?: readonly V3[] }[] }[];
  report: { loops: readonly { hole?: boolean }[] };
}): VentLoop[] {
  return wall.loops.map((loop, i) => ({
    hole: wall.report.loops[i]?.hole === true,
    spans: loop.spans.map((span) => ({ class: span.class, from: span.from, to: span.to, points: span.points })),
  }));
}

export type RibProcessName = "filament" | "resin" | "moulded";

const WELD = 1e-4;
const AREA = 1e-3;
const CUP = 1e-6;
/** A projected crossing whose 3D ends stay this far apart is a fold, not a joint. */
const OVERLAP_MM = 1;
const CLEAR_EXTRA = 0.5;

type Kind = "rib" | "rises" | "open" | "hole";
type V2 = [number, number];

const sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): [number, number, number] | null => {
  const l = len(a);
  return l < 1e-12 ? null : [a[0] / l, a[1] / l, a[2] / l];
};
const dist2 = (a: V2, b: V2) => {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  return x * x + y * y;
};
const lerp3 = (a: V3, b: V3, t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Area-weighted normal of a wall mesh. The side the ribs stand on, before the rib side flips it. */
export function meshOpening(vertices: readonly (readonly number[])[], triangles: readonly (readonly number[])[]): [number, number, number] | null {
  const n: [number, number, number] = [0, 0, 0];
  for (const tri of triangles) {
    const a = vertices[tri[0] ?? -1];
    const b = vertices[tri[1] ?? -1];
    const c = vertices[tri[2] ?? -1];
    if (!a || !b || !c) continue;
    const ab: [number, number, number] = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const ac: [number, number, number] = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    n[0] += ab[1] * ac[2] - ab[2] * ac[1];
    n[1] += ab[2] * ac[0] - ab[0] * ac[2];
    n[2] += ab[0] * ac[1] - ab[1] * ac[0];
  }
  const l = Math.hypot(n[0], n[1], n[2]);
  return l < 1e-12 ? null : [n[0] / l, n[1] / l, n[2] / l];
}

/** At least {@link RESIN_VENT_MM}, rounded up to the printer's XY pixel when one is given. */
export function ventSizeMm(pixelMm?: number): number {
  if (!(pixelMm !== undefined && pixelMm > 0 && Number.isFinite(pixelMm))) return RESIN_VENT_MM;
  return Math.ceil((RESIN_VENT_MM - 1e-9) / pixelMm) * pixelMm;
}

/**
 * The resin fields of a rib-plan request. The panel and `ribs_plan` both call this, so the same wall
 * asks for the same pockets. `plateAxis` is in the plate frame (omitted: +Z, the part as it sits);
 * it is turned into the wall frame by the plate orientation and the pose, and the printer's own
 * direction is not used. Filament and moulded get nothing.
 */
export function ventBodyOf(process: RibProcessName, frame: { orient: readonly number[]; pose: Affine }, loops: readonly VentLoop[], plateAxis?: V3 | null): { vent: true; buildAxis: [number, number, number]; borders: VentBorder[] } | Record<string, never> {
  if (process !== "resin") return {};
  return { vent: true, buildAxis: plateToWall(frame.orient, frame.pose, plateAxis ?? [0, 0, 1]), borders: bordersOf(loops) };
}

/** Plate-frame direction into the wall frame: the plate axes are the rows of `orient`, then the pose. */
export function plateToWall(orient: readonly number[], pose: Affine, plateAxis: V3): [number, number, number] {
  const row = (k: number): V3 => [orient[3 * k] ?? 0, orient[3 * k + 1] ?? 0, orient[3 * k + 2] ?? 0];
  const [x, y, z] = [row(0), row(1), row(2)];
  const inPart: [number, number, number] = [
    plateAxis[0] * x[0] + plateAxis[1] * y[0] + plateAxis[2] * z[0],
    plateAxis[0] * x[1] + plateAxis[1] * y[1] + plateAxis[2] * z[1],
    plateAxis[0] * x[2] + plateAxis[1] * y[2] + plateAxis[2] * z[2],
  ];
  const turned = turnDir(pose, inPart);
  return [turned[0], turned[1], turned[2]];
}

function spanPoints(span: VentLoopSpan): [number, number, number][] {
  const source = span.points && span.points.length >= 2 ? span.points : [span.from, span.to];
  const out: [number, number, number][] = [];
  for (const p of source) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1] || last[2] !== p[2]) out.push([p[0], p[1], p[2]]);
  }
  return out;
}

function bordersOf(loops: readonly VentLoop[]): VentBorder[] {
  const out: VentBorder[] = [];
  for (const loop of loops) {
    if (loop.spans.length === 0) continue;
    // An inner loop is a through hole only when it is open. A joined loop is a standing wall, and it closes the cell.
    if (loop.hole && loop.spans.some((span) => span.class !== "joined")) {
      const points: [number, number, number][] = [];
      for (const span of loop.spans) {
        for (const p of spanPoints(span)) {
          const last = points[points.length - 1];
          if (!last || last[0] !== p[0] || last[1] !== p[1] || last[2] !== p[2]) points.push(p);
        }
      }
      const first = points[0];
      const last = points[points.length - 1];
      if (first && last && (first[0] !== last[0] || first[1] !== last[1] || first[2] !== last[2])) points.push([first[0], first[1], first[2]]);
      if (points.length >= 2) out.push({ points, kind: "hole" });
      continue;
    }
    for (const span of loop.spans) {
      const points = spanPoints(span);
      if (points.length < 2) continue;
      out.push({ points, kind: span.class === "joined" ? "rises" : "open" });
    }
  }
  return out;
}

interface Seg {
  a: V2;
  b: V2;
  a3: [number, number, number];
  b3: [number, number, number];
  kind: Kind;
  rib: number;
  looseA: boolean;
  looseB: boolean;
  gapA: boolean;
  gapB: boolean;
  width: number;
}

interface Half {
  from: number;
  to: number;
  edge: number;
  kind: Kind;
  rib: number;
}

interface Edge {
  a: number;
  b: number;
  kind: Kind;
  rib: number;
  a3: [number, number, number];
  b3: [number, number, number];
  width: number;
}

interface Face {
  id: number;
  halves: Half[];
  ring: number[];
  open: boolean;
  sealed: boolean;
  at2: V2;
  at3: [number, number, number];
}

interface Link {
  face: number;
  edge: number;
  rib: number;
}

/** Closed cells, and one vent each for the cupping cells that can drain through a notch. */
export function ventPockets(input: VentInput): VentReport {
  const sizeMm = ventSizeMm(input.pixelMm);
  const minLength = input.minLengthMm ?? 0;
  const opening = unit(input.opening);
  const build = unit(input.buildAxis ?? [0, 0, 1]);
  const empty = (cups: boolean, note?: string): VentReport => ({ cups, closed: 0, pockets: [], unvented: [], sizeMm, ...(note ? { note } : {}) });
  if (!opening || !build) return empty(false);
  const cups = dot(opening, build) > CUP;
  const axis = Math.abs(opening[0]) < 0.9 ? ([1, 0, 0] as const) : ([0, 1, 0] as const);
  const u = unit(cross(axis, opening));
  if (!u) return empty(cups);
  const v = cross(opening, u);
  const origin = firstPoint(input) ?? [0, 0, 0];
  const project = (p: V3): V2 => {
    const d = sub(p, origin);
    return [dot(d, u), dot(d, v)];
  };
  const segs: Seg[] = [];
  const push = (points: readonly V3[], kind: Kind, rib: number, looseA: boolean, looseB: boolean, gapA: boolean, gapB: boolean, width: number) => {
    for (let i = 1; i < points.length; i += 1) {
      const p = points[i - 1]!;
      const q = points[i]!;
      const a3: [number, number, number] = [p[0], p[1], p[2]];
      const b3: [number, number, number] = [q[0], q[1], q[2]];
      const a = project(a3);
      const b = project(b3);
      if (dist2(a, b) < WELD * WELD) continue;
      segs.push({ a, b, a3, b3, kind, rib, looseA: i === 1 && looseA, looseB: i === points.length - 1 && looseB, gapA: i === 1 && gapA, gapB: i === points.length - 1 && gapB, width });
    }
  };
  input.ribs.forEach((rib, i) => push(rib.points, "rib", i, rib.ends?.[0] === "free", rib.ends?.[1] === "free", rib.ends?.[0] === "gap", rib.ends?.[1] === "gap", rib.widthMm ?? 0));
  for (const border of input.borders ?? []) push(border.points, border.kind, -1, false, false, false, false, 0);
  if (segs.length === 0) return empty(cups);
  seatBorders(segs, opening);
  if (selfOverlaps(segs)) return empty(cups, FOLDED_NOTE);
  joinEnds(segs);
  const pieces = splitSegs(segs);
  const built = buildGraph(pieces);
  if (!built) return empty(cups);
  const faces = walkFaces(built);
  markHoles(faces, built);
  drainThroughGaps(faces, built);
  const sealed = faces.filter((face) => face.sealed);
  if (!cups) return { cups: false, closed: sealed.length, pockets: [], unvented: [], sizeMm };
  const adj = adjacency(faces, built.edges);
  const openIds = faces.filter((face) => face.open).map((face) => face.id);
  const reach = reachable(openIds, adj);
  const parent = new Map<number, Link>();
  const seen = new Set(openIds);
  const order: number[] = [];
  const queue = [...openIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const links = [...(adj[id] ?? [])].sort((a, b) => a.rib - b.rib || a.edge - b.edge);
    for (const link of links) {
      if (seen.has(link.face)) continue;
      seen.add(link.face);
      parent.set(link.face, { face: id, edge: link.edge, rib: link.rib });
      order.push(link.face);
      queue.push(link.face);
    }
  }
  const draining = new Set(openIds);
  const vented = new Set<number>();
  const pockets: VentPocket[] = [];
  const taken: { rib: number; at: V2 }[] = [];
  const gaps = new Map<number, [number, number][]>();
  for (const id of order) {
    if (!sealed.some((face) => face.id === id)) continue;
    const pref = parent.get(id);
    const links = [...(adj[id] ?? [])].filter((link) => draining.has(link.face)).sort((a, b) => a.rib - b.rib || a.edge - b.edge);
    if (pref && draining.has(pref.face)) {
      const at = links.findIndex((link) => link.edge === pref.edge && link.face === pref.face);
      if (at > 0) links.unshift(links.splice(at, 1)[0]!);
    }
    for (const link of links) {
      const placed = placeNotch(built, link, sizeMm, minLength, taken, gaps);
      if (!placed) continue;
      pockets.push({ rib: placed.rib, at: placed.at, sizeMm });
      taken.push({ rib: placed.rib, at: placed.flat });
      const list = gaps.get(placed.rib) ?? [];
      list.push(placed.span);
      gaps.set(placed.rib, list);
      draining.add(id);
      vented.add(id);
      break;
    }
  }
  const unvented: VentUnvented[] = [];
  for (const face of sealed) {
    if (!reach.has(face.id)) unvented.push({ at: face.at3, message: PART_CUPS });
    else if (!vented.has(face.id)) unvented.push({ at: face.at3, message: TOO_SHORT });
  }
  unvented.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2]);
  pockets.sort((a, b) => a.rib - b.rib || a.at[0] - b.at[0] || a.at[1] - b.at[1]);
  return { cups: true, closed: sealed.length, pockets, unvented, sizeMm };
}

/**
 * Cut each vent out of its rib. The gap is centred on `at`. Its new ends are gaps: they open only
 * into the cell on the other side of the rib, and a later read must not treat them as loose ends.
 * A cut that would leave a piece shorter than `minLengthMm` is not made.
 */
export function notchRibs(ribs: readonly VentRib[], pockets: readonly VentPocket[], minLengthMm = 0): { ribs: VentRib[]; pockets: VentPocket[]; refused: VentUnvented[] } {
  const cuts = new Map<number, V3[]>();
  for (const pocket of pockets) {
    const list = cuts.get(pocket.rib) ?? [];
    list.push(pocket.at);
    cuts.set(pocket.rib, list);
  }
  const out: VentRib[] = [];
  const kept: VentPocket[] = [];
  const refused: VentUnvented[] = [];
  ribs.forEach((rib, i) => {
    const at = cuts.get(i);
    if (!at?.length) {
      out.push({ points: rib.points.map((p) => [p[0], p[1], p[2]]), ...(rib.ends ? { ends: [rib.ends[0], rib.ends[1]] as [EndKind, EndKind] } : {}), ...(rib.widthMm !== undefined ? { widthMm: rib.widthMm } : {}) });
      return;
    }
    const size = pockets.find((p) => p.rib === i)?.sizeMm ?? RESIN_VENT_MM;
    const pieces = splitRib(rib, at, size, minLengthMm);
    if (!pieces) {
      for (const pocket of pockets.filter((p) => p.rib === i)) refused.push({ at: pocket.at, message: CUT_REFUSED });
      out.push({ points: rib.points.map((p) => [p[0], p[1], p[2]]), ...(rib.ends ? { ends: [rib.ends[0], rib.ends[1]] as [EndKind, EndKind] } : {}), ...(rib.widthMm !== undefined ? { widthMm: rib.widthMm } : {}) });
      return;
    }
    const base = out.length;
    out.push(...pieces);
    for (const pocket of pockets.filter((p) => p.rib === i)) {
      const ribIndex = out.findIndex((piece, k) => k >= base && piece.points.some((p) => Math.hypot(p[0] - pocket.at[0], p[1] - pocket.at[1], p[2] - pocket.at[2]) < 1));
      kept.push({ ...pocket, rib: ribIndex >= 0 ? ribIndex : base });
    }
  });
  return { ribs: out, pockets: kept, refused };
}

/** Borders are drawn on the face and ribs on the mid-surface. Drop the borders onto the rib plane before the fold check. */
function seatBorders(segs: Seg[], opening: [number, number, number]): void {
  const origin = segs.find((seg) => seg.kind === "rib")?.a3;
  if (!origin) return;
  const drop = (p: [number, number, number]): [number, number, number] => {
    const d = (p[0] - origin[0]) * opening[0] + (p[1] - origin[1]) * opening[1] + (p[2] - origin[2]) * opening[2];
    return [p[0] - opening[0] * d, p[1] - opening[1] * d, p[2] - opening[2] * d];
  };
  for (const seg of segs) {
    if (seg.kind === "rib") continue;
    seg.a3 = drop(seg.a3);
    seg.b3 = drop(seg.b3);
  }
}

function selfOverlaps(segs: Seg[]): boolean {
  const endOnBorder = (rib: Seg, other: Seg, t: number, u: number) => {
    const ribEnd = t <= 1e-6 || t >= 1 - 1e-6;
    const otherEnd = u <= 1e-6 || u >= 1 - 1e-6;
    if (rib.kind === "rib" && other.kind !== "rib" && ribEnd) return true;
    if (other.kind === "rib" && rib.kind !== "rib" && otherEnd) return true;
    return false;
  };
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const hit = intersect(segs[i]!, segs[j]!);
      if (!hit) continue;
      if (hit.t <= 1e-6 && hit.u <= 1e-6) continue;
      if (hit.t <= 1e-6 && hit.u >= 1 - 1e-6) continue;
      if (hit.t >= 1 - 1e-6 && hit.u <= 1e-6) continue;
      if (hit.t >= 1 - 1e-6 && hit.u >= 1 - 1e-6) continue;
      if (endOnBorder(segs[i]!, segs[j]!, hit.t, hit.u)) continue;
      const p = lerp3(segs[i]!.a3, segs[i]!.b3, hit.t);
      const q = lerp3(segs[j]!.a3, segs[j]!.b3, hit.u);
      if (len(sub(p, q)) > OVERLAP_MM) return true;
    }
  }
  return false;
}

/** A rib end that stops within half its width of another rib or a border is extended onto it. An interior vertex of the polyline stays where it is. */
function joinEnds(segs: Seg[]): void {
  const same = (p: V2, q: V2) => dist2(p, q) <= WELD * WELD;
  const ribEnd = (i: number, atStart: boolean) => {
    const seg = segs[i]!;
    const p = atStart ? seg.a : seg.b;
    let n = 0;
    for (const other of segs) {
      if (other.kind !== "rib" || other.rib !== seg.rib) continue;
      if (same(other.a, p) || same(other.b, p)) n += 1;
    }
    return n === 1;
  };
  const move = (seg: Seg, atStart: boolean, q: V2, q3: [number, number, number]) => {
    if (atStart) {
      seg.a = q;
      seg.a3 = q3;
    } else {
      seg.b = q;
      seg.b3 = q3;
    }
  };
  for (let i = 0; i < segs.length; i += 1) {
    if (segs[i]!.kind !== "rib") continue;
    const reach = segs[i]!.width / 2;
    if (!(reach > WELD)) continue;
    for (const atStart of [true, false]) {
      if (!ribEnd(i, atStart)) continue;
      const p = atStart ? segs[i]!.a : segs[i]!.b;
      let best: { d: number; q: V2; q3: [number, number, number] } | null = null;
      for (let j = 0; j < segs.length; j += 1) {
        if (j === i) continue;
        const other = segs[j]!;
        const hit = closest(p, other.a, other.b);
        if (hit.d > reach || hit.d <= WELD) continue;
        if (!best || hit.d < best.d) best = { d: hit.d, q: hit.q, q3: lerp3(other.a3, other.b3, hit.t) };
      }
      if (best) move(segs[i]!, atStart, best.q, best.q3);
    }
  }
}

function closest(p: V2, a: V2, b: V2): { q: V2; d: number; t: number } {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const ab2 = abx * abx + aby * aby;
  const t = ab2 < 1e-18 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / ab2));
  const q: V2 = [a[0] + abx * t, a[1] + aby * t];
  return { q, d: Math.hypot(p[0] - q[0], p[1] - q[1]), t };
}

function buildGraph(pieces: Seg[]): { xy: V2[]; xyz: [number, number, number][]; edges: Edge[]; loose: Set<number>; gap: Set<number>; out: Half[][] } | null {
  if (pieces.length === 0) return null;
  const keyOf = (q: V2) => `${Math.round(q[0] / WELD)}:${Math.round(q[1] / WELD)}`;
  const xy: V2[] = [];
  const xyz: [number, number, number][] = [];
  const idOf = new Map<string, number>();
  const vid = (q: V2, q3: [number, number, number]) => {
    const key = keyOf(q);
    const had = idOf.get(key);
    if (had !== undefined) return had;
    const id = xy.length;
    xy.push(q);
    xyz.push(q3);
    idOf.set(key, id);
    return id;
  };
  const loose = new Set<number>();
  const gap = new Set<number>();
  const edges: Edge[] = [];
  const seenEdge = new Set<string>();
  for (const seg of pieces) {
    const a = vid(seg.a, seg.a3);
    const b = vid(seg.b, seg.b3);
    if (a === b) continue;
    if (seg.looseA) loose.add(a);
    if (seg.looseB) loose.add(b);
    if (seg.gapA) gap.add(a);
    if (seg.gapB) gap.add(b);
    const key = a < b ? `${a}:${b}:${seg.kind}:${seg.rib}` : `${b}:${a}:${seg.kind}:${seg.rib}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push({ a, b, kind: seg.kind, rib: seg.rib, a3: xyz[a]!, b3: xyz[b]!, width: seg.width });
  }
  const out: Half[][] = xy.map(() => []);
  edges.forEach((edge, i) => {
    out[edge.a]!.push({ from: edge.a, to: edge.b, edge: i, kind: edge.kind, rib: edge.rib });
    out[edge.b]!.push({ from: edge.b, to: edge.a, edge: i, kind: edge.kind, rib: edge.rib });
  });
  const ang = (h: Half) => Math.atan2(xy[h.to]![1] - xy[h.from]![1], xy[h.to]![0] - xy[h.from]![0]);
  for (const list of out) list.sort((p, q) => ang(p) - ang(q) || p.edge - q.edge);
  return { xy, xyz, edges, loose, gap, out };
}

/** A gap opens only the two cells on either side of that rib, and only into each other. */
function drainThroughGaps(faces: Face[], built: { edges: Edge[]; gap: Set<number> }): void {
  const users: number[][] = built.edges.map(() => []);
  for (const face of faces) {
    const seen = new Set<number>();
    for (const half of face.halves) {
      if (seen.has(half.edge)) continue;
      seen.add(half.edge);
      users[half.edge]!.push(face.id);
    }
  }
  const adj: number[][] = faces.map(() => []);
  built.edges.forEach((edge, index) => {
    if (!built.gap.has(edge.a) && !built.gap.has(edge.b)) return;
    const ids = [...new Set(users[index] ?? [])];
    for (const a of ids) {
      for (const b of ids) {
        if (a !== b) adj[a]!.push(b);
      }
    }
  });
  const open = new Set(faces.filter((face) => face.open).map((face) => face.id));
  const queue = [...open];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of adj[id] ?? []) {
      if (open.has(next)) continue;
      open.add(next);
      queue.push(next);
    }
  }
  for (const face of faces) {
    if (!open.has(face.id) || !face.sealed) continue;
    face.sealed = false;
    face.open = true;
  }
}

function walkFaces(built: { xy: V2[]; xyz: [number, number, number][]; edges: Edge[]; loose: Set<number>; out: Half[][] }): Face[] {
  const { xy, xyz, out } = built;
  const nextOf = (h: Half): Half => {
    const list = out[h.to] ?? [];
    let i = list.findIndex((row) => row.edge === h.edge);
    if (i < 0) i = 0;
    return list[(i - 1 + list.length) % list.length]!;
  };
  const used = new Set<string>();
  const faces: Face[] = [];
  for (const list of out) {
    for (const start of list) {
      const startKey = `${start.from}:${start.edge}`;
      if (used.has(startKey)) continue;
      const halves: Half[] = [];
      let h = start;
      let guard = 0;
      let closed = false;
      while (guard++ < built.edges.length * 2 + 4) {
        const key = `${h.from}:${h.edge}`;
        if (used.has(key)) break;
        used.add(key);
        halves.push(h);
        h = nextOf(h);
        if (h.from === start.from && h.edge === start.edge) {
          closed = true;
          break;
        }
      }
      if (!closed || halves.length < 3) continue;
      let area = 0;
      for (const row of halves) {
        const p = xy[row.from]!;
        const q = xy[row.to]!;
        area += p[0] * q[1] - q[0] * p[1];
      }
      if (Math.abs(area) < AREA) continue;
      const ring = halves.map((row) => row.from);
      let sx = 0;
      let sy = 0;
      const at3: [number, number, number] = [0, 0, 0];
      for (const id of ring) {
        sx += xy[id]![0];
        sy += xy[id]![1];
        at3[0] += xyz[id]![0];
        at3[1] += xyz[id]![1];
        at3[2] += xyz[id]![2];
      }
      const n = ring.length;
      at3[0] /= n;
      at3[1] /= n;
      at3[2] /= n;
      const bounded = area > 0;
      const drains = halves.some((row) => row.kind === "open" || row.kind === "hole");
      const wall = halves.every((row) => row.kind === "rib" || row.kind === "rises");
      faces.push({
        id: faces.length,
        halves,
        ring,
        open: !bounded || drains || !wall,
        sealed: bounded && wall && !drains,
        at2: [sx / n, sy / n],
        at3,
      });
    }
  }
  return faces;
}

/** A through hole lying inside a sealed cell drains that cell. The hole loop itself is not a pocket. */
function markHoles(faces: Face[], built: { xy: V2[]; edges: Edge[] }): void {
  const holes = faces.filter((face) => face.halves.every((row) => row.kind === "hole") && face.halves.length >= 3);
  for (const hole of holes) {
    const q = hole.at2;
    for (const face of faces) {
      if (!face.sealed || face.id === hole.id) continue;
      if (inside(face.ring.map((id) => built.xy[id]!), q)) {
        face.sealed = false;
        face.open = true;
      }
    }
  }
}

function inside(poly: V2[], q: V2): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    if (pi[1] > q[1] !== pj[1] > q[1] && q[0] < ((pj[0] - pi[0]) * (q[1] - pi[1])) / (pj[1] - pi[1] + 0) + pi[0]) c = !c;
  }
  return c;
}

function adjacency(faces: Face[], edges: Edge[]): Link[][] {
  const users: number[][] = edges.map(() => []);
  for (const face of faces) {
    const seen = new Set<number>();
    for (const half of face.halves) {
      if (seen.has(half.edge)) continue;
      seen.add(half.edge);
      users[half.edge]!.push(face.id);
    }
  }
  const adj: Link[][] = faces.map(() => []);
  users.forEach((ids, edge) => {
    const rib = edges[edge]!.rib;
    if (rib < 0 || edges[edge]!.kind !== "rib") return;
    const unique = [...new Set(ids)];
    if (unique.length < 2) return;
    for (const a of unique) {
      for (const b of unique) {
        if (a === b) continue;
        adj[a]!.push({ face: b, edge, rib });
      }
    }
  });
  return adj;
}

function reachable(roots: number[], adj: Link[][]): Set<number> {
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const link of adj[id] ?? []) {
      if (seen.has(link.face)) continue;
      seen.add(link.face);
      queue.push(link.face);
    }
  }
  return seen;
}

function placeNotch(built: { xy: V2[]; xyz: [number, number, number][]; edges: Edge[]; out: Half[][] }, link: Link, sizeMm: number, minLength: number, taken: { rib: number; at: V2 }[], gaps: Map<number, [number, number][]>): { rib: number; at: [number, number, number]; flat: V2; span: [number, number] } | null {
  const edge = built.edges[link.edge];
  if (!edge || edge.rib < 0) return null;
  const chain = stretchEdges(built, link.edge);
  const ids = orderedVerts(built, chain);
  if (ids.length < 2) return null;
  const points = ids.map((id) => built.xyz[id]!);
  const span = polyLength(points);
  const clear = edge.width / 2 + CLEAR_EXTRA;
  // The gap sits at the middle of the stretch between crossings, so each end stays half a width plus 0.5 mm clear of it.
  if (span / 2 - sizeMm / 2 < clear - 1e-6) return null;
  const at = pointAt(points, span / 2);
  const flat = flatAt(built, ids, span / 2);
  if (taken.some((cut) => cut.rib === edge.rib && Math.hypot(cut.at[0] - flat[0], cut.at[1] - flat[1]) < sizeMm)) return null;
  const total = built.edges.filter((row) => row.rib === edge.rib).reduce((sum, row) => sum + Math.hypot(row.b3[0] - row.a3[0], row.b3[1] - row.a3[1], row.b3[2] - row.a3[2]), 0);
  const s = arcOf(built.edges, edge.rib, at);
  const lo = s - sizeMm / 2;
  const hi = s + sizeMm / 2;
  const existing = gaps.get(edge.rib) ?? [];
  if (!piecesFit(total, [...existing, [lo, hi]], minLength)) return null;
  return { rib: edge.rib, at, flat, span: [lo, hi] };
}

/** Edges of one rib from the previous crossing or border to the next. Colinear samples in between stay in the stretch. */
function stretchEdges(built: { edges: Edge[]; out: Half[][] }, index: number): number[] {
  const rib = built.edges[index]?.rib ?? -1;
  const stop = (vid: number) => {
    const list = built.out[vid] ?? [];
    const mine = new Set(list.filter((half) => built.edges[half.edge]?.rib === rib).map((half) => half.edge));
    const foreign = list.some((half) => built.edges[half.edge]?.rib !== rib);
    return foreign || mine.size !== 2;
  };
  const go = (vid: number, prev: number): number[] => {
    const extra: number[] = [];
    let at = vid;
    let came = prev;
    for (;;) {
      if (stop(at)) break;
      const next = (built.out[at] ?? []).find((half) => half.edge !== came && built.edges[half.edge]?.rib === rib);
      if (!next) break;
      extra.push(next.edge);
      came = next.edge;
      at = next.to;
    }
    return extra;
  };
  const edge = built.edges[index]!;
  return [...go(edge.a, index).reverse(), index, ...go(edge.b, index)];
}

function orderedVerts(built: { edges: Edge[] }, edgeIds: number[]): number[] {
  const first = built.edges[edgeIds[0]!];
  if (!first) return [];
  if (edgeIds.length === 1) return [first.a, first.b];
  const second = built.edges[edgeIds[1]!]!;
  const start = first.a === second.a || first.a === second.b ? first.b : first.a;
  const verts = [start];
  let prev = start;
  for (const id of edgeIds) {
    const edge = built.edges[id]!;
    const next = edge.a === prev ? edge.b : edge.a;
    verts.push(next);
    prev = next;
  }
  return verts;
}

function flatAt(built: { xy: V2[] }, ids: number[], s: number): V2 {
  let run = 0;
  for (let i = 1; i < ids.length; i += 1) {
    const a = built.xy[ids[i - 1]!]!;
    const b = built.xy[ids[i]!]!;
    const step = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (run + step >= s - 1e-9 || i === ids.length - 1) {
      const t = step < 1e-12 ? 0 : Math.min(1, Math.max(0, (s - run) / step));
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    run += step;
  }
  const last = built.xy[ids.at(-1)!]!;
  return [last[0], last[1]];
}

/** Arc length along a rib, walked from the end with the smaller key, up to the point nearest `at`. */
function arcOf(edges: Edge[], rib: number, at: [number, number, number]): number {
  const ofRib = edges.map((row, i) => ({ row, i })).filter((item) => item.row.rib === rib);
  if (ofRib.length === 0) return 0;
  const key = (p: [number, number, number]) => `${Math.round(p[0] / WELD)}:${Math.round(p[1] / WELD)}:${Math.round(p[2] / WELD)}`;
  const byVert = new Map<string, { i: number; length: number; a: [number, number, number]; b: [number, number, number] }[]>();
  for (const item of ofRib) {
    const length = Math.hypot(item.row.b3[0] - item.row.a3[0], item.row.b3[1] - item.row.a3[1], item.row.b3[2] - item.row.a3[2]);
    for (const p of [item.row.a3, item.row.b3]) {
      const list = byVert.get(key(p)) ?? [];
      list.push({ i: item.i, length, a: item.row.a3, b: item.row.b3 });
      byVert.set(key(p), list);
    }
  }
  const ends: string[] = [];
  for (const [k, list] of byVert) if (list.length === 1) ends.push(k);
  ends.sort();
  let cursor = ends[0];
  if (!cursor) return 0;
  let run = 0;
  let best = 0;
  let bestD = Infinity;
  const seen = new Set<number>();
  for (let guard = 0; guard < ofRib.length + 2; guard += 1) {
    const next = (byVert.get(cursor) ?? []).find((item) => !seen.has(item.i));
    if (!next) break;
    seen.add(next.i);
    const a = key(next.a) === cursor ? next.a : next.b;
    const b = a === next.a ? next.b : next.a;
    const ab = sub(b, a);
    const ab2 = dot(ab, ab);
    const t = ab2 < 1e-18 ? 0 : Math.min(1, Math.max(0, dot(sub(at, a), ab) / ab2));
    const q = lerp3(a, b, t);
    const d = len(sub(at, q));
    if (d < bestD) {
      bestD = d;
      best = run + Math.sqrt(ab2) * t;
    }
    run += next.length;
    cursor = key(b);
  }
  return best;
}

function piecesFit(total: number, gaps: [number, number][], minLength: number): boolean {
  const merged: [number, number][] = [];
  for (const gap of [...gaps].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && gap[0] <= last[1] + WELD) last[1] = Math.max(last[1], gap[1]);
    else merged.push([gap[0], gap[1]]);
  }
  let cursor = 0;
  for (const gap of merged) {
    if (gap[0] - cursor < minLength - 1e-6) return false;
    cursor = gap[1];
  }
  return total - cursor >= minLength - 1e-6;
}

function splitSegs(segs: Seg[]): Seg[] {
  const cuts: number[][] = segs.map(() => []);
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const hit = intersect(segs[i]!, segs[j]!);
      if (!hit) continue;
      if (hit.t > 1e-6 && hit.t < 1 - 1e-6) cuts[i]!.push(hit.t);
      if (hit.u > 1e-6 && hit.u < 1 - 1e-6) cuts[j]!.push(hit.u);
    }
  }
  const out: Seg[] = [];
  segs.forEach((seg, i) => {
    const ts = [0, ...cuts[i]!.sort((a, b) => a - b), 1];
    for (let k = 1; k < ts.length; k += 1) {
      const t0 = ts[k - 1]!;
      const t1 = ts[k]!;
      if (t1 - t0 < 1e-8) continue;
      const a: V2 = [seg.a[0] + (seg.b[0] - seg.a[0]) * t0, seg.a[1] + (seg.b[1] - seg.a[1]) * t0];
      const b: V2 = [seg.a[0] + (seg.b[0] - seg.a[0]) * t1, seg.a[1] + (seg.b[1] - seg.a[1]) * t1];
      if (dist2(a, b) < WELD * WELD) continue;
      out.push({
        a,
        b,
        a3: lerp3(seg.a3, seg.b3, t0),
        b3: lerp3(seg.a3, seg.b3, t1),
        kind: seg.kind,
        rib: seg.rib,
        looseA: k === 1 && seg.looseA,
        looseB: k === ts.length - 1 && seg.looseB,
        gapA: k === 1 && seg.gapA,
        gapB: k === ts.length - 1 && seg.gapB,
        width: seg.width,
      });
    }
  });
  return out;
}

function intersect(p: Seg, q: Seg): { t: number; u: number } | null {
  const rx = p.b[0] - p.a[0];
  const ry = p.b[1] - p.a[1];
  const sx = q.b[0] - q.a[0];
  const sy = q.b[1] - q.a[1];
  const den = rx * sy - ry * sx;
  const qx = q.a[0] - p.a[0];
  const qy = q.a[1] - p.a[1];
  if (Math.abs(den) < 1e-12) {
    const on = (a: V2, b: V2, c: V2) => {
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const acx = c[0] - a[0];
      const acy = c[1] - a[1];
      const ab2 = abx * abx + aby * aby;
      if (ab2 < 1e-18) return null;
      const t = (acx * abx + acy * aby) / ab2;
      if (t <= 1e-6 || t >= 1 - 1e-6) return null;
      const dx = a[0] + abx * t - c[0];
      const dy = a[1] + aby * t - c[1];
      return dx * dx + dy * dy < WELD * WELD ? t : null;
    };
    const t = on(p.a, p.b, q.a);
    if (t !== null) return { t, u: 0 };
    const t2 = on(p.a, p.b, q.b);
    if (t2 !== null) return { t: t2, u: 1 };
    const u = on(q.a, q.b, p.a);
    if (u !== null) return { t: 0, u };
    const u2 = on(q.a, q.b, p.b);
    if (u2 !== null) return { t: 1, u: u2 };
    return null;
  }
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)) };
}

function splitRib(rib: VentRib, centers: readonly V3[], size: number, minLength: number): VentRib[] | null {
  const pts = rib.points;
  const total = polyLength(pts);
  if (total < WELD) return null;
  const gaps: [number, number][] = [];
  for (const at of centers) {
    const s = paramOf(pts, at);
    if (s === null) continue;
    const half = size / 2;
    const lo = Math.max(0, s - half);
    const hi = Math.min(total, s + half);
    if (hi - lo < WELD) continue;
    gaps.push([lo, hi]);
  }
  if (gaps.length === 0 || !piecesFit(total, gaps, minLength)) return null;
  gaps.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const gap of gaps) {
    const last = merged.at(-1);
    if (last && gap[0] <= last[1] + WELD) last[1] = Math.max(last[1], gap[1]);
    else merged.push([gap[0], gap[1]]);
  }
  const spans: [number, number][] = [];
  let cursor = 0;
  for (const gap of merged) {
    if (gap[0] - cursor > WELD) spans.push([cursor, gap[0]]);
    cursor = gap[1];
  }
  if (total - cursor > WELD) spans.push([cursor, total]);
  return spans.map((span, i) => {
    const points = sample(pts, span[0], span[1]);
    const start: EndKind = i === 0 ? (rib.ends?.[0] ?? "closed") : "gap";
    const end: EndKind = i === spans.length - 1 ? (rib.ends?.[1] ?? "closed") : "gap";
    return { points, ends: [start, end] as [EndKind, EndKind], ...(rib.widthMm !== undefined ? { widthMm: rib.widthMm } : {}) };
  });
}

function polyLength(pts: readonly V3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i += 1) s += len(sub(pts[i]!, pts[i - 1]!));
  return s;
}

function paramOf(pts: readonly V3[], at: V3): number | null {
  let best = Infinity;
  let atS = 0;
  let run = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const ab = sub(b, a);
    const ab2 = dot(ab, ab);
    const t = ab2 < 1e-18 ? 0 : Math.min(1, Math.max(0, dot(sub(at, a), ab) / ab2));
    const q = lerp3(a, b, t);
    const d = len(sub(at, q));
    if (d < best) {
      best = d;
      atS = run + Math.sqrt(ab2) * t;
    }
    run += Math.sqrt(ab2);
  }
  return best <= 0.5 ? atS : null;
}

function sample(pts: readonly V3[], lo: number, hi: number): [number, number, number][] {
  const out: [number, number, number][] = [pointAt(pts, lo)];
  let run = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const step = len(sub(pts[i]!, pts[i - 1]!));
    const next = run + step;
    if (next > lo + WELD && next < hi - WELD) out.push([pts[i]![0], pts[i]![1], pts[i]![2]]);
    run = next;
  }
  out.push(pointAt(pts, hi));
  return out;
}

function pointAt(pts: readonly V3[], s: number): [number, number, number] {
  let run = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const step = len(sub(b, a));
    if (run + step >= s - 1e-9 || i === pts.length - 1) {
      const t = step < 1e-12 ? 0 : Math.min(1, Math.max(0, (s - run) / step));
      return lerp3(a, b, t);
    }
    run += step;
  }
  const last = pts.at(-1)!;
  return [last[0], last[1], last[2]];
}

function firstPoint(input: VentInput): [number, number, number] | null {
  for (const rib of input.ribs) {
    const p = rib.points[0];
    if (p) return [p[0], p[1], p[2]];
  }
  return null;
}
