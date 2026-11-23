import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";
import { unpackLime } from "./lime-file";
import { plateClick } from "./plate-rows";

type V = [number, number, number];

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
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, face) => ({ id: face, areaMm2: 0 })), edges: [] };
}

type Grid = V[][];

/** An open sheet over the grid's corners, as the kernel answers a NURBS root: one face, four open edges. */
function sheetOf(poles: Grid): MockSolid {
  const a = poles[0]![0]!;
  const b = poles.at(-1)![0]!;
  const c = poles.at(-1)!.at(-1)!;
  const d = poles[0]!.at(-1)!;
  const edge = (id: number, p: V, q: V) => ({ id, lengthMm: Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]), points: [...p, ...q] });
  return {
    volumeMm3: 0,
    positions: [...a, ...b, ...c, ...a, ...c, ...d],
    triangles: [0, 0],
    faces: [{ id: 0, areaMm2: 4900 }],
    edges: [edge(0, a, b), edge(1, b, c), edge(2, c, d), edge(3, d, a)],
    solid: false,
    nakedEdges: [0, 1, 2, 3],
  };
}

interface Sculpt {
  tree: TreeMock;
  /** Every `open` of a NURBS root, in order. */
  nurbsOpens(): Body[];
  /** Set to refuse NURBS opens with this sentence: every one, or only the grids `when` picks. */
  refuse: { with: string | null; when?: (poles: Grid) => boolean };
}

const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
const REFUSAL = "This NURBS surface could not be built.";

async function start(page: Page): Promise<Sculpt> {
  const refuse: Sculpt["refuse"] = { with: null };
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid([20, 20, 10]).positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open(request) {
      const feature = request.feature as { kind?: string; poles?: Grid } | undefined;
      if (feature?.kind === "nurbsSurface") return refuse.with && (!refuse.when || refuse.when(feature.poles!)) ? { error: refuse.with } : sheetOf(feature.poles!);
      return boxSolid([20, 20, 10]);
    },
    apply: (request, parent) => ((request.op as { kind?: string }).kind === "thicken" ? boxSolid([70, 70, 2]) : parent),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  const nurbsOpens = () => tree.of("open").filter((request) => (request.feature as { kind?: string } | undefined)?.kind === "nurbsSurface");
  return { tree, nurbsOpens, refuse };
}

async function openTool(page: Page) {
  // Model has a part on screen first: a tool opened before it lands is closed by its arrival.
  await expect(page.locator("#model")).toHaveAttribute("data-shape-kind", /sheet|solid/);
  await expect(page.locator("#modelReadout")).not.toContainText(/Rebuilding|Opening|Reading/);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.locator("#modelNurbsNote").isVisible()) return;
    if (await page.locator("#modelToolNurbs").isVisible()) await page.locator("#modelToolNurbs").click();
    else {
      await page.locator("#modelFeatureMore").click();
      await page.locator("#modelFeatureMenu [data-tool=sculpt]").click();
    }
    try {
      await expect(page.locator("#modelNurbsNote")).toBeVisible({ timeout: 3000 });
      return;
    } catch {
      // Closed again by a part that arrived meanwhile: open it once more.
    }
  }
  await expect(page.locator("#modelNurbsNote")).toBeVisible();
}

/** From a box part: the tool says there is no surface, and New NURBS surface makes one, as a new object. */
async function newSurface(page: Page, sculpt: Sculpt) {
  await openTool(page);
  await expect(page.locator("#modelNurbsNote")).toContainText("no NURBS surface");
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]")).toHaveCount(0);
  const before = sculpt.nurbsOpens().length;
  await page.locator("#modelNurbsNew").click();
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(before + 1);
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]")).toHaveCount(64);
}

const canvas = (page: Page) => page.locator("#model");
const pole = (page: Page, iu: number, iv: number) => page.locator(`#modelNurbsOverlay [data-nurbs-iu="${iu}"][data-nurbs-iv="${iv}"]`);
/** Select a pole from the keyboard, as Enter on its handle does: handles can sit close together on screen. */
async function select(page: Page, iu: number, iv: number) {
  await pole(page, iu, iv).focus();
  await page.keyboard.press("Enter");
  await expect(pole(page, iu, iv)).toHaveAttribute("aria-pressed", "true");
}
const axis = (page: Page, which: string) => page.locator(`#modelNurbsOverlay [data-cv-axis="${which}"]`);
const shownPole = async (page: Page) => ((await canvas(page).getAttribute("data-nurbs-pole")) ?? "").split(",").map(Number);
const lastGrid = (sculpt: Sculpt) => (sculpt.nurbsOpens().at(-1)!.feature as { poles: Grid }).poles;

/** Drag an axis handle by (dx, dy) pixels, in steps, and let go. */
async function dragAxis(page: Page, which: string, dx: number, dy: number, release = true) {
  const box = (await axis(page, which).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  expect(await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.dataset.cvAxis ?? "", { x, y }), "the handle is on top where it is pressed").toBe(which);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) await page.mouse.move(x + (dx * i) / 6, y + (dy * i) / 6);
  if (release) await page.mouse.up();
}

test("the tool edits a NURBS object reopened from a saved project: a drag sends that object's grid, and Undo puts it back in one step", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  // Save, then open the project in a fresh page.
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  const saved = await readFile((await download.path())!);
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "surface.lime", mimeType: "application/json", buffer: saved });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await page.locator("#objectList .obj").nth(1).click();
  await page.locator("#tabModel").click();
  await openTool(page);
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]"), "the saved surface's own 8 × 8 grid").toHaveCount(64);
  await expect(canvas(page)).toHaveAttribute("data-nurbs-grid", "8x8");
  // The project gives each tree a new key; the reopened surface's is the key Model opened it under.
  const reopened = sculpt.tree.of("open").at(-1)!;
  expect(reopened.feature ?? reopened.filename, "Model opened the saved surface").toBeTruthy();
  const opensBefore = sculpt.nurbsOpens().length;
  await select(page, 2, 3);
  expect((await shownPole(page))[2]).toBe(0);
  await dragAxis(page, "z", 0, -60);
  await expect.poll(() => sculpt.nurbsOpens().length, "one commit for the drag").toBe(opensBefore + 1);
  await expect(page.locator("#objectList .obj"), "no new object").toHaveCount(2);
  const sent = sculpt.nurbsOpens().at(-1)!;
  expect(sent.key, "the same object's tree").toBe(reopened.key);
  const grid = lastGrid(sculpt);
  expect(grid[2]![3]![2], "the dragged pole went up").toBeGreaterThan(1);
  let others = 0;
  grid.forEach((row, iu) => row.forEach((p, iv) => {
    if (iu !== 2 || iv !== 3) others = Math.max(others, Math.abs(p[2]));
  }));
  expect(others, "no other pole moved").toBe(0);
  await expect.poll(async () => (await shownPole(page))[2]).toBeCloseTo(grid[2]![3]![2], 6);
  await expect(page.locator("#modelUndo")).toBeEnabled();
  await page.locator("#modelUndo").click();
  await expect.poll(() => sculpt.nurbsOpens().length, "Undo is one rebuild").toBe(opensBefore + 2);
  expect(lastGrid(sculpt)[2]![3]![2], "Undo sends the grid from before the drag").toBe(0);
  await expect.poll(async () => (await shownPole(page))[2]).toBe(0);
  await expect(page.locator("#modelRedo")).toBeEnabled();
  await page.locator("#modelRedo").click();
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(opensBefore + 3);
  expect(lastGrid(sculpt)[2]![3]![2]).toBeCloseTo(grid[2]![3]![2], 9);
});

test("a refused commit snaps back with the kernel's sentence, and Escape cancels a drag", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  await select(page, 4, 4);
  const before = await shownPole(page);
  // Only the edited grid is refused: the old one opens again, as the kernel would build it.
  sculpt.refuse.with = REFUSAL;
  sculpt.refuse.when = (poles) => poles[4]![4]![2] !== 0;
  const opens = sculpt.nurbsOpens().length;
  await dragAxis(page, "z", 0, -50);
  await expect(page.locator("#modelReadout")).toContainText(REFUSAL);
  await expect.poll(async () => (await shownPole(page))[2], "the preview is back on the last built grid").toBe(before[2]);
  await expect.poll(() => sculpt.nurbsOpens().length, "the refused grid, then the old one again").toBe(opens + 2);
  expect(lastGrid(sculpt)[4]![4]![2], "the part was rebuilt on the old grid").toBe(0);
  await expect(page.locator("#modelHistoryTree .mh-row").filter({ hasText: "NURBS" }), "its history is whole").toHaveCount(1);
  sculpt.refuse.with = null;
  // Escape mid-drag: nothing is sent and the pole goes back.
  const sent = sculpt.tree.calls.length;
  await dragAxis(page, "z", 0, -50, false);
  await expect.poll(async () => (await shownPole(page))[2], "the drag moved the pole").toBeGreaterThan(before[2]! + 1);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(async () => (await shownPole(page))[2]).toBe(before[2]);
  await expect(page.locator("#modelNurbsOverlay [data-cv-axis=z]"), "Escape ended the drag, not the tool").toBeVisible();
  await page.waitForTimeout(300);
  expect(sculpt.tree.calls.length, "a cancelled drag sends nothing").toBe(sent);
});

test("on a moved and turned object, a drag moves the pole in the object's own frame", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  // Turn the new object 90° about Z and move it.
  if (!(await page.locator("#modelToolPlace").isVisible())) await page.locator('.rail-group[data-group="frame"] .rail-fold').click();
  await page.locator("#modelToolPlace").click();
  await expect(page.locator("#modelPlaceRz")).toBeVisible();
  for (const [id, value] of [["#modelPlaceRz", 90], ["#modelPlaceX", 30]] as const) {
    await page.locator(id).fill(String(value));
    await page.locator(id).press("Tab");
  }
  await openTool(page);
  await select(page, 5, 2);
  const before = await shownPole(page);
  expect(before).toEqual([15, -15, 0]);
  // The handles are drawn where the turned part puts them: the X handle's pole is not at its unturned place.
  const opens = sculpt.nurbsOpens().length;
  // Drag along the part's X as the screen shows it: from the pole toward pole (6, 2), one pole further along X.
  const from = (await pole(page, 5, 2).boundingBox())!;
  const to = (await pole(page, 6, 2).boundingBox())!;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  await dragAxis(page, "x", dx, dy);
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(opens + 1);
  const sent = lastGrid(sculpt)[5]![2]!;
  expect(sent[1], "Y in the part's frame is unchanged").toBe(-15);
  expect(sent[2], "Z in the part's frame is unchanged").toBe(0);
  // One pole spacing on screen is about 10 mm along the part's X.
  expect(sent[0] - 15, "the pole followed the pointer along the part's X").toBeGreaterThan(7);
  expect(sent[0] - 15).toBeLessThan(13);
});

test("symmetry mirrors the move on a symmetric grid, and is off with a reason on an asymmetric one", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  const box = page.locator("#modelNurbsSymmetry");
  await expect(box).toBeEnabled();
  await expect(box, "its name holds its visible label").toHaveAccessibleName(/Symmetry/);
  await box.check();
  await select(page, 1, 2);
  await dragAxis(page, "z", 0, -50);
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(2);
  let grid = lastGrid(sculpt);
  expect(grid[1]![2]![2]).toBeGreaterThan(1);
  expect(grid[6]![2]![2], "the mirror pole moved the same").toBeCloseTo(grid[1]![2]![2], 9);
  expect(grid[1]![2]![0]).toBe(-grid[6]![2]![0]);
  // Without symmetry the same drag breaks it: Symmetry turns off and says why, and Make symmetric is offered.
  await box.uncheck();
  await dragAxis(page, "z", 0, -30);
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(3);
  await expect(box).toBeDisabled();
  await expect(page.locator("#modelNurbsSymmetryNote")).toContainText("not symmetric about the part's X = 0 plane");
  await page.locator("#modelNurbsMakeSymmetric").click();
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(4);
  await expect(box).toBeEnabled();
  grid = lastGrid(sculpt);
  expect(grid[1]![2]![2]).toBeCloseTo(grid[6]![2]![2], 9);
});

test("History Edit on a NURBS root opens the tool on its grid; the Exact NURBS drawer acts on typed values", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]")).toHaveCount(0);
  await page.locator("#modelHistoryTree .mh-row").first().locator(".mh-edit").click();
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]")).toHaveCount(64);
  await page.locator("details:has(#modelNurbsWeight) > summary").click();
  // A weight typed and entered is applied (no click needed).
  await select(page, 3, 3);
  await page.locator("#modelNurbsWeight").fill("2");
  await page.locator("#modelNurbsWeight").press("Enter");
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(2);
  expect((sculpt.nurbsOpens().at(-1)!.feature as { weights?: number[][] }).weights?.[3]?.[3]).toBe(2);
  // Raise U degree: the field shows the new degree and the grid grows as OCCT's IncreaseDegree does.
  await page.locator("#modelNurbsElevateU").click();
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(3);
  await expect(page.locator("#modelNurbsDegreeU")).toHaveValue("4");
  expect(lastGrid(sculpt)).toHaveLength(13);
  // Lowering the degree is refused, and the field shows the real degree again.
  await page.locator("#modelNurbsDegreeU").fill("2");
  await page.locator("#modelNurbsDegreeU").press("Tab");
  await expect(page.locator("#modelReadout")).toContainText("Lowering the degree would move the surface");
  await expect(page.locator("#modelNurbsDegreeU")).toHaveValue("4");
  // Crease V at a typed place.
  await page.locator("#modelNurbsParam").fill("0.3");
  await page.locator("#modelNurbsCreaseV").click();
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(4);
  const sent = sculpt.nurbsOpens().at(-1)!.feature as { knotsV: number[]; multsV: number[] };
  const at = sent.knotsV.findIndex((k) => Math.abs(k - 0.3) < 1e-9);
  expect(sent.multsV[at], "a crease is a knot as many times as the degree").toBe(3);
  // Arrow keys on an axis handle move the selected pole along it; one burst is one commit.
  await axis(page, "z").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(5);
  expect(lastGrid(sculpt)[3]![3]![2], "0.5 + 5 mm up").toBeCloseTo(5.5, 9);
  await expect(axis(page, "z"), "focus stays on the handle").toBeFocused();
  // Arrow keys on a pole handle walk the grid, and the tab stop and focus walk with them.
  await select(page, 3, 3);
  await page.keyboard.press("ArrowRight");
  await expect(pole(page, 4, 3)).toBeFocused();
  await expect(pole(page, 4, 3)).toHaveAttribute("tabindex", "0");
  await expect(page.locator('#modelNurbsOverlay [data-nurbs-iu][tabindex="0"]'), "one tab stop for the poles").toHaveCount(1);
});

test("a drag released while the last commit is still building is committed after it: the kernel ends on the grid drawn", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  // Hold the next NURBS open for a moment, as a slow kernel would.
  let held = 0;
  await page.route("**/api/model/tree", async (route) => {
    const body = route.request().postDataJSON() as Body;
    if (body.call === "open" && (body.feature as { kind?: string } | undefined)?.kind === "nurbsSurface" && held === 0) {
      held += 1;
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    await route.fallback();
  });
  const opens = sculpt.nurbsOpens().length;
  await select(page, 3, 3);
  await dragAxis(page, "z", 0, -40);
  await select(page, 4, 4);
  await dragAxis(page, "z", 0, -60);
  await expect.poll(() => sculpt.nurbsOpens().length, "both drags reach the kernel, in order").toBe(opens + 2);
  const grid = lastGrid(sculpt);
  expect(grid[3]![3]![2]).toBeGreaterThan(1);
  expect(grid[4]![4]![2]).toBeGreaterThan(grid[3]![3]![2]);
  await expect.poll(async () => (await shownPole(page))[2], "what is drawn is what was built").toBeCloseTo(grid[4]![4]![2], 6);
  await page.waitForTimeout(300);
  expect(sculpt.nurbsOpens().length, "nothing more is sent").toBe(opens + 2);
});

test("a drag whose button was let go outside the window ends at the next move, and commits", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  await select(page, 3, 4);
  const opens = sculpt.nurbsOpens().length;
  await dragAxis(page, "z", 0, -40, false);
  // The window never heard the release: the next move comes with no button down.
  await page.evaluate(() => document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, buttons: 0, clientX: 10, clientY: 10, bubbles: true })));
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(opens + 1);
  const z = lastGrid(sculpt)[3]![4]![2];
  expect(z).toBeGreaterThan(1);
  // Later moves no longer drag.
  await page.mouse.move(300, 50);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await shownPole(page))[2]).toBeCloseTo(z, 6);
  expect(sculpt.nurbsOpens().length).toBe(opens + 1);
});

test("a later Thicken is rebuilt on the dragged surface, not dropped", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  await page.keyboard.press("Escape");
  await page.locator("#modelSheetThickenGo").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 9800 mm³");
  await openTool(page);
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]"), "the root's grid, under the Thicken").toHaveCount(64);
  const thicken = sculpt.tree.of("apply").at(-1)!;
  const opens = sculpt.nurbsOpens().length;
  await select(page, 3, 3);
  await dragAxis(page, "z", 0, -40);
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(opens + 1);
  const sent = sculpt.nurbsOpens().at(-1)!;
  const nodes = sent.nodes as { id: number; parent: number; op: { kind: string } }[];
  expect(nodes.map((node) => node.op.kind), "the Thicken goes with the new surface").toEqual(["thicken"]);
  expect(nodes[0]!.id).toBe(thicken.node);
  expect((sent.feature as { poles: Grid }).poles[3]![3]![2]).toBeGreaterThan(1);
  // The view comes back on the Thicken, rebuilt.
  await expect(page.locator("#modelReadout")).toContainText("Surface updated");
  await expect.poll(() => sculpt.tree.of("goto").at(-1)?.node).toBe(thicken.node);
  await expect(page.locator("#modelHistoryTree [role=treeitem]")).toHaveCount(2);
});

test("a later NURBS step: History Edit opens the tool on its own grid, a drag edits it with the Thicken replayed, and Undo goes back", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  await page.keyboard.press("Escape");
  await page.locator("#modelSheetThickenGo").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 9800 mm³");
  // Save, then give the surface a second NURBS step under the Thicken, as a recipe would have built it.
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  const doc = JSON.parse(unpackLime(await readFile((await download.path())!)).toString("utf8")) as { objects: { modelTree?: { rootFeature?: { kind?: string }; nodes: Body[]; current: number; committed: number; nextId: number } }[] };
  const holder = doc.objects.find((obj) => obj.modelTree?.rootFeature?.kind === "nurbsSurface")!.modelTree!;
  const [root, thicken] = holder.nodes as [Body, Body];
  const raised = { kind: "nurbsSurface", poles: Array.from({ length: 8 }, (_, iu) => Array.from({ length: 8 }, (_, iv) => [(iu - 3.5) * 10, (iv - 3.5) * 10, 20])), degreeU: 3, degreeV: 3 };
  holder.nodes = [root, { id: 1, parent: 0, op: raised, fingerprint: null }, { ...thicken, id: 2, parent: 1 }];
  holder.current = 2;
  holder.committed = 2;
  holder.nextId = 3;
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "steps.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await page.locator("#objectList .obj").nth(1).click();
  await page.locator("#tabModel").click();
  const stepRow = page.locator("#modelHistoryTree .mh-row").filter({ hasText: "NURBS" }).nth(1);
  await stepRow.locator(".mh-edit").click();
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]"), "the step's grid, not the root's").toHaveCount(64);
  await select(page, 3, 3);
  expect((await shownPole(page))[2], "the step's own poles").toBe(20);
  const edits = sculpt.tree.of("edit").length;
  await dragAxis(page, "z", 0, -40);
  await expect.poll(() => sculpt.tree.of("edit").length).toBe(edits + 1);
  const sent = sculpt.tree.of("edit").at(-1)!;
  expect(sent.parent, "a sibling of the step, on the root").toBe(0);
  expect((sent.op as { poles: Grid }).poles[3]![3]![2]).toBeGreaterThan(21);
  expect((sent.replay as { op: { kind: string } }[]).map((step) => step.op.kind), "the Thicken replays on it").toEqual(["thicken"]);
  await expect(page.locator("#modelReadout")).toContainText("Surface updated");
  await page.locator("#modelUndo").click();
  await expect.poll(() => sculpt.tree.of("goto").at(-1)?.node, "Undo shows the branch from before the drag").toBe(2);
  await expect.poll(async () => (await shownPole(page))[2]).toBe(20);
});

type SavedTree = { rootFeature?: { kind?: string; poles?: Grid }; nodes: Body[]; current: number; committed: number; nextId: number };
type SavedDoc = { objects: { name?: string; mesh?: { bytesBase64?: string }; modelTree?: SavedTree }[] };

/** Save from Prepare, as the app writes the file, and the file unpacked for reading. */
async function saveDoc(page: Page): Promise<{ raw: Buffer; doc: SavedDoc }> {
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile((await download.path())!);
  return { raw, doc: JSON.parse(unpackLime(raw).toString("utf8")) as SavedDoc };
}

/** Open `file` on a fresh page, then the NURBS part (the second object) in Model. */
async function reopen(page: Page, file: Buffer) {
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "surface.lime", mimeType: "application/json", buffer: file });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await page.locator("#objectList .obj").nth(1).click();
  await page.locator("#tabModel").click();
}

/** The largest Z of a binary STL, base64. */
function stlTopZ(b64: string): number {
  const bytes = Buffer.from(b64, "base64");
  const count = bytes.readUInt32LE(80);
  let top = Number.NEGATIVE_INFINITY;
  for (let t = 0; t < count; t += 1) for (let k = 0; k < 3; k += 1) top = Math.max(top, bytes.readFloatLE(84 + t * 50 + 12 + k * 12 + 8));
  return top;
}

test("Undo takes a drag and a later Thicken back in the order they were made, and an edit after an Undo cannot bring the drag back", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  await select(page, 3, 3);
  await dragAxis(page, "z", 0, -40);
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(2);
  const dragged = lastGrid(sculpt)[3]![3]![2];
  await page.keyboard.press("Escape");
  await page.locator("#modelSheetThickenGo").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 9800 mm³");
  // Scenario 1: the first Undo takes the Thicken back, not the drag.
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelSheetThickenGo"), "the sheet is back").toBeVisible();
  expect(sculpt.nurbsOpens().length, "the grid was not rebuilt").toBe(2);
  // The second takes the drag back.
  await page.locator("#modelUndo").click();
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(3);
  expect(lastGrid(sculpt)[3]![3]![2]).toBe(0);
  // Redo in the same order: the drag, then the Thicken.
  await page.locator("#modelRedo").click();
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(4);
  expect(lastGrid(sculpt)[3]![3]![2]).toBeCloseTo(dragged, 9);
  await page.locator("#modelRedo").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 9800 mm³");
  expect(sculpt.nurbsOpens().length, "Redo of the Thicken rebuilt no grid").toBe(4);

  // Scenario 2: Undo back past the drag, then another edit: Redo is that edit's, and the drag stays undone.
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelSheetThickenGo")).toBeVisible();
  await page.locator("#modelUndo").click();
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(5);
  expect(lastGrid(sculpt)[3]![3]![2]).toBe(0);
  await page.locator("#modelSheetThickenMm").fill("3");
  await page.locator("#modelSheetThickenGo").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 9800 mm³");
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelSheetThickenGo")).toBeVisible();
  await page.locator("#modelRedo").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 9800 mm³");
  expect(sculpt.nurbsOpens().length, "the old drag did not come back").toBe(5);
});

test("a dragged surface goes to Prepare as a sheet and comes back to Model with its grid; save and reopen keep both", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  // A corner pole: the mocked kernel's sheet spans the corners, so the plate mesh shows the drag.
  await select(page, 0, 0);
  await dragAxis(page, "z", 0, -60);
  await expect.poll(() => sculpt.nurbsOpens().length).toBe(2);
  const z = lastGrid(sculpt)[0]![0]![2];
  expect(z).toBeGreaterThan(1);
  await expect(canvas(page), "the part itself shows once the grid is built").not.toHaveAttribute("data-nurbs-density", /./);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj-sheet"), "Prepare marks the sheet").toHaveCount(1);
  await page.locator("#tabModel").click();
  await openTool(page);
  await select(page, 0, 0);
  await expect.poll(async () => (await shownPole(page))[2], "the dragged grid, back in Model").toBeCloseTo(z, 6);
  await expect(page.locator("#modelHistoryTree .mh-row").filter({ hasText: "NURBS" }), "the NURBS history is whole").toHaveCount(1);
  const { raw, doc } = await saveDoc(page);
  const saved = doc.objects.find((obj) => obj.modelTree?.rootFeature?.kind === "nurbsSurface")!;
  expect(saved.modelTree!.rootFeature!.poles![0]![0]![2], "the file holds the dragged grid").toBeCloseTo(z, 6);
  expect(stlTopZ(saved.mesh!.bytesBase64!), "the plate mesh in the file is the dragged sheet").toBeCloseTo(z, 3);
  await reopen(page, raw);
  await openTool(page);
  await select(page, 0, 0);
  await expect.poll(async () => (await shownPole(page))[2], "the dragged grid, after reopening").toBeCloseTo(z, 6);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj-sheet"), "still a sheet after reopening").toHaveCount(1);
});

test("with the tool open, opening another object follows it at once", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]")).toHaveCount(64);
  await plateClick(page, "select", 0);
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]:visible"), "no handles left on the box").toHaveCount(0);
  await expect(canvas(page)).not.toHaveAttribute("data-nurbs-density", /./);
  await plateClick(page, "select", 1);
  await openTool(page);
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]")).toHaveCount(64);
  await select(page, 5, 2);
  expect(await shownPole(page)).toEqual([15, -15, 0]);
});

/** A saved project whose NURBS part has a second NURBS step under a Thicken (root 0, NURBS step 1, Thicken 2). */
async function stepProject(page: Page): Promise<Buffer> {
  await page.keyboard.press("Escape");
  await page.locator("#modelSheetThickenGo").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 9800 mm³");
  const { doc } = await saveDoc(page);
  const holder = doc.objects.find((obj) => obj.modelTree?.rootFeature?.kind === "nurbsSurface")!.modelTree!;
  const [root, thicken] = holder.nodes as [Body, Body];
  const raised = { kind: "nurbsSurface", poles: Array.from({ length: 8 }, (_, iu) => Array.from({ length: 8 }, (_, iv) => [(iu - 3.5) * 10, (iv - 3.5) * 10, 20])), degreeU: 3, degreeV: 3 };
  holder.nodes = [root, { id: 1, parent: 0, op: raised, fingerprint: null }, { ...thicken, id: 2, parent: 1 }];
  holder.current = 2;
  holder.committed = 2;
  holder.nextId = 3;
  return Buffer.from(JSON.stringify(doc));
}

test("two drags of a later NURBS step, the second released while the first builds: the second edits the step the first made", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  const file = await stepProject(page);
  let held = false;
  await page.route("**/api/model/tree", async (route) => {
    const body = route.request().postDataJSON() as Body;
    if (body.call === "edit" && !held) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    await route.fallback();
  });
  await reopen(page, file);
  await page.locator("#modelHistoryTree .mh-row").filter({ hasText: "NURBS" }).nth(1).locator(".mh-edit").click();
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]")).toHaveCount(64);
  const edits = sculpt.tree.of("edit").length;
  await select(page, 3, 3);
  await dragAxis(page, "z", 0, -30);
  await select(page, 4, 4);
  await dragAxis(page, "z", 0, -50);
  await expect.poll(() => sculpt.tree.of("edit").length).toBe(edits + 2);
  const [first, second] = sculpt.tree.of("edit").slice(-2) as [Body, Body];
  expect(second.parent, "both are siblings on the root").toBe(0);
  const poles = (second.op as { poles: Grid }).poles;
  expect(poles[3]![3]![2], "the second keeps the first drag").toBeCloseTo((first.op as { poles: Grid }).poles[3]![3]![2], 9);
  expect(poles[4]![4]![2]).toBeGreaterThan(21);
  expect((second.replay as { op: { kind: string } }[]).map((step) => step.op.kind), "the Thicken replays on it").toEqual(["thicken"]);
  await expect.poll(async () => (await shownPole(page))[2], "what is drawn is what was built").toBeCloseTo(poles[4]![4]![2], 6);
  // One Undo per drag, newest first.
  await page.locator("#modelUndo").click();
  await expect.poll(async () => {
    await select(page, 4, 4);
    return (await shownPole(page))[2];
  }).toBe(20);
  await select(page, 3, 3);
  expect((await shownPole(page))[2], "the first drag stays").toBeGreaterThan(21);
});

test("a later-step drag released just before another object is opened is kept, and says nothing on the other object", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  const file = await stepProject(page);
  await page.route("**/api/model/tree", async (route) => {
    const body = route.request().postDataJSON() as Body;
    if (body.call === "edit") await new Promise((resolve) => setTimeout(resolve, 900));
    await route.fallback();
  });
  await reopen(page, file);
  await page.locator("#modelHistoryTree .mh-row").filter({ hasText: "NURBS" }).nth(1).locator(".mh-edit").click();
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]")).toHaveCount(64);
  await select(page, 3, 3);
  await dragAxis(page, "z", 0, -40);
  await plateClick(page, "select", 0);
  await expect.poll(() => sculpt.tree.of("edit").length).toBe(1);
  await page.waitForTimeout(1200);
  await expect(page.locator("#modelReadout"), "nothing about the surface on the box").not.toContainText(/surface|changed/i);
  await plateClick(page, "select", 1);
  await expect(page.locator("#modelHistoryTree .mh-row").filter({ hasText: "NURBS" }), "the edit is in the part's history").toHaveCount(3);
});

test("a 64 × 64 grid: handles near the selection only, one tab stop, and Insert past 64 poles refused", async ({ page }) => {
  const sculpt = await start(page);
  await newSurface(page, sculpt);
  const { doc } = await saveDoc(page);
  const holder = doc.objects.find((obj) => obj.modelTree?.rootFeature?.kind === "nurbsSurface")!.modelTree!;
  holder.rootFeature!.poles = Array.from({ length: 64 }, (_, iu) => Array.from({ length: 64 }, (_, iv) => [(iu - 31.5) * 2, (iv - 31.5) * 2, 0] as V));
  await reopen(page, Buffer.from(JSON.stringify(doc)));
  await openTool(page);
  await expect(canvas(page)).toHaveAttribute("data-nurbs-grid", "64x64");
  await expect(page.locator("#modelNurbsOverlay [data-nurbs-iu]"), "a 9 × 9 window of handles").toHaveCount(81);
  await expect(page.locator("#modelNurbsNote")).toContainText("4096 poles");
  await expect(page.locator('#modelNurbsOverlay [data-nurbs-iu][tabindex="0"]')).toHaveCount(1);
  await select(page, 4, 4);
  for (let i = 0; i < 10; i += 1) await page.keyboard.press("Shift+ArrowRight");
  await expect(pole(page, 44, 4), "the window walked with the selection").toBeFocused();
  await page.locator("details:has(#modelNurbsWeight) > summary").click();
  const opens = sculpt.nurbsOpens().length;
  await page.locator("#modelNurbsInsertU").click();
  await expect(page.locator("#modelReadout")).toContainText("at most 64 poles in each direction");
  await page.waitForTimeout(300);
  expect(sculpt.nurbsOpens().length, "nothing sent").toBe(opens);
});
