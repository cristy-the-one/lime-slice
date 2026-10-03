import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_PRESET } from "../src/presets.ts";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
}

async function share(page: Page, selector: string) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
  }, selector);
  expect(box, selector).not.toBeNull();
  return canvasShare({ width: box!.width, height: box!.height }, { width: box!.viewW, height: box!.viewH });
}

async function openMore(page: Page) {
  await page.locator("#left .profile-more > summary").click();
}

test("a profile switch restores with undo", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.locator("[data-level-choice=simple]").click();
  await openMore(page);
  await page.locator("#profileName").fill("Simple");
  await page.locator("#profileSave").click();
  await expect(page.locator("#toasts").getByRole("status").filter({ hasText: "Saved Simple." })).toBeVisible();
  await expect(page.locator("#profilePick option", { hasText: "Simple" })).toHaveCount(1);

  await page.locator("[data-level-choice=expert]").click();
  await page.locator("#lh").fill("0.28");
  await openMore(page);
  await page.locator("#profileName").fill("Thick");
  await page.locator("#profileSave").click();
  await expect(page.locator("#profilePick")).toHaveValue(/.+/);
  const thick = await page.locator("#profilePick").inputValue();

  await page.locator("#profilePick").selectOption({ label: "Simple" });
  await expect(page.locator("#lh")).toHaveValue("0.2");
  await expect(page.locator("[data-level-choice=simple]")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#lh")).toHaveValue("0.28");
  await expect(page.locator("[data-level-choice=expert]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#profilePick")).toHaveValue(thick);

  await openMore(page);
  const download = page.waitForEvent("download");
  await page.locator("#settingsProfileExport").click();
  expect((await download).suggestedFilename()).toBe("Thick.limeprofile.json");

  await page.keyboard.press("Control+k");
  await page.locator("#paletteInput").fill("Duplicate settings profile");
  await page.keyboard.press("Enter");
  await expect(page.locator("#profilePick option", { hasText: "Thick copy" })).toHaveCount(1);
});

test("a bad profile file toasts Retry and a valid file applies", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.locator("#profileFile").setInputFiles({
    name: "bad.limeprofile.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  const toast = page.locator("#toasts").getByRole("alert").filter({ hasText: "This file is not a Lime Slice settings profile." });
  await expect(toast).toBeVisible();
  const picker = page.waitForEvent("filechooser");
  await toast.getByRole("button", { name: "Retry" }).click();
  expect(await picker).toBeTruthy();

  const file = { version: 1, name: "Imported", settings: { ...DEFAULT_PRESET, layerHeight: 0.32 }, level: "advanced" };
  await page.locator("#profileFile").setInputFiles({
    name: "imported.limeprofile.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.locator("#lh")).toHaveValue("0.32");
  await expect(page.locator("[data-level-choice=advanced]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#profilePick option", { hasText: "Imported" })).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator("#lh")).toHaveValue("0.2");
});

test.describe("compact profile picker", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("the picker sits in the sheet and the prepare canvas stays in front", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare viewport share ${prepare}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#compactTabs [data-tab=settings]").click();
    await expect(page.locator("#profilePick")).toBeVisible();
    await expect(page.locator("#profilePick")).toHaveAttribute("aria-label", "Settings profile");
    await expect(page.locator("#profileSave")).toBeVisible();
  });
});
