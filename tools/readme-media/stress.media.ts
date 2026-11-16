import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { facePoints, openStress, openStressModel } from "../../e2e/stress-mock";
import { ROOT, still } from "./media";

/**
 * Stress, the README's worked example: a 100 x 10 x 10 mm PLA cantilever held at one end, 20 N down on the other. The
 * solve is the real engine's reply for that study (e2e/fixtures/sim-cantilever.json, written by mcp/sim-paint.test.ts),
 * as e2e/stress-cantilever.spec.ts uses it; the steps here are that spec's.
 */
const CANTILEVER = readFileSync(join(ROOT, "e2e/fixtures/sim-cantilever.json"), "utf8");

async function pick(page: Page, which: "Hold" | "Load", at: { x: number; y: number }) {
  await page.locator(`#stress${which}Pick`).click();
  await page.mouse.click(at.x, at.y);
  await expect(page.locator(`#stress${which}Chips .stress-chip`)).toHaveCount(1);
  await page.locator(`#stress${which}Pick`).click();
}

test("the cantilever painted by stress", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await openStressModel(page, CANTILEVER, { width: 1440, height: 1000 }, [100, 10, 10]);
  await page.addStyleTag({ content: ".lime-tip { display: none !important; }" });
  await openStress(page);
  let faces = await facePoints(page);
  await pick(page, "Load", faces.get(5)!);
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.move(box.x + box.width - 60, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 460, box.y + 80, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(2500);
  faces = await facePoints(page);
  await page.locator("#stressHoldFaces").click();
  await pick(page, "Hold", faces.get(4)!);
  await page.locator("#stressForce").fill("20");
  await page.locator("#stressForce").press("Tab");
  await page.locator("#stressCard").selectOption("inhouse-pla");
  await page.locator("#stressRun").click();
  await expect(page.locator("#model")).toHaveAttribute("data-stress", /shown [1-9]/);
  await expect(page.locator("#stressLegend")).toBeVisible();
  await page.mouse.move(890, 510);
  for (let i = 0; i < 3; i += 1) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60); }
  await page.mouse.move(box.x + box.width - 40, box.y + box.height - 40);
  await page.waitForTimeout(800);
  await still(page, "stress-cantilever.png");
});
