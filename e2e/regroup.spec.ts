import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_PRESET } from "../src/presets.ts";

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
}

test("a collapsed group stays collapsed across a reload and its header still shows the value", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  const quality = page.locator('#left .group[data-group="quality"]');
  await expect(quality).toHaveAttribute("open");
  await expect(quality.locator(".group-sum")).toHaveText("0.20 mm");
  await page.locator("#lh").fill("0.28");
  await expect(quality.locator(".group-sum")).toHaveText("0.28 mm");
  await quality.locator("summary").click();
  await expect(quality).not.toHaveAttribute("open");
  await expect(quality.locator(".group-sum")).toBeVisible();
  await page.reload();
  await expect(page.locator('#left .group[data-group="quality"]')).not.toHaveAttribute("open");
  await expect(page.locator('#left .group[data-group="printer"]')).not.toHaveAttribute("open");
  await expect(page.locator('#left .group[data-group="walls"]')).toHaveAttribute("open");
});

test("the printer chip switches the printer, and Edit printer opens the Printer details group", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await expect(page.locator("#printerChipLabel")).toHaveText("Lime 220 · PLA · 0.4 mm");
  await expect(page.locator("#left #machinePrinter")).toHaveCount(0);
  await page.locator("#printerChip > summary").click();
  await page.locator("#machinePrinter").selectOption({ label: "Lime 300" });
  await page.locator("#machineNozzle").selectOption("0.6");
  await expect(page.locator("#printerChipLabel")).toHaveText("Lime 300 · PLA · 0.6 mm");
  await expect(page.locator("#bedx")).toHaveValue("300");
  await page.locator("#levelPick").selectOption("simple");
  await expect(page.locator('#left .group[data-group="printer"]')).toBeHidden();
  await page.locator("#editPrinter").click();
  await expect(page.locator("#levelPick")).toHaveValue("advanced");
  await expect(page.locator('#left .group[data-group="printer"]')).toHaveAttribute("open");
  await expect(page.locator("#bedx")).toBeVisible();
});

test("strategy rows pick the strategy from the left panel", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await expect(page.locator('#left [data-card="speed"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('#left [data-card="layer"]').click();
  await expect(page.locator('#left [data-card="layer"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#bottom")).toBeVisible();
  await expect(page.locator('#left .group[data-group="strategy"] .group-sum')).toHaveText("By layer");
  await page.locator('#left [data-card="efficiency"]').click();
  await expect(page.locator("#weight")).toBeVisible();
  await expect(page.locator("#bottom")).toHaveCount(0);
  await expect(page.locator("#right [data-card]")).toHaveCount(0);
});

test("saved presets become settings profiles once", async ({ page }) => {
  await quiet(page);
  await page.addInitScript((preset) => {
    localStorage.setItem("lime-slice-presets", JSON.stringify({ "Bench speed": { ...preset, layerHeight: 0.32 } }));
  }, DEFAULT_PRESET);
  await page.goto("/");
  await expect(page.locator("#profilePick option", { hasText: "Bench speed" })).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("lime-slice-presets"))).toBeNull();
  await page.locator("#profilePick").selectOption({ label: "Bench speed" });
  await expect(page.locator("#lh")).toHaveValue("0.32");
  await expect(page.locator("#presetPick")).toHaveCount(0);
});

test("the Calibrate sheet opens from the File menu and closes on Escape", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await expect(page.locator("#calibrate")).toBeHidden();
  await expect(page.locator("#left #pacal")).toHaveCount(0);
  await page.locator("#fileMenu > summary").click();
  await page.locator("#calibrateOpen").click();
  await expect(page.locator("#calibrate")).toBeVisible();
  await expect(page.locator("#calibrate #pacal")).toBeVisible();
  await expect(page.locator("#calibrate #retractcal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#calibrate")).toBeHidden();
});

test("no setting appears twice, and a tier hides the groups with nothing to show", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await loadCube(page);
  const ids = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#left input[id], #left select[id], .top input[id], .top select[id], #calibrate input[id]")].map((el) => el.id));
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  expect(dupes).toEqual([]);
  await expect(page.locator("#objectList")).toHaveCount(1);
  await expect(page.locator("#left").getByText("calibration_cube_20mm.stl")).toHaveCount(1);
  await page.locator("#levelPick").selectOption("simple");
  await expect(page.locator('#left .group[data-group="infill"]')).toBeHidden();
  await expect(page.locator('#left .group[data-group="printer"]')).toBeHidden();
  await expect(page.locator("#adaptive")).toBeHidden();
  await page.locator("#find").fill("adaptive");
  await expect(page.locator("#adaptive")).toBeVisible();
  await page.locator("#find").fill("");
  await page.locator("#levelPick").selectOption("expert");
  await expect(page.locator('#left .group[data-group="infill"]')).toBeVisible();
});

test("a tooltip leaves on a press and does not cover the popover it opened", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  const tip = page.locator(".lime-tip[data-open=true]");
  await page.locator("#printerChip > summary").hover();
  await expect(tip).toBeVisible();
  await page.locator("#printerChip > summary").click();
  await expect(page.locator("#printerChip")).toHaveAttribute("open", "");
  await expect(tip).toHaveCount(0);
  await page.waitForTimeout(600);
  await expect(tip, "the open chip keeps no tip").toHaveCount(0);
  await page.locator("#printerChip > summary").click();
  await page.locator("#tabPrepare").hover();
  await expect(tip).toBeVisible();
  await page.locator("#tabPrepare").click();
  await page.waitForTimeout(600);
  await expect(tip, "a clicked tab keeps no tip").toHaveCount(0);
});
