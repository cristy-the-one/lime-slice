import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const shots = path.resolve("/opt/cursor/artifacts/sheet-z");
fs.mkdirSync(shots, { recursive: true });

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: cube }));
}

test("the shortcut sheet sits above the layer tip", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.keyboard.press("?");
  await expect(page.locator("#help")).toBeVisible();
  await page.locator("#rangeHigh").focus();
  await expect(page.locator("#layerTip")).toBeVisible();
  const stack = await page.evaluate(() => {
    const tip = document.querySelector<HTMLElement>("#layerTip")!;
    const help = document.querySelector<HTMLElement>("#help")!;
    const calibrate = document.querySelector<HTMLElement>("#calibrate")!;
    const box = tip.getBoundingClientRect();
    tip.style.pointerEvents = "auto";
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      tipZ: Number(getComputedStyle(tip).zIndex),
      helpZ: Number(getComputedStyle(help).zIndex),
      calibrateZ: Number(getComputedStyle(calibrate).zIndex),
      hitHelp: !!hit?.closest("#help"),
    };
  });
  expect(stack.helpZ).toBeGreaterThan(stack.tipZ);
  expect(stack.calibrateZ).toBe(stack.helpZ);
  expect(stack.hitHelp).toBe(true);
  await page.screenshot({ path: path.join(shots, "after-sheet.png") });
});
