import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share";

const out = path.resolve("artifacts/compact");
fs.mkdirSync(out, { recursive: true });

const hullSlice = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/hull-speed.json"), "utf8"));

async function share(page: Page, selector: string) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
  }, selector);
  expect(box, selector).not.toBeNull();
  return canvasShare({ width: box!.width, height: box!.height }, { width: box!.viewW, height: box!.viewH });
}

async function boot(page: Page, layout: string | null) {
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-theme", "dark");
    localStorage.setItem("lime-slice-settings-level", "simple");
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    await route.fulfill({ json: hullSlice });
  });
  const query = layout ? `/?layout=${layout}` : "/";
  await page.goto(query);
  await expect(page.locator(".app")).toBeVisible();
}

test.describe("iPhone 14 compact layout", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("prepare, sheet, preview, device, and hidden chrome", async ({ page }) => {
    await boot(page, "compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="lime_hull.stl"]')?.click());
    await expect(page.locator("#compactFile")).toContainText("lime_hull");
    await page.waitForTimeout(400);

    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare viewport share ${prepare}`).toBeGreaterThanOrEqual(0.7);
    await page.screenshot({ path: path.join(out, "01-prepare-default.png") });

    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const peek = await share(page, "#prepare");
    expect(peek, `settings peek share ${peek}`).toBeGreaterThanOrEqual(0.7);
    await page.screenshot({ path: path.join(out, "02-settings-peek.png") });

    await page.locator("#compactTabs [data-tab=settings]").click();
    await page.waitForTimeout(250);
    const half = await share(page, "#prepare");
    expect(half, `half sheet share ${half}`).toBeGreaterThan(0.4);
    expect(half, `half sheet share ${half}`).toBeLessThan(0.55);
    await page.screenshot({ path: path.join(out, "03-settings-half.png") });

    await page.locator("#slice").click();
    await page.locator("#compactTabs [data-tab=preview]").click();
    await expect(page.locator("#compactProgress")).toHaveAttribute("data-on", "1");
    await page.screenshot({ path: path.join(out, "04-preview-progress.png") });
    await expect.poll(async () => page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => Number(el.max))).toBeGreaterThan(0);
    await page.waitForTimeout(200);
    const preview = await share(page, "#view3d");
    expect(preview, `preview viewport share ${preview}`).toBeGreaterThanOrEqual(0.7);
    await page.screenshot({ path: path.join(out, "04-preview-scrubber.png") });

    await page.locator("#compactTabs [data-tab=device]").click();
    await expect(page.locator("#compactDevice")).toBeVisible();
    await expect(page.locator("#apiBase")).toBeVisible();
    await page.screenshot({ path: path.join(out, "05-device.png") });

    await page.locator("#compactTabs [data-tab=prepare]").click();
    // Upper canvas, clear of the tool rail and the part gizmo.
    await page.locator("#prepare").click({ position: { x: 250, y: 100 } });
    await expect(page.locator("html")).toHaveClass(/chrome-hidden/);
    const hidden = await share(page, "#prepare");
    expect(hidden, `chrome hidden share ${hidden}`).toBeGreaterThanOrEqual(0.7);
    await page.screenshot({ path: path.join(out, "06-chrome-hidden.png") });
  });

  test("landscape phone stays compact", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await boot(page, null);
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    const prepare = await share(page, "#prepare");
    expect(prepare).toBeGreaterThanOrEqual(0.7);
    await page.screenshot({ path: path.join(out, "07-landscape.png") });
  });
});

test.describe("iPad-sized window", () => {
  test.use({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: false, isMobile: false });

  test("falls back to the desktop shell", async ({ page }) => {
    await boot(page, null);
    await expect(page.locator("html")).not.toHaveClass(/layout-compact/);
    await expect(page.locator(".top")).toBeVisible();
    await page.screenshot({ path: path.join(out, "08-ipad-desktop.png") });
  });
});
