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

test("a slice opens the results panel when the user has not collapsed it", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await expect(page.locator(".workspace")).toHaveClass(/is-right-collapsed/);
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await expect(page.locator(".workspace")).not.toHaveClass(/is-right-collapsed/);
  await expect(page.locator("#right")).toBeVisible();
  await expect(page.locator("#right")).toContainText("Triangles");
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
  await page.locator("#tabPrepare").click();
  expect(await page.evaluate((key) => localStorage.getItem(key), RIGHT_COLLAPSE)).toBeNull();
  await page.reload();
  await expect(page.locator(".workspace")).toHaveClass(/is-right-collapsed/);
  expect(await page.evaluate((key) => localStorage.getItem(key), RIGHT_COLLAPSE)).toBeNull();
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
    await expect(page.locator(".workspace")).not.toHaveClass(/is-right-collapsed/);
    const prepare = await prepareRatio(page);
    expect(prepare, `prepare width ratio ${prepare}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#tabPreview").click();
    const preview = await widthRatio(page, "#previewBody");
    expect(preview, `preview viewport ratio ${preview}`).toBeGreaterThanOrEqual(0.7);
    await page.screenshot({ path: path.join(shots, `after-slice-${width}.png`) });
  });
}
