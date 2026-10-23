import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
}

/** Every slice body the page sends, answered with the cube fixture. */
async function captureSlices(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  return bodies;
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
}

/** The slice request is recorded before the reply rebuilds the settings panel. */
async function sliceSettled(page: Page) {
  await expect(page.locator("#slice")).toBeEnabled();
}

/**
 * The body this Slice click sends. A quiet refresh can add a request before the click, so
 * counting requests is not enough. The click disables the button until its own reply lands,
 * and nothing is sent after it, so the last body once the button is back is the click's.
 */
async function sliceClick(page: Page, bodies: Record<string, unknown>[]) {
  const before = bodies.length;
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBeGreaterThan(before);
  await sliceSettled(page);
  return bodies.at(-1)!;
}

test("the seam position is left out at Blend, sent otherwise, and kept in a preset", async ({ page }) => {
  await quiet(page);
  const bodies = await captureSlices(page);
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);

  const seam = page.locator("#seam");
  await expect(seam).toHaveValue("blend");
  await expect(seam.locator("option")).toHaveText(["Blend (strategy)", "Nearest", "Aligned", "Rear"]);
  const first = await sliceClick(page, bodies);
  expect(first).not.toHaveProperty("seam");
  expect(first).toHaveProperty("scarfSeam", "blend");

  await seam.selectOption("rear");
  await expect(page.locator("label.setting", { has: page.locator("#seam") })).toHaveClass(/is-modified/);
  expect(await sliceClick(page, bodies)).toHaveProperty("seam", "rear");

  await page.locator("#left .profile-more > summary").click();
  await page.locator("#profileName").fill("Back seam");
  await page.locator("#profileSave").click();
  await expect(page.locator("#profilePick option:checked")).toHaveText("Back seam");
  await page.locator("#seam").selectOption("blend");
  await expect(page.locator("#seam")).toHaveValue("blend");
  // Blend and then the profile's Rear are recipes the app already sliced, so each may refresh by itself first.
  expect(await sliceClick(page, bodies)).not.toHaveProperty("seam");

  await page.locator("#profilePick").selectOption({ label: "Back seam" });
  await expect(page.locator("#seam")).toHaveValue("rear");
  expect(await sliceClick(page, bodies)).toHaveProperty("seam", "rear");

  await page.reload();
  await loadCube(page);
  await expect(page.locator("#seam")).toHaveValue("blend");
  await page.locator("#profilePick").selectOption({ label: "Back seam" });
  await expect(page.locator("#seam")).toHaveValue("rear");
});

test("a settings profile keeps the seam position", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.locator("#seam").selectOption("aligned");
  await page.locator("#left .profile-more > summary").click();
  await page.locator("#profileName").fill("Aligned seam");
  await page.locator("#profileSave").click();
  await expect(page.locator("#profilePick option:checked")).toHaveText("Aligned seam");
  await page.locator("#seam").selectOption("blend");
  await page.locator("#profilePick").selectOption({ label: "Aligned seam" });
  await expect(page.locator("#seam")).toHaveValue("aligned");
  await page.locator("#find").fill("rear");
  await expect(page.locator("label.setting", { has: page.locator("#seam") })).toBeVisible();
  await expect(page.locator("label.setting", { has: page.locator("#lh") })).toBeHidden();
});

test("ironing is sent only while on, without a toast, and undone", async ({ page }) => {
  await quiet(page);
  const bodies = await captureSlices(page);
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);

  await expect(page.locator("#ironing")).not.toBeChecked();
  await expect(page.locator("#ironflow")).toHaveCount(0);
  await page.locator("#seam").selectOption("rear");
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+z");
  await expect(page.locator("#seam")).toHaveValue("blend");
  await page.keyboard.press("Control+Shift+Z");
  await expect(page.locator("#seam")).toHaveValue("rear");
  await page.locator("#seam").selectOption("blend");
  await page.waitForTimeout(400);

  const first = await sliceClick(page, bodies);
  expect(first).not.toHaveProperty("seam");
  expect(first).not.toHaveProperty("ironing");

  await page.locator("#seam").selectOption("nearest");
  const nearest = await sliceClick(page, bodies);
  expect(nearest).toHaveProperty("seam", "nearest");
  expect(nearest).not.toHaveProperty("ironing");

  await page.locator("#seam").selectOption("aligned");
  expect(await sliceClick(page, bodies)).toHaveProperty("seam", "aligned");

  await page.locator("#seam").selectOption("rear");
  expect(await sliceClick(page, bodies)).toHaveProperty("seam", "rear");

  // Blend is the first slice's recipe, so the app may refresh it by itself before this click lands.
  await page.locator("#seam").selectOption("blend");
  const blend = await sliceClick(page, bodies);
  expect(blend).not.toHaveProperty("seam");
  expect(blend).not.toHaveProperty("ironing");

  await page.locator("#ironing").check();
  await expect(page.locator("#ironflow")).toHaveValue("10");
  await expect(page.locator("#ironspeed")).toHaveValue("20");
  await expect(page.locator("#ironspace")).toHaveValue("0.1");
  await page.waitForTimeout(400);
  await page.locator("#ironflow").fill("15");
  await page.waitForTimeout(400);
  await page.locator("#ironspeed").fill("30");
  await page.waitForTimeout(400);
  await page.locator("#ironspace").fill("0.2");
  await expect(page.locator("#ironflow")).toHaveValue("15");
  await expect(page.locator("#ironspeed")).toHaveValue("30");
  await expect(page.locator("#ironspace")).toHaveValue("0.2");
  await page.waitForTimeout(400);
  const ironed = await sliceClick(page, bodies);
  expect(ironed).not.toHaveProperty("seam");
  expect(ironed).toHaveProperty("ironing", { flow: 0.15, speed: 30, spacing: 0.2 });
  await expect(page.locator("#toasts").getByRole("status").filter({ hasText: /ironing/i })).toHaveCount(0);

  await page.keyboard.press("Control+z");
  await expect(page.locator("#ironspace")).toHaveValue("0.1");
  await expect(page.locator("#ironspeed")).toHaveValue("30");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#ironspeed")).toHaveValue("20");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#ironflow")).toHaveValue("10");
  await expect(page.locator("#ironing")).toBeChecked();
  expect(await sliceClick(page, bodies)).toHaveProperty("ironing", {});
  await page.keyboard.press("Control+z");
  await expect(page.locator("#ironing")).not.toBeChecked();
});

test.describe("compact seam position", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("the prepare canvas keeps at least 70% at the peek", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await autoSliceOff(page);
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const box = await page.evaluate(() => {
      const rect = document.querySelector("#prepare")!.getBoundingClientRect();
      return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
    });
    const share = canvasShare({ width: box.width, height: box.height }, { width: box.viewW, height: box.viewH });
    expect(share, `prepare viewport share ${share}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#compactTabs [data-tab=settings]").click();
    await page.locator("#seam").scrollIntoViewIfNeeded();
    await expect(page.locator("#seam")).toBeVisible();
    await page.locator("#ironing").scrollIntoViewIfNeeded();
    await expect(page.locator("#ironing")).toBeVisible();
    await page.locator("#ironing").check();
    await expect(page.locator("#ironflow")).toBeVisible();
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => {
      const rect = document.querySelector("#prepare")!.getBoundingClientRect();
      return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
    });
    const peeked = canvasShare({ width: after.width, height: after.height }, { width: after.viewW, height: after.viewH });
    expect(peeked, `prepare viewport share after ironing ${peeked}`).toBeGreaterThanOrEqual(0.7);
  });
});
