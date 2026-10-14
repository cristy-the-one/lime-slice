import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { scrubTravel } from "../src/ui/scrub.ts";
import { autoSliceOff } from "./auto-slice";
import { serveSliceJob } from "./serve-job";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const shots = path.resolve("/opt/cursor/artifacts/numeric-controls");
fs.mkdirSync(shots, { recursive: true });

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
}

async function loadCube(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await expect(page.locator("#placeRx")).toBeVisible();
}

test("typed rotation stays with a 90 degree step", async ({ page }) => {
  await quiet(page);
  await loadCube(page);
  await expect(page.locator("#placeRx")).toHaveValue("0.0");
  await expect(page.locator("#placeRy")).toHaveValue("0.0");
  await expect(page.locator("#placeRz")).toHaveValue("0.0");
  await page.locator("#placeRx").fill("22.5");
  await page.locator("#placeRx").blur();
  await expect(page.locator("#placeRx")).toHaveValue("22.5");
  await page.locator("#rotX").click();
  await expect(page.locator("#placeRx")).toHaveValue("112.5");
  await expect(page.locator("#placeRy")).toHaveValue("0.0");
  await expect(page.locator("#placeRz")).toHaveValue("0.0");
  await page.screenshot({ path: path.join(shots, "rotation.png") });
});

test("brush radius is a number, and brackets and shift-wheel change it", async ({ page }) => {
  await quiet(page);
  await loadCube(page);
  await page.keyboard.press("b");
  const radius = page.locator("#brushRadius");
  await expect(radius).toHaveAttribute("type", "number");
  await expect(radius).toHaveAttribute("step", "0.5");
  const before = Number(await radius.inputValue());
  await page.keyboard.press("]");
  await expect.poll(() => radius.inputValue().then(Number)).toBeCloseTo(before + 0.5, 2);
  await page.locator("#prepare").dispatchEvent("wheel", { deltaY: -80, shiftKey: true });
  await expect.poll(() => radius.inputValue().then(Number)).toBeCloseTo(before + 1, 2);
  await page.screenshot({ path: path.join(shots, "brush.png") });
});

test("scrubbing a modifier number edits that field", async ({ page }) => {
  await quiet(page);
  await loadCube(page);
  await page.locator("#volumeBox").click();
  const label = page.locator("[data-volume] [data-scrub=field]").first();
  await expect(label).toHaveText("X mm");
  const input = page.locator("[data-volume] input[data-field=x]");
  const before = Number(await input.inputValue());
  await expect(page.locator("#partScale")).toHaveValue("100");
  await label.scrollIntoViewIfNeeded();
  const box = (await label.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + scrubTravel(10), y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => input.inputValue().then(Number)).toBeCloseTo(before + 1, 1);
  await expect(page.locator("#partScale")).toHaveValue("100");
});

test("section offset is a number and the axis select aims the plane", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await serveSliceJob(page, cube);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.locator("#sectionOn").check();
  const offset = page.locator("#sectionOffset");
  await expect(offset).toHaveAttribute("type", "number");
  await expect(page.locator("#sectionAxis")).toHaveValue("z");
  await offset.fill("4");
  await expect(offset).toHaveValue("4");
  await page.locator("#sectionAxis").selectOption("x");
  await expect(page.locator("#sectionAxis")).toHaveValue("x");
  await expect(offset).toHaveValue("4");
  await page.screenshot({ path: path.join(shots, "section.png") });
});
