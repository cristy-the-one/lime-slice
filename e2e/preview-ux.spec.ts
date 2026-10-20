import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveSliceJob } from "./serve-job";
import { placeText } from "./place";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

test("preview opens in perspective, blurs until a slice, and steps one layer", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await serveSliceJob(page, cube);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await expect(page.locator("#stage")).toHaveClass(/mode-solid/);
  await expect(page.getByRole("button", { name: "3D", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#view3d")).toHaveAttribute("data-projection", "perspective");
  await expect(page.locator("#pane3d")).toHaveClass(/is-pending/);
  await expect.poll(async () => page.locator("#view3d").evaluate((el) => getComputedStyle(el).filter)).toContain("blur");

  await page.getByRole("button", { name: "2D", exact: true }).click();
  await page.getByRole("tab", { name: "Prepare", exact: true }).click();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(page.locator("#stage")).toHaveClass(/mode-flat/);

  await page.locator("#fileMenu > summary").click();

  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await expect(page.locator("#gizmoNudge")).toBeHidden();
  await page.locator('#toolRail [data-tool="move"]').click();
  await expect(page.locator("#gizmoNudge")).toBeVisible();
  const nudge = await page.locator("#gizmoNudge button").first().boundingBox();
  expect(nudge?.height ?? 99).toBeLessThanOrEqual(24);
  expect(nudge?.width ?? 99).toBeLessThanOrEqual(40);

  const before = await placeText(page);
  await page.getByRole("button", { name: "Nudge X +0.1 mm" }).click();
  await expect.poll(() => placeText(page)).not.toBe(before);

  await page.locator("#slice").click();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect.poll(async () => page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => Number(el.max))).toBeGreaterThan(10);
  await expect(page.locator("#pane3d")).not.toHaveClass(/is-pending/);
  const max = await page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => Number(el.max));
  await expect(page.locator("#rangeHigh")).toHaveValue(String(max));

  const step = await page.locator("#layerNext").boundingBox();
  expect(step?.height ?? 99).toBeLessThanOrEqual(24);
  expect(step?.width ?? 99).toBeLessThanOrEqual(28);
  await page.locator("#layerPrev").click();
  await expect(page.locator("#rangeHigh")).toHaveValue(String(max - 1));
  await page.locator("#layerNext").click();
  await expect(page.locator("#rangeHigh")).toHaveValue(String(max));
});

test("a slice on Prepare paints the layer chart at its on-screen size", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await serveSliceJob(page, cube);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await page.getByRole("tab", { name: "Prepare", exact: true }).click();
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await expect(page.locator(".stage-tools")).toBeHidden();

  await page.locator("#slice").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await expect(page.locator(".stage-tools")).toBeHidden();
  const hidden = await page.locator("#spark").evaluate((el: HTMLCanvasElement) => [el.width, el.height]);
  expect(hidden).not.toEqual([1, 1]);

  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect.poll(async () => page.locator("#spark").evaluate((canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.floor(rect.width * dpr);
    const cssH = Math.floor(rect.height * dpr);
    return cssW > 1 && cssH > 1 && canvas.width === cssW && canvas.height === cssH;
  })).toBe(true);
});

test("the Preview rail holds the view bar, the strip is 52 px and the layer slider 48 px", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await serveSliceJob(page, cube);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#slice").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();

  const rail = page.getByRole("toolbar", { name: "Preview tools" });
  for (const name of ["2D", "Split", "3D", "Color by", "Features shown", "Bed opacity", "Measure", "Section", "Edit supports"]) {
    await expect(rail.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(page.locator(".viewbar")).toHaveCount(0);

  // A flyout opens beside the rail and says so on its button; Esc closes it back onto the button.
  const color = rail.getByRole("button", { name: "Color by", exact: true });
  await color.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#flyColor")).toBeVisible();
  await expect(color).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#colorBy")).toBeFocused();
  const sides = await page.evaluate(() => ({
    fly: document.querySelector("#flyColor")!.getBoundingClientRect().left,
    rail: document.querySelector("#toolRail")!.getBoundingClientRect().right,
  }));
  expect(sides.fly).toBeGreaterThanOrEqual(sides.rail);
  await page.keyboard.press("Escape");
  await expect(page.locator("#flyColor")).toBeHidden();
  await expect(color).toBeFocused();
  await expect(color).toHaveAttribute("aria-expanded", "false");
  await page.locator('#toolRail [data-fly="flyFeatures"]').click();
  await expect(page.locator("#flyFeatures")).toBeVisible();
  await page.locator("#view3d").click({ position: { x: 20, y: 20 } });
  await expect(page.locator("#flyFeatures")).toBeHidden();

  const sizes = await page.evaluate(() => ({
    strip: document.querySelector(".stage-tools")!.getBoundingClientRect().height,
    slider: document.querySelector("#vslider")!.getBoundingClientRect().width,
    canvas: document.querySelector("#view3d")!.getBoundingClientRect().height,
    stage: document.querySelector("#stage")!.getBoundingClientRect().height,
  }));
  expect(sizes.strip).toBe(52);
  expect(sizes.slider).toBe(48);
  expect(sizes.stage - sizes.canvas, "only the strip sits under the 3D view").toBeLessThanOrEqual(53);

  // The rail's view modes drive the stage.
  await rail.getByRole("button", { name: "2D", exact: true }).click();
  await expect(page.locator("#stage")).toHaveClass(/mode-flat/);
  await expect(rail.getByRole("button", { name: "2D", exact: true })).toHaveAttribute("aria-pressed", "true");
});
