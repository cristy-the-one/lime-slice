import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

interface Reply {
  delayMs?: number;
  coreMs?: number;
}

/** Each slice request takes the next reply; the last one repeats. */
async function mockEngine(page: Page, replies: Reply[]) {
  const slices: unknown[] = [];
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", async (route) => {
    const reply = replies[Math.min(slices.length, replies.length - 1)];
    slices.push(route.request().postDataJSON());
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    await route.fulfill({ json: { ...cube, coreMs: reply.coreMs ?? cube.coreMs } }).catch(() => {});
  });
  return slices;
}

async function openSliced(page: Page, slices: unknown[]) {
  await page.goto("/");
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#slice").click();
  await expect.poll(() => slices.length).toBe(1);
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await page.locator("#tabPreview").click();
}

async function autoSliceOff(page: Page) {
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#autoslice").uncheck();
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
}

const chip = (page: Page) => page.locator("#staleChip");

test("a pose change dims the preview and the next slice starts by itself", async ({ page }) => {
  const slices = await mockEngine(page, [{}, { delayMs: 1200 }]);
  await openSliced(page, slices);
  await expect(page.locator("#autoslice")).toBeChecked();
  await expect(chip(page)).toBeHidden();

  await page.locator("#tabPrepare").click();
  await page.locator("#rotZ").click();
  await page.locator("#tabPreview").click();
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await expect(chip(page)).toContainText("Out of date");

  await expect.poll(() => slices.length, { timeout: 3000 }).toBe(2);
  await expect(chip(page)).toContainText("Updating");
  await expect(page.locator("#staleReslice")).toBeHidden();
  await expect(chip(page)).toBeHidden({ timeout: 5000 });
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
});

test("lay flat after a slice marks the preview out of date", async ({ page }) => {
  const slices = await mockEngine(page, [{}, { delayMs: 600 }]);
  await openSliced(page, slices);
  await autoSliceOff(page);
  await page.locator("#tabPrepare").click();
  await page.locator("#rotX").click();
  await page.locator("#layflat").click();
  await page.locator("#tabPreview").click();
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await expect(chip(page)).toContainText("Out of date");
});

test("with auto-slice off the chip offers Re-slice and the click slices", async ({ page }) => {
  const slices = await mockEngine(page, [{}, {}]);
  await openSliced(page, slices);
  await autoSliceOff(page);
  await page.locator("#tabPrepare").click();
  await page.locator("#rotZ").click();
  await page.locator("#tabPreview").click();
  await expect(chip(page)).toContainText("Out of date");
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await page.waitForTimeout(700);
  expect(slices).toHaveLength(1);

  await expect(page.locator("#staleReslice")).toBeVisible();
  await expect(page.locator("#staleReslice")).toHaveAttribute("data-tip", /Ctrl\+Enter/);
  await page.locator("#staleReslice").click();
  await expect.poll(() => slices.length).toBe(2);
  await expect(chip(page)).toBeHidden();
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
});

test("the Prepare tab never shows the chip", async ({ page }) => {
  const slices = await mockEngine(page, [{}]);
  await openSliced(page, slices);
  await autoSliceOff(page);
  await page.locator("#tabPrepare").click();
  await page.locator("#rotZ").click();
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await expect(chip(page)).toBeHidden();
});

test("a slice that took over 20 s is not repeated by itself", async ({ page }) => {
  const slices = await mockEngine(page, [{ coreMs: 25_000 }, {}]);
  await openSliced(page, slices);
  await page.locator("#tabPrepare").click();
  await page.locator("#rotZ").click();
  await page.locator("#tabPreview").click();
  await page.waitForTimeout(900);
  expect(slices).toHaveLength(1);
  await expect(chip(page)).toContainText("Out of date");
  await expect(page.locator("#staleReslice")).toBeVisible();
});

test("a change made during a slice starts the next slice as soon as the first lands", async ({ page }) => {
  const slices = await mockEngine(page, [{}, { delayMs: 1500 }, { delayMs: 400 }]);
  await openSliced(page, slices);
  await page.locator("#tabPrepare").click();
  await page.locator("#rotZ").click();
  await expect.poll(() => slices.length, { timeout: 3000 }).toBe(2);
  await page.locator("#rotZ").click();
  await page.locator("#tabPreview").click();
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await expect(chip(page)).toContainText("Updating");
  await expect.poll(() => slices.length, { timeout: 5000 }).toBe(3);
  await expect(chip(page)).toBeHidden({ timeout: 5000 });
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
});
