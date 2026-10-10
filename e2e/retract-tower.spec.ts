import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";
import { autoSliceOff } from "./auto-slice";

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

test("custom retraction is omitted until it is set", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  const cals: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: cube });
  });
  await page.route("**/api/calibrate/retract", async (route) => {
    cals.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      json: {
        gcode: "; RETRACT_CALIBRATION\n",
        bands: [
          { index: 0, length: 0.4, z0: 0.2, z1: 5 },
          { index: 1, length: 0.8, z0: 5.2, z1: 10 },
        ],
        finalE: 12,
        speedMmS: 30,
      },
    });
  });
  await page.goto("/");
  await autoSliceOff(page);
  await expect(page.getByText("Mock only")).toHaveCount(0);
  await page.locator("#levelPick").selectOption("expert");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toHaveProperty("retractLength");
  expect(bodies[0]).not.toHaveProperty("retractSpeed");

  await page.locator("#retractset").check();
  await page.locator("#retractlen").fill("1.2");
  await page.locator("#retractlen").blur();
  await page.waitForTimeout(400);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].retractLength).toBe(1.2);
  expect(bodies[1]).not.toHaveProperty("retractSpeed");

  await page.locator("#fileMenu > summary").click();
  await page.locator("#calibrateOpen").click();
  await page.locator("#retractcal").click();
  await expect.poll(() => cals.length).toBe(1);
  expect(cals[0]).toMatchObject({ start: 0.2, end: 1.2, step: 0.2, speedMmS: 30 });
  await expect(page.locator("#calibrate")).toContainText("band 1: 0.800 mm");
  await page.locator("#retractchosen").fill("0.8");
  await page.locator("#retractchosen").blur();
  await page.waitForTimeout(400);
  await page.locator("#retractapply").click();
  await page.locator("#calibrateClose").click();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2].retractLength).toBe(0.8);
});

test.describe("retraction stays in the sheet", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a retraction group keeps the prepare canvas", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    const shareOf = await share(page, "#prepare");
    expect(shareOf, `prepare share ${shareOf}`).toBeGreaterThanOrEqual(0.7);
  });
});
