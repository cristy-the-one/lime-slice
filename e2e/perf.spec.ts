import { expect, test, type Page } from "@playwright/test";

/**
 * Main-thread cost of common preview interactions on a real slice.
 * Needs a running engine and a mesh, so it only runs when both are named:
 *   LIME_PERF_API=http://127.0.0.1:43218 LIME_PERF_MESH=/path/to/part.stl npx playwright test perf
 * Prints one JSON line of timings; it asserts nothing about speed.
 */
const api = process.env.LIME_PERF_API;
const mesh = process.env.LIME_PERF_MESH;

test.skip(!api || !mesh, "set LIME_PERF_API and LIME_PERF_MESH");
test.setTimeout(600_000);

async function longTasks(page: Page, since: number) {
  return page.evaluate((t0) => {
    const hits = (window as unknown as { __long: { start: number; ms: number }[] }).__long.filter((x) => x.start >= t0);
    return { sum: Math.round(hits.reduce((s, x) => s + x.ms, 0)), max: Math.round(Math.max(0, ...hits.map((x) => x.ms))), count: hits.length };
  }, since);
}

async function now(page: Page) {
  return page.evaluate(() => performance.now());
}

async function stepInput(page: Page, selector: string, values: number[]) {
  return page.evaluate(({ selector, values }) => {
    const el = document.querySelector<HTMLInputElement>(selector)!;
    const times: number[] = [];
    for (const v of values) {
      const t = performance.now();
      el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return { median: +times[Math.floor(times.length / 2)].toFixed(2), max: +times[times.length - 1].toFixed(2) };
  }, { selector, values });
}

async function settle(page: Page) {
  await page.waitForTimeout(2500);
}

async function draws(page: Page, ms: number) {
  const before = await page.evaluate(() => (window as unknown as { __draws: number }).__draws);
  await page.waitForTimeout(ms);
  const after = await page.evaluate(() => (window as unknown as { __draws: number }).__draws);
  return after - before;
}

test("preview responsiveness on a real slice", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __long: { start: number; ms: number }[]; __draws: number };
    w.__long = [];
    w.__draws = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push({ start: e.startTime, ms: e.duration });
    }).observe({ type: "longtask", buffered: true });
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      const orig = proto.drawArrays;
      proto.drawArrays = function (...args: Parameters<typeof orig>) {
        w.__draws += 1;
        return orig.apply(this, args);
      };
    }
  });
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    const response = await route.fetch({ url, timeout: 600_000 });
    await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#file").setInputFiles(mesh!);
  await expect(page.locator("#status")).toContainText("loaded", { timeout: 60_000 });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();

  const out: Record<string, unknown> = {};
  let gcodeFetches = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/gcode/")) gcodeFetches += 1;
  });
  const clickAt = await now(page);
  const wall = Date.now();
  await page.locator("#slice").click();
  await expect(page.locator("#slice")).toBeEnabled({ timeout: 600_000 });
  out.sliceWallMs = Date.now() - wall;
  await settle(page);
  out.resultLongTasks = await longTasks(page, clickAt);
  const layers = Number(await page.locator("#rangeHigh").getAttribute("max")) + 1;
  out.layers = layers;

  out.idleDraws2s = await draws(page, 2000);

  const mid = Math.floor(layers / 2);
  const steps = Array.from({ length: 20 }, (_, i) => mid + i);
  out.layerStepPreview = await stepInput(page, "#rangeHigh", steps);
  const moves = Number(await page.locator("#move").getAttribute("max"));
  out.playbackStep = await stepInput(page, "#move", Array.from({ length: 20 }, (_, i) => Math.floor((moves * i) / 20)));

  out.gcodeFetchesBeforeGcodeTab = gcodeFetches;
  await page.getByRole("button", { name: "G-code", exact: true }).click();
  await expect(page.locator("#gcodePane .line").first()).toBeVisible({ timeout: 60_000 });
  out.layerStepGcode = await stepInput(page, "#rangeHigh", steps.map((s) => s - 10));
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await settle(page);

  let t0 = await now(page);
  const legendSync = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#legend input[data-kind="outer"]')!;
    const t = performance.now();
    input.checked = false;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return +(performance.now() - t).toFixed(2);
  });
  await settle(page);
  out.legendToggle = { sync: legendSync, ...(await longTasks(page, t0)) };

  t0 = await now(page);
  const colorSync = await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>("#colorBy")!;
    const t = performance.now();
    select.value = "speed";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return +(performance.now() - t).toFixed(2);
  });
  await settle(page);
  out.colorBy = { sync: colorSync, ...(await longTasks(page, t0)) };

  console.log(`PERF ${JSON.stringify(out)}`);
});
