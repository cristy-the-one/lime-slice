import { expect, test, type Page } from "@playwright/test";
import { Clip, loadSample, openApp, still } from "./media";

/** The layer slider's top, as a person drags it. */
async function showLayer(page: Page, layer: number) {
  await page.locator("#rangeHigh").evaluate((el: HTMLInputElement, value) => {
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, layer);
}

async function layers(page: Page) {
  return Number(await page.locator("#rangeHigh").getAttribute("max"));
}

/** Wait until the slice the window started has finished: the slider spans the new layers and stays put. */
async function sliced(page: Page) {
  let last = -1;
  for (let i = 0; i < 120; i += 1) {
    const now = await layers(page);
    const busy = await page.locator("body").evaluate(() => document.querySelector("[data-slicing='true'], .slice-progress:not([hidden])") !== null);
    if (now > 0 && now === last && !busy) return now;
    last = now;
    await page.waitForTimeout(1000);
  }
  throw new Error("the slice never finished");
}

/** Closer in on the part in the 3D view. */
async function zoom(page: Page, at: { x: number; y: number }, ticks: number) {
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < ticks; i += 1) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60); }
}

/**
 * Prepare and Preview on samples/overhang_ledge.stl, Lime 220, PLA, speed strategy, with supports turned on from the
 * banner the window shows (organic tree supports by default).
 */
test("overhang with tree supports", async ({ page }) => {
  await openApp(page);
  await loadSample(page, "Overhang");
  await page.getByRole("button", { name: "Turn on supports" }).click();
  await page.locator("#tabPreview").click();
  await sliced(page);
  await page.locator("#tabPrepare").click();
  await page.mouse.move(1100, 900);
  await page.waitForTimeout(800);
  await still(page, "prepare.png");

  await page.locator("#tabPreview").click();
  await zoom(page, { x: 910, y: 480 }, 7);
  await page.waitForTimeout(800);
  await still(page, "preview-3d.png");

  // Scrub from the first layer to the top.
  const top = await layers(page);
  const clip = new Clip(page, { fps: 10, width: 860, colors: 128, clip: { x: 336, y: 40, width: 1104, height: 936 } });
  for (let layer = 0; layer <= top; layer += 2) {
    await showLayer(page, layer);
    await page.waitForTimeout(40);
    await clip.frame(layer === 0 ? 6 : 1);
  }
  await showLayer(page, top);
  await clip.frame(12);
  console.log(`clip-slice.gif ${clip.save("clip-slice.gif")} bytes, ${clip.frames} frames`);

  // The layer where the shelf starts, with the results dock open.
  await showLayer(page, 62);
  await page.locator("#timing").click();
  await page.mouse.move(700, 900);
  await page.waitForTimeout(800);
  await still(page, "layer-estimate.png");
  await page.locator("#timing").click();

  // Settings search.
  const search = page.getByPlaceholder("Search settings");
  await search.fill("bridge");
  await page.waitForTimeout(600);
  await still(page, "settings-search.png");
});
