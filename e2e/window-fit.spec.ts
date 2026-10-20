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
  await expect(page.locator("#timing")).toHaveAttribute("aria-expanded", "true");
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
  await expect(page.locator("#statusHint")).toBeVisible();
  await expect(page.locator("#statusHint")).toHaveText("Settings are in the drawer (Ctrl+B). Results are in the drawer (Ctrl+Alt+B)");
  // The hint stays out of the live status text, so a drawer toggle is not read out again.
  await expect(page.locator("#statusText")).not.toContainText("drawer");
  // The stage and its canvas: neither moves nor resizes under a drawer, so the camera stays put.
  const stage = async () => page.evaluate(() => {
    const r = document.querySelector("#stage")!.getBoundingClientRect();
    const c = document.querySelector("#prepare")!.getBoundingClientRect();
    return [r.x, r.width, r.height, c.width, c.height];
  });
  const before = await stage();

  await toggle.click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle.locator(".rail-label")).toBeHidden();
  await expect(page.locator("#statusHint")).toHaveText("Results are in the drawer (Ctrl+Alt+B)");
  expect(await stage(), "the view keeps its size under an open drawer").toEqual(before);
  const fit = await outerOverflow(page);
  expect(fit.delta).toBe(0);
  expect(fit.deltaW).toBe(0);
  // The settings drawer sits against the rail; the results drawer against the window's right edge.
  const edges = await page.evaluate(() => ({
    rail: document.querySelector("#toolRail")!.getBoundingClientRect().right,
    left: document.querySelector("#leftDock")!.getBoundingClientRect().left,
    width: document.querySelector("#leftDock")!.getBoundingClientRect().width,
  }));
  expect(edges.left).toBe(edges.rail);
  expect(edges.width).toBe(320);

  // The estimate opens the results drawer, which takes the settings drawer's place.
  await page.locator("#timing").click();
  await expect(workspace).not.toHaveClass(/is-right-collapsed/);
  await expect(workspace).toHaveClass(/is-left-collapsed/);
  expect(await stage()).toEqual(before);
  const right = await page.evaluate(() => [document.querySelector("#rightDock")!.getBoundingClientRect().right, window.innerWidth]);
  expect(right[0]).toBe(right[1]);

  // Ctrl+B swaps back, and a swap from inside one drawer hands the focus to the other.
  await page.locator("#rightDock .dock-close").focus();
  await page.keyboard.press("Control+b");
  await expect(workspace).not.toHaveClass(/is-left-collapsed/);
  await expect(workspace).toHaveClass(/is-right-collapsed/);
  await expect(page.locator("#leftDock .dock-close")).toBeFocused();
  // Escape from inside closes the drawer and hands focus to the rail toggle; so does the chevron.
  await page.keyboard.press("Escape");
  await expect(workspace).toHaveClass(/is-left-collapsed/);
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page.locator("#leftDock .dock-close").focus();
  await page.keyboard.press("Enter");
  await expect(workspace).toHaveClass(/is-left-collapsed/);
  await expect(toggle).toBeFocused();

  // Drawers are not remembered, and a desktop width keeps its own choice.
  for (const key of ["lime-slice-panel-left-collapsed", "lime-slice-panel-right-collapsed", "lime-slice-dock-last"]) {
    expect(await page.evaluate((k) => localStorage.getItem(k), key), key).toBeNull();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(workspace).not.toHaveClass(/is-drawers/);
  await expect(workspace).not.toHaveClass(/is-left-collapsed/);
  await expect(page.locator("#statusHint")).toBeHidden();

  // Narrowing a window into the drawer widths with focus in the settings hands it to the rail toggle.
  await page.locator("#leftDock .dock-close").focus();
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(workspace).toHaveClass(/is-left-collapsed/);
  await expect(toggle).toBeFocused();
});
