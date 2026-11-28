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
 * The mid-orbit window drops the first frame drawn while the camera is moving
 * ({@link ORBIT_WARMUP_FRAMES}): its delta still includes the idle gap. A second
 * orbit is taken after dollying out far enough that beads switch to lines.
 */
const api = process.env.LIME_PERF_API;
const edge = Number(process.env.LIME_PERF_MM ?? "30");
const shotPrefix = process.env.LIME_SHOT_PREFIX;

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
    const rest = frameStats(await previewFrames(page, 3000, true));

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

    out[card] = { layers, rest, orbit: moving, orbitZoomed: zoomed, infillHidden: hidden, zoomOutSteps: ZOOM_OUT_STEPS };
    console.log(`PREVIEW_ORBIT ${card} ${JSON.stringify(out[card])}`);
  }
  console.log(`PREVIEW_ORBIT ${JSON.stringify(out)}`);
  const dir = path.resolve("test-results/preview-orbit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "orbit.json"), JSON.stringify(out, null, 2));
});
