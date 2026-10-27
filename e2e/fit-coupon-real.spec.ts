import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * Split to print's fit coupon against the real modeler (docs/plan-split-connectors.md, milestone 6):
 *   lime-slice serve --port 43218   (with LIME_OCCT_BRIDGE set)
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test fit-coupon-real
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(180_000);
test.use({ viewport: { width: 1440, height: 1000 } });

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${api}/api/model/tree`, {
    data: { call: "open", key: "coupon-real-probe", primitive: { primitive: "box", origin: [0, 0, 0], size: [1, 1, 1], turn: [0, 0, 0] }, chordMm: 0.1 },
  });
  const body = (await res.json().catch(() => ({}))) as { volumeMm3?: number };
  test.skip(typeof body.volumeMm3 !== "number", "this engine has no OCCT modeler");
  await request.post(`${api}/api/model/tree`, { data: { call: "close", key: "coupon-real-probe" } });
});

async function proxy(page: Page) {
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    await route.fulfill({ response: await route.fetch({ url, timeout: 120_000 }) });
  });
}

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/fit-coupon-real/${name}.png` });

test("Print a fit coupon… adds a real plate and pin to the plate, with the card still open on its cut", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await proxy(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="box"]').click();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume", { timeout: 60_000 });
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuSplitPrint").click();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Split to print");
  await page.locator("#modelPartAdd").click();
  await page.locator("#modelPartJointsOn").check();
  await page.locator("#modelPartJointFit").selectOption("loose");
  await expect(page.locator("#modelPartJointFitNote")).toHaveText("Starting fit. 0.25 mm each side (0.5 mm on the diameter).");
  await page.locator("#modelPartCoupon").click();
  await expect(page.locator("#modelPartCouponNote")).toContainText("Added fit-coupon-pla.step and fit-coupon-pla-pins.step to the plate. Fit coupon for PLA: 7 holes from 0.15 to 0.45 mm each side", { timeout: 90_000 });
  await expect(page.locator("#modelPanelTitle"), "the card stays open on its cut").toHaveText("Split to print");
  await page.waitForTimeout(500);
  await shot(page, "card");
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await expect(page.locator("#objectList .obj").nth(1)).toContainText("fit-coupon-pla.step");
  await expect(page.locator("#objectList .obj").nth(2)).toContainText("fit-coupon-pla-pins.step");
  await page.locator("#objectList .obj").nth(1).click();
  await page.waitForTimeout(1500);
  await shot(page, "plate");
  await page.getByRole("button", { name: "Front", exact: true }).click();
  await page.waitForTimeout(1200);
  await shot(page, "plate-front");
});

test("the engine's fitCoupon call answers the layout it was given: a valid plate and pin, volumes by hand", async ({ request }) => {
  const layout = {
    name: "probe",
    sizeMm: [40, 10, 20],
    holes: [
      { x: 10, z: 10, radiusMm: 3.1, depthMm: 2.4, teardrop: true },
      { x: 28, z: 10, radiusMm: 3.2, depthMm: 2.4, teardrop: false },
    ],
    strokes: [],
    strokeMm: 0.6,
    engraveMm: 0.4,
    pins: [{ x: 10, y: 16, radiusMm: 3, lengthMm: 4 }],
  };
  const res = await request.post(`${api}/api/model/tree`, { data: { call: "fitCoupon", spec: layout } });
  const body = (await res.json()) as { plate: { volumeMm3: number; solids: number; stepB64: string }; pins: { volumeMm3: number; solids: number }; error?: string };
  expect(body.error).toBeUndefined();
  const bored = (0.75 * Math.PI + 1) * 3.1 * 3.1 * 2.4 + Math.PI * 3.2 * 3.2 * 2.4;
  expect(body.plate.solids).toBe(1);
  expect(body.plate.volumeMm3).toBeCloseTo(40 * 10 * 20 - bored, 6);
  expect(Buffer.from(body.plate.stepB64, "base64").toString("latin1")).toContain("PRODUCT('probe'");
  expect(body.pins.volumeMm3).toBeCloseTo(Math.PI * 9 * 4 - 2 * Math.PI * 0.25 * (3 - 0.5 / 3), 6);
  const refused = await request.post(`${api}/api/model/tree`, { data: { call: "fitCoupon", spec: { ...layout, holes: [{ x: 1, z: 10, radiusMm: 3.1, depthMm: 2.4, teardrop: false }] } } });
  expect(((await refused.json()) as { error: string }).error).toBe("The coupon's hole 1 reaches outside the plate");
});
