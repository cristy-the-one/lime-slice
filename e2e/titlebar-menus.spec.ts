import { expect, test, type Page } from "@playwright/test";

/**
 * The title bar's menus drop below the 40 px bar. 7.1.1 (Vite 8) emitted the component stylesheets before
 * styles.css, so `.top { overflow: hidden }` won over shell.css's `overflow: visible`, and the bar clipped every
 * menu: File opened empty. This checks that each item of an open menu is what the pointer would hit.
 */
async function itemsOnTop(page: Page, items: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const hidden: string[] = [];
    for (const item of document.querySelectorAll<HTMLElement>(selector)) {
      const box = item.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      if (!hit || !item.contains(hit)) hidden.push(`${item.textContent?.trim()} under ${hit?.tagName.toLowerCase()}#${hit?.id ?? ""}`);
    }
    return hidden;
  }, items);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
});

test("the title bar does not clip its menus", async ({ page }) => {
  const overflow = await page.locator("header.top").evaluate((el) => getComputedStyle(el).overflowY);
  expect(overflow).toBe("visible");
});

test("the File menu's items are on top when it opens", async ({ page }) => {
  await page.locator("#fileMenu > summary").click();
  await expect(page.locator("#fileMenu")).toHaveAttribute("open", "");
  await expect(page.locator('#fileMenu [data-file-action="new"]')).toBeVisible();
  expect(await itemsOnTop(page, "#fileMenu > nav > button")).toEqual([]);
});

test("the printer menu is on top when it opens", async ({ page }) => {
  await page.locator("#printerChip > summary").click();
  await expect(page.locator("#printerChip")).toHaveAttribute("open", "");
  const pick = page.locator("#printerPick");
  await expect(pick).toBeVisible();
  const box = await pick.boundingBox();
  expect(box && box.height > 40).toBe(true);
  expect(await itemsOnTop(page, "#printerPick")).toEqual([]);
});
