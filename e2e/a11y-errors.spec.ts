import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

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

async function openCube(page: Page) {
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
}

test("an unreachable engine toasts Retry and a second probe connects", async ({ page }) => {
  let health = 0;
  await page.route("**/api/health", (route) => {
    health += 1;
    if (health === 1) return route.fulfill({ status: 500, json: { error: "down" } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const toast = page.getByRole("alert").filter({ hasText: "Slicer engine not running" });
  await expect(toast).toBeVisible();
  await expect(page.locator("#engineLink")).toHaveText("Engine unreachable");
  await toast.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("#engineLink")).toHaveText("Engine connected");
  await expect(page.getByRole("alert").filter({ hasText: "Slicer engine not running" })).toHaveCount(0);
});

test("a failed slice toasts Retry and the next attempt can export", async ({ page }) => {
  let slices = 0;
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => {
    slices += 1;
    if (slices === 1) return route.fulfill({ status: 500, json: { error: "planner broke" } });
    return route.fulfill({ json: cube });
  });
  await openCube(page);
  await page.locator("#slice").click();
  const toast = page.getByRole("alert").filter({ hasText: "planner broke" });
  await expect(toast).toBeVisible();
  await expect(page.locator("#export")).toBeDisabled();
  await toast.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("#export")).toBeEnabled();
  expect(slices).toBe(2);
});

test("a bad mesh and a bad project toast Retry that reopens the file picker", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await expect(page.locator("#engineLink")).toHaveText("Engine connected");

  await page.locator("#file").setInputFiles({
    name: "bad.stl",
    mimeType: "model/stl",
    buffer: Buffer.from("this is not an stl"),
  });
  const mesh = page.getByRole("alert").filter({ hasText: "Could not read bad.stl." });
  await expect(mesh).toBeVisible();
  const meshPicker = page.waitForEvent("filechooser");
  await mesh.getByRole("button", { name: "Retry" }).click();
  expect(await meshPicker).toBeTruthy();

  await page.locator("#projectFile").setInputFiles({
    name: "nope.lime",
    mimeType: "application/json",
    buffer: Buffer.from("{not json"),
  });
  const project = page.getByRole("alert").filter({ hasText: "This file is not a Lime Slice project." });
  await expect(project).toBeVisible();
  const projectPicker = page.waitForEvent("filechooser");
  await project.getByRole("button", { name: "Retry" }).click();
  expect(await projectPicker).toBeTruthy();
});

test("named controls expose labels", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await expect(page.locator("#colorBy")).toHaveAttribute("aria-label", "Color by");
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play layer");
  await expect(page.locator("#stop")).toHaveAttribute("aria-label", "Stop playback");
  await expect(page.locator("#find")).toHaveAttribute("aria-label", "Search settings");
  await page.keyboard.press("Control+k");
  await expect(page.locator("#paletteInput")).toBeFocused();
  await expect(page.locator("#paletteList")).toHaveAttribute("aria-label", "Matching commands");
  await page.keyboard.press("Escape");
  await expect(page.locator("#palette")).toBeHidden();
});

test.describe("compact sheet keyboard", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("peek keeps the canvas, and arrows move the sheet, tabs, and palette", async ({ page }) => {
    await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare viewport share ${prepare}`).toBeGreaterThanOrEqual(0.7);

    await page.locator("#compactSheetHandle").focus();
    await expect(page.locator("#compactSheetHandle")).toHaveAttribute("aria-keyshortcuts", "ArrowUp ArrowDown Home End");
    await page.keyboard.press("ArrowUp");
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "half");
    await expect(page.locator("#compactSheetHandle")).toHaveAttribute("aria-valuetext", "half");

    await expect(page.locator("#compactTabs [tabindex='0']")).toHaveCount(1);
    await page.locator("#compactTabs [data-tab=prepare]").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#compactTabs [data-tab=settings]")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#compactTabs [data-tab=settings]")).toHaveAttribute("aria-controls", "compactSheet");
    await expect(page.locator("#find")).toBeFocused();
    await expect(page.locator("#compactTabs [tabindex='0']")).toHaveCount(1);
    await expect(page.locator("#compactIso")).toHaveAttribute("aria-label", "Iso view");

    await page.keyboard.press("Control+k");
    await expect(page.locator("#paletteInput")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#palette")).toBeHidden();
  });
});
