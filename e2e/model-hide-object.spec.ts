import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

type V = [number, number, number];

function boxSolid(size: V, at: V) {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [at[0] + x * sx, at[1] + y * sy, at[2] + z * sz];
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

// An assembly in miniature: the small block sits wholly inside the big one, so from any side the big one is in front.
// The far block is the one open for editing.
const SOLIDS: Record<string, ReturnType<typeof boxSolid>> = {
  "big.step": boxSolid([40, 30, 20], [0, 0, 0]),
  "small.step": boxSolid([20, 20, 10], [10, 5, 0]),
  "far.step": boxSolid([10, 10, 10], [44, 10, 0]),
};

async function threeObjects(page: Page) {
  const named = (route: { request(): { postDataJSON(): { filename?: string } } }) => SOLIDS[route.request().postDataJSON().filename ?? ""]!;
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: named(route).positions } }));
  await mockModelTree(page, { open: (request) => SOLIDS[String(request.filename)]! });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  const step = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  await page.locator("#file").setInputFiles({ name: "big.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabPrepare").click();
  await page.locator("#plateAddFile").setInputFiles({ name: "small.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await page.locator("#plateAddFile").setInputFiles({ name: "far.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  if (!(await page.locator("#modelInspect").isVisible())) await page.locator("#timing").click();
  await expect(page.locator("#modelInspect [data-plate-select]")).toHaveCount(3);
}

const selectedRow = (page: Page) => page.locator("#modelInspect .obj-row[data-selected='true'] .obj-select b");
const eye = (page: Page, index: number) => page.locator("#modelInspect [data-plate-eye]").nth(index);

/** Ctrl-click, which opens the grey object under the pointer, at the middle of the grey objects on screen. */
async function ctrlClickGrey(page: Page) {
  // Frame everything (Shift-click on the reset-view button), then wait for the camera to settle.
  await page.evaluate(() => document.querySelector("#modelResetView")!.dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true })));
  let last = "";
  await expect.poll(async () => {
    const now = (await page.locator("#model").getAttribute("data-context-screen")) ?? "";
    const settled = now === last && now !== "";
    last = now;
    return settled;
  }).toBe(true);
  const [gx, gy, gw, gh] = last.split(",").map(Number);
  const box = (await page.locator("#model").boundingBox())!;
  await page.keyboard.down("Control");
  await page.mouse.click(box.x + gx! + gw! / 2, box.y + gy! + gh! / 2);
  await page.keyboard.up("Control");
}

test("hiding the front part makes a click in the 3D view reach the part behind, and Show all brings it back", async ({ page }) => {
  await threeObjects(page);
  const canvas = page.locator("#model");
  // Open the far block, so big and small are both grey.
  await page.locator("#modelInspect [data-plate-select]").nth(2).click();
  await expect(selectedRow(page)).toHaveText(/^far.step/);
  await expect(canvas).toHaveAttribute("data-context-count", "2");
  await expect(eye(page, 2)).toBeDisabled();
  await expect(page.locator("#modelInspectShowAll")).toBeHidden();

  // The front part is picked first.
  await ctrlClickGrey(page);
  await expect(selectedRow(page)).toHaveText(/^big.step/);
  await page.locator("#modelInspect [data-plate-select]").nth(2).click();
  await expect(selectedRow(page)).toHaveText(/^far.step/);

  // Hide it: it is gone from the view and the click lands on the one behind.
  await eye(page, 0).click();
  await expect(eye(page, 0)).toHaveAttribute("aria-pressed", "true");
  await expect(eye(page, 0)).toHaveAttribute("aria-label", "Show big.step");
  await expect(page.locator("#modelInspect .obj-row").nth(0)).toHaveAttribute("data-hidden", "true");
  await expect(canvas).toHaveAttribute("data-context-count", "1");
  await expect(page.locator("#modelInspectShowAll")).toBeVisible();
  await ctrlClickGrey(page);
  await expect(selectedRow(page)).toHaveText(/^small.step/);
  await page.screenshot({ path: "C:/Users/marius/AppData/Local/Temp/claude/3b29c894b02d8456/cb98bffa-53e1-40b2-8e01-f9c708602ca7/scratchpad/hide-object/hidden-dark.png" });

  // The row still works while hidden, and the plate was never touched.
  await expect(page.locator("#modelInspect [data-plate-select]")).toHaveCount(3);
  await page.locator("#modelInspect [data-plate-select]").nth(2).click();
  await expect(selectedRow(page)).toHaveText(/^far.step/);
  await page.locator("#modelInspectShowAll").click();
  await expect(canvas).toHaveAttribute("data-context-count", "2");
  await expect(eye(page, 0)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#modelInspectShowAll")).toBeHidden();
  await ctrlClickGrey(page);
  await expect(selectedRow(page)).toHaveText(/^big.step/);
});

test("Alt-click on the eye shows only that part; opening a hidden part shows it", async ({ page }) => {
  await threeObjects(page);
  const canvas = page.locator("#model");
  await page.locator("#modelInspect [data-plate-select]").nth(2).click();
  await expect(canvas).toHaveAttribute("data-context-count", "2");
  await eye(page, 1).click({ modifiers: ["Alt"] });
  await expect(canvas).toHaveAttribute("data-context-count", "1");
  await expect(canvas).toHaveAttribute("data-context", /^small\.step|^[^:]+:10\.00,5\.00,0\.00,30\.00,25\.00,10\.00$/);
  await expect(eye(page, 0)).toHaveAttribute("aria-pressed", "true");
  // Alt-click again: all shown.
  await eye(page, 1).click({ modifiers: ["Alt"] });
  await expect(canvas).toHaveAttribute("data-context-count", "2");
  // Hide big, then open it from its row: an open object is never hidden.
  await eye(page, 0).click();
  await expect(canvas).toHaveAttribute("data-context-count", "1");
  await page.locator("#modelInspect [data-plate-select]").nth(0).click();
  await expect(selectedRow(page)).toHaveText(/^big.step/);
  await expect(eye(page, 0)).toBeDisabled();
  await expect(page.locator("#modelInspectShowAll")).toBeHidden();
  await expect(canvas).toHaveAttribute("data-context-count", "2");
});
