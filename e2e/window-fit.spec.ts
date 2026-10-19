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

test("from 961 to 1200 px the docks are drawers over a still view, one at a time, found from the rail", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeAttached();
  const workspace = page.locator(".workspace");
  await expect(workspace).toHaveClass(/is-drawers/);
  await expect(workspace).toHaveClass(/is-left-collapsed/);
  await expect(workspace).toHaveClass(/is-right-collapsed/);
  // The closed settings are labelled on the rail and named in the status line.
  const toggle = page.locator("#leftToggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle.locator(".rail-label")).toBeVisible();
  await expect(page.locator("#statusText")).toContainText("Settings are in the drawer (Ctrl+B)");
  const stage = async () => page.evaluate(() => {
    const r = document.querySelector("#stage")!.getBoundingClientRect();
    return [r.x, r.width];
  });
  const before = await stage();

  await toggle.click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle.locator(".rail-label")).toBeHidden();
  await expect(page.locator("#statusText")).not.toContainText("drawer");
  expect(await stage(), "the view keeps its size under an open drawer").toEqual(before);
  const fit = await outerOverflow(page);
  expect(fit.delta).toBe(0);
  expect(fit.deltaW).toBe(0);
  const drawer = await page.evaluate(() => document.querySelector("#leftDock")!.getBoundingClientRect().width);
  expect(drawer).toBe(320);

  // The estimate opens the results drawer, which takes the settings drawer's place.
  await page.locator("#timing").click();
  await expect(workspace).not.toHaveClass(/is-right-collapsed/);
  await expect(workspace).toHaveClass(/is-left-collapsed/);
  expect(await stage()).toEqual(before);

  // Ctrl+B swaps back; the chevron closes and hands focus to the rail toggle.
  await page.keyboard.press("Control+b");
  await expect(workspace).not.toHaveClass(/is-left-collapsed/);
  await expect(workspace).toHaveClass(/is-right-collapsed/);
  await page.locator("#leftDock .dock-close").focus();
  await page.keyboard.press("Enter");
  await expect(workspace).toHaveClass(/is-left-collapsed/);
  await expect(toggle).toBeFocused();

  // Drawers are not remembered: a reload starts closed, and a desktop width keeps its own choice.
  expect(await page.evaluate(() => localStorage.getItem("lime-slice-panel-left-collapsed"))).toBeNull();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(workspace).not.toHaveClass(/is-drawers/);
  await expect(workspace).not.toHaveClass(/is-left-collapsed/);
});
