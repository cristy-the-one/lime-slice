import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ORBIT_WARMUP_FRAMES, frameStats, orbitFrames, previewFrames, watchGl, type FrameSample } from "./gl-frame";

/**
 * Orbit cost of a heavy preview, per strategy. Needs a running engine:
 *   LIME_PERF_API=http://127.0.0.1:43118 LIME_PW_PORT=44117 npx playwright test preview-orbit
 * LIME_PERF_MM is the box edge (default 30). A 60 mm Toughness slice does not finish a
 * frame on SwiftShader. LIME_SHOT_PREFIX writes
 * docs/screenshots/v1-preview/<prefix>-{rest,orbit,infill-hidden}.png for Toughness.
 * LIME_SHOT_DIR writes the V2 resting views. LIME_ORBIT_OUT is the timing JSON.
 * The mid-orbit window drops the first frame drawn while the camera is moving
 * ({@link ORBIT_WARMUP_FRAMES}): its delta still includes the idle gap. A second
 * orbit is taken after dollying out far enough that beads switch to lines.
 */
const api = process.env.LIME_PERF_API;
const edge = Number(process.env.LIME_PERF_MM ?? "30");
const shotPrefix = process.env.LIME_SHOT_PREFIX;
const shotDir = process.env.LIME_SHOT_DIR;
const orbitOut = process.env.LIME_ORBIT_OUT;
/** Pumped at-rest frames. Toughness on main is about 2.4 s, so this yields several samples. */
const REST_MS = 15_000;
/** The first pumped frame can include the gap since the last draw. Drop it. */
const REST_WARMUP = 1;

test.skip(!api, "set LIME_PERF_API to a running lime-slice serve");
test.describe.configure({ mode: "serial" });
test.setTimeout(1_800_000);

const INFILL = ["sparse", "infill", "solid"];
/** Dolly steps that take the framed 30 mm view past the line threshold and leave the orbit there. */
const ZOOM_OUT_STEPS = 12;
const ZOOM_OUT_DELTA = 150;

function boxStl(size: number): string {
  const p = [
    [0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0],
    [0, 0, size], [size, 0, size], [size, size, size], [0, size, size],
  ];
  const faces: [number, number, number, number[]][] = [
    [0, 2, 1, [0, 0, -1]], [0, 3, 2, [0, 0, -1]],
    [4, 5, 6, [0, 0, 1]], [4, 6, 7, [0, 0, 1]],
    [0, 1, 5, [0, -1, 0]], [0, 5, 4, [0, -1, 0]],
    [1, 2, 6, [1, 0, 0]], [1, 6, 5, [1, 0, 0]],
    [2, 3, 7, [0, 1, 0]], [2, 7, 6, [0, 1, 0]],
    [3, 0, 4, [-1, 0, 0]], [3, 4, 7, [-1, 0, 0]],
  ];
  const lines = ["solid box"];
  for (const [a, b, c, n] of faces) {
    lines.push("  facet normal " + n.join(" "));
    lines.push("    outer loop");
    for (const i of [a, b, c]) lines.push(`      vertex ${p[i]!.join(" ")}`);
    lines.push("    endloop");
    lines.push("  endfacet");
  }
  lines.push("endsolid box");
  return lines.join("\n");
}

async function settle(page: Page) {
  await page.waitForTimeout(3000);
}

async function readOrbit(page: Page) {
  const samples = await page.evaluate(() => {
    const w = window as unknown as { __previewPerf: FrameSample[] };
    const taken = w.__previewPerf;
    w.__previewPerf = [];
    return taken;
  });
  return { ...frameStats(orbitFrames(samples)), warmupDropped: ORBIT_WARMUP_FRAMES };
}

async function beginOrbit(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __previewPerf: FrameSample[]; __gl: { draws: number; instances: number }; __previewPump: boolean };
    w.__gl.draws = 0;
    w.__gl.instances = 0;
    w.__previewPerf = [];
    w.__previewPump = false;
  });
}

/** Come in close enough that a chunk left on lines switches back to boxes, then the caller reframes. */
async function dollyIn(page: Page) {
  const box = await page.locator("#view3d").boundingBox();
  if (!box) throw new Error("preview canvas has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 14; i++) await page.mouse.wheel(0, -200);
  await page.waitForTimeout(300);
}

async function dollyOut(page: Page) {
  await page.evaluate(() => (window as unknown as { __previewReframe?: () => void }).__previewReframe?.());
  await page.waitForTimeout(400);
  const box = await page.locator("#view3d").boundingBox();
  if (!box) throw new Error("preview canvas has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < ZOOM_OUT_STEPS; i++) await page.mouse.wheel(0, ZOOM_OUT_DELTA);
  await page.waitForTimeout(400);
}

async function orbit(page: Page, ms: number) {
  const box = await page.locator("#view3d").boundingBox();
  if (!box) throw new Error("preview canvas has no box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const t0 = Date.now();
  let angle = 0;
  while (Date.now() - t0 < ms) {
    angle += 0.4;
    await page.mouse.move(cx + Math.cos(angle) * 100, cy + Math.sin(angle) * 46);
  }
  await page.mouse.up();
}

async function setKinds(page: Page, kinds: string[], shown: boolean) {
  await page.evaluate(({ kinds, shown }) => {
    for (const kind of kinds) {
      const input = document.querySelector<HTMLInputElement>(`#legend input[data-kind="${kind}"]`);
      if (!input || input.checked === shown) continue;
      input.checked = shown;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, { kinds, shown });
}

async function shot(page: Page, name: string) {
  if (!shotPrefix) return;
  const dir = path.resolve("docs/screenshots/v1-preview");
  fs.mkdirSync(dir, { recursive: true });
  await page.locator("#view3d").screenshot({ path: path.join(dir, `${shotPrefix}-${name}.png`) });
}

test("orbit frame cost of Speed, Efficiency and Toughness @perf", async ({ page }) => {
  const stl = path.join(os.tmpdir(), `lime-box-${edge}mm.stl`);
  fs.writeFileSync(stl, boxStl(edge));
  await watchGl(page);
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    const response = await route.fetch({ url, timeout: 1_200_000 });
    await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.locator("#file").setInputFiles(stl);
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();

  const out: Record<string, unknown> = { edgeMm: edge };
  for (const card of ["speed", "efficiency", "toughness"] as const) {
    const token = await page.locator("#view3d").getAttribute("data-preview-token");
    await page.locator(`[data-card="${card}"]`).click();
    await expect(page.locator(`[data-card="${card}"]`)).toHaveAttribute("aria-pressed", "true");
    await page.locator("#slice").click();
    await expect(page.locator("#slice")).toBeEnabled({ timeout: 1_200_000 });
    await expect.poll(async () => page.locator("#view3d").getAttribute("data-preview-token"), { timeout: 120_000 }).not.toBe(token ?? "");
    await page.getByRole("tab", { name: "Preview", exact: true }).click();
    await page.getByRole("button", { name: "3D", exact: true }).click();
    await settle(page);
    // A zoomed orbit leaves chunks on lines. Come in past the hysteresis band so they switch back, then frame.
    await dollyIn(page);
    await page.evaluate(() => (window as unknown as { __previewReframe?: () => void }).__previewReframe?.());
    await settle(page);
    const layers = Number(await page.locator("#rangeHigh").getAttribute("max")) + 1;
    const restAll = await previewFrames(page, REST_MS, true);
    const rest = frameStats(restAll.slice(REST_WARMUP));

    await beginOrbit(page);
    await orbit(page, 3000);
    const moving = await readOrbit(page);

    await settle(page);
    await setKinds(page, INFILL, false);
    const hidden = frameStats(await previewFrames(page, 3000, true));
    await setKinds(page, INFILL, true);

    await dollyOut(page);
    await beginOrbit(page);
    await orbit(page, 3000);
    const zoomed = await readOrbit(page);

    if (shotPrefix && card === "toughness") {
      await dollyIn(page);
      await page.evaluate(() => (window as unknown as { __previewReframe?: () => void }).__previewReframe?.());
      await settle(page);
      await shot(page, "rest");
      const box = await page.locator("#view3d").boundingBox();
      if (!box) throw new Error("preview canvas has no box");
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 14, cy + i * 6);
      await page.waitForTimeout(400);
      await shot(page, "orbit");
      await page.mouse.up();
      await settle(page);
      await setKinds(page, INFILL, false);
      await settle(page);
      await shot(page, "infill-hidden");
      await setKinds(page, INFILL, true);
    }

    out[card] = {
      layers,
      rest,
      restSamples: restAll.length,
      restWarmupDropped: REST_WARMUP,
      restMs: REST_MS,
      orbit: moving,
      orbitZoomed: zoomed,
      infillHidden: hidden,
      zoomOutSteps: ZOOM_OUT_STEPS,
    };
    console.log(`PREVIEW_ORBIT ${card} ${JSON.stringify(out[card])}`);
  }
  console.log(`PREVIEW_ORBIT ${JSON.stringify(out)}`);
  const dir = path.resolve("test-results/preview-orbit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(orbitOut ? path.resolve(orbitOut) : path.join(dir, "orbit.json"), JSON.stringify(out, null, 2));
});

function addTri(lines: string[], a: number[], b: number[], c: number[]) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  lines.push(`  facet normal ${uy * vz - uz * vy} ${uz * vx - ux * vz} ${ux * vy - uy * vx}`);
  lines.push("    outer loop");
  for (const p of [a, b, c]) lines.push(`      vertex ${p.join(" ")}`);
  lines.push("    endloop");
  lines.push("  endfacet");
}

/** `a,b,c,d` is counter-clockwise when looking at the face from outside. */
function addQuad(lines: string[], a: number[], b: number[], c: number[], d: number[]) {
  addTri(lines, a, b, c);
  addTri(lines, a, c, d);
}

function finishSolid(lines: string[]): string {
  lines.push("endsolid part");
  return lines.join("\n");
}

/** A 30×24×12 block with a 14×8 mm step on one side. One closed shell. */
function stepStl(): string {
  const y = 24;
  const z = 12;
  const top = 20;
  const x = 14;
  const w = 30;
  const lines = ["solid part"];
  const q = (a: number[], b: number[], c: number[], d: number[]) => addQuad(lines, a, b, c, d);
  q([0, 0, 0], [w, 0, 0], [w, 0, z], [0, 0, z]);
  q([0, 0, z], [x, 0, z], [x, 0, top], [0, 0, top]);
  q([0, y, 0], [0, y, z], [w, y, z], [w, y, 0]);
  q([0, y, z], [0, y, top], [x, y, top], [x, y, z]);
  q([0, 0, 0], [0, y, 0], [w, y, 0], [w, 0, 0]);
  q([0, y, 0], [0, 0, 0], [0, 0, top], [0, y, top]);
  q([w, 0, 0], [w, y, 0], [w, y, z], [w, 0, z]);
  q([x, 0, z], [w, 0, z], [w, y, z], [x, y, z]);
  q([0, 0, top], [x, 0, top], [x, y, top], [0, y, top]);
  q([x, 0, z], [x, y, z], [x, y, top], [x, 0, top]);
  return finishSolid(lines);
}

/** A 28×28×16 block with an 8 mm square hole through the layers. */
function holeStl(): string {
  const n = 28;
  const h = 16;
  const a = 10;
  const b = 18;
  const lines = ["solid part"];
  const q = (p: number[], r: number[], s: number[], t: number[]) => addQuad(lines, p, r, s, t);
  q([0, 0, 0], [n, 0, 0], [n, 0, h], [0, 0, h]);
  q([n, n, 0], [0, n, 0], [0, n, h], [n, n, h]);
  q([n, 0, 0], [n, n, 0], [n, n, h], [n, 0, h]);
  q([0, n, 0], [0, 0, 0], [0, 0, h], [0, n, h]);
  q([a, a, 0], [a, a, h], [b, a, h], [b, a, 0]);
  q([b, b, 0], [b, b, h], [a, b, h], [a, b, 0]);
  q([b, a, 0], [b, a, h], [b, b, h], [b, b, 0]);
  q([a, b, 0], [a, b, h], [a, a, h], [a, a, 0]);
  q([0, 0, h], [n, 0, h], [b, a, h], [a, a, h]);
  q([n, 0, h], [n, n, h], [b, b, h], [b, a, h]);
  q([n, n, h], [0, n, h], [a, b, h], [b, b, h]);
  q([0, n, h], [0, 0, h], [a, a, h], [a, b, h]);
  q([0, 0, 0], [a, a, 0], [b, a, 0], [n, 0, 0]);
  q([n, 0, 0], [b, a, 0], [b, b, 0], [n, n, 0]);
  q([n, n, 0], [b, b, 0], [a, b, 0], [0, n, 0]);
  q([0, n, 0], [a, b, 0], [a, a, 0], [0, 0, 0]);
  return finishSolid(lines);
}

const WALLS = ["outer", "inner", "wall", "thin-wall"];

async function reframe(page: Page) {
  await page.evaluate(() => (window as unknown as { __previewReframe?: () => void }).__previewReframe?.());
  await settle(page);
}

/** Drag a fraction of the canvas height. Positive y moves the camera toward the top. */
async function dragView(page: Page, dyFrac: number) {
  const box = await page.locator("#view3d").boundingBox();
  if (!box) throw new Error("preview canvas has no box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dy = box.height * dyFrac;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i++) await page.mouse.move(cx, cy + (dy * i) / steps);
  await page.mouse.up();
  await settle(page);
}

async function saveShot(page: Page, name: string) {
  if (!shotDir) return;
  const dir = path.resolve(shotDir);
  fs.mkdirSync(dir, { recursive: true });
  await page.locator("#view3d").screenshot({ path: path.join(dir, `${name}.png`) });
}

async function sliceToughness(page: Page, stl: string) {
  await page.goto("/");
  await page.locator("#file").setInputFiles(stl);
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  const token = await page.locator("#view3d").getAttribute("data-preview-token");
  await page.locator('[data-card="toughness"]').click();
  await expect(page.locator('[data-card="toughness"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#slice").click();
  await expect(page.locator("#slice")).toBeEnabled({ timeout: 1_200_000 });
  await expect.poll(async () => page.locator("#view3d").getAttribute("data-preview-token"), { timeout: 120_000 }).not.toBe(token ?? "");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await reframe(page);
}

test("resting views of a box, a step and a hole @perf", async ({ page }) => {
  test.skip(!shotDir, "set LIME_SHOT_DIR to write the resting screenshots");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lime-v2-"));
  await watchGl(page);
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    const response = await route.fetch({ url, timeout: 1_200_000 });
    await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const box = path.join(dir, "box.stl");
  fs.writeFileSync(box, boxStl(edge));
  await sliceToughness(page, box);
  await saveShot(page, "box-framed");
  await dragView(page, 0.2);
  await saveShot(page, "box-top");
  await reframe(page);
  await dragView(page, -0.06);
  await saveShot(page, "box-side");
  await reframe(page);
  await dragView(page, -0.22);
  await saveShot(page, "box-below");
  await reframe(page);

  const max = Number(await page.locator("#rangeHigh").getAttribute("max"));
  const low = Math.max(1, Math.round(max * 0.22));
  const high = Math.max(low + 1, Math.round(max * 0.78));
  await page.evaluate(({ low, high }) => {
    const lo = document.querySelector<HTMLInputElement>("#rangeLow")!;
    const hi = document.querySelector<HTMLInputElement>("#rangeHigh")!;
    lo.value = String(low);
    lo.dispatchEvent(new Event("input", { bubbles: true }));
    hi.value = String(high);
    hi.dispatchEvent(new Event("input", { bubbles: true }));
  }, { low, high });
  await settle(page);
  await saveShot(page, "box-slider");
  await page.evaluate(() => {
    const lo = document.querySelector<HTMLInputElement>("#rangeLow")!;
    const hi = document.querySelector<HTMLInputElement>("#rangeHigh")!;
    lo.value = "0";
    lo.dispatchEvent(new Event("input", { bubbles: true }));
    hi.value = hi.max;
    hi.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await reframe(page);

  await setKinds(page, WALLS, false);
  await settle(page);
  await saveShot(page, "box-walls-hidden");
  await setKinds(page, WALLS, true);
  await reframe(page);

  await page.locator('#toolRail [data-tool="section"]').click();
  await expect(page.locator("#sectionOn")).toBeChecked();
  await settle(page);
  await saveShot(page, "box-section");

  const step = path.join(dir, "step.stl");
  fs.writeFileSync(step, stepStl());
  await sliceToughness(page, step);
  await saveShot(page, "step-framed");

  const hole = path.join(dir, "hole.stl");
  fs.writeFileSync(hole, holeStl());
  await sliceToughness(page, hole);
  await saveShot(page, "hole-framed");
});
