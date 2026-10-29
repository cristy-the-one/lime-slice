import { beadCorners, buildWirePreview, KIND_SHIFT, STYLE_WORDS, type Vec3 } from "../src/preview-geom";
import type { WireLayer } from "../src/preview-geom";

/**
 * A hollow box, mouth down, with an inward lip, in 1 mm cells, turned 45° about X so the
 * roof's and the lip's undersides face straight against a 45° belt's build direction: each
 * is born in the air on one layer, the case "Tip under every row" holds up.
 */
export const LIPBOX = { size: 16, height: 10, wall: 1, lipLow: 3, lipHigh: 4, lipIn: 4 };

function filled(x: number, y: number, z: number): boolean {
  const { size, height, wall, lipLow, lipHigh, lipIn } = LIPBOX;
  if (x < 0 || y < 0 || z < 0 || x >= size || y >= size || z >= height) return false;
  const side = x < wall || x >= size - wall || y < wall || y >= size - wall;
  const roof = z >= height - wall;
  const lip = z >= lipLow && z < lipHigh && (x < lipIn || x >= size - lipIn || y < lipIn || y >= size - lipIn);
  return side || roof || lip;
}

function tilt([x, y, z]: number[]): number[] {
  const c = Math.SQRT1_2;
  return [x, y * c - z * c, y * c + z * c].map((v) => Number(v.toFixed(5)));
}

export function lipBoxStl(): string {
  const { size, height } = LIPBOX;
  const out = ["solid lipbox"];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    for (const tri of [[a, b, c], [a, c, d]]) {
      out.push("facet normal 0 0 0", "outer loop");
      for (const v of tri) out.push(`vertex ${tilt(v).join(" ")}`);
      out.push("endloop", "endfacet");
    }
  };
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) for (let z = 0; z < height; z++) {
    if (!filled(x, y, z)) continue;
    if (!filled(x - 1, y, z)) quad([x, y, z], [x, y, z + 1], [x, y + 1, z + 1], [x, y + 1, z]);
    if (!filled(x + 1, y, z)) quad([x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]);
    if (!filled(x, y - 1, z)) quad([x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]);
    if (!filled(x, y + 1, z)) quad([x, y + 1, z], [x, y + 1, z + 1], [x + 1, y + 1, z + 1], [x + 1, y + 1, z]);
    if (!filled(x, y, z - 1)) quad([x, y, z], [x, y + 1, z], [x + 1, y + 1, z], [x + 1, y, z]);
    if (!filled(x, y, z + 1)) quad([x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]);
  }
  out.push("endsolid lipbox");
  return out.join("\n");
}

interface Bead {
  layer: number;
  /** Top face corners, then bottom face corners, in the layer plane's 2D basis plus height along `up`. */
  top: [number, number][];
  topUp: number;
  bottomUp: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Separating-axis test for two convex quads in the plane, shrunk by `margin` so a graze does not count. */
function overlap(p: [number, number][], q: [number, number][], margin: number): boolean {
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const n: [number, number] = [ay - by, bx - ax];
      const len = Math.hypot(n[0], n[1]);
      if (len === 0) continue;
      const proj = (pts: [number, number][]) => pts.map(([x, y]) => (x * n[0] + y * n[1]) / len);
      const a = proj(p);
      const b = proj(q);
      if (Math.max(...a) - margin < Math.min(...b) || Math.max(...b) - margin < Math.min(...a)) return false;
    }
  }
  return true;
}

/**
 * Tree beads right under the bottom interface layer, as the preview draws them with `up`: for
 * each one under an interface bead on the next layer, the gap from its drawn top to that
 * interface bead's drawn bottom, along `up`. Zero is touching.
 */
export function tipContacts(reply: { layers: WireLayer[]; mesh: { min: number[]; max: number[] } }, up: Vec3) {
  const geometry = buildWirePreview({ layers: reply.layers, min: reply.mesh.min, max: reply.mesh.max });
  const support = geometry.kinds.indexOf("support");
  const iface = geometry.kinds.indexOf("support-interface");
  const across: Vec3 = [1, 0, 0];
  const along: Vec3 = [up[1] * across[2] - up[2] * across[1], up[2] * across[0] - up[0] * across[2], up[0] * across[1] - up[1] * across[0]];
  const flat = (v: Vec3): [number, number] => [dot(v, across), dot(v, along)];
  const layers = new Map<number, { support: Bead[]; iface: Bead[] }>();
  for (const chunk of geometry.chunks) {
    const run = chunk.beads;
    chunk.indices.forEach((index, l) => {
      const into = layers.get(index) ?? layers.set(index, { support: [], iface: [] }).get(index)!;
      for (let p = run.at[l]; p < run.at[l + 1] - 1; p++) {
        const s = p * STYLE_WORDS;
        if (run.style[s + 3] === 0) continue;
        const slot = Math.floor(run.style[s] / KIND_SHIFT);
        if (slot !== support && slot !== iface) continue;
        const a: Vec3 = [run.xyz[p * 3], run.xyz[p * 3 + 1], run.xyz[p * 3 + 2]];
        const b: Vec3 = [run.xyz[p * 3 + 3], run.xyz[p * 3 + 4], run.xyz[p * 3 + 5]];
        const c = beadCorners(a, b, run.style[s + 2] / 1000, run.style[s + 3] / 1000, up);
        // Corners: a +side top, a +side bottom, a −side top, a −side bottom, then the same at b.
        const bead: Bead = {
          layer: index,
          top: [c[0], c[4], c[6], c[2]].map(flat),
          topUp: Math.max(dot(c[0], up), dot(c[2], up), dot(c[4], up), dot(c[6], up)),
          bottomUp: Math.min(dot(c[1], up), dot(c[3], up), dot(c[5], up), dot(c[7], up)),
        };
        (slot === support ? into.support : into.iface).push(bead);
      }
    });
  }
  const gaps: number[] = [];
  const indices = [...layers.keys()].sort((a, b) => a - b);
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) continue;
    const below = layers.get(indices[i - 1])!;
    const here = layers.get(indices[i])!;
    for (const tip of below.support) {
      // A tree bead under interface on its own layer is not the top of its column.
      if (below.iface.some((other) => overlap(tip.top, other.top, 0.05))) continue;
      const held = here.iface.filter((bead) => overlap(tip.top, bead.top, 0.05));
      if (held.length === 0) continue;
      gaps.push(Math.min(...held.map((bead) => Math.abs(bead.bottomUp - tip.topUp))));
    }
  }
  return gaps;
}
