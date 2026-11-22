import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 × 20 × 10 mm box, as the modeler reports a solid. */
function boxSolid() {
  const [sx, sy, sz] = [20, 20, 10];
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
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] as { id: number; lengthMm: number; points: number[] }[] };
}

async function openSketch(page: Page) {
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch", "editing");
}

test("the spline tool defaults to control-point NURBS and can switch to through-points and a curvature comb", async ({ page }) => {
  await openSketch(page);
  await page.locator("[data-sketch-tool=spline]").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch-current-tool", "spline");
  const cv = page.locator("[data-sketch-spline-mode=cv]");
  const through = page.locator("[data-sketch-spline-mode=through]");
  await expect(cv).toHaveAttribute("aria-pressed", "true");
  await expect(through).toHaveAttribute("aria-pressed", "false");
  await through.click();
  await expect(through).toHaveAttribute("aria-pressed", "true");
  await expect(cv).toHaveAttribute("aria-pressed", "false");
  const comb = page.locator("[data-sketch-comb]");
  await expect(comb).toHaveAttribute("aria-pressed", "false");
  await comb.click();
  await expect(comb).toHaveAttribute("aria-pressed", "true");
});
