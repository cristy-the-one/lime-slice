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
    const stage = document.querySelector("#stage")?.getBoundingClientRect();
    const left = document.querySelector<HTMLElement>("#left");
    return {
      delta: root.scrollHeight - root.clientHeight,
      deltaW: root.scrollWidth - root.clientWidth,
      statusBottom: status?.bottom ?? -1,
      statusTop: status?.top ?? -1,
      stageBottom: stage?.bottom ?? null,
      stageHeight: stage?.height ?? null,
      innerHeight: window.innerHeight,
      leftScroll: left && getComputedStyle(left).display !== "none" ? left.scrollHeight - left.clientHeight : 0,
    };
  });
}

for (const engine of ["running", "down"] as const) test(`desktop shell fits the viewport without an outer scrollbar, engine ${engine}`, async ({ page }) => {
  await page.route("**/api/health", (route) => (engine === "running" ? route.fulfill({ json: { ok: true } }) : route.abort()));
  const health = page.waitForRequest("**/api/health");
  await page.goto("/");
  await expect(page.locator(".app")).toBeVisible();
  await health;
  await expect(page.locator("#banner .banner")).toHaveCount(engine === "running" ? 0 : 1);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const fit = await outerOverflow(page);
    expect(fit.delta, `${viewport.width}x${viewport.height} vertical`).toBe(0);
    expect(fit.deltaW, `${viewport.width}x${viewport.height} horizontal`).toBe(0);
    expect(fit.statusBottom).toBeLessThanOrEqual(fit.innerHeight + 0.5);
    expect(fit.statusTop).toBeGreaterThanOrEqual(0);
    // The stage, and the playback strip at its foot, end above the status line.
    expect(fit.stageBottom).not.toBeNull();
    expect(fit.stageBottom!).toBeLessThanOrEqual(fit.statusTop + 0.5);
    expect(fit.stageHeight!).toBeGreaterThan(200);
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
  expect(settings.stageBottom).not.toBeNull();
  expect(settings.stageBottom!).toBeLessThanOrEqual(settings.statusTop + 0.5);
  // Results start folded on a desktop width; the narrow window's Results button still shows them.
  await page.locator("#toggleRight").click();
  await expect(page.locator("#right")).toBeVisible();
  expect((await outerOverflow(page)).delta).toBe(0);
});
