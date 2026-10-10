import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
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

test("an object's walls are omitted until they are set", async ({ page }) => {
  await quiet(page);
  const bodies: { objects?: { settings?: { walls?: number; infill?: number } }[] }[] = [];
  await page.route("**/api/slice", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ json: cube });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]?.objects).toBeUndefined();

  await page.locator("#objWalls").fill("3");
  await page.locator("#objWalls").blur();
  await page.waitForTimeout(400);
  await page.locator("#objInfill").fill("80");
  await page.locator("#objInfill").blur();
  await page.waitForTimeout(400);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]?.objects?.[0]?.settings).toEqual({ walls: 3, infill: 0.8 });
});

for (const { id, key, typed, want } of [
  { id: "#objInfill", key: "infill", typed: "80", want: 0.8 },
  { id: "#objWalls", key: "walls", typed: "3", want: 3 },
  { id: "#objSpeed", key: "speed", typed: "120", want: 120 },
] as const) {
  test(`a slice reply keeps ${id} typed while it was on the way`, async ({ page }) => {
    await quiet(page);
    const bodies: { objects?: { settings?: Record<string, number> }[] }[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/slice", async (route) => {
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 2) await held;
      await route.fulfill({ json: cube });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await autoSliceOff(page);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#objectList .obj").first()).toBeVisible();
    await page.locator("#slice").click();
    await expect.poll(() => bodies.length).toBe(1);

    await page.locator("#slice").click();
    await expect.poll(() => bodies.length).toBe(2);
    await page.locator(id).fill(typed);
    release();
    await expect(page.locator("#cancel")).toBeHidden();
    await expect(page.locator(id)).toBeFocused();
    await expect(page.locator(id)).toHaveValue(typed);
    await page.locator(id).blur();
    await expect(page.locator(id)).toHaveValue(typed);

    await page.locator("#slice").click();
    await expect.poll(() => bodies.length).toBe(3);
    expect(bodies[2]?.objects?.[0]?.settings?.[key]).toBe(want);
  });
}

test.describe("object overrides stay in the sheet", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("object override fields keep the prepare canvas", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    const shareOf = await share(page, "#prepare");
    expect(shareOf, `prepare share ${shareOf}`).toBeGreaterThanOrEqual(0.7);
  });
});
