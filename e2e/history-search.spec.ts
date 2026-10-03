import { expect, test, type Page } from "@playwright/test";
import { canvasShare } from "../src/ui/compact/viewport-share";

async function quietEngine(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
}

async function openCube(page: Page) {
  await quietEngine(page);
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
}

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

test("undo and redo restore a placement edit", async ({ page }) => {
  await openCube(page);
  const scale = page.locator("#partScale");
  await expect(scale).toHaveValue("100");
  await scale.fill("150");
  await expect(scale).toHaveValue("150");
  await expect(page.locator("#undoEdit")).toBeEnabled();
  await page.keyboard.press("Control+z");
  await expect(scale).toHaveValue("100");
  await expect(page.locator("#redoEdit")).toBeEnabled();
  await page.keyboard.press("Control+Shift+Z");
  await expect(scale).toHaveValue("150");
  await page.locator("#undoEdit").click();
  await expect(scale).toHaveValue("100");
  await scale.fill("150");
  await page.keyboard.press("Control+k");
  await page.locator("#paletteInput").fill("Undo");
  await page.keyboard.press("Enter");
  await expect(scale).toHaveValue("100");
});

test("settings search matches a label and a keyword", async ({ page }) => {
  await openCube(page);
  const find = page.getByLabel("Search settings");
  await find.fill("layer height");
  await expect(page.locator("#lh")).toBeVisible();
  await expect(page.locator("#gyroid3d")).toBeHidden();
  await find.fill("lattice");
  await expect(page.locator("#gyroid3d")).toBeVisible();
  await expect(page.locator("#lh")).toBeHidden();
  await find.fill("");
  await expect(page.locator("#lh")).toBeVisible();
});

test.describe("compact settings search", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("the search sits in the sheet and the prepare canvas stays in front", async ({ page }) => {
    await quietEngine(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactFile")).toContainText("calibration_cube");
    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare share ${prepare}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#compactTabs [data-tab=settings]").click();
    const find = page.getByLabel("Search settings");
    await expect(find).toBeVisible();
    const undo = await page.locator("#undoEdit").boundingBox();
    expect(undo?.height ?? 0).toBeGreaterThan(0);
    expect(undo?.height ?? 99).toBeLessThanOrEqual(32);
    await find.fill("layer");
    await expect(page.locator("#lh")).toBeVisible();
    await expect(page.locator("#gyroid3d")).toBeHidden();
  });
});
