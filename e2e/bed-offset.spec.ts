import { expect, test, type Page } from "@playwright/test";
import { encodePaths } from "../src/preview-wire";
import { canvasShare } from "../src/ui/compact/viewport-share";

test("an X/Y move slides the preview, re-emits by itself, and the reply offset replaces that slide", async ({ page }) => {
  const calls: { previewBase?: string; pose?: { translation: number[] }; offset?: unknown; objects?: unknown }[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as (typeof calls)[number];
    calls.push(body);
    const moved = calls.length > 1;
    if (moved) await held;
    await route.fulfill({
      json: moved && body.previewBase ? patched(body.previewBase) : firstSlice(),
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#placeX")).toHaveValue("110.0");
  await expect(page.locator("#placeReadout")).toContainText("X 110.0");

  await page.locator("#slice").click();
  await expect(page.locator("#left")).toContainText("outline 0.025 mm");
  await expect(page.locator("#view3d")).toHaveAttribute("data-bed-offset", "0.000,0.000");
  await expect(page.locator("#view3d")).toHaveAttribute("data-preview-token", "bed-1");
  expect(calls[0].pose?.translation?.length).toBe(3);
  expect(calls[0].offset).toBeUndefined();
  expect(calls[0].objects).toBeUndefined();
  await expect(page.locator("#export")).toBeEnabled();

  await commitX(page, "122");
  await expect(page.locator("#placeReadout")).toContainText("X 122.0");
  await expect(page.locator("#view3d")).toHaveAttribute("data-bed-offset", "12.000,0.000");
  await expect.poll(() => calls.length).toBe(2);
  await expect(page.locator("#export")).toBeDisabled();
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
  await expect(page.locator("#banner")).not.toContainText("Settings changed");

  release();
  await expect(page.locator("#view3d")).toHaveAttribute("data-bed-offset", "40.000,-5.000");
  await expect(page.locator("#export")).toBeEnabled();
  const again = calls.at(-1)!;
  expect(again.previewBase).toBe("bed-1");
  expect(again.offset).toBeUndefined();
  expect(again.objects).toBeUndefined();
  await page.locator("#tabGcode").click();
  await expect(page.locator("#gcodePane")).toContainText("G1 X40 Y-5");
  await expect(page.locator("#gcodePane")).not.toContainText("; first");

  await page.locator("#tabPrepare").click();
  await page.locator("#rotZ").click();
  await expect(page.locator("#view3d")).toHaveAttribute("data-bed-offset", "40.000,-5.000");
  await expect(page.locator("#export")).toBeDisabled();
  expect(calls).toHaveLength(2);
});

test("rotation and scale still wait for Slice when auto-slice is off", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", async (route) => {
    calls += 1;
    await route.fulfill({ json: firstSlice() });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#autoslice")).not.toBeChecked();
  await page.locator("#slice").click();
  await expect(page.locator("#export")).toBeEnabled();

  await page.locator("#rotZ").click();
  await expect(page.locator("#banner")).toContainText("Settings changed since this slice. Export stays off until you re-slice.");
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await page.waitForTimeout(600);
  expect(calls).toBe(1);
  await expect(page.locator("#export")).toBeDisabled();

  await page.locator("#slice").click();
  await expect(page.locator("#export")).toBeEnabled();
  await page.locator("#partScale").fill("150");
  await expect(page.locator("#banner")).toContainText("Settings changed since this slice.");
  await page.waitForTimeout(600);
  expect(calls).toBe(2);
  await expect(page.locator("#export")).toBeDisabled();
});

test("Move drags the part in X/Y and Shift snaps to 1 mm", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#prepareBody")).toBeVisible();
  await page.getByRole("button", { name: "Top", exact: true }).click();
  await page.locator("#toolRail [data-tool=move]").click();
  const before = Number(await page.locator("#placeX").inputValue());
  const box = (await page.locator("#prepare").boundingBox())!;
  const x = box.x + box.width * 0.58;
  const y = box.y + box.height * 0.48;
  await page.keyboard.down("Shift");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 90, y + 36, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(async () => Number(await page.locator("#placeX").inputValue())).not.toBe(before);
  const afterX = Number(await page.locator("#placeX").inputValue());
  const afterY = Number(await page.locator("#placeY").inputValue());
  expect(Math.abs(afterX - before)).toBeGreaterThanOrEqual(1);
  expect(Math.abs(afterX - Math.round(afterX))).toBeLessThan(0.05);
  expect(Math.abs(afterY - Math.round(afterY))).toBeLessThan(0.05);
});

test("a Move drag sends one refresh, after the drag ends", async ({ page }) => {
  const calls: { previewBase?: string }[] = [];
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as (typeof calls)[number];
    calls.push(body);
    await route.fulfill({ json: body.previewBase ? patched(body.previewBase) : firstSlice() });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await page.locator("#slice").click();
  await expect(page.locator("#export")).toBeEnabled();
  await page.getByRole("button", { name: "Top", exact: true }).click();
  await page.locator("#toolRail [data-tool=move]").click();
  const box = (await page.locator("#prepare").boundingBox())!;
  const x = box.x + box.width * 0.58;
  const y = box.y + box.height * 0.48;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 50, y + 20, { steps: 8 });
  await page.waitForTimeout(500);
  expect(calls).toHaveLength(1);
  await expect(page.locator("#banner")).not.toContainText("Settings changed");
  await page.mouse.move(x + 90, y + 36, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#export")).toBeEnabled();
  await page.waitForTimeout(500);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.previewBase).toBe("bed-1");
});

test.describe("compact prepare still gives the canvas the peek", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("peek canvas stays at least 70%", async ({ page }) => {
    await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
    await page.goto("/?layout=compact");
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    const box = await page.locator("#prepare").boundingBox();
    expect(box).toBeTruthy();
    const share = canvasShare(
      { width: box!.width, height: box!.height },
      { width: 390, height: 844 },
    );
    expect(share).toBeGreaterThanOrEqual(0.7);
  });
});

async function commitX(page: Page, value: string) {
  const field = page.locator("#placeX");
  await field.fill(value);
  await field.press("Tab");
}

function square(min: number[], max: number[]) {
  return encodePaths([{
    kind: "outer",
    strategy: "speed",
    pts: [
      [min[0] + 1, min[1] + 1],
      [max[0] - 1, min[1] + 1],
      [max[0] - 1, max[1] - 1],
      [min[0] + 1, max[1] - 1],
      [min[0] + 1, min[1] + 1],
    ],
    width: 0.45,
    speed: 40,
    effectiveSpeed: 40,
    toughness: 0,
    beadHeight: 0.2,
  }]);
}

function firstSlice() {
  const min = [100, 100, 0];
  const max = [120, 120, 20];
  return {
    coreMs: 1,
    baselineMs: 0,
    blend: "speed",
    previewToken: "bed-1",
    mesh: { triangles: 12, sourceTriangles: 12, outlineToleranceMm: 0.025, min, max },
    sanity: { ok: true, notes: [], layers: 1, finalE: 1, extrusionLengthMm: 10 },
    estimate: { seconds: 8, filamentMm: 40, filamentG: 0.12, arcMoves: 0, byFeature: [] },
    gcode: "; first\n",
    layers: [{
      index: 0,
      z: 0.2,
      height: 0.2,
      note: "cube",
      seconds: 8,
      speedWalls: 1,
      toughnessWalls: 0,
      supportPaths: 0,
      paths: square(min, max),
    }],
  };
}

/** A later engine: same preview token, no changed layers, and a new bed offset. */
function patched(base: string) {
  const body = firstSlice();
  const { layers: _layers, ...rest } = body;
  return {
    ...rest,
    gcode: "; after move\n;LAYER:0\nG1 X40 Y-5\n",
    previewPatch: { base, layers: [0], changed: [] },
    offset: [40, -5],
  };
}
