import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { scrubTravel } from "../src/ui/scrub.ts";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const shots = path.resolve("/opt/cursor/artifacts/plate-scale");
fs.mkdirSync(shots, { recursive: true });

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
}

async function dragScale(page: Page, dx: number, shift = false) {
  const label = page.locator("[data-scrub=scale]");
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

test("dragging Scale changes the one multiplier and re-slices", async ({ page }) => {
  const bodies: { dataB64?: string; pose?: { rotation: number[] } }[] = [];
  await quiet(page);
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: cube });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-scrub=scale]")).toBeVisible();
  await expect(page.locator("#partScale")).toHaveAttribute("step", "5");
  await expect(page.locator("#partScale")).toHaveValue("100");
  await page.screenshot({ path: path.join(shots, "before-scale.png") });

  await dragScale(page, scrubTravel(10));
  await expect(page.locator("#partScale")).toHaveValue("110");
  await expect(page.locator("[data-selected='true'] span").first()).toContainText("22 × 22 × 22");
  await page.screenshot({ path: path.join(shots, "after-scale.png") });
  await page.keyboard.press("Control+z");
  await expect(page.locator("#partScale")).toHaveValue("100");
  await expect(page.locator("[data-selected='true'] span").first()).toContainText("20 × 20 × 20");

  await dragScale(page, scrubTravel(1), true);
  await expect(page.locator("#partScale")).toHaveValue("105");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#partScale")).toHaveValue("100");

  await dragScale(page, 2);
  await expect(page.locator("#partScale")).toHaveValue("100");

  await page.locator("#partScale").fill("395");
  await page.locator("#partScale").blur();
  await page.waitForTimeout(400);
  await dragScale(page, scrubTravel(20));
  await expect(page.locator("#partScale")).toHaveValue("400");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#partScale")).toHaveValue("395");

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  const scaled = bodies[0]!.dataB64;
  await page.keyboard.press("Control+z");
  await expect(page.locator("#partScale")).toHaveValue("100");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]!.dataB64).not.toBe(scaled);
  expect(bodies[1]!.pose?.rotation).toEqual(bodies[0]!.pose?.rotation);
});
