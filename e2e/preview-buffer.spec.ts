import { expect, test, type Page } from "@playwright/test";

/** Backing store must match the laid-out CSS box times devicePixelRatio. */
async function bufferMatchesCss(page: Page, id: string) {
  return page.locator(`#${id}`).evaluate((el: HTMLCanvasElement, canvasId: string) => {
    const rect = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const expectedW = Math.floor(rect.width * dpr);
    const expectedH = Math.floor(rect.height * dpr);
    return {
      id: canvasId,
      css: [rect.width, rect.height],
      buf: [el.width, el.height],
      expected: [expectedW, expectedH],
      dpr,
      match: el.width === expectedW && el.height === expectedH && rect.width >= 200 && rect.height >= 200,
    };
  }, id);
}

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/** Viewport metrics land before the ResizeObserver frame that resizes the canvases. */
async function afterViewport(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
}

test("preview canvases keep a device-pixel backing store across resize", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#view3d");

  const split = await bufferMatchesCss(page, "view3d");
  const flat = await bufferMatchesCss(page, "view");
  console.log("split", JSON.stringify({ view3d: split, view: flat }));
  expect(split.match, JSON.stringify(split)).toBe(true);
  expect(flat.match, JSON.stringify(flat)).toBe(true);

  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.setViewportSize({ width: 1800, height: 1000 });
  await afterViewport(page);
  const solid = await bufferMatchesCss(page, "view3d");
  console.log("solid resized", JSON.stringify(solid));
  expect(solid.match, JSON.stringify(solid)).toBe(true);
  expect(solid.css[0]).toBeGreaterThan(split.css[0]);

  await page.getByRole("button", { name: "Prepare" }).click();
  const prepare = await bufferMatchesCss(page, "prepare");
  console.log("prepare", JSON.stringify(prepare));
  expect(prepare.match, JSON.stringify(prepare)).toBe(true);

  await page.setViewportSize({ width: 1600, height: 800 });
  await afterViewport(page);
  const prepareResized = await bufferMatchesCss(page, "prepare");
  console.log("prepare resized", JSON.stringify(prepareResized));
  expect(prepareResized.match, JSON.stringify(prepareResized)).toBe(true);
  expect(prepareResized.buf[0]).not.toBe(prepare.buf[0]);
});
