import { expect, test } from "@playwright/test";
import { buildWirePreview, INNER_HALF_SCALE, MARGIN_SHADE, ODD_LAYER_BIT, scenePoint } from "../src/preview-geom";
import { encodePaths, type PreviewPath } from "../src/preview-wire";

const f32 = (values: number[]) => Array.from(new Float32Array(values));
const layer = (index: number, z: number, paths: Partial<PreviewPath>[]) => ({ index, z, height: 0.2, paths: encodePaths(paths) });

test("bead margins stay darker than the face so same-color neighbors do not fuse", () => {
  const built = buildWirePreview({
    layers: [layer(0, 0.2, [
      { kind: "top", pts: [[0, 0], [10, 0]], width: 0.45 },
      { kind: "top", pts: [[0, 0.45], [10, 0.45]], width: 0.45 },
    ])],
    min: [0, -5, 0],
    max: [10, 5, 1],
  });
  expect(MARGIN_SHADE).toBeLessThan(0.7);
  expect(INNER_HALF_SCALE).toBeLessThan(1);
  const beads = built.chunks[0].beads;
  expect(Array.from(beads.at)).toEqual([0, 4]);
  expect(Array.from(beads.xyz)).toEqual(f32([-5, 0.2, -0, 5, 0.2, -0, -5, 0.2, -0.45, 5, 0.2, -0.45]));
  // Half width and bead height in µm; a path's last point starts no segment.
  expect(Array.from(beads.style)).toEqual([0, 0, 225, 200, 0, 0, 0, 0, 0, 0, 225, 200, 0, 0, 0, 0]);
});

test("every segment carries its kind slot, blend weight, and speed for the shader", () => {
  const built = buildWirePreview({
    layers: [layer(0, 1, [
      { kind: "sparse", pts: [[0, 0], [4, 0]], width: 0.4, speed: 80, effectiveSpeed: 70, toughness: 0.4 },
      { kind: "travel", pts: [[4, 0], [4, 3]], speed: 120 },
      { kind: "sparse", pts: [[4, 3], [0, 3]], width: 0.4, speed: 60 },
    ])],
    min: [0, -3, 0],
    max: [4, 3, 2],
  });
  expect(built.kinds).toEqual(["sparse", "travel"]);
  const { beads, travel } = built.chunks[0];
  // Slot 0 with weight 0.4 of 2047 steps, 70 mm/s in tenths.
  expect(Array.from(beads.style.slice(0, 4))).toEqual([819, 700, 200, 200]);
  expect(Array.from(beads.style.slice(8, 12))).toEqual([0, 600, 200, 200]);
  expect(Array.from(travel.style)).toEqual([2048, 1200, 50, 200, 0, 0, 0, 0]);
  expect(Array.from(travel.xyz)).toEqual(f32([2, 1, -0, 2, 1, -3]));
});

test("print-head scene position uses the mesh center, not machine origin", () => {
  const cx = 110;
  const cy = 110;
  const onPart = scenePoint(112, 108, 4.2, cx, cy);
  expect(onPart[0]).toBeCloseTo(2);
  expect(onPart[1]).toBeCloseTo(4.2);
  expect(onPart[2]).toBeCloseTo(2);
  const parkedAtCorner = scenePoint(112, 108, 4.2, 0, 0);
  expect(Math.hypot(parkedAtCorner[0] - onPart[0], parkedAtCorner[2] - onPart[2])).toBeGreaterThan(100);
});

test("layers follow in index order, with each layer's first point and nozzle z", () => {
  const built = buildWirePreview({
    layers: [
      layer(0, 0.2, [
        { kind: "outer", pts: [[0, 0], [4, 0]], width: 0.4, speed: 40, zs: [0.2, 0.18], beadHeight: 0.2 },
        { kind: "gap-fill", pts: [[0, 0]], width: 0.4 },
      ]),
      layer(1, 1, [
        { kind: "sparse", pts: [[0, 1], [4, 1]], width: 0.45, speed: 80, effectiveSpeed: 70, toughness: 0.25 },
        { kind: "outer", pts: [[4, 1], [4, 3]], width: 0.4, speed: 40 },
        { kind: "travel", pts: [[4, 3], [0, 3]], speed: 120 },
      ]),
    ],
    min: [0, 0, 0],
    max: [4, 4, 2],
  });
  expect(built.kinds).toEqual(["outer", "sparse", "travel"]);
  expect(built.chunks).toHaveLength(1);
  const { indices, beads, travel } = built.chunks[0];
  expect(indices).toEqual([0, 1]);
  expect(Array.from(beads.at)).toEqual([0, 2, 6]);
  expect(Array.from(travel.at)).toEqual([0, 0, 2]);
  expect(Array.from(beads.xyz)).toEqual(f32([-2, 0.2, 2, 2, 0.18, 2, -2, 1, 1, 2, 1, 1, 2, 1, 1, 2, 1, -1]));
  expect(Array.from(beads.style)).toEqual([
    0, 400, 200, 200, 0, 0, 0, 0,
    2048 + 512, ODD_LAYER_BIT + 700, 225, 200, 0, 0, 0, 0,
    0, ODD_LAYER_BIT + 400, 200, 200, 0, 0, 0, 0,
  ]);
  expect(Array.from(travel.xyz)).toEqual(f32([2, 1, -1, -2, 1, -1]));
});
