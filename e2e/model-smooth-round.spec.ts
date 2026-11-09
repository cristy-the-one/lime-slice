import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

/** Where the owner's before/after screenshots go; unset in CI. */
const SHOTS = process.env.LIME_SHOTS_DIR;

/** A 10 mm sphere as the modeler reports it: one face, its seam (edge 0) and a latitude ring that is a real edge (edge 1). */
function sphere(seams: boolean): MockSolid {
  const r = 5;
  const lon = 24;
  const lat = 12;
  const at = (i: number, j: number): V => {
    // The seam faces the default view, down the middle of the ball.
    const theta = (i / lon) * 2 * Math.PI - Math.PI / 2;
    const phi = (j / lat) * Math.PI;
    return [r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r + r * Math.cos(phi)];
  };
  const positions: number[] = [];
  const triangles: number[] = [];
  for (let i = 0; i < lon; i += 1) {
    for (let j = 0; j < lat; j += 1) {
      const p00 = at(i, j);
      const p10 = at(i + 1, j);
      const p11 = at(i + 1, j + 1);
      const p01 = at(i, j + 1);
      for (const tri of [[p00, p11, p10], [p00, p01, p11]]) {
        for (const p of tri) positions.push(...p);
        triangles.push(0);
      }
    }
  }
  const meridian: number[] = [];
  for (let j = 0; j <= lat; j += 1) meridian.push(...at(0, j));
  const ring: number[] = [];
  for (let i = 0; i <= lon; i += 1) ring.push(...at(i, lat / 2));
  return {
    volumeMm3: 524,
    positions,
    triangles,
    faces: [{ id: 0, areaMm2: 314, surface: "sphere", radiusMm: r }],
    edges: [{ id: 0, lengthMm: 31, points: meridian }, { id: 1, lengthMm: 31, points: ring }],
    ...(seams ? { seams: [0] } : {}),
  };
}

async function open(page: Page, solid: MockSolid) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid, apply: () => solid });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "ball.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
}

/** Every edge number a click lands on in Edge mode, along `points` in page pixels. */
async function edgesClicked(page: Page, points: [number, number][]): Promise<Set<number>> {
  await page.locator("#modelPickEdge").click();
  await expect(page.locator("#modelPickEdge")).toHaveAttribute("aria-pressed", "true");
  const seen = new Set<number>();
  for (const [x, y] of points) {
    await page.mouse.click(x, y);
    const match = (await page.locator("#modelReadout").innerText()).match(/Edge (\d+)/);
    if (match) seen.add(Number(match[1]));
  }
  return seen;
}

/** Down the ball's middle, where the seam runs (888, 320 to 695 at 1440 x 1000), and along the front of its latitude ring. */
const SEAM_SCAN: [number, number][] = [];
// (not where the ring crosses it, at the back near 440 and the front 510 to 620)
for (let y = 340; y <= 690; y += 10) if (y < 415 || (y > 465 && y < 510) || y > 625) for (const dx of [-6, -3, 0, 3, 6]) SEAM_SCAN.push([888 + dx, y]);
const RING_SCAN: [number, number][] = [];
for (let y = 520; y <= 640; y += 3) RING_SCAN.push([1010, y]);

test("a round face is shaded smooth, and its seam is not drawn", async ({ page }) => {
  await open(page, sphere(true));
  const canvas = page.locator("#model");
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, process.env.LIME_SHOT_NAME ?? "sphere-after.png") });
  // 288 quads = 1728 corners. Flat shading would give every corner its own point; welded in the face, a ring of points each.
  const [points, corners] = ((await canvas.getAttribute("data-solid-points")) ?? "0/0").split("/").map(Number) as [number, number];
  expect(corners).toBe(1728);
  expect(points, "corners of one face that meet share a normal").toBeLessThan(corners / 4);
  // Two edges are listed, one is the seam: one is drawn.
  await expect(canvas).toHaveAttribute("data-edges-drawn", "1/2");
});

test("the seam is neither hovered nor picked, while a real edge still is", async ({ page }) => {
  await open(page, sphere(true));
  const seam = await edgesClicked(page, SEAM_SCAN);
  expect(seam.size, "clicking where the seam runs picks no edge").toBe(0);
  expect((await edgesClicked(page, RING_SCAN)).size, "the latitude ring still is picked").toBeGreaterThan(0);
});

test("without the flag the same scan does reach the seam (the scan is sound)", async ({ page }) => {
  await open(page, sphere(false));
  await expect(page.locator("#model")).toHaveAttribute("data-edges-drawn", "2/2");
  expect((await edgesClicked(page, SEAM_SCAN)).size).toBeGreaterThan(0);
});
