import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

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
  const body = [`;LAYER:${layer.index} Z:${layer.z}`, ";TYPE:OUTER", ...layer.paths[0].pts.map((p: number[]) => `G1 X${p[0]} Y${p[1]} E0.1 F1800`)].join("\n");
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
