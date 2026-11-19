/**
 * Whether a triangle soup closes: each edge, once its corners are welded, used by exactly two triangles. A crack (an
 * edge used once) leaves the slicer guessing at a gap; an edge used by four triangles is where two pieces only touch
 * along a line. `closeCracks` mends the cracks a mesher leaves where two faces sample a shared edge at different points.
 */

export type Vec3 = [number, number, number];

/** Corners closer than this are one point: 1 µm, far under any print, far over float32 noise at a metre. */
export const WELD_MM = 1e-3;

export interface EdgeIssue {
  /** The edge's middle, in the mesh's frame. */
  at: Vec3;
  lengthMm: number;
}

export interface EdgeReport {
  triangles: number;
  /** Triangles whose corners weld into fewer than three points. */
  degenerate: number;
  /** Edges used by one triangle: cracks and holes. */
  open: number;
  /** Edges used by more than two triangles: pieces that touch along a line. */
  nonManifold: number;
  openAt: EdgeIssue[];
  nonManifoldAt: EdgeIssue[];
}

interface Welded {
  /** Welded points, three numbers each. */
  points: number[];
  /** Three point indexes per kept triangle. */
  tris: number[];
  degenerate: number;
}

/** A grid cell's number: three cell indexes hashed together. Points in one cell are told apart by distance. */
function cellKey(i: number, j: number, k: number): number {
  return (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) | 0;
}

/**
 * Corners within `tol` of each other become one point, whichever side of a grid line they fall: a point is looked for
 * in its own cell, then in the 26 around it.
 */
function weld(positions: ArrayLike<number>, tol = WELD_MM): Welded {
  const cells = new Map<number, number[]>();
  const points: number[] = [];
  const tris: number[] = [];
  let degenerate = 0;
  const near = (id: number, x: number, y: number, z: number) =>
    Math.abs(points[id * 3]! - x) <= tol && Math.abs(points[id * 3 + 1]! - y) <= tol && Math.abs(points[id * 3 + 2]! - z) <= tol;
  const idOf = (x: number, y: number, z: number): number => {
    const i = Math.floor(x / tol);
    const j = Math.floor(y / tol);
    const k = Math.floor(z / tol);
    const own = cells.get(cellKey(i, j, k));
    if (own) for (const id of own) if (near(id, x, y, z)) return id;
    for (let di = -1; di <= 1; di += 1) {
      for (let dj = -1; dj <= 1; dj += 1) {
        for (let dk = -1; dk <= 1; dk += 1) {
          if (di === 0 && dj === 0 && dk === 0) continue;
          const row = cells.get(cellKey(i + di, j + dj, k + dk));
          if (row) for (const id of row) if (near(id, x, y, z)) return id;
        }
      }
    }
    const id = points.length / 3;
    points.push(x, y, z);
    if (own) own.push(id);
    else cells.set(cellKey(i, j, k), [id]);
    return id;
  };
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const a = idOf(positions[i]!, positions[i + 1]!, positions[i + 2]!);
    const b = idOf(positions[i + 3]!, positions[i + 4]!, positions[i + 5]!);
    const c = idOf(positions[i + 6]!, positions[i + 7]!, positions[i + 8]!);
    if (a === b || b === c || a === c) {
      degenerate += 1;
      continue;
    }
    tris.push(a, b, c);
  }
  return { points, tris, degenerate };
}

function edgeUse(tris: readonly number[]): Map<number, number> {
  const use = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const a = tris[t + k]!;
      const b = tris[t + ((k + 1) % 3)]!;
      const key = a < b ? a * 0x4000000 + b : b * 0x4000000 + a;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  return use;
}

/** Open and non-manifold edges of a soup of triangles, nine numbers each. `limit` caps the places listed. */
export function edgeReport(positions: ArrayLike<number>, limit = 8): EdgeReport {
  const welded = weld(positions);
  const use = edgeUse(welded.tris);
  const report: EdgeReport = { triangles: Math.floor(positions.length / 9), degenerate: welded.degenerate, open: 0, nonManifold: 0, openAt: [], nonManifoldAt: [] };
  const issue = (key: number): EdgeIssue => {
    const a = Math.floor(key / 0x4000000);
    const b = key % 0x4000000;
    const p = welded.points;
    const at: Vec3 = [0, 1, 2].map((k) => Math.round(((p[a * 3 + k]! + p[b * 3 + k]!) / 2) * 100) / 100) as Vec3;
    const lengthMm = Math.round(Math.hypot(p[a * 3]! - p[b * 3]!, p[a * 3 + 1]! - p[b * 3 + 1]!, p[a * 3 + 2]! - p[b * 3 + 2]!) * 1000) / 1000;
    return { at, lengthMm };
  };
  for (const [key, count] of use) {
    if (count === 1) {
      report.open += 1;
      if (report.openAt.length < limit) report.openAt.push(issue(key));
    } else if (count > 2) {
      report.nonManifold += 1;
      if (report.nonManifoldAt.length < limit) report.nonManifoldAt.push(issue(key));
    }
  }
  return report;
}

/** Every edge used by more than two triangles, as its two welded ends: six numbers an edge, in the soup's frame. */
export function nonManifoldSegments(positions: ArrayLike<number>): Float64Array {
  const welded = weld(positions);
  const p = welded.points;
  const out: number[] = [];
  for (const [key, count] of edgeUse(welded.tris)) {
    if (count <= 2) continue;
    const a = Math.floor(key / 0x4000000);
    const b = key % 0x4000000;
    out.push(p[a * 3]!, p[a * 3 + 1]!, p[a * 3 + 2]!, p[b * 3]!, p[b * 3 + 1]!, p[b * 3 + 2]!);
  }
  return Float64Array.from(out);
}

/**
 * Cracks mended: where one triangle's open edge runs past corners of the faces beside it (within `tolMm` of the
 * edge), that triangle is split at those corners, so both sides of the seam share the same points. Points move by at
 * most `tolMm`. Returns the soup with degenerate triangles dropped, welded corners snapped together, and cracks split.
 */
export function closeCracks(positions: ArrayLike<number>, tolMm = 0.05): Float32Array {
  const welded = weld(positions);
  const { points } = welded;
  let tris = welded.tris;
  // A mesh that already closes, with nothing degenerate, comes back as it was.
  if (welded.degenerate === 0 && [...edgeUse(tris).values()].every((count) => count !== 1)) return Float32Array.from(positions);
  for (let round = 0; round < 4; round += 1) {
    const use = edgeUse(tris);
    const openVerts = new Set<number>();
    for (const [key, count] of use) {
      if (count !== 1) continue;
      openVerts.add(Math.floor(key / 0x4000000));
      openVerts.add(key % 0x4000000);
    }
    if (openVerts.size === 0) break;
    // Open corners by grid cell, so each open edge looks only at corners near it.
    const cell = Math.max(tolMm * 4, 0.5);
    const grid = new Map<string, number[]>();
    for (const v of openVerts) {
      const key = `${Math.floor(points[v * 3]! / cell)},${Math.floor(points[v * 3 + 1]! / cell)},${Math.floor(points[v * 3 + 2]! / cell)}`;
      const row = grid.get(key);
      if (row) row.push(v);
      else grid.set(key, [v]);
    }
    const onEdge = (a: number, b: number): number[] => {
      const ax = points[a * 3]!, ay = points[a * 3 + 1]!, az = points[a * 3 + 2]!;
      const dx = points[b * 3]! - ax, dy = points[b * 3 + 1]! - ay, dz = points[b * 3 + 2]! - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 < 1e-12) return [];
      const lo = [Math.min(ax, ax + dx) - tolMm, Math.min(ay, ay + dy) - tolMm, Math.min(az, az + dz) - tolMm];
      const hi = [Math.max(ax, ax + dx) + tolMm, Math.max(ay, ay + dy) + tolMm, Math.max(az, az + dz) + tolMm];
      const found: { v: number; t: number }[] = [];
      for (let i = Math.floor(lo[0]! / cell); i <= Math.floor(hi[0]! / cell); i += 1) {
        for (let j = Math.floor(lo[1]! / cell); j <= Math.floor(hi[1]! / cell); j += 1) {
          for (let k = Math.floor(lo[2]! / cell); k <= Math.floor(hi[2]! / cell); k += 1) {
            for (const v of grid.get(`${i},${j},${k}`) ?? []) {
              if (v === a || v === b) continue;
              const px = points[v * 3]! - ax, py = points[v * 3 + 1]! - ay, pz = points[v * 3 + 2]! - az;
              const t = (px * dx + py * dy + pz * dz) / len2;
              if (t <= 1e-6 || t >= 1 - 1e-6) continue;
              const ex = px - t * dx, ey = py - t * dy, ez = pz - t * dz;
              if (ex * ex + ey * ey + ez * ez <= tolMm * tolMm) found.push({ v, t });
            }
          }
        }
      }
      return found.sort((x, y) => x.t - y.t).map((row) => row.v);
    };
    const next: number[] = [];
    let split = false;
    for (let t = 0; t < tris.length; t += 3) {
      const corner = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
      let done = false;
      for (let k = 0; k < 3 && !done; k += 1) {
        const a = corner[k]!;
        const b = corner[(k + 1) % 3]!;
        const c = corner[(k + 2) % 3]!;
        const key = a < b ? a * 0x4000000 + b : b * 0x4000000 + a;
        if (use.get(key) !== 1) continue;
        const between = onEdge(a, b);
        if (between.length === 0) continue;
        // A fan from the opposite corner over a, the corners between, and b keeps the triangle's winding.
        const chain = [a, ...between, b];
        for (let i = 0; i + 1 < chain.length; i += 1) next.push(chain[i]!, chain[i + 1]!, c);
        done = true;
        split = true;
      }
      if (!done) next.push(...corner);
    }
    tris = next;
    if (!split) break;
  }
  const out = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i += 1) {
    out[i * 3] = points[tris[i]! * 3]!;
    out[i * 3 + 1] = points[tris[i]! * 3 + 1]!;
    out[i * 3 + 2] = points[tris[i]! * 3 + 2]!;
  }
  return out;
}

export interface HoleReport {
  /** Loops of open edges that were filled. */
  holes: number;
  /** Triangles added to fill them. */
  added: number;
  /** Edges used by one triangle before and after. */
  openBefore: number;
  openAfter: number;
  /** Edges used by more than two triangles after: pieces that touch along a line, which filling does not mend. */
  nonManifold: number;
  /** The longest filled loop, around its edge, in millimetres. */
  largestLoopMm: number;
  /** Loops left as they were for being longer than `maxLoopMm`. */
  skipped: number;
  /** Triangles taken out first: doubles of another triangle, and flaps that hang off a surface that closes without them. */
  removed: number;
}

/** Triangles covering one loop of points, by ear clipping in the loop's best-fit plane, wound as the loop runs. */
function fillLoop(points: readonly number[], loop: readonly number[]): number[] {
  const n = loop.length;
  if (n < 3) return [];
  if (n === 3) return [...loop];
  const at = (v: number, k: number) => points[v * 3 + k]!;
  // Newell's normal: the plane the loop lies nearest to, facing the way the loop turns.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i += 1) {
    const a = loop[i]!, b = loop[(i + 1) % n]!;
    nx += (at(a, 1) - at(b, 1)) * (at(a, 2) + at(b, 2));
    ny += (at(a, 2) - at(b, 2)) * (at(a, 0) + at(b, 0));
    nz += (at(a, 0) - at(b, 0)) * (at(a, 1) + at(b, 1));
  }
  const len = Math.hypot(nx, ny, nz);
  const out: number[] = [];
  if (len < 1e-12) {
    // A loop with no area to speak of: a fan closes it, and its slivers hold no volume.
    for (let i = 1; i + 1 < n; i += 1) out.push(loop[0]!, loop[i]!, loop[i + 1]!);
    return out;
  }
  nx /= len; ny /= len; nz /= len;
  const hx = Math.abs(nx) < 0.9 ? 1 : 0, hy = Math.abs(nx) < 0.9 ? 0 : 1;
  let ux = hy * nz, uy = -hx * nz, uz = hx * ny - hy * nx;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const flat = loop.map((p) => [at(p, 0) * ux + at(p, 1) * uy + at(p, 2) * uz, at(p, 0) * vx + at(p, 1) * vy + at(p, 2) * vz] as const);
  const turn = (a: number, b: number, c: number) => (flat[b]![0] - flat[a]![0]) * (flat[c]![1] - flat[a]![1]) - (flat[b]![1] - flat[a]![1]) * (flat[c]![0] - flat[a]![0]);
  const left = loop.map((_, i) => i);
  while (left.length > 3) {
    const m = left.length;
    let best = -1;
    let bestTurn = 0;
    for (let k = 0; k < m; k += 1) {
      const a = left[(k + m - 1) % m]!, b = left[k]!, c = left[(k + 1) % m]!;
      const area = turn(a, b, c);
      if (area <= 0) continue;
      let clear = true;
      for (const q of left) {
        if (q === a || q === b || q === c) continue;
        if (turn(a, b, q) >= 0 && turn(b, c, q) >= 0 && turn(c, a, q) >= 0) { clear = false; break; }
      }
      if (!clear) continue;
      // The squarest ear first: a fan of long slivers across a hole reads as a crease in the print.
      const ab = Math.hypot(flat[b]![0] - flat[a]![0], flat[b]![1] - flat[a]![1]);
      const bc = Math.hypot(flat[c]![0] - flat[b]![0], flat[c]![1] - flat[b]![1]);
      const ca = Math.hypot(flat[a]![0] - flat[c]![0], flat[a]![1] - flat[c]![1]);
      const shape = area / (ab * ab + bc * bc + ca * ca);
      if (shape > bestTurn) { bestTurn = shape; best = k; }
    }
    // A loop that folds over itself in its plane has no clean ear. The next corner is clipped anyway, so the hole closes.
    const k = best < 0 ? 0 : best;
    out.push(loop[left[(k + m - 1) % m]!]!, loop[left[k]!]!, loop[left[(k + 1) % m]!]!);
    left.splice(k, 1);
  }
  out.push(loop[left[0]!]!, loop[left[1]!]!, loop[left[2]!]!);
  return out;
}

/**
 * Holes filled: cracks are mended first (`closeCracks`), then every loop of open edges is covered with triangles that
 * face the way the triangles around it do. No point moves and none is added. `maxLoopMm` leaves longer loops open, for
 * a surface that is meant to end at an edge. Edges that more than two triangles share stay as they are.
 */
export function closeHoles(positions: ArrayLike<number>, opts: { maxLoopMm?: number; crackTolMm?: number } = {}): { positions: Float32Array; report: HoleReport } {
  // A fill can bare a flap, and a flap taken off can open a loop that now closes: a few passes settle it.
  let pass = closeHolesOnce(positions, opts);
  const report = pass.report;
  for (let round = 0; round < 3 && report.openAfter > 0; round += 1) {
    const next = closeHolesOnce(pass.positions, opts);
    if (next.report.holes === 0 && next.report.removed === 0) break;
    pass = next;
    report.holes += next.report.holes;
    report.added += next.report.added;
    report.removed += next.report.removed;
    report.largestLoopMm = Math.max(report.largestLoopMm, next.report.largestLoopMm);
    report.openAfter = next.report.openAfter;
    report.nonManifold = next.report.nonManifold;
    report.skipped = next.report.skipped;
  }
  return { positions: pass.positions, report };
}

function closeHolesOnce(positions: ArrayLike<number>, opts: { maxLoopMm?: number; crackTolMm?: number }): { positions: Float32Array; report: HoleReport } {
  // A crack is narrow against the part: 0.05 mm on a part of ordinary size, less on a small one, where 0.05 mm is a
  // whole triangle and "mending" it would fold the surface.
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) for (let k = 0; k < 3; k += 1) {
    lo[k] = Math.min(lo[k]!, positions[i + k]!);
    hi[k] = Math.max(hi[k]!, positions[i + k]!);
  }
  const diagonal = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) || 0;
  const mended = closeCracks(positions, opts.crackTolMm ?? Math.max(WELD_MM, Math.min(0.05, diagonal * 5e-4)));
  const welded = weld(mended);
  const { points } = welded;
  const keyOf = (a: number, b: number) => (a < b ? a * 0x4000000 + b : b * 0x4000000 + a);
  const report: HoleReport = { holes: 0, added: 0, openBefore: edgeReport(positions, 0).open, openAfter: 0, nonManifold: 0, largestLoopMm: 0, skipped: 0, removed: 0 };
  let tris = welded.tris;
  if (report.openBefore > 0) {
    // Doubles: the same three corners twice. Facing the same way, one is kept; back to back they are a sheet of no
    // thickness, and both go.
    const seenTri = new Map<string, number[]>();
    for (let t = 0; t < tris.length; t += 3) {
      const key = [tris[t]!, tris[t + 1]!, tris[t + 2]!].sort((a, b) => a - b).join(",");
      const row = seenTri.get(key);
      if (row) row.push(t);
      else seenTri.set(key, [t]);
    }
    const drop = new Set<number>();
    const even = (t: number) => {
      const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
      const m = Math.min(a, b, c);
      const [x, y] = m === a ? [b, c] : m === b ? [c, a] : [a, b];
      return x < y;
    };
    for (const row of seenTri.values()) {
      if (row.length < 2) continue;
      const one = row.filter((t) => even(t));
      const other = row.filter((t) => !even(t));
      const keep = one.length > other.length ? one[0] : other.length > one.length ? other[0] : undefined;
      for (const t of row) if (t !== keep) drop.add(t);
    }
    const without = (gone: Set<number>) => {
      const next: number[] = [];
      for (let t = 0; t < tris.length; t += 3) if (!gone.has(t)) next.push(tris[t]!, tris[t + 1]!, tris[t + 2]!);
      report.removed += gone.size;
      return next;
    };
    if (drop.size > 0) tris = without(drop);
    // Flaps: a triangle with one edge open and another shared by three or more hangs off a surface that goes on
    // without it. Taking it off can bare the next one, so this runs until nothing changes.
    for (let round = 0; round < 32; round += 1) {
      const count = edgeUse(tris);
      const flap = new Set<number>();
      for (let t = 0; t < tris.length; t += 3) {
        let open = false, crowded = false;
        for (let k = 0; k < 3; k += 1) {
          const n = count.get(keyOf(tris[t + k]!, tris[t + ((k + 1) % 3)]!))!;
          if (n === 1) open = true;
          else if (n > 2) crowded = true;
        }
        if (open && crowded) flap.add(t);
      }
      if (flap.size === 0) break;
      tris = without(flap);
    }
  }
  const use = edgeUse(tris);
  // Open edges, each way round: the triangles about a hole do not always agree which way they face, so a loop is
  // followed whichever way its edges run, and turned afterwards. `ran` holds each open edge as its triangle runs it.
  const out = new Map<number, number[]>();
  const ran = new Set<number>();
  let open = 0;
  const link = (from: number, to: number) => {
    const row = out.get(from);
    if (row) row.push(to);
    else out.set(from, [to]);
  };
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const a = tris[t + k]!, b = tris[t + ((k + 1) % 3)]!;
      if (use.get(keyOf(a, b)) !== 1) continue;
      open += 1;
      ran.add(a * 0x4000000 + b);
      link(a, b);
      link(b, a);
    }
  }
  const unlink = (from: number, to: number) => {
    const row = out.get(from)!;
    row.splice(row.lastIndexOf(to), 1);
  };
  const added: number[] = [];
  if (open > 0) {
    const lengthOf = (loop: readonly number[]) => loop.reduce((sum, v, i) => {
      const w = loop[(i + 1) % loop.length]!;
      return sum + Math.hypot(points[v * 3]! - points[w * 3]!, points[v * 3 + 1]! - points[w * 3 + 1]!, points[v * 3 + 2]! - points[w * 3 + 2]!);
    }, 0);
    for (const start of [...out.keys()]) {
      while ((out.get(start)?.length ?? 0) > 0) {
        // Walk open edges from `start`. Coming back to a corner already on the path closes one loop, which is cut off.
        const path: number[] = [start];
        const where = new Map<number, number>([[start, 0]]);
        let at = start;
        for (;;) {
          const row = out.get(at);
          if (!row || row.length === 0) break;
          const next = row.pop()!;
          unlink(next, at);
          const seenAt = where.get(next);
          if (seenAt === undefined) {
            where.set(next, path.length);
            path.push(next);
            at = next;
            continue;
          }
          const loop = path.splice(seenAt);
          for (const v of loop) where.delete(v);
          if (loop.length >= 3) {
            // A triangle runs its open edge a to b, so the fill beside it runs b to a. The loop is turned to disagree
            // with as many of its triangles as it can.
            let same = 0;
            for (let i = 0; i < loop.length; i += 1) if (ran.has(loop[i]! * 0x4000000 + loop[(i + 1) % loop.length]!)) same += 1;
            if (same * 2 > loop.length) loop.reverse();
            const length = lengthOf(loop);
            if (opts.maxLoopMm !== undefined && length > opts.maxLoopMm) report.skipped += 1;
            else {
              const fill = fillLoop(points, loop);
              added.push(...fill);
              report.holes += 1;
              report.added += fill.length / 3;
              report.largestLoopMm = Math.max(report.largestLoopMm, Math.round(length * 100) / 100);
            }
          }
          if (seenAt === 0) break;
          where.set(next, path.length);
          path.push(next);
          at = next;
        }
      }
    }
  }
  const all = added.length > 0 ? [...tris, ...added] : tris;
  const result = new Float32Array(all.length * 3);
  for (let i = 0; i < all.length; i += 1) {
    result[i * 3] = points[all[i]! * 3]!;
    result[i * 3 + 1] = points[all[i]! * 3 + 1]!;
    result[i * 3 + 2] = points[all[i]! * 3 + 2]!;
  }
  for (const count of edgeUse(all).values()) {
    if (count === 1) report.openAfter += 1;
    else if (count > 2) report.nonManifold += 1;
  }
  return { positions: result, report };
}
