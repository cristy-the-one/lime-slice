import type { Page } from "@playwright/test";

/**
 * Turn auto-slice off, for a spec that counts slice requests or waits on the button.
 * The gear is the user's path; the compact layout has no gear, so it gets the input event the gear's switch sends.
 */
export async function autoSliceOff(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-auto-slice", "0"));
  const box = page.locator("#autoslice");
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  if (await box.isVisible()) await box.uncheck();
  else await box.evaluate((el: HTMLInputElement) => { el.checked = false; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
}
