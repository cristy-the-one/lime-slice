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

test("the seam position is left out at Blend, sent otherwise, and kept in a preset", async ({ page }) => {
  await quiet(page);
  const bodies = await captureSlices(page);
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);

  const seam = page.locator("#seam");
  await expect(seam).toHaveValue("blend");
  await expect(seam.locator("option")).toHaveText(["Blend (strategy)", "Nearest", "Aligned", "Rear"]);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  await sliceSettled(page);
  expect(bodies[0]).not.toHaveProperty("seam");
  expect(bodies[0]).toHaveProperty("scarfSeam", "blend");

  await seam.selectOption("rear");
  await expect(page.locator("label.setting", { has: page.locator("#seam") })).toHaveClass(/is-modified/);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  await sliceSettled(page);
  expect(bodies[1]).toHaveProperty("seam", "rear");

  await page.locator("#left .profile-more > summary").click();
  await page.locator("#profileName").fill("Back seam");
  await page.locator("#profileSave").click();
  await expect(page.locator("#profilePick option:checked")).toHaveText("Back seam");
  await page.locator("#seam").selectOption("blend");
  await expect(page.locator("#seam")).toHaveValue("blend");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(3);
  await sliceSettled(page);
  expect(bodies[2]).not.toHaveProperty("seam");

  await page.locator("#profilePick").selectOption({ label: "Back seam" });
  await expect(page.locator("#seam")).toHaveValue("rear");
  // The profile brings back a recipe the app already stored, so it may refresh by itself
  // before this click lands: a slow runner sends that request and then the click's.
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(4);
  expect(bodies.at(-1)).toHaveProperty("seam", "rear");

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

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toHaveProperty("seam");
  expect(bodies[0]).not.toHaveProperty("ironing");

  await page.locator("#seam").selectOption("nearest");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toHaveProperty("seam", "nearest");
  expect(bodies[1]).not.toHaveProperty("ironing");

  await page.locator("#seam").selectOption("aligned");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]).toHaveProperty("seam", "aligned");

  await page.locator("#seam").selectOption("rear");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(4);
  expect(bodies[3]).toHaveProperty("seam", "rear");

  await page.locator("#seam").selectOption("blend");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(5);
  await page.waitForTimeout(400);
  expect(bodies[4]).not.toHaveProperty("seam");
  expect(bodies[4]).not.toHaveProperty("ironing");

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
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(6);
  expect(bodies[5]).not.toHaveProperty("seam");
  expect(bodies[5]).toHaveProperty("ironing", { flow: 0.15, speed: 30, spacing: 0.2 });
  await expect(page.locator("#toasts").getByRole("status").filter({ hasText: /ironing/i })).toHaveCount(0);

  await page.keyboard.press("Control+z");
  await expect(page.locator("#ironspace")).toHaveValue("0.1");
  await expect(page.locator("#ironspeed")).toHaveValue("30");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#ironspeed")).toHaveValue("20");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#ironflow")).toHaveValue("10");
  await expect(page.locator("#ironing")).toBeChecked();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(7);
  expect(bodies[6]).toHaveProperty("ironing", {});
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
