import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { DEFAULT_PRESET } from "../src/presets.ts";
import { expectSupports, setSupports } from "./supports";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  return bodies;
}

async function loadSample(page: Page, name = "calibration_cube_20mm.stl") {
  await page.evaluate((sample) => document.querySelector<HTMLButtonElement>(`[data-sample="${sample}"]`)?.click(), name);
  await expect(page.locator("#slice")).toBeEnabled();
}

async function sliceOnce(page: Page, bodies: unknown[]) {
  const sent = bodies.length;
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(sent + 1);
  await expect(page.locator("#slice")).toBeEnabled();
  return bodies[sent] as Record<string, unknown>;
}

const group = (page: Page) => page.locator('#left .group[data-group="supports"]');

test("Supports is one control with Off, Automatic and Painted only, and Painted only sends supportSource", async ({ page }) => {
  const bodies = await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await loadSample(page);

  const mode = group(page).locator("#supportMode");
  await expect(mode.getByRole("radio")).toHaveCount(3);
  await expect(mode.locator(".seg-opt")).toHaveText(["Off", "Automatic", "Painted only"]);
  await expect(group(page).locator(".group-sum")).toHaveText("Off");
  await expect(page.locator("#supports")).toHaveCount(0);
  await expectSupports(page, "off");
  await expect(group(page).locator("#sangle")).toHaveCount(0);

  // Off sends no source.
  const off = await sliceOnce(page, bodies);
  expect(off.supports).toBe(false);
  expect(off).not.toHaveProperty("supportSource");

  // Automatic shows the angle and sends no source.
  await setSupports(page, "auto");
  await expect(group(page).locator(".group-sum")).toHaveText("Auto");
  await expect(group(page).locator("#sangle")).toBeVisible();
  const auto = await sliceOnce(page, bodies);
  expect(auto).toMatchObject({ supports: true, supportAngle: 45 });
  expect(auto).not.toHaveProperty("supportSource");

  // Painted only hides the angle, keeps style and the tree sizes, and sends the source.
  await setSupports(page, "paint");
  await expect(group(page).locator(".group-sum")).toHaveText("Painted");
  await expect(group(page).locator("#sangle")).toHaveCount(0);
  await expect(group(page).locator("#sstyle")).toBeVisible();
  await page.locator("#levelPick").selectOption("expert");
  await expect(group(page).locator("#tipd")).toBeVisible();
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  const painted = await sliceOnce(page, bodies);
  expect(painted).toMatchObject({ supports: true, supportSource: "paint" });
  expect(painted).not.toHaveProperty("supportAngle");
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);

  // Back to Automatic, and the angle returns with its value.
  await setSupports(page, "auto");
  await expect(group(page).locator("#sangle")).toHaveValue("45");
  const again = await sliceOnce(page, bodies);
  expect(again).not.toHaveProperty("supportSource");
  expect(again.supportAngle).toBe(45);
});

test("in Painted only the Paint button sits right under the control and opens the brush", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loadSample(page);

  // Automatic keeps Paint beside Edit trees, below the settings.
  await setSupports(page, "auto");
  await expect(group(page).locator("#paintSupportsBtn")).toHaveCount(1);
  await expect(group(page).locator('[data-slot="supportPaintTools"]')).toHaveCount(0);

  await setSupports(page, "paint");
  await expect(group(page).locator("#paintSupportsBtn")).toHaveCount(1);
  const under = await page.evaluate(() => {
    const row = document.querySelector("#supportMode")!.closest(".setting")!;
    return row.nextElementSibling?.querySelector("#paintSupportsBtn") != null;
  });
  expect(under, "Paint is the next row after the control").toBe(true);
  // How painting works is in the button's tooltip, not in prose under it.
  await expect(group(page).locator("#paintSupportsBtn")).toHaveAttribute("data-tip", /only where you paint Enforce/);
  await expect(group(page).locator(".row-hint")).toHaveCount(0);
  await expect(group(page).locator("#editTreesBtn")).toHaveCount(1);
  await group(page).locator("#paintSupportsBtn").click();
  await expect(page.locator("#paintBar")).toBeVisible();
});

test("an Enforce stroke while Supports is Off switches to Painted only, and one undo restores both", async ({ page }) => {
  const bodies = await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadSample(page, "lime_hull.stl");
  await page.waitForTimeout(400);
  await expectSupports(page, "off");
  await page.locator('#toolRail [data-tool="paint"]').click();
  const canvas = page.locator("#prepare");
  const box = (await canvas.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height * 0.45 };

  // Block paint never switches anything.
  await page.locator('#paintBar [data-kind="block"]').click();
  await page.mouse.click(at.x, at.y);
  await expect(canvas).toHaveAttribute("data-paint-disks", "1");
  await expectSupports(page, "off");
  await page.waitForTimeout(400);

  await page.locator('#paintBar [data-kind="enforce"]').click();
  await page.mouse.click(at.x + 6, at.y);
  await expect(canvas).toHaveAttribute("data-paint-disks", "2");
  await expectSupports(page, "paint");
  await expect(group(page).locator(".group-sum")).toHaveText("Painted");
  const sent = await sliceOnce(page, bodies);
  expect(sent).toMatchObject({ supports: true, supportSource: "paint" });
  expect(sent.supportPaint).toHaveLength(2);

  await page.waitForTimeout(400);
  await page.keyboard.press("Control+z");
  await expect(canvas).toHaveAttribute("data-paint-disks", "1");
  await expectSupports(page, "off");
  await expect(group(page).locator(".group-sum")).toHaveText("Off");

  // Enforce paint with Automatic already on changes nothing.
  await setSupports(page, "auto");
  await page.waitForTimeout(400);
  await page.getByRole("tab", { name: "Prepare", exact: true }).click();
  if (await page.locator("#paintBar").isHidden()) await page.locator('#toolRail [data-tool="paint"]').click();
  await page.locator('#paintBar [data-kind="enforce"]').click();
  // Opening results after the slice resizes the stage, so the earlier canvas point is stale.
  const again = (await canvas.boundingBox())!;
  await page.mouse.click(again.x + again.width / 2 - 6, again.y + again.height * 0.45);
  await expect(canvas).toHaveAttribute("data-paint-disks", "2");
  await expectSupports(page, "auto");
});

test("a settings profile from before the source reads Automatic", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  const { supportSource: _later, ...old } = { ...DEFAULT_PRESET, supports: true };
  await page.locator("#profileFile").setInputFiles({
    name: "old.limeprofile.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ version: 1, name: "Before", settings: old, level: "advanced" })),
  });
  await expect(page.locator("#profilePick option", { hasText: "Before" })).toHaveCount(1);
  await expectSupports(page, "auto");
  await expect(group(page).locator("#sangle")).toBeVisible();

  const painted = { version: 1, name: "Painted", settings: { ...DEFAULT_PRESET, supports: true, supportSource: "paint" }, level: "advanced" };
  await page.locator("#profileFile").setInputFiles({
    name: "painted.limeprofile.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(painted)),
  });
  await expectSupports(page, "paint");
  await expect(group(page).locator("#sangle")).toHaveCount(0);
});

test("with Painted only the in-air banner names the unpainted overhangs and offers the brush", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { ...cube, inAir: { islands: 0, overhangs: 2 } } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadSample(page);
  await setSupports(page, "paint");
  await sliceOnce(page, bodies);
  await expect(page.locator("#banner")).toContainText("Only painted areas get supports. 2 overhangs would print in the air.");
  await page.locator("#banner").getByRole("button", { name: "Paint supports" }).click();
  await expect(page.locator("#paintBar")).toBeVisible();
});
