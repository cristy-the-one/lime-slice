import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

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

async function openCube(page: Page) {
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
}

test("an unreachable engine toasts Retry and a second probe connects", async ({ page }) => {
  let health = 0;
  await page.route("**/api/health", (route) => {
    health += 1;
    if (health === 1) return route.fulfill({ status: 500, json: { error: "down" } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const toast = page.locator("#toasts").getByRole("alert").filter({ hasText: "Slicer engine not running" });
  await expect(toast).toBeVisible();
  await expect(page.locator("#engineLink")).toHaveText("Engine unreachable");
  await toast.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("#engineLink")).toHaveText("Engine connected");
  await expect(page.locator("#toasts").getByRole("alert").filter({ hasText: "Slicer engine not running" })).toHaveCount(0);
});

test("an unreadable slice reply toasts Retry and the next attempt can export", async ({ page }) => {
  let slices = 0;
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => {
    slices += 1;
    if (slices === 1) return route.fulfill({ status: 502, body: "upstream" });
    return route.fulfill({ json: cube });
  });
  await openCube(page);
  await page.locator("#slice").click();
  const toast = page.locator("#toasts").getByRole("alert").filter({ hasText: "not valid JSON" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("#estimate")).toContainText("g");
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  expect(slices).toBe(2);
});

test("an error the engine gives for the request offers no Retry, and Export slices again once it is fixed", async ({ page }) => {
  let slices = 0;
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => {
    slices += 1;
    if (slices === 1) return route.fulfill({ status: 400, json: { error: "planner broke" } });
    return route.fulfill({ json: cube });
  });
  await openCube(page);
  await page.locator("#slice").click();
  const toast = page.locator("#toasts").getByRole("alert").filter({ hasText: "planner broke" });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole("button")).toHaveCount(1);
  await expect(toast.getByRole("button", { name: "Dismiss" })).toHaveCount(1);
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "first");
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#export").click()]);
  expect(download.suggestedFilename()).toMatch(/\.gcode$/);
  expect(slices).toBe(2);
});

test("a bad mesh and a bad project toast Retry that reopens the file picker", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await expect(page.locator("#engineLink")).toHaveText("Engine connected");

  await page.locator("#file").setInputFiles({
    name: "bad.stl",
    mimeType: "model/stl",
    buffer: Buffer.from("this is not an stl"),
  });
  const mesh = page.locator("#toasts").getByRole("alert").filter({ hasText: "Could not read bad.stl." });
  await expect(mesh).toBeVisible();
  const meshPicker = page.waitForEvent("filechooser");
  await mesh.getByRole("button", { name: "Retry" }).click();
  expect(await meshPicker).toBeTruthy();

  await page.locator("#projectFile").setInputFiles({
    name: "nope.lime",
    mimeType: "application/json",
    buffer: Buffer.from("{not json"),
  });
  const project = page.locator("#toasts").getByRole("alert").filter({ hasText: "This file is not a Lime Slice project." });
  await expect(project).toBeVisible();
  const projectPicker = page.waitForEvent("filechooser");
  await project.getByRole("button", { name: "Retry" }).click();
  expect(await projectPicker).toBeTruthy();
});

test("named controls expose labels", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await expect(page.locator("#colorBy")).toHaveAttribute("aria-label", "Color by");
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play layer");
  await expect(page.locator("#find")).toHaveAttribute("aria-label", "Search settings");
  await page.keyboard.press("Control+k");
  await expect(page.locator("#paletteInput")).toBeFocused();
  await expect(page.locator("#paletteList")).toHaveAttribute("aria-label", "Matching commands");
  await page.keyboard.press("Escape");
  await expect(page.locator("#palette")).toBeHidden();
});

test.describe("compact sheet keyboard", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("peek keeps the canvas, and arrows move the sheet, tabs, and palette", async ({ page }) => {
    await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare viewport share ${prepare}`).toBeGreaterThanOrEqual(0.7);

    await page.locator("#compactSheetHandle").focus();
    await expect(page.locator("#compactSheetHandle")).toHaveAttribute("aria-keyshortcuts", "ArrowUp ArrowDown Home End");
    await page.keyboard.press("ArrowUp");
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "half");
    await expect(page.locator("#compactSheetHandle")).toHaveAttribute("aria-valuetext", "half");

    await expect(page.locator("#compactTabs [tabindex='0']")).toHaveCount(1);
    await page.locator("#compactTabs [data-tab=prepare]").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#compactTabs [data-tab=settings]")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#compactTabs [data-tab=settings]")).toHaveAttribute("aria-controls", "compactSheet");
    await expect(page.locator("#find")).toBeFocused();
    await expect(page.locator("#compactTabs [tabindex='0']")).toHaveCount(1);
    await expect(page.locator("#compactIso")).toHaveAttribute("aria-label", "Iso view");

    await page.keyboard.press("Control+k");
    await expect(page.locator("#paletteInput")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#palette")).toBeHidden();
  });
});

test("a focused model field names its axis for assistive tech", async ({ page }) => {
  const positions = [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 0, 0, 20, 20, 0, 0, 20, 0];
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions } }));
  await mockModelTree(page, { open: () => ({ volumeMm3: 4000, positions, triangles: [0, 0], faces: [{ id: 0, areaMm2: 1 }], edges: [] }), probe: () => ({ ok: true }) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelDy").focus();
  await expect(page.locator("#modelDy")).toHaveAttribute("aria-describedby", "modelAspectDesc");
  await expect(page.locator("#modelAspectDesc")).toHaveText("Depth Y, 10 millimetres, lights the edges along Y");
  await expect(page.locator("#modelAspectBadge")).toHaveText("Y");
  await expect(page.locator("#modelDy")).toHaveCSS("outline-width", "2px");
  const ratios = await page.evaluate(() => {
    const root = document.documentElement;
    const read = (name: string) => getComputedStyle(root).getPropertyValue(name).trim();
    const mix = (paint: number[], back: number[], amount: number) => paint.map((value, i) => Math.round(value * amount + back[i]! * (1 - amount)));
    const parse = (hex: string) => {
      const value = hex.replace("#", "");
      return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
    };
    const out: { scheme: string; axis: string; against: string; ratio: number }[] = [];
    for (const scheme of ["dark", "light"]) {
      root.dataset.scheme = scheme;
      const stage = parse(read("--stage"));
      const ghost = mix(parse(read("--accent")), stage, 0.22);
      for (const axis of ["x", "y", "z"]) {
        const color = parse(read(`--axis-${axis}`));
        out.push({ scheme, axis, against: "stage", ratio: 0 });
        out.push({ scheme, axis, against: "ghost", ratio: 0 });
        const last = out.length;
        const lum = (rgb: number[]) => {
          const lin = rgb.map((value) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
        };
        const ratio = (a: number[], b: number[]) => {
          const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
          return (hi! + 0.05) / (lo! + 0.05);
        };
        out[last - 2]!.ratio = ratio(color, stage);
        out[last - 1]!.ratio = ratio(color, ghost);
      }
    }
    root.dataset.scheme = "";
    return out;
  });
  for (const row of ratios) expect(row.ratio, `${row.scheme} ${row.axis} on ${row.against}`).toBeGreaterThanOrEqual(3);
  if (process.env.UPDATE_SCREENSHOTS === "1") await page.screenshot({ path: "docs/screenshots/ui-review-3-1/ph08-after-badge.png" });
});
