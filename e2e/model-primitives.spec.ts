import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";
import { primitiveMesh, type PrimitiveSpec } from "../src/model-primitive";
import { plateClick } from "./plate-rows";

type V = [number, number, number];

/** What the engine builds from a primitive: its mesh where `origin` puts it, and its volume by formula. */
function primitiveSolid(spec: PrimitiveSpec): MockSolid | { error: string } {
  if (spec.primitive === "cone" && !(spec.height > 0)) return { error: "A cone needs a height above 0" };
  const mesh = primitiveMesh(spec);
  const positions = [...mesh].map((value, i) => value + spec.origin[i % 3]!);
  const r = spec.radius;
  const top = spec.topRadius ?? 0;
  const volumes: Partial<Record<PrimitiveSpec["primitive"], number>> = {
    box: spec.size[0] * spec.size[1] * spec.size[2],
    cylinder: Math.PI * r * r * spec.height,
    cone: (Math.PI * spec.height * (r * r + r * top + top * top)) / 3,
  };
  return { volumeMm3: Math.round(volumes[spec.primitive] ?? 1000), positions, triangles: positions.filter((_, i) => i % 9 === 0).map(() => 0), faces: [{ id: 0, areaMm2: 0 }], edges: [] };
}

/** A box from `at`, as a STEP file reads. */
function boxSolid(size: V, at: V = [0, 0, 0]): MockSolid {
  return primitiveSolid({ primitive: "box", origin: at, size, radius: 0, height: 0, turn: [0, 0, 0] }) as MockSolid;
}

/** An edit takes 100 mm³ off whatever it is applied to. */
function built(request: Body, parent: MockSolid): Built {
  return { ...parent, volumeMm3: parent.volumeMm3 - 100 };
}

const STEP = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const objects = (page: Page) => page.locator("#objectList .obj");

/** The engine is mocked once for the page, so it outlives a reload as `serve` does. A STEP opens as a 20 × 20 × 10 box. */
async function start(page: Page, file = false): Promise<TreeMock> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid([20, 20, 10]).positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => (request.primitive ? primitiveSolid(request.primitive as PrimitiveSpec) : boxSolid([20, 20, 10])),
    apply: built,
  });
  await page.goto("/");
  await autoSliceOff(page);
  if (file) {
    await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: STEP });
    await expect(objects(page)).toHaveCount(1);
  }
  await page.locator("#tabModel").click();
  if (file) await expect(readout(page)).toContainText("Volume 4000 mm³");
  return tree;
}

/** New solid with `kind` picked and `fields` typed, then Create. */
async function create(page: Page, kind: PrimitiveSpec["primitive"], fields: Record<string, number>) {
  await page.locator("#modelToolNew").click();
  await page.locator(`#modelPrim [data-kind="${kind}"]`).click();
  for (const [id, value] of Object.entries(fields)) await page.locator(`#${id}`).fill(String(value));
  await expect(page.locator("#modelApply")).toHaveText("Create");
  await page.locator("#modelApply").click();
}

test("on an empty plate, New solid makes a 20 mm box: listed, measured, and the root of its own history", async ({ page }) => {
  const tree = await start(page);
  const empty = page.locator("#modelEmpty");
  await expect(empty, "the empty view offers New solid plainly").toBeVisible();
  await expect(empty.getByRole("button", { name: "New solid" })).toBeVisible();
  await empty.getByRole("button", { name: "New solid" }).click();
  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(empty, "the panel takes its place").toBeHidden();
  for (const id of ["modelDx", "modelDy", "modelDz"]) await page.locator(`#${id}`).fill("20");
  await expect(page.locator("#model"), "the ghost stands at the origin, on Z 0").toHaveAttribute("data-ghost", "0.00 0.00 10.00 20.00 20.00 20.00");
  await page.locator("#modelDz").press("Tab");
  await page.waitForTimeout(400);
  await page.locator("#modelApply").click();

  await expect(readout(page)).toHaveText("Box 1. Volume 8000 mm³. Pick a face or an edge.");
  await expect(objects(page)).toHaveCount(1);
  await expect(objects(page).first()).toContainText("Box 1");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Box 20×20×20");
  await expect(page.locator("#modelPanel"), "Create closes the panel").toBeHidden();
  expect(tree.calls.map((call) => call.call), "the ghost asked nothing; Create opened the primitive, and no file was read").toEqual(["open"]);
  const opened = tree.of("open");
  expect(opened[0]).toMatchObject({ primitive: { primitive: "box", origin: [-10, -10, 0], size: [20, 20, 20], turn: [0, 0, 0] } });
  expect(opened[0]!.dataB64).toBeUndefined();
  await expect(page.locator("#model"), "it stands at the origin of model space").toHaveAttribute("data-solid", "-10.00,-10.00,0.00,10.00,10.00,20.00");
});

test("a new cone takes a Hole like any solid: History has the cone and the hole", async ({ page }) => {
  const tree = await start(page);
  await create(page, "cone", { modelRadius: 10, modelTopR: 4, modelHeight: 30 });
  await expect(readout(page)).toContainText("Cone 1. Volume 4901 mm³");
  expect(tree.of("open").at(-1)!.primitive).toEqual({ primitive: "cone", origin: [0, 0, 0], size: [0, 0, 0], radius: 10, height: 30, turn: [0, 0, 0], topRadius: 4 });
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Hole. Volume 4801 mm³");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0)).toContainText("Cone ⌀20 to ⌀8 h 30");
});

test("a saved new solid reopens on its plate step from its saved solid, and keeps the primitive for its history", async ({ page }) => {
  const tree = await start(page);
  await create(page, "box", { modelDx: 20, modelDy: 20, modelDz: 20 });
  await expect(readout(page)).toContainText("Volume 8000 mm³");
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(rows(page)).toHaveCount(2);

  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = await readFile((await download.path())!);
  const doc = JSON.parse(saved.toString("utf8")) as { objects: { name: string; modelTree: { rootPrimitive?: unknown; rootStep?: unknown; nodes: unknown[] } }[] };
  expect(doc.objects[0]!.name).toBe("Box 1");
  expect(doc.objects[0]!.modelTree.rootPrimitive, "the file keeps the primitive's numbers").toEqual({ primitive: "box", origin: [-10, -10, 0], size: [20, 20, 20], radius: 0, height: 0, turn: [0, 0, 0] });
  expect(doc.objects[0]!.modelTree.rootStep, "and no root STEP").toBeUndefined();
  expect(doc.objects[0]!.modelTree.nodes).toHaveLength(2);

  await page.reload();
  const before = tree.calls.length;
  await page.locator("#projectFile").setInputFiles({ name: "plate.lime", mimeType: "application/json", buffer: saved });
  await expect(objects(page)).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 7900 mm³");
  await expect(rows(page)).toHaveCount(2);
  const reopened = tree.calls.slice(before).filter((call) => call.call === "open");
  // The plate's step opens from its own saved solid, one read, rather than rebuilding every step from the primitive.
  expect(reopened, "one open").toHaveLength(1);
  expect(reopened[0]!.primitive, "of the whole history, from its primitive").toBeTruthy();
  expect(reopened[0]!.nodes, "with its step").toHaveLength(1);
  expect(reopened[0]!.seed, "and the plate's step from its saved solid").toEqual({ node: 1, dataB64: (doc.objects[0] as { brep?: { bytesBase64?: string } }).brep?.bytesBase64 });
});

test("New solid beside an open solid lands past it in model space, and the old one turns grey", async ({ page }) => {
  await start(page, true);
  await expect(page.locator("#model")).toHaveAttribute("data-solid", "0.00,0.00,0.00,20.00,20.00,10.00");
  const first = await objects(page).first().getAttribute("data-id");
  await page.locator("#modelToolNew").click();
  await expect(page.locator("#modelNote")).toHaveText("Lands beside the other objects, as a new object.");
  await page.locator("#modelPrim [data-kind=box]").click();
  for (const id of ["modelDx", "modelDy", "modelDz"]) await page.locator(`#${id}`).fill("10");
  await expect(page.locator("#model"), "the ghost already stands there").toHaveAttribute("data-ghost", "35.00 10.00 5.00 10.00 10.00 10.00");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Box 1. Volume 1000 mm³");
  await expect(objects(page)).toHaveCount(2);
  await expect(page.locator("#model"), "10 mm past the other, centred on it, on its floor").toHaveAttribute("data-solid", "30.00,5.00,0.00,40.00,15.00,10.00");
  await expect(page.locator("#model")).toHaveAttribute("data-context-count", "1");
  await expect(page.locator("#model")).toHaveAttribute("data-context", `${first ?? "part"}:0.00,0.00,0.00,20.00,20.00,10.00`);
});

test("Prepare undo takes a new solid back off the plate, and redo puts it back", async ({ page }) => {
  await start(page, true);
  await create(page, "cylinder", { modelRadius: 5, modelHeight: 10 });
  await expect(readout(page)).toContainText("Cylinder 1.");
  await expect(objects(page)).toHaveCount(2);
  await page.locator("#tabPrepare").click();
  await page.keyboard.press("Control+z");
  await expect(objects(page)).toHaveCount(1);
  await expect(objects(page).first()).not.toContainText("Cylinder 1");
  await page.keyboard.press("Control+Shift+z");
  await expect(objects(page)).toHaveCount(2);
});

test("Prepare undo of a new solid on an empty plate empties the plate again", async ({ page }) => {
  await start(page);
  await create(page, "box", { modelDx: 10, modelDy: 10, modelDz: 10 });
  await expect(readout(page)).toContainText("Box 1.");
  await page.locator("#tabPrepare").click();
  await expect(objects(page)).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(objects(page)).toHaveCount(0);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelEmpty")).toBeVisible();
  await page.locator("#tabPrepare").click();
  await page.keyboard.press("Control+Shift+z");
  await expect(objects(page), "redo puts it back").toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 1000 mm³");
  await expect(page.locator("#modelEmpty")).toBeHidden();
});

test("with an STL selected, the view says it is a mesh and Shift+N starts a new solid beside it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: (request) => primitiveSolid(request.primitive as PrimitiveSpec), apply: built });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.locator('[data-sample="calibration_cube_20mm.stl"]').click();
  await expect(objects(page)).toHaveCount(1);
  await page.locator("#tabModel").click();
  const empty = page.locator("#modelEmpty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("This object is a mesh");
  await expect(empty.getByRole("button", { name: "Add a file" })).toBeVisible();
  await expect(page.locator("#model"), "the mesh is drawn grey").toHaveAttribute("data-context-count", "1");
  await page.locator("#model").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("Shift+N");
  await expect(page.locator("#modelToolNew")).toHaveAttribute("aria-pressed", "true");
  await expect(empty).toBeHidden();
  await expect(page.locator("#modelNote")).toHaveText("Lands beside the other objects, as a new object.");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Box 1.");
  await expect(objects(page)).toHaveCount(2);
  expect(tree.of("open")).toHaveLength(1);
  const solid = ((await page.locator("#model").getAttribute("data-solid")) ?? "").split(",").map(Number);
  const cube = ((await page.locator("#model").getAttribute("data-context")) ?? "").split(":")[1]!.split(",").map(Number);
  expect(solid[0], "10 mm past the cube along X").toBeCloseTo(cube[3]! + 10, 1);
});

test("a copy of a new solid that has no step yet starts from the same primitive, with no STEP written or read", async ({ page }) => {
  const tree = await start(page);
  await create(page, "tube", { modelRadius: 10, modelInnerR: 6, modelHeight: 5 });
  await expect(readout(page)).toContainText("Tube 1.");
  await plateClick(page, "duplicate");
  await expect(objects(page)).toHaveCount(2);
  await expect.poll(() => tree.of("open").length, { message: "the copy is a tree of its own" }).toBe(2);
  const [first, copy] = tree.of("open");
  expect(copy!.primitive, "rooted in the same primitive").toEqual(first!.primitive);
  expect(copy!.key).not.toBe(first!.key);
  expect(tree.of("export"), "no STEP is written for it").toHaveLength(0);
  await expect(rows(page).first()).toContainText("Tube ⌀20 inside ⌀12 h 5");
});

test("the Boolean tool sends a torus's ring and tube", async ({ page }) => {
  const tree = await start(page, true);
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelPrim [data-kind=torus]").click();
  await expect(page.locator("#modelRadiusLabel")).toHaveText("Ring radius");
  await page.locator("#modelRadius").fill("8");
  await page.locator("#modelTube").fill("2");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(rows(page)).toHaveCount(2);
  const op = tree.of("apply").at(-1)!.op as Body;
  expect(op).toMatchObject({ kind: "boolean", op: "fuse", primitive: "torus", radius: 8, tubeRadius: 2 });
  expect(op.topRadius, "a torus sends no other primitive's fields").toBeUndefined();
  await expect(rows(page).nth(1)).toContainText("Fuse torus ⌀16 tube ⌀4");
});

test("a size the engine refuses shows in the readout, and nothing is added", async ({ page }) => {
  await start(page, true);
  await create(page, "cone", { modelHeight: 0 });
  await expect(readout(page)).toHaveText("A cone needs a height above 0");
  await expect(objects(page)).toHaveCount(1);
  await expect(page.locator("#modelPanel"), "the panel stays open to fix the number").toBeVisible();
});
