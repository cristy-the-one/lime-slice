import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { rampColor, SAFETY_RAMP, STRESS_RAMP } from "../src/colors.ts";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";
import { facePoints } from "./stress-mock";

type V = [number, number, number];

/** The 20 mm cube's canned slice: one object, its layers in its part frame, 0 to 20. */
const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

function boxSolid(): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * 20];
  const quads: V[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((q, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  return { volumeMm3: 8000, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 400 })), edges: [] };
}

function f32b64(values: number[]): string {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buf.writeFloatLE(value, index * 4));
  return buf.toString("base64");
}

/**
 * A canned sliced study of the cube: 10 mm cells, two slabs. The half at
 * x < 10 carries 1 MPa with a safety factor of 5; the half past it carries
 * 9 MPa at 1. The surface is one triangle; the Preview reads the cells.
 */
function cannedStudy(): string {
  const cells: number[][] = [];
  for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) cells.push([i, j, k, 1, i === 0 ? 1 : 9, i === 0 ? 5 : 1]);
  const buf = Buffer.alloc(cells.length * 24);
  cells.forEach(([i, j, k, phi, stress, safety], n) => {
    buf.writeUInt32LE(i!, n * 24);
    buf.writeUInt32LE(j!, n * 24 + 4);
    buf.writeUInt32LE(k!, n * 24 + 8);
    buf.writeFloatLE(phi!, n * 24 + 12);
    buf.writeFloatLE(stress!, n * 24 + 16);
    buf.writeFloatLE(safety!, n * 24 + 20);
  });
  return JSON.stringify({
    ok: true,
    report: { representation: "sliced", trust: "usable", notes: [], margins: [], maxDisplacementMm: 0.1, minSafetyFactor: 1, massG: 9 },
    surface: {
      triangles: 1,
      positionsB64: f32b64([0, 0, 0, 20, 0, 0, 0, 20, 0]),
      displacementB64: f32b64([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      vonMisesB64: f32b64([1, 5, 9]),
      safetyB64: f32b64([5, 3, 1]),
    },
    cells: {
      partToSlice: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      originXy: [0, 0],
      hXy: 10,
      slabs: [
        [0, 10],
        [10, 20.5],
      ],
      count: cells.length,
      cellsB64: buf.toString("base64"),
    },
  });
}

async function open(page: Page) {
  await page.addInitScript((text: string) => {
    (window as unknown as { __limeSimStudy?: () => string }).__limeSimStudy = () => text;
  }, cannedStudy());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: cube }));
  await mockModelTree(page, { open: () => boxSolid(), apply: () => boxSolid(), probe: () => ({ ok: true }) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "cube.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
}

/** Pixels of the 2D toolpath canvas near each colour, by RGB distance. */
async function countNear(page: Page, hexes: string[]): Promise<number[]> {
  return page.locator("#view").evaluate((canvas, targets) => {
    const c = canvas as HTMLCanvasElement;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const rgb = targets.map((hex) => [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16)));
    const counts = targets.map(() => 0);
    for (let p = 0; p < data.length; p += 4) {
      rgb.forEach(([r, g, b], t) => {
        if (Math.abs(data[p] - r) + Math.abs(data[p + 1] - g) + Math.abs(data[p + 2] - b) < 40) counts[t] += 1;
      });
    }
    return counts;
  }, hexes);
}

/**
 * Where each colour sits across the drawn part: counts in the left and right
 * fifths of the box the coloured pixels span.
 */
async function sides(page: Page, hexes: string[]): Promise<{ left: number[]; right: number[] }> {
  return page.locator("#view").evaluate((canvas, targets) => {
    const c = canvas as HTMLCanvasElement;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const rgb = targets.map((hex) => [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16)));
    const near = (p: number) => rgb.findIndex(([r, g, b]) => Math.abs(data[p] - r) + Math.abs(data[p + 1] - g) + Math.abs(data[p + 2] - b) < 40);
    let lo = c.width;
    let hi = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (near((y * c.width + x) * 4) >= 0) {
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      }
    }
    const left = targets.map(() => 0);
    const right = targets.map(() => 0);
    const fifth = (hi - lo) / 5;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const t = near((y * c.width + x) * 4);
        if (t < 0) continue;
        if (x < lo + fifth) left[t] += 1;
        if (x > hi - fifth) right[t] += 1;
      }
    }
    return { left, right };
  }, hexes);
}

/** Pixels of the 3D view that read as the stress ramp's hot red, through its lighting. */
async function hotIn3d(page: Page): Promise<number> {
  const png = (await page.locator("#view3d").screenshot()).toString("base64");
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let hot = 0;
    for (let p = 0; p < px.length; p += 4) {
      const [r, g, b] = [px[p], px[p + 1], px[p + 2]];
      if (r > 90 && g < 0.3 * r && b < 0.45 * r) hot += 1;
    }
    return hot;
  }, png);
}

async function colourBy(page: Page, mode: string) {
  await page.locator('#toolRail [data-fly="flyColor"]').click();
  await page.locator("#colorBy").selectOption(mode);
}

test("the Preview colours each bead by the sliced stress under it", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  await open(page);
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");

  // Before a study, the stress colours say what they need.
  await page.locator("#tabPreview").click();
  await page.locator('#toolRail [data-fly="flyColor"]').click();
  // Playwright's toBeDisabled doesn't read an <option>; its property does.
  expect(await page.locator('#colorBy option[value="stress"]').evaluate((o) => (o as HTMLOptionElement).disabled)).toBe(true);
  await expect(page.locator("#colorStressNote")).toHaveText("Run Stress… in Model on this object to colour by stress.");
  await page.keyboard.press("Escape");

  await page.locator("#tabModel").click();
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuStress").click();
  const top = [...(await facePoints(page)).values()].find((at) => at.normal[2]! > 0.5)!;
  await page.locator("#stressLoadPick").click();
  await page.mouse.click(top.x, top.y);
  await page.locator("#stressLoadPick").click();
  await page.locator("#stressForce").fill("25");
  await page.locator("#stressBed").click();
  await page.locator("#stressRun").click();
  await expect(page.locator("#stressStatus")).toHaveText("");

  await page.locator("#tabPreview").click();
  await page.locator("#toolRail").getByRole("button", { name: "2D", exact: true }).click();
  await colourBy(page, "stress");
  await expect(page.locator("#colorStressNote")).toHaveText("Stress in the beads, 0 to 9.00 MPa.");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath("preview-stress.png") });
  // The ramp tops out at the 9 MPa peak: the cool half sits a ninth of the way up, the hot half at the top.
  const coolColour = rampColor(STRESS_RAMP, 1 / 9);
  const hotColour = rampColor(STRESS_RAMP, 1);
  const [cool, hot] = await countNear(page, [coolColour, hotColour]);
  expect(cool, "beads of the 1 MPa half").toBeGreaterThan(50);
  expect(hot, "beads of the 9 MPa half").toBeGreaterThan(50);
  // The colour changes where the cells do, at x = 10, not where a long bead's middle falls:
  // the left fifth is the cool half's, the right fifth the hot half's.
  const split = await sides(page, [coolColour, hotColour]);
  expect(split.left[0], "cool on the left").toBeGreaterThan(10 * split.left[1]);
  expect(split.right[1], "hot on the right").toBeGreaterThan(10 * split.right[0]);

  await colourBy(page, "safety");
  await expect(page.locator("#colorStressNote")).toContainText("Safety factor: red at 1 or under, green at 3 or over.");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const [red, green] = await countNear(page, [SAFETY_RAMP[0], SAFETY_RAMP[2]]);
  expect(red, "beads at a safety factor of 1").toBeGreaterThan(50);
  expect(green, "beads at a safety factor of 5").toBeGreaterThan(50);

  // Feature colours have none of the ramp's ends.
  await colourBy(page, "feature");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const [, featureHot] = await countNear(page, [coolColour, hotColour]);
  expect(featureHot).toBeLessThan(hot / 10);

  // The 3D view looks the cell up per fragment; its shader compiles and draws the hot half.
  await page.locator("#toolRail").getByRole("button", { name: "3D", exact: true }).click();
  await page.waitForTimeout(500);
  const featureRed = await hotIn3d(page);
  await colourBy(page, "stress");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const stressRed = await hotIn3d(page);
  await page.screenshot({ path: test.info().outputPath("preview-stress-3d.png") });
  expect(stressRed, "the hot half in 3D").toBeGreaterThan(500);
  expect(featureRed).toBeLessThan(stressRed / 10);
  expect(errors.filter((e) => /shader|WebGL|GLSL|THREE/i.test(e)), errors.join(" | ")).toEqual([]);
});
