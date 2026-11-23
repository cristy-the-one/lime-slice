import { expect, test } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";
import { encodeSolid } from "../src/model-reply";

/**
 * Organic fix round S6: the view asks for the kernel's display mesh, and the plate never takes it. The stand-in engine
 * answers a display request with a box 14 tall and a plate request with the same step 12 tall (the default mesh): the
 * view shows the first, and after a step the plate row reads the second.
 */
type V = [number, number, number];

function box(sz: number): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * sz];
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
  return { volumeMm3: 400 * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

test("the view shows the display mesh; the plate takes the default one", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: box(10).positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => box(10),
    // The step built: the display reply's box is 14 tall, the plate reply's 12.
    // The display mesh carries normals, as the kernel's does.
    apply: (request: Body) => (request.meshQuality === "display" ? { ...box(14), normals: box(14).positions.map((_, i) => (i % 3 === 2 ? 1 : 0)) } : box(12)),
    probe: () => ({ ok: true }),
    goto: (request: Body) => {
      if (request.meshQuality === "display" || Number(request.node) === 0) return null;
      const solid = box(12);
      return { id: Number(request.node), ...encodeSolid(solid), fingerprint: { volumeMm3: solid.volumeMm3, faces: 6, edges: 0 } };
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  expect(tree.of("open").every((request) => request.meshQuality === "display"), "the view's open asks for the display mesh").toBe(true);
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelCut").click();
  await page.locator("#modelDx").fill("8");
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout"), "the view shows the display reply").toContainText("Volume 5600 mm³");
  expect(tree.of("apply").at(-1)?.meshQuality).toBe("display");
  // Leaving Model commits: the plate's mesh is asked for again, without the field.
  await page.locator("#tabPrepare").click();
  await expect.poll(() => tree.of("goto").some((request) => request.meshQuality === undefined && Number(request.node) === 1), { message: "the plate's mesh is asked for without the field" }).toBe(true);
  await expect(page.locator("#objectList .obj").first(), "the plate holds the default mesh").toContainText("20 × 20 × 12");
});
