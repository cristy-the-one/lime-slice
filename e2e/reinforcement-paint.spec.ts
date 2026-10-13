import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
}

test("reinforcement brush creates regions, edits depth/fill-through/density, and omits when Normal", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: cube });
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toHaveProperty("reinforcement");

  await page.locator("#tabPrepare").click();
  await page.locator('[data-tool="reinforce"]').click();
  await expect(page.locator("#reinforceBar")).toBeVisible();
  await expect(page.locator("#reinforceRadius")).toHaveValue("3");
  await expect(page.locator("#reinforceDepth")).toHaveValue("5");
  await expect(page.locator("#reinforceFillThrough")).not.toBeChecked();

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
  await expect(page.locator("#prepare")).toHaveAttribute("data-reinforce-disks", /[1-9]/);
  await expect(page.locator("#reinforceRegions .pb-region-row")).toHaveCount(1);
  await expect(page.locator("#reinforceRegions .pb-region-select").first()).toContainText("Paint 1 (5 mm)");
  await expect(page.locator("#reinforceRegions .pb-region-out").first()).toHaveText("100%");

  await expect.poll(() => bodies.length).toBe(2);
  const firstReinforce = bodies[1].reinforcement as {
    kind: string;
    density: number;
    depthMm: number;
    fillThrough?: boolean;
    disks: { r: number; p: number[]; n: number[] }[];
  }[];
  expect(firstReinforce).toHaveLength(1);
  expect(firstReinforce[0].kind).toBe("paint");
  expect(firstReinforce[0].density).toBe(1);
  expect(firstReinforce[0].depthMm).toBe(5);
  expect(firstReinforce[0].fillThrough).toBeUndefined();
  expect(firstReinforce[0].disks.length).toBeGreaterThan(0);

  // Change depth to 8 mm.
  await page.locator("#reinforceDepth").fill("8");
  await page.locator("#reinforceDepth").dispatchEvent("change");
  await expect(page.locator("#reinforceRegions .pb-region-select").first()).toContainText("Paint 1 (8 mm)");
  await expect.poll(() => bodies.length).toBe(3);
  expect((bodies[2].reinforcement as { depthMm: number }[])[0].depthMm).toBe(8);

  // Toggle Fill through: hides depth slider and sends fillThrough: true.
  await page.locator("#reinforceFillThrough").check();
  await expect(page.locator("#reinforceDepthField")).toBeHidden();
  await expect(page.locator("#reinforceRegions .pb-region-select").first()).toContainText("Paint 1 (through)");
  await expect.poll(() => bodies.length).toBe(4);
  expect((bodies[3].reinforcement as { fillThrough?: boolean }[])[0].fillThrough).toBe(true);

  // New region adds an empty Paint 2; Done drops the empty region.
  await page.locator("#reinforceNewRegion").click();
  await expect(page.locator("#reinforceRegions .pb-region-row")).toHaveCount(2);
  await page.locator("#reinforceDone").click();
  await expect(page.locator("#reinforceBar")).toBeHidden();
  await page.locator('[data-tool="reinforce"]').click();
  await expect(page.locator("#reinforceRegions .pb-region-row")).toHaveCount(1);

  // Lower density to Normal: slice omits reinforcement.
  const densitySlider = page.locator("#reinforceRegions .pb-region-density").first();
  const minVal = (await densitySlider.getAttribute("min"))!;
  await densitySlider.fill(minVal);
  await densitySlider.dispatchEvent("change");
  await expect(page.locator("#reinforceRegions .pb-region-out").first()).toHaveText("Normal");
  await expect.poll(() => bodies.length).toBe(5);
  expect(bodies[4]).not.toHaveProperty("reinforcement");

  // Delete region removes the row.
  await page.locator("#reinforceRegions .pb-region-del").first().click();
  await expect(page.locator("#reinforceRegions .pb-region-row")).toHaveCount(0);
  await expect(page.locator("#prepare")).toHaveAttribute("data-reinforce-disks", "0");
});

test.describe("the reinforce brush stays in the sheet on compact", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a reinforce brush keeps the prepare canvas >= 70%", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await page.locator('[data-tool="reinforce"]').click();
    await expect(page.locator("#reinforceBar")).toBeVisible();
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
