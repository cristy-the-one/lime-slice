import { expect, test } from "@playwright/test";
import { openApp, openFile, still } from "./media";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });

/** The compact layout at a phone's size: Prepare, Preview and Model. */
test("phone layout", async ({ page }) => {
  await openApp(page, "layout=compact");
  await openFile(page, "samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj").first()).toBeAttached({ timeout: 30_000 });
  // The canvas lies over the banner in the compact layout; the button takes the click itself.
  await page.locator("[data-banner-action=supports]").dispatchEvent("click");
  await page.waitForTimeout(2500);
  await still(page, "prepare-phone.png");

  await page.locator("#compactTabs [data-tab=preview]").click();
  for (let i = 0; i < 60; i += 1) {
    if (Number(await page.locator("#rangeHigh").getAttribute("max")) > 0) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(2000);
  await still(page, "preview-phone.png");

  // Model: a new box, as the empty Model view offers.
  await page.locator("#compactTabs [data-tab=model]").click();
  await page.locator("#modelEmptyNew").click();
  await page.locator('#modelPrim [data-kind="box"]').click();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume", { timeout: 60_000 });
  await page.waitForTimeout(2000);
  await still(page, "model-phone.png");
});
