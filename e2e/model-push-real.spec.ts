import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * Face push/pull against the real modeler:
 *   lime-slice serve --port 43218   (with LIME_OCCT_BRIDGE set)
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test model-push-real
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(180_000);

// The slicing job's engine has no OCCT bridge: then there is no modeler to push a face with.
test.beforeAll(async ({ request }) => {
  const res = await request.post(`${api}/api/model/tree`, {
    data: { call: "open", key: "push-real-probe", primitive: { primitive: "box", origin: [0, 0, 0], size: [1, 1, 1], turn: [0, 0, 0] }, chordMm: 0.1 },
  });
  const body = (await res.json().catch(() => ({}))) as { volumeMm3?: number };
  test.skip(typeof body.volumeMm3 !== "number", "this engine has no OCCT modeler");
  await request.post(`${api}/api/model/tree`, { data: { call: "close", key: "push-real-probe" } });
});

async function proxy(page: Page) {
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    await route.fulfill({ response: await route.fetch({ url, timeout: 120_000 }) });
  });
}

/** A new solid from the empty Model view. */
async function newSolid(page: Page, kind: string, fields: Record<string, number>) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await proxy(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await page.locator("#modelToolNew").click();
  await page.locator(`#modelPrim [data-kind="${kind}"]`).click();
  for (const [id, value] of Object.entries(fields)) await page.locator(`#${id}`).fill(String(value));
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume", { timeout: 60_000 });
  await expect(page.locator("#modelPanel")).toBeHidden();
}

function volume(text: string | null): number {
  const match = /Volume ([\d.,]+) mm³/.exec(text ?? "");
  return match ? Number(match[1]!.replace(/,/g, "")) : Number.NaN;
}

test("pushing a cylinder's wall moves it along its radius, and the box shows the diameter it builds", async ({ page }) => {
  await newSolid(page, "cylinder", { modelRadius: 10, modelHeight: 20 });
  const before = volume(await page.locator("#modelReadout").textContent());
  expect(before).toBeCloseTo(Math.PI * 100 * 20, -1);
  const canvas = page.locator("#model");
  const rect = (await canvas.boundingBox())!;
  const screen = (await canvas.getAttribute("data-solid-screen"))!.split(",").map(Number);
  // The middle of the solid on screen, a little low, is on the wall that faces the camera.
  const at = { x: rect.x + screen[0]! + screen[2]! / 2, y: rect.y + screen[1]! + screen[3]! * 0.62 };
  let nudge = 0;
  await expect.poll(async () => {
    nudge = (nudge + 1) % 3;
    await page.mouse.move(at.x + nudge, at.y);
    return canvas.getAttribute("data-handles") ?? "";
  }).toContain("pull:");
  const grip = /pull:(-?\d+),(-?\d+)/.exec((await canvas.getAttribute("data-handles")) ?? "")!;
  const arrow = { x: rect.x + Number(grip[1]) - at.x, y: rect.y + Number(grip[2]) - at.y };
  expect(Math.hypot(arrow.x, arrow.y), "the wall has an arrow to drag").toBeGreaterThan(2);

  await page.mouse.down();
  for (let step = 6; step <= 30; step += 6) await page.mouse.move(at.x + (arrow.x / Math.hypot(arrow.x, arrow.y)) * step, at.y + (arrow.y / Math.hypot(arrow.x, arrow.y)) * step);
  const inputs = page.locator(".interact-hud:not([hidden]) input");
  await expect(inputs).toHaveCount(2);
  await page.keyboard.type("-4");
  await expect(inputs.nth(0)).toHaveValue("-4");
  await expect(inputs.nth(1), "a 4 mm push on r10 leaves ⌀12").toHaveValue("12");
  await page.keyboard.press("Enter");
  await page.mouse.up();
  const width = async () => {
    const box = ((await canvas.getAttribute("data-solid")) ?? "").split(",").map(Number);
    return [box[3]! - box[0]!, box[4]! - box[1]!, box[5]! - box[2]!].map((value) => Math.round(value * 10) / 10);
  };
  await expect.poll(width, { timeout: 60_000, message: "the kernel built ⌀12, as tall as before" }).toEqual([12, 12, 20]);
});
