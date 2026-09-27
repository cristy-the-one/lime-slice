import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
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

test("bed opacity and section controls are preview-only chrome", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (msg) => logs.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`pageerror: ${err.message}`));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: cube }));
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
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await expect(page.locator("#slice")).toHaveText("Slice");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.locator("#sectionOn").check();
  await expect(page.locator("#sectionOffset")).toBeVisible();
  await expect(page.locator("#sectionFlip")).toBeVisible();
  await expect(page.locator("#sectionReadout")).toContainText("hides arrow side");
  await expect(page.locator("#sectionReadout")).toContainText("layers still apply");
  await page.locator("#sectionOffset").evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#sectionReadout")).toContainText("0.0 mm");
  await page.waitForTimeout(400);
  const out = "/opt/cursor/artifacts/preview-section";
  fs.mkdirSync(out, { recursive: true });
  await page.locator("#view3d").screenshot({ path: path.join(out, "section-plus-z.png") });
  await page.locator("#sectionOn").uncheck();
  await page.waitForTimeout(200);
  await page.locator("#view3d").screenshot({ path: path.join(out, "section-off.png") });
  await page.locator("#sectionOn").check();
  await page.locator("#sectionFlip").click();
  await expect(page.locator("#sectionReadout")).toContainText("0.00 0.00 -1.00");
  await page.locator("#bedOpacity").evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(200);
  await page.locator("#view3d").screenshot({ path: path.join(out, "bed-hidden.png") });
  await page.getByRole("button", { name: "Prepare", exact: true }).click();
  await expect(page.locator("#sectionField")).toBeHidden();
  await expect(bed).toBeVisible();
  expect(logs.filter((line) => line.startsWith("pageerror:") || line.startsWith("error:"))).toEqual([]);
});
