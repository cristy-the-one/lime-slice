import { expect, test, type Page } from "@playwright/test";
import { Clip, loadSample, openApp, still } from "./media";

async function layers(page: Page) {
  return Number(await page.locator("#rangeHigh").getAttribute("max"));
}

async function showLayer(page: Page, layer: number) {
  await page.locator("#rangeHigh").evaluate((el: HTMLInputElement, value) => {
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, layer);
}

/**
 * The 45° belt: samples/overhang_ledge.stl on the Ideaformer IR3 V2 with supports on. The part rides along the belt;
 * the layer readout's Z is the position along it.
 */
test("overhang on the IR3 V2 belt", async ({ page }) => {
  await openApp(page);
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machinePrinter").selectOption("ideaformer-ir3-v2");
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "1");
  await loadSample(page, "Overhang");
  await page.getByRole("button", { name: "Turn on supports" }).click();
  await page.locator("#tabPreview").click();
  let last = -1;
  for (let i = 0; i < 120; i += 1) {
    const now = await layers(page);
    if (now > 0 && now === last) break;
    last = now;
    await page.waitForTimeout(1000);
  }
  // Closer in on the part: the wheel zooms toward the pointer.
  await page.mouse.move(905, 485);
  for (let i = 0; i < 14; i += 1) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60); }
  await page.waitForTimeout(800);
  await still(page, "belt-preview.png");

  const top = await layers(page);
  const clip = new Clip(page, { fps: 10, width: 860, colors: 128, clip: { x: 336, y: 40, width: 1104, height: 936 } });
  const step = Math.max(1, Math.round(top / 60));
  for (let layer = 0; layer <= top; layer += step) {
    await showLayer(page, layer);
    await page.waitForTimeout(40);
    await clip.frame(layer === 0 ? 6 : 1);
  }
  await showLayer(page, top);
  await clip.frame(12);
  console.log(`clip-belt.gif ${clip.save("clip-belt.gif")} bytes, ${clip.frames} frames, ${top + 1} layers`);
});
