/** Mirrors `strategy::mix` / `pure` so the panel can update before the next slice. */

export interface ResolvedCard {
  name: string;
  toughness: number;
  walls: number;
  pattern: string;
  density: number;
  outer: number;
  inner: number;
  sparse: number;
  top: number;
  travel: number;
  effectiveOuter: number;
  effectiveInner: number;
  effectiveSparse: number;
  effectiveTop: number;
}

const SPEED = {
  walls: 2,
  density: 0.12,
  pattern: "lightning",
  outer: 130,
  inner: 160,
  sparse: 220,
  solid: 150,
  top: 120,
  travel: 300,
};

const TOUGH = {
  walls: 5,
  density: 0.48,
  pattern: "gyroid",
  outer: 40,
  inner: 48,
  sparse: 55,
  solid: 42,
  top: 36,
  travel: 140,
};

export function layerWeight(z: number, bottomMm: number, transitionMm: number): number {
  if (z <= Math.max(0, bottomMm)) return 1;
  if (transitionMm <= 1e-6 || z >= bottomMm + transitionMm) return 0;
  return 1 - (z - bottomMm) / transitionMm;
}

export function resolved(toughness: number, layerH = 0.2, lineWidth = 0.45, maxVol = 12): ResolvedCard {
  const t = Math.max(0, Math.min(1, toughness));
  const lerp = (a: number, b: number) => a + (b - a) * t;
  let pattern = "gyroid";
  if (t < 0.2) pattern = "lightning";
  else if (t < 0.45) pattern = "lines";
  else if (t < 0.75) pattern = "grid";
  const cap = (speed: number) => {
    const area = Math.max(1e-6, lineWidth * layerH);
    return Math.min(speed, maxVol / area);
  };
  const outer = lerp(SPEED.outer, TOUGH.outer);
  const inner = lerp(SPEED.inner, TOUGH.inner);
  const sparse = lerp(SPEED.sparse, TOUGH.sparse);
  const top = lerp(SPEED.top, TOUGH.top);
  const name = t <= 1e-9 ? "speed" : t >= 1 - 1e-9 ? "toughness" : Math.abs(t - 0.5) < 0.02 ? "efficiency" : "weight";
  return {
    name,
    toughness: t,
    walls: Math.round(lerp(SPEED.walls, TOUGH.walls)),
    pattern,
    density: lerp(SPEED.density, TOUGH.density),
    outer,
    inner,
    sparse,
    top,
    travel: lerp(SPEED.travel, TOUGH.travel),
    effectiveOuter: cap(outer),
    effectiveInner: cap(inner),
    effectiveSparse: cap(sparse),
    effectiveTop: cap(top),
  };
}
