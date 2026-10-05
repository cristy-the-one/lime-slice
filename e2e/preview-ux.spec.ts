import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveSliceJob } from "./serve-job";

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

  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
  await expect(page.locator("#gizmoNudge")).toBeVisible();
  const nudge = await page.locator("#gizmoNudge button").first().boundingBox();
  expect(nudge?.height ?? 99).toBeLessThanOrEqual(20);
  expect(nudge?.width ?? 99).toBeLessThanOrEqual(40);

  const before = await page.locator("#placeReadout").innerText();
  await page.getByRole("button", { name: "Nudge X +0.1 mm" }).click();
  await expect(page.locator("#placeReadout")).not.toHaveText(before);

  await page.locator("#slice").click();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect.poll(async () => page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => Number(el.max))).toBeGreaterThan(10);
  await expect(page.locator("#pane3d")).not.toHaveClass(/is-pending/);
  const max = await page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => Number(el.max));
  await expect(page.locator("#rangeHigh")).toHaveValue(String(max));

  const step = await page.locator("#layerNext").boundingBox();
  expect(step?.height ?? 99).toBeLessThanOrEqual(22);
  expect(step?.width ?? 99).toBeLessThanOrEqual(28);
  await page.locator("#layerPrev").click();
  await expect(page.locator("#rangeHigh")).toHaveValue(String(max - 1));
  await page.locator("#layerNext").click();
  await expect(page.locator("#rangeHigh")).toHaveValue(String(max));
});
