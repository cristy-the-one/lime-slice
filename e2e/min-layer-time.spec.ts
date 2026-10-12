import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
// The engine's reply when it slowed the second layer to reach the minimum layer time.
const cooled = { ...cube, layers: cube.layers.map((layer: Record<string, unknown>, i: number) => (i === 1 ? { ...layer, slow: 0.4, seconds: 8 } : layer)) };

async function quiet(page: Page, reply: unknown = cube) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: reply });
  });
  return bodies;
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
}

test("the minimum layer time sits in Speed & travel, is always sent, and stales a slice", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await loadCube(page);

  const group = page.locator('#left .group[data-group="speed"]');
  await expect(group.locator("#minlayer")).toHaveValue("8");
  await expect(group.locator("#minlayerspd")).toBeHidden();
  await expect(group.locator('[data-tip*="plastic can cool"]')).toHaveCount(1);
  await page.locator("#levelPick").selectOption("expert");
  await expect(group.locator("#minlayerspd")).toBeVisible();
  await expect(group.locator("#minlayerspd")).toHaveValue("15");

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect(page.locator("#slice")).toBeEnabled();
  expect(bodies[0]).toMatchObject({ minLayerTimeS: 8, minLayerSpeedMmS: 15 });
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);

  await page.locator("#minlayer").fill("12");
  await page.locator("#minlayer").blur();
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({ minLayerTimeS: 12, minLayerSpeedMmS: 15 });

  await page.locator("#minlayerspd").fill("20");
  await page.locator("#minlayerspd").blur();
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]).toMatchObject({ minLayerTimeS: 12, minLayerSpeedMmS: 20 });

  // Off hides the speed it would have floored, and is sent as 0.
  await page.locator("#minlayer").fill("0");
  await page.locator("#minlayer").blur();
  await expect(group.locator("#minlayerspd")).toHaveCount(0);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(4);
  expect(bodies[3]).toMatchObject({ minLayerTimeS: 0 });
});

test("the active layer says when it was slowed for cooling, in a row that fits", async ({ page }) => {
  const bodies = await quiet(page, cooled);
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect(page.locator("#slice")).toBeEnabled();

  const readout = page.locator("#layerReadout");
  const goTo = async (layer: number) =>
    page.locator("#rangeHigh").evaluate((el: HTMLInputElement, n) => {
      el.value = String(n);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, layer);
  await goTo(1);
  await expect(readout).toContainText("Layer time 8.0 s");
  await expect(readout).toContainText("Cooling slowed ×0.40");
  // Every value stays inside the narrowest results panel (as fit.spec.ts sets it) instead of running past its edge.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".workspace")!.style.setProperty("--panel-right", "240px");
    window.dispatchEvent(new Event("resize"));
  });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const clipped = await readout.locator("dd").evaluateAll((cells) => cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length);
  expect(clipped).toBe(0);
  await goTo(2);
  await expect(readout).toContainText("Layer time");
  await expect(readout).not.toContainText("Cooling");
});
