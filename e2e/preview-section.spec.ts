import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveSliceJob } from "./serve-job";
import {
  aimSection,
  clipDistance,
  clipPolyline,
  flipSection,
  keepsPoint,
  layerCut,
  printToScene,
  sectionReach,
  threeClip,
  type SectionSpec,
  type Vec3,
} from "../src/section-plane";

const center: Vec3 = [10, 20, 30];
const flat: SectionSpec = { normal: [0, 0, 1], offset: 0 };

test("section plane hides the arrow side and keeps the cut itself", () => {
  expect(keepsPoint([10, 20, 30], center, flat)).toBe(true);
  expect(keepsPoint([10, 20, 29], center, flat)).toBe(true);
  expect(keepsPoint([10, 20, 31], center, flat)).toBe(false);
  const flipped = flipSection(flat);
  expect(keepsPoint([10, 20, 31], center, flipped)).toBe(true);
  expect(keepsPoint([10, 20, 29], center, flipped)).toBe(false);
  expect(flipped.offset).toBeCloseTo(0, 6);
});

test("aiming keeps the distance from the part center", () => {
  const raised: SectionSpec = { normal: [0, 0, 1], offset: 4 };
  const aimed = aimSection(raised, [1, 0, 0], Math.PI / 2);
  expect(aimed.offset).toBeCloseTo(4, 6);
  expect(aimed.normal[0]).toBeCloseTo(0, 5);
  expect(aimed.normal[1]).toBeCloseTo(-1, 5);
  expect(aimed.normal[2]).toBeCloseTo(0, 5);
  expect(keepsPoint([10, 16, 30], center, aimed)).toBe(true);
  expect(keepsPoint([10, 25, 30], center, aimed)).toBe(true);
  expect(keepsPoint([10, 10, 30], center, aimed)).toBe(false);
});

test("three.js clip distance matches the print-space keep test", () => {
  const specs: SectionSpec[] = [
    flat,
    { normal: [0, 0, 1], offset: 5 },
    { normal: [1, 0, 0], offset: -2 },
    aimSection({ normal: [0, 1, 0], offset: 3 }, [0, 0, 1], 0.4),
  ];
  const samples: Vec3[] = [
    [10, 20, 30],
    [0, 0, 0],
    [12, 18, 40],
    [8, 22, 20],
    [40, -10, 5],
  ];
  for (const spec of specs) {
    const plane = threeClip(center, spec);
    for (const sample of samples) {
      const distance = clipDistance(printToScene(sample, center), plane);
      const kept = keepsPoint(sample, center, spec);
      expect(distance >= -1e-6, `${spec.normal} @ ${sample} dist ${distance}`).toBe(kept);
    }
  }
});

test("polyline clip and layer line follow the same plane", () => {
  const vertical: SectionSpec = { normal: [1, 0, 0], offset: 0 };
  const runs = clipPolyline([[0, 0], [20, 0], [20, 10]], undefined, 30, 0, 3, center, vertical);
  expect(runs).toEqual([[[0, 0], [10, 0]]]);
  const line = layerCut(30, { minX: 0, minY: 10, maxX: 20, maxY: 30 }, center, vertical);
  expect(line).not.toBeNull();
  expect(line![0][0]).toBeCloseTo(10, 5);
  expect(line![1][0]).toBeCloseTo(10, 5);
  expect(sectionReach([0, 0, 0], [20, 20, 20])).toBeCloseTo(Math.hypot(20, 20, 20) / 2, 5);
});

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const out = path.resolve("artifacts/preview-section");

test("bed opacity and section controls are preview-only chrome", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (msg) => logs.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`pageerror: ${err.message}`));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await serveSliceJob(page, cube);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const bed = page.locator("#bedOpacity");
  await expect(bed).toHaveValue("40");
  await bed.evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "100";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#sectionOffsetField")).toBeHidden();
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await expect(page.locator("#slice")).toHaveText("Show result");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.locator("#sectionOn").check();
  await expect(page.locator("#sectionOffset")).toBeVisible();
  await expect(page.locator("#sectionFlip")).toBeVisible();
  await expect(page.locator("#sectionReadout")).toBeHidden();
  await page.locator("#sectionOffset").evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => Math.abs(await sectionOffsetOf(page))).toBeLessThan(0.05);
  await expect(page.locator("#sectionReadout")).toBeHidden();
  await page.waitForTimeout(400);
  fs.mkdirSync(out, { recursive: true });
  await page.locator("#view3d").screenshot({ path: path.join(out, "section-plus-z.png") });
  await page.locator("#sectionOn").uncheck();
  await page.waitForTimeout(200);
  await page.locator("#view3d").screenshot({ path: path.join(out, "section-off.png") });
  await page.locator("#sectionOn").check();
  await page.locator("#sectionFlip").click();
  await expect(page.locator("#sectionReadout")).toBeHidden();
  await page.locator("#bedOpacity").evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(200);
  await page.locator("#view3d").screenshot({ path: path.join(out, "bed-hidden.png") });
  await page.getByRole("tab", { name: "Prepare", exact: true }).click();
  await expect(page.locator("#sectionField")).toBeHidden();
  await expect(bed).toBeVisible();
  expect(logs.filter((line) => line.startsWith("pageerror:") || line.startsWith("error:"))).toEqual([]);
});

const PIGMENT: [number, number, number][] = [
  [0xe0, 0x69, 0x0e],
  [0x2a, 0x5f, 0xd6],
  [0x4f, 0xa8, 0xe8],
  [0x2f, 0xa3, 0x6b],
  [0xe0, 0x6f, 0xb0],
  [0xdc, 0xcb, 0x12],
  [0xc4, 0x1e, 0x3a],
  [0x19, 0xb5, 0xa5],
  [0x7d, 0x8d, 0xb8],
];
const RINGS: [number, number, number][] = [
  [0xe8, 0x5d, 0x4c],
  [0x8f, 0xce, 0x6a],
  [0x6a, 0xa7, 0xff],
];

/** Lime is the solid ghost. Pigment is feature-colored bead faces, ignoring the section rings. */
async function colorBuckets(page: Page, name = ""): Promise<{ lime: number; pigment: number; travel: number }> {
  const png = name
    ? await page.locator("#view3d").screenshot({ path: path.join(out, `${name}.png`) })
    : await page.locator("#view3d").screenshot();
  return page.evaluate(async ({ data, pigment, rings }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { lime: 0, pigment: 0, travel: 0 };
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const near = (r: number, g: number, b: number, c: number[], tol: number) =>
      Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]) < tol;
    let lime = 0;
    let beads = 0;
    let travel = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      // Ring green sits just outside the ghost lime; a wide ring test would delete the ghost.
      if (rings.some((c) => near(r, g, b, c, 60))) continue;
      if (near(r, g, b, [0x96, 0xbe, 0x28], 90)) lime += 1;
      if (pigment.some((c) => near(r, g, b, c, 48))) beads += 1;
      if (near(r, g, b, [0x4d, 0x56, 0x68], 50)) travel += 1;
    }
    return { lime, pigment: beads, travel };
  }, { data: png.toString("base64"), pigment: PIGMENT, rings: RINGS });
}

async function zoomPart(page: Page) {
  await page.locator("#view3d").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    for (let i = 0; i < 6; i++) {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -350, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    }
  });
  await page.waitForTimeout(400);
}

async function sectionOffsetOf(page: Page) {
  return Number(await page.locator("#sectionOffset").inputValue());
}

/** Mean horizontal position of the aim rings, as a fraction of the 3D view width. */
async function ringAnchor(page: Page): Promise<{ x: number; n: number }> {
  const png = await page.locator("#view3d").screenshot();
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { x: 1, n: 0 };
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const rings: number[][] = [[0xe8, 0x5d, 0x4c], [0x8f, 0xce, 0x6a], [0x6a, 0xa7, 0xff]];
    let n = 0;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const hit = rings.some((c) => Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]) < 70);
      if (!hit) continue;
      n += 1;
      sum += (i / 4) % canvas.width;
    }
    return { x: n ? sum / n / canvas.width : 1, n };
  }, png.toString("base64"));
}

async function setOffset(page: Page, value: string) {
  await page.locator("#sectionOffset").evaluate((el, next) => {
    const input = el as HTMLInputElement;
    input.value = next === "min" ? input.min : next === "max" ? input.max : next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  await page.waitForTimeout(250);
}

test("section plane clips 3D beads, travels, and the solid ghost", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (msg) => logs.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`pageerror: ${err.message}`));
  fs.mkdirSync(out, { recursive: true });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await serveSliceJob(page, cube);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.waitForTimeout(400);
  const ghostFull = await colorBuckets(page, "ghost-full");
  await page.locator("#sectionOn").check();
  await setOffset(page, "0");
  const ghostHalf = await colorBuckets(page, "ghost-half");
  const beforeDrag = await sectionOffsetOf(page);
  const box = (await page.locator("#view3d").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 48, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const afterDrag = await sectionOffsetOf(page);
  await setOffset(page, "min");
  const ghostCut = await colorBuckets(page, "ghost-cut");

  await page.locator("#sectionOn").uncheck();
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await zoomPart(page);
  let beadsFull = await colorBuckets(page);
  for (let i = 0; i < 20 && beadsFull.pigment < 4000; i++) {
    await page.waitForTimeout(250);
    beadsFull = await colorBuckets(page);
  }
  await colorBuckets(page, "beads-full");
  await page.locator("#legend label", { hasText: "Travel" }).click();
  await page.waitForTimeout(300);
  const travelOn = await colorBuckets(page, "travels-on");
  await page.locator("#sectionOn").check();
  await setOffset(page, "0");
  const beadsHalf = await colorBuckets(page, "beads-half");
  // Before a slice the view is blurred, which washes the rings out.
  const rings = await ringAnchor(page);
  await setOffset(page, "min");
  const beadsCut = await colorBuckets(page, "beads-cut");

  expect(ghostFull.lime).toBeGreaterThan(10000);
  expect(ghostHalf.lime).toBeGreaterThan(ghostFull.lime * 0.15);
  expect(ghostHalf.lime).toBeLessThan(ghostFull.lime * 0.75);
  expect(rings.n).toBeGreaterThan(200);
  expect(rings.x).toBeLessThan(0.34);
  expect(Math.abs(afterDrag - beforeDrag)).toBeLessThan(0.2);
  expect(ghostCut.lime).toBeLessThan(ghostFull.lime * 0.05);
  expect(beadsFull.pigment).toBeGreaterThan(4000);
  expect(beadsHalf.pigment).toBeGreaterThan(beadsFull.pigment * 0.2);
  expect(beadsHalf.pigment).toBeLessThan(beadsFull.pigment * 0.85);
  expect(beadsCut.pigment).toBeLessThan(beadsFull.pigment * 0.08);
  // Travels are the same clipped shader as the faces. Turning them on must not throw,
  // and hiding the whole part must not leave feature-colored faces behind.
  expect(travelOn.pigment).toBeGreaterThan(4000);
  expect(beadsCut.pigment).toBeLessThan(200);
  expect(logs.filter((line) => line.startsWith("pageerror:") || line.startsWith("error:"))).toEqual([]);
});
