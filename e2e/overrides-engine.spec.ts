import { expect, test, type Page } from "@playwright/test";

/**
 * A height range added in the UI reaches a real engine and changes the slice.
 *   lime-slice serve --port 43218 --cache-dir <dir>
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test overrides-engine
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(300_000);

const SLICE_MS = 120_000;

type Layer = { z: number; note: string; speedWalls: number; toughnessWalls: number };
type Reply = { gcode?: string; gcodeToken?: string; layers?: Layer[] };

async function proxy(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  const replies: Reply[] = [];
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    if (/\/api\/jobs$|\/api\/slice$/.test(url) && route.request().method() === "POST") bodies.push(route.request().postDataJSON());
    const response = await route.fetch({ url, timeout: SLICE_MS });
    if (/\/api\/jobs\/[^/]+\/result$|\/api\/slice$/.test(url) && response.status() === 200) replies.push(JSON.parse(await response.text()));
    await route.fulfill({ response });
  });
  return { bodies, replies };
}

async function gcodeOf(page: Page, reply: Reply) {
  if (reply.gcode) return reply.gcode;
  const res = await page.request.get(`${api}/api/gcode/${reply.gcodeToken}`);
  expect(res.ok()).toBe(true);
  return res.text();
}

/** The highest feed of any extruding move on each `;LAYER:` block, mm/s, keyed by Z. */
function fastestByLayer(gcode: string): Map<number, number> {
  const out = new Map<number, number>();
  let z = Number.NaN;
  let feed = 0;
  for (const line of gcode.split("\n")) {
    const layer = /^;LAYER:\d+ Z:([\d.]+)/.exec(line);
    if (layer) {
      z = Number(layer[1]);
      out.set(z, 0);
      continue;
    }
    const f = /^G[0-3] .*F([\d.]+)/.exec(line);
    if (f) feed = Number(f[1]) / 60;
    if (out.has(z) && /^G[123] .*E[\d.]/.test(line)) out.set(z, Math.max(out.get(z)!, feed));
  }
  return out;
}

test("a height range slices with its walls and speed cap", async ({ page }) => {
  const { bodies, replies } = await proxy(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("#heightAdd").click();
  await page.locator("[data-range] input[data-field=zFrom]").fill("2");
  await page.locator("[data-range] input[data-field=zTo]").fill("6");
  await page.locator("[data-range] input[data-field=walls]").fill("6");
  await page.locator("[data-range] input[data-field=infill]").fill("");
  await page.locator("[data-range] input[data-field=speed]").fill("25");

  const sent = bodies.length;
  await page.locator("#slice").click();
  await expect(page.locator("#slice")).toBeEnabled({ timeout: SLICE_MS });
  await expect(page.locator("#cancel")).toBeHidden();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  expect(bodies.length).toBeGreaterThan(sent);
  expect(bodies.at(-1)!.heightRanges).toEqual([{ z: [2, 6], walls: 6, speed: 25 }]);
  // An auto slice started while typing may land too; read the last request's reply.
  await expect.poll(() => replies.length, { timeout: SLICE_MS }).toBe(bodies.length);
  await expect(page.locator("#toasts").getByText("not yet sliced")).toHaveCount(0);

  const reply = replies.at(-1)!;
  const layers = reply.layers!;
  // Layer z is a sum of 0.2 mm steps; the range ends hold the layers at 2 and 6 mm.
  const inRange = layers.filter((l) => l.z > 2 - 1e-6 && l.z < 6 + 1e-6);
  const outside = layers.filter((l) => l.z > 0.5 && !inRange.includes(l));
  expect(inRange.length).toBe(21);
  for (const l of inRange) {
    expect(l.speedWalls + l.toughnessWalls, `walls at z ${l.z}`).toBe(6);
    expect(l.note).toContain("walls=6");
  }
  for (const l of outside) expect(l.speedWalls + l.toughnessWalls, `walls at z ${l.z}`).toBe(2);

  const fastest = fastestByLayer(await gcodeOf(page, reply));
  for (const l of inRange) expect(fastest.get(Math.round(l.z * 1000) / 1000)!, `feed at z ${l.z}`).toBeLessThanOrEqual(25.0001);
  const above = Math.max(...outside.map((l) => fastest.get(Math.round(l.z * 1000) / 1000) ?? 0));
  expect(above).toBeGreaterThan(100);
});
