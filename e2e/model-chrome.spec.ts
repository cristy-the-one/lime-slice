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

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test("model tool panels stay clear of the size chip, the measure control, and rail tips", async ({ page }) => {
  await openModel(page);
  const fit = page.locator("#modelFit");
  const measure = page.locator("#measureField");
  const tools = page.locator("#modelBar .model-tools");
  const rail = page.locator("#toolRail");
  const measureBox = await measure.boundingBox();
  const toolsBox = await tools.boundingBox();
  const railBox = await rail.boundingBox();
  expect(measureBox && toolsBox && railBox).toBeTruthy();
  expect(overlaps(measureBox!, toolsBox!)).toBe(false);
  expect(overlaps(measureBox!, railBox!)).toBe(false);
  expect(measureBox!.x).toBeGreaterThan(toolsBox!.x);

  await page.locator("#modelToolBoolean").click();
  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(page.locator("#modelPrim")).toBeVisible();
  const panel = page.locator("#modelPanel");
  const prim = page.locator("#modelPrim");
  expect(overlaps((await fit.boundingBox())!, (await panel.boundingBox())!)).toBe(false);
  expect(overlaps((await fit.boundingBox())!, (await prim.boundingBox())!)).toBe(false);
  if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/after-boolean-panel.png` });

  await page.locator("#modelToolFillet").evaluate((button) => button.removeAttribute("disabled"));
  await page.locator("#modelToolFillet").click();
  await expect(page.locator("#modelBlend")).toBeVisible();
  expect(overlaps((await fit.boundingBox())!, (await page.locator("#modelBlend").boundingBox())!)).toBe(false);
  if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/after-fillet-panel.png` });
  await page.locator('#toolRail [data-tool="scale"]').hover();
  const tip = page.locator(".lime-tip");
  await expect(tip).toBeVisible();
  expect(overlaps((await tip.boundingBox())!, (await panel.boundingBox())!)).toBe(false);
  if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/after-rail-tip.png` });
});
