import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * Sketch features against the real OCCT modeler, not the mocked tree:
 *   lime-slice serve --port 43218 --cache-dir <dir>
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test model-sketch-real
 * The volumes and boxes are the kernel's, so they check where each feature lands as well as that it is built.
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(180_000);

// The release bench engine has no OCCT bridge (CI builds `lime-slice` without it): then there is no modeler to sketch
// features with, and every Apply is refused. Skip rather than fail, as model-push-real does.
test.beforeAll(async ({ request }) => {
  const res = await request.post(`${api}/api/model/tree`, {
    data: { call: "open", key: "sketch-real-probe", primitive: { primitive: "box", origin: [0, 0, 0], size: [1, 1, 1], turn: [0, 0, 0] }, chordMm: 0.1 },
  });
  const body = (await res.json().catch(() => ({}))) as { volumeMm3?: number };
  test.skip(typeof body.volumeMm3 !== "number", "this engine has no OCCT modeler");
  await request.post(`${api}/api/model/tree`, { data: { call: "close", key: "sketch-real-probe" } });
});

async function start(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    await route.fulfill({ response: await route.fetch({ url, timeout: 120_000 }) });
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelEmptySketch")).toBeVisible();
}

/** The open solid's volume, as the readout says it. */
async function volume(page: Page): Promise<number> {
  const text = (await page.locator("#modelReadout").textContent()) ?? "";
  const match = /Volume ([\d.,]+) mm³/.exec(text);
  return match ? Number(match[1]!.replace(/,/g, "")) : Number.NaN;
}

async function bounds(page: Page): Promise<number[]> {
  return ((await page.locator("#model").getAttribute("data-solid")) ?? "").split(",").map(Number);
}

async function typed(page: Page, values: string[]) {
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  for (const [index, value] of values.entries()) {
    await hud.locator("input").nth(index).fill(value);
    await hud.locator("input").nth(index).press(index === values.length - 1 ? "Enter" : "Tab");
  }
}

async function rectangleAt(page: Page, at: { x: number; y: number }, width: string, height: string) {
  await page.locator("[data-sketch-tool=rectangle]").click();
  await page.mouse.click(at.x, at.y);
  await typed(page, [width, height]);
}

async function circleAt(page: Page, at: { x: number; y: number }, diameter: string) {
  await page.locator("[data-sketch-menu=draw]").click();
  await page.locator(".sketch-menu-list [data-sketch-tool=circle]").click();
  await page.mouse.click(at.x, at.y);
  await typed(page, [diameter]);
}

test("a rectangle extrudes on the bed, a circle cuts it from below, and an edit of the root keeps the cut", async ({ page }) => {
  await start(page);
  const canvas = page.locator("#model");
  await page.locator("#modelEmptySketch").click();
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await rectangleAt(page, centre, "20", "10");
  await page.keyboard.press("E");
  await typed(page, ["10"]);
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(2000, 0);
  const placed = await bounds(page);
  expect(placed[2], "the new object stands on the bed").toBeCloseTo(0, 3);
  expect(placed[5]).toBeCloseTo(10, 3);

  // A circle on the bed inside the block's footprint, extruded up into it, cuts a 5 mm deep pocket from below.
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await circleAt(page, { x: centre.x + 4, y: centre.y - 4 }, "4");
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  for (let turn = 0; turn < 4 && (await canvas.getAttribute("data-extrude-mode")) !== "cut"; turn += 1) await page.locator("[data-sketch-mode]").click();
  await expect(canvas).toHaveAttribute("data-extrude-mode", "cut");
  await typed(page, ["5"]);
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(2000 - Math.PI * 4 * 5, 0);

  // The root becomes 12 tall: the later cut is rebuilt on it and is still the step shown.
  const rows = page.locator("#modelHistoryTree .mh-row");
  await expect(rows).toHaveCount(2);
  await rows.first().locator(".mh-edit").click();
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await typed(page, ["12"]);
  await expect(page.locator('#modelHistoryTree .mh-row[aria-selected="true"]')).toContainText("Cut");
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(2400 - Math.PI * 4 * 5, 0);
  await expect(page.locator("#modelRedo")).toBeDisabled();
});

test("a washer sweeps up a path with its hole, where it was drawn", async ({ page }) => {
  await start(page);
  const canvas = page.locator("#model");
  await page.locator("#modelEmptySketch").click();
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await circleAt(page, centre, "12");
  await circleAt(page, centre, "4");
  await page.locator("[data-sketch-finish]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");

  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XZ]").click();
  await page.locator("[data-sketch-tool=line]").click();
  const from = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.55 };
  await page.mouse.click(from.x, from.y);
  await page.mouse.move(from.x, from.y - 30);
  await typed(page, ["20", "90"]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("W");
  await expect(canvas).toHaveAttribute("data-sweep-profile", "1");
  await expect(canvas).toHaveAttribute("data-sweep-path", "1");
  await page.keyboard.press("Enter");
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeGreaterThan(Math.PI * 32 * 20 * 0.98);
  expect(await volume(page)).toBeLessThan(Math.PI * 32 * 20 * 1.02);
  const placed = await bounds(page);
  expect(placed[2], "the sweep starts on the bed, where the washer was drawn").toBeCloseTo(0, 2);
  expect(placed[5]).toBeCloseTo(20, 1);
});
