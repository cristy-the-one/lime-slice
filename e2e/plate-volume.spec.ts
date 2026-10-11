import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { scrubTravel } from "../src/ui/scrub.ts";
import { autoSliceOff } from "./auto-slice";

const shots = path.resolve("/opt/cursor/artifacts/volume-scrub");
fs.mkdirSync(shots, { recursive: true });

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
}

async function dragVolumeName(page: Page, dx: number, shift = false) {
  const label = page.locator("[data-volume] [data-scrub=scale]");
  await label.scrollIntoViewIfNeeded();
  const box = (await label.boundingBox())!;
  const x = box.x + 8;
  const y = box.y + box.height / 2;
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
}

test("dragging a volume name scales the part, once, and does not open the row", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await page.locator("#volumeBox").click();
  const name = page.locator("[data-volume] [data-scrub=scale]");
  await expect(name).toHaveText("Box");
  await expect(page.locator("#partScale")).toHaveValue("100");
  await expect(page.locator("[data-volume]")).not.toHaveAttribute("open");
  await expect(page.locator("[data-volume] .mod-val")).toContainText("30 × 30 × 20");

  await dragVolumeName(page, scrubTravel(10));
  await expect(page.locator("#partScale")).toHaveValue("110");
  await expect(page.locator("[data-selected='true'] span").first()).toContainText("22 × 22 × 22");
  await expect(page.locator("[data-volume] .mod-val")).toContainText("30 × 30 × 20");
  await expect(page.locator("[data-volume]")).not.toHaveAttribute("open");
  await page.screenshot({ path: path.join(shots, "after-volume.png") });
  await page.keyboard.press("Control+z");
  await expect(page.locator("#partScale")).toHaveValue("100");
  await expect(page.locator("[data-selected='true'] span").first()).toContainText("20 × 20 × 20");
  await expect(page.locator("[data-volume]")).toHaveCount(1);

  await dragVolumeName(page, scrubTravel(1), true);
  await expect(page.locator("#partScale")).toHaveValue("105");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#partScale")).toHaveValue("100");

  await dragVolumeName(page, 2);
  await expect(page.locator("#partScale")).toHaveValue("100");
  await expect(page.locator("[data-volume]")).not.toHaveAttribute("open");

  await name.click();
  await expect(page.locator("[data-volume]")).toHaveAttribute("open", "");
  await expect(page.locator("#partScale")).toHaveValue("100");
});
