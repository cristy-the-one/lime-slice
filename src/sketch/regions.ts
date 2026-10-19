/**
 * The closed areas a sketch encloses (`docs/plan-gui-cad-modeling.md`, Plan B §4.2).
 *
 * Construction entities are ignored. Every other curve is split where it meets another, and the
 * pieces become a planar graph. Faces are traced by the smallest left turn at each vertex — the
 * walk that keeps the face on the left — and the unbounded face, the clockwise one, is dropped.
 * A circle that meets nothing is one closed edge and one face.
 *
 * Faces are then nested. A region's holes are the faces directly inside it, and each of those is
 * also its own region, so a washer is the ring and the hole, both selectable. `toLoops` writes
 * profile v2: the outer loop counter-clockwise, holes clockwise, arcs kept as arcs.
 */
import {
  EPS,
  arcFrom3,
  arcPoint,
  curveIntersect,
  curveOf,
  dist,
  leftNormal,
  pointOn,
  samePt,
  type Curve,
  type Pt,
  SPLINE_THROUGH_MAX,
  throughPoints,
} from "./geom.ts";
import type { SketchData } from "./model.ts";

const TAU = Math.PI * 2;
/** Faces smaller than this are gaps left by a curve that was traced both ways. */
const AREA_EPS = 1e-8;

export type ProfileSegment =
  | { kind: "line"; to: Pt }
  | { kind: "arc"; through: Pt; to: Pt }
  | { kind: "spline"; through: Pt[]; to: Pt };

/** One closed outline of profile v2: `start`, then each segment's `to`, the last back at `start`. */
export interface ProfileLoop {
  start: Pt;
  segments: ProfileSegment[];
}

export interface Region {
  /** Counter-clockwise. */
  outer: ProfileLoop;
  /** Clockwise. Each is the outline of a face directly inside this one. */
  holes: ProfileLoop[];
  /** Outer area minus the holes, in mm². */
  area: number;
}

type Piece =
  | { kind: "line"; a: Pt; b: Pt }
  | { kind: "arc"; centre: Pt; radius: number; a0: number; sweep: number; a: Pt; b: Pt }
  | { kind: "spline"; points: Pt[]; emit?: Pt[] };

interface Vertex {
  id: number;
  at: Pt;
}

interface Hedge {
  id: number;
  from: number;
  to: number;
  angle: number;
  curvature: number;
  piece: Piece;
  twin: number;
}

interface Face {
  pieces: Piece[];
  area: number;
  at: Pt;
}

/** The selectable regions of a sketch, largest area first. */
export function sketchRegions(sketch: SketchData): readonly Region[] {
  // A sketch is never changed in place, so its regions are kept until it is replaced. A pointer move asks again.
  const cached = regionsOf.get(sketch);
  if (cached) return cached;
  const found = traceRegions(sketch);
  regionsOf.set(sketch, found);
  return found;
}

const regionsOf = new WeakMap<SketchData, readonly Region[]>();

function traceRegions(sketch: SketchData): Region[] {
  const curves: Curve[] = [];
  for (const entity of sketch.entities) {
    if (entity.construction) continue;
    const curve = curveOf(sketch, entity);
    if (curve) curves.push(curve);
  }
  const faces = traceFaces(curves);
  if (!faces.length) return [];
  return nest(faces);
}

/**
 * Profile v2 loops for one region: the outer boundary, then each hole.
 * The outer loop is counter-clockwise and each hole is clockwise, arcs kept as arcs.
 */
export function toLoops(region: Region): ProfileLoop[] {
  return [region.outer, ...region.holes].map(cloneLoop);
}

/** The smallest region whose filled area contains `pt`, or null when none does. A point in a hole misses the ring and hits the hole. */
export function regionAt(regions: readonly Region[], pt: Pt): Region | null {
  let best: Region | null = null;
  for (const region of regions) {
    if (!loopContains(region.outer, pt) || region.holes.some((hole) => loopContains(hole, pt))) continue;
    if (!best || region.area < best.area) best = region;
  }
  return best;
}

/** Signed area of a profile loop. Positive is counter-clockwise. */
export function loopSignedArea(loop: ProfileLoop): number {
  let area = 0;
  let prev = loop.start;
  for (const segment of loop.segments) {
    if (segment.kind === "line") area += shoelace(prev, segment.to);
    else if (segment.kind === "arc") area += arcSegmentArea(prev, segment.through, segment.to);
    else area += polylineArea([prev, ...segment.through, segment.to]);
    prev = segment.to;
  }
  return area;
}

function traceFaces(curves: Curve[]): Face[] {
  const vertices: Vertex[] = [];
  const splits: { t: number; vid: number }[][] = curves.map(() => []);
  const addSplit = (index: number, t: number, pt: Pt) => {
    const vid = vertexAt(vertices, pt);
    splits[index]!.push({ t: normalizeParam(curves[index]!, t), vid });
  };

  for (let i = 0; i < curves.length; i++) {
    const curve = curves[i]!;
    if (!isClosed(curve)) {
      addSplit(i, 0, pointOn(curve, 0));
      addSplit(i, 1, pointOn(curve, 1));
    }
  }
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      for (const hit of curveIntersect(curves[i]!, curves[j]!)) {
        addSplit(i, hit.t0, hit.pt);
        addSplit(j, hit.t1, hit.pt);
      }
    }
    for (const hit of selfHits(curves[i]!)) addSplit(i, hit.t, hit.pt);
  }
  for (let i = 0; i < curves.length; i++) {
    if (isClosed(curves[i]!) && splits[i]!.length === 0) addSplit(i, 0, pointOn(curves[i]!, 0));
  }

  const hedges: Hedge[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < curves.length; i++) {
    const curve = curves[i]!;
    const params = uniqueParams(splits[i]!, isClosed(curve));
    const spans = paramSpans(params, isClosed(curve));
    for (const [t0, t1] of spans) {
      const v0 = vertexAt(vertices, pointOn(curve, t0));
      const v1 = vertexAt(vertices, pointOn(curve, t1));
      const piece = makePiece(curve, t0, t1, vertices[v0]!.at, vertices[v1]!.at);
      if (!piece || pieceSpan(piece) <= EPS) continue;
      const key = edgeKey(v0, v1, piece);
      if (seen.has(key)) continue;
      seen.add(key);
      pushHedge(hedges, v0, v1, piece);
    }
  }
  if (!hedges.length) return [];

  const outgoing: number[][] = vertices.map(() => []);
  for (const hedge of hedges) outgoing[hedge.from]!.push(hedge.id);
  for (const list of outgoing) {
    list.sort((p, q) => {
      const a = hedges[p]!;
      const b = hedges[q]!;
      const gap = angleGap(a.angle, b.angle);
      if (gap > 1e-8) return a.angle - b.angle;
      return a.curvature - b.curvature;
    });
  }

  const nextOf = (id: number): number => {
    const hedge = hedges[id]!;
    const list = outgoing[hedge.to]!;
    const at = list.indexOf(hedge.twin);
    // Clockwise from the reverse edge: the sharpest left turn that keeps the face on the left.
    if (at < 0) return hedge.twin;
    return list[(at - 1 + list.length) % list.length]!;
  };

  const used = new Uint8Array(hedges.length);
  const faces: Face[] = [];
  for (let start = 0; start < hedges.length; start++) {
    if (used[start]) continue;
    const pieces: Piece[] = [];
    let cursor = start;
    let closed = false;
    for (let guard = 0; guard <= hedges.length; guard++) {
      if (used[cursor] && cursor !== start) break;
      used[cursor] = 1;
      pieces.push(hedges[cursor]!.piece);
      cursor = nextOf(cursor);
      if (cursor === start) {
        closed = true;
        break;
      }
    }
    if (!closed) continue;
    const area = pieces.reduce((sum, piece) => sum + pieceArea(piece), 0);
    if (area <= AREA_EPS) continue;
    const at = interiorPoint(pieces);
    if (!at) continue;
    faces.push({ pieces, area, at });
  }
  return faces;
}

function nest(faces: Face[]): Region[] {
  const parent = faces.map(() => -1);
  for (let i = 0; i < faces.length; i++) {
    let best = -1;
    let bestArea = Infinity;
    for (let j = 0; j < faces.length; j++) {
      if (i === j || faces[j]!.area <= faces[i]!.area + AREA_EPS || faces[j]!.area >= bestArea) continue;
      if (pointInPieces(faces[j]!.pieces, faces[i]!.at)) {
        best = j;
        bestArea = faces[j]!.area;
      }
    }
    parent[i] = best;
  }
  const holesOf = faces.map(() => [] as number[]);
  for (let i = 0; i < faces.length; i++) {
    const owner = parent[i]!;
    if (owner >= 0) holesOf[owner]!.push(i);
  }
  const regions: Region[] = faces.map((face, index) => {
    const holes = holesOf[index]!.map((child) => emitLoop(faces[child]!.pieces, false));
    const holeArea = holesOf[index]!.reduce((sum, child) => sum + faces[child]!.area, 0);
    return { outer: emitLoop(face.pieces, true), holes, area: face.area - holeArea };
  });
  regions.sort((a, b) => b.area - a.area || a.outer.start[0] - b.outer.start[0] || a.outer.start[1] - b.outer.start[1]);
  return regions;
}

function emitLoop(pieces: Piece[], ccw: boolean): ProfileLoop {
  const area = pieces.reduce((sum, piece) => sum + pieceArea(piece), 0);
  const oriented = area > 0 === ccw ? pieces : [...pieces].reverse().map(reversePiece);
  const segments: ProfileSegment[] = [];
  let start: Pt | null = null;
  const pushLine = (to: Pt) => {
    const last = segments[segments.length - 1];
    // The line already open started at the loop start, or at the end of the segment before it.
    const from = !last || segments.length === 0 ? start : segments.length === 1 ? start : segments[segments.length - 2]!.to;
    if (last?.kind === "line" && from && collinear(from, last.to, to)) {
      last.to = [to[0], to[1]];
      return;
    }
    segments.push({ kind: "line", to: [to[0], to[1]] });
  };
  for (const piece of oriented) {
    const from = pieceStart(piece);
    if (!start) start = [from[0], from[1]];
    if (piece.kind === "line") pushLine(piece.b);
    else if (piece.kind === "arc") {
      for (const segment of emitArc(piece)) {
        if (segment.kind === "line") pushLine(segment.to);
        else segments.push(segment);
      }
    } else {
      // A cut piece of a spline is its 0.5 mm samples. The engine takes few points between a segment's ends, so the
      // piece is sent as the samples a smooth curve needs to stay within 0.01 mm of it.
      const points = piece.emit && piece.emit.length <= SPLINE_THROUGH_MAX + 2 ? piece.emit : throughPoints(piece.points, 0.01, SPLINE_THROUGH_MAX + 2);
      if (points.length <= 2) pushLine(points[points.length - 1] ?? from);
      else segments.push({ kind: "spline", through: points.slice(1, -1).map(clonePt), to: clonePt(points[points.length - 1]!) });
    }
  }
  const loopStart = start ?? [0, 0];
  const last = segments[segments.length - 1];
  if (last) last.to = [loopStart[0], loopStart[1]];
  return { start: loopStart, segments };
}

function emitArc(piece: Extract<Piece, { kind: "arc" }>): ProfileSegment[] {
  const sweep = piece.sweep;
  if (Math.abs(sweep) < 1e-6) return [{ kind: "line", to: clonePt(piece.b) }];
  if (Math.abs(sweep) >= TAU - 1e-3) {
    const half = { ...piece, sweep: sweep / 2, b: arcPoint(asArc(piece), 0.5) };
    const rest = { ...piece, a0: piece.a0 + sweep / 2, sweep: sweep / 2, a: half.b, b: piece.b };
    return [...emitArc(half), ...emitArc(rest)];
  }
  const through = arcPoint(asArc(piece), 0.5);
  return [{ kind: "arc", through, to: clonePt(piece.b) }];
}

function makePiece(curve: Curve, t0: number, t1: number, v0: Pt, v1: Pt): Piece | null {
  if (curve.kind === "line") {
    if (samePt(v0, v1)) return null;
    return { kind: "line", a: clonePt(v0), b: clonePt(v1) };
  }
  if (curve.kind === "arc") {
    const sweep = (t1 - t0) * curve.arc.sweep;
    if (Math.abs(sweep) < 1e-9) return null;
    const a0 = curve.arc.a0 + t0 * curve.arc.sweep;
    return { kind: "arc", centre: clonePt(curve.arc.centre), radius: curve.arc.radius, a0, sweep, a: clonePt(v0), b: clonePt(v1) };
  }
  if (curve.kind === "circle") {
    const sweep = (t1 - t0) * TAU;
    if (Math.abs(sweep) < 1e-9) return null;
    const start = pointOn(curve, t0);
    const a0 = Math.atan2(start[1] - curve.centre[1], start[0] - curve.centre[0]);
    return { kind: "arc", centre: clonePt(curve.centre), radius: curve.radius, a0, sweep, a: clonePt(v0), b: clonePt(v1) };
  }
  const points = splineBetween(curve.samples, t0, t1);
  if (points.length < 2) return null;
  points[0] = clonePt(v0);
  points[points.length - 1] = clonePt(v1);
  if (t1 - t0 >= 1 - 1e-8 && curve.controls.length >= 2) {
    const emit = curve.closed ? [...curve.controls.map(clonePt), clonePt(curve.controls[0]!)] : curve.controls.map(clonePt);
    emit[0] = clonePt(v0);
    emit[emit.length - 1] = clonePt(v1);
    return { kind: "spline", points, emit };
  }
  return { kind: "spline", points };
}

function splineBetween(samples: readonly Pt[], t0: number, t1: number): Pt[] {
  if (samples.length < 2) return samples.map(clonePt);
  const take = (from: number, to: number): Pt[] => {
    const out: Pt[] = [polylineAt(samples, from)];
    const lengths = spanLengths(samples);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    if (total <= EPS) return [clonePt(samples[0]!), clonePt(samples[samples.length - 1]!)];
    let covered = 0;
    for (let i = 0; i < lengths.length; i++) {
      const next = covered + lengths[i]!;
      const mid = next / total;
      if (mid > from + 1e-9 && mid < to - 1e-9) out.push(clonePt(samples[i + 1]!));
      covered = next;
    }
    out.push(polylineAt(samples, to));
    return out;
  };
  if (t1 <= 1 + 1e-9) return take(Math.max(0, t0), Math.min(1, t1));
  const first = take(t0, 1);
  const second = take(0, t1 - 1);
  second.shift();
  return [...first, ...second];
}

function polylineAt(samples: readonly Pt[], t: number): Pt {
  const lengths = spanLengths(samples);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= EPS) return clonePt(samples[0]!);
  let target = Math.min(1, Math.max(0, t)) * total;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!;
    if (target <= length || i === lengths.length - 1) {
      const u = length <= EPS ? 0 : target / length;
      const a = samples[i]!;
      const b = samples[i + 1]!;
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
    target -= length;
  }
  return clonePt(samples[samples.length - 1]!);
}

function selfHits(curve: Curve): { t: number; pt: Pt }[] {
  if (curve.kind !== "spline") return [];
  const samples = curve.samples;
  const lengths = spanLengths(samples);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= EPS) return [];
  const hits: { t: number; pt: Pt }[] = [];
  const count = samples.length - 1;
  const paramAt = (index: number, u: number) => {
    let before = 0;
    for (let k = 0; k < index; k++) before += lengths[k]!;
    return (before + u * lengths[index]!) / total;
  };
  for (let i = 0; i < count; i++) {
    for (let j = i + 2; j < count; j++) {
      if (curve.closed && i === 0 && j === count - 1) continue;
      const a0 = samples[i]!;
      const a1 = samples[i + 1]!;
      const b0 = samples[j]!;
      const b1 = samples[j + 1]!;
      if (samePt(a0, a1) || samePt(b0, b1)) continue;
      const rx = a1[0] - a0[0];
      const ry = a1[1] - a0[1];
      const sx = b1[0] - b0[0];
      const sy = b1[1] - b0[1];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) <= 1e-12) continue;
      const qx = b0[0] - a0[0];
      const qy = b0[1] - a0[1];
      const t = (qx * sy - qy * sx) / den;
      const u = (qx * ry - qy * rx) / den;
      if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) continue;
      const pt: Pt = [a0[0] + t * rx, a0[1] + t * ry];
      hits.push({ pt, t: paramAt(i, t) }, { pt, t: paramAt(j, u) });
    }
  }
  return hits;
}

function pushHedge(hedges: Hedge[], v0: number, v1: number, piece: Piece) {
  const reverse = reversePiece(piece);
  const id0 = hedges.length;
  const id1 = id0 + 1;
  hedges.push({ id: id0, from: v0, to: v1, angle: departure(piece), curvature: curvatureOf(piece), piece, twin: id1 });
  hedges.push({ id: id1, from: v1, to: v0, angle: departure(reverse), curvature: curvatureOf(reverse), piece: reverse, twin: id0 });
}

function reversePiece(piece: Piece): Piece {
  if (piece.kind === "line") return { kind: "line", a: piece.b, b: piece.a };
  if (piece.kind === "arc") {
    return { kind: "arc", centre: piece.centre, radius: piece.radius, a0: piece.a0 + piece.sweep, sweep: -piece.sweep, a: piece.b, b: piece.a };
  }
  return { kind: "spline", points: [...piece.points].reverse(), emit: piece.emit ? [...piece.emit].reverse() : undefined };
}

function departure(piece: Piece): number {
  if (piece.kind === "line") return norm(Math.atan2(piece.b[1] - piece.a[1], piece.b[0] - piece.a[0]));
  if (piece.kind === "arc") {
    const sign = piece.sweep >= 0 ? 1 : -1;
    return norm(Math.atan2(sign * Math.cos(piece.a0), sign * -Math.sin(piece.a0)));
  }
  const a = piece.points[0] ?? [0, 0];
  const b = piece.points[1] ?? a;
  return norm(Math.atan2(b[1] - a[1], b[0] - a[0]));
}

function curvatureOf(piece: Piece): number {
  if (piece.kind === "arc") return (piece.sweep >= 0 ? 1 : -1) / piece.radius;
  return 0;
}

function pieceArea(piece: Piece): number {
  if (piece.kind === "line") return shoelace(piece.a, piece.b);
  if (piece.kind === "arc") {
    const chord = shoelace(piece.a, piece.b);
    const segment = (piece.radius * piece.radius / 2) * (piece.sweep - Math.sin(piece.sweep));
    return chord + segment;
  }
  return polylineArea(piece.points);
}

function pieceSpan(piece: Piece): number {
  if (piece.kind === "line") return dist(piece.a, piece.b);
  if (piece.kind === "arc") return Math.abs(piece.sweep) * piece.radius;
  return spanLengths(piece.points).reduce((sum, length) => sum + length, 0);
}

function pieceStart(piece: Piece): Pt {
  if (piece.kind === "spline") return piece.points[0] ?? [0, 0];
  return piece.a;
}

function interiorPoint(pieces: Piece[]): Pt | null {
  const poly = samplePieces(pieces);
  for (const piece of pieces) {
    const mid = pieceMid(piece);
    const tangent = pieceTangent(piece);
    const left = leftNormal(tangent);
    for (const scale of [1e-3, 1e-2, 0.05, 0.5, 2]) {
      const pt: Pt = [mid[0] + left[0] * scale, mid[1] + left[1] * scale];
      if (winding(poly, pt) !== 0) return pt;
    }
  }
  return poly.length ? centroid(poly) : null;
}

function pointInPieces(pieces: Piece[], pt: Pt): boolean {
  return winding(samplePieces(pieces), pt) !== 0;
}

function samplePieces(pieces: Piece[]): Pt[] {
  const out: Pt[] = [];
  for (const piece of pieces) {
    if (piece.kind === "line") {
      if (!out.length) out.push(clonePt(piece.a));
      out.push(clonePt(piece.b));
    } else if (piece.kind === "arc") {
      const steps = Math.max(8, Math.ceil(Math.abs(piece.sweep) / (Math.PI / 32)));
      for (let i = out.length ? 1 : 0; i <= steps; i++) out.push(arcPoint(asArc(piece), i / steps));
      out[out.length - 1] = clonePt(piece.b);
    } else {
      for (let i = out.length ? 1 : 0; i < piece.points.length; i++) out.push(clonePt(piece.points[i]!));
    }
  }
  return out;
}

function loopContains(loop: ProfileLoop, pt: Pt): boolean {
  return winding(sampleLoop(loop), pt) !== 0;
}

function sampleLoop(loop: ProfileLoop): Pt[] {
  const out: Pt[] = [clonePt(loop.start)];
  let prev = loop.start;
  for (const segment of loop.segments) {
    if (segment.kind === "line") out.push(clonePt(segment.to));
    else if (segment.kind === "arc") sampleProfileArc(prev, segment.through, segment.to, out);
    else {
      for (const point of segment.through) out.push(clonePt(point));
      out.push(clonePt(segment.to));
    }
    prev = segment.to;
  }
  return out;
}

function sampleProfileArc(a: Pt, through: Pt, b: Pt, out: Pt[]) {
  const arc = arcFrom3(a, through, b);
  if (!arc) {
    out.push(clonePt(b));
    return;
  }
  const steps = Math.max(4, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 32)));
  for (let i = 1; i <= steps; i++) out.push(arcPoint(arc, i / steps));
  out[out.length - 1] = clonePt(b);
}

function winding(poly: readonly Pt[], pt: Pt): number {
  let wind = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (samePt(a, b)) continue;
    if (a[1] <= pt[1]) {
      if (b[1] > pt[1] && cross(a, b, pt) > 0) wind += 1;
    } else if (b[1] <= pt[1] && cross(a, b, pt) < 0) wind -= 1;
  }
  return wind;
}

function cross(a: Pt, b: Pt, p: Pt): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function centroid(poly: readonly Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const point of poly) {
    x += point[0];
    y += point[1];
  }
  return [x / poly.length, y / poly.length];
}

function pieceMid(piece: Piece): Pt {
  if (piece.kind === "line") return [(piece.a[0] + piece.b[0]) / 2, (piece.a[1] + piece.b[1]) / 2];
  if (piece.kind === "arc") return arcPoint(asArc(piece), 0.5);
  return piece.points[Math.floor(piece.points.length / 2)] ?? piece.points[0]!;
}

function pieceTangent(piece: Piece): Pt {
  if (piece.kind === "line") {
    const length = dist(piece.a, piece.b) || 1;
    return [(piece.b[0] - piece.a[0]) / length, (piece.b[1] - piece.a[1]) / length];
  }
  if (piece.kind === "arc") {
    const sign = piece.sweep >= 0 ? 1 : -1;
    const theta = piece.a0 + piece.sweep / 2;
    return [sign * -Math.sin(theta), sign * Math.cos(theta)];
  }
  const i = Math.max(0, Math.floor(piece.points.length / 2) - 1);
  const a = piece.points[i]!;
  const b = piece.points[Math.min(piece.points.length - 1, i + 1)]!;
  const length = dist(a, b) || 1;
  return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
}

function asArc(piece: Extract<Piece, { kind: "arc" }>) {
  return { centre: piece.centre, radius: piece.radius, a0: piece.a0, sweep: piece.sweep };
}

function vertexAt(vertices: Vertex[], pt: Pt): number {
  for (const vertex of vertices) {
    if (dist(vertex.at, pt) <= EPS) return vertex.id;
  }
  const id = vertices.length;
  vertices.push({ id, at: clonePt(pt) });
  return id;
}

function uniqueParams(splits: { t: number; vid: number }[], closed: boolean): number[] {
  const values = splits.map((split) => (closed ? wrap01(split.t) : clamp01(split.t)));
  values.sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of values) {
    const last = out[out.length - 1];
    if (last !== undefined && Math.abs(value - last) < 1e-8) continue;
    if (closed && out.length && Math.abs(value - out[0]!) < 1e-8) continue;
    if (closed && value > 1 - 1e-8) continue;
    out.push(value);
  }
  return out;
}

function paramSpans(params: number[], closed: boolean): [number, number][] {
  if (!closed) {
    const values = [...params];
    if (!values.some((value) => value <= 1e-8)) values.unshift(0);
    if (!values.some((value) => value >= 1 - 1e-8)) values.push(1);
    values.sort((a, b) => a - b);
    const spans: [number, number][] = [];
    for (let i = 0; i < values.length - 1; i++) {
      if (values[i + 1]! - values[i]! > 1e-8) spans.push([values[i]!, values[i + 1]!]);
    }
    return spans;
  }
  if (!params.length) return [[0, 1]];
  const spans: [number, number][] = [];
  for (let i = 0; i < params.length; i++) {
    const t0 = params[i]!;
    const t1 = i + 1 < params.length ? params[i + 1]! : params[0]! + 1;
    if (t1 - t0 > 1e-8) spans.push([t0, t1]);
  }
  return spans;
}

function edgeKey(v0: number, v1: number, piece: Piece): string {
  const mid = pieceMid(piece);
  const q = (value: number) => Math.round(value * 1e5);
  if (v0 === v1) {
    const sign = piece.kind === "arc" ? Math.sign(piece.sweep) : 1;
    return `loop:${v0}:${q(mid[0])}:${q(mid[1])}:${sign}`;
  }
  const lo = Math.min(v0, v1);
  const hi = Math.max(v0, v1);
  return `${lo}:${hi}:${q(mid[0])}:${q(mid[1])}`;
}

function isClosed(curve: Curve): boolean {
  return curve.kind === "circle" || (curve.kind === "spline" && curve.closed);
}

function normalizeParam(curve: Curve, t: number): number {
  if (!isClosed(curve)) return clamp01(t);
  return wrap01(t);
}

function wrap01(t: number): number {
  let value = t % 1;
  if (value < 0) value += 1;
  if (value > 1 - 1e-9) return 0;
  return value;
}

function clamp01(t: number): number {
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

function spanLengths(samples: readonly Pt[]): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < samples.length - 1; i++) lengths.push(dist(samples[i]!, samples[i + 1]!));
  return lengths;
}

function shoelace(a: Pt, b: Pt): number {
  return (a[0] * b[1] - b[0] * a[1]) / 2;
}

function polylineArea(points: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0; i < points.length - 1; i++) sum += shoelace(points[i]!, points[i + 1]!);
  return sum;
}

function arcSegmentArea(a: Pt, through: Pt, b: Pt): number {
  const chord = shoelace(a, b);
  const arc = arcFrom3(a, through, b);
  if (!arc) return chord;
  return chord + (arc.radius * arc.radius / 2) * (arc.sweep - Math.sin(arc.sweep));
}

function collinear(a: Pt, b: Pt, c: Pt): boolean {
  const ab = dist(a, b);
  const bc = dist(b, c);
  if (ab <= EPS || bc <= EPS) return true;
  const crossAbs = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return crossAbs <= 1e-8 * (ab + bc) && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) > 0;
}

function cloneLoop(loop: ProfileLoop): ProfileLoop {
  return {
    start: clonePt(loop.start),
    segments: loop.segments.map((segment) => {
      if (segment.kind === "line") return { kind: "line", to: clonePt(segment.to) };
      if (segment.kind === "arc") return { kind: "arc", through: clonePt(segment.through), to: clonePt(segment.to) };
      return { kind: "spline", through: segment.through.map(clonePt), to: clonePt(segment.to) };
    }),
  };
}

function clonePt(pt: Pt): Pt {
  return [pt[0], pt[1]];
}

function angleGap(a: number, b: number): number {
  const gap = Math.abs(a - b);
  return Math.min(gap, TAU - gap);
}

function norm(angle: number): number {
  const value = angle % TAU;
  return value < 0 ? value + TAU : value;
}
