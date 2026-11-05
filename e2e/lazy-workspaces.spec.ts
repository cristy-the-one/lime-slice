import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid } from "./model-tree-mock";

/**
 * Model, Sketch, Stress, Split to print and Plugins load on first use (src/app/workspaces.ts). These hold Model's chunk
 * back, so the first use comes before it, as on a slow disk: the use waits for it and is never lost.
 */

type V = [number, number, number];

/** A box the modeler reports as a solid. */
function boxSolid(size: V): MockSolid {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [x * sx, y * sy, z * sz];
  const quads: V[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((q, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const pa = corners[a!]!;
    const pb = corners[b!]!;
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges };
}

const ROOT = boxSolid([20, 20, 10]);
const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
const volume = (dx: number) => `Volume ${400 * dx} mm³`;
const readout = (page: Page) => page.locator("#modelReadout");
const labels = (page: Page) => page.locator("#modelHistoryTree .mh-label");

/** A box cut leaves a 20 × 20 slab as tall as the box's Size X, so each step's volume names its numbers. */
function built(request: Body): Built {
  const op = request.op as { size?: number[] };
  return boxSolid([20, 20, op.size![0]!]);
}

async function mockEngine(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: ROOT.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  return mockModelTree(page, { open: () => ROOT, apply: built });
}

/** Holds Model's chunk until `release`, and counts the requests for it. */
async function holdModelChunk(page: Page) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = { requests: 0, release: () => release() };
  await page.route(/\/assets\/model-workspace-[^/]*\.js$/, async (route) => {
    held.requests += 1;
    await gate;
    await route.fallback();
  });
  return held;
}

async function cut(page: Page, dx: number) {
  if ((await page.locator("#modelToolBoolean").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  await page.locator("#modelDx").fill(String(dx));
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText(volume(dx));
}

test("Model is not in the page at start, and loads by itself once the window is idle", async ({ page }) => {
  await page.goto("/");
  // Prepare and Preview are there; Model's parts are not written yet, its tab and frame are.
  await expect(page.locator("#tabModel")).toBeVisible();
  await expect(page.locator("#modelBody")).toHaveCount(1);
  // The prefetch writes them hidden, with the ids they always had, and the rail takes Model's set and foot.
  await expect(page.locator("#modelDock")).toHaveCount(1);
  await expect(page.locator("#toolRail #railModel")).toBeHidden();
  await expect(page.locator("#toolRail .rail-foot #railModelFoot")).toBeHidden();
  await expect(page.locator("#modelInspect")).toBeHidden();
  await expect(page.locator("#model")).toHaveCount(1);
});

test("a click on Model before its code has loaded shows the empty frame at once, and a working Model view once it loads", async ({ page }) => {
  await mockEngine(page);
  const held = await holdModelChunk(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  // The frame: the Model tab is on, Settings and Results step aside, and nothing of Model is written yet.
  await expect(page.locator("#tabModel")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#modelBody")).toBeVisible();
  await expect(page.locator("#left")).toBeHidden();
  expect(await page.locator("#model").count(), "Model's view is not there before its code").toBe(0);
  expect(held.requests, "the click asked for Model's code").toBeGreaterThan(0);
  held.release();
  // The click was kept: Model opens the plate's solid without a second click.
  await expect(readout(page)).toContainText(volume(10));
  await expect(page.locator("#model")).toBeVisible();
  await expect(page.locator("#modelDock")).toBeVisible();
  await expect(page.locator("#toolRail #railModel")).toBeVisible();
  await expect(labels(page)).toHaveText(["plate.step"]);
  // And it works: a cut builds a step.
  await cut(page, 8);
  await expect(labels(page)).toHaveText(["plate.step", "Cut box 8×10×10"]);
});

test("keys pressed before Model has loaded run once it loads", async ({ page }) => {
  await mockEngine(page);
  const held = await holdModelChunk(page);
  await page.goto("/");
  await expect(page.locator("#tabPreview")).toHaveAttribute("aria-selected", "true");
  // 4 is the Model tab's key and Shift+N opens New solid there. Both are pressed before Model's code has arrived.
  await page.keyboard.press("4");
  await expect(page.locator("#tabModel")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Shift+N");
  expect(await page.locator("#modelToolNew").count(), "Model has not loaded").toBe(0);
  held.release();
  await expect(page.locator("#modelToolNew"), "the queued Shift+N opened New solid").toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelPanel")).toBeVisible();
});

test("a project with Model steps opens from a cold start: Model loads before the steps are taken back", async ({ page }) => {
  await mockEngine(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(10));
  await cut(page, 8);
  await cut(page, 6);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  const saved = await readFile((await download.path())!);

  // A fresh page with Model's code held back: the open has to wait for it.
  const held = await holdModelChunk(page);
  await page.reload();
  await expect(page.locator("#tabModel")).toBeVisible();
  expect(await page.locator("#modelDock").count(), "Model has not loaded").toBe(0);
  await page.locator("#projectFile").setInputFiles({ name: "plate.lime", mimeType: "application/json", buffer: saved });
  await expect.poll(() => held.requests, { message: "the open asks for Model's code" }).toBeGreaterThan(0);
  await expect(page.locator("#projectTitle"), "the open waits for Model").toHaveText("Untitled");
  held.release();
  await expect(page.locator("#projectTitle")).toHaveText("plate.lime");
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(readout(page), "Model opens on the step the plate holds").toContainText(volume(6));
  await expect(labels(page)).toHaveText(["plate.step", "Cut box 8×10×10", "Cut box 6×10×10"]);
});
