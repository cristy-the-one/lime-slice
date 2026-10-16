import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 × 20 box `h` tall, with its twelve edges, as the modeler reports a solid. */
function boxSolid(h: number, volumeMm3 = 400 * h): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * h];
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
    const [pa, pb] = [corners[a!]!, corners[b!]!];
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges };
}

const heightOf = (solid: MockSolid) => Math.max(...solid.positions.filter((_, i) => i % 3 === 2));
const FILLET_MISFIT = "The fillet did not fit this edge";

/**
 * A box cut leaves a slab as tall as Size X; a box root or a new solid is as tall as its Size Z. A fillet takes 10 mm³ per
 * mm of size off, and fits only while its size stays under a quarter of the slab's height, so a thinner slab breaks it.
 */
function build(request: Body, parent: MockSolid): Built {
  const op = request.op as { kind: string; size?: number[] | number; primitive?: string };
  if (op.kind === "boolean") return boxSolid((op.size as number[])[0]!);
  if (op.kind === "root") return boxSolid((op.size as number[])[2]!, (op.size as number[]).reduce((a, b) => a * b, 1));
  if (op.kind === "fillet") {
    const h = heightOf(parent);
    if ((op.size as number) >= h / 4) return { error: FILLET_MISFIT };
    return { ...boxSolid(h), volumeMm3: parent.volumeMm3 - 10 * (op.size as number) };
  }
  if (op.kind === "scale") return { ...parent, volumeMm3: parent.volumeMm3 * (request.op as { factor: number }).factor ** 3 };
  return { error: `unexpected ${op.kind}` };
}

async function openModel(page: Page): Promise<TreeMock> {
  const root = boxSolid(10);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => {
      const primitive = request.primitive as { size: number[] } | undefined;
      return primitive ? boxSolid(primitive.size[2]!, primitive.size.reduce((a, b) => a * b, 1)) : root;
    },
    apply: build,
    probe: (request, on) => {
      const built = build(request, on);
      return "error" in built ? { ok: false, error: built.error } : { ok: true };
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const row = (page: Page, label: string) => page.getByRole("treeitem", { name: new RegExp(`^${label}`) });
const byId = (page: Page, id: number) => page.locator(`#modelHistoryTree [data-id="${id}"]`);
const head = (page: Page) => page.locator("#modelEditHead");
const apply = (page: Page) => page.locator("#modelApply");

async function cut(page: Page, dx: number, atX?: number) {
  if ((await page.locator("#modelToolBoolean").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  if (atX !== undefined) await page.locator("#modelX").fill(String(atX));
  await page.locator("#modelDx").fill(String(dx));
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText(`Volume ${400 * dx} mm³`);
}

/** Pick one edge of the shown solid by scanning the canvas in Edge mode. */
async function pickEdge(page: Page) {
  await page.locator("#modelPickEdge").click();
  const box = (await page.locator("#model").boundingBox())!;
  for (let r = 0; r < 9; r += 1) {
    for (let col = 0; col < 9; col += 1) {
      await page.mouse.click(box.x + box.width * (0.18 + col * 0.08), box.y + box.height * (0.18 + r * 0.08));
      if (/Edge \d+/.test(await readout(page).innerText())) return;
    }
  }
  throw new Error("no edge under the scan");
}

/** Plate → Cut box 8 → Fillet r 1, the fillet shown. */
async function cutThenFillet(page: Page) {
  await cut(page, 8);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await pickEdge(page);
  await page.locator("#modelToolFillet").click();
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText("Fillet. Volume 3190 mm³");
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
}

test("Edit step from the row menu opens the step's tool on its parent, prefilled, and Update forks and replays", async ({ page }) => {
  const tree = await openModel(page);
  await cutThenFillet(page);

  const probes = tree.of("probe").length;
  await row(page, "Cut box 8").locator(".mh-more").click();
  const item = page.getByRole("menuitem", { name: /Edit step/ });
  await expect(item).toHaveAttribute("aria-disabled", "false");
  await expect(item).toContainText("Shift+E");
  await item.click();

  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(head(page)).toHaveText("Editing step 1: Cut box 8×10×10");
  await expect(page.locator("#modelToolBoolean")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelDx"), "the panel opens with the step's own numbers").toHaveValue("8");
  await expect(page.locator("#modelCut")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelWithObject"), "a boolean stays a boolean with a primitive").toBeHidden();
  await expect(apply(page)).toHaveText("Update");
  await expect(apply(page), "the numbers as they are would change nothing").toBeDisabled();
  await expect(page.locator("#modelNote")).toHaveText("Change a number to update this step.");
  await expect(row(page, "plate.step"), "the view shows the step's parent, as when it was first applied").toHaveAttribute("aria-selected", "true");
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  expect(tree.of("probe"), "an untouched panel asks nothing").toHaveLength(probes);

  await page.locator("#modelDx").fill("6");
  await expect(apply(page)).toBeEnabled();
  const probe = tree.of("probe").at(-1)!;
  expect(probe, "the dry-run runs on the parent").toMatchObject({ node: 0, op: { kind: "boolean", size: [6, 10, 10] } });
  await apply(page).click();
  await expect(readout(page)).toContainText("Updated “Cut box 6×10×10” and rebuilt the step after it. Volume 2390 mm³.");
  await expect(page.locator("#modelPanel")).toBeHidden();
  const edits = tree.of("edit");
  expect(edits).toHaveLength(1);
  expect(edits[0], "one call: the edited op on the parent, and the fillet replayed under it").toMatchObject({ parent: 0, node: 3, op: { kind: "boolean", op: "cut", size: [6, 10, 10] }, replay: [{ id: 4, op: { kind: "fillet", size: 1 } }] });

  await expect(rows(page), "the edit is the main rail, the old branch beside it").toHaveText([/^plate\.step/, /^Cut box 8/, /^Fillet 1 edge r 1/, /^Cut box 6/, /^Fillet 1 edge r 1/]);
  await expect(byId(page, 4)).toHaveAttribute("aria-selected", "true");
  await expect(byId(page, 1)).toHaveAttribute("aria-level", "2");
  await expect(byId(page, 3)).toHaveAttribute("aria-level", "1");
  await expect(page.locator("#modelHistoryToggle")).toHaveText("History · 5");

  // The old branch is still there: a click shows its fillet as it was.
  await byId(page, 2).click();
  await expect(readout(page)).toContainText("Volume 3190 mm³");
});

test("the pencil and Shift+E open an edit; Cancel and Esc put the view back where it was", async ({ page }) => {
  const tree = await openModel(page);
  await cut(page, 8);
  await cut(page, 6);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();

  const pencil = row(page, "Cut box 8").locator(".mh-edit");
  await expect(pencil).toHaveAttribute("aria-label", "Edit step: Cut box 8×10×10");
  await row(page, "Cut box 8").hover();
  await expect(pencil).toBeVisible();
  await pencil.click();
  await expect(head(page)).toHaveText("Editing step 1: Cut box 8×10×10");
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  await expect(page.locator("#modelUndo"), "Cancel is the way back while editing").toBeDisabled();
  await page.locator("#modelCancel").click();
  await expect(page.locator("#modelPanel")).toBeHidden();
  await expect(row(page, "Cut box 6"), "Cancel goes back to the step shown before").toHaveAttribute("aria-selected", "true");
  await expect(readout(page)).toContainText("Volume 2400 mm³");

  await row(page, "Cut box 6").focus();
  await page.keyboard.press("Shift+E");
  await expect(head(page), "Shift+E in the panel edits the focused step").toHaveText("Editing step 2: Cut box 6×10×10");
  await expect(row(page, "Cut box 8")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelPanel")).toBeHidden();
  await expect(row(page, "Cut box 6")).toHaveAttribute("aria-selected", "true");

  await page.locator("#model").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+E");
  await expect(head(page), "elsewhere in Model it edits the step shown").toHaveText("Editing step 2: Cut box 6×10×10");
  await page.locator("#modelDx").fill("5");
  await expect(apply(page)).toBeEnabled();
  await page.locator("#modelDx").press("Enter");
  await expect(readout(page)).toContainText("Updated “Cut box 5×10×10”. Volume 2000 mm³.");
  expect(tree.of("edit").map((request) => request.replay), "nothing under the shown step to replay").toEqual([[]]);
  await expect(rows(page)).toHaveText([/^plate\.step/, /^Cut box 8/, /^Cut box 6/, /^Cut box 5/]);
});

test("a step under the edit that no longer builds is kept broken with the engine's reason, and editing it mends the branch", async ({ page }) => {
  const tree = await openModel(page);
  await cutThenFillet(page);
  await page.locator("#modelToolScale").click();
  await apply(page).click();
  await expect(readout(page)).toContainText("Volume 25520 mm³");
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await row(page, "Cut box 8").locator(".mh-edit").click();
  await page.locator("#modelDx").fill("4");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText(`Updated “Cut box 4×10×10”. Volume 1600 mm³. Step 2, “Fillet 1 edge r 1”, could not be rebuilt: ${FILLET_MISFIT}. The view shows the last step that built.`);
  await expect(byId(page, 4), "the view is on the last step that built").toHaveAttribute("aria-selected", "true");
  await expect(byId(page, 5)).toHaveAttribute("data-broken", "");
  await expect(byId(page, 5)).toHaveAttribute("aria-description", FILLET_MISFIT);
  await expect(byId(page, 6), "the scale is kept under it, blocked").toHaveAttribute("data-blocked", "");
  await expect(byId(page, 2), "the old branch is not broken").not.toHaveAttribute("data-broken", "");
  await expect(page.locator("#modelRedo"), "Redo cannot step into the broken step").toBeDisabled();

  // The broken fillet can itself be edited: its edge is picked again, a smaller size fits, and the scale replays.
  await byId(page, 5).hover();
  await byId(page, 5).locator(".mh-edit").click();
  await expect(head(page)).toHaveText("Editing step 2: Fillet 1 edge r 1");
  await expect(page.locator("#modelCount"), "its edge is picked again").toHaveText("1 edge");
  await expect(page.locator("#modelBlend")).toHaveValue("1");
  await page.locator("#modelBlend").fill("0.5");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText("Updated “Fillet 1 edge r 0.5” and rebuilt the step after it. Volume 12760 mm³.");
  expect(tree.of("edit").at(-1), "the broken step forks under its parent, and what was under it replays").toMatchObject({ parent: 4, node: 7, op: { kind: "fillet", size: 0.5 }, replay: [{ id: 8, op: { kind: "scale" } }] });
  await expect(byId(page, 8)).toHaveAttribute("aria-selected", "true");
  await expect(byId(page, 5), "the broken step stays, so it can be deleted").toHaveAttribute("data-broken", "");
  await byId(page, 5).locator(".mh-more").click();
  await page.getByRole("menuitem", { name: /Delete branch/ }).click();
  await expect(byId(page, 5)).toHaveCount(0);
  await expect(byId(page, 6)).toHaveCount(0);
});

test("Model Undo takes an edit back to the old branch, and Redo brings it back", async ({ page }) => {
  await openModel(page);
  await cut(page, 8);
  await cut(page, 6);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await row(page, "Cut box 8").locator(".mh-edit").click();
  await page.locator("#modelDx").fill("9");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText("Updated “Cut box 9×10×10” and rebuilt the step after it. Volume 2400 mm³.");
  await expect(byId(page, 4)).toHaveAttribute("aria-selected", "true");

  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText("Volume 2400 mm³. Edit of the step undone.");
  await expect(byId(page, 2), "Undo goes back to the step shown before the edit").toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+Shift+Z");
  await expect(readout(page)).toContainText("Edit of the step redone.");
  await expect(byId(page, 4)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+z");
  await expect(byId(page, 2)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+z");
  await expect(readout(page), "and on from there as ever").toContainText("Volume 3200 mm³. Edit undone.");
  await expect(byId(page, 1)).toHaveAttribute("aria-selected", "true");
});

test("Update shows how many steps it rebuilds, and Cancel while they rebuild goes back at once", async ({ page }) => {
  const tree = await openModel(page);
  await cut(page, 8);
  await cut(page, 7);
  await cut(page, 6);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/model/tree", async (route) => {
    if ((route.request().postDataJSON() as Body).call === "edit") await held;
    await route.fallback();
  });
  await row(page, "Cut box 8").locator(".mh-edit").click();
  await page.locator("#modelDx").fill("9");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toHaveText("Rebuilding 3 steps…");
  await page.locator("#modelCancel").click();
  await expect(row(page, "Cut box 6"), "the view goes back while the engine still works").toHaveAttribute("aria-selected", "true");
  await expect(readout(page)).toContainText("Volume 2400 mm³");
  release();
  await expect.poll(() => tree.of("drop").map((request) => request.node), { message: "what the engine built for it goes" }).toEqual([4]);
  await expect(rows(page)).toHaveCount(4);
  await expect(row(page, "Cut box 6")).toHaveAttribute("aria-selected", "true");
});

test("the opened file cannot be edited, says why, and shows no pencil; a new solid's root can", async ({ page }) => {
  const tree = await openModel(page);
  await cut(page, 8);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await expect(row(page, "plate.step").locator(".mh-edit")).toBeHidden();
  await row(page, "plate.step").focus();
  await page.keyboard.press("Shift+F10");
  const item = page.getByRole("menuitem", { name: /Edit step/ });
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(item).toContainText("The opened file starts the history. Its steps can be edited, not the file.");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+E");
  await expect(readout(page)).toHaveText("The opened file starts the history. Its steps can be edited, not the file.");
  await expect(page.locator("#modelPanel")).toBeHidden();

  // A new solid's root is a primitive: it edits in New solid's panel, and the step under it replays.
  await page.locator("#modelToolNew").click();
  for (const [id, value] of [["modelDx", 20], ["modelDy", 20], ["modelDz", 20]] as const) await page.locator(`#${id}`).fill(String(value));
  await apply(page).click();
  await expect(readout(page)).toContainText("Box 1. Volume 8000 mm³");
  await cut(page, 5, 40);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await row(page, "Box 20×20×20").locator(".mh-edit").click();
  await expect(head(page)).toHaveText("Editing the new solid: Box 20×20×20");
  await expect(page.locator("#modelToolNew")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelDz")).toHaveValue("20");
  await page.locator("#modelDz").fill("30");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText("Updated “Box 20×20×30” and rebuilt the step after it. Volume 2000 mm³.");
  expect(tree.of("edit").at(-1)).toMatchObject({ parent: 0, op: { kind: "root", primitive: "box", size: [20, 20, 30], origin: [-10, -10, 0] }, replay: [{ op: { kind: "boolean", size: [5, 20, 20] } }] });
  await expect(rows(page)).toHaveText([/^Box 20×20×20/, /^Cut box 5/, /^Box 20×20×30/, /^Cut box 5/]);
});
