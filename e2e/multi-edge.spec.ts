import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { holeAxis, outwardFromMesh } from "../src/model-blend.ts";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

const out = "/opt/cursor/artifacts/multi-edge";
fs.mkdirSync(out, { recursive: true });

type V = [number, number, number];

/** A 20 × 20 × 10 mm box, as the modeler reports a solid. */
function boxSolid() {
  const [sx, sy, sz] = [20, 20, 10];
  const c = (x: number, y: number, z: number): V => [x * sx, y * sy, z * sz];
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
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const pa = corners[a!]!;
    const pb = corners[b!]!;
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges };
}

const solid = boxSolid();

async function openModel(page: Page, probes: Record<string, unknown>[]) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, {
    open: () => solid,
    apply: (request) => {
      probes.push(request.op as Record<string, unknown>);
      return solid;
    },
    probe: (request) => {
      probes.push(request.op as Record<string, unknown>);
      return { ok: true };
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
}

async function clickCanvas(page: Page, x: number, y: number, shift = false) {
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.click(x, y);
  if (shift) await page.keyboard.up("Shift");
}

test("a hole follows the picked face, and a fillet sends every selected edge", async ({ page }) => {
  const probes: Record<string, unknown>[] = [];
  await openModel(page, probes);
  await expect(page.locator("#modelToolFillet")).toHaveAttribute("data-tip-idle", "Round every selected edge in one step");
  await expect(page.locator("#modelToolFillet")).toHaveAttribute("data-tip", "Pick an edge to fillet. Switch to Edge, then click the edges.");
  await expect(page.locator("#modelToolHole")).toHaveAttribute("data-tip", "Cut a cylinder into the picked face, or straight down");

  await page.locator("#modelToolHole").click();
  await expect.poll(() => (probes.at(-1)?.axis as number[] | undefined)?.[2]).toBe(-1);
  expect(probes.at(-1)).toMatchObject({ kind: "hole", axis: [0, 0, -1] });
  await expect(page.locator("#modelNote")).toContainText("Straight down from the origin.");
  await page.locator("#modelToolHole").click();

  const box = (await page.locator("#model").boundingBox())!;
  const spots = [
    [0.5, 0.68],
    [0.36, 0.62],
    [0.64, 0.6],
    [0.5, 0.42],
  ];
  let face = -1;
  for (const [u, v] of spots) {
    await clickCanvas(page, box.x + box.width * u, box.y + box.height * v);
    const text = await page.locator("#modelReadout").innerText();
    const match = text.match(/Face (\d+)/);
    if (match) {
      face = Number(match[1]) - 1;
      break;
    }
  }
  expect(face, "a click should land on a face").toBeGreaterThanOrEqual(0);
  const outward = outwardFromMesh(solid.positions, solid.triangles, face);
  expect(outward).not.toBeNull();
  const [dx, dy, dz] = holeAxis(outward);

  const before = probes.length;
  await page.locator("#modelToolHole").click();
  await expect.poll(() => probes.length).toBeGreaterThan(before);
  await expect.poll(() => (probes.at(-1)?.axis as number[] | undefined)?.[0]).toBeCloseTo(dx, 5);
  expect(probes.at(-1)).toMatchObject({ kind: "hole" });
  const axis = probes.at(-1)?.axis as number[];
  expect(axis[1]).toBeCloseTo(dy, 5);
  expect(axis[2]).toBeCloseTo(dz, 5);
  const down = Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6 && dz < -0.9;
  await expect(page.locator("#modelNote")).toContainText(down ? "Straight down from the origin." : "Into the picked face.");
  await page.screenshot({ path: path.join(out, "hole-face.png") });

  await page.locator("#modelPickEdge").click();
  await expect(page.locator("#modelPickEdge")).toHaveAttribute("aria-pressed", "true");
  const hits: { x: number; y: number; edge: number }[] = [];
  for (let row = 0; row < 9 && hits.length < 2; row += 1) {
    for (let col = 0; col < 9 && hits.length < 2; col += 1) {
      const x = box.x + box.width * (0.18 + col * 0.08);
      const y = box.y + box.height * (0.18 + row * 0.08);
      await clickCanvas(page, x, y);
      const text = await page.locator("#modelReadout").innerText();
      const match = text.match(/Edge (\d+)/);
      if (!match) continue;
      const edge = Number(match[1]);
      if (!hits.some((hit) => hit.edge === edge)) hits.push({ x, y, edge });
    }
  }
  expect(hits.length, "the scan should find two different edges").toBeGreaterThanOrEqual(2);
  await clickCanvas(page, hits[0]!.x, hits[0]!.y);
  await clickCanvas(page, hits[1]!.x, hits[1]!.y, true);
  await expect(page.locator("#modelCount")).toContainText("2 edges");
  await page.locator("#modelToolFillet").click();
  await expect(page.locator("#modelPickEdge")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => (probes.at(-1)?.edges as number[] | undefined)?.length).toBe(2);
  const sent = probes.at(-1)?.edges as number[];
  expect(new Set(sent).size).toBe(2);
  await expect(page.locator("#modelNote")).toContainText("This fillet fits.");
  await page.screenshot({ path: path.join(out, "two-edges.png") });
});
