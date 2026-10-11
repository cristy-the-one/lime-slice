import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const shots = path.resolve("/opt/cursor/artifacts/plate-marks");
fs.mkdirSync(shots, { recursive: true });

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
}

test("a row states seam and walls, and a plain row stays one size line", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await quiet(page);
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);

  await expect(page.locator(".obj-marks")).toHaveCount(0);
  await expect(page.locator("#objectList .obj span")).toHaveCount(1);
  await expect(page.locator("#objectList .obj span")).toHaveText("20 × 20 × 20 mm");
  const pane = await page.evaluate(() => {
    const canvas = document.querySelector("#prepare")!.getBoundingClientRect();
    const host = document.querySelector("#prepareBody")!.getBoundingClientRect();
    return (canvas.width * canvas.height) / (host.width * host.height);
  });
  expect(pane, `prepare canvas of its pane ${pane}`).toBeGreaterThanOrEqual(0.7);
  await page.screenshot({ path: path.join(shots, "before-marks.png") });

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toHaveProperty("marks");
  expect(bodies[0]).not.toHaveProperty("objects");

  await page.locator("#objWalls").fill("4");
  await page.locator("#objWalls").blur();
  await page.waitForTimeout(400);
  await expect(page.locator(".obj-marks")).toHaveText("walls 4");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".obj-marks")).toHaveCount(0);
  await expect(page.locator("#objWalls")).toHaveValue("");

  await page.locator("#objWalls").fill("4");
  await page.locator("#objWalls").blur();
  await page.waitForTimeout(400);
  await page.locator("#plateDuplicate").click();
  await expect(page.locator(".obj-marks")).toHaveCount(2);
  await expect(page.locator(".obj-marks").nth(0)).toHaveText("walls 4");
  await expect(page.locator(".obj-marks").nth(1)).toHaveText("walls 4");
  await page.locator("[data-plate-remove]").first().click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);
  await expect(page.locator(".obj-marks")).toHaveText("walls 4");

  await page.locator('[data-tool="seam"]').click();
  await expect(page.locator("#seamBar")).toBeVisible();
  const canvas = page.locator("#prepare");
  const box = (await canvas.boundingBox())!;
  let hit = "";
  for (let row = 8; row < 24 && !hit; row++) {
    for (let col = 8; col < 32 && !hit; col++) {
      const x = box.x + (box.width * col) / 40;
      const y = box.y + (box.height * row) / 32;
      await page.mouse.move(x, y);
      hit = (await canvas.getAttribute("data-brush-hit")) ?? "";
      if (hit) await page.mouse.down();
    }
  }
  await page.mouse.up();
  expect(hit, "the brush meets the cube").not.toBe("");
  await expect(page.locator(".obj-marks")).toHaveText("seam · walls 4");
  await page.screenshot({ path: path.join(shots, "after-marks.png") });
  await expect.poll(() => bodies.length).toBeGreaterThan(1);
  const sent = bodies.at(-1)!;
  expect(sent).not.toHaveProperty("marks");
  const objects = sent.objects as { settings?: { walls?: number }; seamPaint?: unknown[]; marks?: unknown }[];
  expect(objects?.[0]?.settings?.walls).toBe(4);
  expect(objects?.[0]?.seamPaint?.length).toBeGreaterThan(0);
  expect(objects?.[0]).not.toHaveProperty("marks");

  await page.locator("#seamClear").click();
  await expect(page.locator(".obj-marks")).toHaveText("walls 4");
  await expect(page.locator("#objectList .obj span")).toHaveCount(2);
});
