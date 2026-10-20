import { expect, test, type Page } from "@playwright/test";
import { railClick } from "./rail";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";
import { plateClick } from "./plate-rows";

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
  quads.forEach((q, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

const ROOT = boxSolid([20, 20, 10]);

/** A box cut leaves a 20 × 20 slab as tall as the box's Size X, so each step's volume names its numbers. */
async function openModel(page: Page, url = "/", part: { root: MockSolid; name: string; apply?: (request: Body) => Built } = { root: ROOT, name: "plate.step" }): Promise<TreeMock> {
  const { root, name } = part;
  const apply = part.apply ?? ((request: Body) => boxSolid([20, 20, (request.op as { size: number[] }).size[0]!]));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: () => root, apply });
  await page.goto(url);
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name, mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  if (url.includes("compact")) await page.locator("#compactTabs [data-tab=model]").click();
  else await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(`Volume ${root.volumeMm3} mm³`);
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const row = (page: Page, label: string) => page.getByRole("treeitem", { name: new RegExp(`^${label}`) });
const volume = (dx: number) => `Volume ${400 * dx} mm³`;

/** Hold the engine's answer to a jump to `node` for `ms`, counting the asks and the answers. */
async function slowGoto(page: Page, node: number, ms = 900) {
  const seen = { asked: 0, answered: 0 };
  await page.route("**/api/model/tree", async (route) => {
    const body = route.request().postDataJSON() as Body;
    if (body.call !== "goto" || body.node !== node) return route.fallback();
    seen.asked += 1;
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.fallback();
    seen.answered += 1;
  });
  return seen;
}
async function cut(page: Page, dx: number) {
  if ((await page.locator("#modelToolBoolean").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  await page.locator("#modelDx").fill(String(dx));
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText(volume(dx));
}

/** 0 → 8 → 6, back to 8, then 8 → 4: a fork at "Cut box 8", with "Cut box 4" shown. */
async function fork(page: Page) {
  await cut(page, 8);
  await cut(page, 6);
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText(`${volume(8)}. Edit undone.`);
  await cut(page, 4);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
}

test("clicking a row shows that step, and the rows follow the history oldest first", async ({ page }) => {
  await openModel(page);
  await expect(page.locator("#modelHistory")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  for (const dx of [8, 6, 4]) await cut(page, dx);
  await expect(rows(page)).toHaveText(["plate.step", "Cut box 8×10×10", "Cut box 6×10×10", "Cut box 4×10×10"].map((label) => new RegExp(`^${label}`)));
  await expect(page.locator("#modelHistoryToggle")).toHaveText("History · 4");
  await expect(row(page, "Cut box 4"), "the shown step is selected").toHaveAttribute("aria-selected", "true");

  await row(page, "Cut box 8").click();
  await expect(readout(page)).toContainText(volume(8));
  await expect(row(page, "Cut box 8")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "Cut box 4")).toHaveAttribute("aria-selected", "false");
  await expect(row(page, "Cut box 6"), "steps after the shown one are redo").toHaveAttribute("data-state", "redo");
  await expect(row(page, "plate.step"), "the plate still holds the file until Model closes").toContainText("Plate");

  await row(page, "plate.step").click();
  await expect(readout(page)).toContainText(volume(10));
  await expect(page.locator("#modelUndo")).toBeDisabled();
});

test("Up and Down move and show; fast presses show only the last target, and a late reply for an older one is dropped", async ({ page }) => {
  const tree = await openModel(page);
  for (const dx of [9, 8, 7, 6, 5]) await cut(page, dx);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await row(page, "Cut box 5").focus();

  await page.keyboard.press("ArrowUp");
  await expect(row(page, "Cut box 6")).toBeFocused();
  await expect(readout(page)).toContainText(volume(6));
  await expect(row(page, "Cut box 6")).toHaveAttribute("aria-selected", "true");

  for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowUp");
  await expect(row(page, "Cut box 9")).toBeFocused();
  await expect(readout(page)).toContainText(volume(9));
  expect(tree.of("goto").map((request) => request.node), "only the last of the fast presses asks the engine").toEqual([1]);

  await page.keyboard.press("ArrowDown");
  await expect(readout(page)).toContainText(volume(8));

  // The root left the client's recent solids: its reply is slow. A press after it wins.
  const root = await slowGoto(page, 0);
  await page.keyboard.press("Home");
  await expect.poll(() => root.asked).toBe(1);
  await page.keyboard.press("End");
  await expect(readout(page)).toContainText(volume(5));
  await expect.poll(() => root.answered).toBe(1);
  await expect(readout(page), "the root's late reply is not shown").toContainText(volume(5));
  await expect(row(page, "Cut box 5")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "Cut box 5")).toBeFocused();
});

test("a fork draws two rails, and Left and Right switch branches", async ({ page }) => {
  await openModel(page);
  await fork(page);
  await expect(rows(page)).toHaveText([/^plate\.step/, /^Cut box 8/, /^Cut box 6/, /^Cut box 4/]);
  await expect(page.locator("#modelHistoryTree .mh-rail").first(), "two columns of rails").toHaveAttribute("width", "24");
  await expect(row(page, "Cut box 8"), "the fork").toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "Cut box 6"), "the side branch is one level in").toHaveAttribute("aria-level", "2");
  await expect(row(page, "Cut box 4")).toHaveAttribute("aria-level", "1");
  await expect(row(page, "Cut box 6")).toHaveAttribute("data-state", "other");

  await row(page, "Cut box 4").focus();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "Cut box 6")).toBeFocused();
  await expect(readout(page)).toContainText(volume(6));
  await expect(row(page, "Cut box 6")).toHaveAttribute("aria-selected", "true");
  await expect(rows(page), "rows stay put while the keys are in the list").toHaveText([/^plate\.step/, /^Cut box 8/, /^Cut box 6/, /^Cut box 4/]);
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "Cut box 4")).toBeFocused();
  await expect(readout(page)).toContainText(volume(4));
  await page.keyboard.press("ArrowRight");
  await expect(readout(page)).toContainText(volume(6));

  await page.keyboard.press("Escape");
  await expect(rows(page), "then the shown branch takes the main rail").toHaveText([/^plate\.step/, /^Cut box 8/, /^Cut box 4/, /^Cut box 6/]);
  await expect(row(page, "Cut box 4")).toHaveAttribute("aria-level", "2");
  await expect(row(page, "Cut box 6")).toHaveAttribute("aria-level", "1");

  await page.keyboard.press("Shift+H");
  await expect(row(page, "Cut box 6")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#modelHistoryTree"), "the pause ran out").not.toHaveAttribute("aria-busy", "true");
  await expect(readout(page), "Right then Left inside the pause lands where it started").toContainText(volume(6));
});

test("a step can be renamed, and keeps its op in the tip", async ({ page }) => {
  await openModel(page);
  await fork(page);
  await row(page, "Cut box 6").locator(".mh-label").dblclick();
  const field = page.getByRole("textbox", { name: "Step name" });
  await expect(field).toBeFocused();
  await field.fill("Slot for the clip");
  await field.press("Enter");
  await expect(row(page, "Slot for the clip")).toBeFocused();
  await expect(row(page, "Slot for the clip")).toHaveAttribute("data-tip", "Slot for the clip. Cut box 6×10×10");
  await expect(readout(page), "the first click of the double-click showed the step").toContainText(volume(6));

  await page.keyboard.press("F2");
  await page.getByRole("textbox", { name: "Step name" }).fill("Ignored");
  await page.keyboard.press("Escape");
  await expect(row(page, "Slot for the clip")).toBeVisible();

  await page.keyboard.press("F2");
  await page.getByRole("textbox", { name: "Step name" }).fill("");
  await page.keyboard.press("Enter");
  await expect(row(page, "Cut box 6"), "an unnamed step has its whole label in the tip").toHaveAttribute("data-tip", "Cut box 6×10×10");
});

test("steps named texture 1/n through n/n fold into one row, and undo skips the run", async ({ page }) => {
  await openModel(page);
  await cut(page, 8);
  await cut(page, 6);
  await cut(page, 4);
  for (const [label, name] of [["Cut box 8", "texture 1/3"], ["Cut box 6", "texture 2/3"], ["Cut box 4", "texture 3/3"]] as const) {
    await row(page, label).locator(".mh-label").dblclick();
    const field = page.getByRole("textbox", { name: "Step name" });
    await expect(field).toBeFocused();
    await field.fill(name);
    await field.press("Enter");
  }
  const folded = row(page, "texture · 3 steps");
  await expect(folded).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(folded).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#modelHistoryCount")).toHaveText("· 4");

  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText(`${volume(10)}. texture · 3 steps undone.`);
  await expect(folded).toHaveAttribute("data-state", "redo");
  await page.locator("#modelRedo").click();
  await expect(readout(page)).toContainText(`${volume(4)}. texture · 3 steps redone.`);
  await expect(folded).toHaveAttribute("aria-selected", "true");

  await folded.locator(".mh-fold").click();
  await expect(rows(page)).toHaveCount(4);
  await expect(row(page, "texture 1/3")).toBeVisible();
  await expect(row(page, "texture 3/3")).toHaveAttribute("aria-selected", "true");
  await row(page, "texture 1/3").locator(".mh-fold").click();
  await expect(rows(page)).toHaveCount(2);
  await expect(folded).toBeVisible();
});

test("deleting a branch drops it here and in the engine; the shown branch stays with a plain reason", async ({ page }) => {
  const tree = await openModel(page);
  await fork(page);
  await row(page, "Cut box 8").focus();
  await page.keyboard.press("Delete");
  await expect(readout(page)).toHaveText("The step on screen is on this branch. Go to another branch first.");
  await expect(rows(page)).toHaveCount(4);

  await row(page, "Cut box 8").locator(".mh-more").click();
  const remove = page.getByRole("menuitem", { name: /Delete branch/ });
  await expect(remove).toHaveAttribute("aria-disabled", "true");
  await expect(remove).toContainText("The step on screen is on this branch.");
  await page.keyboard.press("Escape");
  await expect(row(page, "Cut box 8")).toBeFocused();

  await row(page, "Cut box 6").locator(".mh-more").click();
  await expect(remove).toHaveAttribute("aria-disabled", "false");
  await remove.click();
  await expect(rows(page)).toHaveText([/^plate\.step/, /^Cut box 8/, /^Cut box 4/]);
  expect(tree.of("drop").map((request) => request.node), "the engine drops the branch").toEqual([2]);
  await expect(page.locator("#modelHistoryTree .mh-rail").first(), "one rail again").toHaveAttribute("width", "12");
  await expect(readout(page)).toContainText(volume(4));

  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText(volume(8));
  await row(page, "Cut box 4").focus();
  await page.keyboard.press("Delete");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator("#modelRedo"), "nothing left to redo").toBeDisabled();
});

test("the panel collapses to one row, stays collapsed, and catches up when opened", async ({ page }) => {
  await openModel(page);
  await cut(page, 8);
  const toggle = page.locator("#modelHistoryToggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#modelHistoryTree")).toBeHidden();
  await expect(toggle).toHaveText("History · 2");
  expect(await page.evaluate(() => localStorage.getItem("lime-slice-model-history-collapsed"))).toBe("1");

  await cut(page, 6);
  await expect(toggle, "the count follows").toHaveText("History · 3");
  await expect(rows(page), "no rows are built while collapsed").toHaveCount(2);

  await page.locator("#tabPrepare").click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(rows(page)).toHaveCount(3);
  await expect(row(page, "Cut box 6")).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => localStorage.getItem("lime-slice-model-history-collapsed"))).toBeNull();
});

test("Shift+H reaches the panel from the canvas, roles and names are in place, and Esc leaves", async ({ page }) => {
  const mock = await openModel(page);
  await fork(page);
  await page.locator("#modelHistoryToggle").click();
  await page.locator("#model").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+H");
  const tree = page.getByRole("tree", { name: "Model history" });
  await expect(tree).toBeVisible();
  await expect(row(page, "Cut box 4")).toBeFocused();
  await expect(tree.getByRole("treeitem")).toHaveCount(4);
  await expect(tree.locator('[role=treeitem][aria-selected="true"]')).toHaveCount(1);
  await expect(tree.locator('[role=treeitem][tabindex="0"]'), "one row in the tab order").toHaveCount(1);
  for (const item of await tree.getByRole("treeitem").all()) {
    await expect(item).toHaveAttribute("aria-level", /^[12]$/);
    await expect(item).toHaveAttribute("aria-label", /\S/);
  }
  await expect(page.getByRole("button", { name: /^History/ })).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.press("ArrowUp");
  await expect(row(page, "Cut box 6")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row(page, "Cut box 6")).not.toBeFocused();
  await expect(readout(page), "Esc shows the step the keys were on").toContainText(volume(6));
  await expect(page.locator("#modelPanel"), "and leaves the tool alone").toBeHidden();
  await page.locator("#modelToolBoolean").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.keyboard.press("Shift+H");
  await expect(row(page, "Cut box 6")).toBeFocused();
  const before = await readout(page).textContent();
  await page.keyboard.press("Enter");
  expect(await readout(page).textContent(), "Enter in the panel is not Apply, which would say it is editing at once").toBe(before);
  expect(mock.of("apply"), "the three cuts only").toHaveLength(3);
});

test("a branch the plate held stays, so Prepare undo can still find its step and the tree keeps its other branches", async ({ page }) => {
  const tree = await openModel(page);
  await cut(page, 8);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj").first()).toContainText("20 × 20 × 8");
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(8));
  await row(page, "plate.step").click();
  await expect(readout(page)).toContainText(volume(10));
  await cut(page, 6);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj").first()).toContainText("20 × 20 × 6");

  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(6));
  await row(page, "Cut box 8").focus();
  await page.keyboard.press("Delete");
  await expect(readout(page)).toHaveText("The plate held a step on this branch, and Prepare undo can bring it back.");
  await expect(rows(page)).toHaveCount(3);
  expect(tree.of("drop")).toHaveLength(0);

  await page.locator("#tabPrepare").click();
  await page.keyboard.press("Control+z");
  await expect(page.locator("#objectList .obj").first()).toContainText("20 × 20 × 8");
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(volume(8));
  await expect(rows(page), "both branches are still there").toHaveCount(3);
  expect(tree.of("close"), "no tree was closed").toHaveLength(0);
  expect(tree.of("open"), "and none read again").toHaveLength(1);
});

test("a step already on its way is not asked for again, and Apply and STEP wait for it", async ({ page }) => {
  const tree = await openModel(page);
  for (const dx of [9, 8, 7, 6, 5]) await cut(page, dx);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelDx").fill("3");
  await expect(page.locator("#modelApply")).toBeEnabled();
  const slow = await slowGoto(page, 1);
  await row(page, "Cut box 9").click();
  await expect.poll(() => slow.asked).toBe(1);
  await expect(page.locator("#modelApply"), "Apply waits for the step on its way").toBeDisabled();
  await expect(page.locator("#modelStep"), "so does STEP").toBeDisabled();
  await row(page, "Cut box 9").click();
  await page.keyboard.press("Escape");
  await expect(readout(page)).toContainText(volume(9));
  await expect(page.locator("#modelApply")).toBeEnabled();
  await expect(page.locator("#modelStep")).toBeEnabled();
  expect(tree.of("goto").filter((request) => request.node === 1), "one ask for the step").toHaveLength(1);
});

test("an arrow press just before leaving Model does not move the step the plate took", async ({ page }) => {
  await openModel(page);
  await cut(page, 8);
  await cut(page, 6);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await row(page, "Cut box 6").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("1");
  await expect(page.locator("#prepareBody")).toBeVisible();
  await expect(page.locator("#objectList .obj").first()).toContainText("20 × 20 × 6");
  await expect(page.locator("#modelHistoryTree"), "the arrow's pause ran out").not.toHaveAttribute("aria-busy", "true");
  await plateClick(page, "duplicate");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await expect(page.locator("#objectList .obj").first(), "the plate keeps the step it took on leaving").toContainText("20 × 20 × 6");
});

test("the row menu closes when Model closes", async ({ page }) => {
  await openModel(page);
  await fork(page);
  await row(page, "Cut box 6").locator(".mh-more").click();
  const menu = page.getByRole("menu", { name: "Step" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("1");
  await expect(page.locator("#prepareBody")).toBeVisible();
  await page.keyboard.press("4");
  await expect(readout(page)).toContainText(volume(4));
  await expect(menu).toBeHidden();
});

type Rect = { x: number; y: number; width: number; height: number };
const meets = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const inside = (a: Rect, b: Rect) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;

/** A part past the build volume, with a long file name, so the size chip warns over several lines. */
const BIG = boxSolid([400, 300, 120]);
const LONG_NAME = "20261012_Cover_Assembly_With_A_Very_Long_File_Name_full_revision_C.stp";
const REFUSAL =
  "The box reaches past the solid on two sides, so the cut would leave a thin wall that cannot be printed. Move the box into the part, or make it smaller, and try again.";

async function openBig(page: Page, url = "/") {
  return openModel(page, url, {
    root: BIG,
    name: LONG_NAME,
    apply: (request: Body) => {
      const dx = (request.op as { size: number[] }).size[0]!;
      return dx === 9 ? { error: REFUSAL } : boxSolid([400, 300, dx * 10]);
    },
  });
}

/** Three cuts and a refusal: four rows, a warning in the chip, and a long readout. */
async function longStack(page: Page) {
  for (const dx of [3, 4, 5, 9]) {
    // Apply ends the tool; the refused last one leaves it open.
    await page.locator("#modelToolBoolean").click();
    await page.locator("#modelDx").fill(String(dx));
    await expect(page.locator("#modelApply")).toBeEnabled();
    await page.locator("#modelApply").click();
    await expect(readout(page)).toContainText(dx === 9 ? REFUSAL : `Volume ${400 * 300 * dx * 10} mm³`);
  }
  await expect(page.locator("#modelFit")).toHaveAttribute("data-over", "1");
}

/**
 * E3. The panel and History share the Model dock and the readout and the size warning share the status line: no two of
 * them overlap, none sits over the view, each stays in its own place, and the readout shows all its text.
 */
async function expectStackClear(page: Page) {
  const canvas = (await page.locator("#model").boundingBox())!;
  const dock = (await page.locator("#leftDock").boundingBox())!;
  const status = (await page.locator("footer.status").boundingBox())!;
  const parts = new Map<string, Rect>();
  for (const id of ["#modelPanel", "#modelHistory", "#modelFitWarn", "#modelReadout"]) {
    const box = (await page.locator(id).isVisible()) ? await page.locator(id).boundingBox() : null;
    if (box) parts.set(id, box);
  }
  expect([...parts.keys()]).toEqual(expect.arrayContaining(["#modelHistory", "#modelFitWarn", "#modelReadout"]));
  const list = [...parts];
  for (let i = 0; i < list.length; i += 1) {
    const [id, box] = list[i]!;
    expect(meets(box, canvas), `${id} stays off the view`).toBe(false);
    expect(inside(box, id === "#modelPanel" || id === "#modelHistory" ? dock : status), `${id} stays in its place`).toBe(true);
    for (let j = i + 1; j < list.length; j += 1) expect(meets(box, list[j]![1]), `${id} clear of ${list[j]![0]}`).toBe(false);
  }
  const clipped = await readout(page).locator(".model-readout-text").evaluate((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
  expect(clipped, "the readout shows all its text").toBe(false);
}

test("History, the size warning, and a long readout stay clear of each other and of the view, on a tall window and a short one", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBig(page);
  await longStack(page);
  await expect(rows(page)).toHaveCount(4);
  await expectStackClear(page);
  await page.locator("#modelCancel").click();
  await expectStackClear(page);

  await page.setViewportSize({ width: 1280, height: 640 });
  await expectStackClear(page);
  // A short window folds the Combine group: its button opens it beside the rail.
  await railClick(page, "#modelToolBoolean");
  await expect(page.locator("#modelPrim")).toBeVisible();
  await expectStackClear(page);
  const tree = (await page.locator("#modelHistoryTree").boundingBox())!;
  expect(tree.height, "History keeps room for its rows, scrolling inside").toBeGreaterThan(20);

  const root = row(page, "20261012_Cover");
  await expect(root, "the long file name is whole in the tip").toHaveAttribute("data-tip", LONG_NAME);
  const label = root.locator(".mh-label");
  expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth), "and ellipsized in the row").toBe(true);
  const panel = (await page.locator("#modelHistory").boundingBox())!;
  // E3. History is the Model dock's width, which a long name does not widen.
  expect(panel.width, "without widening the panel").toBeLessThanOrEqual((await page.locator("#leftDock").boundingBox())!.width);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("History is a sheet opened from the Model toolbar", async ({ page }) => {
    await openModel(page, "/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await cut(page, 8);
    await cut(page, 6);
    await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
    const open = page.locator("#modelHistoryOpen");
    await expect(open).toBeVisible();
    await expect(page.locator("#modelHistory")).toBeHidden();
    await open.click();
    await expect(open).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#modelHistory")).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
    await expect(page.locator("#slice"), "the sheet covers Slice's corner").toBeHidden();
    const box = (await page.locator("#modelHistory").boundingBox())!;
    expect(box.width, "full width").toBeGreaterThan(380);

    await row(page, "Cut box 8").tap();
    await expect(readout(page)).toContainText(volume(8));
    await page.locator("#modelHistoryToggle").tap();
    await expect(page.locator("#modelHistory")).toBeHidden();
    await expect(open).toBeFocused();
    await expect(page.locator("#slice")).toBeVisible();
  });

  test("the open sheet leaves the size warning and the readout in view", async ({ page }) => {
    await openBig(page, "/?layout=compact");
    await longStack(page);
    await page.locator("#modelCancel").click();
    await page.locator("#modelHistoryOpen").click();
    await expect(rows(page)).toHaveCount(4);
    const sheet = (await page.locator("#modelHistory").boundingBox())!;
    const fit = (await page.locator("#modelFitWarn").boundingBox())!;
    const text = (await readout(page).boundingBox())!;
    expect(meets(sheet, fit), "the sheet leaves the size warning").toBe(false);
    expect(meets(sheet, text), "and the readout").toBe(false);
    expect(meets(fit, text), "which do not overlap each other").toBe(false);
  });

  test("on a short landscape phone the sheet shrinks below the warning, and the readout stays short of the dock", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openBig(page, "/?layout=compact");
    await longStack(page);
    const canvas = (await page.locator("#model").boundingBox())!;
    const fit = (await page.locator("#modelFitWarn").boundingBox())!;
    const text = (await readout(page).boundingBox())!;
    const grips = ((await page.locator("#model").getAttribute("data-handles")) ?? "").split(" ").filter(Boolean).map((item) => canvas.x + Number(item.split(":")[1]!.split(",")[0]));
    expect(grips.length, "the Boolean tool's dock is up").toBeGreaterThan(0);
    for (const box of [fit, text]) expect(box.x + box.width, "the chip and the readout end left of the dock").toBeLessThan(Math.min(...grips) - 8);
    await page.locator("#modelCancel").click();
    await page.locator("#modelHistoryOpen").click();
    await expect(rows(page)).toHaveCount(4);
    const sheet = (await page.locator("#modelHistory").boundingBox())!;
    expect(meets(sheet, fit), "the sheet leaves the size warning").toBe(false);
    expect(meets(sheet, text), "and the readout").toBe(false);
    expect(sheet.height, "and keeps room for a row").toBeGreaterThan(60);
  });
});
