import { expect, test } from "@playwright/test";
import { buildPreviewGeometry, INNER_HALF_SCALE, scenePoint } from "../src/preview-geom";

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
    hidden: [],
    showTravel: false,
    colorMode: "feature",
  });
  expect(built.ribbon.length / 3).toBe(12);
  expect(built.face.length / 3).toBe(12);
  const margin = built.ribbonColor.slice(0, 3);
  const face = built.faceColor.slice(0, 3);
  expect(face[0]).toBeGreaterThan(margin[0] + 0.2);
  expect(face[1]).toBeGreaterThan(margin[1] + 0.2);
  const half = 0.225;
  const outerHalf = Math.abs(built.ribbon[2 * 3 + 2]);
  const innerHalf = Math.abs(built.face[2 * 3 + 2]);
  expect(outerHalf).toBeCloseTo(half, 5);
  expect(innerHalf).toBeCloseTo(half * INNER_HALF_SCALE, 5);
  expect(innerHalf).toBeLessThan(outerHalf);
  expect(built.ranges[0].ribbonCount).toBe(12);
  expect(built.ranges[0].faceCount).toBe(12);
});

test("speed and blend-weight beads keep the same margin inset", () => {
  for (const colorMode of ["speed", "weight"] as const) {
    const built = buildPreviewGeometry({
      layers: [{ z: 1, paths: [{ kind: "sparse", pts: [[0, 0], [4, 0]], width: 0.4, speed: 80, effectiveSpeed: 80, toughness: 0.4 }] }],
      min: [0, -1, 0],
      max: [4, 1, 2],
      hidden: [],
      showTravel: false,
      colorMode,
    });
    const margin = built.ribbonColor[0];
    const face = built.faceColor[0];
    expect(face).toBeGreaterThan(margin + 0.15);
    expect(Math.abs(built.face[2])).toBeLessThan(Math.abs(built.ribbon[2]));
  }
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
