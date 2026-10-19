import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const beltCube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-belt.json"), "utf8"));

test.use({ viewport: { width: 1440, height: 900 } });

async function quiet(page: Page, reply: unknown = cube) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: reply }));
}

async function openCube(page: Page) {
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
}

/** What the eye reads: the label's size and the callout line's thickness, in CSS pixels. */
async function look(host: Locator) {
  return host.evaluate((el) => {
    const label = el.querySelector(".measure text.m-dim")!;
    const line = el.querySelector(".measure .m-line")!;
    return { font: getComputedStyle(label).fontSize, stroke: getComputedStyle(line).strokeWidth };
  });
}

/** How many callout labels and line segments touch the scale bar's rectangle. -1 when the view draws no bar. */
async function barCollisions(host: Locator) {
  return host.locator(".measure svg").evaluate((svg) => {
    const origin = svg.getBoundingClientRect();
    const bar = [...svg.querySelectorAll(".m-scale, .m-scale-label")].map((el) => el.getBoundingClientRect());
    if (bar.length < 2) return -1;
    const rect = { l: Math.min(...bar.map((r) => r.left)), t: Math.min(...bar.map((r) => r.top)), r: Math.max(...bar.map((r) => r.right)), b: Math.max(...bar.map((r) => r.bottom)) };
    const inside = (x: number, y: number) => x >= rect.l && x <= rect.r && y >= rect.t && y <= rect.b;
    const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) => {
      const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
      return side(ax, ay, bx, by, cx, cy) * side(ax, ay, bx, by, dx, dy) <= 0 && side(cx, cy, dx, dy, ax, ay) * side(cx, cy, dx, dy, bx, by) <= 0;
    };
    let hits = 0;
    for (const label of svg.querySelectorAll(".m-dim, .m-bed")) {
      const r = label.getBoundingClientRect();
      if (r.left < rect.r && r.right > rect.l && r.top < rect.b && r.bottom > rect.t) hits++;
    }
    for (const line of svg.querySelectorAll(".m-line")) {
      const nums = line.getAttribute("d")!.match(/-?[\d.]+/g)!.map(Number);
      for (let i = 0; i + 3 < nums.length; i += 4) {
        const [ax, ay, bx, by] = [nums[i]! + origin.left, nums[i + 1]! + origin.top, nums[i + 2]! + origin.left, nums[i + 3]! + origin.top];
        const edges: [number, number, number, number][] = [[rect.l, rect.t, rect.r, rect.t], [rect.r, rect.t, rect.r, rect.b], [rect.r, rect.b, rect.l, rect.b], [rect.l, rect.b, rect.l, rect.t]];
        if (inside(ax, ay) || inside(bx, by) || edges.some(([cx, cy, dx, dy]) => cross(ax, ay, bx, by, cx, cy, dx, dy))) hits++;
      }
    }
    return hits;
  });
}

const dims = (host: Locator) => host.locator(".measure text.m-dim");

test("Prepare measures the selected part and keeps its look when the part is scaled", async ({ page }) => {
  await quiet(page);
  await openCube(page);
  await page.locator("#tabPrepare").click();
  const stage = page.locator("#prepareBody");
  await expect(dims(stage)).toHaveCount(3);
  expect(await dims(stage).allTextContents()).toEqual(["20.0 mm", "20.0 mm", "20.0 mm"]);
  expect(await dims(stage).evaluateAll((all) => all.map((el) => el.getAttribute("data-axis")))).toEqual(["x", "y", "z"]);
  const before = await look(stage);
  expect(before.font).toBe("11px");
  expect(before.stroke).toBe("1px");
  expect(await stage.locator(".measure").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");

  await page.locator("#partScale").fill("200");
  await page.locator("#partScale").press("Enter");
  await expect.poll(async () => dims(stage).allTextContents()).toEqual(["40.0 mm", "40.0 mm", "40.0 mm"]);
  expect(await look(stage)).toEqual(before);

  await page.locator("#partScale").fill("50");
  await page.locator("#partScale").press("Enter");
  await expect.poll(async () => dims(stage).allTextContents()).toEqual(["10.0 mm", "10.0 mm", "10.0 mm"]);
  expect(await look(stage)).toEqual(before);
});

test("a stretched part reads each extent on its own axis", async ({ page }) => {
  await quiet(page);
  await openCube(page);
  await page.locator("#tabPrepare").click();
  const stage = page.locator("#prepareBody");
  await expect(dims(stage)).toHaveCount(3);
  // A part whose three sides differ tells the axes apart; a cube cannot.
  // The cube is unsaved, so opening another sample asks before it replaces the plate.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.locator('[data-sample="thin_fin.stl"]').click();
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await expect(page.locator("#objectList .obj b")).toHaveText("thin_fin.stl");
  await expect.poll(async () => dims(stage).count()).toBe(3);
  const byAxis = await dims(stage).evaluateAll((all) => Object.fromEntries(all.map((el) => [el.getAttribute("data-axis"), el.textContent])));
  const size = await page.locator("[data-selected='true'] span").first().innerText();
  const [sx, sy, sz] = size.match(/[\d.]+/g)!.map(Number);
  expect(byAxis).toEqual({ x: `${sx!.toFixed(1)} mm`, y: `${sy!.toFixed(1)} mm`, z: `${sz!.toFixed(1)} mm` });
});

test("Measure turns it all off, a reload keeps that, and Shift+M brings it back", async ({ page }) => {
  await quiet(page);
  await openCube(page);
  await page.locator("#tabPrepare").click();
  await expect(dims(page.locator("#prepareBody"))).toHaveCount(3);
  const measure = page.locator("#measureField");
  await expect(measure).toHaveAttribute("aria-pressed", "true");

  await measure.click();
  await expect(measure).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".measure svg")).toHaveCount(0);

  await page.reload();
  await expect(measure).toHaveAttribute("aria-pressed", "false");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabPrepare").click();
  await page.waitForTimeout(800);
  await expect(page.locator(".measure svg")).toHaveCount(0);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Shift+M");
  await expect(measure).toHaveAttribute("aria-pressed", "true");
  await expect(dims(page.locator("#prepareBody"))).toHaveCount(3);
  expect(await page.evaluate(() => localStorage.getItem("lime-slice-measure"))).toBe("1");
});

test("Preview 3D and the 2D layer view show the callouts and an honest scale bar", async ({ page }) => {
  await quiet(page);
  await openCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  const solid = page.locator("#pane3d");
  await expect(dims(solid)).toHaveCount(3);
  expect(await dims(solid).allTextContents()).toEqual(["20.0 mm", "20.0 mm", "20.0 mm"]);
  const bar = solid.locator(".measure .m-scale-label");
  await expect(bar).toHaveText(/^\d+(\.\d+)? (mm|m)$/);
  expect(await barCollisions(solid)).toBe(0);

  const zoomIn = async () => {
    await page.locator("#view3d").evaluate((el) => {
      const rect = el.getBoundingClientRect();
      for (let i = 0; i < 10; i++) el.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
    });
  };
  const before = await bar.textContent();
  await zoomIn();
  await expect.poll(async () => bar.textContent()).not.toBe(before);
  const barPx = async (host: Locator) => host.locator(".measure .m-scale").evaluate((el) => {
    const nums = el.getAttribute("d")!.match(/-?[\d.]+/g)!.map(Number);
    return nums[nums.length - 2]! - nums[0]!;
  });
  expect(await barPx(solid)).toBeGreaterThanOrEqual(55);
  expect(await barPx(solid)).toBeLessThanOrEqual(141);

  await page.getByRole("button", { name: "2D", exact: true }).click();
  const flat = page.locator("#pane2d");
  await expect(dims(flat)).toHaveCount(2);
  expect(await dims(flat).allTextContents()).toEqual(["20.0 mm", "20.0 mm"]);
  expect(await barCollisions(flat)).toBe(0);
  const mm = Number((await flat.locator(".measure .m-scale-label").textContent())!.replace(/\D+$/, ""));
  const cssPerMm = await page.locator("#view").evaluate((el) => Number((el as HTMLCanvasElement).dataset.flatScale) * el.clientWidth / (el as HTMLCanvasElement).width);
  expect(Math.abs((await barPx(flat)) / mm - cssPerMm)).toBeLessThan(0.02);

  // Zoomed in, a label that would leave the pane is dropped rather than squeezed in.
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect.poll(async () => dims(solid).count()).toBeGreaterThan(0);
  await expect(solid.locator(".measure .m-scale-label")).toHaveCount(1);
  await expect(flat.locator(".measure .m-scale-label")).toHaveCount(1);
  expect(await barCollisions(flat)).toBe(0);
  expect(await barCollisions(solid)).toBe(0);
});

test("the belt printer measures the part it prints and numbers its bed in 50 mm steps", async ({ page }) => {
  await quiet(page, beltCube);
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machinePrinter").selectOption("ideaformer-ir3-v2");
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabPrepare").click();
  const stage = page.locator("#prepareBody");
  await expect(stage.locator(".measure .m-scale-label")).toHaveCount(1);
  await expect.poll(async () => dims(stage).allTextContents()).toEqual(["20.0 mm", "20.0 mm", "20.0 mm"]);

  await page.locator("#slice").click();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  const solid = page.locator("#pane3d");
  await expect(solid.locator(".measure .m-bed").first()).toBeVisible();
  const numbers = (await solid.locator(".measure .m-bed").allTextContents()).map(Number);
  expect(numbers.length).toBeGreaterThan(0);
  expect(numbers.every((v) => v > 0 && v % 50 === 0)).toBe(true);
});
