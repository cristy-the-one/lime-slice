import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

/**
 * Organic fix round S5: a sketch root edit rebuilds every node under its own id. The commit that follows must put the
 * NEW solid's mesh on the plate, not the mesh the node stored before the edit.
 */
type V = [number, number, number];

function box(sx: number, sy: number, sz: number): MockSolid {
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
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

/** The extrude the open asks for, built as a 12 x 5 box as tall as its depth. */
function built(request: Body): MockSolid {
  const feature = request.feature as { depth?: number } | undefined;
  return box(12, 5, Math.abs(feature?.depth ?? 10));
}

async function drawAndExtrude(page: Page, depth: string) {
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=rectangle]").click();
  const area = (await canvas.boundingBox())!;
  await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").nth(0).fill("12");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("5");
  await hud.locator("input").nth(1).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "4");
  await page.locator("button[data-sketch-extrude]").click();
  await hud.locator("input").first().fill(depth);
  await hud.locator("input").first().press("Enter");
}

test("after a sketch root edit the plate takes the rebuilt solid, not the mesh stored before the edit", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: built, probe: () => ({ ok: true }) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await page.locator("#modelEmptySketch").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch", "editing");
  await drawAndExtrude(page, "5");
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj").first()).toContainText("12 × 5 × 5");

  // Edit the root's sketch: the same outline, 9 deep.
  await page.locator("#tabModel").click();
  await page.getByRole("treeitem").first().locator(".mh-more").click();
  await page.getByRole("menuitem", { name: /Edit step/ }).click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch", "editing");
  const hud = page.locator(".interact-hud:not([hidden])");
  if (!(await hud.isVisible())) await page.locator("button[data-sketch-extrude]").click();
  await hud.locator("input").first().fill("9");
  await hud.locator("input").first().press("Enter");
  await expect.poll(() => tree.of("open").map((request) => (request.feature as { depth?: number } | undefined)?.depth).filter((d) => d !== undefined).at(-1)).toBe(9);
  await expect(page.locator("#modelReadout")).toContainText("Updated the sketch.");

  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj").first(), "the plate holds the rebuilt solid").toContainText("12 × 5 × 9");
});
