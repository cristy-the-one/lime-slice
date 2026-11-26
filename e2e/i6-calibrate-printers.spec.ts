import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * I6 (docs/plan-interaction-model.md D3). Calibrate is a Prepare rail button. Off Prepare the palette
 * keeps it, disabled, with the reason. Printers is a top-bar menu beside File, and the printer chip opens it.
 */

const shots = path.join("docs/screenshots/i6-calibrate-printers");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
});

async function openPalette(page: Page, query: string) {
  await page.keyboard.press("Control+K");
  const input = page.locator("#paletteInput");
  await expect(input).toBeVisible();
  await input.fill(query);
}

test("Calibrate is on Prepare's rail, absent from File, and disabled in Model", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  await page.locator("#tabPrepare").click();
  const rail = page.locator('#toolRail [data-tool="calibrate"]');
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute("aria-label", "Calibrate");
  await page.screenshot({ path: path.join(shots, "prepare-rail.png") });

  await page.locator("#fileMenu > summary").click();
  await expect(page.locator("#fileMenu")).toHaveAttribute("open", "");
  await expect(page.locator("#fileMenu #calibrateOpen")).toHaveCount(0);
  await expect(page.locator("#fileMenu")).not.toContainText("Calibrate");
  await expect(page.locator("#fileMenu #machineOpen")).toHaveCount(0);
  await expect(page.locator("#fileMenu")).not.toContainText("Printers and filaments");
  await page.locator("#fileMenu > summary").click();

  await rail.click();
  await expect(page.locator("#calibrate")).toBeVisible();
  await expect(page.locator("#calibrate #pacal")).toBeVisible();
  await expect(page.locator("#calibrate #retractcal")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "calibrate-sheet.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator("#calibrate")).toBeHidden();
  await expect(rail).toBeFocused();

  await page.locator("#tabModel").click();
  await expect(rail).toBeHidden();
  await openPalette(page, "Calibrate");
  const row = page.locator('#paletteList [data-id="calibrate"]');
  await expect(row).toHaveAttribute("aria-disabled", "true");
  await expect(row).toHaveAttribute("title", "Calibrate is in Prepare.");
  await page.screenshot({ path: path.join(shots, "calibrate-disabled-model.png") });
});

test("Printers opens from the menu and from the chip", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const menu = page.locator("#printersMenu");
  await expect(menu).toBeVisible();
  await menu.locator("> summary").click();
  await expect(menu).toHaveAttribute("open", "");
  await expect(page.locator("#machinePrinter")).toBeVisible();
  await expect(page.locator("#machineFilament")).toBeVisible();
  await expect(page.locator("#printersMenu #machineOpen")).toBeVisible();
  await expect(page.locator("#printersMenu #machineSettings")).toBeVisible();
  await expect(page.locator("#printersMenu #machineOpen")).toHaveText("Printers and filaments…");
  await expect(page.locator("#printersMenu #machineSettings")).toHaveText("Machine settings…");
  await page.screenshot({ path: path.join(shots, "printers-menu.png") });

  await menu.locator("> summary").click();
  await expect(menu).not.toHaveAttribute("open", "");

  await page.locator("#printerChip > summary").click();
  await expect(menu).toHaveAttribute("open", "");
  await expect(page.locator("#machinePrinter")).toBeVisible();
  await expect(page.locator("#machineFilament")).toBeVisible();
  await expect(page.locator("#printersMenu #machineSettings")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "printers-from-chip.png") });
  await page.locator("#printersMenu #machineSettings").click();
  await expect(menu).not.toHaveAttribute("open", "");
  await expect(page.locator('#left .group[data-group="printer"]')).toHaveAttribute("open");
  await expect(page.locator("#bedx")).toBeVisible();
});
