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

async function prepareRatio(page: Page) {
  return page.evaluate(() => {
    const rect = document.querySelector("#prepare")!.getBoundingClientRect();
    return rect.width / window.innerWidth;
  });
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
  await expect(page.locator("#right")).toContainText("Outline");
  expect(await page.evaluate((key) => localStorage.getItem(key), RIGHT_COLLAPSE)).toBeNull();
  await page.reload();
  await expect(page.locator(".workspace")).toHaveClass(/is-right-collapsed/);
  expect(await prepareRatio(page)).toBeGreaterThanOrEqual(0.7);
});
