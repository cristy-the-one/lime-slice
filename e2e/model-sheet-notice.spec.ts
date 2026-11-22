import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

/** One open quad: a sheet the modeler reports as not a solid, with one naked edge. */
function sheet(): MockSolid {
  const corners: V[] = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0]];
  const positions = [...corners[0]!, ...corners[1]!, ...corners[2]!, ...corners[0]!, ...corners[2]!, ...corners[3]!];
  return {
    volumeMm3: 0,
    positions,
    triangles: [0, 0],
    faces: [{ id: 0, areaMm2: 400 }],
    edges: [{ id: 0, lengthMm: 20, points: [...corners[0]!, ...corners[1]!] }],
    solid: false,
    nakedEdges: [0],
  };
}

/** The same quad, closed, after Thicken or Cap & Sew. */
function closed(): MockSolid {
  const open = sheet();
  return { ...open, volumeMm3: 800, solid: true, nakedEdges: [] };
}

async function openSheet(page: Page) {
  const open = sheet();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: open.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => open,
    apply: (request) => {
      const kind = (request.op as Body | undefined)?.kind;
      if (kind === "thicken" || kind === "sew") return closed();
      return { error: `unexpected ${String(kind)}` };
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "roof.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelSheetBar")).toBeVisible();
  await expect(page.locator("#modelSheetText")).toContainText("1 open border");
  await expect(page.locator("#modelHistoryTree .mh-sheet")).toHaveText("Sheet");
  return tree;
}

test("an open sheet thickens from the notice", async ({ page }) => {
  const tree = await openSheet(page);
  await expect(page.locator("#modelSheetThickenGo")).toBeVisible();
  await expect(page.locator("#modelSheetSewGo")).toBeVisible();
  await page.locator("#modelSheetThickenMm").fill("2.4");
  await page.locator("#modelSheetThickenGo").click();
  await expect.poll(() => tree.of("apply").length).toBe(1);
  expect(tree.of("apply")[0]?.op).toEqual({ kind: "thicken", thickness: 2.4 });
  await expect(page.locator("#modelSheetBar")).toBeHidden();
});

test("an open sheet caps and sews from the notice", async ({ page }) => {
  const tree = await openSheet(page);
  await page.locator("#modelSheetSewGo").click();
  await expect.poll(() => tree.of("apply").length).toBe(1);
  expect(tree.of("apply")[0]?.op).toEqual({ kind: "sew", capPlanar: true });
  await expect(page.locator("#modelSheetBar")).toBeHidden();
});
