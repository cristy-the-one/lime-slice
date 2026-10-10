import { expect, test, type Page } from "@playwright/test";

/**
 * Move a sliced part against a real engine, which replies in the part frame.
 * The stored-recipe specs need the engine's disk cache, as the desktop app has:
 *   lime-slice serve --port 43218 --cache-dir <dir>
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test part-frame
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(300_000);

const SLICE_MS = 120_000;

async function sliced(page: Page) {
  await expect(page.locator("#slice")).toBeEnabled({ timeout: SLICE_MS });
  await expect(page.locator("#cancel")).toBeHidden();
}

type Reply = { gcode?: string; gcodeToken?: string; fromCache?: boolean; coreMs: number; previewPatch?: { changed: unknown[] } };

/** Send the app's engine calls to the real engine, and keep each slice reply. */
async function proxy(page: Page) {
  const replies: Reply[] = [];
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    const response = await route.fetch({ url, timeout: SLICE_MS });
    if (/\/api\/jobs\/[^/]+\/result$|\/api\/slice$/.test(url) && response.status() === 200) replies.push(JSON.parse(await response.text()));
    await route.fulfill({ response });
  });
  return replies;
}

async function gcodeOf(page: Page, reply: Reply) {
  if (reply.gcode) return reply.gcode;
  const res = await page.request.get(`${api}/api/gcode/${reply.gcodeToken}`);
  expect(res.ok()).toBe(true);
  return res.text();
}

/** X range of the extrusions from the first layer marker on, so start G-code is left out. */
function printedX(gcode: string): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const line of gcode.slice(gcode.indexOf(";LAYER:")).split("\n")) {
    const x = /^G1 .*X(-?[\d.]+).*E/.exec(line);
    if (!x) continue;
    min = Math.min(min, Number(x[1]));
    max = Math.max(max, Number(x[1]));
  }
  return [min, max];
}

async function loadDragon(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#file").setInputFiles("samples/dragon_2_5.stl");
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 30_000 });
}

test("an X/Y move re-emits the G-code at the new place without a click", async ({ page }) => {
  const replies = await proxy(page);
  await loadDragon(page);
  await page.locator("#slice").click();
  await sliced(page);
  // Time a move after a planned slice. The next spec moves after a disk-cache load.
  if (replies[0]!.fromCache) {
    await page.locator("#force").click();
    await sliced(page);
  }
  await expect(page.locator("#export")).toBeEnabled();
  expect(replies.at(-1)!.fromCache).toBe(false);
  const planned = replies.length;
  const before = printedX(await gcodeOf(page, replies.at(-1)!));
  const fromX = Number(await page.locator("#placeX").inputValue());

  const committed = Date.now();
  await commitX(page, String(fromX + 25));
  await expect(page.locator("#export")).toBeEnabled({ timeout: SLICE_MS });
  console.log(`move: commit to export enabled ${Date.now() - committed} ms`);
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
  expect(replies).toHaveLength(planned + 1);
  const moved = replies[planned]!;
  expect(moved.fromCache || moved.previewPatch?.changed.length === 0, "the move re-emitted or came from the store").toBe(true);
  const after = printedX(await gcodeOf(page, moved));
  expect(after[0] - before[0]).toBeCloseTo(25, 1);
  expect(after[1] - before[1]).toBeCloseTo(25, 1);
});

test("settings switched back to a sliced recipe show it without a click", async ({ page }) => {
  const replies = await proxy(page);
  await loadDragon(page);
  await page.locator("#slice").click();
  await sliced(page);
  await page.locator("#lh").fill("0.28");
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await expect(page.locator("#export")).toHaveAttribute("data-tip", "Settings changed. Slice again to export.");
  await page.locator("#slice").click();
  await sliced(page);
  await expect(page.locator("#export")).toBeEnabled();
  expect(replies).toHaveLength(2);

  await page.locator("#lh").fill("0.2");
  await expect(page.locator("#export")).toBeEnabled({ timeout: SLICE_MS });
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
  expect(replies).toHaveLength(3);
  expect(replies[2]!.fromCache).toBe(true);
});

test("an X/Y move after a disk-cache load re-emits without a click", async ({ page }) => {
  const replies = await proxy(page);
  await loadDragon(page);
  await page.locator("#slice").click();
  await sliced(page);
  await page.locator("#lh").fill("0.28");
  await page.locator("#slice").click();
  await sliced(page);
  await page.locator("#lh").fill("0.2");
  await expect(page.locator("#export")).toBeEnabled({ timeout: SLICE_MS });
  expect(replies).toHaveLength(3);
  const loaded = replies[2]!;
  expect(loaded.fromCache).toBe(true);
  const before = printedX(await gcodeOf(page, loaded));

  // The engine plans the loaded recipe again in the background. A move sent
  // before that finishes supersedes it and plans in full.
  await page.waitForTimeout(2_000 + 3 * loaded.coreMs);
  const dx = 25;
  const fromX = Number(await page.locator("#placeX").inputValue());
  const committed = Date.now();
  await commitX(page, String(fromX + dx));
  await expect(page.locator("#export")).toBeEnabled({ timeout: SLICE_MS });
  console.log(`move after a disk-cache load: commit to export enabled ${Date.now() - committed} ms`);
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
  expect(replies).toHaveLength(4);
  const moved = replies[3]!;
  expect(moved.fromCache).toBe(false);
  expect(moved.previewPatch?.changed).toEqual([]);
  const after = printedX(await gcodeOf(page, moved));
  expect(after[0] - before[0]).toBeCloseTo(dx, 1);
  expect(after[1] - before[1]).toBeCloseTo(dx, 1);
});

async function commitX(page: Page, value: string) {
  const field = page.locator("#placeX");
  await field.fill(value);
  await field.press("Tab");
}

test("a moved part keeps its split plane and G-code line on the bed", async ({ page }) => {
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    const response = await route.fetch({ url, timeout: SLICE_MS });
    await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "Bridge" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /^By region/ }).click();
  await page.locator("#slice").click();
  await sliced(page);
  await expect(page.locator("#view3d")).toHaveAttribute("data-bed-offset", "0.000,0.000");

  await commitX(page, "140");
  await page.locator("#slice").click();
  await sliced(page);
  await expect(page.locator("#view3d")).toHaveAttribute("data-bed-offset", "30.000,0.000");
  await expect(page.locator("#banner")).not.toContainText("outside the mesh");

  await page.locator("#tabGcode").click();
  await expect(page.locator("#gcodePane .gcode-text")).toContainText(";LAYER:");
  await expect(page.locator("#gcodePane .gcode-mark")).toBeVisible();
});
