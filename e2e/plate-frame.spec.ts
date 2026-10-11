import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";
import { autoSliceOff } from "./auto-slice";

const shots = path.resolve("/opt/cursor/artifacts/plate-frame");
fs.mkdirSync(shots, { recursive: true });

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-frame=part]")).toBeVisible();
  await expect(page.locator("#prepare")).toHaveAttribute("data-cam", /.+/);
}

async function share(page: Page) {
  const box = await page.evaluate(() => {
    const el = document.querySelector("#prepare");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
  });
  expect(box).not.toBeNull();
  return canvasShare({ width: box!.width, height: box!.height }, { width: box!.viewW, height: box!.viewH });
}

async function cam(page: Page) {
  return page.locator("#prepare").getAttribute("data-cam");
}

async function framed(page: Page) {
  return page.locator("#prepare").getAttribute("data-framed");
}

test("Frame shows the named solid and does not become an undo step", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await page.screenshot({ path: path.join(shots, "before-frame.png") });
  const home = await cam(page);
  const homeBox = await framed(page);

  await page.locator("#viewPresets button").nth(0).click();
  await expect.poll(() => cam(page)).not.toBe(home);
  expect(await framed(page)).toBe(homeBox);
  await page.screenshot({ path: path.join(shots, "during-top.png") });

  await page.locator("[data-plate-frame=part]").click();
  await expect.poll(() => cam(page)).toBe(home);
  await page.screenshot({ path: path.join(shots, "after-frame.png") });

  const beforeX = Number(await page.locator("#placeX").inputValue());
  await page.locator("#placeX").fill(String(beforeX + 30));
  await page.locator("#placeX").blur();
  await page.waitForTimeout(400);
  await page.locator("#viewPresets button").nth(0).click();
  await page.locator("[data-plate-frame=part]").click();
  await page.locator("[data-plate-frame=part]").click();
  const framedCam = await cam(page);
  await page.keyboard.press("Control+z");
  await expect.poll(() => page.locator("#placeX").inputValue().then(Number)).toBeCloseTo(beforeX, 1);
  expect(await cam(page)).toBe(framedCam);

  const prepare = page.locator("#prepare");
  const box = (await prepare.boundingBox())!;
  const still = await cam(page);
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.45);
  expect(await cam(page)).toBe(still);

  await page.locator("#plateDuplicate").click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  const afterAdd = await cam(page);
  await page.locator("[data-plate-select=part]").click();
  expect(await cam(page)).toBe(afterAdd);
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");

  const packedBefore = await framed(page);
  await page.locator("#plateArrange").click();
  await expect.poll(() => framed(page)).not.toBe(packedBefore);
  await page.screenshot({ path: path.join(shots, "after-arrange.png") });
  const packedCam = await cam(page);
  await page.keyboard.press("Control+z");
  await expect(page.locator("#plateOverlap")).toContainText("overlaps");
  expect(await cam(page)).toBe(packedCam);

  await page.locator("#plateArrange").click();
  await page.locator("[data-plate-remove]").first().click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);
  await expect.poll(() => framed(page)).not.toBe(packedBefore);
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
});

test.describe("compact frame", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("framing does not resize the sheet", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await autoSliceOff(page);
    await loadCube(page);
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const shareOf = await share(page);
    expect(shareOf, `peek share ${shareOf}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#compactTabs [data-tab=settings]").click();
    await page.locator("[data-plate-frame=part]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "half");
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    // The sheet height animates. The canvas share is the settled peek, not a mid-transition frame.
    await expect.poll(async () => share(page), { timeout: 3_000 }).toBeGreaterThanOrEqual(0.7);
  });
});
