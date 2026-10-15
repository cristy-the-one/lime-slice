import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { setSupports } from "./supports";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

type Printer = { fanPercent?: number; overhangFanPercent?: number; fanOffLayers?: number; supportFanPercent?: number; nozzleTemp?: number };
type SliceBody = { printer: Printer };

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

async function open(page: Page) {
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
}

/** Slice and return the fan the request's printer carries. */
async function sentFan(page: Page, bodies: SliceBody[]) {
  const start = bodies.length;
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBeGreaterThan(start);
  await expect(page.locator("#slice")).toBeEnabled();
  const { fanPercent, overhangFanPercent, fanOffLayers, supportFanPercent } = bodies.at(-1)!.printer;
  return { fanPercent, overhangFanPercent, fanOffLayers, supportFanPercent };
}

/** The filament picker sits in the printer chip, as a person reaches it. */
async function chooseFilament(page: Page, id: string) {
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machineFilament").selectOption(id);
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
}

async function fields(page: Page) {
  return {
    fan: await page.locator("#fanpct").inputValue(),
    overhang: await page.locator("#ovfanpct").inputValue(),
    off: await page.locator("#fanoff").inputValue(),
  };
}

test("the Cooling fields show the filament's fan, choosing PETG sets IdeaFormer's, and an edit stays with the filament", async ({ page }) => {
  const bodies = await quiet(page);
  await open(page);
  await expect(page.locator('.group[data-group="cooling"]')).toBeVisible();
  expect(await fields(page)).toEqual({ fan: "100", overhang: "100", off: "1" });
  expect(await sentFan(page, bodies)).toEqual({ fanPercent: 100, overhangFanPercent: 100, fanOffLayers: 1, supportFanPercent: undefined });

  await chooseFilament(page, "lime-petg");
  expect(await fields(page)).toEqual({ fan: "20", overhang: "100", off: "3" });
  expect(await sentFan(page, bodies)).toEqual({ fanPercent: 20, overhangFanPercent: 100, fanOffLayers: 3, supportFanPercent: undefined });

  // A per-print change, like a temperature change, is kept on the filament.
  await page.locator("#fanpct").fill("35");
  await page.locator("#fanoff").fill("2");
  expect(await sentFan(page, bodies)).toEqual({ fanPercent: 35, overhangFanPercent: 100, fanOffLayers: 2, supportFanPercent: undefined });
  await chooseFilament(page, "lime-pla");
  expect(await fields(page)).toEqual({ fan: "100", overhang: "100", off: "1" });
  await chooseFilament(page, "lime-petg");
  expect(await fields(page)).toEqual({ fan: "35", overhang: "100", off: "2" });

  // The Speed ↔ Toughness weight does not touch the fan.
  await page.locator('[data-card="efficiency"]').click();
  await page.locator("#weight").fill("90");
  await page.locator("#weight").dispatchEvent("change");
  expect((await sentFan(page, bodies)).fanPercent).toBe(35);
});

test("Support fan % follows Fan % until set, an edit is one undo step, and the overhang fan hides with overhang control", async ({ page }) => {
  const bodies = await quiet(page);
  await open(page);
  await chooseFilament(page, "lime-petg");
  await expect(page.locator("#supfanpct")).toHaveCount(0);
  await setSupports(page, "auto");
  await expect(page.locator("#supfanpct")).toHaveValue("");
  await expect(page.locator("#supfanpct")).toHaveAttribute("placeholder", "20");

  await page.locator("#supfanpct").fill("10");
  expect((await sentFan(page, bodies)).supportFanPercent).toBe(10);
  await page.locator("#supfanpct").fill("");
  expect(await sentFan(page, bodies)).toEqual({ fanPercent: 20, overhangFanPercent: 100, fanOffLayers: 3, supportFanPercent: undefined });

  await page.locator("#fanpct").fill("45");
  await expect(page.locator("#supfanpct")).toHaveAttribute("placeholder", "45");
  await page.locator("#fanpct").blur();
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+z");
  await expect(page.locator("#fanpct")).toHaveValue("20");
  expect((await sentFan(page, bodies)).fanPercent).toBe(20);

  await page.locator("#overhang").click();
  await expect(page.locator("#ovfanpct")).toHaveCount(0);
});
