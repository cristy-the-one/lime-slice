import { CHUNK_LAYERS, KIND_SHIFT, MAX_KINDS, ODD_LAYER_BIT, STYLE_WORDS, WEIGHT_STEPS, buildWirePreview, meshCenter, type PreviewChunk, type PreviewGeometry, type WireLayer } from "./preview-geom.ts";
import { encodePaths, type PreviewPath } from "./preview-wire.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `\n got ${JSON.stringify(actual)}\n want ${JSON.stringify(expected)}`);
}

function sameNums(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function sameChunk(a: PreviewChunk, b: PreviewChunk): boolean {
  return a.object === b.object
    && JSON.stringify(a.indices) === JSON.stringify(b.indices)
    && sameNums(a.beads.at, b.beads.at)
    && sameNums(a.beads.xyz, b.beads.xyz)
    && sameNums(a.beads.style, b.beads.style)
    && sameNums(a.travel.at, b.travel.at)
    && sameNums(a.travel.xyz, b.travel.xyz)
    && sameNums(a.travel.style, b.travel.style);
}

function sameGeom(a: PreviewGeometry, b: PreviewGeometry): boolean {
  return JSON.stringify(a.kinds) === JSON.stringify(b.kinds) && a.chunks.length === b.chunks.length && a.chunks.every((chunk, i) => sameChunk(chunk, b.chunks[i]));
}

/** The previous per-object scan. The single-pass builder must match it byte for byte. */
function referenceWirePreview(msg: { layers: WireLayer[]; min: number[]; max: number[]; kinds?: readonly string[]; objects?: number }): PreviewGeometry {
  const kinds = [...(msg.kinds ?? [])];
  const { cx, cy } = meshCenter(msg.min, msg.max);
  const chunks: PreviewChunk[] = [];
  const layers = msg.layers;
  let objects = Math.max(msg.objects ?? 1, 1);
  for (const layer of layers) for (const o of layer.paths.object ?? []) objects = Math.max(objects, o + 1);
  const assign = (kind: string) => {
    let i = kinds.indexOf(kind);
    if (i < 0 && kinds.length < MAX_KINDS) i = kinds.push(kind) - 1;
    return i < 0 ? MAX_KINDS - 1 : i;
  };
  const u16 = (v: number) => Math.min(65535, Math.max(0, Math.round(v)));
  const half = (width: number | undefined) => Math.max(0.05, (width ?? 0.45) / 2);
  const heightOf = (bead: number | undefined, layerH: number | undefined) => {
    const picked = bead && bead > 1e-6 ? bead : layerH;
    const height = picked && picked > 1e-6 ? picked : 0.2;
    return Math.max(0.04, height);
  };
  for (let object = 0; object < objects; object++) {
    for (let i = 0; i < layers.length;) {
      const key = Math.floor(layers[i].index / CHUNK_LAYERS);
      let j = i + 1;
      while (j < layers.length && Math.floor(layers[j].index / CHUNK_LAYERS) === key) j++;
      const range = layers.slice(i, j);
      const travelSlot = range.map((layer) => layer.paths.kinds.indexOf("travel"));
      const beadAt = new Int32Array(range.length + 1);
      const travelAt = new Int32Array(range.length + 1);
      for (let l = 0; l < range.length; l++) {
        const cols = range[l].paths;
        let beads = 0;
        let travel = 0;
        for (let p = 0; p < cols.kind.length; p++) {
          const points = cols.start[p + 1] - cols.start[p];
          if (points < 2 || (cols.object?.[p] ?? 0) !== object) continue;
          if (cols.kind[p] === travelSlot[l]) travel += points;
          else beads += points;
        }
        beadAt[l + 1] = beadAt[l] + beads;
        travelAt[l + 1] = travelAt[l] + travel;
      }
      const run = (at: Int32Array) => ({ xyz: new Float32Array(at[at.length - 1] * 3), style: new Uint16Array(at[at.length - 1] * STYLE_WORDS), at });
      const beads = run(beadAt);
      const travel = run(travelAt);
      for (let l = 0; l < range.length; l++) {
        const layer = range[l];
        const cols = layer.paths;
        const slots = new Int16Array(cols.kinds.length).fill(-1);
        let b = beadAt[l];
        let t = travelAt[l];
        for (let p = 0; p < cols.kind.length; p++) {
          const start = cols.start[p];
          const end = cols.start[p + 1];
          if (end - start < 2 || (cols.object?.[p] ?? 0) !== object) continue;
          const isTravel = cols.kind[p] === travelSlot[l];
          const dest = isTravel ? travel : beads;
          const at = isTravel ? t : b;
          const z = cols.z.length >= end ? cols.z : null;
          for (let k = start; k < end; k++) {
            const o = (at + k - start) * 3;
            dest.xyz[o] = cols.xy[2 * k] - cx;
            dest.xyz[o + 1] = z ? (z[k] ?? layer.z) : layer.z;
            dest.xyz[o + 2] = -(cols.xy[2 * k + 1] - cy);
          }
          if (slots[cols.kind[p]] < 0) slots[cols.kind[p]] = assign(cols.kinds[cols.kind[p]]);
          const word = slots[cols.kind[p]] * KIND_SHIFT + Math.round(Math.min(1, Math.max(0, cols.toughness[p] ?? 0)) * WEIGHT_STEPS);
          const speed = Math.min(ODD_LAYER_BIT - 1, u16((cols.effectiveSpeed[p] ?? cols.speed[p] ?? 0) * 10)) | (layer.index & 1 ? ODD_LAYER_BIT : 0);
          const width = u16(half(cols.width[p]) * 1000);
          const height = u16(heightOf(cols.beadHeight[p], layer.height) * 1000);
          for (let s = at * STYLE_WORDS, last = (at + end - start - 1) * STYLE_WORDS; s < last; s += STYLE_WORDS) {
            dest.style[s] = word;
            dest.style[s + 1] = speed;
            dest.style[s + 2] = width;
            dest.style[s + 3] = height;
          }
          if (isTravel) t += end - start;
          else b += end - start;
        }
      }
      chunks.push({ object, indices: range.map((layer) => layer.index), beads, travel });
      i = j;
    }
  }
  return { kinds, chunks };
}

const layer = (index: number, paths: Partial<PreviewPath>[], height = 0.2): WireLayer => ({ index, z: (index + 1) * height, height, paths: encodePaths(paths) });

const bounds = { min: [0, 0, 0], max: [40, 20, 10] };

function assertMatch(name: string, msg: { layers: WireLayer[]; min: number[]; max: number[]; kinds?: readonly string[]; objects?: number }): void {
  const got = buildWirePreview(msg);
  const want = referenceWirePreview(msg);
  check(name, sameGeom(got, want), sameGeom(got, want) ? "" : `\n got kinds ${JSON.stringify(got.kinds)} chunks ${got.chunks.length}\n want kinds ${JSON.stringify(want.kinds)} chunks ${want.chunks.length}`);
}

assertMatch("one object, one chunk", {
  ...bounds,
  layers: [layer(0, [
    { kind: "outer", pts: [[0, 0], [4, 0]], width: 0.4, speed: 40, zs: [0.2, 0.18], beadHeight: 0.2 },
    { kind: "gap-fill", pts: [[0, 0]], width: 0.4 },
  ])],
});

assertMatch("kind slots follow object order across chunk boundaries, not path order", {
  ...bounds,
  objects: 3,
  kinds: ["seed"],
  layers: [
    layer(0, [
      { kind: "support", object: 1, pts: [[30, 0], [34, 0]], width: 0.45, speed: 40, toughness: 1 },
      { kind: "outer", object: 0, pts: [[0, 0], [4, 0]], width: 0.4, speed: 50, toughness: 0.25 },
      { kind: "travel", object: 0, pts: [[4, 0], [4, 3]], speed: 120 },
    ]),
    layer(1, [
      { kind: "outer", object: 1, pts: [[30, 1], [34, 1]], width: 0.4, speed: 40 },
    ]),
    layer(32, [
      { kind: "sparse", object: 0, pts: [[0, 1], [4, 1], [4, 2]], width: 0.45, speed: 80, effectiveSpeed: 70, toughness: 0.4 },
      { kind: "support", object: 1, pts: [[30, 1], [31, 1]], width: 0.45, speed: 30 },
    ]),
  ],
});

const gotKinds = buildWirePreview({
  ...bounds,
  objects: 3,
  kinds: ["seed"],
  layers: [
    layer(0, [
      { kind: "support", object: 1, pts: [[30, 0], [34, 0]] },
      { kind: "outer", object: 0, pts: [[0, 0], [4, 0]] },
    ]),
    layer(32, [{ kind: "sparse", object: 0, pts: [[0, 1], [4, 1]] }]),
  ],
});
eq("an earlier object's later chunk claims a kind before a later object", gotKinds.kinds, ["seed", "outer", "sparse", "support"]);
eq("empty objects still get a chunk per range, object-major", gotKinds.chunks.map((c) => [c.object, c.indices, c.beads.xyz.length]), [
  [0, [0], 6],
  [0, [32], 6],
  [1, [0], 6],
  [1, [32], 0],
  [2, [0], 0],
  [2, [32], 0],
]);

const mixed: WireLayer[] = [];
let n = 1;
for (let index = 0; index < 70; index += index === 10 ? 25 : 1) {
  const paths: Partial<PreviewPath>[] = [];
  for (let p = 0; p < 6; p++) {
    for (let object = 2; object >= 0; object--) {
      const pts: [number, number][] = [];
      const count = 2 + ((n + object) % 4);
      for (let k = 0; k < count; k++) pts.push([object * 3 + k, index + p * 0.1]);
      paths.push({
        kind: ["outer", "travel", "sparse", "support", "gap-fill", "inner"][(n + object) % 6],
        object: object === 2 && p === 0 ? undefined : object,
        pts,
        width: 0.3 + (object % 3) * 0.1,
        speed: 20 + n,
        effectiveSpeed: p % 2 ? undefined : 15 + n,
        toughness: ((n % 5) - 1) / 3,
        beadHeight: p % 3 === 0 ? 0 : 0.2,
        zs: p % 2 === 0 ? pts.map((_, k) => (k === 1 ? null : index * 0.2 + k * 0.01)) as number[] : undefined,
      });
      n++;
    }
    if (p === 3) paths.push({ kind: "outer", object: 0, pts: [[1, 1]] });
    if (p === 4) paths.push({ kind: "outer", object: -1, pts: [[1, 1], [2, 2]] });
  }
  mixed.push(layer(index, paths, index % 2 ? 0 : 0.16));
}
assertMatch("interleaved objects, gaps, short paths, and dropped indexes match the per-object scan", { ...bounds, layers: mixed, objects: 4, kinds: ["travel"] });
assertMatch("a fractional object count still visits every integer slot", {
  ...bounds,
  objects: 2.5,
  layers: [layer(0, [{ kind: "outer", object: 2, pts: [[0, 0], [1, 0]], width: 0.4 }])],
});
assertMatch("no layers is an empty preview", { ...bounds, layers: [], objects: 3 });
assertMatch("a missing object column is object 0", {
  ...bounds,
  layers: [layer(5, [{ kind: "inner", pts: [[1, 2], [3, 4]], speed: 10 }])],
});

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("preview-geom: single-pass chunks match the per-object scan");
