import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";
import { serveSliceJob } from "./serve-job";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const beltCube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-belt.json"), "utf8"));

interface Ink {
  n: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
}

/** Bounding box of the pixels that are not the canvas background. */
async function inkOf(page: Page): Promise<Ink> {
  return page.locator("#view").evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return { n: 0, minX: 0, minY: 0, maxX: -1, maxY: -1, width: canvas.width, height: canvas.height };
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const bg = [data[0], data[1], data[2]];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let n = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 30) {
          n++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { n, minX, minY, maxX, maxY, width, height };
  });
}

function framed(ink: Ink, layer: number) {
  expect(ink.n, `layer ${layer} drew nothing`).toBeGreaterThan(20);
  expect(ink.minX, `layer ${layer} left`).toBeGreaterThanOrEqual(2);
  expect(ink.minY, `layer ${layer} top`).toBeGreaterThanOrEqual(2);
  expect(ink.maxX, `layer ${layer} right`).toBeLessThanOrEqual(ink.width - 2);
  expect(ink.maxY, `layer ${layer} bottom`).toBeLessThanOrEqual(ink.height - 2);
  const cx = (ink.minX + ink.maxX) / 2 / ink.width;
  const cy = (ink.minY + ink.maxY) / 2 / ink.height;
  expect(cx, `layer ${layer} center x ${cx}`).toBeGreaterThan(0.32);
  expect(cx, `layer ${layer} center x ${cx}`).toBeLessThan(0.68);
  expect(cy, `layer ${layer} center y ${cy}`).toBeGreaterThan(0.32);
  expect(cy, `layer ${layer} center y ${cy}`).toBeLessThan(0.68);
  const fill = Math.max((ink.maxX - ink.minX) / ink.width, (ink.maxY - ink.minY) / ink.height);
  expect(fill, `layer ${layer} fill ${fill}`).toBeGreaterThanOrEqual(0.72);
}

async function showLayer(page: Page, layer: number) {
  await page.locator("#rangeHigh").evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, layer);
}

async function open2d(page: Page, printer: "belt" | "cartesian") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  if (printer === "belt") await page.locator("#machinePrinter").selectOption({ label: "Generic belt 45°" });
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "2D", exact: true }).click();
  await expect(page.locator("#stage")).toHaveClass(/mode-flat/);
  await expect.poll(async () => page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => Number(el.max))).toBeGreaterThan(10);
  await page.locator(".toast-close").click({ timeout: 1000 }).catch(() => {});
}

test("a belt layer stays inside the 2D canvas, and drag and zoom move it", async ({ page }) => {
  await quiet(page);
  await serveSliceJob(page, beltCube);
  await open2d(page, "belt");

  const max = await page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => Number(el.max));
  for (const layer of [0, 20, 40, 70, 100, max]) {
    await showLayer(page, layer);
    framed(await inkOf(page), layer);
  }

  const scale40 = await page.locator("#view").getAttribute("data-flat-scale");
  await showLayer(page, 45);
  framed(await inkOf(page), 45);
  const scale45 = await page.locator("#view").getAttribute("data-flat-scale");
  expect(Math.abs(Number(scale45) - Number(scale40)) / Number(scale40)).toBeLessThan(0.12);

  await page.locator("#layerPrev").click();
  await expect(page.locator("#rangeHigh")).toHaveValue("44");
  framed(await inkOf(page), 44);
  await page.locator("#layerNext").click();
  await expect(page.locator("#rangeHigh")).toHaveValue("45");

  const before = await inkOf(page);
  const box = (await page.locator("#view").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 50, { steps: 12 });
  await page.mouse.up();
  const dragged = await inkOf(page);
  const beforeCx = (before.minX + before.maxX) / 2;
  const beforeCy = (before.minY + before.maxY) / 2;
  const afterCx = (dragged.minX + dragged.maxX) / 2;
  const afterCy = (dragged.minY + dragged.maxY) / 2;
  expect(afterCx - beforeCx).toBeGreaterThan(70);
  expect(afterCy - beforeCy).toBeGreaterThan(25);
  expect(await page.locator("#view").getAttribute("data-flat-mode")).toBe("user");

  const zoomedOut = Number(await page.locator("#view").getAttribute("data-flat-scale"));
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -240);
  const zoomedIn = Number(await page.locator("#view").getAttribute("data-flat-scale"));
  expect(zoomedIn).toBeGreaterThan(zoomedOut * 1.2);

  const panScale = zoomedIn;
  await page.mouse.wheel(80, 0);
  expect(Number(await page.locator("#view").getAttribute("data-flat-scale"))).toBeCloseTo(panScale, 3);
  const panned = await inkOf(page);
  expect(panned.n).toBeGreaterThan(20);

  await showLayer(page, 0);
  const jumped = await inkOf(page);
  expect(jumped.n).toBeGreaterThan(20);
  const jumpedCx = (jumped.minX + jumped.maxX) / 2;
  const jumpedCy = (jumped.minY + jumped.maxY) / 2;
  expect(jumpedCx).toBeGreaterThan(0);
  expect(jumpedCx).toBeLessThan(jumped.width);
  expect(jumpedCy).toBeGreaterThan(0);
  expect(jumpedCy).toBeLessThan(jumped.height);
  await showLayer(page, 45);

  await page.locator("#flatFit").click();
  expect(await page.locator("#view").getAttribute("data-flat-mode")).toBe("fit");
  framed(await inkOf(page), 45);

  const fitBox = await page.locator("#flatFit").boundingBox();
  expect(fitBox?.height ?? 99).toBeLessThanOrEqual(22);
  expect(fitBox?.width ?? 99).toBeLessThanOrEqual(48);

  const share = await page.evaluate(() => {
    const canvas = document.querySelector("#view")!.getBoundingClientRect();
    const body = document.querySelector("#previewBody")!.getBoundingClientRect();
    return { canvas, body, viewW: window.innerWidth, viewH: window.innerHeight };
  });
  const ofPreview = (share.canvas.width * share.canvas.height) / (share.body.width * share.body.height);
  expect(ofPreview, `2D canvas share of the preview ${ofPreview}`).toBeGreaterThanOrEqual(0.7);

  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect(page.locator("#stage")).toHaveClass(/mode-solid/);
  await expect(page.locator("#view3d")).toBeVisible();
  await expect(page.locator("#view3d")).toHaveAttribute("data-projection", "perspective");
  await page.locator("#layerPrev").click();
  await expect(page.locator("#rangeHigh")).toHaveValue("44");
});

test("cartesian 2D still frames the current layer", async ({ page }) => {
  await quiet(page);
  await serveSliceJob(page, cube);
  await open2d(page, "cartesian");
  const max = await page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => Number(el.max));
  const mid = Math.floor(max / 2);
  for (const layer of [0, mid, max]) {
    await showLayer(page, layer);
    framed(await inkOf(page), layer);
  }
  const first = Number(await page.locator("#view").getAttribute("data-flat-scale"));
  await showLayer(page, mid);
  const second = Number(await page.locator("#view").getAttribute("data-flat-scale"));
  expect(Math.abs(second - first) / first).toBeLessThan(0.12);
});

test.describe("phone preview", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the preview canvas stays at least 70% of the screen", async ({ page }) => {
    await quiet(page);
    await serveSliceJob(page, cube);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await page.locator("#slice").click();
    await page.locator("#compactTabs [data-tab=preview]").click();
    await expect.poll(async () => page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => Number(el.max))).toBeGreaterThan(10);
    const share = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
    }, "#view3d");
    expect(share).not.toBeNull();
    const ratio = canvasShare({ width: share!.width, height: share!.height }, { width: share!.viewW, height: share!.viewH });
    expect(ratio, `preview share ${ratio}`).toBeGreaterThanOrEqual(0.7);
  });
});
