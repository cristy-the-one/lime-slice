import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { Clip, ROOT, openApp, still } from "./media";

/** The open solid's volume, as the readout says it. */
async function volume(page: Page): Promise<number> {
  const text = (await page.locator("#modelReadout").textContent()) ?? "";
  const match = /Volume ([\d.,]+) mm³/.exec(text);
  return match ? Number(match[1]!.replace(/,/g, "")) : Number.NaN;
}

/** Type into the size boxes by the pointer, one frame per box. */
async function typed(page: Page, clip: Clip, values: string[]) {
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  for (const [index, value] of values.entries()) {
    await hud.locator("input").nth(index).fill(value);
    await clip.frame(4);
    await hud.locator("input").nth(index).press(index === values.length - 1 ? "Enter" : "Tab");
  }
}

/** Frames until the kernel's volume reads `want`. */
async function until(page: Page, clip: Clip, want: number) {
  for (let i = 0; i < 300; i += 1) {
    if (Math.abs((await volume(page)) - want) < 1) return;
    await clip.frame();
  }
  throw new Error(`the volume never read ${want}`);
}

/**
 * Model, on the real kernel: a rectangle sketched on the bed, extruded, a circle sketched and cut through from below,
 * then the first step edited from History. One clip and the still at its end.
 */
test("sketch to solid", async ({ page }) => {
  await openApp(page);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelEmptySketch")).toBeVisible();
  const canvas = page.locator("#model");
  const clip = new Clip(page, { fps: 8, width: 900, colors: 96 });
  await page.mouse.move(700, 500);
  await page.waitForTimeout(800);
  await clip.frame(6);
  await page.locator("#modelEmptySketch").click();
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await clip.frame(4);

  // A 40 x 24 rectangle, typed.
  await page.locator("[data-sketch-tool=rectangle]").click();
  await page.mouse.move(centre.x - 60, centre.y - 40);
  await clip.frame(2);
  await page.mouse.click(centre.x - 60, centre.y - 40);
  await clip.frame(2);
  await typed(page, clip, ["40", "24"]);
  await clip.frame(6);

  // Extrude 16 mm.
  await page.keyboard.press("E");
  await clip.frame(4);
  await typed(page, clip, ["16"]);
  await until(page, clip, 40 * 24 * 16);
  await clip.frame(8);

  // A 10 mm circle on the bed, cut 16 mm up through the block.
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await clip.frame(3);
  await page.locator("[data-sketch-tool=circle]").click();
  await page.mouse.click(centre.x, centre.y);
  await typed(page, clip, ["10"]);
  await clip.frame(3);
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await page.locator("[data-sketch-mode=cut]").click();
  await clip.frame(3);
  await typed(page, clip, ["16"]);
  await until(page, clip, 40 * 24 * 16 - Math.PI * 25 * 16);
  await page.mouse.move(box.x + box.width - 40, box.y + 40);
  await clip.frame(10);

  // History: edit the extrude down to 12 mm; the cut is replayed on the lower block.
  const rows = page.locator("#modelHistoryTree .mh-row");
  await expect(rows).toHaveCount(2);
  await rows.first().locator(".mh-edit").click();
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await clip.frame(4);
  await typed(page, clip, ["12"]);
  await until(page, clip, 40 * 24 * 12 - Math.PI * 25 * 12);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30);
  await page.waitForTimeout(500);
  await clip.frame(14);
  await still(page, "model-history.png");
  console.log(`clip-model.gif ${clip.save("clip-model.gif")} bytes, ${clip.frames} frames`);
});

/** Text wrapped round a cylinder (made over MCP by tools/readme-media/mcp-media.ts), opened in Model. */
test("lettering on a curved face", async ({ page }) => {
  await openApp(page);
  await page.locator("#projectFile").setInputFiles(join(ROOT, "artifacts/readme-media/lettering.lime"));
  await expect(page.locator("#objectList .obj")).toHaveCount(1, { timeout: 60_000 });
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume", { timeout: 120_000 });
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 2; i += 1) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60); }
  await page.mouse.move(box.x + box.width - 40, box.y + box.height - 40);
  await page.waitForTimeout(1200);
  await still(page, "model-text.png");
});

/** Split to print: a 320 mm bar is too long for the Lime 220, and the card proposes where to cut it. */
test("split to print", async ({ page }) => {
  await openApp(page);
  await page.locator("#tabModel").click();
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="box"]').click();
  for (const [id, value] of Object.entries({ modelDx: 320, modelDy: 60, modelDz: 30 })) await page.locator(`#${id}`).fill(String(value));
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume", { timeout: 60_000 });
  await expect(page.locator("#modelPanel")).toBeHidden();
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuSplitPrint").click();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Split to print");
  await expect(page.locator("#modelPartPieces li").first()).toBeVisible({ timeout: 30_000 });
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.move(box.x + box.width - 40, box.y + box.height - 40);
  await page.waitForTimeout(1500);
  await still(page, "model-split.png");
});
