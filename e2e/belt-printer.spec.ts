import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";

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

test("a belt printer shows the belt and a mock slice, and a cartesian printer still slices", async ({ page }) => {
  await quiet(page);
  let slices = 0;
  await page.route("**/api/slice", async (route) => {
    slices += 1;
    await route.fulfill({ json: cube });
  });
  await page.goto("/");
  await page.locator("#machineKind").selectOption("belt");
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "1");
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt-plane", "1");
  await expect(page.locator("#beltAngle")).toHaveValue("45");
  await expect(page.locator("#beltFields")).toBeVisible();
  await page.locator("#beltCopies").fill("3");
  await page.locator("#beltCopies").blur();
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt-copies", "3");

  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect(page.locator("#banner")).toContainText("Mock belt preview");
  await expect(page.locator("#export")).toBeDisabled();
  await expect(page.locator("#sendPrinter")).toBeDisabled();
  await page.locator("#tabPreview").click();
  await expect(page.locator("#beltMockTag")).toBeVisible();
  await expect(page.locator("#view3d")).toHaveAttribute("data-belt-mock", "");
  expect(slices).toBe(0);

  await page.locator("#tabPrepare").click();
  await page.locator("#machineKind").selectOption("cartesian");
  await expect(page.locator("#beltFields")).toBeHidden();
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "0");
  await page.locator("#slice").click();
  await expect.poll(() => slices).toBe(1);
  await expect(page.locator("#export")).toBeEnabled();
  await expect(page.locator("#beltMockTag")).toBeHidden();
});

test.describe("belt fields stay in the sheet", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a belt printer keeps the prepare canvas", async ({ page }) => {
    await quiet(page);
    await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    const before = await share(page, "#prepare");
    expect(before).toBeGreaterThanOrEqual(0.7);

    await page.locator("#compactTabs [data-tab=settings]").click();
    await page.locator("#machineKind").selectOption("belt");
    await expect(page.locator("#beltFields")).toBeVisible();
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "1");
    await expect(page.locator("#prepare")).toHaveAttribute("data-belt-plane", "1");
    const after = await share(page, "#prepare");
    expect(after, `prepare share ${after}`).toBeGreaterThanOrEqual(0.7);
  });
});
