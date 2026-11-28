import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { frameStats, previewFrames, watchGl, type FrameSample } from "./gl-frame";

/**
 * Orbit cost of a heavy preview, per strategy. Needs a running engine:
 *   LIME_PERF_API=http://127.0.0.1:43118 LIME_PW_PORT=44117 npx playwright test preview-orbit
 * LIME_PERF_MM is the box edge (default 30). A 60 mm Toughness slice does not finish a
 * frame on SwiftShader. LIME_SHOT_PREFIX writes
 * docs/screenshots/v1-preview/<prefix>-{rest,orbit,infill-hidden}.png for Toughness.
 */
const api = process.env.LIME_PERF_API;
const edge = Number(process.env.LIME_PERF_MM ?? "30");
const shotPrefix = process.env.LIME_SHOT_PREFIX;

test.skip(!api, "set LIME_PERF_API to a running lime-slice serve");
test.describe.configure({ mode: "serial" });
test.setTimeout(1_800_000);

const INFILL = ["sparse", "infill", "solid"];

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
    const layers = Number(await page.locator("#rangeHigh").getAttribute("max")) + 1;
    if (shotPrefix && card === "toughness") await shot(page, "rest");

    const rest = frameStats(await previewFrames(page, 3000, true));

    if (shotPrefix && card === "toughness") {
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
    }
    await page.evaluate(() => {
      const w = window as unknown as { __previewPerf: FrameSample[]; __gl: { draws: number; instances: number }; __previewPump: boolean };
      w.__gl.draws = 0;
      w.__gl.instances = 0;
      w.__previewPerf = [];
      w.__previewPump = false;
    });
    await orbit(page, 3000);
    const moving = frameStats(await page.evaluate(() => {
      const w = window as unknown as { __previewPerf: FrameSample[] };
      const samples = w.__previewPerf.filter((sample) => sample.calls > 0 && sample.ms > 0);
      w.__previewPerf = [];
      return samples;
    }));

    await settle(page);
    await setKinds(page, INFILL, false);
    if (shotPrefix && card === "toughness") {
      await settle(page);
      await shot(page, "infill-hidden");
    }
    const hidden = frameStats(await previewFrames(page, 3000, true));
    await setKinds(page, INFILL, true);

    out[card] = { layers, rest, orbit: moving, infillHidden: hidden };
    console.log(`PREVIEW_ORBIT ${card} ${JSON.stringify(out[card])}`);
  }
  console.log(`PREVIEW_ORBIT ${JSON.stringify(out)}`);
  const dir = path.resolve("test-results/preview-orbit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "orbit.json"), JSON.stringify(out, null, 2));
});
