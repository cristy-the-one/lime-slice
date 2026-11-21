import { expect, test } from "@playwright/test";
import { findFloor, openCard, openPart, shot } from "./auto-ribs-box";

/**
 * Resist buckling on the Auto ribs panel. The plan is the deterministic stand-in (its load factor is a label, not a
 * solve). Headless Chromium, as the other Auto ribs specs.
 */
test.use({ viewport: { width: 1440, height: 1000 } });

test("Resist buckling refuses a pressure, then shows the factor and the warning", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await openPart(page, { tickMs: 40 });
  const floor = await findFloor(page);
  await openCard(page);
  await page.mouse.click(floor.x, floor.y);
  await expect(page.locator("#autoRibsWallLine")).toHaveText(/^1 face/);
  await page.locator("#autoRibsHowMuch > summary").click();

  await page.getByRole("button", { name: "Resist buckling" }).click();
  await expect(page.locator("#autoRibsSliderNote")).toHaveText("Holds 3× the load before it buckles. 1× buckles exactly at the load.");
  await expect(page.locator("#autoRibsSliderLo")).toHaveText("1.5×");
  await expect(page.locator("#autoRibsSliderMid")).toHaveText("3×");
  await expect(page.locator("#autoRibsSliderHi")).toHaveText("5×");
  await expect(page.getByRole("button", { name: "Deflection" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Budget" })).toBeHidden();
  await expect(page.locator("#autoRibsAgainst")).toBeHidden();

  await page.locator("#modelApply").click();
  await expect(page.locator("#autoRibsError")).toHaveText("This load bends the wall but doesn't press along it, so it can't buckle it. Buckling needs a load along the wall, such as a push on its edge.", { timeout: 30_000 });

  await page.locator("#autoRibsHoldLoad > summary").click();
  await page.locator("#autoRibsLoadForce").click();
  await page.locator("#autoRibsDirX").fill("1");
  await page.locator("#autoRibsDirY").fill("0");
  await page.locator("#autoRibsDirZ").fill("0");
  await page.locator("#autoRibsDirZ").blur();
  await page.locator("#autoRibsLoadPick").click();
  await page.mouse.click(floor.x, floor.y);
  await page.locator("#modelApply").click();
  await expect(page.locator("#autoRibsGain")).toHaveText(/^Buckles at \d+(\.\d)?× the load \(was \d+(\.\d)?×\)\.$/, { timeout: 30_000 });
  await expect(page.locator("#autoRibsNotes")).toContainText("This is the ideal buckling load. A curved wall, or one that isn't perfectly flat, can buckle well below it.");
  await expect(page.locator("#autoRibsNotes")).not.toContainText("Buckles at");
  await page.locator("#autoRibsGain").scrollIntoViewIfNeeded();
  await shot(page, "buckling-result.png");

  await page.locator("#autoRibsAddCase").click();
  await expect(page.locator("#autoRibsAgainst")).toBeVisible();
  await expect(page.locator("#autoRibsAgainstCase")).toHaveValue("Case 1");
  await page.locator("[data-case-pick='1']").click();
  await page.mouse.click(floor.x, floor.y);
  await page.locator("#modelApply").click();
  await expect(page.locator("#autoRibsNotes")).toContainText("Against case: Case 1", { timeout: 30_000 });
  await expect(page.locator("#autoRibsGain")).toHaveText(/^Buckles at /);
});
