import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function sliceWith(page: Page, velocityCap: unknown) {
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-closed-groups", "[]");
    localStorage.setItem("lime-slice-theme", "dark");
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) =>
    route.fulfill({ json: { ...cube, estimate: { ...cube.estimate, ...(velocityCap ? { velocityCap } : {}) } } }),
  );
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#slice").click();
  await page.locator("#timing").click();
  await expect(page.locator("#summaryCard #estimate .big")).toBeVisible();
}

test("a Max velocity below the slice's feeds says why the time is long", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await sliceWith(page, { maxVelocityMmS: 40, fastestFeedMmS: 300, cappedShare: 0.968 });
  const warn = page.locator("#summaryCard #velocityCapWarn");
  await expect(warn).toHaveText(
    "Max velocity 40 mm/s holds 97% of the path below the feeds this slice writes (up to 300 mm/s), and the time assumes it. Match it to printer.cfg's max_velocity in Printer details if the printer is faster.",
  );
  const shots = process.env.LIME_SHOTS;
  if (shots) await page.locator("#summaryCard").screenshot({ path: path.join(shots, "velocity-cap-warning.png") });
});

test("a slice the printer's Max velocity does not hold back shows no warning", async ({ page }) => {
  await sliceWith(page, null);
  await expect(page.locator("#velocityCapWarn")).toHaveCount(0);
});
