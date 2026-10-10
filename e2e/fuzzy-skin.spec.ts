import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
}

async function captureSlices(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  return bodies;
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
}

test("fuzzy skin is omitted until it is on, then sent, and undone", async ({ page }) => {
  await quiet(page);
  const bodies = await captureSlices(page);
  await page.goto("/");
  await loadCube(page);

  await expect(page.locator("#fuzzy")).not.toBeChecked();
  await expect(page.locator("#fuzzythick")).toHaveCount(0);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toHaveProperty("fuzzySkin");

  await page.locator("#fuzzy").check();
  await expect(page.locator("#fuzzythick")).toHaveValue("0.3");
  await expect(page.locator("#fuzzydist")).toHaveValue("0.8");
  await page.waitForTimeout(400);
  await page.locator("#fuzzythick").fill("0.5");
  await page.waitForTimeout(400);
  await page.locator("#fuzzydist").fill("1.2");
  await page.waitForTimeout(400);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toHaveProperty("fuzzySkin", { thickness: 0.5, pointDistance: 1.2 });
  await expect(page.locator("#toasts").getByRole("status").filter({ hasText: /fuzzy/i })).toHaveCount(0);

  await page.locator("#undoEdit").click();
  await expect(page.locator("#fuzzydist")).toHaveValue("0.8");
  await page.locator("#undoEdit").click();
  await expect(page.locator("#fuzzythick")).toHaveValue("0.3");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]).toHaveProperty("fuzzySkin", {});
  await page.locator("#undoEdit").click();
  await expect(page.locator("#fuzzy")).not.toBeChecked();
});

test.describe("compact fuzzy skin", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("the prepare canvas stays at least 70% with fuzzy skin in the sheet", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.locator("#compactTabs [data-tab=settings]").click();
    await page.locator("#fuzzy").scrollIntoViewIfNeeded();
    await expect(page.locator("#fuzzy")).toBeVisible();
    await page.locator("#fuzzy").check();
    await expect(page.locator("#fuzzythick")).toBeVisible();
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    const box = await page.evaluate(() => {
      const rect = document.querySelector("#prepare")!.getBoundingClientRect();
      return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
    });
    const share = canvasShare({ width: box.width, height: box.height }, { width: box.viewW, height: box.viewH });
    expect(share, `prepare viewport share ${share}`).toBeGreaterThanOrEqual(0.7);
  });
});
