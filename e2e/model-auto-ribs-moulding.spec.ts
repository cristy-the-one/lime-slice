import { expect, test } from "@playwright/test";
import { findFloor, openCard, openPart, primary, shot } from "./auto-ribs-box";

/**
 * Moulding checks on the Auto ribs card (src/modeling/moulding.ts). The stand-in plans the wall; moulded shows the
 * flag list, one rib that sits inside every limit shows the pass line, and filament leaves the list out. The existing auto-ribs specs are unchanged.
 */

test("moulded lists moulding flags, one rib inside the limits passes, and filament shows neither", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page);
  const floor = await findFloor(page);
  await openCard(page);
  await page.locator("#autoRibsSizes").locator("summary").click();
  await page.locator("#autoRibsProcess").selectOption("moulded");
  await page.mouse.click(floor.x, floor.y);
  await expect(primary(page)).toBeEnabled();
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  const flags = page.locator("#autoRibsMoulding");
  await expect(flags).toBeVisible();
  await expect(flags).toContainText(/base .* × the wall, over 0\.6/);
  await expect(page.locator("#autoRibsMouldingList li").first()).toBeVisible();
  await flags.scrollIntoViewIfNeeded();
  await shot(page, "moulding-flags.png");

  // One rib, 1.06 mm wide and 2 mm tall: its product root sits in the band and its own circle stays under 1.2.
  // A grid crosses, and that circle does not, so the target stops after the first rib (src/modeling/moulding.test.ts).
  await page.locator("#autoRibsWidth").fill("1.06");
  await page.locator("#autoRibsHeight").fill("2");
  await page.locator("#autoRibsHowMuch").locator("summary").click();
  await page.getByRole("button", { name: "Target" }).click();
  await page.locator("#autoRibsStiffer").fill("1.05");
  await expect(primary(page)).toHaveText("Run again");
  await primary(page).click();
  await expect(page.locator("#autoRibsMouldingList")).toHaveText("Moulding checks pass (6 rules)", { timeout: 20_000 });
  await page.locator("#autoRibsSizes").locator("summary").click();
  await page.locator("#autoRibsHowMuch").locator("summary").click();
  await flags.scrollIntoViewIfNeeded();
  await shot(page, "moulding-pass.png");

  await page.locator("#autoRibsSizes").locator("summary").click();
  await page.locator("#autoRibsProcess").selectOption("filament");
  await expect(primary(page)).toHaveText("Run again");
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#autoRibsGain")).toHaveText(/^\d+(\.\d)?× stiffer$/);
  await expect(flags).toBeHidden();
  await page.locator("#autoRibsSizes").locator("summary").click();
  await page.locator("#autoRibsGain").scrollIntoViewIfNeeded();
  await shot(page, "moulding-filament.png");
});
