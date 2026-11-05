import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function openSlicedCube(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: cube }));
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
}

test("an idle page schedules no repeating timers, and playback still advances", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __timers: { interval: number; timeout: number; raf: number } };
    w.__timers = { interval: 0, timeout: 0, raf: 0 };
    const si = window.setInterval.bind(window);
    const st = window.setTimeout.bind(window);
    const raf = window.requestAnimationFrame.bind(window);
    window.setInterval = ((...a: Parameters<typeof setInterval>) => (w.__timers.interval++, si(...a))) as typeof setInterval;
    window.setTimeout = ((...a: Parameters<typeof setTimeout>) => (w.__timers.timeout++, st(...a))) as typeof setTimeout;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => (w.__timers.raf++, raf(cb))) as typeof requestAnimationFrame;
  });
  await openSlicedCube(page);
  await page.waitForTimeout(500);
  const read = () => page.evaluate(() => (window as unknown as { __timers: Record<string, number> }).__timers);
  const before = await read();
  await page.waitForTimeout(2000);
  const after = await read();
  // Nothing may poll while idle: a 100 ms tick would add about 20 intervals' worth of callbacks, a loop 120 frames.
  expect(after.interval - before.interval).toBeLessThanOrEqual(2);
  expect(after.timeout - before.timeout).toBeLessThanOrEqual(4);
  expect(after.raf - before.raf).toBeLessThanOrEqual(4);

  // Playback: one move per 40 ms, paced by animation frames.
  const play = page.locator("#play");
  await expect(play).toBeEnabled();
  const readMove = () => page.locator("#move").evaluate((el) => Number((el as HTMLInputElement).value));
  const start = await readMove();
  await play.click();
  await expect(play).toHaveText("Pause");
  await page.waitForTimeout(1000);
  const moved = (await readMove()) - start;
  await play.click();
  await expect(play).toHaveText("Play");
  expect(moved).toBeGreaterThan(10);
  expect(moved).toBeLessThan(40);
  const stopped = await read();
  await page.waitForTimeout(500);
  expect((await read()).raf - stopped.raf).toBeLessThanOrEqual(4);
});
