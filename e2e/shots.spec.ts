import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const out = path.resolve("artifacts/ui-v3");
fs.mkdirSync(out, { recursive: true });

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const hull = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/hull-speed.json"), "utf8"));

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(out, name) });
}

test("ui states from real slice fixtures", async ({ page }) => {
  let delay = 0;
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", async (route) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const name = route.request().postDataJSON()?.filename as string;
    const body = name?.includes("hull") ? hull : cube;
    await route.fulfill({ json: body });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await shot(page, "v3-01-empty.png");

  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
  await shot(page, "v3-02-loaded.png");

  await page.getByRole("button", { name: /^Speed/ }).click();
  await page.locator("#right").screenshot({ path: path.join(out, "v3-03-card-speed.png") });
  await page.getByRole("button", { name: /^Efficiency/ }).click();
  await page.locator("#right").screenshot({ path: path.join(out, "v3-04-card-efficiency.png") });
  await page.getByRole("button", { name: /^Toughness/ }).click();
  await page.locator("#right").screenshot({ path: path.join(out, "v3-05-card-toughness.png") });
  await page.getByRole("button", { name: /^Speed/ }).click();

  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("1.84 g");
  await expect(page.locator(".chip").first()).toBeVisible();

  await page.getByRole("button", { name: /^By layer/ }).click();
  await expect(page.locator("#layerBand")).toBeVisible();
  await page.locator("#vslider").screenshot({ path: path.join(out, "v3-06-layer-blend.png") });

  await page.getByRole("button", { name: /^By region/ }).click();
  await page.locator("#at").fill("10");
  await page.locator("#at").dispatchEvent("change");
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.waitForTimeout(400);
  await page.locator("#view3d").screenshot({ path: path.join(out, "v3-07-region-blend-plane.png") });

  await page.getByRole("button", { name: /^Speed/ }).click();
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "60 mm hull" }).click();
  delay = 2500;
  await page.locator("#slice").click();
  await expect(page.locator("[data-state=slicing]")).toBeVisible();
  await shot(page, "v3-08-slicing-progress.png");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#banner")).toContainText("cancelled");
  await shot(page, "v3-09-cancelled.png");

  delay = 0;
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("4.66 g");
  const mid = Math.floor(hull.layers.length / 2);
  await page.locator("#rangeHigh").evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, mid);
  await page.locator("#legend label", { hasText: "Travel" }).locator("input").check();
  await page.getByRole("button", { name: "2D", exact: true }).click();
  await page.waitForTimeout(200);
  await page.locator("#view").screenshot({ path: path.join(out, "v3-12-preview-2d.png") });
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await page.waitForTimeout(300);
  await page.locator(".previews").screenshot({ path: path.join(out, "v3-17-split.png") });
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.waitForTimeout(400);
  await page.locator("#view3d").screenshot({ path: path.join(out, "v3-13-preview-3d.png") });

  await page.locator("#legend label", { hasText: "Outer wall" }).locator("input").uncheck();
  await page.locator("#legend").screenshot({ path: path.join(out, "v3-14-legend-toggles.png") });

  await page.locator("#estimate").scrollIntoViewIfNeeded();
  await page.locator("#estimate").screenshot({ path: path.join(out, "v3-15-estimate-card.png") });

  await page.setViewportSize({ width: 960, height: 800 });
  await page.waitForTimeout(250);
  await shot(page, "v3-16-narrow-960.png");
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.locator("#lh").fill("0.28");
  await page.locator("#lh").dispatchEvent("change");
  await expect(page.getByRole("button", { name: "Re-slice" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export G-code" })).toBeDisabled();
  await shot(page, "v3-10-stale.png");

  await page.unroute("**/api/health");
  await page.route("**/api/health", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#banner")).toContainText("Slicer engine not running");
  await shot(page, "v3-11-error-banner.png");
});
