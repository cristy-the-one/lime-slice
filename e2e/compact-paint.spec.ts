import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share";

const out = path.resolve("artifacts/compact");
fs.mkdirSync(out, { recursive: true });

async function share(page: Page, selector: string) {
  const box = await page.evaluate((sel) => {
    const rect = document.querySelector(sel)!.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
  }, selector);
  return canvasShare({ width: box.width, height: box.height }, { width: box.viewW, height: box.viewH });
}

test.describe("compact support paint", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("one finger paints at the peek, with 44 px tools and the canvas at 70%", async ({ page }) => {
    const sent: unknown[] = [];
    await page.addInitScript(() => {
      localStorage.setItem("lime-slice-theme", "dark");
      localStorage.setItem("lime-slice-settings-level", "simple");
    });
    await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
    await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
    await page.route("**/api/slice", (route) => {
      sent.push(route.request().postDataJSON()?.supportPaint);
      return route.fulfill({ status: 500, json: { error: "not under test" } });
    });
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="lime_hull.stl"]')?.click());
    await expect(page.locator("#compactFile")).toContainText("lime_hull");
    await page.waitForTimeout(400);

    await page.locator('#toolRail [data-tool="paint"]').tap();
    const bar = page.locator("#paintBar");
    await expect(bar).toBeVisible();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const targets = ['#toolRail [data-tool="paint"]', '#paintBar [data-kind="enforce"]', '#paintBar [data-kind="block"]', "#brushRadius", "#paintClear", "#paintDone"];
    for (const selector of targets) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(Math.min(box.width, box.height), `${selector} is ${box.width}×${box.height}`).toBeGreaterThanOrEqual(44);
    }
    const barBox = (await bar.boundingBox())!;
    const sliceBox = (await page.locator("#slice").boundingBox())!;
    expect(barBox.y + barBox.height, "the bar clears the Slice button").toBeLessThanOrEqual(sliceBox.y);
    const peek = await share(page, "#prepare");
    expect(peek, `prepare share with the brush on ${peek}`).toBeGreaterThanOrEqual(0.7);

    await bar.locator('[data-kind="enforce"]').tap();
    const canvas = page.locator("#prepare");
    const box = (await canvas.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.45);
    await expect(canvas).toHaveAttribute("data-paint-disks", "1");
    await expect(page.locator("html")).not.toHaveClass(/chrome-hidden/);
    await expect(bar).toHaveAttribute("data-enforce", "1");
    await page.screenshot({ path: path.join(out, "paint-peek.png") });
    console.log(`compact paint: prepare share ${peek.toFixed(3)} with the brush on`);

    await page.locator("#paintDone").tap();
    await expect(bar).toBeHidden();
    for (const paint of sent) expect(paint).toEqual([{ kind: "enforce", p: expect.any(Array), n: expect.any(Array), r: 3 }]);
  });
});
