import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

/**
 * Organic final round: one reply carries both meshes. The stand-in engine answers a step with the plate mesh (a box
 * 12 tall) and, when the view asks (`meshQuality: "display"`), a finer display mesh beside it (a box 14 tall, twice the
 * triangles). The view draws the display mesh; the plate takes the plate mesh, at once and with no second engine call.
 */
type V = [number, number, number];

function box(sz: number, copies = 1): { positions: number[]; triangles: number[] } {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * sz];
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
  for (let k = 0; k < copies; k += 1) {
    quads.forEach((q, face) => {
      for (const tri of [[0, 1, 2], [0, 2, 3]]) {
        for (const i of tri) positions.push(...q[i]!);
        triangles.push(face);
      }
    });
  }
  return { positions, triangles };
}

function solid(sz: number, display: boolean): MockSolid {
  const plate = box(sz);
  const fine = box(14, 2);
  return {
    volumeMm3: 400 * sz,
    ...plate,
    faces: Array.from({ length: 6 }, (_, id) => ({ id, areaMm2: 0 })),
    edges: [],
    ...(display ? { display: { positions: fine.positions, normals: fine.positions.map((_, i) => (i % 3 === 2 ? 1 : 0)), triangles: fine.triangles } } : {}),
  };
}

async function openPart(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: box(10).positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => solid(10, false),
    // The step: the plate mesh is 12 tall; asked for the display mesh, the same reply carries it too.
    apply: (request: Body) => solid(12, request.meshQuality === "display"),
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  return tree;
}

async function cut(page: Page) {
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelCut").click();
  await page.locator("#modelDx").fill("8");
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4800 mm³");
}

test("the view draws the display mesh; the plate takes the plate mesh from the same reply", async ({ page }) => {
  const tree = await openPart(page);
  await cut(page);
  expect(tree.of("apply").at(-1)?.meshQuality, "the view's step asks for the display mesh").toBe("display");
  // The view draws the display mesh: 24 triangles, 72 points, with the kernel's normals.
  await expect(page.locator("#model")).toHaveAttribute("data-solid-points", "72/72");
  await expect(page.locator("#model")).toHaveAttribute("data-normals-source", "analytic");
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj").first(), "the plate holds the plate mesh").toContainText("20 × 20 × 12");
  expect(tree.of("goto").length, "no second engine call for the plate's mesh").toBe(0);
});

test("a Model edit reaches the plate when another part is clicked at once, and Slice sends the edited mesh", async ({ page }) => {
  const tree = await openPart(page);
  // A second part on the plate.
  await page.locator("#tabPrepare").click();
  await page.locator("#plateAddFile").setInputFiles({ name: "second.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await page.locator("#objectList [data-plate-select]").first().click();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await cut(page);
  // Straight to the other part, as the review's steps did.
  await page.locator("#tabPrepare").click();
  await page.locator("#objectList [data-plate-select]").nth(1).click();
  await expect(page.locator("#objectList .obj").first(), "the edited part's plate mesh is the edit").toContainText("20 × 20 × 12");
  let sent = "";
  await page.route("**/api/slice**", async (route) => {
    sent = route.request().postData() ?? "";
    await route.fulfill({ status: 500, json: { error: "no slicer in this spec" } });
  });
  await page.locator("#slice").click();
  await expect.poll(() => sent.length > 0, { message: "a slice was asked for" }).toBe(true);
  expect(tree.calls.filter((call) => call.call === "goto").length, "no plate-quality refetch").toBe(0);
});
