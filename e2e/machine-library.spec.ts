import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
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

test("filament and nozzle pick the pressure advance, and a bad file can be retried", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await expect(page.locator("#machinePrinter")).toHaveValue("lime-220");
  await expect(page.locator("#machineFilament")).toHaveValue("lime-pla");
  await expect(page.locator("#machineNozzle")).toHaveValue("0.4");
  await expect(page.locator("#machineAdvance")).toHaveValue("0");
  await expect(page.locator("#machineFlow")).toHaveValue("1");
  await expect(page.locator("#machineTemps")).toHaveText("Nozzle 200 °C · bed 60 °C");

  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });

  await page.locator("#machineFilament").selectOption("lime-petg");

  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  await expect(page.locator("#machineAdvance")).toHaveValue("0.05");
  await expect(page.locator("#machineTemps")).toHaveText("Nozzle 240 °C · bed 80 °C");

  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });

  await page.locator("#machineNozzle").selectOption("0.6");

  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  await expect(page.locator("#machineAdvance")).toHaveValue("0.06");
  await expect(page.locator("#printerChipLabel")).toHaveText("Lime 220 · PETG · 0.6 mm");

  await page.keyboard.press("Control+z");
  await expect(page.locator("#machineNozzle")).toHaveValue("0.4");
  await expect(page.locator("#machineAdvance")).toHaveValue("0.05");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#machineFilament")).toHaveValue("lime-pla");
  await expect(page.locator("#machineAdvance")).toHaveValue("0");
  await expect(page.locator("#machineTemps")).toHaveText("Nozzle 200 °C · bed 60 °C");

  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });

  await page.locator("#machineFilament").selectOption("lime-petg");

  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  await page.locator("#machineMore > summary").click();
  await expect(page.locator("#machineStart")).toHaveValue("");
  await expect(page.locator("#machineEnd")).toHaveValue("");
  await expect(page.locator("label", { has: page.locator("#machineStart") })).toHaveAttribute("data-tip", /inserted into Export and Send/);
  const download = page.waitForEvent("download");
  await page.locator("#machineExport").click();
  expect((await download).suggestedFilename()).toBe("Lime_220__PETG.limemachine.json");

  await page.locator("#machineFile").setInputFiles({
    name: "bad.limemachine.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  const toast = page.locator("#toasts").getByRole("alert").filter({ hasText: "This file is not a Lime Slice machine profile." });
  await expect(toast).toBeVisible();
  const picker = page.waitForEvent("filechooser");
  await toast.getByRole("button", { name: "Retry" }).click();
  expect(await picker).toBeTruthy();

  const file = {
    version: 1,
    printer: {
      name: "Shop",
      bedX: 250,
      bedY: 210,
      bedZ: 200,
      maxVolumetricMm3S: 11,
      maxAccel: 3000,
      startGcode: "; shop",
      endGcode: "; end",
    },
    filament: {
      name: "Shop PLA",
      material: "PLA",
      diameterMm: 1.75,
      densityGCm3: 1.24,
      costPerKg: 18,
      nozzleTemp: 210,
      bedTemp: 55,
      pressureAdvance: { "0.4": 0.02 },
      linearAdvance: { "0.4": 0 },
    },
    nozzleMm: 0.4,
  };
  await page.locator("#machineFile").setInputFiles({
    name: "shop.limemachine.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.locator("#machinePrinter option", { hasText: "Shop" })).toHaveCount(1);
  await expect(page.locator("#bedx")).toHaveValue("250");
  await expect(page.locator("#machineAdvance")).toHaveValue("0.02");
  await expect(page.locator("#machineTemps")).toHaveText("Nozzle 210 °C · bed 55 °C");
  await page.locator("#machineMore > summary").click();
  await expect(page.locator("#machineHost")).toHaveValue("");
  await page.locator("#machineMore > summary").click();

  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });

  await page.locator("#machinePrinter").selectOption("lime-220");

  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  await page.locator("#machineMore > summary").click();
  await page.locator("#machineDelete").click();
  await expect(page.locator("#toasts").getByRole("status").filter({ hasText: "Built-in profiles stay in the catalog." })).toBeVisible();
  await page.locator("#machineDuplicate").click();
  await expect(page.locator("#machinePrinter option", { hasText: "Lime 220 copy" })).toHaveCount(1);
});

test("one advance control follows the printer's firmware, and only that advance is sent", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: cube });
  });
  await page.goto("/");
  await autoSliceOff(page);
  await expect(page.locator("#secondFilament")).toHaveCount(0);
  await expect(page.locator("#pa")).toHaveCount(0);
  await expect(page.locator("#la")).toHaveCount(0);
  await expect(page.locator("#pafw")).toHaveCount(0);
  await expect(page.locator("#machineFirmware")).toHaveValue("klipper");
  await expect(page.locator("label:has(#machineAdvance)")).toContainText("Pressure advance");
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machineFilament").selectOption("lime-petg");
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].printer).toMatchObject({ pressureAdvance: 0.05 });
  expect(bodies[0].printer).not.toHaveProperty("linearAdvance");

  await page.locator("#machineFirmware").selectOption("marlin");
  await expect(page.locator("label:has(#machineAdvance)")).toContainText("Linear advance K");
  await expect(page.locator("#machineAdvance")).toHaveValue("0");
  await page.locator("#machineAdvance").fill("0.8");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].printer).toMatchObject({ linearAdvance: 0.8 });
  expect(bodies[1].printer).not.toHaveProperty("pressureAdvance");

  // The firmware is the printer's: it stays after a reload, and the value typed under it is kept.
  await page.reload();
  await expect(page.locator("#machineFirmware")).toHaveValue("marlin");
  await expect(page.locator("#machineAdvance")).toHaveValue("0.8");
});

test.describe("compact machine library", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("the prepare canvas stays in front at the peek", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare viewport share ${prepare}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#compactTabs [data-tab=device]").click();
    await expect(page.locator("#compactDevice #machinePrinter")).toBeVisible();
    await expect(page.locator("#compactDevice #machineFilament")).toBeVisible();
    await page.locator("#compactTabs [data-tab=settings]").click();
    await expect(page.locator("#machineAdvance")).toBeVisible();
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    const peeked = await share(page, "#prepare");
    expect(peeked, `peek viewport share ${peeked}`).toBeGreaterThanOrEqual(0.7);
  });
});
