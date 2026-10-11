import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";
import { autoSliceOff } from "./auto-slice";

const shots = path.resolve("/opt/cursor/artifacts/compact-gizmo");
fs.mkdirSync(shots, { recursive: true });

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#prepare")).toHaveAttribute("data-cam", /.+/);
  await expect(page.locator("#prepare")).toHaveAttribute("data-gizmo-px", /.+/);
}

async function share(page: Page) {
  const box = await page.evaluate(() => {
    const rect = document.querySelector("#prepare")!.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
  });
  return canvasShare({ width: box.width, height: box.height }, { width: box.viewW, height: box.viewH });
}

test.describe("phone prepare", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the gizmo shrinks and the solid sits clear of it", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await autoSliceOff(page);
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await loadCube(page);
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await expect.poll(async () => share(page), { timeout: 3_000 }).toBeGreaterThanOrEqual(0.7);
    await expect(page.locator("#prepare")).toHaveAttribute("data-gizmo-px", "56");
    const pan = Number(await page.locator("#prepare").getAttribute("data-frame-pan"));
    expect(pan).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(shots, "after-phone.png") });
  });
});

test("a desktop prepare keeps the 88px gizmo and a centred frame", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await expect(page.locator("#prepare")).toHaveAttribute("data-gizmo-px", "88");
  await expect(page.locator("#prepare")).toHaveAttribute("data-frame-pan", "0");
  const home = await page.locator("#prepare").getAttribute("data-cam");
  await page.locator("#viewPresets button").nth(0).click();
  await expect.poll(() => page.locator("#prepare").getAttribute("data-cam")).not.toBe(home);
  await expect(page.locator("#prepare")).toHaveAttribute("data-frame-pan", "0");
  await page.locator("[data-plate-frame=part]").click();
  await expect.poll(() => page.locator("#prepare").getAttribute("data-cam")).toBe(home);
});
