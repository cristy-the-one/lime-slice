import { expect, test } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body } from "./model-tree-mock";

type V = [number, number, number];

function boxSolid(size: V) {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [x * sx, y * sy, z * sz];
  const quads: V[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((q, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, face) => ({ id: face, areaMm2: 0 })), edges: [] };
}

test("dragging a NURBS pole moves its mirror and commits the same grid", async ({ page }) => {
  const opens: Body[] = [];
  const solid = boxSolid([20, 20, 10]);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, {
    open(request) {
      opens.push(request);
      return solid;
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelFeatureMenu [data-tool=sculpt]").click();
  const axis = page.locator("#modelNurbsOverlay [data-cv-axis=x]");
  await expect(axis).toBeVisible();
  await page.locator("#modelNurbsSymmetry").check();
  const before = await page.locator("#model").getAttribute("data-nurbs-pole");
  const box = await axis.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y - 48);
  await page.mouse.up();
  await expect.poll(async () => page.locator("#model").getAttribute("data-nurbs-pole")).not.toBe(before);
  const pole = (await page.locator("#model").getAttribute("data-nurbs-pole"))!.split(",").map(Number);
  const mirror = (await page.locator("#model").getAttribute("data-nurbs-mirror"))!.split(",").map(Number);
  expect(Math.abs(pole[0]! + mirror[0]!)).toBeLessThan(1e-6);
  expect(Math.abs(pole[1]! - mirror[1]!)).toBeLessThan(1e-6);
  expect(Math.abs(pole[2]! - mirror[2]!)).toBeLessThan(1e-6);
  await expect.poll(() => opens.some((request) => (request.feature as { kind?: string } | undefined)?.kind === "nurbsSurface")).toBe(true);
  const feature = opens.find((request) => (request.feature as { kind?: string } | undefined)?.kind === "nurbsSurface")!.feature as {
    poles: number[][][];
    degreeU: number;
  };
  expect(feature.degreeU).toBe(3);
  expect(feature.poles).toHaveLength(8);
  expect(feature.poles[0]).toHaveLength(8);
  const sent = feature.poles[1]![1]!;
  const sentMirror = feature.poles[6]![1]!;
  expect(Math.abs(sent[0]! + sentMirror[0]!)).toBeLessThan(1e-6);
});
