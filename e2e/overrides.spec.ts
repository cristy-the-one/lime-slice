import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
}

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

test("ranges and volumes are stored and drawn, and a slice does not send them", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await quiet(page);
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  await page.goto("/");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#status")).toContainText("loaded");
  await page.locator("#heightAdd").click();
  await expect(page.locator("#toasts").getByRole("status").filter({ hasText: "Overrides are stored but not yet sliced." })).toBeVisible();
  await expect(page.locator("[data-range]")).toHaveCount(1);
  await expect(page.locator("[data-range] input[data-field=zFrom]")).toHaveValue("0");
  await expect(page.locator("[data-range] input[data-field=zTo]")).toHaveValue("4");
  await expect(page.locator("[data-range] input[data-field=infill]")).toHaveValue("40");
  await expect(page.locator("#rangeBands .range-band")).toHaveCount(1);
  await expect(page.locator("#viewportBands .range-band")).toHaveCount(1);

  await page.locator("#volumeBox").click();
  await expect(page.locator("[data-volume]")).toHaveCount(1);
  await expect(page.locator("#prepare")).toHaveAttribute("data-modifier-volumes", "1");
  await expect(page.locator("#prepare")).toHaveAttribute("data-modifier-ranges", "1");
  await expect(page.locator("#prepare")).toHaveAttribute("data-modifier-gizmo", "move");
  const x = page.locator("[data-volume] input[data-field=x]");
  await expect(x).toHaveValue("110");
  await page.locator("#modToolScale").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-modifier-gizmo", "scale");
  await page.locator("#modToolMove").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-modifier-gizmo", "move");

  await page.locator("#tabPrepare").click();
  const canvas = page.locator("#prepare");
  await expect(canvas).not.toHaveAttribute("data-modifier-nx", "");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const nx = Number(await canvas.getAttribute("data-modifier-nx"));
  const ny = Number(await canvas.getAttribute("data-modifier-ny"));
  const startX = box!.x + nx * box!.width;
  const startY = box!.y + ny * box!.height;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 70, startY, { steps: 10 });
  await page.mouse.up();
  await expect(x).not.toHaveValue("110");

  await page.locator("#undoEdit").click();
  await expect(x).toHaveValue("110");
  await page.locator("#modToolScale").click();
  await expect(canvas).toHaveAttribute("data-modifier-gizmo", "scale");
  const sx = page.locator("[data-volume] input[data-field=sx]");
  await expect(sx).toHaveValue("30");
  const snx = Number(await canvas.getAttribute("data-modifier-nx"));
  const sny = Number(await canvas.getAttribute("data-modifier-ny"));
  const scaleX = box!.x + snx * box!.width;
  const scaleY = box!.y + sny * box!.height;
  await page.mouse.move(scaleX, scaleY);
  await page.mouse.down();
  await page.mouse.move(scaleX + 60, scaleY, { steps: 8 });
  await page.mouse.up();
  await expect(sx).not.toHaveValue("30");
  await page.locator("#undoEdit").click();
  await expect(sx).toHaveValue("30");

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  const sent = bodies[0];
  expect(sent).not.toHaveProperty("heightRanges");
  expect(sent).not.toHaveProperty("modifierVolumes");
  expect(sent).not.toHaveProperty("overrides");
  await expect(page.locator("#toasts").getByRole("status").filter({ hasText: "Overrides are stored but not yet sliced." }).first()).toBeVisible();
});

test.describe("compact overrides", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("the prepare canvas stays in front at the peek", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare viewport share ${prepare}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#compactTabs [data-tab=settings]").click();
    await expect(page.locator("#heightAdd")).toBeVisible();
    await expect(page.locator("#volumeBox")).toBeVisible();
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    const peeked = await share(page, "#prepare");
    expect(peeked, `peek viewport share ${peeked}`).toBeGreaterThanOrEqual(0.7);
  });
});
