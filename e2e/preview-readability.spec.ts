import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const out = "/opt/cursor/artifacts/preview-edges";
fs.mkdirSync(out, { recursive: true });

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

test("feature-colored 3D preview keeps bead margins and the print head on the part", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (msg) => logs.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`pageerror: ${err.message}`));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: cube }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.waitForTimeout(1200);
  const zoom = async () => {
    await page.locator("#view3d").evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      for (let i = 0; i < 12; i++) {
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -350, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      }
    });
  };
  await zoom();
  await page.waitForTimeout(800);
  await zoom();
  await page.waitForTimeout(250);
  expect(logs.filter((line) => line.startsWith("pageerror:") || line.startsWith("error:"))).toEqual([]);
  await page.locator("#view3d").screenshot({ path: path.join(out, "after-feature-3d.png") });

  await page.locator("#move").evaluate((el) => {
    const input = el as HTMLInputElement;
    const max = Number(input.max);
    input.value = String(Math.max(0, Math.floor(max * 0.45)));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#playReadout")).toContainText("mm/s");
  await page.waitForTimeout(300);
  await page.locator("#view3d").screenshot({ path: path.join(out, "after-playhead.png") });
});
