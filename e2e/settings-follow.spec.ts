import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const beltLedge = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/ledge-belt-skeleton.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
}

async function loadCube(page: Page, name = "calibration_cube_20mm.stl") {
  await page.evaluate((sample) => document.querySelector<HTMLButtonElement>(`[data-sample="${sample}"]`)?.click(), name);
  await expect(page.locator("#slice")).toBeEnabled();
}

test("Export slices first when the slice is missing or stale, then saves; Ctrl+E does the same", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#export")).toBeDisabled();
  await loadCube(page);
  await expect(page.locator("#export")).toBeEnabled();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "first");

  const first = page.waitForEvent("download");
  await page.locator("#export").click();
  expect((await first).suggestedFilename()).toMatch(/\.gcode$/);
  expect(bodies).toHaveLength(1);
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");

  // A setting changed since: the slice is stale, and Export makes a new one before it saves.
  await page.locator("#lh").fill("0.28");
  await page.locator("#lh").dispatchEvent("change");
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "first");
  const second = page.waitForEvent("download");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+e");
  expect((await second).suggestedFilename()).toMatch(/\.gcode$/);
  expect(bodies).toHaveLength(2);
  expect(bodies[1].layerHeight).toBe(0.28);
});

test("Send slices first too, and still needs a host", async ({ page }) => {
  await quiet(page);
  const uploads: string[] = [];
  const bodies: unknown[] = [];
  await page.route("http://printer.local/**", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      uploads.push(request.url());
      return route.fulfill({ status: 201, body: "" });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: cube });
  });
  await page.goto("/");
  await loadCube(page);
  await expect(page.locator("#sendPrinter")).toBeDisabled();
  await expect(page.locator("#sendPrinter")).toHaveAttribute("data-tip", /Prusa Link host/);
  await page.locator("#machineMore > summary").click();
  await page.locator("#machineHost").fill("http://printer.local");
  await page.locator("#machineKey").fill("secret");
  await page.locator("#machineHost").dispatchEvent("change");
  await expect(page.locator("#sendPrinter")).toBeEnabled();
  expect(bodies).toHaveLength(0);
  await page.locator("#sendPrinter").click();
  await expect.poll(() => uploads.length).toBe(1);
  expect(bodies).toHaveLength(1);
});

test("Turn on supports in the in-air banner ticks Smart supports and slices, in one undo step", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    return route.fulfill({ json: body.supports ? cube : { ...cube, inAir: { islands: 2, overhangs: 1 } } });
  });
  await page.goto("/");
  await loadCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("#banner")).toContainText("would print in the air");
  expect(bodies[0].supports).toBe(false);
  await page.waitForTimeout(400);
  await page.locator("#banner").getByRole("button", { name: "Turn on supports" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].supports).toBe(true);
  await expect(page.locator("#supports")).toBeChecked();
  await expect(page.locator("#banner")).not.toContainText("would print in the air");
  await page.locator("#undoEdit").click();
  await expect(page.locator("#supports")).not.toBeChecked();
});

test("an Enforce disk turns Smart supports on; a Block disk does not", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loadCube(page, "lime_hull.stl");
  await page.waitForTimeout(400);
  await page.locator('#toolRail [data-tool="paint"]').click();
  const canvas = page.locator("#prepare");
  const box = (await canvas.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height * 0.45 };

  await page.locator('#paintBar [data-kind="block"]').click();
  await page.mouse.click(at.x, at.y);
  await expect(canvas).toHaveAttribute("data-paint-disks", "1");
  await expect(page.locator("#supports")).not.toBeChecked();

  await page.waitForTimeout(400);
  await page.locator('#paintBar [data-kind="enforce"]').click();
  await page.mouse.click(at.x + 6, at.y);
  await expect(canvas).toHaveAttribute("data-paint-disks", "2");
  await expect(page.locator("#supports")).toBeChecked();
  await page.waitForTimeout(400);
  await page.locator("#undoEdit").click();
  await expect(canvas).toHaveAttribute("data-paint-disks", "1");
  await expect(page.locator("#supports")).not.toBeChecked();
});

test("the Edit supports tool turns on tree supports, slices, and opens when the skeleton arrives", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: beltLedge });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#machineKind").selectOption("belt");
  await loadCube(page, "overhang_ledge.stl");
  await expect(page.locator("#supports")).not.toBeChecked();
  await expect(page.locator("#supportEditbar")).toBeHidden();
  await page.locator("#tabPreview").click();
  await page.keyboard.press("e");
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].supports).toBe(true);
  expect(bodies[0].supportStyle).toBe("tree");
  expect(bodies[0].includeSkeleton).toBe(true);
  await expect(page.locator("#supportEditbar")).toBeVisible();
  await expect(page.locator("#supports")).toBeChecked();
});

test("Blend compare estimates the selected object of a plate", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/pareto", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    const point = (label: string, toughness: number, seconds: number, filamentG: number) => ({ label, toughness, seconds, filamentG, score: toughness });
    return route.fulfill({ json: [point("speed", 0, 300, 2), point("toughness", 1, 600, 4)] });
  });
  await page.goto("/");
  await loadCube(page);
  await page.locator("#plateAdd").click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await page.locator("#printOrder").selectOption("sequential");
  await page.locator("#paretoBtn").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toHaveProperty("objects");
  expect(bodies[0]).not.toHaveProperty("printOrder");
  expect(bodies[0]).toHaveProperty("dataB64");
  expect(bodies[0]).toHaveProperty("pose");
  await expect(page.locator("#pareto svg.pareto")).toBeVisible();
  await expect(page.locator("#banner")).not.toContainText("Compare blends");
});

test("one at a time: Arrange keeps the toolhead clearance, and the request prints the tallest last", async ({ page }) => {
  await quiet(page);
  const bodies: { objects?: { id: string }[]; printOrder?: string; sequentialClearanceMm?: number }[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: cube });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loadCube(page);
  await page.locator("#plateAdd").click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await page.locator("#partScale").fill("50");
  await page.waitForTimeout(400);
  await expect(page.locator("#plateOverlap")).toContainText("overlaps");
  await page.locator("#printOrder").selectOption("sequential");
  // The overlap warning carries its own Arrange.
  await page.locator("#plateOverlap").getByRole("button", { name: "Arrange" }).click();
  await expect(page.locator("#plateOverlap")).toHaveCount(0);
  const second = Number(await page.locator("#placeX").inputValue());
  await page.locator("[data-plate-select='part']").click();
  const first = Number(await page.locator("#placeX").inputValue());
  // 10 mm and 20 mm wide, 35 mm clear between: centres 5 + 35 + 10 apart.
  expect(Math.abs(first - second)).toBeCloseTo(50, 0);

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].printOrder).toBe("sequential");
  const ids = bodies[0].objects!.map((o) => o.id);
  expect(ids).toHaveLength(2);
  expect(ids[1], "the 20 mm part prints last").toBe("part");
});

test("a height range typed backwards is swapped, and a preset needs a name to save", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  await page.goto("/");
  await loadCube(page);
  await page.locator("#heightAdd").click();
  const from = page.locator("[data-range] input[data-field=zFrom]");
  const to = page.locator("[data-range] input[data-field=zTo]");
  await from.fill("12");
  await from.dispatchEvent("change");
  await expect(from).toHaveValue("4");
  await expect(to).toHaveValue("12");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect((bodies[0].heightRanges as { z: number[] }[])[0]!.z).toEqual([4, 12]);

  await expect(page.locator("#presetSave")).toBeDisabled();
  await page.locator("#presetName").fill("bench");
  await expect(page.locator("#presetSave")).toBeEnabled();
  await page.locator("#presetName").fill("");
  await expect(page.locator("#presetSave")).toBeDisabled();
});
