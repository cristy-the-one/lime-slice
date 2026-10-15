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

test("a printer answers, an unreachable host can be retried, and upload can start the print", async ({ page }) => {
  await quiet(page);
  let block = true;
  const uploads: { header: string | undefined; body: string }[] = [];
  await page.route("http://127.0.0.1:9/**", (route) => {
    if (block) return route.abort();
    const url = route.request().url();
    if (url.endsWith("/api/version")) {
      return route.fulfill({
        json: { api: "1.0.0", version: "0.7.0", printer: "1", text: "PrusaLink 0.7.0", firmware: "1" },
      });
    }
    return route.abort();
  });
  let statusCalls = 0;
  await page.route("http://printer.local/**", async (route) => {
    const request = route.request();
    if (request.method() === "PUT" && request.url().includes("/api/v1/files/local/")) {
      uploads.push({ header: await request.headerValue("print-after-upload"), body: request.postData() ?? "" });
      return route.fulfill({ status: 201, body: "" });
    }
    if (request.url().endsWith("/api/v1/status")) {
      statusCalls += 1;
      if (statusCalls === 1) return route.fulfill({ json: { printer: { state: "IDLE" } } });
      return route.fulfill({ json: { printer: { state: "PRINTING" }, job: { progress: 10, time_remaining: 60 } } });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: cube }));

  await page.goto("/");
  await autoSliceOff(page);
  await expect(page.locator("#sendPrinter")).toBeHidden();
  await page.locator("#machineMore").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machineHost").fill("http://127.0.0.1:9");
  await page.locator("#machineKey").fill("secret");
  await expect(page.locator("#sendPrinter")).toBeVisible();
  await expect(page.locator("#sendPrinter")).toBeDisabled();
  await page.locator("#prusaTest").click();
  const toast = page.locator("#toasts").getByRole("alert").filter({ hasText: "Could not reach Prusa Link" });
  await expect(toast).toBeVisible();
  block = false;
  await toast.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("#prusaStatus")).toHaveText("PrusaLink 0.7.0");

  await page.locator("#fileMenu > summary").click();

  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#slice").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current", { timeout: 15_000 });
  await expect(page.locator("#sendPrinter")).toBeEnabled();
  await page.locator("#machineMore").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machineHost").fill("http://printer.local");
  await page.locator("#machineStartPrint").check();
  await page.locator("#sendPrinter").click();
  await expect(page.locator("#prusaStatus")).toHaveText("Uploaded. PRINTING · 10% · 1 min left");
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.header).toBe("?1");
  expect(uploads[0]?.body).toContain("fixture keeps estimates");
  await page.locator("#prusaJob").click();
  await expect(page.locator("#prusaStatus")).toHaveText("PRINTING · 10% · 1 min left");
});

test("Moonraker printer.cfg import updates Klipper limits and offers to update bed and nozzle", async ({ page }) => {
  await quiet(page);
  await page.route("http://voron.local:7125/**", (route) => {
    const url = route.request().url();
    if (url.includes("/printer/objects/query?configfile=settings")) {
      return route.fulfill({
        json: {
          result: {
            status: {
              configfile: {
                settings: {
                  printer: {
                    max_velocity: 450,
                    max_accel: 15000,
                    square_corner_velocity: 9,
                    minimum_cruise_ratio: 0.35,
                    max_z_velocity: 30,
                    max_z_accel: 400,
                  },
                  extruder: {
                    instantaneous_corner_velocity: 2,
                    nozzle_diameter: 0.6,
                    filament_diameter: 1.75,
                    max_temp: 290,
                  },
                  heater_bed: {
                    max_temp: 110,
                  },
                  stepper_x: { position_max: 300 },
                  stepper_y: { position_max: 300 },
                  stepper_z: { position_max: 280 },
                  gcode_arcs: { resolution: 1 },
                },
              },
            },
          },
        },
      });
    }
    return route.fulfill({ status: 404, body: "" });
  });

  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("expert");
  await page.locator("#machineMore").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machineHostType").selectOption("moonraker");
  await page.locator("#machineHost").fill("http://voron.local:7125");
  await page.locator("#moonrakerImport").click();

  await expect(page.locator("#prusaStatus")).toContainText("Imported printer.cfg");
  await expect(page.locator("#prusaStatus")).toContainText("[gcode_arcs] found");
  await expect(page.locator("#machineFirmware")).toHaveValue("klipper");
  await expect(page.locator("#machineArcs")).toBeChecked();
  await expect(page.locator("#arcs")).toBeEnabled();
  await expect(page.locator("#vmax")).toHaveValue("450");
  await expect(page.locator("#accel")).toHaveValue("15000");
  await expect(page.locator("#scv")).toHaveValue("9");
  await expect(page.locator("#mcr")).toHaveValue("0.35");
  await expect(page.locator("#ecv")).toHaveValue("2");
  await expect(page.locator("#zvmax")).toHaveValue("30");
  await expect(page.locator("#zamax")).toHaveValue("400");

  // Bed and nozzle are offered via toast action ("3) offer to update the rest")
  const toast = page.locator("#toasts").getByRole("status").filter({ hasText: "300×300×280 mm bed" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Update bed & nozzle" }).click();
  await expect(page.locator("#bedx")).toHaveValue("300");
  await expect(page.locator("#bedy")).toHaveValue("300");
  await expect(page.locator("#bedz")).toHaveValue("280");
  await expect(page.locator("#machineNozzle")).toHaveValue("0.6");
});

test.describe("compact Prusa Link", () => {
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
    await autoSliceOff(page);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare viewport share ${prepare}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#compactTabs [data-tab=settings]").click();
    await page.evaluate(() => {
      const menu = document.querySelector<HTMLDetailsElement>("#machineMore");
      if (menu) menu.open = true;
    });
    await expect(page.locator("#machineHost")).toBeVisible();
    await expect(page.locator("#prusaTest")).toBeVisible();
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    const peeked = await share(page, "#prepare");
    expect(peeked, `peek viewport share ${peeked}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#compactTabs [data-tab=device]").click();
    await expect(page.locator("#compactSend")).toBeHidden();
    await expect(page.locator("#compactShare")).toBeVisible();
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    const afterDevice = await share(page, "#prepare");
    expect(afterDevice, `prepare viewport share after device ${afterDevice}`).toBeGreaterThanOrEqual(0.7);
  });
});
