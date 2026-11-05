import { expect, type Page } from "@playwright/test";

/** The app's question sheet (src/ui/ask-sheet.ts), which replaced `window.confirm` and `window.prompt`. */
export const askSheet = (page: Page) => page.locator("#askSheet");

const handled = new WeakSet<Page>();

/**
 * Take the action of every question sheet that shows from now on, as `page.on("dialog", accept)` did for native
 * dialogs: Playwright clicks it away before each action or auto-waiting assertion it would cover. A spec that does
 * not care whether a load asks to discard unsaved changes uses this.
 */
export async function acceptSheets(page: Page): Promise<void> {
  if (handled.has(page)) return;
  handled.add(page);
  await page.addLocatorHandler(page.locator("#askSheet:not([hidden])"), async (sheet) => {
    await sheet.locator('[data-ask="confirm"]').click();
  });
}

/** The question sheet is open with this title; answer it with its action (typing `value` first) or Cancel. */
export async function answerSheet(page: Page, title: string | RegExp, answer: { value?: string; cancel?: boolean } = {}): Promise<void> {
  const sheet = askSheet(page);
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("h2")).toHaveText(title);
  if (answer.value !== undefined) await sheet.locator("#askSheetInput").fill(answer.value);
  await sheet.locator(answer.cancel ? '[data-ask="cancel"]' : '[data-ask="confirm"]').click();
  await expect(sheet).toBeHidden();
}
