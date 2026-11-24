import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Built } from "./model-tree-mock";

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

/** Click over the viewport in edge mode until the readout names an edge. */
async function pickEdge(page: Page) {
  await page.locator("#modelPickEdge").click();
  const box = (await page.locator("#model").boundingBox())!;
  for (let r = 0; r < 9; r += 1) {
    for (let col = 0; col < 9; col += 1) {
      await page.mouse.click(box.x + box.width * (0.18 + col * 0.08), box.y + box.height * (0.18 + r * 0.08));
      if (/Edge \d+/.test(await page.locator("#modelReadout").innerText())) return;
    }
  }
  throw new Error("no edge under the scan");
}

async function openFillet(page: Page, apply?: () => Built) {
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid, ...(apply ? { apply } : {}) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  // As a user does: Fillet opens once an edge is picked.
  await expect(page.locator("#modelToolFillet")).toHaveAttribute("aria-disabled", "true");
  await pickEdge(page);
  await expect(page.locator("#modelToolFillet")).not.toHaveAttribute("aria-disabled", "true");
  await page.locator("#modelToolFillet").click();
  await expect(page.locator("#modelFilletProfile")).toBeVisible();
}

test("fillet defaults to circular G1 and offers smooth G2, conic, and a variable radius", async ({ page }) => {
  await openFillet(page);
  await expect(page.locator("#modelFilletProfile [data-fillet-profile=g1]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelFilletRho")).toBeHidden();
  await expect(page.locator("#modelFilletStart")).toBeHidden();
  // The profile promises no more than the kernel builds: the hint shows with G2 and Conic only.
  const note = page.locator("#modelFilletProfileNote");
  await expect(note).toBeHidden();

  await page.locator("#modelFilletProfile [data-fillet-profile=g2]").click();
  await expect(page.locator("#modelFilletProfile [data-fillet-profile=g2]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelFilletProfile [data-fillet-profile=g1]")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#modelFilletRho")).toBeHidden();
  await expect(note).toBeVisible();
  await expect(note).toHaveText("Only on straight edges between flat faces.");

  await page.locator("#modelFilletProfile [data-fillet-profile=conic]").click();
  await expect(page.locator("#modelFilletProfile [data-fillet-profile=conic]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelFilletRho")).toBeVisible();
  await expect(note).toBeVisible();

  await page.locator("#modelFilletVariable").check();
  await expect(page.locator("#modelFilletStart")).toBeVisible();
  await expect(page.locator("#modelFilletMid")).toBeVisible();
  await expect(page.locator("#modelFilletEnd")).toBeVisible();
});

/** The kernel's sentence for G2 fillet edges that meet at a corner (crates/lime-model-occt/cpp/kernel.cpp). */
const CORNER = "A G2 fillet is built only on straight edges between two flat faces that do not meet each other: picked edges that meet at a corner need a corner blend it does not build. Pick edges that do not touch, or use G1.";

test("a refused G2 fillet shows the kernel's sentence as it comes", async ({ page }) => {
  await openFillet(page, () => ({ error: CORNER }));
  await page.locator("#modelFilletProfile [data-fillet-profile=g2]").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText(CORNER);
});
