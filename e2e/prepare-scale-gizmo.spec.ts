import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

async function grips(page: Page): Promise<Record<string, { x: number; y: number }>> {
  const canvas = page.locator("#prepare");
  const text = (await canvas.getAttribute("data-scale-grips")) ?? "";
  const box = (await canvas.boundingBox())!;
  const map: Record<string, { x: number; y: number }> = {};
  for (const item of text.split(" ").filter(Boolean)) {
    const [id, at] = item.split(":");
    const [x, y] = at!.split(",").map(Number);
    map[id!] = { x: box.x + x!, y: box.y + y! };
  }
  return map;
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number, shift = false) {
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
}

test("the prepare scale gizmo stays parked off the part and writes Scale %", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => route.fulfill({ status: 404, json: { error: "off" } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#partScale")).toHaveValue("100");

  const scale = page.locator('#toolRail [data-tool="scale"]');
  await expect(scale).not.toHaveClass(/is-disabled/);
  await expect(scale).not.toHaveAttribute("aria-disabled", "true");
  await scale.click();
  await expect(scale).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#gizmoNudge")).toBeVisible();
  await expect.poll(async () => (await grips(page)).u).toBeTruthy();

  const canvas = (await page.locator("#prepare").boundingBox())!;
  const home = await grips(page);
  expect(home.u!.x - canvas.x).toBeLessThan(canvas.width * 0.34);
  expect(home.u!.x - canvas.x).toBeGreaterThan(canvas.width * 0.02);
  expect(home.x!.x - canvas.x).toBeLessThan(canvas.width * 0.5);

  await drag(page, home.u!, 0, -90);
  const grown = Number(await page.locator("#partScale").inputValue());
  expect(grown).toBeGreaterThan(100);
  expect(grown).toBeLessThanOrEqual(400);
  await expect(page.locator("#gizmoReadout")).toBeHidden();
  const parked = await grips(page);
  expect(Math.abs(parked.u!.x - home.u!.x)).toBeLessThan(30);
  expect(Math.abs(parked.u!.y - home.u!.y)).toBeLessThan(30);
  expect(parked.u!.x - canvas.x).toBeLessThan(canvas.width * 0.34);
  if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/after-scale-gizmo.png` });

  await page.locator("#partScale").fill("100");
  await page.locator("#partScale").blur();
  await expect(page.locator("#partScale")).toHaveValue("100");
  const again = (await grips(page)).u!;
  await drag(page, again, 0, -80, true);
  const snapped = Number(await page.locator("#partScale").inputValue());
  expect(snapped).not.toBe(100);
  expect(snapped % 5).toBe(0);

  await page.keyboard.press("Control+z");
  await expect(page.locator("#partScale")).toHaveValue("100");

  await page.locator("#partScale").fill("100");
  await page.locator("#partScale").blur();
  for (const [dx, dy] of [[70, 0], [0, -70], [-70, 0], [0, 70]] as const) {
    const from = (await grips(page)).x;
    expect(from).toBeTruthy();
    await drag(page, from!, dx, dy);
    if (Number(await page.locator("#partScale").inputValue()) !== 100) break;
    await page.locator("#partScale").fill("100");
    await page.locator("#partScale").blur();
  }
  expect(Number(await page.locator("#partScale").inputValue())).not.toBe(100);

  await page.locator("#partScale").fill("150");
  await page.locator("#partScale").press("Enter");
  await expect(page.locator("#partScale")).toHaveValue("150");
  await page.locator('#gizmoNudge button[aria-label="Nudge scale +1%"]').first().click();
  await expect(page.locator("#partScale")).toHaveValue("151");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#partScale")).toHaveValue("150");
});
