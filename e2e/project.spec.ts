import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const out = path.resolve("artifacts/project");
fs.mkdirSync(out, { recursive: true });

test("save a project, refuse a damaged file, and open it again", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();

  await page.keyboard.press("Control+k");
  await page.locator("#paletteInput").fill("project");
  await expect(page.locator("#paletteList")).toContainText("Save project");
  await expect(page.locator("#paletteList")).toContainText("Open mesh or project");
  await page.screenshot({ path: path.join(out, "desktop-commands.png") });
  await page.keyboard.press("Escape");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press("Control+s"),
  ]);
  const saved = fs.readFileSync((await download.path())!);
  const doc = JSON.parse(saved.toString("utf8")) as { version: number; mesh: { name: string }; supportEdits: unknown[] };
  expect(doc.version).toBe(1);
  expect(doc.mesh.name).toContain("cube");
  expect(doc.supportEdits).toEqual([]);

  await page.locator("#projectFile").setInputFiles({
    name: "broken.lime",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await expect(page.locator(".toast-error")).toContainText("not a Lime Slice project");
  await page.screenshot({ path: path.join(out, "desktop-corrupt.png") });

  await page.locator("#lh").fill("0.28");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#projectFile").setInputFiles({
    name: "cube.lime",
    mimeType: "application/json",
    buffer: saved,
  });
  await expect(page.locator("#objectList")).toContainText("calibration_cube");
  await expect(page.locator("#lh")).toHaveValue("0.2");
  await page.evaluate(() => document.querySelector("#toasts")?.replaceChildren());
  await page.screenshot({ path: path.join(out, "desktop-opened.png") });
});

test.describe("compact project menu", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("the overflow menu offers open and save", async ({ page }) => {
    await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.locator("#compactTop summary").click();
    await expect(page.getByRole("button", { name: "Save project" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open project" })).toBeVisible();
    await page.screenshot({ path: path.join(out, "compact-menu.png") });
  });
});
