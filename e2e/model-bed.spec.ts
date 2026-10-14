import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

type V = [number, number, number];

/** A box the modeler reports as a solid, in its own CAD frame. */
function boxSolid(min: V, size: V) {
  const [ox, oy, oz] = min;
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [ox + x * sx, oy + y * sy, oz + z * sz];
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
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const pa = corners[a!]!;
    const pb = corners[b!]!;
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges };
}

async function openModel(page: Page, solid: ReturnType<typeof boxSolid>) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
}

test("model mode centres the edit base under an origin-centred plate", async ({ page }) => {
  const plate = boxSolid([-110, -110, 0], [220, 220, 5.1]);
  await openModel(page, plate);
  await expect(page.locator("#model")).toHaveAttribute("data-bed", "220x220x250");
  await expect(page.locator("#model")).toHaveAttribute("data-bed-origin", "-110.0,-110.0,0.0");
  await expect(page.locator("#modelFit")).toHaveText("220.0 × 220.0 × 5.1 mm");
  const numbers = (await page.locator("#modelBody .measure .m-bed").allTextContents()).map(Number);
  expect(numbers.length).toBeGreaterThan(0);
  expect(numbers.every((value) => value > 0 && value % 50 === 0)).toBe(true);
  if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/after-bed-centered.png` });
});

test("model mode centres a corner box without moving its CAD frame", async ({ page }) => {
  await openModel(page, boxSolid([0, 0, 0], [20, 20, 10]));
  await expect(page.locator("#model")).toHaveAttribute("data-bed-origin", "-100.0,-100.0,0.0");
  await expect(page.locator("#modelBody .measure")).toContainText("20.0 mm");
});
