import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { frameStats, previewFrames, watchGl } from "./gl-frame";
import { serveSliceJob } from "./serve-job";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

test("hiding solid infill leaves its instances out of the preview draw", async ({ page }) => {
  await watchGl(page);
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await serveSliceJob(page, cube);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.locator("#slice").click();
  await expect.poll(async () => page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => Number(el.max))).toBeGreaterThan(10);
  await expect(page.locator('#legend input[data-kind="solid"]')).toBeAttached();
  await page.waitForTimeout(600);

  const shown = frameStats(await previewFrames(page, 400, true));
  expect(shown.n).toBeGreaterThan(0);
  expect(shown.instances).toBeGreaterThan(0);

  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#legend input[data-kind="solid"]')!;
    input.checked = false;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const hidden = frameStats(await previewFrames(page, 400, true));
  expect(hidden.instances).toBeLessThan(shown.instances);
  expect(hidden.draws).toBeGreaterThan(0);

  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#legend input[data-kind="solid"]')!;
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const restored = frameStats(await previewFrames(page, 400, true));
  expect(restored.instances).toBe(shown.instances);

  const view = await page.locator("#view3d").boundingBox();
  if (!view) throw new Error("preview canvas has no box");
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 150);
  await page.waitForTimeout(300);
  const lined = frameStats(await previewFrames(page, 400, true));
  expect(lined.instances).toBeGreaterThan(0);
  expect(lined.instances).toBeLessThan(restored.instances);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -200);
  await page.waitForTimeout(300);
  const boxed = frameStats(await previewFrames(page, 400, true));
  expect(boxed.instances).toBe(restored.instances);
});
