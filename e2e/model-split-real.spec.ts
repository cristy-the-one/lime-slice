import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * Split to print against the real modeler:
 *   lime-slice serve --port 43218   (with the OCCT bridge next to it)
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test --workers=1 model-split-real
 *
 * Bound a run with Playwright's own timeout, never with a shell `timeout` around `npx playwright`: its SIGTERM kills
 * the browser under the page, and the page reports that as "Target crashed" (docs/okf/build/test-and-ci.md, "Target crashed" in a probe).
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(180_000);
test.use({ viewport: { width: 1440, height: 1000 } });

// The slicing job's engine has no OCCT bridge: then there is no modeler to cut with.
test.beforeAll(async ({ request }) => {
  const res = await request.post(`${api}/api/model/tree`, {
    data: { call: "open", key: "split-real-probe", primitive: { primitive: "box", origin: [0, 0, 0], size: [1, 1, 1], turn: [0, 0, 0] }, chordMm: 0.1 },
  });
  const body = (await res.json().catch(() => ({}))) as { volumeMm3?: number };
  test.skip(typeof body.volumeMm3 !== "number", "this engine has no OCCT modeler");
  await request.post(`${api}/api/model/tree`, { data: { call: "close", key: "split-real-probe" } });
});

/**
 * The page's engine calls, sent to `api`. The card supersedes a check while its fields are typed, so a reply can come
 * back for a request the page has already dropped: that one is let go instead of failing the test.
 */
async function proxy(page: Page) {
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    try {
      const res = await route.fetch({ url, timeout: 120_000 });
      await route.fulfill({ status: res.status(), headers: res.headers(), body: await res.body() });
    } catch (err) {
      if (page.isClosed() || /disposed|closed|Route is already handled/i.test(String(err))) return;
      throw err;
    }
  });
}

/** A 120 × 70 × 50 box, the Split to print card open on it with one cut through its middle (At X 0: the box is centred on the origin). Counts the page's crashes. */
async function cardOnBox(page: Page): Promise<{ crashes: () => number }> {
  let crashes = 0;
  page.on("crash", () => (crashes += 1));
  await proxy(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="box"]').click();
  for (const [id, value] of Object.entries({ modelDx: 120, modelDy: 70, modelDz: 50 })) await page.locator(`#${id}`).fill(String(value));
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume", { timeout: 60_000 });
  await expect(page.locator("#modelPanel")).toBeHidden();
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuSplitPrint").click();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Split to print");
  await page.locator("#modelPartClear").click();
  await page.locator("#modelPartAdd").click();
  await expect(page.locator("#modelPartAt-1")).toHaveValue("0");
  return { crashes: () => crashes };
}

const pieces = (page: Page) => page.locator("#modelPartPieces li");

function volume(text: string): number {
  const match = /([\d.,]+) mm³/.exec(text);
  return match ? Number(match[1]!.replace(/,/g, "")) : Number.NaN;
}

/** The card sits on the kernel's answer for a while, as a person reading it would; the page must still answer. */
async function idle(page: Page, crashes: () => number) {
  await page.waitForTimeout(12_000);
  expect(await page.evaluate(() => document.readyState)).toBe("complete");
  expect(crashes(), "the page did not crash").toBe(0);
}

async function applyToPlate(page: Page) {
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelPanel")).toBeHidden({ timeout: 60_000 });
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(2, { timeout: 30_000 });
}

test("a straight cut through the middle: the kernel's two halves show, the card idles, and Apply puts both on the plate", async ({ page }) => {
  const { crashes } = await cardOnBox(page);
  await expect(pieces(page)).toHaveCount(2, { timeout: 60_000 });
  await expect(pieces(page).nth(0)).toContainText("60 × 70 × 50 mm");
  await expect(pieces(page).nth(1)).toContainText("60 × 70 × 50 mm");
  // Half of 420,000 mm³, as the meshed solid measures it.
  for (const row of await pieces(page).allInnerTexts()) expect(volume(row)).toBeCloseTo(210_000, -2);
  await idle(page, crashes);
  await applyToPlate(page);
  expect(crashes()).toBe(0);
});

test("a zig-zag through the middle: the teeth go to the negative piece, 68 mm against 60 mm, and Apply puts both on the plate", async ({ page }) => {
  const { crashes } = await cardOnBox(page);
  await page.locator("#modelPartProfileKind").selectOption("zigzag");
  for (const [field, value] of [["#modelPartProfilePitch", "14"], ["#modelPartProfileDepth", "8"], ["#modelPartProfileAngle", "20"]] as const) {
    await page.locator(field).fill(value);
    await page.locator(field).dispatchEvent("change");
  }
  await expect(pieces(page)).toHaveCount(2, { timeout: 60_000 });
  await expect(pieces(page).nth(0)).toContainText("68 × 70 × 50 mm", { timeout: 60_000 });
  await expect(pieces(page).nth(1)).toContainText("60 × 70 × 50 mm");
  await idle(page, crashes);
  await applyToPlate(page);
  expect(crashes()).toBe(0);
});
