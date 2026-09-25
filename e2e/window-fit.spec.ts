import { expect, test, type Page } from "@playwright/test";

const viewports = [
  { width: 960, height: 640 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1600, height: 1200 },
];

async function outerOverflow(page: Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const status = document.querySelector(".status")?.getBoundingClientRect();
    const legend = document.querySelector(".legend");
    const legendBox = legend && getComputedStyle(legend).display !== "none" ? legend.getBoundingClientRect() : null;
    const left = document.querySelector<HTMLElement>("#left");
    return {
      delta: root.scrollHeight - root.clientHeight,
      deltaW: root.scrollWidth - root.clientWidth,
      statusBottom: status?.bottom ?? -1,
      statusTop: status?.top ?? -1,
      legendBottom: legendBox?.bottom ?? null,
      legendHeight: legendBox?.height ?? null,
      innerHeight: window.innerHeight,
      leftScroll: left && getComputedStyle(left).display !== "none" ? left.scrollHeight - left.clientHeight : 0,
    };
  });
}

test("desktop shell fits the viewport without an outer scrollbar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app")).toBeVisible();

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const fit = await outerOverflow(page);
    expect(fit.delta, `${viewport.width}x${viewport.height} vertical`).toBe(0);
    expect(fit.deltaW, `${viewport.width}x${viewport.height} horizontal`).toBe(0);
    expect(fit.statusBottom).toBeLessThanOrEqual(fit.innerHeight + 0.5);
    expect(fit.statusTop).toBeGreaterThanOrEqual(0);
    expect(fit.legendBottom).not.toBeNull();
    expect(fit.legendBottom!).toBeLessThanOrEqual(fit.innerHeight + 0.5);
    expect(fit.legendHeight!).toBeGreaterThan(8);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await outerOverflow(page);
  expect(wide.leftScroll).toBeGreaterThan(0);

  await page.setViewportSize({ width: 960, height: 640 });
  await page.locator("#toggleLeft").click();
  await expect(page.locator("#left")).toBeVisible();
  const settings = await outerOverflow(page);
  expect(settings.delta).toBe(0);
  expect(settings.deltaW).toBe(0);
  expect(settings.leftScroll).toBeGreaterThan(0);
  expect(settings.statusBottom).toBeLessThanOrEqual(settings.innerHeight + 0.5);
  expect(settings.legendBottom).not.toBeNull();
  expect(settings.legendBottom!).toBeLessThanOrEqual(settings.innerHeight + 0.5);
});
