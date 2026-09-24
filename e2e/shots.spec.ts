import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const out = path.resolve("artifacts/ui");
fs.mkdirSync(out, { recursive: true });

const layer = {
  index: 0,
  z: 0.2,
  height: 0.2,
  note: "speed walls=2",
  seconds: 1.7,
  speedWalls: 2,
  toughnessWalls: 0,
  supportPaths: 0,
  paths: [
    { kind: "outer", strategy: "speed", pts: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]], width: 0.45, speed: 130, effectiveSpeed: 80, toughness: 0 },
    { kind: "inner", strategy: "speed", pts: [[1, 1], [19, 1], [19, 19], [1, 19], [1, 1]], width: 0.45, speed: 160, effectiveSpeed: 90, toughness: 0 },
    { kind: "sparse", strategy: "speed", pts: [[3, 3], [17, 10], [3, 17]], width: 0.45, speed: 180, effectiveSpeed: 100, toughness: 0 },
    { kind: "travel", strategy: "speed", pts: [[0, 0], [3, 3]], width: 0, speed: 300, effectiveSpeed: 300, toughness: 0 },
  ],
};

function sliceBody() {
  return {
    coreMs: 12,
    baselineMs: 0,
    baselineLabel: "skipped",
    blend: "single speed",
    mesh: { triangles: 12, min: [0, 0, 0], max: [20, 20, 20] },
    sanity: { ok: true, notes: [], layers: 2, finalE: 100, extrusionLengthMm: 400 },
    estimate: {
      seconds: 170,
      filamentMm: 600,
      filamentG: 1.84,
      arcMoves: 4,
      travelMm: 80,
      retracts: 3,
      scarfedLoops: 0,
      byFeature: [
        { kind: "outer", seconds: 40, filamentMm: 200, filamentG: 0.6 },
        { kind: "inner", seconds: 30, filamentMm: 150, filamentG: 0.45 },
        { kind: "sparse", seconds: 50, filamentMm: 200, filamentG: 0.6 },
        { kind: "travel", seconds: 50, filamentMm: 0, filamentG: 0 },
      ],
    },
    compare: [
      { label: "speed", seconds: 170, filamentG: 1.84 },
      { label: "efficiency", seconds: 240, filamentG: 2.4 },
      { label: "toughness", seconds: 900, filamentG: 6.2 },
      { label: "classic", seconds: 320, filamentG: 2.7 },
    ],
    gcode: "; mock\n",
    layers: [layer, { ...layer, index: 1, z: 10, seconds: 1.4, paths: layer.paths.map((p) => ({ ...p, toughness: 0.4 })) }],
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    if (route.request().postDataJSON()?.filename === "bad.stl") {
      await route.fulfill({ status: 400, json: { error: "bad mesh" } });
      return;
    }
    await route.fulfill({ json: sliceBody() });
  });
});

test("ui states", async ({ page }) => {
  await page.goto("/");
  await page.screenshot({ path: path.join(out, "01-empty.png") });

  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
  await page.screenshot({ path: path.join(out, "02-loaded.png") });

  await page.getByRole("button", { name: /^Speed/ }).click();
  await page.screenshot({ path: path.join(out, "03-card-speed.png") });
  await page.getByRole("button", { name: /^Efficiency/ }).click();
  await page.screenshot({ path: path.join(out, "04-card-efficiency.png") });
  await page.getByRole("button", { name: /^Toughness/ }).click();
  await page.screenshot({ path: path.join(out, "05-card-toughness.png") });

  await page.getByRole("button", { name: /^By layer/ }).click();
  await expect(page.locator("#layerBand")).toBeVisible();
  await page.screenshot({ path: path.join(out, "06-layer-blend.png") });

  await page.getByRole("button", { name: /^By region/ }).click();

  await page.unroute("**/api/slice");
  await page.route("**/api/slice", async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ json: sliceBody() });
  });
  const slice = page.getByRole("button", { name: "Slice", exact: true });
  await slice.click();
  await expect(page.locator("[data-state=slicing]")).toBeVisible();
  await page.screenshot({ path: path.join(out, "08-slicing-progress.png") });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#banner")).toContainText("cancelled");
  await page.screenshot({ path: path.join(out, "09-cancelled.png") });

  await page.unroute("**/api/slice");
  await page.route("**/api/slice", (route) => route.fulfill({ json: sliceBody() }));
  await page.getByRole("button", { name: "Slice", exact: true }).click();
  await expect(page.locator("#estimate")).toContainText("1.84 g");
  await page.getByRole("button", { name: "2D", exact: true }).click();
  await page.screenshot({ path: path.join(out, "12-preview-2d.png") });
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.screenshot({ path: path.join(out, "13-preview-3d.png") });
  await page.screenshot({ path: path.join(out, "07-region-blend-plane.png") });
  await page.locator("#legend input").first().uncheck();
  await page.screenshot({ path: path.join(out, "14-legend-toggles.png") });
  await page.screenshot({ path: path.join(out, "15-estimate-card.png") });

  await page.locator("#lh").fill("0.28");
  await page.locator("#lh").dispatchEvent("change");
  await expect(page.getByRole("button", { name: "Re-slice" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export G-code" })).toBeDisabled();
  await page.screenshot({ path: path.join(out, "10-stale.png") });

  await page.unroute("**/api/health");
  await page.route("**/api/health", (route) => route.abort());
  await page.reload();
  await expect(page.locator("#banner")).toContainText("Slicer engine not running");
  await page.screenshot({ path: path.join(out, "11-error-banner.png") });

  await page.setViewportSize({ width: 960, height: 800 });
  await page.screenshot({ path: path.join(out, "16-narrow-960.png") });
});
