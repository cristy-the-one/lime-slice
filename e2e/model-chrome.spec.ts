import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

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
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const pa = corners[a!]!;
    const pb = corners[b!]!;
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  return { id: 1, volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges };
}

async function openModel(page: Page) {
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await page.route("**/api/model/probe", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/model", (route) => route.fulfill({ json: solid }));
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
}

test("model mode shows the bed, the outer size, and measure callouts", async ({ page }) => {
  await openModel(page);
  await expect(page.locator("#model")).toHaveAttribute("data-bed", "220x220x250");
  await expect(page.locator("#measureField")).toBeVisible();
  const fit = page.locator("#modelFit");
  await expect(fit).toHaveText("20.0 × 20.0 × 10.0 mm");
  await expect(fit).toHaveAttribute("data-over", "0");
  await expect(page.locator("#modelBody .measure")).toContainText("20.0 mm");
  await expect(page.locator("#modelBody .measure")).toContainText("10.0 mm");

  await page.locator("#modelToolScale").click();
  await expect(fit).toHaveText("40.0 × 40.0 × 20.0 mm");

  await page.locator("#measureOn").uncheck();
  await expect(page.locator("#modelBody .measure svg")).toHaveCount(0);
  await expect(fit).toHaveText("40.0 × 40.0 × 20.0 mm");
});
