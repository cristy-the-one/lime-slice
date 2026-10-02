import { buildWirePreview, type PreviewGeometry } from "./preview-geom.ts";
import { patchGeometry, patchLayers, type PreviewPatch } from "./preview-patch.ts";
import { decodePaths, encodePaths, type PreviewPath } from "./preview-wire.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}`);
}

const bead = (kind: string, x: number, zs?: number[]): Partial<PreviewPath> => ({ kind, strategy: "toughness", pts: [[x, 0], [x + 1, 0], [x + 1, 1]], zs, width: 0.45, speed: 40, toughness: 1 });
const hop = (x: number): Partial<PreviewPath> => ({ kind: "travel", pts: [[x, 0], [x + 5, 5]], speed: 150 });
const layer = (index: number, paths: Partial<PreviewPath>[]) => ({ index, z: 0.2 * (index + 1), height: 0.2, paths: encodePaths(paths) });

const held = [
  layer(0, [bead("skirt", 0), hop(1), bead("outer", 2)]),
  layer(1, [bead("support", 0), hop(1), bead("support", 3), hop(4), bead("outer", 6, [0.3, 0.35, 0.4]), bead("gap-fill", 12)]),
  layer(2, [bead("support", 9)]),
];
const patch: PreviewPatch = {
  base: "a",
  layers: [0, 1, 3],
  changed: [
    { ...layer(1, [hop(7), bead("support-interface", 8)]), order: [2, -1, -2, 4] },
    { ...layer(3, [bead("top", 1)]), order: [-1] },
  ],
};
const merged = patchLayers(held, patch)!;
eq("layer list follows the patch", merged.map((l) => l.index), [0, 1, 3]);
check("an unchanged layer is the held one", merged[0] === held[0]);
eq(
  "a changed layer mixes held and sent paths in order",
  decodePaths(merged[1].paths, 0.4).map((p) => [p.kind, p.pts[0][0], p.zs ?? null]),
  [["support", 3, [0.4, 0.4, 0.4]], ["travel", 7, [0.4, 0.4]], ["support-interface", 8, [0.4, 0.4, 0.4]], ["outer", 6, [0.3, 0.35, 0.4]]],
);
eq("a merged layer names only the kinds it uses", merged[1].paths.kinds, ["support", "travel", "support-interface", "outer"]);
eq("a new layer is the sent paths", decodePaths(merged[2].paths, 0.8).map((p) => p.kind), ["top"]);
eq("a reference past the held layer is refused", patchLayers(held, { ...patch, changed: [{ ...patch.changed[0], order: [9] }] }), null);
eq("a layer the holder lacks is refused", patchLayers(held, { ...patch, layers: [0, 5] }), null);

const bounds = { min: [0, 0, 0], max: [20, 10, 2] };
const old = buildWirePreview({ layers: held, ...bounds });
const fresh = buildWirePreview({ layers: patch.changed, ...bounds, kinds: old.kinds });
const spliced = patchGeometry(old, held, patch, fresh);
const rebuilt = buildWirePreview({ layers: merged, ...bounds, kinds: spliced.kinds });
const arrays = (g: PreviewGeometry) => [g.ribbon, g.ribbonInfo, g.face, g.faceInfo, g.travel, g.travelInfo].map((a) => Array.from(a));
eq("spliced ranges equal a full build", spliced.ranges, rebuilt.ranges);
eq("spliced buffers equal a full build", arrays(spliced), arrays(rebuilt));
check("the splice kept every shown kind slot", old.kinds.every((k, i) => spliced.kinds[i] === k));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("preview-patch: layers and buffers ok");
