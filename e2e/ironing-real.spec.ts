import { expect, test, type Page } from "@playwright/test";

/**
 * Turn ironing on against a real engine and check the G-code irons the
 * cube's top layer and nothing below it.
 *   lime-slice serve --port 43218 --cache-dir <dir>
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test ironing-real
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(180_000);

const SLICE_MS = 120_000;

type Reply = { gcode?: string; gcodeToken?: string };

async function proxy(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  const replies: Reply[] = [];
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    if (/\/api\/(jobs|slice)$/.test(url) && route.request().method() === "POST") bodies.push(route.request().postDataJSON() as Record<string, unknown>);
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

/** The layer index each `; TYPE:IRONING` prints under. */
function ironedLayers(gcode: string): number[] {
  const layers: number[] = [];
  let layer = -1;
  for (const line of gcode.split("\n")) {
    const at = /^;LAYER:(\d+) /.exec(line);
    if (at) layer = Number(at[1]);
    if (line === "; TYPE:IRONING" && layers.at(-1) !== layer) layers.push(layer);
  }
  return layers;
}

test("ironing on slices the cube's top layer ironed, with no toast", async ({ page }) => {
  const { bodies, replies } = await proxy(page);
  await page.goto("/");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();

  await page.locator("#ironing").check();
  await expect(page.locator("#ironflow")).toHaveValue("10");
  await page.locator("#slice").click();
  await expect(page.locator("#slice")).toBeEnabled({ timeout: SLICE_MS });
  await expect(page.locator("#export")).toBeEnabled({ timeout: SLICE_MS });

  expect(bodies.at(-1)).toHaveProperty("ironing", {});
  const gcode = await gcodeOf(page, replies.at(-1)!);
  const top = Math.max(...[...gcode.matchAll(/^;LAYER:(\d+) /gm)].map((m) => Number(m[1])));
  expect(top).toBe(99);
  expect(ironedLayers(gcode)).toEqual([top]);
  expect(gcode).toContain("; ironing flow 0.1 speed 20 spacing 0.1");
  expect(gcode).toMatch(/; TYPE:IRONING\n(?:M204 S\d+\n)?G1 X[\d.]+ Y[\d.]+ F\d+\n(?:M204 S\d+\n)?G1 X[\d.]+ Y[\d.]+ E[\d.]+ F1200\n/);

  await expect(page.locator("#estimate table.est")).toContainText("Ironing");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  const swatch = page.locator("#legend label", { hasText: /^Ironing/ }).locator(".swatch");
  await expect(swatch).toHaveCSS("background-color", "rgb(94, 234, 212)");
  await expect(page.locator("#toasts").getByRole("status").filter({ hasText: /ironing/i })).toHaveCount(0);
});
