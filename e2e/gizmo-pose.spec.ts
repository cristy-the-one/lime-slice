import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { GIZMO_SCREEN_PX, gizmoRadiusForPixels, snapStep } from "../src/gizmo-math";
import { boundsOf, centeringShift, ID_MATRIX, rotZ, transformPositions } from "../src/mesh-place";
import { encodePaths } from "../src/preview-wire";

const out = "/opt/cursor/artifacts/gizmo-pose";
fs.mkdirSync(out, { recursive: true });

test("screen radius tracks camera distance and shift snaps the drag", () => {
  const project = (radius: number, distance: number, fov: number, height: number, zoom = 1) => {
    const worldPerPx = (2 * Math.tan((fov * Math.PI) / 360) * distance) / (height * zoom);
    return radius / worldPerPx;
  };
  for (const distance of [40, 90, 180, 420]) {
    const radius = gizmoRadiusForPixels(distance, 40, 720, GIZMO_SCREEN_PX, 1);
    expect(project(radius, distance, 40, 720)).toBeCloseTo(GIZMO_SCREEN_PX, 4);
  }
  const near = gizmoRadiusForPixels(100, 40, 720, GIZMO_SCREEN_PX);
  const far = gizmoRadiusForPixels(250, 40, 720, GIZMO_SCREEN_PX);
  expect(far / near).toBeCloseTo(2.5, 5);
  expect(project(gizmoRadiusForPixels(80, 40, 600, 90, 2), 80, 40, 600, 2)).toBeCloseTo(90, 4);

  expect(snapStep(22, false, 15)).toBe(22);
  expect(snapStep(22, true, 15)).toBe(15);
  expect(snapStep(23, true, 15)).toBe(30);
  expect(snapStep(1.4, true, 1)).toBe(1);
  expect(snapStep(-1.6, true, 1)).toBe(-2);
  expect(snapStep(0.4, true, 1)).toBe(0);
});

test("a manual shift matches Center, and an extra Z lift is what gets placed", () => {
  const src = new Float32Array([
    0, 0, 0, 10, 0, 0, 0, 4, 0,
    0, 0, 0, 10, 0, 0, 0, 0, 6,
  ]);
  const shift = centeringShift(src, rotZ(90), 2, 220, 200);
  const centered = boundsOf(transformPositions(src, rotZ(90), 2, 220, 200, true));
  const manual = boundsOf(transformPositions(src, rotZ(90), 2, 220, 200, false, shift));
  for (let i = 0; i < 3; i++) {
    expect(manual.min[i]).toBeCloseTo(centered.min[i], 5);
    expect(manual.max[i]).toBeCloseTo(centered.max[i], 5);
  }
  const base = boundsOf(transformPositions(src, ID_MATRIX, 1, 220, 180, false));
  const moved = boundsOf(transformPositions(src, ID_MATRIX, 1, 220, 180, false, { x: 5, y: -3, z: 2.5 }));
  expect(moved.min[0]).toBeCloseTo(base.min[0] + 5, 5);
  expect(moved.min[1]).toBeCloseTo(base.min[1] - 3, 5);
  expect(moved.min[2]).toBeCloseTo(base.min[2] + 2.5, 5);
  const ignored = boundsOf(transformPositions(src, ID_MATRIX, 1, 220, 180, true, { x: 40, y: 40, z: 9 }));
  const plain = boundsOf(transformPositions(src, ID_MATRIX, 1, 220, 180, true));
  expect(ignored.min[2]).toBeCloseTo(plain.min[2], 5);
  expect((ignored.min[0] + ignored.max[0]) / 2).toBeCloseTo(110, 5);

  const home = centeringShift(src, ID_MATRIX, 1, 220, 180);
  const lifted = boundsOf(transformPositions(src, ID_MATRIX, 1, 220, 180, false, { ...home, z: 4 }));
  const seated = boundsOf(transformPositions(src, ID_MATRIX, 1, 220, 180, true));
  expect((lifted.min[0] + lifted.max[0]) / 2).toBeCloseTo((seated.min[0] + seated.max[0]) / 2, 4);
  expect((lifted.min[1] + lifted.max[1]) / 2).toBeCloseTo((seated.min[1] + seated.max[1]) / 2, 4);
  expect(lifted.min[2]).toBeCloseTo(4, 5);
});

test("zoom keeps the gizmo the same size and an arrow move is what gets sliced", async ({ page }) => {
  let captured: Buffer | null = null;
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as { dataB64: string };
    captured = Buffer.from(body.dataB64, "base64");
    const bounds = stlBounds(captured);
    await route.fulfill({ json: fakeSlice(bounds.min, bounds.max) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
  await expect(page.locator("#prepareBody")).toBeVisible();
  await expect(page.locator("#gizmoReadout")).toContainText("arrow");
  const home = await page.locator("#placeReadout").innerText();
  expect(home).toContain("X 110.0");
  expect(home).toContain("bed Z 0.0");

  const prepare = page.locator("#prepare");
  await prepare.hover();
  await page.waitForTimeout(200);
  const fit = await shotBox(page, "zoom-fit.png");
  expect(fit.gizmo, JSON.stringify(fit)).toBeGreaterThan(80);
  expect(fit.mesh).toBeGreaterThan(fit.gizmo);

  await wheel(page, -120, 12);
  const zoomedIn = await shotBox(page, "zoom-in.png");
  expect(zoomedIn.mesh).toBeGreaterThan(fit.mesh * 1.6);
  expect(ratio(zoomedIn.span, fit.span)).toBeGreaterThan(0.88);
  expect(ratio(zoomedIn.span, fit.span)).toBeLessThan(1.12);
  expect(Math.hypot(zoomedIn.midX - zoomedIn.cssW / 2, zoomedIn.midY - zoomedIn.cssH / 2)).toBeLessThan(28);

  await wheel(page, 120, 24);
  const zoomedOut = await shotBox(page, "zoom-out.png");
  expect(zoomedOut.mesh).toBeLessThan(fit.mesh * 0.7);
  expect(ratio(zoomedOut.span, fit.span)).toBeGreaterThan(0.88);
  expect(ratio(zoomedOut.span, fit.span)).toBeLessThan(1.12);

  const before = parsePlace(await page.locator("#placeReadout").innerText());
  const arrow = await arrowHandle(page);
  await drag(page, arrow.x, arrow.y, arrow.x + arrow.dx, arrow.y + arrow.dy);
  await page.locator("#prepare").screenshot({ path: path.join(out, "translated.png") });
  const after = parsePlace(await page.locator("#placeReadout").innerText());
  const delta = after[arrow.axis] - before[arrow.axis];
  expect(Math.abs(delta)).toBeGreaterThan(0.8);
  expect(Math.sign(delta)).toBe(1);

  await page.locator("#slice").click();
  await expect.poll(() => captured !== null).toBe(true);
  const sliced = stlBounds(captured!);
  const midX = (sliced.min[0] + sliced.max[0]) / 2;
  const midY = (sliced.min[1] + sliced.max[1]) / 2;
  expect(Math.abs(midX - after.x)).toBeLessThan(0.15);
  expect(Math.abs(midY - after.y)).toBeLessThan(0.15);
  expect(Math.abs(sliced.min[2] - after.z)).toBeLessThan(0.15);
  expect(Math.abs(midX - before.x) + Math.abs(midY - before.y) + Math.abs(sliced.min[2] - before.z)).toBeGreaterThan(0.8);

  await page.locator("#layflat").click();
  const laid = await page.locator("#placeReadout").innerText();
  expect(laid).not.toBe(home);
  await page.locator("#center").click();
  await expect(page.locator("#placeReadout")).toHaveText(home);

  const again = await arrowHandle(page);
  await page.keyboard.down("Shift");
  await drag(page, again.x, again.y, again.x + again.dx, again.y + again.dy);
  await page.keyboard.up("Shift");
  const snapped = parsePlace(await page.locator("#placeReadout").innerText());
  const step = snapped[again.axis] - parsePlace(home)[again.axis];
  expect(Math.abs(step)).toBeGreaterThanOrEqual(1);
  expect(Math.abs(step - Math.round(step))).toBeLessThan(0.05);
  await page.locator("#center").click();
  await expect(page.locator("#placeReadout")).toHaveText(home);
});

function ratio(a: number, b: number) {
  return a / b;
}

async function wheel(page: Page, deltaY: number, times: number) {
  const box = (await page.locator("#prepare").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < times; i++) await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(280);
}

async function drag(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 18 });
  await page.mouse.up();
  await page.waitForTimeout(180);
}

async function shotBox(page: Page, name: string) {
  const png = await page.locator("#prepare").screenshot({ path: path.join(out, name) });
  const box = (await page.locator("#prepare").boundingBox())!;
  const img = decodePng(png);
  const scale = img.width / box.width;
  const limit = 1.6 * GIZMO_SCREEN_PX * scale;
  const cx = img.width / 2;
  const cy = img.height / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let gizmo = 0;
  let mesh = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      if (isMesh(r, g, b)) mesh += 1;
      if (Math.hypot(x - cx, y - cy) > limit) continue;
      if (!gizmoFamily(r, g, b)) continue;
      gizmo += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const span = Math.max(maxX - minX, maxY - minY) / scale;
  return {
    gizmo,
    mesh,
    span,
    cssW: box.width,
    cssH: box.height,
    midX: gizmo ? (minX + maxX) / 2 / scale : 0,
    midY: gizmo ? (minY + maxY) / 2 / scale : 0,
  };
}

async function arrowHandle(page: Page): Promise<{ axis: "x" | "y" | "z"; x: number; y: number; dx: number; dy: number }> {
  const png = await page.locator("#prepare").screenshot();
  const box = (await page.locator("#prepare").boundingBox())!;
  const img = decodePng(png);
  const scale = img.width / box.width;
  const cx = img.width / 2;
  const cy = img.height / 2;
  // Shaft band, inside the rings. An edge-on ring still sprays pixels through
  // the middle; the real arrow is the color whose centroid sits away from center.
  const inner = 0.22 * GIZMO_SCREEN_PX * scale;
  const outer = 0.55 * GIZMO_SCREEN_PX * scale;
  const buckets: Record<"x" | "y" | "z", { x: number; y: number }[]> = { x: [], y: [], z: [] };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < inner || dist > outer) continue;
      const i = (y * img.width + x) * 4;
      const family = gizmoFamily(img.data[i], img.data[i + 1], img.data[i + 2]);
      if (!family) continue;
      buckets[family].push({ x, y });
    }
  }
  let axis: "x" | "y" | "z" = "x";
  let bestLen = 0;
  let ox = 1;
  let oy = 0;
  for (const key of ["x", "y", "z"] as const) {
    const pts = buckets[key];
    if (pts.length < 20) continue;
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    const dx = sx / pts.length - cx;
    const dy = sy / pts.length - cy;
    const len = Math.hypot(dx, dy);
    if (len > bestLen) {
      bestLen = len;
      axis = key;
      ox = dx;
      oy = dy;
    }
  }
  expect(bestLen, "arrow centroid collapsed into the ring").toBeGreaterThan(12 * scale);
  const len = Math.hypot(ox, oy) || 1;
  return {
    axis,
    x: box.x + (cx + ox) / scale,
    y: box.y + (cy + oy) / scale,
    dx: (ox / len) * 100,
    dy: (oy / len) * 100,
  };
}

function parsePlace(text: string) {
  const match = text.match(/X ([-\d.]+) · Y ([-\d.]+) · bed Z ([-\d.]+)/);
  if (!match) throw new Error(`place readout: ${text}`);
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

function gizmoFamily(r: number, g: number, b: number): "x" | "y" | "z" | null {
  if (r > 200 && g > 55 && g < 140 && b > 45 && b < 120 && r > g + 70) return "x";
  if (r > 115 && r < 175 && g > 185 && g < 235 && b > 80 && b < 145 && g > r + 30) return "y";
  if (b > 210 && r > 70 && r < 160 && g > 130 && g < 210 && b > g + 30) return "z";
  return null;
}

function isMesh(r: number, g: number, b: number) {
  return g > r + 8 && g > b + 25 && r > 80 && r < 185 && g > 110 && g < 198 && b > 30 && b < 115;
}

function near(value: number, target: number, tol: number) {
  return Math.abs(value - target) <= tol;
}

function stlBounds(buf: Buffer) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint32(80, true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50 + 12;
    for (let v = 0; v < 9; v++) {
      const value = view.getFloat32(base + v * 4, true);
      const axis = v % 3;
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { count, min, max };
}

function fakeSlice(min: number[], max: number[]) {
  const paths = encodePaths([{
    kind: "outer",
    strategy: "speed",
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
    toughness: 0,
    beadHeight: 0.2,
  }]);
  return {
    coreMs: 1,
    baselineMs: 0,
    blend: "speed",
    mesh: { triangles: 12, min, max },
    sanity: { ok: true, notes: [], layers: 1, finalE: 1, extrusionLengthMm: 10 },
    estimate: { seconds: 8, filamentMm: 40, filamentG: 0.12, arcMoves: 0, byFeature: [] },
    gcode: "; preview\n",
    layers: [{
      index: 0,
      z: 0.2,
      height: 0.2,
      note: "cube",
      seconds: 8,
      speedWalls: 1,
      toughnessWalls: 0,
      supportPaths: 0,
      paths,
    }],
  };
}

function decodePng(buf: Buffer): { width: number; height: number; data: Buffer } {
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    off += 4;
    const type = buf.toString("ascii", off, off + 4);
    off += 4;
    const data = buf.subarray(off, off + len);
    off += len + 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp || !width) throw new Error(`png ${width}x${height} color ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const outPx = Buffer.alloc(width * height * 4);
  let i = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[i++];
    const row = Buffer.from(raw.subarray(i, i + stride));
    i += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = prev[x];
      const ul = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 255;
      else if (filter === 2) row[x] = (row[x] + up) & 255;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, ul)) & 255;
    }
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      const src = x * bpp;
      outPx[dst] = row[src];
      outPx[dst + 1] = row[src + 1];
      outPx[dst + 2] = row[src + 2];
      outPx[dst + 3] = bpp === 4 ? row[src + 3] : 255;
    }
    prev = row;
  }
  return { width, height, data: outPx };
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
