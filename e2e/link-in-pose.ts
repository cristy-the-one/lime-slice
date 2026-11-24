import { expect, type Page } from "@playwright/test";

/** The stage tab that is pressed, so a visit to Pose can return there. */
async function pressedTab(page: Page): Promise<string | null> {
  for (const id of ["#tabPrepare", "#tabModel", "#tabPreview", "#tabGcode"]) {
    if ((await page.locator(id).getAttribute("aria-pressed")) === "true") return id;
  }
  return null;
}

/**
 * Pose's Link: parent, then child, then Select, so a later part click selects. Returns to the stage it left.
 * The parent should already be selected when the caller cares that the link itself is the only new undo step.
 */
export async function linkInPose(page: Page, child: string, parent: string): Promise<void> {
  const back = await pressedTab(page);
  if ((await page.locator("#tabPose").getAttribute("aria-pressed")) !== "true") await page.locator("#tabPose").click();
  const panel = page.locator("#posePanel");
  await expect(panel.locator(`[data-object='${parent}']`)).toBeVisible();
  await page.locator("[data-pose-tool='link']").click();
  await panel.locator(`[data-object='${parent}']`).click();
  await panel.locator(`[data-object='${child}']`).click();
  await expect(panel).toContainText("Linked.");
  // Attach was one click. Link is a tool that stays armed, so a later part click would link again.
  // Back to Select, the tool Pose starts on, before the caller continues.
  await page.locator("[data-pose-tool='select']").click();
  if (back) await page.locator(back).click();
}

/** Ungroup from Pose's assembly header, then return to the stage it left. */
export async function ungroupInPose(page: Page): Promise<void> {
  const back = await pressedTab(page);
  if ((await page.locator("#tabPose").getAttribute("aria-pressed")) !== "true") await page.locator("#tabPose").click();
  await page.locator("#posePanel [data-pose-ungroup]").click();
  if (back) await page.locator(back).click();
}

/** Pose's assembly header Export…, the same dialog the old STEP button opened. Stays in Pose. */
export async function exportAssemblyFromPose(page: Page): Promise<void> {
  if ((await page.locator("#tabPose").getAttribute("aria-pressed")) !== "true") await page.locator("#tabPose").click();
  await page.locator("#posePanel [data-pose-action='assembly-export']").click();
}
