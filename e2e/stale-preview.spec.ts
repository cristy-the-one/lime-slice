import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

interface Reply {
  coreMs?: number;
}

/**
 * Each slice request takes the next reply; the last one repeats. `hold()` keeps the next request open until its
 * release runs, so a spec sees the in-flight state however fast or slow the runner is.
 */
async function mockEngine(page: Page, replies: Reply[]) {
  const slices: unknown[] = [];
  let gate: Promise<void> | null = null;
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", async (route) => {
    const reply = replies[Math.min(slices.length, replies.length - 1)];
    slices.push(route.request().postDataJSON());
    const held = gate;
    gate = null;
    if (held) await held;
    await route.fulfill({ json: { ...cube, coreMs: reply.coreMs ?? cube.coreMs } }).catch(() => {});
  });
  const hold = () => {
    let release = () => {};
    gate = new Promise<void>((resolve) => { release = resolve; });
    return () => release();
  };
  return Object.assign(slices, { hold });
}

/** Auto-slice on slices the loaded mesh by itself; off, the first slice waits for the button. */
async function openSliced(page: Page, slices: unknown[], auto = true, sample = "20 mm cube") {
  await page.goto("/");
  if (!auto) await setAutoSlice(page, false);
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: sample }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  if (!auto) await page.locator("#slice").click();
  await expect.poll(() => slices.length).toBe(1);
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await page.locator("#tabPreview").click();
}

async function setAutoSlice(page: Page, on: boolean) {
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#autoslice").setChecked(on);
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
}

const chip = (page: Page) => page.locator("#staleChip");

test("a pose change dims the preview and the next slice starts by itself", async ({ page }) => {
  const slices = await mockEngine(page, [{}]);
  await openSliced(page, slices);
  await expect(page.locator("#autoslice")).toBeChecked();
  await expect(chip(page)).toBeHidden();

  const release = slices.hold();
  const before = slices.length;
  await page.locator("#tabPrepare").click();
  await page.locator("#rotZ").click();
  await page.locator("#tabPreview").click();
  await expect(page.locator("#stage")).toHaveClass(/stale/);

  await expect.poll(() => slices.length, { timeout: 5000 }).toBe(before + 1);
  await expect(chip(page)).toContainText("Updating");
  await expect(page.locator("#staleReslice")).toBeHidden();
  release();
  await expect(chip(page)).toBeHidden({ timeout: 5000 });
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
});

test("lay flat after a slice marks the preview out of date, then re-slices", async ({ page }) => {
  const slices = await mockEngine(page, [{}]);
  await openSliced(page, slices, true, "Slope");
  const release = slices.hold();
  const before = slices.length;
  await page.locator("#tabPrepare").click();
  await page.locator("#layflat").click();
  await page.locator("#tabPreview").click();
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await expect(chip(page)).toBeVisible();
  await expect.poll(() => slices.length, { timeout: 5000 }).toBe(before + 1);
  release();
  await expect(chip(page)).toBeHidden({ timeout: 5000 });
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
});

test("with auto-slice off the chip offers Re-slice and the click slices", async ({ page }) => {
  const slices = await mockEngine(page, [{}, {}]);
  await openSliced(page, slices, false);
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
  await openSliced(page, slices, false);
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
  const slices = await mockEngine(page, [{}]);
  await openSliced(page, slices);
  const release = slices.hold();
  const before = slices.length;
  await page.locator("#tabPrepare").click();
  await page.locator("#rotZ").click();
  await expect.poll(() => slices.length, { timeout: 5000 }).toBe(before + 1);
  await page.locator("#rotZ").click();
  await page.locator("#tabPreview").click();
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await expect(chip(page)).toContainText("Updating");
  release();
  await expect.poll(() => slices.length, { timeout: 5000 }).toBe(before + 2);
  await expect(chip(page)).toBeHidden({ timeout: 5000 });
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
});

test("auto-slice is on for a new user, and the switch is remembered after a restart", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await expect(page.locator("#autoslice")).toBeChecked();
  await page.locator("#autoslice").uncheck();
  await page.reload();
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await expect(page.locator("#autoslice")).not.toBeChecked();
  await page.locator("#autoslice").check();
  await page.reload();
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await expect(page.locator("#autoslice")).toBeChecked();
});

test("undo never flips the auto-slice switch: it is a preference, not a print setting", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await setAutoSlice(page, false);
  await page.locator("#lh").fill("0.28");
  await page.locator("#lh").dispatchEvent("change");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#lh")).toHaveValue("0.2");
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await expect(page.locator("#autoslice")).not.toBeChecked();
});
