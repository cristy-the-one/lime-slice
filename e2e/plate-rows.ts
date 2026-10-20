import type { Page } from "@playwright/test";

type PlateAction = "select" | "frame" | "remove" | "check" | "duplicate";

/**
 * E3. Click a plate list button the way a user can reach it: in Prepare the Objects list, and in Model, which hides the
 * settings, Inspect's rows (the right dock, opened from the estimate when shut and shut again after).
 */
export async function plateClick(page: Page, action: PlateAction, index = 0) {
  const model = (await page.locator("#tabModel").getAttribute("aria-selected")) === "true";
  const root = model ? "#modelInspect" : "#left";
  const opened = model && !(await page.locator("#modelInspect").isVisible());
  if (opened) await page.locator("#timing").click();
  const button = action === "duplicate"
    ? page.locator(model ? "#modelInspectDuplicate" : "#plateDuplicate")
    : page.locator(`${root} [data-plate-${action}]`).nth(index);
  await button.click();
  if (opened && (await page.locator("#modelInspect").isVisible())) await page.locator("#timing").click();
}
