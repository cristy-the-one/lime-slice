/**
 * The last sliced stress result as a lookup the Preview colours toolpaths
 * with (the sliced plan's §8). The bridge sends the solved grid: a point in
 * the object's part frame, where the slice reply's layers are, goes through
 * `partToSlice` and lands in one cell. The part frame doesn't depend on
 * where the object sits on the plate, so a plate slice's layers find the
 * cells of a study sliced alone.
 */

export const STRESS_NEEDS_RESULT = "Run Stress… in Model on this object to colour by stress.";

export interface StressCells {
  objectId: string | null;
  partToSlice: number[][];
  origin: [number, number];
  h: number;
  /** Bottom and top of each slab, bottom first. */
  slabs: [number, number][];
  /** `i,j,slab` → fraction, bead von Mises (MPa), safety factor. */
  values: Map<string, [number, number, number]>;
  /** The highest bead stress, the top of the stress ramp. */
  peakMpa: number;
  trust: string;
}

export interface CellReading {
  stressMpa: number;
  safety: number;
}

function numberMatrix(value: unknown): number[][] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const rows = value.map((row) => (Array.isArray(row) ? row.map(Number) : []));
  return rows.every((row) => row.length >= 4 && row.every(Number.isFinite)) ? rows : null;
}

/** The `cells` block of a bridge reply, or null when it has none. */
export function parseStressCells(replyText: string, objectId: string | null): StressCells | null {
  let reply: Record<string, unknown>;
  try {
    reply = JSON.parse(replyText) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!reply || reply.ok !== true) return null;
  const cells = reply.cells as Record<string, unknown> | null | undefined;
  if (!cells || typeof cells !== "object") return null;
  const partToSlice = numberMatrix(cells.partToSlice);
  const origin = Array.isArray(cells.originXy) ? cells.originXy.map(Number) : [];
  const h = Number(cells.hXy);
  const slabs = Array.isArray(cells.slabs)
    ? (cells.slabs as unknown[]).map((s) => (Array.isArray(s) ? [Number(s[0]), Number(s[1])] : [NaN, NaN]) as [number, number])
    : [];
  if (!partToSlice || origin.length < 2 || !(h > 0) || slabs.length === 0 || typeof cells.cellsB64 !== "string") return null;
  const raw = Uint8Array.from(atob(cells.cellsB64), (c) => c.charCodeAt(0));
  const view = new DataView(raw.buffer);
  const values = new Map<string, [number, number, number]>();
  let peakMpa = 0;
  for (let o = 0; o + 24 <= raw.length; o += 24) {
    const key = `${view.getUint32(o, true)},${view.getUint32(o + 4, true)},${view.getUint32(o + 8, true)}`;
    const phi = view.getFloat32(o + 12, true);
    const stress = view.getFloat32(o + 16, true);
    const safety = view.getFloat32(o + 20, true);
    values.set(key, [phi, stress, safety]);
    if (Number.isFinite(stress)) peakMpa = Math.max(peakMpa, stress);
  }
  const report = reply.report as Record<string, unknown> | undefined;
  return {
    objectId,
    partToSlice,
    origin: [origin[0], origin[1]],
    h,
    slabs,
    values,
    peakMpa,
    trust: typeof report?.trust === "string" ? report.trust : "rough",
  };
}

/** The cell under a point of the part frame, or null outside the solved part. */
export function cellAt(cells: StressCells, x: number, y: number, z: number): CellReading | null {
  const m = cells.partToSlice;
  const sx = m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3];
  const sy = m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3];
  const sz = m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3];
  const i = Math.floor((sx - cells.origin[0]) / cells.h);
  const j = Math.floor((sy - cells.origin[1]) / cells.h);
  if (i < 0 || j < 0) return null;
  let lo = 0;
  let hi = cells.slabs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [bottom, top] = cells.slabs[mid];
    if (sz < bottom) hi = mid - 1;
    else if (sz >= top) lo = mid + 1;
    else {
      const hit = cells.values.get(`${i},${j},${mid}`);
      return hit ? { stressMpa: hit[1], safety: hit[2] } : null;
    }
  }
  return null;
}

/** A stretch of a bead inside one cell, as fractions `t0` to `t1` along it. */
export interface CellPiece {
  t0: number;
  t1: number;
  reading: CellReading | null;
}

/**
 * A bead from `a` to `b` (part frame, at height `z`) cut where it crosses the
 * grid's cell lines, each piece with the cell it lies in. The crossings are
 * found in the slice frame, where the cells are square.
 */
export function cellPieces(cells: StressCells, a: [number, number], b: [number, number], z: number): CellPiece[] {
  const m = cells.partToSlice;
  const slice = (x: number, y: number) => [m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3], m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3]];
  const [sx0, sy0] = slice(a[0], a[1]);
  const [sx1, sy1] = slice(b[0], b[1]);
  const cuts = [0, 1];
  for (const [s0, s1, origin] of [[sx0, sx1, cells.origin[0]], [sy0, sy1, cells.origin[1]]]) {
    if (Math.abs(s1 - s0) < 1e-12) continue;
    const lo = Math.ceil((Math.min(s0, s1) - origin) / cells.h);
    const hi = Math.floor((Math.max(s0, s1) - origin) / cells.h);
    for (let k = lo; k <= hi; k++) {
      const t = (origin + k * cells.h - s0) / (s1 - s0);
      if (t > 0 && t < 1) cuts.push(t);
    }
  }
  cuts.sort((p, q) => p - q);
  const pieces: CellPiece[] = [];
  for (let n = 0; n + 1 < cuts.length; n++) {
    const [t0, t1] = [cuts[n], cuts[n + 1]];
    if (t1 - t0 < 1e-9) continue;
    const tm = (t0 + t1) / 2;
    pieces.push({ t0, t1, reading: cellAt(cells, a[0] + (b[0] - a[0]) * tm, a[1] + (b[1] - a[1]) * tm, z) });
  }
  return pieces;
}

let current: StressCells | null = null;
const listeners = new Set<() => void>();

/** Keep the cells of a successful solve for the Preview. */
export function rememberStressCells(objectId: string | null, replyText: string): void {
  const parsed = parseStressCells(replyText, objectId);
  if (!parsed) return;
  current = parsed;
  for (const cb of listeners) cb();
}

export function clearStressCells(): void {
  if (!current) return;
  current = null;
  for (const cb of listeners) cb();
}

/** The cells for `objectId`, or the last ones when no id is asked for. */
export function stressCellsFor(objectId?: string | null): StressCells | null {
  if (!current) return null;
  if (objectId !== undefined && objectId !== null && current.objectId !== null && current.objectId !== objectId) return null;
  return current;
}

export function onStressCells(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
