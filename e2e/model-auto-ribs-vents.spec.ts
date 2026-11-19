import { expect, test } from "@playwright/test";
import { findFloor, openCard, openPart, primary, shot } from "./auto-ribs-box";

/**
 * Resin vents on the Auto ribs card. The floor's ribs stand upward. With the build direction +Z they face the tank
 * and the line stays hidden. Turn the build over and the same ribs cup: the line names the pockets, and the plan's
 * ribs are the gapped ones. Filament leaves the line and the vents key out.
 */

test("resin lists the pockets it vented, and nothing when the ribs face the tank", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page);
  const floor = await findFloor(page);
  await openCard(page);
  await page.locator("#autoRibsSizes").locator("summary").click();
  await page.locator("#autoRibsProcess").selectOption("resin");
  await page.mouse.click(floor.x, floor.y);
  await expect(primary(page)).toBeEnabled();
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  const line = page.locator("#autoRibsVents");
  await expect(line).toBeHidden();
  await page.locator("#autoRibsGain").scrollIntoViewIfNeeded();
  await shot(page, "vents-none.png");

  await page.evaluate(() => {
    (window as unknown as { __limeAutoRibs: { setBuild(axis: number[]): void } }).__limeAutoRibs.setBuild([0, 0, -1]);
  });
  await expect(primary(page)).toHaveText("Run again");
  await primary(page).click();
  await expect(line).toBeVisible({ timeout: 20_000 });
  await expect(line).toHaveText(/^\d+ pockets? vented$/);
  const vented = await page.evaluate(() => {
    const plan = (window as unknown as { __limeAutoRibs: { plan(): { ribs: unknown[]; vents?: { pockets: unknown[]; sizeMm: number } } } }).__limeAutoRibs.plan();
    return { ribs: plan.ribs.length, pockets: plan.vents?.pockets.length ?? 0, sizeMm: plan.vents?.sizeMm ?? 0 };
  });
  expect(vented.pockets).toBeGreaterThan(0);
  expect(vented.ribs).toBeGreaterThan(vented.pockets);
  expect(vented.sizeMm).toBe(0.75);
  await line.scrollIntoViewIfNeeded();
  await shot(page, "vents-pockets.png");

  await page.locator("#autoRibsProcess").selectOption("filament");
  await expect(primary(page)).toHaveText("Run again");
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  await expect(line).toBeHidden();
  const filament = await page.evaluate(() => {
    const plan = (window as unknown as { __limeAutoRibs: { plan(): object } }).__limeAutoRibs.plan();
    return "vents" in plan;
  });
  expect(filament).toBe(false);
});
