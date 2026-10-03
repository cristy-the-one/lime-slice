import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { GIZMO_SCREEN_PX, gizmoRadiusForPixels, parkLeftCameraSpace, parkLeftNdcX, snapStep } from "../src/gizmo-math";
import { applyRigidPose, boundsOf, centeringShift, ID_MATRIX, placeMesh, rotX, rotZ, scaledCanonical, transformPositions, type Mat3, type MeshShift, type RigidPose } from "../src/mesh-place";
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

test("left park stays in the left third, on the camera-depth plane", () => {
  for (const width of [280, 640, 960, 1440, 2400]) {
    const ndc = parkLeftNdcX(width);
    expect(ndc).toBeGreaterThanOrEqual(-0.92);
    expect(ndc).toBeLessThanOrEqual(-0.42);
    expect((ndc + 1) / 2).toBeLessThan(0.34);
  }
  const [x, y, z] = parkLeftCameraSpace(960, 120, 40, 1.5, 1);
  const halfH = Math.tan((40 * Math.PI) / 360) * 120;
  expect(y).toBe(0);
  expect(z).toBeCloseTo(-120, 6);
  expect(x).toBeCloseTo(parkLeftNdcX(960) * halfH * 1.5, 5);
  expect(x).toBeLessThan(0);
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

test("scaled canonical plus pose matches placement", () => {
  const src = new Float32Array([
    0, 0, 0, 10, 0, 0, 0, 4, 0,
    0, 0, 0, 10, 0, 0, 0, 0, 6,
  ]);
  const cases: Array<[Mat3, number, boolean, MeshShift | undefined]> = [
    [ID_MATRIX, 1, true, undefined],
    [rotZ(90), 2, true, undefined],
    [rotZ(90), 2, false, { x: 5, y: -3, z: 2.5 }],
    [ID_MATRIX, 1, false, { x: 5, y: -3, z: 2.5 }],
    [rotX(90), 0.5, true, undefined],
    [ID_MATRIX, 1, false, { x: 0, y: 0, z: 4 }],
  ];
  for (const [matrix, scale, centered, shift] of cases) {
    const placed = transformPositions(src, matrix, scale, 220, 200, centered, shift);
    const { pose } = placeMesh(src, matrix, scale, 220, 200, centered, shift);
    const via = applyRigidPose(scaledCanonical(src, scale), pose);
    expect(via.length).toBe(placed.length);
    for (let i = 0; i < placed.length; i++) expect(via[i]).toBeCloseTo(placed[i], 4);
  }
});

test("zoom keeps the gizmo the same size and an arrow move is what gets sliced", async ({ page }) => {
  let captured: { buf: Buffer; pose?: RigidPose } | null = null;
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as { dataB64: string; pose?: RigidPose };
    const buf = Buffer.from(body.dataB64, "base64");
    captured = { buf, pose: body.pose };
    const bounds = body.pose ? posedBounds(buf, body.pose) : stlBounds(buf);
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
  expect(fit.midX, JSON.stringify(fit)).toBeLessThan(fit.cssW * 0.34);
  expect(fit.midX).toBeGreaterThan(fit.cssW * 0.02);
  expect(Math.abs(fit.midY - fit.cssH / 2)).toBeLessThan(fit.cssH * 0.14);
  expect(fit.meshMidX).toBeGreaterThan(fit.cssW * 0.38);
  expect(fit.meshMidX - fit.midX).toBeGreaterThan(fit.cssW * 0.12);
  fs.copyFileSync(path.join(out, "zoom-fit.png"), "/opt/cursor/artifacts/prepare-gizmo-parked-left.png");

  await wheel(page, -120, 12);
  const zoomedIn = await shotBox(page, "zoom-in.png");
  expect(zoomedIn.mesh).toBeGreaterThan(fit.mesh * 1.6);
  expect(ratio(zoomedIn.span, fit.span)).toBeGreaterThan(0.88);
  expect(ratio(zoomedIn.span, fit.span)).toBeLessThan(1.12);
  expect(Math.abs(zoomedIn.midX - fit.midX)).toBeLessThan(28);
  expect(Math.abs(zoomedIn.midY - fit.midY)).toBeLessThan(28);

  await wheel(page, 120, 24);
  const zoomedOut = await shotBox(page, "zoom-out.png");
  expect(zoomedOut.mesh).toBeLessThan(fit.mesh * 0.7);
  expect(ratio(zoomedOut.span, fit.span)).toBeGreaterThan(0.88);
  expect(ratio(zoomedOut.span, fit.span)).toBeLessThan(1.12);
  expect(Math.abs(zoomedOut.midX - fit.midX)).toBeLessThan(28);
  expect(Math.abs(zoomedOut.midY - fit.midY)).toBeLessThan(28);

  const poseBeforeOrbit = await page.locator("#placeReadout").innerText();
  const box = (await prepare.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 - 30, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  const orbited = await shotBox(page, "orbit.png");
  expect(await page.locator("#placeReadout").innerText()).toBe(poseBeforeOrbit);
  expect(Math.abs(orbited.midX - zoomedOut.midX)).toBeLessThan(36);
  expect(Math.abs(orbited.midY - zoomedOut.midY)).toBeLessThan(36);
  expect(orbited.meshMidX - orbited.midX).toBeGreaterThan(orbited.cssW * 0.1);

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
  const sliced = captured!.pose ? posedBounds(captured!.buf, captured!.pose) : stlBounds(captured!.buf);
  await expect(page.locator("#left")).toContainText("outline 0.025 mm");
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
  const sampled = samplePrepare(img);
  const focus = gizmoFocus(sampled.gizmo, 1.6 * GIZMO_SCREEN_PX * scale);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (const p of focus.kept) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const span = focus.kept.length ? Math.max(maxX - minX, maxY - minY) / scale : 0;
  return {
    gizmo: focus.kept.length,
    mesh: sampled.mesh,
    span,
    cssW: box.width,
    cssH: box.height,
    midX: focus.kept.length ? focus.cx / scale : 0,
    midY: focus.kept.length ? focus.cy / scale : 0,
    meshMidX: sampled.mesh ? sampled.meshX / sampled.mesh / scale : 0,
    meshMidY: sampled.mesh ? sampled.meshY / sampled.mesh / scale : 0,
  };
}

async function arrowHandle(page: Page): Promise<{ axis: "x" | "y" | "z"; x: number; y: number; dx: number; dy: number }> {
  const png = await page.locator("#prepare").screenshot();
  const box = (await page.locator("#prepare").boundingBox())!;
  const img = decodePng(png);
  const scale = img.width / box.width;
  const sampled = samplePrepare(img);
  const focus = gizmoFocus(sampled.gizmo, 1.6 * GIZMO_SCREEN_PX * scale);
  const aimed = aimArrow(focus.kept, focus.cx, focus.cy);
  expect(aimed.margin, "no translate arrow stood out from its ring").toBeGreaterThan(18);
  const len = Math.hypot(aimed.ox, aimed.oy) || 1;
  return {
    axis: aimed.axis,
    x: box.x + aimed.hitX / scale,
    y: box.y + aimed.hitY / scale,
    dx: (aimed.ox / len) * 110,
    dy: (aimed.oy / len) * 110,
  };
}

/**
 * An edge-on ring is a diameter, so its centroid sits on the gizmo center.
 * The arrow is only the positive ray: the angular bin that beats the opposite bin.
 */
function aimArrow(pts: { x: number; y: number; family: "x" | "y" | "z" }[], cx: number, cy: number) {
  const bins = 36;
  const hist = new Array(40).fill(0);
  for (const p of pts) hist[Math.min(39, Math.floor(Math.hypot(p.x - cx, p.y - cy) / 4))]++;
  let mode = 12;
  let modeN = 0;
  for (let i = 8; i < 28; i++) {
    if (hist[i] > modeN) {
      modeN = hist[i];
      mode = i;
    }
  }
  const radius = (mode + 0.5) * 4;
  const inner = 0.28 * radius;
  const outer = 0.85 * radius;
  let axis: "x" | "y" | "z" = "x";
  let margin = -1;
  let bestBin = 0;
  for (const key of ["x", "y", "z"] as const) {
    const counts = new Array(bins).fill(0);
    for (const p of pts) {
      if (p.family !== key) continue;
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < inner || d > outer) continue;
      const ang = Math.atan2(p.y - cy, p.x - cx);
      const bin = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * bins) % bins;
      counts[bin] += 1;
    }
    for (let bin = 0; bin < bins; bin++) {
      const score = counts[bin] - counts[(bin + bins / 2) % bins];
      if (score > margin) {
        margin = score;
        axis = key;
        bestBin = bin;
      }
    }
  }
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of pts) {
    if (p.family !== axis) continue;
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < inner || d > outer) continue;
    const ang = Math.atan2(p.y - cy, p.x - cx);
    const bin = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * bins) % bins;
    const delta = Math.min(Math.abs(bin - bestBin), bins - Math.abs(bin - bestBin));
    if (delta > 1) continue;
    sx += p.x;
    sy += p.y;
    n += 1;
  }
  const hitX = n ? sx / n : cx + Math.cos((bestBin + 0.5) / bins * Math.PI * 2 - Math.PI) * radius * 0.55;
  const hitY = n ? sy / n : cy + Math.sin((bestBin + 0.5) / bins * Math.PI * 2 - Math.PI) * radius * 0.55;
  return { axis, margin, ox: hitX - cx, oy: hitY - cy, hitX, hitY };
}

function parsePlace(text: string) {
  const match = text.match(/X ([-\d.]+) · Y ([-\d.]+) · bed Z ([-\d.]+)/);
  if (!match) throw new Error(`place readout: ${text}`);
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

function samplePrepare(img: { width: number; height: number; data: Buffer }) {
  const gizmo: { x: number; y: number; family: "x" | "y" | "z" }[] = [];
  let mesh = 0;
  let meshX = 0;
  let meshY = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      if (isMesh(r, g, b)) {
        mesh += 1;
        meshX += x;
        meshY += y;
      }
      const family = gizmoFamily(r, g, b);
      if (family) gizmo.push({ x, y, family });
    }
  }
  return { gizmo, mesh, meshX, meshY };
}

/** Pull onto the ring cluster so the bed-corner triad does not own the centroid. */
function gizmoFocus<T extends { x: number; y: number }>(pts: T[], reach: number): { cx: number; cy: number; kept: T[] } {
  if (pts.length === 0) return { cx: 0, cy: 0, kept: [] as T[] };
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let kept = pts;
  for (let iter = 0; iter < 4; iter++) {
    const next = kept.filter((p) => Math.hypot(p.x - cx, p.y - cy) <= reach);
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
  return { cx, cy, kept };
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

function posedBounds(buf: Buffer, pose: RigidPose) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint32(80, true);
  const pos = new Float32Array(count * 9);
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50 + 12;
    for (let v = 0; v < 9; v++) pos[i * 9 + v] = view.getFloat32(base + v * 4, true);
  }
  return boundsOf(applyRigidPose(pos, pose));
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
    mesh: {
      triangles: 12,
      sourceTriangles: 12000,
      outlineToleranceMm: 0.025,
      min,
      max,
    },
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
