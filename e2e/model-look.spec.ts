import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

/** A box the modeler reports as a solid, in its own CAD frame. */
function boxSolid(size: V): MockSolid {
  const [sx, sy, sz] = size;
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
  quads.forEach((quad, face) => {
    for (const tri of [
      [0, 1, 2],
      [0, 2, 3],
    ]) {
      for (const index of tri) positions.push(...quad[index]!);
      triangles.push(face);
    }
  });
  return {
    volumeMm3: sx * sy * sz,
    positions,
    triangles,
    faces: quads.map((_, id) => ({ id, areaMm2: 0 })),
    edges: [],
    stepFaces: [0, 0, 0, 0, 0, 0],
  };
}

/** The box, plus one triangle the fuse made, so two steps own faces. */
function fused(root: MockSolid): MockSolid {
  return {
    volumeMm3: root.volumeMm3 + 1,
    positions: [...root.positions, 2, 2, 10, 4, 2, 10, 3, 4, 10],
    triangles: [...root.triangles, 6],
    faces: [...root.faces, { id: 6, areaMm2: 1 }],
    edges: [],
    stepFaces: [0, 0, 0, 0, 0, 0, 1],
  };
}

const root = boxSolid([20, 20, 10]);

async function openModel(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, { open: () => root, apply: () => fused(root) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
}

test("colour by step shows two colours, and a section offset is typed or dragged", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelToolBoolean").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4001 mm³");

  await page.locator("#modelLookOpen").click();
  await page.locator("#modelColourSteps").check();
  const swatches = page.locator(".mh-swatch");
  await expect(swatches).toHaveCount(2);
  const colours = await swatches.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
  expect(colours[0]).not.toBe(colours[1]);
  const painted = await page.locator("#model").getAttribute("data-face-colors");
  expect(painted?.split(" ").filter(Boolean)).toHaveLength(2);

  await page.locator("#modelHistoryTree [role=treeitem]").nth(1).hover();
  await expect(page.locator("#model")).toHaveAttribute("data-highlight", "1");

  await page.locator("#modelSection").check();
  await page.locator("#modelSectionOffset").fill("3");
  await expect(page.locator("#model")).toHaveAttribute("data-section", "10.00 10.00 8.00 0.00 0.00 1.00");

  await expect(page.locator("#model")).toHaveAttribute("data-section-handle", /^\d+ \d+$/);
  const handle = await page.locator("#model").getAttribute("data-section-handle");
  const box = await page.locator("#model").boundingBox();
  expect(box).toBeTruthy();
  const [x, y] = handle!.split(" ").map(Number);
  await page.mouse.move(box!.x + x!, box!.y + y!);
  await page.mouse.down();
  await page.mouse.move(box!.x + x! + 30, box!.y + y! + 20);
  await page.mouse.up();
  await expect(page.locator("#model")).not.toHaveAttribute("data-section", "10.00 10.00 8.00 0.00 0.00 1.00");
});

test("a section face is taken only right after Face, and another object starts the View menu over", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelLookOpen").click();
  await page.locator("#modelSection").check();
  await page.locator("#modelSectionAxis [data-axis=face]").click();
  await expect(page.locator("#modelSectionNote")).toHaveText("Pick a flat face.");
  const [x, y, w, h] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.click(box.x + x! + w! * 0.5, box.y + y! + h! * 0.5);
  const plane = await page.locator("#model").getAttribute("data-section");
  expect(plane, "the picked face is the plane").toBeTruthy();
  await expect(page.locator("#modelSectionNote")).toBeHidden();

  // A later face pick is for another tool: the plane stays.
  await page.mouse.click(box.x + x! + w! * 0.15, box.y + y! + h! * 0.85);
  await expect(page.locator("#model")).toHaveAttribute("data-section", plane!);

  await page.locator("#modelLookOpen").click();
  await page.locator("#modelColourSteps").check();
  await page.locator("#tabPrepare").click();
  await page.locator("#plateAddFile").setInputFiles({ name: "other.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await page.locator("[data-plate-select]").nth(1).click();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await expect(page.locator("#modelSection"), "section is off on another object").not.toBeChecked();
  await expect(page.locator("#modelColourSteps")).not.toBeChecked();
  await expect(page.locator("#model")).not.toHaveAttribute("data-section", /./);
  await expect(page.locator("#modelSectionAxis [data-axis=z]")).toHaveAttribute("aria-pressed", "true");
});
