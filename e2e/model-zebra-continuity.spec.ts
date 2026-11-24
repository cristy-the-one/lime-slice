import { inflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

/**
 * A flat 40 x 10 mm strip of two faces whose vertex normals tilt along x, as two curved patches meeting at x = 0
 * would: the normal's z runs `z0 -> zSeam` over the left face and `zSeam -> z1` over the right. Equal slopes on both
 * sides are a G2 seam; a slope that jumps at the seam is G1 (same normal, different bending).
 */
function strip(z0: number, zSeam: number, z1: number): MockSolid {
  const heading = (z: number): V => [Math.sqrt(Math.max(0, 1 - z * z)), 0, z];
  const positions: number[] = [];
  const normals: number[] = [];
  const triangles: number[] = [];
  const vert = (x: number, y: number, n: V) => {
    positions.push(x, y, 0);
    normals.push(...n);
  };
  // Many columns per face, so the interpolated normal follows the intended slope.
  const columns = 40;
  const zAt = (t: number) => (t <= 0.5 ? z0 + (zSeam - z0) * (t / 0.5) : zSeam + (z1 - zSeam) * ((t - 0.5) / 0.5));
  for (let i = 0; i < columns; i += 1) {
    const face = i < columns / 2 ? 0 : 1;
    const x0 = -20 + (40 * i) / columns;
    const x1 = -20 + (40 * (i + 1)) / columns;
    const n0 = heading(zAt(i / columns));
    const n1 = heading(zAt((i + 1) / columns));
    vert(x0, -5, n0);
    vert(x1, -5, n1);
    vert(x1, 5, n1);
    triangles.push(face);
    vert(x0, -5, n0);
    vert(x1, 5, n1);
    vert(x0, 5, n0);
    triangles.push(face);
  }
  return { volumeMm3: 0, positions, normals, triangles, faces: [{ id: 0, areaMm2: 200 }, { id: 1, areaMm2: 200 }], edges: [] };
}

/** RGBA pixels of a PNG screenshot (8-bit RGB or RGBA, no interlace), decoded here so no image library is needed. */
function decodePng(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= channels ? line[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      line[x] = (v + [0, a, b, (a + b) >> 1, paeth][filter]!) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      out.set([line[x * channels]!, line[x * channels + 1]!, line[x * channels + 2]!, 255], (y * width + x) * 4);
    }
    prev.set(line);
  }
  return { width, height, rgba: out };
}

async function show(page: Page, solid: MockSolid): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Shader Error|WebGLProgram|WebGL: INVALID|GL_INVALID|GL ERROR/i.test(text)) errors.push(text);
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, { open: () => solid });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "strip.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#model")).toHaveAttribute("data-normals-source", "analytic");
  // The viewport's own Zebra material, from the View menu, banded by the world normal's z (horizontal).
  const view = page.locator("#modelLookOpen");
  if (!(await view.isVisible())) await page.getByRole("button", { name: "Inspect tools" }).click();
  await view.click();
  await page.locator("#modelShading [data-shading=zebra]").click();
  await expect(page.locator("#model")).toHaveAttribute("data-shading", "zebra");
  await page.locator("#modelZebraAxis [data-zebra-axis=horizontal]").click();
  await page.keyboard.press("Escape");
  // Top view: the strip lies left to right across the canvas, the seam in the middle.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("t");
  await page.waitForTimeout(500);
  return errors;
}

/** Stripe boundaries crossed along the strip's middle row, left of the seam and right of it. */
async function stripes(page: Page): Promise<{ left: number; right: number; dark: number; light: number; width: number }> {
  const shot = decodePng(await page.locator("#model").screenshot({ path: test.info().outputPath(`zebra-${Date.now()}.png`) }));
  const lum = (x: number, y: number) => {
    const i = (y * shot.width + x) * 4;
    return shot.rgba[i]! + shot.rgba[i + 1]! + shot.rgba[i + 2]!;
  };
  // The view frames the strip at the canvas's centre, the seam on its middle column. The row is a little below the
  // centre line, clear of the axis line drawn there. The background is as dark as a dark band, so the strip's extent is
  // read from its first and last light pixel.
  const row = Math.floor(shot.height / 2) + 20;
  const kinds = Array.from({ length: shot.width }, (_, x) => (lum(x, row) > 650 ? "l" : "d"));
  const first = kinds.indexOf("l");
  const last = kinds.lastIndexOf("l");
  const mid = Math.floor(shot.width / 2);
  let left = 0;
  let right = 0;
  let prev = "";
  for (let x = first; x <= last; x += 1) {
    const k = kinds[x]!;
    if (prev && k !== prev) {
      if (x < mid) left += 1;
      else right += 1;
    }
    prev = k;
  }
  const inside = kinds.slice(first, last + 1);
  return { left, right, dark: inside.filter((k) => k === "d").length, light: inside.filter((k) => k === "l").length, width: last - first };
}

test("the viewport's zebra stripes kink across a G1 seam and run on across a G2 seam", async ({ page, context }) => {
  const errors = await show(page, strip(0.2, 0.8, 0.9));
  const g1 = await stripes(page);
  const second = await context.newPage();
  const errors2 = await show(second, strip(0.2, 0.5, 0.8));
  const g2 = await stripes(second);
  console.log(`S5 viewport zebra g1 left=${g1.left} right=${g1.right} g2 left=${g2.left} right=${g2.right} (g1 dark/light px ${g1.dark}/${g1.light}, strip ${g1.width} px)`);
  expect([...errors, ...errors2], "the zebra material compiles with no WebGL error").toEqual([]);
  expect(g1.dark > 20 && g1.light > 20, "black and white bands are drawn on the strip").toBe(true);
  expect(g1.left, "G1 stripes kink: the slope changes across the seam").toBeGreaterThanOrEqual(g1.right + 2);
  expect(Math.abs(g2.left - g2.right), "G2 stripes run on: the same slope on both sides").toBeLessThanOrEqual(1);
});
