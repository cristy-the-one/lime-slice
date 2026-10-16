import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";
import { primitiveMesh, type PrimitiveSpec } from "../src/model-primitive";

type V = [number, number, number];

function primitiveSolid(spec: PrimitiveSpec): MockSolid {
  const mesh = primitiveMesh(spec);
  const positions = [...mesh].map((value, i) => value + spec.origin[i % 3]!);
  return { volumeMm3: spec.size[0] * spec.size[1] * spec.size[2], positions, triangles: positions.filter((_, i) => i % 9 === 0).map(() => 0), faces: [{ id: 0, areaMm2: 0 }], edges: [] };
}

function boxSolid(size: V, at: V = [0, 0, 0]): MockSolid {
  return primitiveSolid({ primitive: "box", origin: at, size, radius: 0, height: 0, turn: [0, 0, 0] });
}

/**
 * A scale takes the factor cubed; a hole 100 mm³ per mm of radius, and is refused on a part smaller than that; a cut
 * takes a tenth of the tool's volume, a fuse adds it.
 */
function built(request: Body, parent: MockSolid, tool?: MockSolid): Built {
  const op = request.op as { kind: string; op?: string; factor?: number; radius?: number };
  const at = (volumeMm3: number) => ({ ...parent, volumeMm3: Math.round(volumeMm3 * 1000) / 1000 });
  if (op.kind === "scale") return at(parent.volumeMm3 * op.factor! ** 3);
  if (op.kind === "hole") return parent.volumeMm3 < 100 * op.radius! ? { error: "The hole is bigger than the part" } : at(parent.volumeMm3 - 100 * op.radius!);
  if (op.kind === "join") return at(parent.volumeMm3 + (op.op === "fuse" ? 1 : -1) * (tool?.volumeMm3 ?? 0) / 10);
  return at(parent.volumeMm3 - 100);
}

const STEP = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const row = (page: Page, key: string) => page.locator(`#modelHistoryTree [data-row="${key}"]`);
const objects = (page: Page) => page.locator("#objectList .obj");
const canvas = (page: Page) => page.locator("#model");
const head = (page: Page) => page.locator("#modelEditHead");

/**
 * `plate.step` (a 20 × 20 × 10 box) scaled to 50 %, then Box 1 (10 mm) cut by it, and a hole after the cut: Box 1's
 * history has the join at step 2, its tool's steps on a lane of their own.
 */
async function start(page: Page, preview = false): Promise<TreeMock> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid([20, 20, 10]).positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => (request.primitive ? primitiveSolid(request.primitive as PrimitiveSpec) : boxSolid([20, 20, 10])),
    apply: built,
    ...(preview ? { preview: (request: Body, on: MockSolid, tool?: MockSolid) => { const made = built(request, on, tool); return "volumeMm3" in made ? made : null; } } : {}),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: STEP });
  await expect(objects(page)).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  return tree;
}

async function joinScene(page: Page, preview = false): Promise<TreeMock> {
  const tree = await start(page, preview);
  await page.locator("#modelToolScale").click();
  await page.locator("#modelFactor").fill("0.5");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Volume 500 mm³");
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="box"]').click();
  for (const id of ["modelDx", "modelDy", "modelDz"]) await page.locator(`#${id}`).fill("10");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Box 1. Volume 1000 mm³");
  await page.keyboard.press("Shift+G");
  await page.locator("#modelObjects [data-object]").first().click();
  await page.locator("#modelCut").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Volume 950 mm³");
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Volume 750 mm³");
  return tree;
}

test("a join is a merge: its tool's steps come in on a lane of their own, and a click shows the tool as it was, read-only", async ({ page }) => {
  await joinScene(page);
  await expect(objects(page), "the tool left the plate").toHaveCount(1);
  await expect(rows(page)).toHaveCount(5);
  await expect(page.locator("#modelHistoryToggle"), "the header counts the tool's rows too").toHaveText("History · 5");
  expect(await rows(page).evaluateAll((els) => els.map((el) => [(el as HTMLElement).dataset.row, el.querySelector(".mh-label")?.textContent, el.getAttribute("aria-level")]))).toEqual([
    ["0", "Box 10×10×10", "1"],
    ["1/0", "plate.step", "2"],
    ["1/1", "Scale 50 %", "2"],
    ["1", "Cut plate.step", "1"],
    ["2", "Hole ⌀4 depth 12", "1"],
  ]);
  await expect(row(page, "1"), "the join owns its tool's rows").toHaveAttribute("aria-owns", "mhRow-1-0 mhRow-1-1");
  await expect(row(page, "1")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "1/1")).toHaveAttribute("aria-label", "plate.step: Scale 50 %");
  await expect(row(page, "1/1"), "the tool's steps are the shown step's history").toHaveAttribute("data-state", "past");

  const plateMesh = await canvas(page).getAttribute("data-plate-mesh");
  await row(page, "1/1").click();
  await expect(readout(page)).toHaveText("“Scale 50 %” of plate.step, as “Cut plate.step” takes it. Volume 500 mm³. Edit step changes it.");
  await expect(row(page, "1/1")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "2"), "the part's steps are not the shown step's history now").toHaveAttribute("data-state", "other");
  await expect(row(page, "0").locator(".mh-plate"), "the plate still holds the step it held").toBeVisible();
  await expect(page.locator("#modelToolHole"), "a tool's step is looked at, not worked on").toBeDisabled();
  await expect(page.locator("#modelToolHole")).toHaveAttribute("data-tip", /a step of a tool this part was joined with/);
  await expect(page.locator("#modelToolNew")).toBeEnabled();
  const grey = (await canvas(page).getAttribute("data-context")) ?? "";
  expect(grey.split(" ").length, "the part is grey behind the tool").toBe(1);
  expect(await canvas(page).getAttribute("data-plate-mesh"), "the plate did not move").toBe(plateMesh);
  await expect(objects(page)).toHaveCount(1);

  // Esc leaves History, as ever; once more, on the canvas, it goes back to the part.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(readout(page), "Esc goes back to the part").toHaveText("Volume 750 mm³.");
  await expect(row(page, "2")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#modelToolHole")).toBeEnabled();

  // Keys: Right on the join goes into its tool's lane, at the step it takes; Left comes back; Down walks every row.
  await row(page, "1").click();
  await expect(readout(page)).toContainText("Volume 950 mm³");
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "1/1")).toBeFocused();
  await expect(readout(page), "the arrow shows the step after the pause").toContainText("Volume 500 mm³");
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "1/0")).toBeFocused();
  await expect(readout(page)).toContainText("“plate.step” of plate.step");
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "1")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(readout(page)).toContainText("Volume 950 mm³");
});

test("a tool's step edited from the part's History: the tool forks, the join is built again on it, the part's later steps replay, and undo, save and reopen keep it", async ({ page }) => {
  const tree = await joinScene(page);
  await row(page, "1/1").click({ button: "right" });
  const item = page.getByRole("menuitem", { name: /Delete branch/ });
  await expect(item, "a tool's step is on the way to the step the join takes, so it stays").toHaveAttribute("aria-disabled", "true");
  await expect(item).toContainText("This step makes plate.step as “Cut plate.step” takes it. Delete the branch from that step instead.");
  await page.getByRole("menuitem", { name: /Edit step/ }).click();
  await expect(head(page)).toHaveText("Editing plate.step, step 1: Scale 50 %");
  await expect(page.locator("#modelFactor")).toHaveValue("0.5");
  await expect(readout(page), "the view shows the step before it, where the join put the tool").toContainText("Volume 4000 mm³");
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await expect(page.locator("#modelApply")).toBeDisabled();
  await page.locator("#modelFactor").fill("0.6");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toHaveText("Updated “Scale 60 %” of plate.step and rebuilt 2 steps after it. Volume 713.60 mm³.");
  await expect(page.locator("#modelPanel"), "Update ends the tool").toBeHidden();
  const sent = tree.of("edit").at(-1)!;
  expect(sent.tools, "one call: the tool's part first").toEqual([{ key: expect.any(String), parent: 0, node: 2, op: { kind: "scale", factor: 0.6 }, replay: [] }]);
  expect((sent.op as { tool: { node: number } }).tool.node, "the join names the tool's new step").toBe(2);
  expect(sent.replay, "and the hole replays").toEqual([{ id: 4, op: expect.objectContaining({ kind: "hole" }) }]);
  expect(await rows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.row))).toEqual(["0", "1/0", "1/1", "1", "2", "3/0", "3/2", "3", "4"]);
  await expect(row(page, "3/2")).toContainText("Scale 60 %");
  await expect(row(page, "1/1"), "the old branch stays, with its old tool step").toContainText("Scale 50 %");

  await page.locator("#modelUndo").click();
  await expect(readout(page), "Undo goes back to the step shown before the edit").toContainText("Volume 750 mm³");
  await page.locator("#modelRedo").click();
  await expect(readout(page)).toContainText("Volume 713.60 mm³");

  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = await readFile((await download.path())!);
  const doc = JSON.parse(saved.toString("utf8")) as { modelTools: { modelTree: { nodes: { id: number; parent: number | null; op: Body | null }[] } }[] };
  expect(doc.modelTools[0]!.modelTree.nodes.map((node) => [node.id, node.parent, (node.op as { factor?: number } | null)?.factor ?? null]), "the tool's tree is saved forked").toEqual([[0, null, null], [1, 0, 0.5], [2, 0, 0.6]]);
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "plate.lime", mimeType: "application/json", buffer: saved });
  await expect(objects(page)).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 713.60 mm³");
  await expect(row(page, "3/2")).toContainText("Scale 60 %");
  await row(page, "3/2").click();
  await expect(readout(page), "after a reopen the tool's step opens from its tree").toHaveText("“Scale 60 %” of plate.step, as “Cut plate.step” takes it. Volume 864 mm³. Edit step changes it.");
});

test("the same tool edit after the part's branch was deleted builds the join on the tool's branch from before, not a twin of it", async ({ page }) => {
  const tree = await joinScene(page);
  const edit = async (factor: string) => {
    await row(page, "1/1").click();
    await page.keyboard.press("Shift+E");
    await expect(head(page)).toHaveText("Editing plate.step, step 1: Scale 50 %");
    await page.locator("#modelFactor").fill(factor);
    await page.locator("#modelApply").click();
  };
  await edit("0.6");
  await expect(readout(page)).toHaveText("Updated “Scale 60 %” of plate.step and rebuilt 2 steps after it. Volume 713.60 mm³.");
  const keys = () => rows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.row));
  expect(await keys()).toEqual(["0", "1/0", "1/1", "1", "2", "3/0", "3/2", "3", "4"]);

  // The part's branch goes; the tool's new step stays, as the tool's own tree keeps every branch.
  await row(page, "2").click();
  await expect(readout(page)).toContainText("Volume 750 mm³");
  await row(page, "3").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Delete branch/ }).click();
  expect(await keys()).toEqual(["0", "1/0", "1/1", "1", "2"]);
  await expect(page.locator("#modelHistoryToggle")).toHaveText("History · 5");

  await edit("0.6");
  await expect(readout(page), "the tool's step was built before: only the join and the hole are").toHaveText("Updated “Scale 60 %” of plate.step and rebuilt 2 steps after it. Volume 713.60 mm³.");
  const sent = tree.of("edit");
  expect(sent).toHaveLength(2);
  expect(sent[1]!.tools, "the tool's tree is not asked to build anything").toBeUndefined();
  expect((sent[1]!.op as { tool: { node: number } }).tool.node, "the join takes the tool's step from the first edit").toBe(2);
  expect(await keys()).toEqual(["0", "1/0", "1/1", "1", "2", "5/0", "5/2", "5", "6"]);
  await expect(page.locator("#modelHistoryToggle")).toHaveText("History · 9");

  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse((await readFile((await download.path())!)).toString("utf8")) as { modelTools: { modelTree: { nodes: { id: number; parent: number | null; op: Body | null }[] } }[] };
  expect(doc.modelTools[0]!.modelTree.nodes.map((node) => [node.id, node.parent, (node.op as { factor?: number } | null)?.factor ?? null]), "one branch in the tool's tree for the one edit").toEqual([[0, null, null], [1, 0, 0.5], [2, 0, 0.6]]);
});

test("a tool's step that no longer builds is kept broken, and so is the join it fed, with the part's later steps under it", async ({ page }) => {
  await start(page);
  await page.locator("#modelToolScale").click();
  await page.locator("#modelFactor").fill("0.5");
  await page.locator("#modelApply").click();
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Volume 300 mm³");
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="box"]').click();
  for (const id of ["modelDx", "modelDy", "modelDz"]) await page.locator(`#${id}`).fill("10");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Box 1. Volume 1000 mm³");
  await page.keyboard.press("Shift+G");
  await page.locator("#modelObjects [data-object]").first().click();
  await page.locator("#modelCut").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Volume 970 mm³");
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Volume 770 mm³");

  // At 25 % the tool is 62.5 mm³, too small for its hole.
  await row(page, "1/1").locator(".mh-edit").click();
  await expect(head(page)).toHaveText("Editing plate.step, step 1: Scale 50 %");
  await page.locator("#modelFactor").fill("0.25");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toHaveText("Updated “Scale 25 %” of plate.step. Volume 1000 mm³. Step 2 of plate.step, “Hole ⌀4 depth 12”, could not be rebuilt: The hole is bigger than the part. The view shows the last step of this part that built. Edit that step or delete its branch.");
  expect(await rows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.row))).toEqual(["0", "3/0", "3/3", "3/4", "3", "4", "1/0", "1/1", "1/2", "1", "2"]);
  await expect(row(page, "3/4")).toHaveAttribute("data-broken", "");
  await expect(row(page, "3")).toHaveAttribute("data-broken", "");
  await expect(row(page, "3")).toHaveAttribute("data-tip", /The tool object's step could not be rebuilt: The hole is bigger than the part/);
  await expect(row(page, "4")).toHaveAttribute("data-blocked", "");
  await expect(row(page, "0"), "the view shows the join's parent").toHaveAttribute("aria-selected", "true");
  await expect(row(page, "3/4").locator(".mh-edit"), "the broken tool step can be edited in turn").toBeVisible();
});

test("every probed tool shows the shape its check built, and Apply ends the tool", async ({ page }) => {
  const tree = await start(page, true);
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  const probe = tree.of("probe").at(-1)!;
  expect([probe.preview, typeof probe.chordMm], "the check asks for its shape").toEqual([true, "number"]);
  await expect(canvas(page), "the shape is drawn in the solid's place").toHaveAttribute("data-preview", "3800.00");
  await expect(canvas(page), "and the hole's stand-in gives way to it").not.toHaveAttribute("data-ghost", /./);
  await page.locator("#modelHoleR").fill("3");
  await expect(canvas(page), "a new number shows its shape once checked").toHaveAttribute("data-preview", "3700.00");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Hole. Volume 3700 mm³");
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await expect(canvas(page)).not.toHaveAttribute("data-ghost", /./);
  await expect(canvas(page)).not.toHaveAttribute("data-preview", /./);
  await expect(page.locator("#modelUndo")).toBeEnabled();
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelHoleR"), "the tool opens again on the numbers applied last").toHaveValue("3");

  await page.locator("#modelToolBoolean").click();
  await page.locator('#modelPrim [data-kind="box"]').click();
  await expect(canvas(page), "a boolean keeps its tool's outline over the shape").toHaveAttribute("data-ghost", /./);
  await expect(canvas(page)).toHaveAttribute("data-preview", /./);
  await page.locator("#modelCancel").click();
  await expect(canvas(page)).not.toHaveAttribute("data-preview", /./);
});
