import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
}

test("seam paint is omitted until a disk is painted", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: cube });
  });
  await page.goto("/");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toHaveProperty("seamPaint");

  await page.locator("#tabPrepare").click();
  await page.locator('[data-tool="seam"]').click();
  await expect(page.locator("#seamBar")).toBeVisible();
  await expect(page.locator("#seamRadius")).toHaveValue("3");
  await expect(page.getByText("Mock only")).toHaveCount(0);

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
  await expect(page.locator("#prepare")).toHaveAttribute("data-seam-disks", /[1-9]/);
  // The stroke re-slices on its own; a Slice click here would race it.
  await expect.poll(() => bodies.length).toBe(2);
  const disks = bodies[1].seamPaint as { r: number; p: number[] }[];
  expect(disks.length).toBeGreaterThan(0);
  expect(disks[0].r).toBeGreaterThan(0);
  expect(bodies[1]).not.toHaveProperty("objects");
});

test.describe("the seam brush stays in the sheet", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a seam brush keeps the prepare canvas", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await page.locator('[data-tool="seam"]').click();
    await expect(page.locator("#seamBar")).toBeVisible();
    await page.waitForTimeout(250);
    const box = await page.evaluate(() => {
      const el = document.querySelector("#prepare");
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
    });
    expect(box).not.toBeNull();
    const share = canvasShare({ width: box!.width, height: box!.height }, { width: box!.viewW, height: box!.viewH });
    expect(share).toBeGreaterThanOrEqual(0.7);
  });
});
