import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { decodePaths } from "../src/preview-wire";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function mockEngine(page: Page, delayMs: () => number) {
  const slices: unknown[] = [];
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", async (route) => {
    slices.push(route.request().postDataJSON());
    const delay = delayMs();
    if (delay) await new Promise((r) => setTimeout(r, delay));
    await route.fulfill({ json: cube }).catch(() => {});
  });
  return slices;
}

async function openCube(page: Page) {
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
}

test("a setting changed during a slice leaves the finished result stale", async ({ page }) => {
  await mockEngine(page, () => 1500);
  await openCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("[data-state=slicing]")).toBeVisible();
  await page.locator("#lh").fill("0.28");
  await expect(page.locator("#estimate")).toContainText("g", { timeout: 10_000 });
  await expect(page.locator("#slice")).toHaveText("Re-slice");
  await expect(page.locator("#export")).toBeDisabled();
});

test("the parked G-code body is fetched once, when the G-code tab first needs it", async ({ page }) => {
  const layer = cube.layers[0];
  const body = [`;LAYER:${layer.index} Z:${layer.z}`, ";TYPE:OUTER", ...decodePaths(layer.paths, layer.z)[0].pts.map((p) => `G1 X${p[0]} Y${p[1]} E0.1 F1800`)].join("\n");
  const fetches: string[] = [];
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: { ...cube, gcode: "", gcodeToken: "t1" } }));
  await page.route("**/api/gcode/*", (route) => {
    fetches.push(route.request().url());
    return route.fulfill({ body });
  });
  await openCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.waitForTimeout(300);
  expect(fetches).toEqual([]);
  await page.getByRole("button", { name: "G-code", exact: true }).click();
  await expect(page.locator("#gcodePane .line").first()).toHaveText(`;LAYER:${layer.index} Z:${layer.z}`);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "G-code", exact: true }).click();
  await expect(page.locator("#gcodePane .line").nth(1)).toHaveText(";TYPE:OUTER");
  expect(fetches).toHaveLength(1);
  expect(fetches[0]).toMatch(/\/api\/gcode\/t1$/);
});

test("legend and Color by recolor the 3D preview without rebuilding it", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __layerPosts: number };
    w.__layerPosts = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      if ((args[0] as { layers?: unknown })?.layers) w.__layerPosts += 1;
      return post.apply(this, args);
    } as Worker["postMessage"];
  });
  await mockEngine(page, () => 0);
  await openCube(page);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.locator("#rangeHigh").evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = input.max;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const canvas = page.locator("#view3d");
  await page.waitForTimeout(800);
  const feature = await canvas.screenshot();
  await page.locator("#legend label", { hasText: "Outer wall" }).locator("input").uncheck();
  await page.waitForTimeout(300);
  const noOuter = await canvas.screenshot();
  await page.locator("#colorBy").selectOption("speed");
  await page.waitForTimeout(300);
  const speed = await canvas.screenshot();
  await page.locator("#legend label", { hasText: "Outer wall" }).locator("input").check();
  await page.locator("#colorBy").selectOption("feature");
  await page.waitForTimeout(300);
  const back = await canvas.screenshot();
  expect(noOuter.equals(feature)).toBe(false);
  expect(speed.equals(noOuter)).toBe(false);
  expect(back.equals(feature)).toBe(true);
  const mainThreadLayerPosts = await page.evaluate(() => (window as unknown as { __layerPosts: number }).__layerPosts);
  expect(mainThreadLayerPosts).toBe(0);
});

test("the 3D view draws only while something changes", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __draws: number };
    w.__draws = 0;
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function (this: WebGL2RenderingContext, ...args: Parameters<typeof draw>) {
      w.__draws += 1;
      return draw.apply(this, args);
    };
  });
  const draws = () => page.evaluate(() => (window as unknown as { __draws: number }).__draws);
  await mockEngine(page, () => 0);
  await openCube(page);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.waitForTimeout(1500);
  const idle = await draws();
  await page.waitForTimeout(1000);
  expect(await draws()).toBe(idle);

  const canvas = page.locator("#view3d");
  const before = await canvas.screenshot();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  expect(await draws()).toBeGreaterThan(idle);
  expect((await canvas.screenshot()).equals(before)).toBe(false);
  const drawsIn = async (ms: number) => {
    const start = await draws();
    await page.waitForTimeout(ms);
    return (await draws()) - start;
  };
  await expect.poll(() => drawsIn(500), { timeout: 8000, message: "damping settles and drawing stops" }).toBe(0);
});

test("playback readout does not resize the print slider", async ({ page }) => {
  await mockEngine(page, () => 0);
  await openCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const move = page.locator("#move");
  await expect(move).toBeVisible();
  await expect(move).toBeEnabled();
  const max = Number(await move.getAttribute("max"));
  expect(max).toBeGreaterThan(4);
  const box = async () => (await move.boundingBox())!;
  const first = await box();
  const texts = new Set<string>();
  for (const t of [0, 0.15, 0.35, 0.55, 0.75, 1]) {
    await move.evaluate((el, value) => {
      const input = el as HTMLInputElement;
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, Math.round(max * t));
    texts.add((await page.locator("#playReadout").textContent()) ?? "");
    const now = await box();
    expect(Math.abs(now.x - first.x)).toBeLessThan(1);
    expect(Math.abs(now.width - first.width)).toBeLessThan(1);
    expect(Math.abs(now.y - first.y)).toBeLessThan(1);
  }
  expect(texts.size).toBeGreaterThan(1);
  const play = page.locator("#play");
  const playBefore = (await play.boundingBox())!;
  await play.click();
  await expect(play).toHaveText("Pause");
  const playing = await box();
  const playAfter = (await play.boundingBox())!;
  expect(Math.abs(playing.x - first.x)).toBeLessThan(1);
  expect(Math.abs(playing.y - first.y)).toBeLessThan(1);
  expect(Math.abs(playing.width - first.width)).toBeLessThan(1);
  expect(Math.abs(playAfter.x - playBefore.x)).toBeLessThan(1);
  expect(Math.abs(playAfter.width - playBefore.width)).toBeLessThan(1);
  await page.waitForTimeout(240);
  const later = await box();
  expect(Math.abs(later.x - first.x)).toBeLessThan(1);
  expect(Math.abs(later.width - first.width)).toBeLessThan(1);
});

test("layer scrub does not resize the spark or the layer track", async ({ page }) => {
  await mockEngine(page, () => 0);
  await openCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const spark = page.locator("#spark");
  const track = page.locator("#vslider .track");
  const spark0 = (await spark.boundingBox())!;
  const track0 = (await track.boundingBox())!;
  const label0 = await page.locator("#sparkLabel").innerText();
  const z0 = await page.locator("#readHigh").innerText();
  await page.locator("#rangeHigh").evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = input.max;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#readHigh")).not.toHaveText(z0);
  const spark1 = (await spark.boundingBox())!;
  const track1 = (await track.boundingBox())!;
  expect(await page.locator("#sparkLabel").innerText()).not.toBe(label0);
  expect(Math.abs(spark1.x - spark0.x)).toBeLessThan(1);
  expect(Math.abs(spark1.width - spark0.width)).toBeLessThan(1);
  expect(Math.abs(track1.x - track0.x)).toBeLessThan(1);
  expect(Math.abs(track1.width - track0.width)).toBeLessThan(1);
});

test("starting a slice keeps Cancel off the Slice hitbox and the action row still", async ({ page }) => {
  await mockEngine(page, () => 4000);
  await openCube(page);
  const slice = page.locator("#slice");
  const cancel = page.locator("#cancel");
  const exportBtn = page.locator("#export");
  await expect(slice).toHaveText("Slice");
  await expect(slice).toBeEnabled();
  await expect(cancel).toBeVisible();
  await expect(cancel).toBeDisabled();
  const before = (await slice.boundingBox())!;
  const cancelBefore = (await cancel.boundingBox())!;
  const exportBefore = (await exportBtn.boundingBox())!;
  const topBefore = (await page.locator(".top").boundingBox())!;
  const stageBefore = (await page.locator(".workspace").boundingBox())!;
  const x = before.x + before.width / 2;
  const y = before.y + before.height / 2;
  await page.mouse.click(x, y);
  await expect(slice).toHaveText("Slicing…");
  await expect(slice).toBeDisabled();
  await expect(cancel).toBeEnabled();
  await expect(page.locator("[data-state=slicing]")).toBeVisible();
  const after = (await slice.boundingBox())!;
  const cancelAfter = (await cancel.boundingBox())!;
  const exportAfter = (await exportBtn.boundingBox())!;
  const topAfter = (await page.locator(".top").boundingBox())!;
  const stageAfter = (await page.locator(".workspace").boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  expect(Math.abs(after.width - before.width)).toBeLessThan(1);
  expect(Math.abs(cancelAfter.x - cancelBefore.x)).toBeLessThan(1);
  expect(Math.abs(cancelAfter.y - cancelBefore.y)).toBeLessThan(1);
  expect(Math.abs(exportAfter.x - exportBefore.x)).toBeLessThan(1);
  expect(Math.abs(topAfter.y - topBefore.y)).toBeLessThan(1);
  expect(Math.abs(topAfter.height - topBefore.height)).toBeLessThan(1);
  expect(Math.abs(stageAfter.y - stageBefore.y)).toBeLessThan(1);
  expect(x).toBeGreaterThanOrEqual(after.x);
  expect(x).toBeLessThan(after.x + after.width);
  expect(x < cancelAfter.x || x >= cancelAfter.x + cancelAfter.width).toBe(true);
  await page.mouse.click(x, y);
  await expect(page.locator("#banner")).not.toContainText("cancelled");
  await expect(page.locator("[data-state=slicing]")).toBeVisible();
  await expect(page.locator("#timing")).toHaveText(/^Slicing… \d+\.\d s$/);
  const timing = await page.locator("#timing").textContent();
  await page.waitForTimeout(600);
  expect(await page.locator("#timing").textContent()).not.toBe(timing);
  const ticked = (await slice.boundingBox())!;
  const cancelTicked = (await cancel.boundingBox())!;
  expect(Math.abs(ticked.x - before.x)).toBeLessThan(1);
  expect(Math.abs(cancelTicked.x - cancelBefore.x)).toBeLessThan(1);
  expect(Math.abs(((await page.locator(".workspace").boundingBox())!).y - stageBefore.y)).toBeLessThan(1);
});

test("a running slice shows elapsed time and Cancel aborts the request", async ({ page }) => {
  await mockEngine(page, () => 4000);
  await openCube(page);
  const failed: string[] = [];
  page.on("requestfailed", (req) => failed.push(req.url()));
  await page.locator("#slice").click();
  await expect(page.locator("[data-state=slicing]")).toHaveClass(/indeterminate/);
  await expect(page.locator("#timing")).toHaveText(/^Slicing… \d+\.\d s$/);
  const first = await page.locator("#timing").textContent();
  await page.waitForTimeout(600);
  expect(await page.locator("#timing").textContent()).not.toBe(first);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#banner")).toContainText("cancelled");
  await expect(page.locator("#timing")).toHaveText("No slice yet");
  await expect.poll(() => failed.filter((url) => url.includes("/api/slice")).length).toBe(1);
});

test("a collapsed settings group stays collapsed when the panel re-renders", async ({ page }) => {
  await mockEngine(page, () => 0);
  await openCube(page);
  const walls = page.locator('details[data-group="Walls and seams"]');
  await walls.locator("summary").click();
  await expect(walls).not.toHaveAttribute("open");
  await page.locator("#adaptive").check();
  await expect(page.locator("#amin")).toBeVisible();
  await expect(walls).not.toHaveAttribute("open");
  await expect(page.locator('details[data-group="Quality"]')).toHaveAttribute("open");
});

test("auto-slice runs after a structural toggle", async ({ page }) => {
  const slices = await mockEngine(page, () => 0);
  await openCube(page);
  await page.locator("#autoslice").check();
  await page.locator("#slice").click();
  await expect.poll(() => slices.length).toBe(1);
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#adaptive").check();
  await expect.poll(() => slices.length, { timeout: 3000 }).toBe(2);
  expect((slices[1] as { adaptive: boolean }).adaptive).toBe(true);
});

test("auto-slice picks up an edit made while a slice was running", async ({ page }) => {
  let calls = 0;
  const slices = await mockEngine(page, () => (calls++ === 0 ? 1200 : 0));
  await openCube(page);
  await page.locator("#autoslice").check();
  await page.locator("#slice").click();
  await expect.poll(() => slices.length).toBe(1);
  await page.locator("#arcs").uncheck();
  await expect.poll(() => slices.length, { timeout: 5000 }).toBe(2);
  expect((slices[1] as { arcFit: boolean }).arcFit).toBe(false);
  await expect(page.locator("#slice")).toHaveText("Slice");
  await expect(page.locator("#export")).toBeEnabled();
});
