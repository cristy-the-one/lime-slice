import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";
import { primitiveMesh, type PrimitiveSpec } from "../src/model-primitive";

type V = [number, number, number];

/** What the engine builds from a primitive: its mesh where `origin` puts it, and a box's volume. */
function primitiveSolid(spec: PrimitiveSpec): MockSolid {
  const mesh = primitiveMesh(spec);
  const positions = [...mesh].map((value, i) => value + spec.origin[i % 3]!);
  return { volumeMm3: spec.size[0] * spec.size[1] * spec.size[2], positions, triangles: positions.filter((_, i) => i % 9 === 0).map(() => 0), faces: [{ id: 0, areaMm2: 0 }], edges: [] };
}

function boxSolid(size: V, at: V = [0, 0, 0]): MockSolid {
  return primitiveSolid({ primitive: "box", origin: at, size, radius: 0, height: 0, turn: [0, 0, 0] });
}

/** A join adds 500 mm³, cuts 500, or keeps 300; any other edit takes 100 off. */
function built(request: Body, parent: MockSolid): Built {
  const op = request.op as { kind: string; op?: "fuse" | "cut" | "common" };
  if (op.kind === "split") return { kept: { ...boxSolid([20, 20, 5]), volumeMm3: 2000 }, other: { ...boxSolid([20, 20, 5], [0, 0, 5]), volumeMm3: 2000 } };
  if (op.kind === "join") return { ...parent, volumeMm3: op.op === "fuse" ? parent.volumeMm3 + 500 : op.op === "cut" ? parent.volumeMm3 - 500 : 300 };
  return { ...parent, volumeMm3: parent.volumeMm3 - 100 };
}

/** A binary STL of a 10 mm box: a mesh, which Model does not edit. */
function boxStl(): Buffer {
  const { positions } = boxSolid([10, 10, 10]);
  const count = positions.length / 9;
  const out = Buffer.alloc(84 + count * 50);
  out.writeUInt32LE(count, 80);
  for (let t = 0; t < count; t += 1) {
    for (let i = 0; i < 9; i += 1) out.writeFloatLE(positions[t * 9 + i]!, 84 + t * 50 + 12 + i * 4);
  }
  return out;
}

const STEP = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const objects = (page: Page) => page.locator("#objectList .obj");
const choices = (page: Page) => page.locator("#modelObjects [data-object]");
const canvas = (page: Page) => page.locator("#model");

/** `plate.step`, a 20 × 20 × 10 box at its file's origin, opened in Model; `skin.step` opens as surfaces only. */
async function start(page: Page): Promise<TreeMock> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid([20, 20, 10]).positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => {
      if (request.primitive) return primitiveSolid(request.primitive as PrimitiveSpec);
      return String(request.filename).startsWith("skin") ? { ...boxSolid([20, 20, 10]), solid: false } : boxSolid([20, 20, 10]);
    },
    apply: built,
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: STEP });
  await expect(objects(page)).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  return tree;
}

/** A 10 mm New solid box, beside plate.step, open in Model. */
async function newBox(page: Page) {
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="box"]').click();
  for (const id of ["modelDx", "modelDy", "modelDz"]) await page.locator(`#${id}`).fill("10");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Box 1. Volume 1000 mm³");
  // Leaving Model ends the visit, so the next one's Prepare step is the join's alone.
  await page.locator("#tabPrepare").click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 1000 mm³");
}

/** Boolean on an object, from closed or already open. */
async function openJoin(page: Page) {
  if ((await page.locator("#modelToolBoolean").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolBoolean").click();
  await page.locator("#modelWithObject").click();
  await expect(page.locator("#modelObjects")).toBeVisible();
}

test("Boolean on an object: the other solid is picked by a click in the view, drawn as the ghost, and the readout says what happens", async ({ page }) => {
  const tree = await start(page);
  await newBox(page);
  await page.keyboard.press("Shift+G");
  await expect(page.locator("#modelWithObject"), "Shift+G opens Boolean on an object: Object, last in the primitive row").toHaveAttribute("aria-checked", "true");
  await expect(page.locator(`#modelPrim [aria-checked="true"]`), "and only Object is checked there").toHaveCount(1);
  await expect(page.locator("#modelDx"), "the primitive's fields give way").toBeHidden();
  await expect(page.locator("#modelX")).toBeHidden();
  await expect(choices(page), "the list offers the other solid, never the open one").toHaveText(["plate.step"]);
  await expect(page.locator("#modelNote")).toHaveText("Pick the tool: click a grey object, or one in the list.");
  await expect(page.locator("#modelApply")).toBeDisabled();
  await expect(canvas(page)).toHaveAttribute("data-context-count", "1");

  await page.locator("#modelResetView").click({ modifiers: ["Shift"] });
  await page.waitForTimeout(300);
  const [gx, gy, gw, gh] = ((await canvas(page).getAttribute("data-context-screen")) ?? "").split(",").map(Number);
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + gx! + gw! / 2, box.y + gy! + gh! / 2);
  await expect(choices(page).first(), "a click on the grey object picks it").toHaveAttribute("aria-checked", "true");
  await expect(canvas(page), "it is the ghost now, where it sits in model space, not grey").toHaveAttribute("data-ghost", "10.00 10.00 5.00 20.00 20.00 10.00");
  await expect(canvas(page)).toHaveAttribute("data-context-count", "0");
  await expect(readout(page)).toHaveText("Fuse plate.step into Box 1; plate.step leaves the plate.");
  await expect(page.locator("#modelNote")).toHaveText("This boolean changes the solid.");
  await expect(page.locator("#modelApply")).toBeEnabled();
  const probe = tree.of("probe").at(-1)!;
  const box1 = (await canvas(page).getAttribute("data-solid"))!.split(",").map(Number);
  expect(probe.op, "the probe names the tool's tree and step").toMatchObject({ kind: "join", op: "fuse", tool: { node: 0, name: "plate.step" }, keepTool: false });
  const relative = (probe.op as { relative: { m: number[]; t: number[] } }).relative;
  expect(relative.m, "and its pose in Box 1's own frame: unturned, and as far as Box 1 was moved").toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  expect(relative.t.map((value) => Math.round(value * 100) / 100 + 0)).toEqual([-(box1[0]! + 5), -(box1[1]! + 5), 0]);

  await page.locator("#modelCut").click();
  await expect(readout(page)).toHaveText("Cut plate.step from Box 1; plate.step leaves the plate.");
  await expect(page.locator("#modelNote")).toHaveText("This boolean changes the solid.");
  await page.locator("#modelKeepTool").check();
  await expect(readout(page)).toHaveText("Cut plate.step from Box 1; plate.step stays on the plate.");
  const asked = tree.of("probe").length;
  await page.waitForTimeout(400);
  expect(tree.of("probe").length, "Keep changes no solid, so it asks the engine nothing").toBe(asked);

  await page.locator(`#modelPrim [data-kind="box"]`).click();
  await expect(canvas(page), "back to a primitive, the object is grey again").toHaveAttribute("data-context-count", "1");
  await expect(page.locator("#modelDx")).toBeVisible();
});

/** Each grey object's model-space box, by id, from the canvas. */
async function greyBoxes(page: Page): Promise<Record<string, string>> {
  const raw = (await canvas(page).getAttribute("data-context")) ?? "";
  return Object.fromEntries(raw.split(" ").filter(Boolean).map((entry) => entry.split(":") as [string, string]));
}

test("Keep off: Apply takes the tool off the plate in the same Prepare step, and Prepare undo puts it back", async ({ page }) => {
  const tree = await start(page);
  await newBox(page);
  const before = await greyBoxes(page);
  await openJoin(page);
  await choices(page).first().click();
  await expect(choices(page).first(), "a pick from the list").toHaveAttribute("aria-checked", "true");
  await page.locator("#modelCut").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toHaveText("Cut plate.step. Volume 500 mm³. plate.step left the plate.");
  await expect(objects(page)).toHaveCount(1);
  // The box's root, the tool's own step on its lane, and the join it merges into.
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(1), "the tool's step comes in on a lane of its own").toHaveAttribute("data-row", "1/0");
  await expect(rows(page).nth(2)).toContainText("Cut plate.step");
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await expect(choices(page), "the tool has left the list too").toHaveCount(0);
  expect(tree.of("apply").at(-1)!.op).toMatchObject({ kind: "join", op: "cut", keepTool: false, tool: { name: "plate.step" } });

  await page.locator("#tabPrepare").click();
  await page.keyboard.press("Control+z");
  await expect(objects(page), "Prepare undo brings the tool back with the edit").toHaveCount(2);
  await expect(objects(page)).toContainText(["plate.step", "Box 1"]);
  await page.locator("#tabModel").click();
  await expect(readout(page), "and the box is as it was").toContainText("Volume 1000 mm³");
  await expect(rows(page), "its history keeps the join, and its tool's lane").toHaveCount(3);
  expect(await greyBoxes(page), "the tool is back where it sat in model space").toEqual(before);

  // The same join applied again shows the step it built, and takes the tool off again.
  await openJoin(page);
  await choices(page).first().click();
  await page.locator("#modelCut").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  const applies = tree.of("apply").length;
  await page.locator("#modelApply").click();
  await expect(readout(page)).toHaveText("Cut plate.step. Volume 500 mm³. plate.step left the plate.");
  await expect(objects(page)).toHaveCount(1);
  expect(tree.of("apply").length, "nothing was built again").toBe(applies);
});

test("a tool Model never opened gets its tree when picked, and a tool whose history uses the open solid is refused", async ({ page }) => {
  const tree = await start(page);
  await newBox(page);
  await page.locator("#tabPrepare").click();
  await page.locator("#plateAddFile").setInputFiles({ name: "rod.step", mimeType: "model/step", buffer: STEP });
  await expect(objects(page)).toHaveCount(3);
  await page.locator("[data-plate-select]").nth(1).click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 1000 mm³");
  await openJoin(page);
  await expect(choices(page)).toHaveText(["plate.step", /^rod\.step/]);
  const opens = tree.of("open").length;
  await choices(page).nth(1).click();
  await expect(page.locator("#modelNote")).toHaveText("This boolean changes the solid.");
  expect(tree.of("open").slice(opens).map((call) => call.filename), "the rod's tree opened from its file, for the join").toEqual(["rod.step"]);
  expect(tree.of("open").at(-1)!.nodes, "its root alone").toBeUndefined();

  await page.locator("#modelKeepTool").check();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toHaveText(/^Fuse rod\.step( \d+)?\. Volume 1500 mm³\.$/);
  await expect(page.locator("#modelKeepTool"), "Keep goes back off after the join").not.toBeChecked();

  await page.locator("#tabPrepare").click();
  await page.locator("[data-plate-select]").nth(2).click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  await openJoin(page);
  await choices(page).filter({ hasText: "Box 1" }).click();
  await expect(page.locator("#modelNote")).toHaveText("The tool object's history already uses this part, so the two cannot be joined.");
  await expect(page.locator("#modelApply")).toBeDisabled();
});

test("a split piece fused back into its part stays off the plate when Model closes", async ({ page }) => {
  await start(page);
  await page.locator("#modelToolSplit").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(objects(page)).toHaveCount(2);
  await openJoin(page);
  await expect(choices(page)).toHaveText(["plate split"]);
  await choices(page).first().click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toHaveText("Fuse plate split. Volume 2500 mm³. plate split left the plate.");
  await expect(objects(page)).toHaveCount(1);
  await page.locator("#tabPrepare").click();
  await expect(objects(page), "the plate takes the join, and the piece it crossed stays fused").toHaveCount(1);
});

test("Keep on: the tool stays on the plate", async ({ page }) => {
  await start(page);
  await newBox(page);
  await openJoin(page);
  await choices(page).first().click();
  await page.locator("#modelKeepTool").check();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toHaveText("Fuse plate.step. Volume 1500 mm³.");
  await expect(objects(page)).toHaveCount(2);
  await expect(choices(page), "it is still on offer").toHaveText(["plate.step"]);
});

test("a join saves its removed tool's tree, reopens, and takes an edit after the reopen", async ({ page }) => {
  const tree = await start(page);
  await newBox(page);
  await openJoin(page);
  await choices(page).first().click();
  await page.locator("#modelCut").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(objects(page)).toHaveCount(1);

  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = await readFile((await download.path())!);
  const doc = JSON.parse(saved.toString("utf8")) as {
    objects: { name: string; modelTree: { nodes: { op: Body | null }[] } }[];
    modelTools: { id: string; name: string; modelTree: { rootStep: { name: string } } }[];
  };
  expect(doc.objects.map((obj) => obj.name), "the plate is the box alone").toEqual(["Box 1"]);
  expect(doc.modelTools.map((tool) => [tool.name, tool.modelTree.rootStep.name]), "the tool's tree is kept for the join").toEqual([["plate.step", "plate.step"]]);
  const join = doc.objects[0]!.modelTree.nodes[1]!.op as { tool: Record<string, unknown> };
  expect(join.tool, "the join names it by object and step, not by key").toEqual({ object: doc.modelTools[0]!.id, node: 0, name: "plate.step" });

  await page.reload();
  const before = tree.calls.length;
  await page.locator("#projectFile").setInputFiles({ name: "plate.lime", mimeType: "application/json", buffer: saved });
  await expect(objects(page)).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 500 mm³");
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(2)).toContainText("Cut plate.step");
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Hole. Volume 400 mm³");
  const opened = tree.calls.slice(before).filter((call) => call.call === "open");
  expect(opened.some((call) => call.filename === "plate.step" && Array.isArray(call.nodes)), "the tool's tree opened again, whole, for the join to build").toBe(true);
});

test("the open object, a mesh, and surfaces are never offered as the tool", async ({ page }) => {
  await start(page);
  await page.locator("#tabPrepare").click();
  await page.locator("#plateAddFile").setInputFiles({ name: "cube.stl", mimeType: "model/stl", buffer: boxStl() });
  await expect(objects(page)).toHaveCount(2);
  await page.locator("#plateAddFile").setInputFiles({ name: "skin.step", mimeType: "model/step", buffer: STEP });
  await expect(objects(page)).toHaveCount(3);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("can be measured but not edited");
  await page.locator("#tabPrepare").click();
  await page.locator("[data-plate-select]").first().click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  await openJoin(page);
  await expect(choices(page)).toHaveCount(0);
  await expect(page.locator("#modelObjects")).toHaveText("No other solid on the plate.");
});
