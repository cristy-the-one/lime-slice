import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
}

async function share(page: Page, selector: string) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
  }, selector);
  expect(box, selector).not.toBeNull();
  return canvasShare({ width: box!.width, height: box!.height }, { width: box!.viewW, height: box!.viewH });
}

test("a saved band writes the filament nozzle temperature", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  const cals: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: cube });
  });
  await page.route("**/api/calibrate/temp", async (route) => {
    cals.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      json: {
        gcode: "; TEMP_CALIBRATION\n",
        bands: [
          { index: 0, temp: 190, z0: 0.2, z1: 5 },
          { index: 1, temp: 215, z0: 5.2, z1: 10 },
        ],
        finalE: 12,
        speedMmS: 40,
      },
    });
  });
  await page.goto("/");
  await expect(page.getByText("Mock only")).toHaveCount(0);
  await page.locator("[data-level-choice=expert]").click();
  await page.locator("#tempcal").click();
  await expect.poll(() => cals.length).toBe(1);
  expect(cals[0]).toMatchObject({ start: 190, end: 230, step: 5, bandHeight: 5, speedMmS: 40 });
  await expect(page.locator("#left")).toContainText("band 1: 215 °C");

  await page.locator("#tempchosen").fill("215");
  await page.locator("#tempchosen").blur();
  await page.waitForTimeout(400);
  await page.locator("#tempapply").click();
  await expect(page.locator("#machineTemps")).toHaveText("Nozzle 215 °C · bed 60 °C");

  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toHaveProperty("temperature");
  expect(bodies[0]).not.toHaveProperty("temp");
  expect((bodies[0].printer as { nozzleTemp: number }).nozzleTemp).toBe(215);
});

test("an exported tower carries the printer's start and end G-code", async ({ page }) => {
  await quiet(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
  const tower = [
    "; TEMP_CALIBRATION",
    "M140 S60",
    "M104 S190",
    "M190 S60",
    "M109 S190",
    "G21",
    "G90",
    "M82",
    "G28",
    "G92 E0",
    ";LAYER:0 Z:0.200 H:0.200 temp=190",
    "G1 X20 Y20 E1 F2400",
    "M106 S0",
    "M104 S0",
    "M140 S0",
    "M84",
    "",
  ].join("\n");
  await page.route("**/api/calibrate/temp", (route) =>
    route.fulfill({
      json: { gcode: tower, bands: [{ index: 0, temp: 190, z0: 0.2, z1: 5 }], finalE: 1, speedMmS: 40 },
    }),
  );
  await page.goto("/");
  await page.locator("#machineMore > summary").click();
  await page.locator("#machineStart").fill("G29 ; probe");
  await page.locator("#machineEnd").fill("M300 ; beep");
  await page.locator("#machineEnd").blur();
  await page.locator("[data-level-choice=expert]").click();
  await page.locator("#tempcal").click();
  await expect(page.locator("#tempexport")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.locator("#tempexport").click();
  const text = fs.readFileSync(await (await download).path(), "utf8");
  expect(text).toContain("G28\nG92 E0\nG29 ; probe\n");
  expect(text).toContain("M300 ; beep\nM106 S0\nM104 S0\nM140 S0\n");
});

test.describe("temperature stays in the sheet", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a temperature group keeps the prepare canvas", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    const shareOf = await share(page, "#prepare");
    expect(shareOf, `prepare share ${shareOf}`).toBeGreaterThanOrEqual(0.7);
  });
});
