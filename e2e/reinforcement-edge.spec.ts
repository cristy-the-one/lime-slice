import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

/** The sample's bounds in the mesh frame the slice request uses, read from the binary STL the app loads. */
function stlBounds(file: string) {
  const buf = fs.readFileSync(file);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < buf.readUInt32LE(80); t++) {
    for (let k = 0; k < 9; k++) {
      const v = buf.readFloatLE(84 + t * 50 + 12 + k * 4);
      min[k % 3] = Math.min(min[k % 3]!, v);
      max[k % 3] = Math.max(max[k % 3]!, v);
    }
  }
  return { min, max };
}
const box = stlBounds(path.resolve("samples/calibration_cube_20mm.stl"));

type Disk = { p: number[]; n: number[]; r: number };
type Body = { reinforcement?: { disks: Disk[] }[] };

/** Distance from a top-face point to the nearest edge of the cube's top face, in the mesh frame. */
const toTopEdge = (p: number[]) => Math.min(p[0]! - box.min[0]!, box.max[0]! - p[0]!, p[1]! - box.min[1]!, box.max[1]! - p[1]!);

/**
 * Open the cube in Prepare from the top, with one slice done so every reinforce edit slices again, and the
 * Reinforce bar open. `toScreen` maps a print X/Y on the cube's top face to page pixels.
 */
async function openTop(page: Page, url = "/") {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: Body[] = [];
  await page.route("**/api/slice", async (route) => {
    bodies.push(route.request().postDataJSON() as Body);
    await route.fulfill({ json: cube });
  });
  await page.goto(url);
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#slice")?.click());
  await expect.poll(() => bodies.length).toBe(1);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#tabPrepare")?.click());
  const canvas = page.locator("#prepare");
  await expect(canvas).toHaveAttribute("data-framed", /\d/);
  const framed = (await canvas.getAttribute("data-framed"))!.split(" ").map(Number);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#viewPresets button")?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-tool="reinforce"]')?.click());
  await expect(page.locator("#reinforceBar")).toBeVisible();

  const rect = (await canvas.boundingBox())!;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const printAt = async (x: number, y: number) => {
    await page.mouse.move(x, y);
    const hit = (await canvas.getAttribute("data-brush-hit")) ?? "";
    expect(hit, `the brush meets the cube at ${x}, ${y}`).not.toBe("");
    return hit.split(",").map(Number);
  };
  const reach = Math.min(rect.width, rect.height) / 6;
  const p0 = await printAt(cx, cy);
  const px = await printAt(cx + reach, cy);
  const py = await printAt(cx, cy - reach);
  expect(p0[2], "the view looks at the top face").toBeCloseTo(box.max[2]! - box.min[2]!, 1);
  const a = (px[0]! - p0[0]!) / reach, b = (p0[0]! - py[0]!) / reach;
  const c = (px[1]! - p0[1]!) / reach, d = (p0[1]! - py[1]!) / reach;
  const det = a * d - b * c;
  const half = (box.max[0]! - box.min[0]!) / 2;
  /** Page pixels of print (X, Y) given relative to the top face's centre. */
  const toScreen = (dx: number, dy: number) => {
    const u = framed[0]! + dx - p0[0]!;
    const v = framed[1]! + dy - p0[1]!;
    return { x: cx + (d * u - b * v) / det, y: cy + (-c * u + a * v) / det };
  };
  return { bodies, canvas, toScreen, half };
}

async function alongEdge(page: Page) {
  await page.locator('#reinforceMode [data-reinforce-mode="edge"]').click();
  await expect(page.locator('#reinforceMode [data-reinforce-mode="edge"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#reinforceRadiusField")).toBeHidden();
  await expect(page.locator("#reinforceOffset")).toHaveValue("0");
  await expect(page.locator("#reinforceWidth")).toHaveValue("6");
  await expect(page.locator("#reinforceWidth")).toHaveAttribute("data-brush-radius", "");
  await expect(page.locator("#prepare")).toHaveAttribute("data-edge-ready", "1");
  await expect(page.locator("#reinforceStatus")).not.toHaveText("Finding edges…");
}

test("Along edge lays a whole-loop strip at the inset, undoes in one step, and a partial strip between two clicks", async ({ page }) => {
  const { bodies, canvas, toScreen, half } = await openTop(page);
  await alongEdge(page);

  const rightEdge = toScreen(half - 0.4, 0);
  await page.mouse.move(rightEdge.x, rightEdge.y);
  await expect(canvas, "the right top edge highlights, corner to corner").toHaveAttribute("data-edge-hover", "2");
  await page.mouse.move(toScreen(0, 0).x, toScreen(0, 0).y);
  await expect(canvas, "the face centre is not near an edge").toHaveAttribute("data-edge-hover", "");

  await page.mouse.dblclick(rightEdge.x, rightEdge.y);
  await expect.poll(() => bodies.length).toBe(2);
  const loop = bodies[1]!.reinforcement![0]!.disks;
  // Inset path 4 x (20 - 2 x 3) = 56 mm at a 1.5 mm step.
  expect(loop).toHaveLength(38);
  for (const disk of loop) {
    expect(disk.r).toBe(3);
    expect(disk.p[2]).toBeCloseTo(box.max[2]!, 3);
    expect(disk.n[0]).toBeCloseTo(0, 4);
    expect(disk.n[1]).toBeCloseTo(0, 4);
    expect(disk.n[2]).toBeCloseTo(1, 4);
    expect(Math.abs(toTopEdge(disk.p) - 3), `disk at ${disk.p} sits 3 mm in`).toBeLessThanOrEqual(0.05);
  }
  await expect(canvas).toHaveAttribute("data-reinforce-disks", "38");
  await expect(canvas).toHaveAttribute("data-edge-start", "");

  await page.keyboard.press("Control+z");
  await expect(canvas).toHaveAttribute("data-reinforce-disks", "0");
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]).not.toHaveProperty("reinforcement");

  const from = toScreen(half - 0.4, -4);
  const to = toScreen(half - 0.4, 4);
  await page.mouse.move(from.x, from.y);
  await expect(canvas).toHaveAttribute("data-edge-hover", "2");
  await page.mouse.down();
  await page.mouse.up();
  await expect(canvas).toHaveAttribute("data-edge-start", "1");
  await expect(canvas, "a started strip outlines its whole loop").toHaveAttribute("data-edge-hover", "4");
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await expect(canvas).toHaveAttribute("data-edge-preview", "7");
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => bodies.length).toBe(4);
  const arc = bodies[3]!.reinforcement![0]!.disks;
  // 8 mm along one edge at a 1.5 mm step, both ends included.
  expect(arc).toHaveLength(7);
  for (const disk of arc) {
    expect(disk.p[0], `disk at ${disk.p} lies on the right edge's inset`).toBeCloseTo(box.max[0]! - 3, 2);
    expect(disk.p[2]).toBeCloseTo(box.max[2]!, 3);
  }
  await expect(canvas).toHaveAttribute("data-edge-preview", "0");
});

test("Esc drops a started strip first and leaves the tool on the second press", async ({ page }) => {
  const { canvas, toScreen, half } = await openTop(page);
  await alongEdge(page);
  const edge = toScreen(0, half - 0.4);
  await page.mouse.move(edge.x, edge.y);
  await expect(canvas).toHaveAttribute("data-edge-hover", "2");
  await page.mouse.down();
  await page.mouse.up();
  await expect(canvas).toHaveAttribute("data-edge-start", "1");

  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-edge-start", "");
  await expect(page.locator("#reinforceBar")).toBeVisible();
  await expect(canvas).toHaveAttribute("data-reinforce-disks", "0");

  await page.keyboard.press("Escape");
  await expect(page.locator("#reinforceBar")).toBeHidden();
});

test("Shift+click in Brush mode paints a straight line from the last dab", async ({ page }) => {
  const { bodies, toScreen } = await openTop(page);
  const start = toScreen(-6, -5);
  const end = toScreen(6, 5);
  await page.mouse.click(start.x, start.y);
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]!.reinforcement![0]!.disks).toHaveLength(1);

  await page.keyboard.down("Shift");
  await page.mouse.click(end.x, end.y);
  await page.keyboard.up("Shift");
  await expect.poll(() => bodies.length).toBe(3);
  const disks = bodies[2]!.reinforcement![0]!.disks;
  const first = disks[0]!.p;
  const last = disks[disks.length - 1]!.p;
  const length = Math.hypot(last[0]! - first[0]!, last[1]! - first[1]!);
  expect(length, "the line runs from the first click to the second").toBeGreaterThan(14);
  for (let i = 1; i < disks.length; i++) {
    const [p, q] = [disks[i - 1]!.p, disks[i]!.p];
    // Stroke spacing 0.5 x r = 1.5 mm, plus one sampling step of at most r / 4 = 0.75 mm.
    expect(Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!), `gap before disk ${i}`).toBeLessThanOrEqual(2.25);
    const off = Math.abs((last[0]! - first[0]!) * (q[1]! - first[1]!) - (last[1]! - first[1]!) * (q[0]! - first[0]!)) / length;
    expect(off, `disk ${i} lies on the line`).toBeLessThanOrEqual(0.05);
  }
});

test.describe("Along edge on a touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a double tap on an edge lays the whole loop", async ({ page }) => {
    const { bodies, canvas, toScreen, half } = await openTop(page, "/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    for (const selector of ['#reinforceMode [data-reinforce-mode="brush"]', '#reinforceMode [data-reinforce-mode="edge"]']) {
      const target = (await page.locator(selector).boundingBox())!;
      expect(Math.min(target.width, target.height), `${selector} is ${target.width}x${target.height}`).toBeGreaterThanOrEqual(44);
    }
    await page.locator('#reinforceMode [data-reinforce-mode="edge"]').tap();
    await expect(canvas).toHaveAttribute("data-edge-ready", "1");
    // The bar covers the lower half of the stage, so tap the highest of the four edge midpoints.
    const edge = [toScreen(half - 0.4, 0), toScreen(0, half - 0.4), toScreen(0.4 - half, 0), toScreen(0, 0.4 - half)].sort((p, q) => p.y - q.y)[0]!;
    await page.touchscreen.tap(edge.x, edge.y);
    await expect(canvas).toHaveAttribute("data-edge-start", "1");
    await page.touchscreen.tap(edge.x, edge.y);
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]!.reinforcement![0]!.disks).toHaveLength(38);
  });
});
