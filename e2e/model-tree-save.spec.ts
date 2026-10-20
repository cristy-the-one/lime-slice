import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, olderFile, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";
import { plateClick } from "./plate-rows";

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
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const pa = corners[a!]!;
    const pb = corners[b!]!;
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges };
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
  if (op.kind === "fillet" || op.kind === "chamfer") return { ...boxSolid([20, 20, 4]), volumeMm3: 1590 };
  return boxSolid([20, 20, op.size![0]!]);
}

/** The engine is mocked once for the page, so it outlives a reload as `serve` does. */
async function openModel(page: Page, model = true, more: Pick<Parameters<typeof mockModelTree>[1], "goto" | "probe" | "seedRefused" | "held"> = {}): Promise<TreeMock> {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: ROOT.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: () => ROOT, apply: built, ...more });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  if (!model) return tree;
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(10));
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const labels = (page: Page) => page.locator("#modelHistoryTree .mh-label");
const row = (page: Page, label: string) => page.getByRole("treeitem", { name: new RegExp(`^${label}`) });
const volume = (dx: number) => `Volume ${400 * dx} mm³`;

async function cut(page: Page, dx: number, atX?: number) {
  if ((await page.locator("#modelToolBoolean").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  if (atX !== undefined) await page.locator("#modelX").fill(String(atX));
  await page.locator("#modelDx").fill(String(dx));
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText(volume(dx));
}

async function split(page: Page, z: number) {
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelPlane").fill(String(z));
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText(`Split. ${volume(z)}`);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
}

/** Pick one edge of the shown solid by scanning the canvas in Edge mode. A click on the open panel or on History is skipped. */
async function pickEdge(page: Page) {
  await page.locator("#modelPickEdge").click();
  const box = (await page.locator("#model").boundingBox())!;
  for (let r = 0; r < 9; r += 1) {
    for (let col = 0; col < 9; col += 1) {
      const x = box.x + box.width * (0.18 + col * 0.08);
      const y = box.y + box.height * (0.18 + r * 0.08);
      const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id ?? "", { x, y });
      if (top !== "model") continue;
      await page.mouse.click(x, y);
      if (/Edge \d+/.test(await readout(page).innerText())) return;
    }
  }
  throw new Error("no edge under the scan");
}

/** Fillet the picked edge: the tool opens, its check passes, and Apply is clicked. */
async function filletPicked(page: Page) {
  await page.locator("#modelToolFillet").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
}

/** Hold every whole-tree open (an `open` with saved steps) until `release`. */
async function holdWholeOpens(page: Page) {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const seen = { holding: 0, release: () => release() };
  await page.route("**/api/model/tree", async (route) => {
    const body = route.request().postDataJSON() as Body;
    if (body.call === "open" && body.nodes) {
      seen.holding += 1;
      await held;
    }
    await route.fallback();
  });
  return seen;
}

/** Cut 8, 6, 4 in a row, save as an app before version 3 did, reopen, and open Model on the plate's step, read from its STEP. */
async function reopenedChain(page: Page, more: Parameters<typeof openModel>[2] = {}) {
  const tree = await openModel(page, true, more);
  for (const dx of [8, 6, 4]) await cut(page, dx);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await saveAndReopen(page, true);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(4));
  return tree;
}

/** Save from Prepare, open a fresh page, and open the saved file there; with `older`, as an app before version 3 saved it. */
async function saveAndReopen(page: Page, older = false): Promise<Record<string, unknown>> {
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  const written = await readFile((await download.path())!);
  const saved = older ? olderFile(written) : written;
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "plate.lime", mimeType: "application/json", buffer: saved });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  return JSON.parse(saved.toString("utf8")) as Record<string, unknown>;
}

test("a project an older app saved brings back its Model history: the same steps and names, and a jump rebuilds a step from the root", async ({ page }) => {
  const tree = await openModel(page);
  await cut(page, 8);
  await cut(page, 6);
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText(`${volume(8)}. Edit undone.`);
  await cut(page, 4);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await row(page, "Cut box 6").locator(".mh-label").dblclick();
  await page.getByRole("textbox", { name: "Step name" }).fill("Pocket");
  await page.keyboard.press("Enter");
  await row(page, "Cut box 4").click();
  await expect(readout(page)).toContainText(volume(4));
  const before = await labels(page).allTextContents();
  expect(before).toEqual(["plate.step", "Cut box 8×10×10", "Pocket", "Cut box 4×10×10"]);
  const firstKey = String(tree.of("open")[0]!.key);

  const doc = await saveAndReopen(page, true);
  const saved = (doc.objects as { modelTree: { nodes: { id: number; name?: string }[]; committed: number; rootStep: { bytesBase64?: string } } }[])[0]!.modelTree;
  expect(saved.nodes.map((node) => [node.id, node.name ?? null]), "the file keeps every step and the name").toEqual([[0, null], [1, null], [2, "Pocket"], [3, null]]);
  expect(saved.committed).toBe(3);
  expect(saved.rootStep.bytesBase64, "with the STEP file it started from").toBe(FILE.toString("base64"));

  const opens = tree.of("open").length;
  const gotos = tree.of("goto").length;
  await page.locator("#tabModel").click();
  await expect(readout(page), "Model opens on the step the plate holds").toContainText(volume(4));
  await expect(labels(page)).toHaveText(before);
  expect(tree.of("open").slice(opens), "one open: the plate's step from its own STEP, with no steps rebuilt").toHaveLength(1);
  const seed = tree.of("open")[opens]!;
  expect(seed.key, "under a key of its own, never the one the engine had before").not.toBe(firstKey);
  expect(seed.nodes).toBeUndefined();
  expect(tree.of("goto").slice(gotos).map((request) => request.node), "asked for, then asked again as the engine's root once its STEP is open").toEqual([3, 0]);

  // A new step builds on the plate's step as read from its STEP, at once: no history is rebuilt for it.
  await cut(page, 2);
  expect(tree.of("open").slice(opens), "no open for the whole tree").toHaveLength(1);
  expect(tree.of("apply").at(-1), "the edit builds on the read step, the engine's root, as step 4").toMatchObject({ key: seed.key, parent: 0, node: 4 });
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText(`${volume(4)}. Edit undone.`);
  await page.locator("#modelRedo").click();
  await expect(readout(page)).toContainText(`${volume(2)}. Edit redone.`);
  expect(tree.of("open").slice(opens), "undo and redo stay on the steps the engine holds").toHaveLength(1);
  // A jump to an earlier step rebuilds the history, with the new step in it.
  await row(page, "Cut box 8").click();
  await expect(readout(page)).toContainText(volume(8));
  expect(tree.of("open").slice(opens), "one more open, for the whole tree").toHaveLength(2);
  const whole = tree.of("open").at(-1)!;
  expect(whole.dataB64, "from the root STEP").toBe(FILE.toString("base64"));
  expect((whole.nodes as { id: number; parent: number }[]).map((node) => [node.id, node.parent]), "with every step").toEqual([[1, 0], [2, 1], [3, 1], [4, 3]]);
  await row(page, "Pocket").click();
  await expect(readout(page)).toContainText(volume(6));
  await cut(page, 3);
  expect(tree.of("apply").at(-1), "an edit after that numbers steps as saved").toMatchObject({ key: seed.key, parent: 2, node: 5 });
});

test("a project whose history starts from a primitive opens Model from the plate's STEP, with no step rebuilt", async ({ page }) => {
  // As the MCP server saved a model_build part before version 3: a primitive root, a STEP brep, and the plate on the last step.
  const tree = await openModel(page);
  for (const dx of [8, 6, 4]) await cut(page, dx);
  await expect(page.locator("#modelPanel")).toBeHidden();
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  const doc = JSON.parse((await readFile((await download.path())!)).toString("utf8")) as { objects: { brep?: { bytesBase64?: string }; modelTree: Record<string, unknown> }[] };
  const saved = doc.objects[0]!.modelTree;
  delete saved.rootStep;
  saved.rootPrimitive = { primitive: "box", origin: [0, 0, 0], size: [20, 20, 10], radius: 0, height: 0, turn: [0, 0, 0] };
  await page.reload();
  const opens = tree.of("open").length;
  const older = JSON.parse(olderFile(Buffer.from(JSON.stringify(doc))).toString("utf8")) as typeof doc;
  await page.locator("#projectFile").setInputFiles({ name: "built.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(older)) });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(readout(page), "Model opens on the plate's step").toContainText(volume(4));
  const since = tree.of("open").slice(opens);
  expect(since, "one open").toHaveLength(1);
  expect(since[0]!.nodes, "of the plate's step alone").toBeUndefined();
  expect(since[0]!.dataB64, "read from the plate's STEP").toBe(older.objects[0]!.brep?.bytesBase64);
  await cut(page, 2);
  expect(tree.of("open").slice(opens), "an edit builds on it with nothing rebuilt").toHaveLength(1);
});

test("a project saves the plate's step as the engine's binary solid, and reopens whole from it: a fillet builds at once, a jump rebuilds from the root", async ({ page }) => {
  const tree = await openModel(page);
  for (const dx of [8, 6, 4]) await cut(page, dx);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  const doc = await saveAndReopen(page);
  const object = (doc.objects as { brep: { name: string; bytesBase64: string } }[])[0]!;
  expect(doc.version, "a file with the binary solid is version 3").toBe(3);
  expect(object.brep.name).toBe("plate.brep");
  expect(Buffer.from(object.brep.bytesBase64, "base64").toString().startsWith("LIMEBREP "), "the solid as the engine wrote it").toBe(true);

  const opens = tree.of("open").length;
  await page.locator("#tabModel").click();
  await expect(readout(page), "Model opens on the plate's step").toContainText(volume(4));
  const since = tree.of("open").slice(opens);
  expect(since, "one open").toHaveLength(1);
  expect(since[0]!.dataB64, "of the whole tree, from its root STEP").toBe(FILE.toString("base64"));
  expect((since[0]!.nodes as unknown[]).length, "with every step").toBe(3);
  expect(since[0]!.seed, "and the plate's step from its saved solid").toEqual({ node: 3, dataB64: object.brep.bytesBase64 });
  expect([since[0]!.current, since[0]!.quiet], "quietly, at its root: the step is asked for next").toEqual([0, true]);
  expect(tree.of("goto").at(-1)).toMatchObject({ key: since[0]!.key, node: 3 });

  // The saved solid is the step exactly, so a fillet takes its edges at once: nothing is rebuilt, nothing asked again.
  const applies = tree.of("apply").length;
  await pickEdge(page);
  await filletPicked(page);
  await expect(readout(page)).toContainText("Volume 1590 mm³");
  expect(tree.of("apply").slice(applies), "the fillet builds on the plate's step").toHaveLength(1);
  expect(tree.of("apply").at(-1)).toMatchObject({ key: since[0]!.key, parent: 3, node: 4, op: { kind: "fillet" } });
  // A jump to an earlier step asks the tree already open; the engine builds it from the root.
  await row(page, "Cut box 8").click();
  await expect(readout(page)).toContainText(volume(8));
  expect(tree.of("open").slice(opens), "no second open").toHaveLength(1);
  expect(tree.of("goto").at(-1)).toMatchObject({ key: since[0]!.key, node: 1 });
});

test("an imported STEP root is saved once as the engine's binary solid of it, under the file's name", async ({ page }) => {
  const tree = await openModel(page, true, { held: true });
  await cut(page, 8);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  const doc = await saveAndReopen(page);
  const root = (doc.objects as { modelTree: { rootStep: { name: string; bytesBase64: string } } }[])[0]!.modelTree.rootStep;
  expect(root.name, "History still names the root by its file").toBe("plate.step");
  expect(Buffer.from(root.bytesBase64, "base64").toString().startsWith("LIMEBREP "), "the root as the engine holds it").toBe(true);
  expect(tree.of("export").filter((request) => request.node === 0), "written once, in the binary format").toEqual([expect.objectContaining({ format: "brep" })]);

  const opens = tree.of("open").length;
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(8));
  expect(tree.of("open").slice(opens).map((request) => request.dataB64), "the history opens from that root").toEqual([root.bytesBase64]);
  await page.locator("#tabPrepare").click();
  const exports = tree.of("export").length;
  await saveAndReopen(page);
  expect(tree.of("export").slice(exports).filter((request) => request.node === 0), "a root already in the binary format is not written again").toHaveLength(0);
});

test("a saved solid the engine refuses is said, and the history is rebuilt instead", async ({ page }) => {
  const tree = await openModel(page, true, { seedRefused: () => "saved by Open CASCADE 7.8.0, this modeler has 7.9.2" });
  for (const dx of [8, 6]) await cut(page, dx);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await saveAndReopen(page);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("The saved solid did not open (saved by Open CASCADE 7.8.0, this modeler has 7.9.2), so its history was rebuilt.");
  expect(tree.of("open").at(-1)!.seed).toBeTruthy();
});

test("calls made while a reopened tree opens whole wait for it, and two jumps share one open", async ({ page }) => {
  const tree = await openModel(page);
  const probes: number[] = [];
  await page.route("**/api/model/tree", async (route) => {
    const body = route.request().postDataJSON() as Body;
    if (body.call === "probe") probes.push(Number(body.node));
    await route.fallback();
  });
  for (const dx of [8, 6, 4]) await cut(page, dx);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await saveAndReopen(page, true);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(4));

  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let holding = 0;
  await page.route("**/api/model/tree", async (route) => {
    const body = route.request().postDataJSON() as Body;
    if (body.call === "open" && body.nodes) {
      holding += 1;
      await held;
    }
    await route.fallback();
  });
  await row(page, "Cut box 8").click();
  await expect.poll(() => holding).toBe(1);
  await row(page, "Cut box 6").click();
  const asked = probes.length;
  await page.locator("#modelToolBoolean").click();
  await page.waitForTimeout(300);
  release();
  await expect(readout(page)).toContainText(volume(6));
  expect(tree.of("open").filter((request) => request.nodes), "one whole open for both jumps").toHaveLength(1);
  expect(probes.slice(asked)[0], "a check asked meanwhile waits, and names the step as the whole tree does").toBe(3);
  expect(probes.slice(asked)).not.toContain(0);
  expect(tree.of("goto").at(-1)?.node).toBe(2);
});

test("a jump back to the plate's step while the whole tree opens shows the step as rebuilt, and a fillet builds on that", async ({ page }) => {
  const tree = await reopenedChain(page);
  const hold = await holdWholeOpens(page);
  await row(page, "Cut box 8").click();
  await expect.poll(() => hold.holding).toBe(1);
  const gotos = tree.of("goto").length;
  await row(page, "Cut box 4").click();
  hold.release();
  await expect(readout(page)).toContainText(volume(4));
  await expect.poll(() => tree.of("goto").slice(gotos).map((request) => request.node), { message: "the step comes from the whole tree, not from the solid read from its STEP" }).toContain(3);
  await pickEdge(page);
  await filletPicked(page);
  await expect(readout(page)).toContainText("Volume 1590 mm³");
  expect(tree.of("apply").at(-1), "the fillet builds on the rebuilt step at once").toMatchObject({ parent: 3, node: 4, op: { kind: "fillet" } });
});

test("a fillet on a reopened step rebuilds the step first and asks for its edges again", async ({ page }) => {
  // A fillet names edges by the solid's numbering, which the STEP-read step may number apart from the rebuilt one.
  const tree = await reopenedChain(page);
  const applies = tree.of("apply").length;
  await pickEdge(page);
  await filletPicked(page);
  await expect(readout(page)).toContainText("The step was rebuilt from its history: pick the edges again.");
  expect(tree.of("open").at(-1)?.nodes, "the whole tree opened").toHaveLength(3);
  expect(tree.of("apply"), "and nothing was built on edges the read solid numbered").toHaveLength(applies);
  await expect(page.locator("#modelApply")).toBeDisabled();
  // Picked again on the rebuilt step, the fillet builds there, and a jump away and back finds it whole.
  // The fillet tool stays open, waiting for edges on the rebuilt step.
  await pickEdge(page);
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Volume 1590 mm³");
  expect(tree.of("apply").at(-1), "the fillet builds on the rebuilt step").toMatchObject({ parent: 3, node: 4, op: { kind: "fillet" } });
  await row(page, "Cut box 8").click();
  await expect(readout(page)).toContainText(volume(8));
  await rows(page).last().click();
  await expect(readout(page)).toContainText("Volume 1590 mm³");
  await expect(rows(page).last()).not.toHaveAttribute("data-broken", "");
});

test("an edit on a reopened step builds at once, even where its history would rebuild differently", async ({ page }) => {
  const why = "This step rebuilt differently: 1 mm³, 6 faces, 12 edges instead of 1600 mm³, 6 faces, 12 edges";
  let reopened = false;
  const tree = await reopenedChain(page, { goto: (request) => (reopened && request.node === 3 ? { error: why, broken: 3 } : null) });
  reopened = true;
  const applies = tree.of("apply").length;
  if ((await page.locator("#modelToolBoolean").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolBoolean").click();
  await page.locator("#modelDx").fill("2");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText(volume(2));
  expect(tree.of("apply").slice(applies), "the cut builds on the read step").toHaveLength(1);
  expect(tree.of("open").filter((request) => request.nodes), "and no history is rebuilt for it").toHaveLength(0);
  await expect(row(page, "Cut box 4")).not.toHaveAttribute("data-broken", "");
});

test("a check sent before the whole tree opened, answered after, is asked again under the step's own number", async ({ page }) => {
  let whole = false;
  const tree = await reopenedChain(page, { probe: (request) => (whole && request.node === 0 ? { ok: false, error: "Asked of the root" } : { ok: true }) });
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let holding = 0;
  await page.route("**/api/model/tree", async (route) => {
    const body = route.request().postDataJSON() as Body;
    if (body.call === "probe" && body.node === 0 && holding === 0) {
      holding += 1;
      await held;
    }
    if (body.call === "open" && body.nodes) whole = true;
    await route.fallback();
  });
  await page.locator("#modelToolBoolean").click();
  await expect.poll(() => holding).toBe(1);
  await row(page, "Cut box 8").click();
  await expect(readout(page)).toContainText(volume(8));
  release();
  await expect.poll(() => tree.calls.filter((request) => request.call === "probe" && request.node === 3).length, { message: "the late check is asked again" }).toBeGreaterThan(0);
  await row(page, "Cut box 4").click();
  await expect(readout(page)).toContainText(volume(4));
  await expect(page.locator("#modelNote")).not.toContainText("Asked of the root");
  await expect(page.locator("#modelApply")).toBeEnabled();
});

test("a save survives the plate being replaced while a piece's root STEP is still being written", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  const tree = await openModel(page);
  await split(page, 4);
  await plateClick(page, "select", 1);
  await expect(readout(page)).toContainText(volume(6));
  await cut(page, 2);
  await page.locator("#tabPrepare").click();
  await expect.poll(() => tree.of("export").length).toBe(2);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let holding = 0;
  await page.route("**/api/model/tree", async (route) => {
    const body = route.request().postDataJSON() as Body;
    if (body.call === "export" && body.node === 0) {
      holding += 1;
      await held;
    }
    await route.fallback();
  });
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  await expect.poll(() => holding).toBe(1);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#file").setInputFiles({ name: "other.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  release();
  const saved = JSON.parse((await (await import("node:fs/promises")).readFile((await (await download).path())!)).toString("utf8")) as { objects?: { modelTree?: unknown }[] };
  expect(errors, "the save does not throw").toEqual([]);
  expect((saved.objects ?? []).filter((obj) => obj.modelTree), "no tree of the replaced plate goes into the file").toHaveLength(0);
});

test("a part Prepare undo took back to before its first Model visit still saves its history", async ({ page }) => {
  const tree = await openModel(page, false);
  await page.locator("#placeX").fill("60");
  await page.locator("#placeX").press("Tab");
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(10));
  await cut(page, 5);
  await page.locator("#tabPrepare").click();
  // Back past the visit and the move made before it: the plate's part carries no tree key there.
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#objectList .obj").first()).toContainText("20 × 20 × 10");
  const doc = await saveAndReopen(page);
  const saved = (doc.objects as { modelTree?: { nodes: unknown[]; committed: number } }[] | undefined)?.[0]?.modelTree;
  expect(saved?.nodes, "the tree is saved with its step").toHaveLength(2);
  expect(saved?.committed).toBe(0);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(10));
  await row(page, "Cut box 5").click();
  await expect(readout(page)).toContainText(volume(5));
  expect(tree.of("open").at(-1)?.nodes).toHaveLength(1);
});

test("a copy's tree is closed once no Prepare step can bring the copy back, and a deleted part's tree stays for undo", async ({ page }) => {
  const tree = await openModel(page);
  await cut(page, 5);
  await page.locator("#tabPrepare").click();
  await plateClick(page, "duplicate");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await plateClick(page, "select", 1);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(5));
  await cut(page, 3, 30);
  const copyKey = String(tree.of("apply").at(-1)!.key);
  const partKey = String(tree.of("apply")[0]!.key);
  await page.locator("#tabPrepare").click();

  // The part is deleted, then put back: its tree stays, and Model resumes it with nothing read again.
  await plateClick(page, "remove");
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const opens = tree.of("open").length;
  await plateClick(page, "select");
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(5));
  expect(tree.of("open"), "the part's tree was kept").toHaveLength(opens);
  expect(tree.of("close")).toHaveLength(0);
  await page.locator("#tabPrepare").click();

  // Undo the copy's edit and the copy itself; a new edit then clears the redo steps that held it.
  for (let i = 0; i < 6 && (await page.locator("#objectList .obj").count()) > 1; i += 1) {
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(100);
  }
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await expect(page.locator("#objectList .obj").first(), "the part keeps its cut").toContainText("20 × 20 × 5");
  expect(tree.of("close"), "a redo step can still bring the copy back").toHaveLength(0);
  await page.locator("#placeX").fill("60");
  await page.locator("#placeX").press("Tab");
  await expect.poll(() => tree.of("close").map((request) => request.key)).toEqual([copyKey]);
  expect(tree.of("close").map((request) => request.key)).not.toContain(partKey);
});

test("a split piece opens after a reload with its own steps, without the part it was cut from", async ({ page }) => {
  const tree = await openModel(page);
  await split(page, 4);
  await plateClick(page, "select", 1);
  await expect(readout(page)).toContainText(volume(6));
  await cut(page, 2);

  const doc = await saveAndReopen(page);
  const objects = doc.objects as { id: string; modelTree: { nodes: { id: number; piece?: string }[] } }[];
  expect(objects[0]!.modelTree.nodes.find((node) => node.id === 1)?.piece, "the split names its piece's plate object").toBe(objects[1]!.id);

  const calls = tree.calls.length;
  await plateClick(page, "select", 1);
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
  await page.locator("#tabPrepare").click();
  await plateClick(page, "select");
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(6));
  await row(page, "Cut box 8").focus();
  await page.keyboard.press("Delete");
  await expect(readout(page), "before the save, Prepare undo can bring the cut back").toHaveText("The plate held a step on this branch, and Prepare undo can bring it back.");

  await saveAndReopen(page);
  await plateClick(page, "select");
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
