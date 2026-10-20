import type { Page } from "@playwright/test";

/**
 * E3. Click a Model tool in the rail as a user does on a short window: when its group has folded into one button, that
 * button opens the group beside the rail first.
 */
export async function railClick(page: Page, selector: string) {
  const tool = page.locator(selector);
  // A resize just made folds the rail on its next event: let it land before looking.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
  if (!(await tool.isVisible())) {
    const fold = page.locator(".rail-group[data-folded]", { has: page.locator(selector) }).locator(".rail-fold");
    await fold.click();
  }
  await tool.click();
}
