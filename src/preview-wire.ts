/**
 * The engine sends each preview layer's paths as parallel arrays: a few long
 * number arrays parse far faster than one object per path. `start[i]` to
 * `start[i + 1]` are path `i`'s points, two numbers each in `xy` and one each
 * in `z`. `z` is empty when every point sits on the layer, and `null` marks a
 * point that does.
 */
export interface PathColumns {
  kinds: string[];
  strategies: string[];
  kind: number[];
  strategy: number[];
  width: number[];
  speed: number[];
  effectiveSpeed: number[];
  toughness: number[];
  beadHeight: number[];
  start: number[];
  xy: number[];
  z: (number | null)[];
}

export interface PreviewPath {
  kind: string;
  strategy: string;
  pts: [number, number][];
  zs?: number[];
  width: number;
  speed: number;
  effectiveSpeed: number;
  toughness: number;
  beadHeight: number;
}

export function pathCount(cols: PathColumns): number {
  return cols.kind.length;
}

export function decodePaths(cols: PathColumns, layerZ: number): PreviewPath[] {
  const out: PreviewPath[] = new Array(cols.kind.length);
  for (let i = 0; i < cols.kind.length; i++) {
    const a = cols.start[i];
    const b = cols.start[i + 1];
    const pts: [number, number][] = new Array(b - a);
    for (let k = a; k < b; k++) pts[k - a] = [cols.xy[2 * k], cols.xy[2 * k + 1]];
    const path: PreviewPath = {
      kind: cols.kinds[cols.kind[i]],
      strategy: cols.strategies[cols.strategy[i]],
      pts,
      width: cols.width[i],
      speed: cols.speed[i],
      effectiveSpeed: cols.effectiveSpeed[i],
      toughness: cols.toughness[i],
      beadHeight: cols.beadHeight[i],
    };
    if (cols.z.length > 0) path.zs = cols.z.slice(a, b).map((z) => z ?? layerZ);
    out[i] = path;
  }
  return out;
}

/** The inverse of `decodePaths`, for tests and recorded fixtures. */
export function encodePaths(paths: Partial<PreviewPath>[]): PathColumns {
  const cols: PathColumns = { kinds: [], strategies: [], kind: [], strategy: [], width: [], speed: [], effectiveSpeed: [], toughness: [], beadHeight: [], start: [0], xy: [], z: [] };
  const slot = (table: string[], name: string) => {
    const i = table.indexOf(name);
    return i >= 0 ? i : table.push(name) - 1;
  };
  const withZ = paths.some((p) => p.zs && p.zs.length > 0);
  for (const p of paths) {
    cols.kind.push(slot(cols.kinds, p.kind ?? "travel"));
    cols.strategy.push(slot(cols.strategies, p.strategy ?? "speed"));
    cols.width.push(p.width ?? 0);
    cols.speed.push(p.speed ?? 0);
    cols.effectiveSpeed.push(p.effectiveSpeed ?? p.speed ?? 0);
    cols.toughness.push(p.toughness ?? 0);
    cols.beadHeight.push(p.beadHeight ?? 0);
    (p.pts ?? []).forEach(([x, y], k) => {
      cols.xy.push(x, y);
      if (withZ) cols.z.push(p.zs?.[k] ?? null);
    });
    cols.start.push(cols.xy.length / 2);
  }
  return cols;
}
