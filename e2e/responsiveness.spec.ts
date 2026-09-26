import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function mockEngine(page: Page, delayMs: () => number) {
  const slices: unknown[] = [];
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", async (route) => {
    slices.push(route.request().postDataJSON());
    const delay = delayMs();
    if (delay) await new Promise((r) => setTimeout(r, delay));
    await route.fulfill({ json: cube }).catch(() => {});
  });
  return slices;
}

async function openCube(page: Page) {
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
}

test("a setting changed during a slice leaves the finished result stale", async ({ page }) => {
  await mockEngine(page, () => 1500);
  await openCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("[data-state=slicing]")).toBeVisible();
  await page.locator("#lh").fill("0.28");
  await expect(page.locator("#estimate")).toContainText("g", { timeout: 10_000 });
  await expect(page.locator("#slice")).toHaveText("Re-slice");
  await expect(page.locator("#export")).toBeDisabled();
});

test("auto-slice runs after a structural toggle", async ({ page }) => {
  const slices = await mockEngine(page, () => 0);
  await openCube(page);
  await page.locator("#autoslice").check();
  await page.locator("#slice").click();
  await expect.poll(() => slices.length).toBe(1);
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#adaptive").check();
  await expect.poll(() => slices.length, { timeout: 3000 }).toBe(2);
  expect((slices[1] as { adaptive: boolean }).adaptive).toBe(true);
});

test("auto-slice picks up an edit made while a slice was running", async ({ page }) => {
  let calls = 0;
  const slices = await mockEngine(page, () => (calls++ === 0 ? 1200 : 0));
  await openCube(page);
  await page.locator("#autoslice").check();
  await page.locator("#slice").click();
  await expect.poll(() => slices.length).toBe(1);
  await page.locator("#arcs").uncheck();
  await expect.poll(() => slices.length, { timeout: 5000 }).toBe(2);
  expect((slices[1] as { arcFit: boolean }).arcFit).toBe(false);
  await expect(page.locator("#slice")).toHaveText("Slice");
  await expect(page.locator("#export")).toBeEnabled();
});
