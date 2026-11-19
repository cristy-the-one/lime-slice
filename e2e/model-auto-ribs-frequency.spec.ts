import { expect, test } from "@playwright/test";
import { findFloor, openCard, openPart, panelRun, primary, shot } from "./auto-ribs-box";

/**
 * Higher frequency on the Auto ribs panel. The plan is the deterministic stand-in (its Hz are a label, not a solve).
 * Headless Chromium, as the other Auto ribs specs.
 */
test("Higher frequency shows Hz, cancel stops mid-plan, and Stiffer returns the old result", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page, { tickMs: 400 });
  const floor = await findFloor(page);
  await openCard(page);
  await page.mouse.click(floor.x, floor.y);
  await expect(page.locator("#autoRibsWallLine")).toHaveText(/^1 face/);
  await page.locator("#autoRibsHowMuch > summary").click();
  await page.getByRole("button", { name: "Higher frequency" }).click();
  await expect(page.locator("#autoRibsSliderNote")).toContainText(/Higher frequency: 1\.5×/);
  await expect(page.getByRole("button", { name: "Deflection" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Budget" })).toBeHidden();

  await primary(page).click();
  await expect(page.locator("#autoRibsGain")).toHaveText(/\d+(\.\d+)? Hz → \d+(\.\d+)? Hz/, { timeout: 30_000 });
  await expect(page.locator("#autoRibsFrequency")).toContainText("× as stiff, for information");
  await expect(page.locator("#autoRibsFrequency")).toBeVisible();
  await page.locator("#autoRibsGain").scrollIntoViewIfNeeded();
  await shot(page, "frequency-result.png");

  await page.locator("#autoRibsSlider").fill("1");
  await expect(primary(page)).toHaveText("Run again");
  await primary(page).click();
  await expect(page.locator("#autoRibsStage")).toHaveText("Choosing ribs", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator("#autoRibsStopped")).toBeVisible({ timeout: 10_000 });
  const stopped = await panelRun(page);
  expect(stopped.plan?.stoppedEarly, "cancel mid-plan").toBe(true);

  await page.locator("#autoRibsSlider").fill("0");
  await page.getByRole("button", { name: "Stiffer", exact: true }).click();
  await expect(page.locator("#autoRibsSliderNote")).toContainText("Balanced");
  await expect(primary(page)).toHaveText("Run again");
  await primary(page).click();
  await expect(page.locator("#autoRibsGain")).toHaveText(/^\d+(\.\d)?× stiffer$/, { timeout: 30_000 });
  await expect(page.locator("#autoRibsFrequency")).toBeHidden();
  await expect(page.locator("#autoRibsStopped")).toBeHidden();
});
