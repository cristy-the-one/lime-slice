/**
 * Several files in one pick. File > Open replaces the plate with the first file and adds the rest. Add to plate (the
 * File menu, Ctrl+Shift+O, the object toolbar's +) adds every file, and on an empty plate works like Open.
 * STL samples stand in for STEP: both pickers send every format through the same Add, and step-solids covers STEP reads.
 */
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { acceptSheets, askSheet } from "./ask-sheet";
import { autoSliceOff } from "./auto-slice";

const CUBE = "samples/calibration_cube_20mm.stl";
const LEDGE = "samples/overhang_ledge.stl";
const RAMP = "samples/slope_ramp.stl";

async function start(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
}

const objects = (page: Page) => page.locator("[data-plate-id]");
const named = (page: Page, name: string) => objects(page).filter({ hasText: name });

test("both pickers take several files", async ({ page }) => {
  await start(page);
  await expect(page.locator("#file")).toHaveAttribute("multiple", "");
  await expect(page.locator("#plateAddFile")).toHaveAttribute("multiple", "");
});

test("Open with several files puts the first on the plate and adds the rest", async ({ page }) => {
  await start(page);
  await page.locator("#file").setInputFiles([CUBE, LEDGE, RAMP]);
  await expect(objects(page)).toHaveCount(3);
  await expect(named(page, "overhang_ledge.stl")).toHaveCount(1);
  await expect(named(page, "slope_ramp.stl")).toHaveCount(1);
  // Each add is its own undo step; the replace is not undone by them.
  await page.locator("#prepare").click();
  await page.keyboard.press("Control+z");
  await expect(objects(page)).toHaveCount(2);
  await expect(named(page, "slope_ramp.stl")).toHaveCount(0);
});

test("Open with several files replaces what was on the plate", async ({ page }) => {
  await start(page);
  // Open asks before it discards the loaded plate; the adds wait for that answer.
  await acceptSheets(page);
  await page.locator("#file").setInputFiles(CUBE);
  await expect(objects(page)).toHaveCount(1);
  await page.locator("#file").setInputFiles([LEDGE, RAMP]);
  await expect(objects(page)).toHaveCount(2);
  await expect(named(page, "overhang_ledge.stl")).toHaveCount(1);
  await expect(named(page, "slope_ramp.stl")).toHaveCount(1);
});

test("Cancel at Open's unsaved-changes question adds nothing", async ({ page }) => {
  await start(page);
  await page.locator("#file").setInputFiles(CUBE);
  await expect(objects(page)).toHaveCount(1);
  await page.locator("#file").setInputFiles([LEDGE, RAMP]);
  const sheet = askSheet(page);
  await expect(sheet).toBeVisible();
  await sheet.locator('[data-ask="cancel"]').click();
  await expect(sheet).toBeHidden();
  await expect(objects(page)).toHaveCount(1);
  await expect(named(page, "calibration_cube_20mm.stl")).toHaveCount(1);
});

test("File > Add to plate adds several files beside the part already there", async ({ page }) => {
  await start(page);
  await page.locator("#file").setInputFiles(CUBE);
  await expect(objects(page)).toHaveCount(1);
  await page.locator("#fileMenu > summary").click();
  const entry = page.locator("#fileMenu [data-file-action='add']");
  await expect(entry).toHaveText("Add to plate…");
  const chooser = page.waitForEvent("filechooser");
  await entry.click();
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(true);
  await picker.setFiles([LEDGE, RAMP]);
  await expect(objects(page)).toHaveCount(3);
  await expect(named(page, "overhang_ledge.stl")).toHaveCount(1);
  await expect(named(page, "slope_ramp.stl")).toHaveCount(1);
});

test("Add to plate on an empty plate works like Open", async ({ page }) => {
  await start(page);
  await expect(objects(page)).toHaveCount(0);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("body").press("Control+Shift+O");
  await (await chooser).setFiles([LEDGE, CUBE]);
  await expect(objects(page)).toHaveCount(2);
  await expect(named(page, "overhang_ledge.stl")).toHaveCount(1);
});

test("Add to plate skips a project file and says so", async ({ page }) => {
  await start(page);
  await page.locator("#file").setInputFiles(CUBE);
  await expect(objects(page)).toHaveCount(1);
  await page.locator("#plateAddFile").setInputFiles([
    { name: "job.lime", mimeType: "application/json", buffer: Buffer.from("{}") },
    { name: "overhang_ledge.stl", mimeType: "model/stl", buffer: fs.readFileSync(LEDGE) },
  ]);
  await expect(objects(page)).toHaveCount(2);
  await expect(page.getByText("job.lime is a project: open it from the File menu.")).toBeVisible();
});
