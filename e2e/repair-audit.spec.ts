import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
}

test("the sheet shows repaired layers and dropped chains from the slice", async ({ page }) => {
  await quiet(page);
  let n = 0;
  await page.route("**/api/slice", (route) => {
    n += 1;
    const body = structuredClone(cube);
    if (n > 1) {
      body.mesh.repairedLayers = 4;
      body.mesh.droppedChains = 2;
    }
    return route.fulfill({ json: body });
  });
  await page.goto("/");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await expect(page.locator("#leftBody")).not.toContainText("Repaired layers");

  await page.locator("#slice").click();
  // The fixture reply has no counts: unknown, not zero.
  await expect(page.locator("#leftBody")).toContainText("Repaired layers — · dropped chains —");

  await page.locator("#slice").click();
  await expect(page.locator("#leftBody")).toContainText("Repaired layers 4 · dropped chains 2");
});

test.describe("compact repair line", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the prepare canvas stays at least 70% with the repair line in the sheet", async ({ page }) => {
    await quiet(page);
    await page.route("**/api/slice", (route) => {
      const body = structuredClone(cube);
      body.mesh.repairedLayers = 1;
      body.mesh.droppedChains = 0;
      return route.fulfill({ json: body });
    });
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.locator("#compactTabs [data-tab=settings]").click();
    await page.locator("#slice").click();
    await expect(page.locator("#leftBody")).toContainText("Repaired layers 1 · dropped chains 0");
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    const box = await page.evaluate(() => {
      const rect = document.querySelector("#prepare")!.getBoundingClientRect();
      return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
    });
    const share = canvasShare({ width: box.width, height: box.height }, { width: box.viewW, height: box.viewH });
    expect(share, `prepare viewport share ${share}`).toBeGreaterThanOrEqual(0.7);
  });
});
