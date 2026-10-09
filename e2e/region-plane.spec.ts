import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { GIZMO_SCREEN_PX } from "../src/gizmo-math";
import { boundsOf, ID_MATRIX, parseStl, transformPositions } from "../src/mesh-place";
import { encodePaths } from "../src/preview-wire";
import { nextSplitAt, roundSplit, splitMidpoint } from "../src/split-at";

const out = path.resolve("artifacts/region-plane");
fs.mkdirSync(out, { recursive: true });

const bridgeFile = fs.readFileSync(path.resolve("samples/bridge_span.stl"));
const bridgePos = parseStl(bridgeFile.buffer.slice(bridgeFile.byteOffset, bridgeFile.byteOffset + bridgeFile.byteLength));
if (!bridgePos) throw new Error("bridge_span.stl did not parse");
const placed = transformPositions(bridgePos, ID_MATRIX, 1, 220, 220, true);
const placedBounds = boundsOf(placed);
const midX = roundSplit(splitMidpoint(placedBounds, "x"));
const midY = roundSplit(splitMidpoint(placedBounds, "y"));

test("split defaults to the mesh midpoint", () => {
  const bounds = { min: [95, 102, 0] as [number, number, number], max: [125, 118, 10] as [number, number, number] };
  expect(nextSplitAt("load", 10, bounds, "x", false)).toBe(110);
  expect(nextSplitAt("axis", 10, bounds, "y", true)).toBe(110);
  expect(nextSplitAt("open", 10, bounds, "x", false)).toBe(110);
  expect(nextSplitAt("open", 100, bounds, "x", true)).toBe(100);
  expect(nextSplitAt("transform", 10, bounds, "x", true)).toBe(110);
  expect(nextSplitAt("transform", 100, bounds, "x", true)).toBe(100);
  expect(splitMidpoint(placedBounds, "x")).toBeGreaterThan(placedBounds.min[0]);
  expect(splitMidpoint(placedBounds, "x")).toBeLessThan(placedBounds.max[0]);
});

test("bridge By region starts inside the mesh and the plane and gizmo move it", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: fakeSlice() }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "Bridge" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
  await expect(page.locator("#prepareBody")).toBeVisible();
  await page.getByRole("button", { name: /^By region/ }).click();
  await expect.poll(async () => Number(await page.locator("#at").inputValue())).toBeCloseTo(midX, 1);
  await expect(page.locator("#banner")).not.toContainText("outside the mesh");
  await expect(page.locator("#gizmoReadout")).toContainText("low toughness");
  await expect(page.locator("#gizmoReadout")).toContainText("high speed");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, "prepare-region-plane.png") });
  await page.locator("#prepare").screenshot({ path: path.join(out, "prepare-canvas.png") });

  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.waitForTimeout(400);
  await page.locator("#view3d").screenshot({ path: path.join(out, "preview-3d-before-slice.png") });
  await page.getByRole("tab", { name: "Prepare", exact: true }).click();

  const box = (await page.locator("#prepare").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 140, cy + 8, { steps: 16 });
  await page.mouse.up();
  await expect.poll(async () => Number(await page.locator("#at").inputValue())).not.toBeCloseTo(midX, 0);
  const dragged = Number(await page.locator("#at").inputValue());
  expect(dragged).toBeGreaterThanOrEqual(placedBounds.min[0] - 0.05);
  expect(dragged).toBeLessThanOrEqual(placedBounds.max[0] + 0.05);
  await expect(page.locator("#banner")).not.toContainText("outside the mesh");
  await page.locator("#prepare").screenshot({ path: path.join(out, "prepare-after-drag.png") });

  await page.locator("#axis").selectOption("y");
  await expect.poll(async () => Number(await page.locator("#at").inputValue())).toBeCloseTo(midY, 1);
  await expect(page.locator("#banner")).not.toContainText("outside the mesh");
  await page.locator("#axis").selectOption("x");
  await expect.poll(async () => Number(await page.locator("#at").inputValue())).toBeCloseTo(midX, 1);

  await page.locator("#at").fill("0");
  await page.locator("#at").dispatchEvent("input");
  await expect(page.locator("#banner")).toContainText("outside the mesh");
  const warning = await page.locator("#banner").innerText();
  const range = warning.match(/\(([\d.]+)[–-]([\d.]+)\)/);
  expect(range).toBeTruthy();
  const warnedMid = (Number(range![1]) + Number(range![2])) / 2;
  expect(Math.abs(warnedMid - midX)).toBeLessThan(0.2);

  await page.locator("#axis").selectOption("y");
  await page.locator("#axis").selectOption("x");
  await expect(page.locator("#banner")).not.toContainText("outside the mesh");
  await expect.poll(async () => Number(await page.locator("#at").inputValue())).toBeCloseTo(midX, 1);

  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await page.waitForTimeout(500);
  await page.locator(".previews").screenshot({ path: path.join(out, "split-view-plane.png") });

  await page.getByRole("tab", { name: "Prepare", exact: true }).click();
  await page.waitForTimeout(200);
  const sizeBefore = await page.locator("#objectList .obj span").innerText();
  const gizmoAt = await prepareGizmoPoint(page);
  expect(gizmoAt.fx, "prepare gizmo should sit on the left of the view").toBeLessThan(0.34);
  expect(gizmoAt.fx).toBeGreaterThan(0.02);
  const ring = GIZMO_SCREEN_PX;
  const gx = gizmoAt.x;
  const gy = gizmoAt.y;
  const ringDrags: Array<[number, number, number, number]> = [
    [gx, gy - ring, gx + 78, gy - ring + 16],
    [gx + ring, gy, gx + ring - 12, gy - 72],
    [gx - ring, gy, gx - ring + 14, gy + 68],
    [gx, gy + ring, gx - 64, gy + ring - 18],
    [gx + ring * 0.7, gy - ring * 0.7, gx + 16, gy - 24],
  ];
  let sizeNow = sizeBefore;
  for (const [x0, y0, x1, y1] of ringDrags) {
    await drag(page, x0, y0, x1, y1);
    sizeNow = await page.locator("#objectList .obj span").innerText();
    if (sizeNow !== sizeBefore) break;
  }
  await page.locator("#prepare").screenshot({ path: path.join(out, "prepare-gizmo.png") });
  expect(sizeNow).not.toBe(sizeBefore);
  await expect(page.locator("#banner")).not.toContainText("outside the mesh");

  await page.locator("#rotX").click();
  await expect(page.locator("#banner")).not.toContainText("outside the mesh");
  const afterSnap = Number(await page.locator("#at").inputValue());
  expect(Number.isFinite(afterSnap)).toBe(true);
});

test("two objects share one By region plane across the plate", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "Bridge" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
  await page.locator("#plateDuplicate").click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await page.locator("#placeX").fill("150");
  await page.locator("#placeX").dispatchEvent("change");
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-objects", "2");
  await page.getByRole("button", { name: /^By region/ }).click();

  // The objects span X 95-125 and 135-165, so 130 is in the gap: a plate cut, not one object's.
  await page.locator("#at").fill("130");
  await page.locator("#at").dispatchEvent("input");
  await expect(page.locator("#prepare")).toHaveAttribute("data-split-bounds", "95.0,102.0,165.0,118.0");
  await expect(page.locator("#at")).toHaveValue("130");
  await expect(page.locator("#banner")).not.toContainText("outside the mesh");

  await page.locator("[data-plate-select]").first().click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");
  await expect(page.locator("#at")).toHaveValue("130");
  await expect(page.locator("#prepare")).toHaveAttribute("data-split-bounds", "95.0,102.0,165.0,118.0");
  await expect(page.locator("#banner")).not.toContainText("outside the mesh");

  await page.locator("#at").fill("0");
  await page.locator("#at").dispatchEvent("input");
  await expect(page.locator("#banner")).toContainText(/outside the mesh \(95\.0.165\.0\)/);
});

function fakeSlice() {
  const min = [...placedBounds.min];
  const max = [...placedBounds.max];
  const paths = encodePaths([{
    kind: "outer",
    strategy: "toughness",
    pts: [
      [min[0] + 1, min[1] + 1],
      [max[0] - 1, min[1] + 1],
      [max[0] - 1, max[1] - 1],
      [min[0] + 1, max[1] - 1],
      [min[0] + 1, min[1] + 1],
    ],
    width: 0.45,
    speed: 40,
    effectiveSpeed: 40,
    toughness: 1,
    beadHeight: 0.2,
  }]);
  return {
    coreMs: 1,
    baselineMs: 0,
    blend: "by region",
    mesh: { triangles: 36, min, max },
    sanity: { ok: true, notes: [], layers: 1, finalE: 1, extrusionLengthMm: 10 },
    estimate: { seconds: 12, filamentMm: 100, filamentG: 0.31, arcMoves: 0, byFeature: [] },
    gcode: "; preview\n",
    layers: [{
      index: 0,
      z: 0.2,
      height: 0.2,
      note: "region low=toughness high=speed",
      seconds: 12,
      speedWalls: 0,
      toughnessWalls: 1,
      supportPaths: 0,
      paths,
    }],
  };
}

/** Page point of the prepare rotate gizmo, plus its horizontal fraction of the canvas. */
async function prepareGizmoPoint(page: Page): Promise<{ x: number; y: number; fx: number }> {
  const png = await page.locator("#prepare").screenshot();
  const box = (await page.locator("#prepare").boundingBox())!;
  const local = await page.evaluate(async ({ data, cssW }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { fx: 1, fy: 0.5 };
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const pts: { x: number; y: number }[] = [];
    const ringPixel = (r: number, g: number, b: number) =>
      (r > 200 && g > 55 && g < 140 && b > 45 && b < 120 && r > g + 70)
      || (r > 115 && r < 175 && g > 185 && g < 235 && b > 80 && b < 145 && g > r + 30)
      || (b > 210 && r > 70 && r < 160 && g > 130 && g < 210 && b > g + 30);
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      if (!ringPixel(r, g, b)) continue;
      const p = i / 4;
      pts.push({ x: p % canvas.width, y: Math.floor(p / canvas.width) });
    }
    if (pts.length < 30) return { fx: 1, fy: 0.5 };
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    const imageReach = 1.6 * 88 * (canvas.width / Math.max(cssW, 1));
    let kept = pts;
    for (let iter = 0; iter < 4; iter++) {
      const next = kept.filter((p) => Math.hypot(p.x - cx, p.y - cy) <= imageReach);
      if (next.length < 30) break;
      let sx = 0;
      let sy = 0;
      for (const p of next) {
        sx += p.x;
        sy += p.y;
      }
      cx = sx / next.length;
      cy = sy / next.length;
      kept = next;
    }
    return { fx: cx / canvas.width, fy: cy / canvas.height };
  }, { data: png.toString("base64"), cssW: box.width });
  return { x: box.x + local.fx * box.width, y: box.y + local.fy * box.height, fx: local.fx };
}

async function drag(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}
