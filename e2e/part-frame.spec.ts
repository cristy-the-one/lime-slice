import { expect, test, type Page } from "@playwright/test";

/**
 * Move a sliced part against a real engine, which replies in the part frame:
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test part-frame
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(300_000);

const SLICE_MS = 120_000;

async function sliced(page: Page) {
  await expect(page.locator("#slice")).toBeEnabled({ timeout: SLICE_MS });
  await expect(page.locator("#cancel")).toBeDisabled();
}

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
  await expect(page.locator("#status")).toContainText("loaded", { timeout: 30_000 });
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
  await expect(page.locator("#gcodePane .line")).not.toHaveCount(0);
  await expect(page.locator("#gcodePane .line.on")).toHaveCount(1);
});
