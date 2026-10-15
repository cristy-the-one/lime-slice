import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";
import { MISMATCHED, encodeSolid } from "../src/model-reply";

type V = [number, number, number];

/** A box the modeler reports as a solid, in its own CAD frame, from `z0` up. */
function boxSolid(size: V, z0 = 0): MockSolid {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [x * sx, y * sy, z0 + z * sz];
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

const ROOT = boxSolid([20, 20, 10]);

/** A box cut leaves a 20 × 20 slab as tall as the box's Size X, so each Apply's volume names its numbers. */
function built(request: Body): Built {
  const op = request.op as { kind: string; size?: number[]; origin?: number[] };
  if (op.kind === "split") {
    const z = op.origin![2]!;
    return { kept: boxSolid([20, 20, z]), other: boxSolid([20, 20, 10 - z], z) };
  }
  return boxSolid([20, 20, op.size![0]!]);
}

async function openModel(page: Page, solid = ROOT, goto?: (request: Body) => Body | null): Promise<TreeMock> {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: () => solid, apply: built, goto });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText(solid.solid === false ? "Surfaces only" : "Volume");
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");

/** Cut with the box tool at Size X `dx`, and wait for the new volume. */
async function cut(page: Page, dx: number) {
  if ((await page.locator("#modelToolBoolean").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolBoolean").click();
  await page.locator("#modelDx").fill(String(dx));
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText(`Volume ${400 * dx} mm³`);
}

async function undo(page: Page, volume: number) {
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText(`Volume ${volume} mm³. Edit undone.`);
}

async function redo(page: Page, volume: number) {
  await page.locator("#modelRedo").click();
  await expect(readout(page)).toContainText(`Volume ${volume} mm³. Edit redone.`);
}

test("Apply, Undo, and Apply again keep both branches, and Redo follows the newest", async ({ page }) => {
  const tree = await openModel(page);
  await cut(page, 5);
  await undo(page, 4000);
  await cut(page, 3);
  const applies = tree.of("apply").map((request) => [request.parent, request.node]);
  expect(applies, "the second Apply branches from the root with a node of its own").toEqual([[0, 1], [0, 2]]);
  expect(tree.of("drop"), "the first branch is kept").toHaveLength(0);

  await undo(page, 4000);
  await redo(page, 1200);
  await expect(page.locator("#modelRedo")).toBeDisabled();

  await undo(page, 4000);
  await cut(page, 5);
  expect(tree.of("apply"), "the first branch is still there: its numbers jump to it, with nothing built").toHaveLength(2);
  await undo(page, 4000);
  await redo(page, 2000);
});

test("jumping back and forward shows each step's own volume, from memory or from the engine", async ({ page }) => {
  const tree = await openModel(page);
  const volumes = [4000];
  for (const dx of [9, 8, 7, 6, 5]) {
    await cut(page, dx);
    volumes.push(400 * dx);
  }
  for (let at = volumes.length - 2; at >= 0; at -= 1) await undo(page, volumes[at]!);
  await expect(page.locator("#modelUndo"), "the root has nothing to undo").toBeDisabled();
  expect(tree.of("goto").map((request) => request.node), "the four latest steps are drawn from memory; older ones ask the engine").toEqual([1, 0]);

  await redo(page, volumes[1]!);
  await redo(page, volumes[2]!);
  expect(tree.of("goto")).toHaveLength(2);
  await page.keyboard.press("Control+z");
  await expect(readout(page)).toContainText(`Volume ${volumes[1]} mm³. Edit undone.`);
  await page.keyboard.press("Control+y");
  await expect(readout(page)).toContainText(`Volume ${volumes[2]} mm³. Edit redone.`);
});

test("Undo at the root does not reach into Prepare's history", async ({ page }) => {
  await openModel(page);
  await page.locator("#tabPrepare").click();
  await page.locator("#placeX").fill("60");
  await page.locator("#placeX").press("Tab");
  const moved = await page.locator("#placeX").inputValue();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  await expect(page.locator("#modelUndo")).toBeDisabled();
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#placeX"), "the move made before Model stays").toHaveValue(moved);
});

test("a jump above a split keeps the piece on the plate, and the piece is still edited as its own tree", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelPlane").fill("4");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Split. Volume 1600 mm³");
  await expect(page.locator("#objectList .obj"), "the piece is on the plate at once").toHaveCount(2);

  await undo(page, 4000);
  await expect(page.locator("#objectList .obj"), "Undo above the split keeps the piece").toHaveCount(2);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await page.locator("#tabModel").click();

  await page.locator("[data-plate-select]").nth(1).click();
  await expect(readout(page)).toContainText("Volume 2400 mm³");
  expect(tree.of("open"), "the piece needs no STEP read").toHaveLength(1);
  await cut(page, 2);
  const split = tree.of("apply")[0]!;
  expect(tree.of("apply")[1]!.key, "the piece's edit goes to the piece's tree").toBe(split.otherKey);
});

test("Prepare undo after a Model visit puts the mesh and the paint back, and Model resumes on that step", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#tabPrepare").click();
  await page.locator('[data-tool="seam"]').click();
  const canvas = page.locator("#prepare");
  const box = (await canvas.boundingBox())!;
  let hit = "";
  for (let row = 8; row < 24 && !hit; row++) {
    for (let col = 8; col < 32 && !hit; col++) {
      await page.mouse.move(box.x + (box.width * col) / 40, box.y + (box.height * row) / 32);
      hit = (await canvas.getAttribute("data-brush-hit")) ?? "";
      if (hit) await page.mouse.down();
    }
  }
  await page.mouse.up();
  expect(hit, "the brush meets the part").not.toBe("");
  await expect(canvas).toHaveAttribute("data-seam-disks", /^[1-9]/);
  const painted = await canvas.getAttribute("data-seam-disks");
  await page.locator('[data-tool="seam"]').click();

  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  await cut(page, 5);
  await expect(readout(page)).toContainText("Leaving Model clears this part's support paint.");
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj").first(), "leaving Model gives the plate the cut part").toContainText("20 × 20 × 5");
  await expect(canvas).toHaveAttribute("data-seam-disks", "0");

  await page.keyboard.press("Control+z");
  await expect(page.locator("#objectList .obj").first(), "one Prepare undo takes back the whole visit").toContainText("20 × 20 × 10");
  await expect(canvas).toHaveAttribute("data-seam-disks", painted!);

  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  expect(tree.of("open"), "Model finds the step in its tree, with no STEP read").toHaveLength(1);
  await redo(page, 2000);
  expect(tree.of("apply"), "and the cut is still there to redo").toHaveLength(1);
});

test("a STEP of surfaces with no solid shows no volume and offers only Measure", async ({ page }) => {
  await openModel(page, { ...boxSolid([20, 20, 10]), volumeMm3: 1234.56, solid: false });
  await expect(readout(page)).toHaveText("Surfaces only. This file can be measured but not edited. Pick a face or an edge.");
  await expect(page.locator("#modelToolBoolean")).toBeDisabled();
  await expect(page.locator("#modelToolBoolean")).toHaveAttribute("data-tip", "This STEP file has surfaces but no closed solid, so it can be measured but not edited.");
  await expect(page.locator("#modelToolMeasure")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(readout(page)).not.toContainText("Volume");
});

test("an engine that forgot the tree gets the root and the steps again, and the edit goes through", async ({ page }) => {
  const tree = await openModel(page);
  await cut(page, 5);
  tree.forget();
  await cut(page, 3);
  expect(tree.of("open"), "one reopen").toHaveLength(2);
  const reopen = tree.of("open")[1]!;
  expect(reopen.dataB64, "the root goes again").toBe(tree.of("open")[0]!.dataB64);
  expect((reopen.nodes as { id: number; parent: number }[]).map((node) => [node.id, node.parent]), "with the step it has").toEqual([[1, 0]]);
  expect(tree.of("apply").at(-1), "the new step builds on the step it had").toMatchObject({ parent: 1, node: 2 });
});

test("a step that no longer rebuilds is marked, says so in plain words, and is not asked for again", async ({ page }) => {
  const why = "This step rebuilt differently: 1 mm³, 6 faces, 12 edges instead of 3600 mm³, 6 faces, 12 edges";
  const tree = await openModel(page, ROOT, (request) => (request.node === 1 ? { error: why, broken: 1 } : null));
  for (const dx of [9, 8, 7, 6, 5]) await cut(page, dx);
  for (const volume of [2400, 2800, 3200]) await undo(page, volume);
  await page.locator("#modelUndo").click();
  const plain = "This step could not be rebuilt, so it and the steps after it are unavailable.";
  await expect(readout(page)).toHaveText(plain);
  expect(tree.of("goto")).toHaveLength(1);
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toHaveText(plain);
  expect(tree.of("goto"), "the marked step is not asked for again").toHaveLength(1);
});

test("a split taken back by Prepare undo comes back with its piece when Model returns to it", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelPlane").fill("4");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Split. Volume 1600 mm³");
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect(page.locator("#objectList .obj"), "Prepare undo takes back the split and its piece").toHaveCount(1);

  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  await redo(page, 1600);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj"), "the plate takes the split with its piece").toHaveCount(2);
  await expect(page.locator("#objectList .obj").first(), "the part is the kept half").toContainText("20 × 20 × 4");
  await expect(page.locator("#objectList .obj").nth(1)).toContainText("20 × 20 × 6");
  expect(tree.of("apply"), "nothing was built again").toHaveLength(1);

  await page.locator("[data-plate-remove]").nth(1).click();
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 1600 mm³");
  await cut(page, 3);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj").first()).toContainText("20 × 20 × 3");
  await expect(page.locator("#objectList .obj"), "a piece removed by hand stays removed").toHaveCount(1);
});

test("Duplicate in Model opens the copy, and a Slice in Model slices the step on screen", async ({ page }) => {
  const slices: Body[] = [];
  await page.route("**/api/slice", (route) => {
    slices.push(route.request().postDataJSON() as Body);
    return route.fulfill({ status: 500, json: { error: "not sliced in this test" } });
  });
  const tree = await openModel(page);
  await cut(page, 5);
  await page.locator("#slice").click();
  await expect.poll(() => slices.length).toBe(1);
  expect(slices[0]!.filename, "the plate took the cut before slicing").toBe("plate.stl");

  await page.locator("#plateDuplicate").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await expect.poll(() => tree.of("open").length, { message: "the copy is a tree of its own" }).toBe(2);
  expect(tree.of("export").map((request) => request.node), "rooted in the STEP of the step it copies").toEqual([1]);
  expect(tree.of("open")[1]!.dataB64).toBe(Buffer.from("EDITED-STEP-1").toString("base64"));
  await expect(readout(page)).toContainText("Pick a face or an edge.");
  await cut(page, 3);
  expect(tree.of("apply").at(-1)!.key, "the edit goes to the copy's tree").toBe(tree.of("open")[1]!.key);
});

test("an engine that forgot a split piece gets it back from its parent's split", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelPlane").fill("4");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Split. Volume 1600 mm³");
  const split = tree.of("apply")[0]!;
  await page.locator("[data-plate-select]").nth(1).click();
  await expect(readout(page)).toContainText("Volume 2400 mm³");
  tree.forget();
  await cut(page, 2);
  const spare = tree.of("apply").find((request) => request.otherKey === split.otherKey && request.node !== split.node);
  expect(spare, "the split runs again on a spare node of the parent tree, for the piece's key").toBeTruthy();
  expect(tree.of("drop").map((request) => [request.key, request.node]), "and the spare node goes").toEqual([[split.key, spare!.node]]);
  expect(tree.of("apply").at(-1), "then the piece's edit goes through").toMatchObject({ key: split.otherKey, parent: 0 });
});

/** Answer every `call` request with `body(request)` instead of the mock's own answer. */
async function answerWith(page: Page, call: string, body: (request: Body) => Body) {
  await page.route("**/api/model/tree", async (route) => {
    const request = route.request().postDataJSON() as Body;
    if (request.call !== call) return route.fallback();
    await route.fulfill({ json: body(request) });
  });
}

const OLD_FORMAT = { volumeMm3: 1600, positions: [], triangles: [], faces: [], edges: [] };

test("a step the app cannot read is refused in plain words, and the engine drops it", async ({ page }) => {
  const tree = await openModel(page);
  await answerWith(page, "apply", (request) => ({ id: request.node, ...OLD_FORMAT }));
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelDx").fill("4");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toHaveText(MISMATCHED);
  await expect.poll(() => tree.of("drop").map((request) => request.node)).toEqual([1]);
  await expect(page.locator("#modelUndo"), "no step was added").toBeDisabled();
});

test("a split whose piece the app cannot read drops the step and closes the piece's tree", async ({ page }) => {
  const tree = await openModel(page);
  const kept = boxSolid([20, 20, 4]);
  const fingerprint = { volumeMm3: kept.volumeMm3, faces: 6, edges: 0 };
  await answerWith(page, "apply", (request) => ({
    id: request.node,
    ...encodeSolid(kept),
    fingerprint,
    op: request.op,
    other: { id: 0, key: request.otherKey, ...OLD_FORMAT },
  }));
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelPlane").fill("4");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toHaveText(MISMATCHED);
  await expect(page.locator("#objectList .obj"), "no piece joins the plate").toHaveCount(1);
  await expect.poll(() => tree.of("drop").map((request) => request.node)).toEqual([1]);
  const close = tree.of("close").map((request) => request.key);
  expect(close, "the piece's tree goes").toHaveLength(1);
  expect(close[0]).toMatch(/piece/);
});

test("a root the app cannot read is refused in plain words, and its tree is closed", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: ROOT.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: () => ROOT, apply: built });
  await answerWith(page, "open", () => ({ id: 0, ...OLD_FORMAT }));
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toHaveText(MISMATCHED);
  await expect.poll(() => tree.of("close").length, { message: "the engine lets go of the tree it opened" }).toBe(1);
});
