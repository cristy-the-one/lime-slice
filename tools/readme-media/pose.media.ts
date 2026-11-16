import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { Clip, ROOT, openApp, still } from "./media";

/**
 * Pose: three gears that mesh (made by tools/readme-media/mechanisms.ts) are coupled with one button, then the pinion
 * is turned through a full turn by its Angle field, and the wheel and the idler follow at their tooth ratios.
 */
test("gear train in Pose", async ({ page }) => {
  await openApp(page);
  await page.locator("#projectFile").setInputFiles(join(ROOT, "artifacts/readme-media/gear-train.lime"));
  await expect(page.locator("[data-plate-select]")).toHaveCount(3, { timeout: 60_000 });
  await page.locator("#tabPose").click();
  const panel = page.locator("#posePanel");
  const rows = panel.locator("[data-object]");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  await panel.getByText("Pinion", { exact: false }).first().click();
  await expect(panel.getByRole("button", { name: "Couple gears" })).toBeVisible();
  // Closer in on the gears, the pointer off the buttons so no tooltip shows.
  await page.mouse.move(900, 520);
  for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(0, -240); await page.waitForTimeout(80); }
  await page.waitForTimeout(1500);
  const clip = new Clip(page, { fps: 10, width: 800, colors: 96, clip: { x: 0, y: 0, width: 1440, height: 1000 } });
  await clip.frame(8);
  await panel.getByRole("button", { name: "Couple gears" }).click();
  await page.mouse.move(900, 520);
  await page.waitForTimeout(1200);
  await clip.frame(12);
  const angle = panel.getByLabel("Angle °");
  for (let a = 6; a <= 360; a += 8) {
    await angle.fill(String(a));
    await angle.press("Tab");
    await page.waitForTimeout(60);
    await clip.frame();
  }
  await clip.frame(6);
  await still(page, "pose-gears.png");
  console.log(`clip-gear-train.gif ${clip.save("clip-gear-train.gif")} bytes, ${clip.frames} frames`);
});
