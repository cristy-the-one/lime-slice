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

test("sequential is omitted until the plate prints one object at a time", async ({ page }) => {
  await quiet(page);
  const bodies: { printOrder?: string; sequentialClearanceMm?: number; objects?: unknown }[] = [];
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
  expect(bodies[0]).not.toHaveProperty("printOrder");
  expect(bodies[0]).not.toHaveProperty("objects");

  await page.locator("#plateAdd").click();
  await expect(page.locator("#printOrder")).toBeVisible();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).not.toHaveProperty("printOrder");

  await page.locator("#printOrder").selectOption("sequential");
  await expect(page.locator("#seqclear")).toBeVisible();
  await page.waitForTimeout(400);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]?.printOrder).toBe("sequential");
  expect(bodies[2]).not.toHaveProperty("sequentialClearanceMm");

  await page.locator("#seqclear").fill("4");
  await page.locator("#seqclear").blur();
  await page.waitForTimeout(400);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(4);
  expect(bodies[3]?.printOrder).toBe("sequential");
  expect(bodies[3]?.sequentialClearanceMm).toBe(4);
});

for (const { id, field, typed } of [
  { id: "#seqclear", field: "sequentialClearanceMm", typed: 4 },
  { id: "#seqgantry", field: "sequentialGantryMm", typed: 30 },
] as const) {
  test(`a slice reply keeps ${id} typed while it was on the way`, async ({ page }) => {
    await quiet(page);
    const bodies: Record<string, unknown>[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/slice", async (route) => {
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) await held;
      await route.fulfill({ json: cube });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await autoSliceOff(page);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#objectList .obj").first()).toBeVisible();
    await page.locator("#plateAdd").click();
    await page.locator("#printOrder").selectOption("sequential");
    await expect(page.locator(id)).toBeVisible();

    await page.locator("#slice").click();
    await expect.poll(() => bodies.length).toBe(1);
    await page.locator(id).fill(String(typed));
    release();
    await expect(page.locator("#cancel")).toBeHidden();
    await expect(page.locator(id)).toBeFocused();
    await expect(page.locator(id)).toHaveValue(String(typed));
    await page.locator(id).blur();
    await expect(page.locator(id)).toHaveValue(String(typed));

    await page.locator("#slice").click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]?.[field]).toBe(typed);
  });
}

test.describe("sequential controls stay in the sheet", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("one-at-a-time keeps the prepare canvas", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#objectList .obj").first()).toBeVisible();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.locator("#compactTabs [data-tab=settings]").click();
    await page.locator("#plateAdd").click();
    await page.locator("#printOrder").selectOption("sequential");
    await expect(page.locator("#seqclear")).toBeVisible();
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    const peeked = await share(page, "#prepare");
    expect(peeked, `peek viewport share ${peeked}`).toBeGreaterThanOrEqual(0.7);
  });
});
