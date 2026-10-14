/**
 * Disconnected triangle shells. Vertices within `WELD_MM` are the same point,
 * so a shell whose STL repeats its corners stays one piece. Shells that do not
 * touch stay separate. Nothing here moves a shell onto the bed.
 */

/** Coincident corners in an STL are rarely the same float. A micron welds them. */
export const WELD_MM = 0.001;

export interface ShellGroups {
  count: number;
  /** Triangle indexes, largest shell first. */
  groups: number[][];
}

interface Analysis {
  count: number;
  groups: number[][] | null;
}

const cached = new WeakMap<Float32Array, Analysis>();

function quant(value: number): number {
  return Math.round(value / WELD_MM);
}

function analyze(pos: Float32Array): Analysis {
  const hit = cached.get(pos);
  if (hit) return hit;
  const count = Math.floor(pos.length / 9);
  const groups = count < 2 ? null : components(pos, count);
  const next: Analysis = { count: groups?.length ?? (count > 0 ? 1 : 0), groups: groups && groups.length >= 2 ? groups : null };
  cached.set(pos, next);
  return next;
}

function components(pos: Float32Array, tris: number): number[][] | null {
  const parent = new Int32Array(tris);
  for (let i = 0; i < tris; i++) parent[i] = i;
  const find = (index: number) => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== root) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const owner = new Map<string, number>();
  for (let tri = 0; tri < tris; tri++) {
    const base = tri * 9;
    for (let corner = 0; corner < 3; corner++) {
      const at = base + corner * 3;
      const key = `${quant(pos[at]!)},${quant(pos[at + 1]!)},${quant(pos[at + 2]!)}`;
      const prev = owner.get(key);
      if (prev === undefined) owner.set(key, tri);
      else union(prev, tri);
    }
  }
  const buckets = new Map<number, number[]>();
  for (let tri = 0; tri < tris; tri++) {
    const root = find(tri);
    const list = buckets.get(root);
    if (list) list.push(tri);
    else buckets.set(root, [tri]);
  }
  if (buckets.size < 2) return null;
  return [...buckets.values()].sort((a, b) => b.length - a.length || a[0]! - b[0]!);
}

/** How many shells this mesh has. One solid is 1. An empty mesh is 0. */
export function shellCount(pos: Float32Array): number {
  return analyze(pos).count;
}

/** Triangle groups when the mesh is more than one shell. Otherwise null. */
export function shellGroups(pos: Float32Array): ShellGroups | null {
  const found = analyze(pos);
  if (!found.groups) return null;
  return { count: found.count, groups: found.groups };
}

/** Copy `groups` out of `pos`. `pos` and the group source must be the same triangle order. */
export function takeGroups(pos: Float32Array, groups: readonly number[][]): Float32Array[] {
  return groups.map((tris) => {
    const out = new Float32Array(tris.length * 9);
    let write = 0;
    for (const tri of tris) {
      const at = tri * 9;
      out[write] = pos[at]!;
      out[write + 1] = pos[at + 1]!;
      out[write + 2] = pos[at + 2]!;
      out[write + 3] = pos[at + 3]!;
      out[write + 4] = pos[at + 4]!;
      out[write + 5] = pos[at + 5]!;
      out[write + 6] = pos[at + 6]!;
      out[write + 7] = pos[at + 7]!;
      out[write + 8] = pos[at + 8]!;
      write += 9;
    }
    return out;
  });
}

/** STEP assemblies only. The button is the way an STL splits; this is the extra offer. */
export function assemblyNotice(fileName: string, shells: number): { message: string; label: string } | null {
  if (shells < 2 || !/\.(step|stp)$/i.test(fileName)) return null;
  return {
    message: `Imported assembly with ${shells} solids.`,
    label: `Split into ${shells} objects`,
  };
}
