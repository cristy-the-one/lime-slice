/**
 * Vent notches for resin (docs/plan-auto-ribs.md, the resin row). A pocket is a cell of the rib network
 * drawn on the wall, closed all round by ribs or by borders where a side wall stands. It cups when that
 * cell's opening faces the build platform.
 *
 * Formlabs, "Preventing suction cups in PreForm": "Pointing the opening of the cavity face upward in
 * PreForm traps air between the part and the resin tank as the build platform lowers the cavity against
 * the bottom of the resin tank." The opening has to face the platform to cup, and face the tank to drain.
 * Here the build axis points away from the plate, toward where each new layer is laid (the tank side). A
 * pocket cups when its opening points against that axis.
 *
 * The notch is one full-height gap per cupping pocket, `RESIN_VENT_MM` wide. Formlabs, Form 4 design
 * specifications: "Minimum drain hole diameter. Recommended: 0.75 mm/750 micron diameter." The printer
 * record has no XY pixel, so the gap is that figure and is not rounded. A root hole under a continuous
 * rib top is not a ribNet section (a height is the whole stretch), so the notch is a gap in the run.
 *
 * The arrangement is the ribs' chords projected onto the plane of the opening. A flat wall is that plane.
 * A curved wall is read by its chords, not by a geodesic arrangement.
 */

/** Formlabs' minimum drain hole, mm. Form 4 design specifications, "Minimum drain hole diameter". */
export const RESIN_VENT_MM = 0.75;

export type V3 = readonly [number, number, number];
export type EndKind = "closed" | "free";

/** One rib run. A free end drains every cell that touches it. Omitted ends are closed. */
export interface VentRib {
  points: readonly V3[];
  ends?: readonly [EndKind, EndKind];
}

/**
 * A wall border in the same drawing. `rises` is a side wall, and it closes a cell. `open` is the part's
 * edge. `hole` is a hole in the wall. Neither closes a cell.
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
  /** Away from the plate, toward the tank. Default +Z. */
  buildAxis?: V3;
  /** The printer's XY pixel, mm. Absent: the vent is exactly {@link RESIN_VENT_MM}. */
  pixelMm?: number;
}

/** One notch: the rib it cuts, the point the gap is centred on, and the gap. */
export interface VentPocket {
  rib: number;
  at: [number, number, number];
  sizeMm: number;
}

export interface VentReport {
  /** The opening faces the build platform, so a closed cell cups. */
  cups: boolean;
  pockets: VentPocket[];
  sizeMm: number;
}

type Kind = "rib" | "rises" | "open" | "hole";
type V2 = [number, number];

const SNAP = 1e-4;
const AREA = 1e-3;

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

interface Seg {
  a: V2;
  b: V2;
  kind: Kind;
  rib: number;
  looseA: boolean;
  looseB: boolean;
}

interface Half {
  from: number;
  to: number;
  edge: number;
  kind: Kind;
  rib: number;
}

/** Closed cells that cup, and one vent each. No pockets when the opening faces the tank. */
export function ventPockets(input: VentInput): VentReport {
  const sizeMm = ventSizeMm(input.pixelMm);
  const opening = unit(input.opening);
  const build = unit(input.buildAxis ?? [0, 0, 1]);
  if (!opening || !build) return { cups: false, pockets: [], sizeMm };
  // The platform is behind the build axis. An opening that points that way faces the platform.
  const cups = dot(opening, build) < -1e-6;
  if (!cups) return { cups: false, pockets: [], sizeMm };
  const pockets = closedPockets(input, opening, build, sizeMm);
  return { cups: true, pockets, sizeMm };
}

/**
 * Cut each vent out of its rib. A vent is a gap of its size, centred on `at`, kept off the rib's ends
 * when the rib is long enough. Gap ends are free. Pieces shorter than the snap are dropped.
 */
export function notchRibs(ribs: readonly VentRib[], pockets: readonly VentPocket[]): VentRib[] {
  const cuts = new Map<number, V3[]>();
  for (const pocket of pockets) {
    const list = cuts.get(pocket.rib) ?? [];
    list.push(pocket.at);
    cuts.set(pocket.rib, list);
  }
  const out: VentRib[] = [];
  ribs.forEach((rib, i) => {
    const at = cuts.get(i);
    if (!at?.length) {
      out.push({ points: rib.points.map((p) => [p[0], p[1], p[2]]), ...(rib.ends ? { ends: rib.ends } : {}) });
      return;
    }
    out.push(...splitRib(rib, at, pockets.find((p) => p.rib === i)?.sizeMm ?? RESIN_VENT_MM));
  });
  return out;
}

function closedPockets(input: VentInput, opening: [number, number, number], build: [number, number, number], sizeMm: number): VentPocket[] {
  const axis = Math.abs(opening[0]) < 0.9 ? ([1, 0, 0] as const) : ([0, 1, 0] as const);
  const u = unit(cross(axis, opening));
  if (!u) return [];
  const v = cross(opening, u);
  const origin = firstPoint(input) ?? [0, 0, 0];
  const project = (p: V3): V2 => {
    const d = sub(p, origin);
    return [dot(d, u), dot(d, v)];
  };
  const lift = (q: V2): [number, number, number] => [origin[0] + q[0] * u[0] + q[1] * v[0], origin[1] + q[0] * u[1] + q[1] * v[1], origin[2] + q[0] * u[2] + q[1] * v[2]];
  const segs: Seg[] = [];
  const push = (points: readonly V3[], kind: Kind, rib: number, looseA: boolean, looseB: boolean) => {
    for (let i = 1; i < points.length; i += 1) {
      const a = project(points[i - 1]!);
      const b = project(points[i]!);
      if (dist2(a, b) < SNAP * SNAP) continue;
      const last = i === points.length - 1;
      segs.push({ a, b, kind, rib, looseA: i === 1 && looseA, looseB: last && looseB });
    }
  };
  input.ribs.forEach((rib, i) => push(rib.points, "rib", i, rib.ends?.[0] === "free", rib.ends?.[1] === "free"));
  for (const border of input.borders ?? []) push(border.points, border.kind, -1, false, false);
  const pieces = splitSegs(segs);
  if (pieces.length === 0) return [];
  const keyOf = (q: V2) => `${Math.round(q[0] / SNAP)}:${Math.round(q[1] / SNAP)}`;
  const xy: V2[] = [];
  const idOf = new Map<string, number>();
  const vid = (q: V2) => {
    const key = keyOf(q);
    const had = idOf.get(key);
    if (had !== undefined) return had;
    const id = xy.length;
    xy.push(q);
    idOf.set(key, id);
    return id;
  };
  const loose = new Set<number>();
  interface Edge {
    a: number;
    b: number;
    kind: Kind;
    rib: number;
  }
  const edges: Edge[] = [];
  const seenEdge = new Set<string>();
  for (const seg of pieces) {
    const a = vid(seg.a);
    const b = vid(seg.b);
    if (a === b) continue;
    if (seg.looseA) loose.add(a);
    if (seg.looseB) loose.add(b);
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push({ a, b, kind: seg.kind, rib: seg.rib });
  }
  const out: Half[][] = xy.map(() => []);
  edges.forEach((edge, i) => {
    out[edge.a]!.push({ from: edge.a, to: edge.b, edge: i, kind: edge.kind, rib: edge.rib });
    out[edge.b]!.push({ from: edge.b, to: edge.a, edge: i, kind: edge.kind, rib: edge.rib });
  });
  const ang = (h: Half) => Math.atan2(xy[h.to]![1] - xy[h.from]![1], xy[h.to]![0] - xy[h.from]![0]);
  for (const list of out) list.sort((p, q) => ang(p) - ang(q) || p.edge - q.edge);
  const nextOf = (h: Half): Half => {
    const list = out[h.to]!;
    let i = list.findIndex((row) => row.edge === h.edge);
    if (i < 0) i = 0;
    return list[(i - 1 + list.length) % list.length]!;
  };
  const used = new Set<string>();
  const pockets: VentPocket[] = [];
  const taken: { rib: number; at: V2 }[] = [];
  for (const list of out) {
    for (const start of list) {
      const startKey = `${start.from}:${start.edge}`;
      if (used.has(startKey)) continue;
      const face: Half[] = [];
      let h = start;
      let guard = 0;
      let closed = false;
      while (guard++ < edges.length * 2 + 4) {
        const key = `${h.from}:${h.edge}`;
        if (used.has(key)) break;
        used.add(key);
        face.push(h);
        h = nextOf(h);
        if (h.from === start.from && h.edge === start.edge) {
          closed = true;
          break;
        }
      }
      if (!closed || face.length < 3) continue;
      let area = 0;
      for (const row of face) {
        const p = xy[row.from]!;
        const q = xy[row.to]!;
        area += p[0] * q[1] - q[0] * p[1];
      }
      if (area < AREA) continue;
      if (face.some((row) => row.kind !== "rib" && row.kind !== "rises")) continue;
      if (face.some((row) => loose.has(row.from))) continue;
      const vent = chooseVent(face, xy, build, u, v, origin, sizeMm, taken);
      if (!vent) continue;
      taken.push({ rib: vent.rib, at: vent.flat });
      pockets.push({ rib: vent.rib, at: lift(vent.flat), sizeMm });
    }
  }
  return pockets;
}

function chooseVent(face: Half[], xy: V2[], build: V3, u: V3, v: V3, origin: V3, sizeMm: number, taken: { rib: number; at: V2 }[]): { rib: number; flat: V2 } | null {
  const drain = (q: V2) => {
    const p = [origin[0] + q[0] * u[0] + q[1] * v[0], origin[1] + q[0] * u[1] + q[1] * v[1], origin[2] + q[0] * u[2] + q[1] * v[2]] as const;
    return dot(p, build);
  };
  const rows = face
    .filter((row) => row.kind === "rib" && row.rib >= 0)
    .map((row) => {
      const a = xy[row.from]!;
      const b = xy[row.to]!;
      const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return { row, a, b, span, low: Math.min(drain(a), drain(b)) };
    })
    .sort((p, q) => p.low - q.low || q.span - p.span || p.row.rib - q.row.rib || p.row.edge - q.row.edge);
  for (const row of rows) {
    const flat = place(row.a, row.b, drain, sizeMm);
    if (taken.some((cut) => cut.rib === row.row.rib && Math.hypot(cut.at[0] - flat[0], cut.at[1] - flat[1]) < sizeMm)) continue;
    return { rib: row.row.rib, flat };
  }
  return null;
}

/** The notch centre: the low end of the edge, held inside it by half the gap. A level edge uses its middle. */
function place(a: V2, b: V2, drain: (q: V2) => number, sizeMm: number): V2 {
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const mid: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (span < 1e-9) return mid;
  const da = drain(a);
  const db = drain(b);
  if (Math.abs(da - db) < 1e-6) return mid;
  const low = da < db ? a : b;
  const high = da < db ? b : a;
  const inset = Math.min(span / 2, sizeMm / 2 + 0.05);
  const t = inset / span;
  return [low[0] + (high[0] - low[0]) * t, low[1] + (high[1] - low[1]) * t];
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
      if (dist2(a, b) < SNAP * SNAP) continue;
      out.push({ a, b, kind: seg.kind, rib: seg.rib, looseA: k === 1 && seg.looseA, looseB: k === ts.length - 1 && seg.looseB });
    }
  });
  return out;
}

/** Proper crossing, or an end of one lying on the other. Parallel overlaps are left alone. */
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
      return dx * dx + dy * dy < SNAP * SNAP ? t : null;
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

function splitRib(rib: VentRib, centers: readonly V3[], size: number): VentRib[] {
  const pts = rib.points;
  const total = polyLength(pts);
  if (total < SNAP) return [];
  const gaps: [number, number][] = [];
  for (const at of centers) {
    const s = paramOf(pts, at);
    if (s === null) continue;
    const half = size / 2;
    const lo = Math.max(0, s - half);
    const hi = Math.min(total, s + half);
    if (hi - lo < SNAP) continue;
    gaps.push([lo, hi]);
  }
  gaps.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const gap of gaps) {
    const last = merged.at(-1);
    if (last && gap[0] <= last[1] + SNAP) last[1] = Math.max(last[1], gap[1]);
    else merged.push([gap[0], gap[1]]);
  }
  const spans: [number, number][] = [];
  let cursor = 0;
  for (const gap of merged) {
    if (gap[0] - cursor > SNAP) spans.push([cursor, gap[0]]);
    cursor = gap[1];
  }
  if (total - cursor > SNAP) spans.push([cursor, total]);
  return spans.map((span, i) => {
    const points = sample(pts, span[0], span[1]);
    const start = i === 0 ? (rib.ends?.[0] ?? "closed") : "free";
    const end = i === spans.length - 1 ? (rib.ends?.[1] ?? "closed") : "free";
    return { points, ends: [start, end] as [EndKind, EndKind] };
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
    const q: [number, number, number] = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
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
    if (next > lo + SNAP && next < hi - SNAP) out.push([pts[i]![0], pts[i]![1], pts[i]![2]]);
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
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
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
