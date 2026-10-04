import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { filamentCost, filamentGrams } from "../src/estimate.ts";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const mm: number = cube.estimate.filamentMm;

test("price and density update the estimate without a slice, a stale mark, or a request", async ({ page }) => {
  const jobs: Record<string, unknown>[] = [];
  const done = JSON.stringify({ id: "1", stage: "emit", done: 1, total: 1, fraction: 1, status: "done" });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
  await page.route("**/api/jobs**", (route) => {
    const url = new URL(route.request().url()).pathname;
    if (/\/api\/jobs\/?$/.test(url)) {
      jobs.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 202, json: { id: "1" } });
    }
    if (url.endsWith("/events")) return route.fulfill({ contentType: "text/event-stream", body: `data: ${done}\n\n` });
    if (url.endsWith("/result")) return route.fulfill({ json: cube });
    return route.fulfill({ contentType: "application/json", body: done });
  });
  await page.goto("/");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#status")).toContainText("loaded");
  await page.locator("#slice").click();
  await expect(page.locator("#export")).toBeEnabled();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.printer).not.toHaveProperty("filamentDensityGCm3");
  expect(jobs[0]!.printer).not.toHaveProperty("filamentCostPerKg");
  const pla = { filamentDiameter: 1.75, filamentDensityGCm3: 1.24, filamentCostPerKg: 20 };
  await expect(page.locator("#estGrams")).toHaveText(`${filamentGrams(mm, pla).toFixed(2)} g`);

  await page.locator("[data-level-choice=advanced]").click();
  await page.locator("#density").fill("1.5");
  await page.locator("#cost").fill("40");
  const petg = { filamentDiameter: 1.75, filamentDensityGCm3: 1.5, filamentCostPerKg: 40 };
  const grams = filamentGrams(mm, petg);
  await expect(page.locator("#estGrams")).toHaveText(`${grams.toFixed(2)} g`);
  await expect(page.locator("#estCost")).toHaveText(filamentCost(grams, petg).toFixed(2));
  await expect(page.locator("#timing")).toContainText(`${grams.toFixed(2)} g`);
  await expect(page.locator("#export")).toBeEnabled();
  await expect(page.locator("#banner")).not.toContainText("Settings changed");
  await expect(page.locator("#slice")).not.toHaveAttribute("data-slice-action", "changed");
  const download = page.waitForEvent("download", { timeout: 10_000 });
  await page.locator("#export").click();
  expect((await download).suggestedFilename()).toMatch(/\.gcode$/);
  await page.waitForTimeout(600);
  expect(jobs, "no request after a price or density edit").toHaveLength(1);
});
