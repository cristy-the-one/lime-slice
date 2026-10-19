import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const shots = path.resolve("/opt/cursor/artifacts/viewport-width");
fs.mkdirSync(shots, { recursive: true });
const RIGHT_COLLAPSE = "lime-slice-panel-right-collapsed";

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: cube }));
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
}

async function widthRatio(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const rect = document.querySelector(sel)!.getBoundingClientRect();
    return rect.width / window.innerWidth;
  }, selector);
}

async function prepareRatio(page: Page) {
  return widthRatio(page, "#prepare");
}

test("the default prepare viewport is at least 70% of a 1440 window", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  const workspace = page.locator(".workspace");
  await expect(workspace).toHaveClass(/is-right-collapsed/);
  await expect(workspace).not.toHaveClass(/is-left-collapsed/);
  expect(await page.evaluate((key) => localStorage.getItem(key), RIGHT_COLLAPSE)).toBeNull();
  const ratio = await prepareRatio(page);
  expect(ratio, `prepare width ratio ${ratio}`).toBeGreaterThanOrEqual(0.7);
  await page.screenshot({ path: path.join(shots, "after-1440.png") });

  await page.keyboard.press("Control+b");
  await expect(workspace).toHaveClass(/is-left-collapsed/);
  await page.keyboard.press("Control+b");
  await expect(workspace).not.toHaveClass(/is-left-collapsed/);
  await page.keyboard.press("Control+Alt+b");
  await expect(workspace).not.toHaveClass(/is-right-collapsed/);
  await expect(page.locator("#right")).toBeVisible();
  await page.keyboard.press("Control+Alt+b");
  await expect(workspace).toHaveClass(/is-right-collapsed/);

  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await expect(workspace).toHaveClass(/is-right-collapsed/);
  expect(await page.evaluate((key) => localStorage.getItem(key), RIGHT_COLLAPSE)).toBe("1");
});

test("a slice leaves the results closed, and the estimate opens them and is remembered", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  const workspace = page.locator(".workspace");
  await expect(workspace).toHaveClass(/is-right-collapsed/);
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await expect(workspace).toHaveClass(/is-right-collapsed/);
  expect(await page.evaluate((key) => localStorage.getItem(key), RIGHT_COLLAPSE)).toBeNull();

  const timing = page.locator("#timing");
  await expect(timing).toHaveAttribute("aria-expanded", "false");
  await timing.click();
  await expect(workspace).not.toHaveClass(/is-right-collapsed/);
  await expect(timing).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#right")).toBeVisible();
  await expect(page.locator("#right")).toContainText("Triangles");
  // 1440 has no room for both docks: the one opened last stays, and settings fold to the rail.
  await expect(workspace).toHaveClass(/is-left-collapsed/);
  await expect(page.locator("#leftToggle")).toHaveAttribute("aria-expanded", "false");
  const openRatio = await prepareRatio(page);
  expect(openRatio, `prepare width ratio after results open ${openRatio}`).toBeGreaterThanOrEqual(0.7);
  await page.locator("#tabPreview").click();
  const previewRatio = await widthRatio(page, "#previewBody");
  expect(previewRatio, `preview viewport ratio ${previewRatio}`).toBeGreaterThanOrEqual(0.7);
  const canvasGap = await page.evaluate(() => {
    const body = document.querySelector("#previewBody")!.getBoundingClientRect().width;
    const canvas = document.querySelector("#view3d")!.getBoundingClientRect().width;
    return body - canvas;
  });
  expect(canvasGap, "the 3D canvas keeps the preview viewport aside from the layer slider").toBeLessThanOrEqual(80);
  expect(await page.evaluate((key) => localStorage.getItem(key), RIGHT_COLLAPSE)).toBe("0");
  await page.reload();
  await expect(workspace).not.toHaveClass(/is-right-collapsed/);

  await page.locator("#rightDock .dock-close").click();
  await expect(workspace).toHaveClass(/is-right-collapsed/);
  await expect(workspace).not.toHaveClass(/is-left-collapsed/);
  expect(await page.evaluate((key) => localStorage.getItem(key), RIGHT_COLLAPSE)).toBe("1");
});

test("1920 fits both docks: settings yield to the results", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await page.locator("#timing").click();
  const workspace = page.locator(".workspace");
  await expect(workspace).not.toHaveClass(/is-right-collapsed/);
  await expect(workspace).not.toHaveClass(/is-left-collapsed/);
  const widths = await page.evaluate(() => ({
    left: document.querySelector("#leftDock")!.getBoundingClientRect().width,
    right: document.querySelector("#rightDock")!.getBoundingClientRect().width,
  }));
  expect(widths.right).toBe(280);
  expect(widths.left).toBeGreaterThanOrEqual(240);
  expect(await prepareRatio(page)).toBeGreaterThanOrEqual(0.7);
});

for (const width of [1280, 1600]) {
  test(`prepare and preview stay at least 70% of a ${width} window after slicing`, async ({ page }) => {
    await quiet(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await autoSliceOff(page);
    await loadCube(page);
    const before = await prepareRatio(page);
    expect(before, `prepare width ratio before slice ${before}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#slice").click();
    await expect(page.locator("#estimate")).toContainText("g");
    await page.locator("#timing").click();
    await expect(page.locator(".workspace")).not.toHaveClass(/is-right-collapsed/);
    const prepare = await prepareRatio(page);
    expect(prepare, `prepare width ratio ${prepare}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#tabPreview").click();
    const preview = await widthRatio(page, "#previewBody");
    expect(preview, `preview viewport ratio ${preview}`).toBeGreaterThanOrEqual(0.7);
    await page.screenshot({ path: path.join(shots, `after-slice-${width}.png`) });
  });
}

for (const { width, left, columns } of [
  { width: 2560, left: 360, columns: "auto" },
  { width: 3440, left: 600, columns: "2" },
]) {
  test(`${width} opens both docks by default, settings ${left} wide in ${columns === "2" ? "two columns" : "one column"}`, async ({ page }) => {
    await quiet(page);
    await page.setViewportSize({ width, height: 1440 });
    await page.goto("/");
    await autoSliceOff(page);
    await loadCube(page);
    const workspace = page.locator(".workspace");
    await expect(workspace).not.toHaveClass(/is-left-collapsed/);
    await expect(workspace).not.toHaveClass(/is-right-collapsed/);
    await expect(page.locator("#timing")).toHaveAttribute("aria-expanded", "true");
    // Nothing is stored until the user chooses: the width alone opened the results.
    expect(await page.evaluate((key) => localStorage.getItem(key), RIGHT_COLLAPSE)).toBeNull();
    const docks = await page.evaluate(() => ({
      left: document.querySelector("#leftDock")!.getBoundingClientRect().width,
      right: document.querySelector("#rightDock")!.getBoundingClientRect().width,
      columns: getComputedStyle(document.querySelector("#leftBody")!).columnCount,
    }));
    expect(docks.left).toBe(left);
    expect(docks.right).toBe(340);
    expect(docks.columns).toBe(columns);

    await page.locator("#slice").click();
    await expect(page.locator("#estimate")).toContainText("g");
    await page.locator("#tabPreview").click();
    // Both docks open still leave the preview a large view.
    const view = await page.evaluate(() => document.querySelector("#previewBody")!.getBoundingClientRect().width);
    expect(view).toBeGreaterThanOrEqual(1764);
    await page.screenshot({ path: path.join(shots, `wide-${width}.png`) });

    // A user's close is remembered over the width's default.
    await page.locator("#rightDock .dock-close").click();
    await expect(workspace).toHaveClass(/is-right-collapsed/);
    expect(await page.evaluate((key) => localStorage.getItem(key), RIGHT_COLLAPSE)).toBe("1");
    await page.reload();
    await expect(workspace).toHaveClass(/is-right-collapsed/);
    await expect(workspace).not.toHaveClass(/is-left-collapsed/);
  });
}
