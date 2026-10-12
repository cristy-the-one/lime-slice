import { expect, type Page } from "@playwright/test";

/** The Supports control's three choices, by the radio each one is. */
export type SupportChoice = "off" | "auto" | "paint";

export async function setSupports(page: Page, choice: SupportChoice) {
  await page.locator(`#supportMode-${choice}`).check();
}

export async function expectSupports(page: Page, choice: SupportChoice) {
  await expect(page.locator(`#supportMode-${choice}`)).toBeChecked();
}
