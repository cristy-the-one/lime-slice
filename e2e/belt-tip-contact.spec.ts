import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { lipBoxStl, tipContacts } from "./belt-lipbox";
import { serveSliceJob } from "./serve-job";
import { setSupports } from "./supports";
import type { Vec3 } from "../src/preview-geom";

/**
 * On a 45° belt the layers lean, so the preview hangs each bead along the tilted layer normal.
 * Dropped straight down, as it was, a bead covered only cos 45° of its layer's thickness: every
 * layer showed a dark seam to the next, and a tree tip stopped short of the interface it holds,
 * although the G-code prints the tip right under it.
 *
 * The fixture is `lipBoxStl()` sliced for the IR3 V2 by a real engine: Automatic organic
 * trees, Tip under every row, gaps Auto. The engine test re-slices it and checks the preview's
 * beads against the G-code:
 *   lime-slice serve --port 43218 --cache-dir <dir>
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test belt-tip-contact
 */
const fixture = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/lipbox-belt.json"), "utf8"));
const BELT_UP: Vec3 = [0, Math.SQRT1_2, Math.SQRT1_2];
const SHOTS = "test-results/belt-tips";

async function openBelt(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machinePrinter").selectOption("ideaformer-ir3-v2");
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  await page.locator("#file").setInputFiles({ name: "lipbox.stl", mimeType: "model/stl", buffer: Buffer.from(lipBoxStl()) });
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 30_000 });
}

/** The scene normal the preview shader hangs beads along, as the view reports it. */
async function drawnUp(page: Page): Promise<Vec3> {
  const text = await page.locator("#view3d").getAttribute("data-layer-up");
  return (text ?? "").split(",").map(Number) as Vec3;
}

/** Only supports and interface shown, seen from under the belt toward the lip. */
async function shootFromBelow(page: Page, name: string) {
  await page.evaluate(() => {
    for (const box of document.querySelectorAll<HTMLInputElement>("#right input[data-kind]")) {
      const keep = box.dataset.kind === "support" || box.dataset.kind === "support-interface";
      if (box.checked !== keep) box.click();
    }
  });
  const view = (await page.locator("#view3d").boundingBox())!;
  const cx = view.x + view.width / 2;
  const cy = view.y + view.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 150, cy - 420, { steps: 25 });
  await page.mouse.up();
  await page.waitForTimeout(2000);
  for (let i = 0; i < 22; i++) await page.mouse.wheel(0, -300);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test("belt tree tips are drawn touching the interface they hold", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await serveSliceJob(page, fixture);
  await openBelt(page);
  await expect(page.locator("#view3d")).toHaveAttribute("data-layer-up", "0.0000,0.7071,0.7071");
  await page.locator("#slice").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current", { timeout: 60_000 });
  await page.getByRole("tab", { name: "Preview" }).click();

  const up = await drawnUp(page);
  up.forEach((v, k) => expect(v).toBeCloseTo(BELT_UP[k], 3));
  const gaps = tipContacts(fixture, up);
  expect(gaps.length, "tree beads right under a bottom interface bead").toBeGreaterThan(30);
  expect(Math.max(...gaps), "drawn gap from a tip's top to the interface above it, mm").toBeLessThan(0.01);

  await shootFromBelow(page, "from-below");
});

test("a flat bed keeps beads hanging straight down", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#view3d")).toHaveAttribute("data-layer-up", "0.0000,1.0000,0.0000");
});

const api = process.env.LIME_EDIT_API;

test.describe("against a real engine", () => {
  test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");

  test("the preview's tree and interface beads are the G-code's, and tips touch", async ({ page }) => {
    test.setTimeout(300_000);
    const replies: { layers: never[]; mesh: { min: number[]; max: number[] }; gcodeToken?: string; gcode?: string }[] = [];
    await page.route("http://127.0.0.1:43118/**", async (route) => {
      const url = route.request().url().replace("http://127.0.0.1:43118", api!);
      const response = await route.fetch({ url, timeout: 240_000 });
      if (/\/api\/jobs\/[^/]+\/result$|\/api\/slice$/.test(url) && response.status() === 200) replies.push(JSON.parse(await response.text()));
      await route.fulfill({ response });
    });
    await openBelt(page);
    await page.locator("#levelPick").selectOption("advanced");
    await setSupports(page, "auto");
    await expect(page.locator("#sstyle")).toHaveValue("tree");
    await page.locator("#rowtips").check();
    await page.locator("#slice").click();
    await expect(page.locator("#export")).toHaveAttribute("data-slice", "current", { timeout: 240_000 });
    const reply = replies.at(-1)!;
    const gcode = reply.gcode || (await (await page.request.get(`${api}/api/gcode/${reply.gcodeToken}`)).text());

    const printed = gcodeBeads(gcode);
    const shown = previewBeads(reply.layers);
    expect(shown.length, "preview layers").toBe(printed.length);
    // The G-code's belt axis runs against the reply frame's Y; a shift lines the frames up.
    const p = printed.flatMap((layer) => layer.support);
    const s = shown.flatMap((layer) => layer.support);
    const shift = [mean(s, 0) - mean(p, 0), mean(s, 1) + mean(p, 1), mean(s, 2) - mean(p, 2)];
    for (const kind of ["support", "support-interface"] as const) {
      expect(shown.flatMap((layer) => layer[kind]).length, `${kind} points`).toBeGreaterThan(100);
      let worst = { d: 0, layer: -1, at: [] as number[] };
      printed.forEach((layer, l) => {
        for (const [x, y, z] of layer[kind]) {
          const at = [x + shift[0], shift[1] - y, z + shift[2]];
          const d = nearest(shown[l][kind], at);
          if (d > worst.d) worst = { d, layer: l, at };
        }
      });
      expect(worst.d, `${kind}: every printed point has a preview point on its layer, mm; worst ${JSON.stringify(worst)}`).toBeLessThan(0.2);
    }

    await page.getByRole("tab", { name: "Preview" }).click();
    const gaps = tipContacts(reply, await drawnUp(page));
    expect(gaps.length).toBeGreaterThan(30);
    expect(Math.max(...gaps)).toBeLessThan(0.01);
  });
});

type Kinded = { support: number[][]; "support-interface": number[][] };

/** Every extruding move's end point by layer and feature, read as belt-handedness reads a belt file: X, v = Z − Y cos a, u = Y sin a. */
function gcodeBeads(gcode: string): Kinded[] {
  const s = Math.SQRT1_2;
  const layers: Kinded[] = [];
  let feature = "";
  let [x, b, u, e] = [0, 0, 0, 0];
  for (const line of gcode.split("\n")) {
    if (line.startsWith(";LAYER:")) {
      layers.push({ support: [], "support-interface": [] });
      continue;
    }
    const type = /^;\s*TYPE:(\S+)/.exec(line);
    if (type) feature = type[1].toLowerCase();
    const word = (axis: string) => new RegExp(`\\s${axis}(-?[\\d.]+)`).exec(line)?.[1];
    if (/^G92 /.test(line) && word("E")) e = Number(word("E"));
    if (layers.length === 0 || !/^G[0-3] /.test(line)) continue;
    x = word("X") ? Number(word("X")) : x;
    b = word("Z") ? Number(word("Z")) : b;
    u = word("Y") ? Number(word("Y")) : u;
    // Absolute E: a bead is a move that pushes filament, not a wipe that pulls it back.
    const pushed = word("E") !== undefined && Number(word("E")) > e + 1e-6;
    if (word("E") !== undefined) e = Number(word("E"));
    if ((feature === "support" || feature === "support-interface") && pushed && (word("X") || word("Y"))) {
      layers.at(-1)![feature].push([x, b - u * s, u * s]);
    }
  }
  return layers;
}

function previewBeads(layers: { z: number; paths: { kinds: string[]; kind: number[]; start: number[]; xy: number[]; z: (number | null)[] } }[]): Kinded[] {
  return layers.map((layer) => {
    const out: Kinded = { support: [], "support-interface": [] };
    const c = layer.paths;
    for (let i = 0; i < c.kind.length; i++) {
      const name = c.kinds[c.kind[i]];
      if (name !== "support" && name !== "support-interface") continue;
      for (let k = c.start[i]; k < c.start[i + 1]; k++) out[name].push([c.xy[2 * k], c.xy[2 * k + 1], c.z[k] ?? layer.z]);
    }
    return out;
  });
}

const mean = (points: number[][], k: number) => points.reduce((sum, p) => sum + p[k], 0) / points.length;

/** Distance to the nearest preview vertex. The preview drops only vertices within 0.04 mm of the last one it kept. */
function nearest(points: number[][], p: number[]): number {
  let best = Infinity;
  for (const q of points) best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
  return best;
}
