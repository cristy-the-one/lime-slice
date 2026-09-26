import { expect, test } from "@playwright/test";
import { buildPreviewGeometry, buildWirePreview, INNER_HALF_SCALE, MARGIN_SHADE, scenePoint } from "../src/preview-geom";
import { encodePaths } from "../src/preview-wire";

test("bead margins stay darker than the face so same-color neighbors do not fuse", () => {
  const built = buildPreviewGeometry({
    layers: [
      {
        z: 0.2,
        paths: [
          {
            kind: "top",
            pts: [[0, 0], [10, 0]],
            width: 0.45,
          },
          {
            kind: "top",
            pts: [[0, 0.45], [10, 0.45]],
            width: 0.45,
          },
        ],
      },
    ],
    min: [0, -5, 0],
    max: [10, 5, 1],
  });
  // Top, bottom, and two sides — four quads per segment, two segments.
  expect(built.ribbon.length / 3).toBe(48);
  expect(built.face.length / 3).toBe(12);
  const ys = [];
  for (let i = 1; i < built.ribbon.length; i += 3) ys.push(built.ribbon[i]);
  expect(Math.min(...ys)).toBeCloseTo(0, 5);
  expect(Math.max(...ys)).toBeCloseTo(0.2, 5);
  expect(MARGIN_SHADE).toBeLessThan(0.5);
  const half = 0.225;
  const outerHalf = Math.abs(built.ribbon[2 * 3 + 2]);
  const innerHalf = Math.abs(built.face[2 * 3 + 2]);
  expect(outerHalf).toBeCloseTo(half, 5);
  expect(innerHalf).toBeCloseTo(half * INNER_HALF_SCALE, 5);
  expect(innerHalf).toBeLessThan(outerHalf);
  expect(built.ranges[0].ribbonCount).toBe(48);
  expect(built.ranges[0].faceCount).toBe(12);
});

test("every vertex carries its kind slot, blend weight, and speed for the shader", () => {
  const built = buildPreviewGeometry({
    layers: [
      {
        z: 1,
        paths: [
          { kind: "sparse", pts: [[0, 0], [4, 0]], width: 0.4, speed: 80, effectiveSpeed: 70, toughness: 0.4 },
          { kind: "travel", pts: [[4, 0], [4, 3]], speed: 120 },
          { kind: "sparse", pts: [[4, 3], [0, 3]], width: 0.4, speed: 60 },
        ],
      },
    ],
    min: [0, -3, 0],
    max: [4, 3, 2],
  });
  expect(built.kinds).toEqual(["sparse", "travel"]);
  expect(Array.from(built.ribbonInfo.slice(0, 3))).toEqual([0, Math.fround(0.4), 70]);
  expect(Array.from(built.ribbonInfo.slice(-3))).toEqual([0, 0, 60]);
  expect(built.faceInfo.length).toBe(built.face.length);
  expect(Array.from(built.travelInfo)).toEqual([1, 0, 120, 1, 0, 120]);
  expect(built.travel.length).toBe(6);
  expect(Math.abs(built.face[2])).toBeLessThan(Math.abs(built.ribbon[2]));
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

test("layers are concatenated in index order and columnar input matches", () => {
  const layers = [
    {
      z: 0.2,
      height: 0.2,
      paths: [
        { kind: "outer", pts: [[0, 0], [4, 0]] as [number, number][], width: 0.4, speed: 40, zs: [0.2, 0.18], beadHeight: 0.2 },
        { kind: "gap-fill", pts: [[0, 0]] as [number, number][], width: 0.4 },
      ],
    },
    {
      z: 1,
      height: 0.2,
      paths: [
        { kind: "sparse", pts: [[0, 1], [4, 1]] as [number, number][], width: 0.45, speed: 80, effectiveSpeed: 70, toughness: 0.25 },
        { kind: "outer", pts: [[4, 1], [4, 3]] as [number, number][], width: 0.4, speed: 40 },
        { kind: "travel", pts: [[4, 3], [0, 3]] as [number, number][], speed: 120 },
      ],
    },
  ];
  const bounds = { min: [0, 0, 0], max: [4, 4, 2] };
  const built = buildPreviewGeometry({ layers, ...bounds });
  const wire = buildWirePreview({
    layers: layers.map((layer) => ({ z: layer.z, height: layer.height, paths: encodePaths(layer.paths) })),
    ...bounds,
  });

  expect(built.kinds).toEqual(["outer", "sparse", "travel"]);
  expect(wire.kinds).toEqual(built.kinds);
  let ribbon = 0;
  let face = 0;
  let travel = 0;
  for (const range of built.ranges) {
    expect(range.ribbonStart).toBe(ribbon);
    expect(range.faceStart).toBe(face);
    expect(range.travelStart).toBe(travel);
    ribbon += range.ribbonCount;
    face += range.faceCount;
    travel += range.travelCount;
  }
  expect(ribbon).toBe(built.ribbon.length / 3);
  expect(face).toBe(built.face.length / 3);
  expect(travel).toBe(built.travel.length / 3);
  expect(built.ranges[0].ribbonCount).toBe(24);
  expect(built.ranges[1].ribbonStart).toBe(24);
  expect(built.ranges[1].ribbonCount).toBe(48);
  expect(built.ranges[0].travelCount).toBe(0);
  expect(built.ranges[1].travelCount).toBe(2);
  // Scene Y is nozzle Z, so layer 0 sits under layer 1.
  expect(built.ribbon[1]).toBeCloseTo(0.2, 5);
  expect(built.ribbon[built.ranges[1].ribbonStart * 3 + 1]).toBeCloseTo(1, 5);
  expect(built.ribbonInfo[0]).toBe(0);
  expect(built.ribbonInfo[built.ranges[1].ribbonStart * 3]).toBe(1);
  expect(built.ribbonInfo[(built.ranges[1].ribbonStart + 24) * 3]).toBe(0);
  expect(built.travelInfo[0]).toBe(2);
  expect(floats(wire.ribbon)).toEqual(floats(built.ribbon));
  expect(floats(wire.ribbonInfo)).toEqual(floats(built.ribbonInfo));
  expect(floats(wire.face)).toEqual(floats(built.face));
  expect(floats(wire.faceInfo)).toEqual(floats(built.faceInfo));
  expect(floats(wire.travel)).toEqual(floats(built.travel));
  expect(floats(wire.travelInfo)).toEqual(floats(built.travelInfo));
  expect(wire.ranges).toEqual(built.ranges);
});

function floats(values: ArrayLike<number>) {
  return Array.from(values);
}
