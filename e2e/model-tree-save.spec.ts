import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";

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
const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");

/** A box cut leaves a 20 × 20 slab as tall as the box's Size X, so each step's volume names its numbers. */
function built(request: Body): Built {
  const op = request.op as { kind: string; size?: number[]; origin?: number[] };
  if (op.kind === "split") {
    const z = op.origin![2]!;
    return { kept: boxSolid([20, 20, z]), other: boxSolid([20, 20, 10 - z], z) };
  }
  return boxSolid([20, 20, op.size![0]!]);
}

/** The engine is mocked once for the page, so it outlives a reload as `serve` does. */
async function openModel(page: Page): Promise<TreeMock> {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: ROOT.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: () => ROOT, apply: built });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(10));
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const labels = (page: Page) => page.locator("#modelHistoryTree .mh-label");
const row = (page: Page, label: string) => page.getByRole("treeitem", { name: new RegExp(`^${label}`) });
const volume = (dx: number) => `Volume ${400 * dx} mm³`;

async function cut(page: Page, dx: number) {
  if ((await page.locator("#modelToolBoolean").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  await page.locator("#modelDx").fill(String(dx));
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText(volume(dx));
}

async function split(page: Page, z: number) {
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelPlaneZ").fill(String(z));
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText(`Split. ${volume(z)}`);
  await page.locator("#modelCancel").click();
}

/** Save from Prepare, open a fresh page, and open the saved file there. */
async function saveAndReopen(page: Page): Promise<Record<string, unknown>> {
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  const saved = await readFile((await download.path())!);
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "plate.lime", mimeType: "application/json", buffer: saved });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  return JSON.parse(saved.toString("utf8")) as Record<string, unknown>;
}

test("a saved project brings back its Model history: the same steps and names, and a jump rebuilds a step from the root", async ({ page }) => {
  const tree = await openModel(page);
  await cut(page, 8);
  await cut(page, 6);
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText(`${volume(8)}. Edit undone.`);
  await cut(page, 4);
  await page.locator("#modelCancel").click();
  await row(page, "Cut box 6").locator(".mh-label").dblclick();
  await page.getByRole("textbox", { name: "Step name" }).fill("Pocket");
  await page.keyboard.press("Enter");
  await row(page, "Cut box 4").click();
  await expect(readout(page)).toContainText(volume(4));
  const before = await labels(page).allTextContents();
  expect(before).toEqual(["plate.step", "Cut box 8×10×10", "Pocket", "Cut box 4×10×10"]);
  const firstKey = String(tree.of("open")[0]!.key);

  const doc = await saveAndReopen(page);
  const saved = (doc.objects as { modelTree: { nodes: { id: number; name?: string }[]; committed: number; rootStep: { bytesBase64?: string } } }[])[0]!.modelTree;
  expect(saved.nodes.map((node) => [node.id, node.name ?? null]), "the file keeps every step and the name").toEqual([[0, null], [1, null], [2, "Pocket"], [3, null]]);
  expect(saved.committed).toBe(3);
  expect(saved.rootStep.bytesBase64, "with the STEP file it started from").toBe(FILE.toString("base64"));

  const opens = tree.of("open").length;
  await page.locator("#tabModel").click();
  await expect(readout(page), "Model opens on the step the plate holds").toContainText(volume(4));
  await expect(labels(page)).toHaveText(before);
  const seed = tree.of("open")[opens]!;
  expect(seed.key, "under a key of its own, never the one the engine had before").not.toBe(firstKey);
  expect(seed.nodes, "the plate's step opens from its own STEP, with no steps rebuilt").toBeUndefined();

  await row(page, "Cut box 8").click();
  await expect(readout(page)).toContainText(volume(8));
  const whole = tree.of("open").at(-1)!;
  expect(whole.dataB64, "a step the engine was not given rebuilds from the root STEP").toBe(FILE.toString("base64"));
  expect((whole.nodes as { id: number; parent: number }[]).map((node) => [node.id, node.parent]), "with every step").toEqual([[1, 0], [2, 1], [3, 1]]);
  expect(whole.current).toBe(1);
  await row(page, "Pocket").click();
  await expect(readout(page)).toContainText(volume(6));
  await cut(page, 2);
  expect(tree.of("apply").at(-1), "an edit on a reopened tree builds on its step").toMatchObject({ key: seed.key, parent: 2, node: 4 });
});

test("a split piece opens after a reload with its own steps, without the part it was cut from", async ({ page }) => {
  const tree = await openModel(page);
  await split(page, 4);
  await page.locator("[data-plate-select]").nth(1).click();
  await expect(readout(page)).toContainText(volume(6));
  await cut(page, 2);

  const doc = await saveAndReopen(page);
  const objects = doc.objects as { id: string; modelTree: { nodes: { id: number; piece?: string }[] } }[];
  expect(objects[0]!.modelTree.nodes.find((node) => node.id === 1)?.piece, "the split names its piece's plate object").toBe(objects[1]!.id);

  const calls = tree.calls.length;
  await page.locator("[data-plate-select]").nth(1).click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(2));
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toHaveText(/^Cut box 2/);
  await rows(page).first().click();
  await expect(readout(page), "the piece's root rebuilds from its own STEP").toContainText(volume(6));
  const after = tree.calls.slice(calls);
  expect(new Set(after.map((request) => request.key)).size, "only the piece's tree is asked").toBe(1);
  expect(after.some((request) => request.otherKey), "no split runs again").toBe(false);
  expect(after.filter((request) => request.call === "open").map((request) => request.dataB64), "the part's STEP is not read").not.toContain(FILE.toString("base64"));
});

test("after a reload, Delete branch refuses the plate's path and a split whose piece is on the plate, and lets the rest go", async ({ page }) => {
  const tree = await openModel(page);
  await cut(page, 8);
  await page.locator("#tabPrepare").click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(8));
  await row(page, "plate.step").click();
  await expect(readout(page)).toContainText(volume(10));
  await split(page, 4);
  await row(page, "plate.step").click();
  await expect(readout(page)).toContainText(volume(10));
  await cut(page, 6);
  await page.locator("#modelCancel").click();
  await row(page, "Cut box 8").focus();
  await page.keyboard.press("Delete");
  await expect(readout(page), "before the save, Prepare undo can bring the cut back").toHaveText("The plate held a step on this branch, and Prepare undo can bring it back.");

  await saveAndReopen(page);
  await page.locator("[data-plate-select]").first().click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(6));
  await expect(labels(page)).toHaveText(["plate.step", "Cut box 8×10×10", "Split at Z 4", "Cut box 6×10×10"]);

  const remove = page.getByRole("menuitem", { name: /Delete branch/ });
  for (const [label, why] of [
    ["plate.step", "The opened file starts the history and stays."],
    ["Cut box 6", "The step on screen is on this branch."],
    ["Split at Z 4", "A split on this branch made a part of its own."],
  ] as const) {
    await row(page, label).locator(".mh-more").click();
    await expect(remove).toHaveAttribute("aria-disabled", "true");
    await expect(remove).toContainText(why);
    await page.keyboard.press("Escape");
  }

  await row(page, "Cut box 8").locator(".mh-more").click();
  await expect(remove, "no Prepare step from before the save can bring the cut back").toHaveAttribute("aria-disabled", "false");
  await remove.click();
  await expect(labels(page)).toHaveText(["plate.step", "Split at Z 4", "Cut box 6×10×10"]);
  expect(tree.of("close"), "no tree was closed").toHaveLength(0);
});
