import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { scrubTravel } from "../src/ui/scrub.ts";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

type SliceBody = { printer: { nozzleTemp: number; bedTemp: number } };

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: SliceBody[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: cube });
  });
  return bodies;
}

async function choose(page: Page, printerId: string, filamentId: string) {
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machinePrinter").selectOption(printerId);
  await page.locator("#machineFilament").selectOption(filamentId);
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
}

async function sent(page: Page, bodies: SliceBody[]) {
  const start = bodies.length;
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBeGreaterThan(start);
  await expect(page.locator("#slice")).toBeEnabled();
  const printer = bodies.at(-1)!.printer;
  return { nozzle: printer.nozzleTemp, bed: printer.bedTemp };
}

test("nozzle and bed follow the filament, clamp only at the printer limit, and can be typed, scrubbed, and found", async ({ page }) => {
  const bodies = await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();

  await expect(page.locator("#nozzlec")).toHaveValue("200");
  await expect(page.locator("#bedc")).toHaveValue("60");
  await expect(page.locator("#machineTemps")).toHaveText("Nozzle 200 °C · bed 60 °C");
  await expect(page.locator("label:has(#nozzlec) [data-scrub=field]")).toHaveText("Nozzle °C");
  await expect(page.locator("label:has(#bedc) [data-scrub=field]")).toHaveText("Bed °C");

  await page.locator("#levelPick").selectOption("simple");
  await expect(page.locator("#nozzlec")).toBeVisible();
  await expect(page.locator("#bedc")).toBeVisible();
  await expect(page.locator("#machineMaxNozzle")).toBeHidden();
  await page.locator("#levelPick").selectOption("expert");

  const find = page.locator("#find");
  await find.fill("temperature");
  await expect(page.locator("#nozzlec")).toBeVisible();
  await expect(page.locator("#bedc")).toBeVisible();
  await find.fill("hotend");
  await expect(page.locator("#nozzlec")).toBeVisible();
  await expect(page.locator("#bedc")).toBeHidden();
  await find.fill("nozzle");
  await expect(page.locator("#nozzlec")).toBeVisible();
  await find.fill("bed");
  await expect(page.locator("#bedc")).toBeVisible();
  await find.fill("");

  await choose(page, "ideaformer-ir3-v2", "lime-petg");
  await expect(page.locator("#nozzlec")).toHaveValue("240");
  await expect(page.locator("#bedc")).toHaveValue("80");
  await expect(page.locator("#machineTemps")).toHaveText("Nozzle 240 °C · bed 80 °C");
  await expect(page.locator("#machineHeatNote")).toBeHidden();
  expect(await sent(page, bodies)).toEqual({ nozzle: 240, bed: 80 });

  await page.locator("#bedc").fill("75");
  await page.locator("#bedc").blur();
  await expect(page.locator("#bedc")).toHaveValue("75");
  expect(await sent(page, bodies)).toEqual({ nozzle: 240, bed: 75 });
  await choose(page, "ideaformer-ir3-v2", "lime-pla");
  await expect(page.locator("#bedc")).toHaveValue("60");
  await choose(page, "ideaformer-ir3-v2", "lime-petg");
  await expect(page.locator("#nozzlec")).toHaveValue("240");
  await expect(page.locator("#bedc")).toHaveValue("75");

  await choose(page, "ideaformer-ir3-v2", "lime-abs");
  await expect(page.locator("#nozzlec")).toHaveValue("250");
  await expect(page.locator("#bedc")).toHaveValue("90");
  await expect(page.locator("#machineTemps")).toHaveText("Nozzle 250 °C · bed 90 °C");
  await expect(page.locator("#machineHeatNote")).toHaveText("Bed set to 90 °C: ABS asks for 100 °C, but this printer's limit is 90 °C. Change the limit in Edit printer.");
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await expect(page.locator("#printerHeatNote")).toHaveText("Bed set to 90 °C: ABS asks for 100 °C, but this printer's limit is 90 °C. Change the limit in Edit printer.");
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  expect(await sent(page, bodies)).toEqual({ nozzle: 250, bed: 90 });

  await choose(page, "lime-220", "lime-abs");
  await expect(page.locator("#nozzlec")).toHaveValue("250");
  await expect(page.locator("#bedc")).toHaveValue("100");
  await expect(page.locator("#machineTemps")).toHaveText("Nozzle 250 °C · bed 100 °C");
  await expect(page.locator("#machineHeatNote")).toBeHidden();
  expect(await sent(page, bodies)).toEqual({ nozzle: 250, bed: 100 });

  const label = page.locator("label:has(#nozzlec) [data-scrub=field]");
  await label.scrollIntoViewIfNeeded();
  const box = (await label.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + scrubTravel(3), y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.locator("#nozzlec").inputValue().then(Number)).toBe(253);
});
