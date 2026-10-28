import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A box the modeler reports as a solid, from `min`. */
function boxSolid(size: V, min: V = [0, 0, 0]): MockSolid {
  const c = (x: number, y: number, z: number): V => [min[0] + x * size[0], min[1] + y * size[1], min[2] + z * size[2]];
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
  return { volumeMm3: size[0] * size[1] * size[2], positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

/** The box a mock solid spans. */
function boxOf(solid: MockSolid): { min: V; max: V } {
  const min: V = [Infinity, Infinity, Infinity];
  const max: V = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < solid.positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, solid.positions[i + k]!);
      max[k] = Math.max(max[k]!, solid.positions[i + k]!);
    }
  }
  return { min, max };
}

/** A 500 mm bar: the Lime 220's 210 mm usable length takes three pieces. */
const BAR = boxSolid([500, 20, 20]);
const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");

type Placed = { id: string; type: string };
type Cut = { origin: V; normal: V; connectors?: { on?: boolean; placed?: Placed[] } };

/** A 500 mm bar 60 mm wide: four dowels typed across its section, at four diameters' pitch, leave two that fit. */
const WIDE = boxSolid([500, 60, 20]);

/** The connectors a stored op placed, every cut's, as the kernel would build them all. */
const placedOf = (cuts: Cut[]) => cuts.flatMap((cut) => (cut.connectors?.on ? (cut.connectors.placed ?? []) : []));

/** The pins of `count` dowels: 6 × 6 × 8 mm posts standing in a row, as one solid. */
function pinsSolid(count: number): MockSolid {
  const posts = Array.from({ length: count }, (_, at) => boxSolid([6, 6, 8], [at * 9, 40, 0]));
  return {
    volumeMm3: posts.reduce((sum, post) => sum + post.volumeMm3, 0),
    positions: posts.flatMap((post) => post.positions),
    triangles: posts.flatMap((post, at) => post.triangles.map((face) => face + 6 * at)),
    faces: posts.flatMap((post, at) => post.faces.map((face) => ({ ...face, id: face.id + 6 * at }))),
    edges: [],
  };
}

/** A 400 mm tall column: the Form 4 builds 210 mm, so it takes three pieces across Z. */
const COLUMN = boxSolid([20, 20, 400]);

/** The Telo's cut: 680 mm along Y, which is 7 pieces against the Form 4's 125 mm depth and 4 once the bar stands in its 210 mm height. */
const LONG_BAR = boxSolid([97, 680, 150]);

/** The boxes between the cuts across the axis they are square to, as the kernel orders them: negative side first. */
function piecesOf(parent: MockSolid, cuts: Cut[]): MockSolid[] {
  const { min, max } = boxOf(parent);
  const axis = [0, 1, 2].reduce((best, i) => (Math.abs(cuts[0]!.normal[i]!) > Math.abs(cuts[0]!.normal[best]!) ? i : best), 0);
  const stops = cuts.map((cut) => cut.origin[axis]!).sort((a, b) => a - b);
  const bounds = [min[axis]!, ...stops, max[axis]!];
  return bounds.slice(1).map((hi, k) => {
    const size: V = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const from: V = [min[0], min[1], min[2]];
    size[axis] = hi - bounds[k]!;
    from[axis] = bounds[k]!;
    return boxSolid(size, from);
  });
}

function built(request: Body, parent: MockSolid): Built {
  const op = request.op as { kind: string; cuts?: Cut[]; op?: string; origin?: V; size?: V };
  if (op.kind === "partition") {
    const [kept, ...pieces] = piecesOf(parent, op.cuts!);
    const placed = placedOf(op.cuts!);
    const dowels = placed.filter((row) => row.type === "dowel").length;
    const joints = placed.length > 0 ? { connectors: { placed: placed.map((row) => ({ id: row.id, at: [0, 0, 0], teardrop: true })), dropped: [] } } : {};
    return { kept: kept!, pieces, ...(dowels > 0 ? { pins: pinsSolid(dowels) } : {}), ...joints };
  }
  // A Boolean cut takes its box out of the part, and misses a part it does not reach.
  if (op.kind === "boolean" && op.origin && op.size) {
    const { min, max } = boxOf(parent);
    if (op.origin[0] >= max[0] || op.origin[0] + op.size[0] <= min[0]) return { error: "The tool misses the solid" };
    return { ...parent, volumeMm3: parent.volumeMm3 - op.size[0] * op.size[1] * op.size[2] };
  }
  return parent;
}

async function openBar(page: Page, compact = false, part: MockSolid = BAR, extra: Partial<Parameters<typeof mockModelTree>[1]> = {}): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: part.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    ...extra,
    open: () => part,
    fitCoupon(request) {
      const spec = request.spec as { name: string; holes: unknown[]; pins: unknown[] };
      const file = (text: string) => ({ stepB64: Buffer.from(`ISO-10303-21;\n/* ${text} */\nEND-ISO-10303-21;\n`).toString("base64"), volumeMm3: 1000, solids: 1 });
      return { plate: file(spec.name), pins: spec.pins.length > 0 ? file(`${spec.name}-pins`) : null, engravedMm3: 4.2 };
    },
    apply: built,
    probe(request, on) {
      const op = request.op as { kind: string; cuts?: Cut[] };
      if (op.kind !== "partition") return { ok: true };
      const parts = piecesOf(on, op.cuts!).map((piece) => ({ volumeMm3: piece.volumeMm3, ...boxOf(piece) }));
      const placed = placedOf(op.cuts!);
      const dowels = placed.filter((row) => row.type === "dowel").length;
      const joints = placed.length > 0 ? { connectors: { placed: placed.map((row) => ({ id: row.id, at: [0, 0, 0], teardrop: true })), dropped: [] }, notes: [] } : {};
      return { ok: true, volumeMm3: parts[0]!.volumeMm3, parts, ...(dowels > 0 ? { pins: { count: dowels, volumeMm3: pinsSolid(dowels).volumeMm3 } } : {}), ...joints };
    },
  });
  await page.goto(compact ? "/?layout=compact" : "/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "bar.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeAttached();
  await page.locator(compact ? "#compactTabs [data-tab=model]" : "#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
const labels = (page: Page) => page.locator("#modelHistoryTree .mh-label");
const cuts = (page: Page) => page.locator("#modelPartCuts .sp-cut");
const at = (page: Page, n: number) => page.locator(`#modelPartAt-${n}`);
const apply = (page: Page) => page.locator("#modelApply");

async function openCard(page: Page) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuSplitPrint").click();
  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Split to print");
}

async function grips(page: Page): Promise<Record<string, { x: number; y: number }>> {
  const text = (await page.locator("#model").getAttribute("data-handles")) ?? "";
  const box = (await page.locator("#model").boundingBox())!;
  const map: Record<string, { x: number; y: number }> = {};
  for (const item of text.split(" ").filter(Boolean)) {
    const [id, place] = item.split(":");
    const [x, y] = place!.split(",").map(Number);
    map[id!] = { x: box.x + x!, y: box.y + y! };
  }
  return map;
}

async function grip(page: Page, id: string) {
  await expect.poll(async () => Object.keys(await grips(page))).toContain(id);
  return (await grips(page))[id]!;
}

/** The probes that cut the bar, newest last, as the requests' first cut's X. */
const probedAt = (tree: TreeMock) => tree.of("probe").map((request) => (request.op as { cuts: Cut[] }).cuts.map((cut) => cut.origin[0]));

async function save(page: Page): Promise<{ objects: { id: string; name: string; placement: { offset: { x: number; y: number }; orient: number[] }; modelTree?: unknown }[] }> {
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  return JSON.parse((await readFile((await download.path())!)).toString("utf8"));
}

/** Object `n` of the plate, opened in Model from Prepare's list. */
async function openObject(page: Page, n: number) {
  await page.locator("#tabPrepare").click();
  await page.locator("#objectList .obj").nth(n).click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
}

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/split-print/${name}.png` });
const target = (page: Page) => page.locator("#modelPartTarget");

/** The left dock and the canvas, as the owner sees them: the shots `verify-ui` asks for. */
const view = (page: Page, name: string) => page.screenshot({ path: `test-results/split-print-export/${name}.png` });

async function applyForForm4(page: Page) {
  await target(page).selectOption("formlabs-form-4");
  await expect(page.locator("#modelPartPieces li")).toHaveCount(3);
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#modelPartDone")).toBeVisible();
}

test.use({ viewport: { width: 1440, height: 1000 } });

test("the menu item opens the card on a 500 mm bar with the planner's two cuts and its note, and nothing is cut", async ({ page }) => {
  const tree = await openBar(page);
  await expect(page.locator("#railModel [data-tool=partition], #modelToolSplitPrint"), "no rail button").toHaveCount(0);
  await openCard(page);
  await expect(page.locator("#modelPartNote")).toHaveText("This part is 500 mm along X. The Lime 220 bed fits 210 mm. Two cuts are proposed.");
  await expect(cuts(page)).toHaveCount(2);
  await expect(at(page, 1)).toHaveValue("166.67");
  await expect(at(page, 2)).toHaveValue("333.33");
  await expect(page.locator("#modelPartCuts .scrub-label").first()).toHaveText("At X");
  await expect(page.locator("#modelPartPieces li"), "the kernel's pieces show once the cut is checked").toHaveCount(3);
  await expect(page.locator("#modelPartPieces li").first()).toContainText("Part 1 · 66666.67 mm³ · 166.67 × 20 × 20 mm");
  await expect(apply(page)).toBeEnabled();
  expect(tree.of("apply"), "nothing is cut until Apply").toHaveLength(0);
  expect(probedAt(tree).at(-1)).toEqual([500 / 3, 1000 / 3].map((x) => expect.closeTo(x, 4)));
  await expect(page.locator("#model")).toHaveAttribute("data-cut-pieces", "3");
  await page.waitForTimeout(400);
  await shot(page, "card-proposed");
});

test("Clear cuts empties the list and Apply is refused; Add cut puts one in the middle; Escape cancels", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await page.locator("#modelPartClear").click();
  await expect(cuts(page)).toHaveCount(0);
  await expect(apply(page)).toBeDisabled();
  await expect(page.locator("#modelPartStatus")).toHaveText("Add a cut, or Fit the bed, to split the part.");
  await expect(page.locator("#model")).toHaveAttribute("data-cut-pieces", "0");
  await page.locator("#modelPartAdd").click();
  await expect(cuts(page)).toHaveCount(1);
  await expect(at(page, 1)).toHaveValue("250");
  await expect(apply(page)).toBeEnabled();
  await page.locator("#modelPartFit").click();
  await expect(cuts(page)).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelPanel"), "Escape closes the card").toBeHidden();
  await expect(page.locator("#model")).not.toHaveAttribute("data-handles", /cut-/);
  expect(tree.of("apply")).toHaveLength(0);
  await expect(labels(page)).toHaveText(["bar.step"]);
});

test("typing At X moves the plane, dragging it changes the field with Ctrl snapping, and hover lights only that plane", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  const before = await grip(page, "cut-1");
  await at(page, 1).fill("100");
  await at(page, 1).dispatchEvent("input");
  await expect.poll(async () => (await grips(page))["cut-1"]?.x, "the plane's arrow moves with the number").toBeLessThan(before.x - 10);
  await expect.poll(() => probedAt(tree).at(-1)?.[0], "the check cuts at the typed X").toBe(100);

  // Hover: only cut 2's plane lights, and only its field.
  const second = await grip(page, "cut-2");
  await page.mouse.move(second.x, second.y);
  await expect(page.locator("#model")).toHaveAttribute("data-aspect", "cut-2");
  await expect(page.locator("#model")).toHaveAttribute("data-aspect-field", "modelPartAt-2");
  await expect(page.locator("#model")).toHaveAttribute("data-aspect-tip", /^Cut 2 At X 333\.33 mm$/);
  await expect(at(page, 2)).toHaveClass(/is-aspect/);
  await expect(at(page, 1)).not.toHaveClass(/is-aspect/);
  await page.waitForTimeout(300);
  await shot(page, "plane-hovered");

  // Drag cut 2's arrow: the field follows, the kernel waits for the release, and Ctrl snaps to whole millimetres.
  const probes = tree.of("probe").length;
  await page.keyboard.down("Control");
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(second.x + 5 * i, second.y);
  await expect(page.locator(".interact-hud:not([hidden])"), "the heads-up field is up while the plane moves").toBeVisible();
  await expect(page.locator(".interact-hud:not([hidden]) input").first()).toHaveAttribute("data-field", "modelPartAt-2");
  expect(tree.of("probe").length, "no kernel call while the mouse moves").toBe(probes);
  await shot(page, "plane-drag");
  await page.mouse.up();
  await page.keyboard.up("Control");
  const dragged = Number(await at(page, 2).inputValue());
  expect(dragged, "the drag moved the plane").not.toBe(333.33);
  expect(Number.isInteger(dragged), `Ctrl snaps to whole millimetres, got ${dragged}`).toBe(true);
  await expect.poll(() => probedAt(tree).at(-1)?.[1], "the release checks the dragged cut").toBe(dragged);

  // The heads-up field takes typing, and Tab goes on to Tilt A.
  await page.keyboard.type("300");
  await page.keyboard.press("Tab");
  await expect(page.locator(".interact-hud:not([hidden])")).toHaveAttribute("data-hud-active", "1");
  await page.keyboard.press("Enter");
  await expect(page.locator(".interact-hud:not([hidden])")).toHaveCount(0);
  await expect(at(page, 2)).toHaveValue("300");
});

test("Apply makes the row and the pieces, the pencil reopens the card filled, and Update rebuilds the pieces in one Prepare undo", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#modelPanel"), "Apply closes the card").toBeHidden();
  await expect(labels(page)).toHaveText(["bar.step", "Split to print, 3 parts"]);
  const applied = tree.of("apply").at(-1)!;
  expect((applied.op as { kind: string }).kind).toBe("partition");
  expect((applied.pieceKeys as unknown[]).length, "a key for every piece Max pieces allows").toBe(11);
  await expect(page.locator("#objectList .obj"), "the two new pieces are on the plate").toHaveCount(3);
  await expect(page.locator("#objectList .obj").nth(1)).toContainText("bar part 2");
  await expect(page.locator("#objectList .obj").nth(2)).toContainText("bar part 3");
  // --- Assemblies M8 (D7). Group the parts is on: the part and its pieces are one assembly the moment they are cut.
  await expect(page.locator("[data-assembly-head]"), "the cut parts are one group").toHaveCount(1);
  await expect(page.locator("[data-assembly-head]")).toContainText("3 parts");
  await page.locator("#tabPrepare").click();
  await shot(page, "pieces-grouped");
  await page.locator("#tabModel").click();
  await page.waitForTimeout(600);
  await shot(page, "applied");

  // The plate takes the cut on leaving Model: a Prepare step of its own.
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await page.waitForTimeout(600);
  await shot(page, "applied-plate");
  await page.locator("#objectList .obj").first().click();
  await page.locator("#tabModel").click();
  await expect(labels(page)).toHaveText(["bar.step", "Split to print, 3 parts"]);

  // The pencil: the card opens on the bar, filled from the step, and offers no Update until a number changes.
  await page.getByRole("treeitem", { name: /^Split to print, 3 parts/ }).locator(".mh-edit").click();
  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(page.locator("#modelEditHead")).toHaveText("Editing step 1: Split to print, 3 parts");
  await expect(cuts(page)).toHaveCount(2);
  await expect(at(page, 1)).toHaveValue("166.67");
  await expect(at(page, 2)).toHaveValue("333.33");
  await expect(apply(page)).toHaveText("Update");
  await expect(apply(page)).toBeDisabled();
  await page.locator("#modelPartCuts [data-cut-drop='1']").click();
  await at(page, 1).fill("200");
  await at(page, 1).dispatchEvent("change");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(labels(page)).toHaveText(["bar.step", "Split to print, 3 parts", "Split to print, 2 parts"]);
  const edited = tree.of("edit").at(-1)!;
  expect((edited.op as { kind: string }).kind).toBe("partition");
  expect((edited.pieceKeys as unknown[]).length).toBe(11);
  await expect(page.locator("#objectList .obj"), "piece 3 leaves the plate; piece 2 is the same object").toHaveCount(2);
  await expect(page.locator("#objectList .obj").nth(1)).toContainText("bar part 2");
  await expect(readout(page)).toContainText("One piece left the plate.");

  // One Prepare undo takes the whole Update back: three objects again.
  await page.locator("#tabPrepare").click();
  await page.keyboard.press("Control+z");
  await expect(page.locator("#objectList .obj"), "one undo brings every piece back").toHaveCount(3);
});

// --- Milestone 7: Joint down per piece.
const orientMenu = (page: Page, part: number) => page.locator(`#modelPartPieces select[data-piece-orient="${part - 1}"]`);
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** The third row of a placement's orientation: the plate's up in the part's own frame. */
const upOf = (orient: number[]) => orient.slice(6, 9);

test("Joint down on part 2 is a menu on its row, stores orient, and turns that piece so its cut face lies on the bed", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await expect(page.locator("#modelPartPieces li")).toHaveCount(3);
  await expect(orientMenu(page, 1)).toHaveValue("keep");
  await expect(orientMenu(page, 2)).toHaveValue("keep");
  await expect(page.locator("#modelPartOrientNote"), "the note for an export target stays hidden").toBeHidden();
  await orientMenu(page, 2).selectOption("joint");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  expect((tree.of("apply").at(-1)!.op as { orient: unknown }).orient, "the op stores a choice for each part").toEqual(["keep", "joint"]);
  await expect(readout(page)).toContainText("Part 2 is joint down on cut 1, its larger cut face, 400 mm².");
  const doc = await save(page);
  const [whole, part2, part3] = doc.objects;
  expect(whole!.placement.orient, "the part itself keeps").toEqual(IDENTITY);
  expect(part3!.placement.orient, "part 3 keeps").toEqual(IDENTITY);
  const up = upOf(part2!.placement.orient);
  expect(Math.abs(up[0]!), "the cut's face looks along X, so the plate's up is X in the piece's frame").toBeCloseTo(1, 9);
  expect(Math.abs(up[1]!) + Math.abs(up[2]!)).toBeCloseTo(0, 9);
});

test("an Update that sets part 2 to Joint down turns it, and one Prepare undo puts it back", async ({ page }) => {
  await openBar(page);
  await openCard(page);
  await apply(page).click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await page.locator("#tabPrepare").click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/split-bed/before-keep.png" });
  const before = await save(page);
  expect(before.objects[1]!.placement.orient).toEqual(IDENTITY);
  await page.locator("#objectList .obj").first().click();
  await page.locator("#tabModel").click();
  await expect(labels(page)).toHaveText(["bar.step", "Split to print, 3 parts"]);
  await page.getByRole("treeitem", { name: /^Split to print, 3 parts/ }).locator(".mh-edit").click();
  await expect(apply(page)).toHaveText("Update");
  await expect(apply(page)).toBeDisabled();
  await expect(orientMenu(page, 2)).toHaveValue("keep");
  await orientMenu(page, 2).selectOption("joint");
  await expect(apply(page), "choosing Joint down is a change: Update is offered").toBeEnabled();
  await apply(page).click();
  await expect(labels(page)).toHaveText(["bar.step", "Split to print, 3 parts", "Split to print, 3 parts"]);
  await expect(readout(page)).toContainText("Part 2 is joint down on cut 1");
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/split-bed/after-joint-down.png" });
  const turned = await save(page);
  expect(Math.abs(upOf(turned.objects[1]!.placement.orient)[0]!), "part 2 is turned").toBeCloseTo(1, 9);
  expect(turned.objects[1]!.id, "the same object").toBe(before.objects[1]!.id);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  const back = await save(page);
  expect(back.objects, "the undo took the Update back whole: the pieces and their orientation").toHaveLength(3);
  expect(back.objects[1]!.placement.orient, "part 2 is as it was").toEqual(IDENTITY);
});

test("Joint down is not offered for the Form 4: the pieces stay as cut for PreForm", async ({ page }) => {
  await openBar(page);
  await openCard(page);
  await orientMenu(page, 2).selectOption("joint");
  await target(page).selectOption("formlabs-form-4");
  await expect(page.locator("#modelPartPieces li")).toHaveCount(3);
  await expect(page.locator("#modelPartPieces select"), "no menu on any row").toHaveCount(0);
  await expect(page.locator("#modelPartOrientNote")).toBeVisible();
  await expect(page.locator("#modelPartOrientNote")).toHaveText("Pieces for the Formlabs Form 4 stay as they were cut. PreForm orients them, so Joint down is not offered.");
  await apply(page).click();
  await expect(page.locator("#modelPartDone")).toBeVisible();
});

// --- Milestone 8: lap and tongue profiles on a cut.
const profileKind = (page: Page) => page.locator("#modelPartProfileKind");
type Shaped = { kind: string; depth?: number; height?: number; width?: number; side?: string; at?: number; clearance?: number; endGap?: number; u0?: number; u1?: number; v?: number };
const lastProfile = (tree: TreeMock) => ((tree.of("probe").at(-1)?.op as { cuts: { profile?: Shaped }[] } | undefined)?.cuts[0]?.profile) ?? { kind: "straight" };

test("a cut's Profile menu offers Straight, Lap and Tongue; a lap shows Depth, Height and Side with the planner's defaults and sends the step resolved on the section", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await expect(profileKind(page)).toHaveValue("straight");
  await expect(page.locator("#modelPartProfileFields"), "a plain cut shows no profile fields").toBeHidden();
  await profileKind(page).selectOption("lap");
  await expect(page.locator("#modelPartProfileFields")).toBeVisible();
  await expect(page.locator("#modelPartProfileDepth")).toHaveAttribute("placeholder", "8");
  await expect(page.locator("#modelPartProfileHeight")).toHaveAttribute("placeholder", "Half");
  await expect(page.locator("#modelPartProfileWidth"), "a tongue's width waits for its kind").toBeHidden();
  await expect.poll(() => lastProfile(tree).kind).toBe("lap");
  expect(lastProfile(tree)).toEqual(expect.objectContaining({ kind: "lap", depth: 8, height: 10, side: "positive" }));
  expect(typeof lastProfile(tree).at, "the step is a position on the section, from the cut's origin").toBe("number");
  await page.locator("#modelPartProfileDepth").fill("10");
  await page.locator("#modelPartProfileDepth").dispatchEvent("change");
  await page.locator("#modelPartProfileHeight").fill("6");
  await page.locator("#modelPartProfileHeight").dispatchEvent("change");
  await page.locator("#modelPartProfileSide").selectOption("negative");
  await expect.poll(() => lastProfile(tree)).toEqual(expect.objectContaining({ kind: "lap", depth: 10, height: 6, side: "negative" }));
  await page.locator("#modelPartProfileDepth").fill("2");
  await page.locator("#modelPartProfileDepth").dispatchEvent("change");
  await expect(page.locator("#modelPartProfileNote"), "a depth under the floor says so").toContainText("Lap depth is 2 mm, under the 2.4 mm floor.");
  await expect(apply(page)).toBeDisabled();
  await page.locator("#modelPartProfileDepth").fill("");
  await page.locator("#modelPartProfileDepth").dispatchEvent("change");
  await expect(page.locator("#modelPartProfileNote")).toBeHidden();
  await jointsOn(page).check();
  await expect(page.locator("#modelPartProfileNote"), "a lap has flats for connectors since milestone 11").toBeHidden();
  await expect(apply(page)).toBeEnabled();
  await profileKind(page).selectOption("tongue");
  await expect(page.locator("#modelPartProfileNote"), "a tongue takes connectors beside it").toBeHidden();
  await expect(page.locator("#modelPartStatus")).toHaveText("Cut 1: no dowel fits beside the tongue. The flats beside it hold a circle 6.8 mm across at most. A dowel of radius 2.47 mm or less fits.");
  await expect(apply(page), "the cut says why it cannot be built, and what would fit").toBeDisabled();
  await profileKind(page).selectOption("lap");
  await jointsOn(page).uncheck();
  if ((await page.locator("#modelPartHowOpen").getAttribute("aria-expanded")) === "true") await page.locator("#modelPartHowOpen").click();
  await page.waitForTimeout(400);
  await shot(page, "profile-lap");
  await profileKind(page).selectOption("straight");
  await expect(page.locator("#modelPartProfileFields")).toBeHidden();
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  expect((tree.of("apply").at(-1)!.op as { cuts: { profile: Shaped }[] }).cuts[0]!.profile.kind, "back to straight is a plain cut").toBe("straight");
});

test("a tongue sends its width, depth, clearance, end gap and its place on the section, and Apply stores the lap", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await profileKind(page).selectOption("tongue");
  await expect(page.locator("#modelPartProfileWidth")).toBeVisible();
  await expect(page.locator("#modelPartProfileWidth")).toHaveAttribute("placeholder", "6");
  await expect(page.locator("#modelPartProfileHeight"), "a lap's height waits for its kind").toBeHidden();
  await expect.poll(() => lastProfile(tree)).toEqual(expect.objectContaining({ kind: "tongue", width: 6, depth: 3, side: "positive", clearance: 0.15, endGap: 0.4, v: 0 }));
  const tongue = lastProfile(tree);
  expect(tongue.u1! - tongue.u0!, "20 mm of section less the 3.95 mm margin each end").toBeCloseTo(12.1, 6);
  await profileKind(page).selectOption("lap");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  const applied = tree.of("apply").at(-1)!.op as { cuts: { profile: Shaped }[] };
  expect(applied.cuts[0]!.profile).toEqual(expect.objectContaining({ kind: "lap", depth: 8, height: 10, side: "positive" }));
  await page.getByRole("treeitem", { name: /^Split to print, 3 parts/ }).locator(".mh-edit").click();
  await expect(profileKind(page), "the pencil reopens the card with the lap").toHaveValue("lap");
  await expect(page.locator("#modelPartProfileDepth")).toHaveValue("8");
  await expect(page.locator("#modelPartProfileHeight")).toHaveValue("10");
});

// --- Milestone 9: zig-zag and dovetail profiles, and key and dovetail connectors.
test("a zig-zag shows Pitch, Depth and Angle, and a dovetail Width, Depth, Angle and Slide, each sending its sizes resolved on the section", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await profileKind(page).selectOption("zigzag");
  await expect(page.locator("#modelPartProfilePitch")).toBeVisible();
  await expect(page.locator("#modelPartProfileAngle")).toBeVisible();
  await expect(page.locator("#modelPartProfileWidth"), "a tongue's width waits for its kind").toBeHidden();
  await expect(page.locator("#modelPartProfileSlideRow"), "and so does a dovetail's slide").toBeHidden();
  await expect(page.locator("#modelPartProfilePitch")).toHaveAttribute("placeholder", "10");
  await expect(page.locator("#modelPartProfileDepth")).toHaveAttribute("placeholder", "3");
  await expect.poll(() => lastProfile(tree)).toEqual(expect.objectContaining({ kind: "zigzag", pitch: 10, depth: 3, angle: 0, side: "positive", u0: -10 }));
  await page.locator("#modelPartProfileAngle").fill("20");
  await page.locator("#modelPartProfileAngle").dispatchEvent("change");
  await expect.poll(() => lastProfile(tree)).toEqual(expect.objectContaining({ kind: "zigzag", angle: 20 }));
  await profileKind(page).selectOption("dovetail");
  await expect(page.locator("#modelPartProfileSlideRow")).toBeVisible();
  await expect(page.locator("#modelPartProfileWidth")).toHaveAttribute("placeholder", "8");
  await expect(page.locator("#modelPartProfileAngle")).toHaveAttribute("placeholder", "20");
  await expect(page.locator("#modelPartProfilePitch"), "a zig-zag's pitch waits for its kind").toBeHidden();
  await expect.poll(() => lastProfile(tree)).toEqual(expect.objectContaining({ kind: "dovetail", width: 8, angle: 20, depth: 3, slide: "u", side: "positive", clearance: 0.15, endGap: 0.4, u0: -10, u1: 10, v: 0 }));
  await page.locator("#modelPartProfileSlide").selectOption("v");
  await expect.poll(() => lastProfile(tree)).toEqual(expect.objectContaining({ kind: "dovetail", slide: "v" }));
  await page.locator("#modelPartProfileAngle").fill("60");
  await page.locator("#modelPartProfileAngle").dispatchEvent("change");
  await expect(page.locator("#modelPartProfileNote")).toContainText("This dovetail's neck is 0 mm, under 0.8 mm. Lower the angle or widen the dovetail.");
  await expect(apply(page)).toBeDisabled();
  await page.locator("#modelPartProfileAngle").fill("");
  await page.locator("#modelPartProfileAngle").dispatchEvent("change");
  if ((await page.locator("#modelPartHowOpen").getAttribute("aria-expanded")) === "true") await page.locator("#modelPartHowOpen").click();
  await page.waitForTimeout(400);
  await shot(page, "profile-dovetail");
});

test("Key and Dovetail connectors show their own fields and are placed on the section", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await jointsOn(page).check();
  await page.locator("#modelPartJointType").selectOption("key");
  await expect(page.locator("#modelPartJointWidth")).toBeVisible();
  await expect(page.locator("#modelPartJointHeight")).toBeVisible();
  await expect(page.locator("#modelPartJointWidth")).toHaveValue("6");
  await expect(page.locator("#modelPartJointHeight")).toHaveValue("6");
  await expect(page.locator("#modelPartJointDepth")).toHaveValue("3");
  await expect(page.locator("#modelPartJointGap")).toHaveValue("0.4");
  await expect(page.locator("#modelPartJointRadius"), "a dowel's radius is not a key's").toBeHidden();
  await expect(page.locator("#modelPartJointAngle")).toBeHidden();
  const typesOf = () => ((tree.of("probe").at(-1)?.op as { cuts: { connectors?: { types?: { type: string; width?: number; height?: number; slide?: string; angle?: number }[]; placed?: unknown[] } }[] } | undefined)?.cuts[0]?.connectors) ?? {};
  await expect.poll(() => typesOf().types?.[0]?.type).toBe("key");
  expect(typesOf().types?.[0]).toEqual(expect.objectContaining({ width: 6, height: 6, depth: 3, clearance: 0.15, endGap: 0.4 }));
  expect((typesOf().placed ?? []).length, "the planner placed keys on the 20 mm section").toBeGreaterThan(0);
  await page.locator("#modelPartJointHeight").fill("4");
  await page.locator("#modelPartJointHeight").dispatchEvent("change");
  await expect.poll(() => typesOf().types?.[0]?.height).toBe(4);
  await page.locator("#modelPartJointType").selectOption("dovetail");
  await expect(page.locator("#modelPartJointAngle")).toBeVisible();
  await expect(page.locator("#modelPartJointAngle")).toHaveValue("20");
  await expect(page.locator("#modelPartJointSlide")).toBeVisible();
  await expect(page.locator("#modelPartJointWidth")).toHaveValue("8");
  await expect(page.locator("#modelPartJointHeight"), "a key's height waits for its kind").toBeHidden();
  await expect.poll(() => typesOf().types?.[0]).toEqual(expect.objectContaining({ type: "dovetail", width: 8, angle: 20, slide: "u" }));
  await page.locator("#modelPartJointSlide").selectOption("v");
  await expect.poll(() => typesOf().types?.[0]?.slide).toBe("v");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await expect(labels(page)).toHaveText(["bar.step", "Split to print, 3 parts, dovetails"]);
});

// --- Milestone 10: a cut along a sketched profile.
type Drawn = { kind: string; start?: [number, number]; chain?: { kind: string; to: [number, number] }[]; sketch?: unknown };
const sketchCanvas = (page: Page) => page.locator("#model");

/** The screen point of (u, w) on the open sketch's plane, from where its origin and 10 mm along X and Y land. */
async function onSketch(page: Page, u: number, w: number): Promise<{ x: number; y: number }> {
  const text = (await sketchCanvas(page).getAttribute("data-sketch-frame")) ?? "";
  const [o, x, y] = text.split(" ").map((pair) => pair.split(",").map(Number) as [number, number]);
  return { x: o![0] + ((x![0] - o![0]) * u) / 10 + ((y![0] - o![0]) * w) / 10, y: o![1] + ((x![1] - o![1]) * u) / 10 + ((y![1] - o![1]) * w) / 10 };
}

/** The sketch has turned onto the cut's plane: the camera has stopped, and the frame on screen is the settled one. */
async function settleSketch(page: Page) {
  await expect(sketchCanvas(page)).toHaveAttribute("data-sketch", "editing");
  await expect(sketchCanvas(page)).toHaveAttribute("data-sketch-profile", "1");
  await page.waitForTimeout(500);
  const box = (await sketchCanvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.8, box.y + 40);
  await expect(sketchCanvas(page)).toHaveAttribute("data-sketch-frame", /\d/);
}

test("choosing Sketch opens the sketcher on the cut; a chain drawn across it and Apply make the row; the pencil reopens the chain", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await profileKind(page).selectOption("sketch");
  await settleSketch(page);
  await expect(page.locator("#modelPanel"), "the card steps aside while the profile is drawn").toBeHidden();
  await expect(page.locator("#sketchCards .sketch-profile .sketch-feature-name")).toHaveText("Sketch profile");
  await expect(page.locator("#sketchCards [data-sketch-make]"), "a profile sketch makes no feature of its own").toHaveCount(0);
  await expect(page.locator("#sketchProfileNote")).toHaveText("The sketch profile has no chain yet. Draw it across the cut, or give start and chain.");
  await expect(sketchCanvas(page)).toHaveAttribute("data-sketch-current-tool", "line");
  // A step across the 20 mm section, U from −10 to 10: in at W = 0, up 20 mm along the cut's normal, out at W = 20.
  for (const [u, w] of [[-20, 0], [0, 0], [0, 20], [20, 20]] as const) {
    const point = await onSketch(page, u, w);
    await page.mouse.click(point.x, point.y);
  }
  await expect(sketchCanvas(page)).toHaveAttribute("data-sketch-entities", "3");
  await expect(page.locator("#sketchProfileNote"), "the chain crosses the section, so nothing stands in its way").toBeHidden();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/split-print/sketch-profile.png" });
  await page.locator("[data-sketch-profile-use]").click();

  await expect(page.locator("#modelPanel"), "Use profile brings the card back").toBeVisible();
  await expect(sketchCanvas(page)).toHaveAttribute("data-sketch", "off");
  await expect(page.locator("#modelPartProfileSketchText")).toHaveText("Sketch · 3 lines");
  await expect(profileKind(page)).toHaveValue("sketch");
  await expect.poll(() => (lastProfile(tree) as Drawn).kind).toBe("sketch");
  const sent = lastProfile(tree) as Drawn;
  expect(sent.sketch, "the engine sees the chain, not the sketch").toBeUndefined();
  expect(sent.chain!.map((segment) => segment.kind)).toEqual(["line", "line", "line"]);
  expect(sent.start![0], "the chain starts past the section's low side").toBeLessThanOrEqual(-10);
  expect(sent.chain!.at(-1)!.to[0], "and ends past its high side").toBeGreaterThanOrEqual(10);
  const cut = (tree.of("probe").at(-1)!.op as { cuts: { u?: V }[] }).cuts[0]!;
  expect(cut.u, "the cut's U is fixed with its sketch").toEqual([0, 1, 0]);
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(labels(page)).toHaveText(["bar.step", "Split to print, sketch, 3 parts"]);
  const applied = tree.of("apply").at(-1)!.op as { cuts: { profile?: Drawn }[] };
  expect(applied.cuts[0]!.profile!.sketch, "the apply sends the chain alone too").toBeUndefined();

  // The pencil reopens the chain in the sketcher first, then the card.
  await page.getByRole("treeitem", { name: /^Split to print, sketch, 3 parts/ }).locator(".mh-edit").click();
  await settleSketch(page);
  await expect(sketchCanvas(page), "the chain is back, its three lines").toHaveAttribute("data-sketch-entities", "3");
  await expect(page.locator("#modelPanel")).toBeHidden();
  await page.locator("[data-sketch-profile-cancel]").click();
  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(profileKind(page)).toHaveValue("sketch");
  await expect(page.locator("#modelPartProfileSketchText")).toHaveText("Sketch · 3 lines");
  await expect(apply(page), "an untouched edit offers no Update").toBeDisabled();
});

test("a chain that stops inside the section is refused in the sketch card and on the card", async ({ page }) => {
  await openBar(page);
  await openCard(page);
  await profileKind(page).selectOption("sketch");
  await settleSketch(page);
  for (const [u, w] of [[-20, 0], [0, 0], [0, 20]] as const) {
    const point = await onSketch(page, u, w);
    await page.mouse.click(point.x, point.y);
  }
  await expect(sketchCanvas(page)).toHaveAttribute("data-sketch-entities", "2");
  await expect(page.locator("#sketchProfileNote")).toHaveText("The sketch has to cross the section: start it past one side of the part and end it past the other.");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelPanel"), "Esc out of the sketch uses the chain as it stands").toBeVisible();
  await expect(page.locator("#modelPartStatus")).toHaveText("Cut 1: The sketch has to cross the section: start it past one side of the part and end it past the other.");
  await expect(apply(page)).toBeDisabled();
});

test("Apply along a sketch, then Explode spreads its pieces", async ({ page }) => {
  // The 60 mm wide bar, so the tooth sits well clear of the section's sides and of the cut's trace, which snap.
  await openBar(page, false, WIDE);
  await openCard(page);
  await profileKind(page).selectOption("sketch");
  await settleSketch(page);
  for (const [u, w] of [[-40, 30], [-8, 30], [-8, 45], [8, 45], [8, 30], [40, 30]] as const) {
    const point = await onSketch(page, u, w);
    await page.mouse.click(point.x, point.y);
  }
  await expect(sketchCanvas(page)).toHaveAttribute("data-sketch-entities", "5");
  await page.locator("[data-sketch-profile-use]").click();
  await expect(page.locator("#modelPartProfileSketchText")).toHaveText("Sketch · 5 lines");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(labels(page)).toHaveText(["bar.step", "Split to print, sketch, 3 parts"]);
  await page.locator("#modelLookOpen").click();
  await page.locator("#modelExplode").check();
  await expect(page.locator("#model")).toHaveAttribute("data-explode-parts", /2:/);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.screenshot({ path: "test-results/split-print/sketch-explode.png" });
});

test("lay out places only the new pieces, around an object that stays where it was", async ({ page }) => {
  await openBar(page);
  // A second object on the plate, where a whole-plate Arrange would start from.
  await page.locator("#tabPrepare").click();
  await page.locator("#plateAddFile").setInputFiles({ name: "block.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const first = await save(page);
  const block = first.objects[1]!;
  await page.locator("#objectList .obj").first().click();
  await page.locator("#tabModel").click();
  await openCard(page);
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#objectList .obj")).toHaveCount(4);
  const after = await save(page);
  const kept = after.objects.find((obj) => obj.id === block.id)!;
  expect(kept.placement.offset, "the object already on the plate does not move").toEqual(block.placement.offset);
  const pieces = after.objects.filter((obj) => /part [23]$/.test(obj.name));
  expect(pieces).toHaveLength(2);
  expect(pieces[0]!.placement.offset, "the pieces are laid out apart").not.toEqual(pieces[1]!.placement.offset);
});

test("Group the parts off cuts with no assembly, and a project saved before assemblies reopens without one", async ({ page }) => {
  await openBar(page);
  await openCard(page);
  await expect(page.locator("#modelPartGroup")).toBeChecked();
  await page.locator("#modelPartGroup").scrollIntoViewIfNeeded();
  await shot(page, "card-group");
  await page.locator("#modelPartGroup").uncheck();
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await expect(page.locator("[data-assembly-head]"), "unchecked, the pieces are not grouped").toHaveCount(0);
  // The file an older app wrote has no assemblies key: it opens with its pieces, ungrouped.
  const doc = await saveAndReopen(page, (file) => delete file.assemblies);
  expect(doc.assemblies).toBeUndefined();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await expect(page.locator("[data-assembly-head]")).toHaveCount(0);
});

test("an edit that moves a piece away from its later step keeps that step, broken, in the piece's history", async ({ page }) => {
  await openBar(page);
  await openCard(page);
  await apply(page).click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  // Piece 2 (X 166.67 to 333.33) takes a Boolean cut at X 200.
  await openObject(page, 1);
  await expect(labels(page)).toHaveText(["Part 2"]);
  await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  await page.locator("#modelX").fill("200");
  await page.locator("#modelX").dispatchEvent("input");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(labels(page)).toHaveCount(2);
  // Back on the bar: the first cut moves to X 260, so piece 2 runs from 260 and the cut at X 200 misses it.
  await openObject(page, 0);
  await expect(labels(page)).toHaveText(["bar.step", "Split to print, 3 parts"]);
  await page.getByRole("treeitem", { name: /^Split to print, 3 parts/ }).locator(".mh-edit").click();
  await at(page, 1).fill("260");
  await at(page, 1).dispatchEvent("change");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText("did not build on the new cut");
  await openObject(page, 1);
  await expect(labels(page), "the later step is still in piece 2's history").toHaveCount(2);
  await expect(page.locator("#modelHistoryTree .mh-row[data-broken]"), "and its row says it did not build").toHaveCount(1);
});

const FORM4_NOTE = "This part is 400 mm along Z. The Formlabs Form 4 volume fits 190 mm. Two cuts are proposed.";

test("Print on lists the plate's printer first and the Form 4 last; the Form 4 fits its volume and proposes the cuts again", async ({ page }) => {
  await openBar(page, false, COLUMN);
  await openCard(page);
  const names = await target(page).locator("option").allTextContents();
  expect(names.at(-1), "the Form 4 is last").toBe("Formlabs Form 4");
  expect(names.length).toBeGreaterThan(1);
  await expect(target(page).locator("option:checked"), "the plate's printer is the one shown").toHaveText(names[0]!);
  await expect(page.locator("#modelPartFit")).toHaveText("Fit the bed");
  await target(page).selectOption("formlabs-form-4");
  await expect(page.locator("#modelPartNote"), "the note names the Form 4's volume").toHaveText(FORM4_NOTE);
  await expect(page.locator("#modelPartFit")).toHaveText("Fit the printer");
  await expect(cuts(page), "the planner proposes again: two cuts, three pieces").toHaveCount(2);
  await expect(page.locator("#modelPartPieces li")).toHaveCount(3);
  await expect(page.locator("#modelPartLayout"), "nothing is laid out for an export target").toBeHidden();
  if ((await page.locator("#modelPartHowOpen").getAttribute("aria-expanded")) === "true") await page.locator("#modelPartHowOpen").click();
  await page.waitForTimeout(400);
  await view(page, "card-form4");
});

test("Print on the Form 4 over a long bar turns it to the volume's height: four pieces, and the sentence says which axis", async ({ page }) => {
  await openBar(page, false, LONG_BAR);
  await openCard(page);
  await expect(page.locator("#modelPartNote"), "for the plate's printer the bar is cut where it lies").toContainText("This part is 680 mm along Y.");
  await target(page).selectOption("formlabs-form-4");
  await expect(page.locator("#modelPartNote")).toHaveText(/^Cut for the Formlabs Form 4 with the part's 680 mm along the volume's 210 mm height: 4 parts\. Three cuts are proposed\. Pieces 1–4 are 170 mm tall\. Tilted in PreForm they may not fit; a fourth cut would leave room\.$/);
  await expect(cuts(page), "three cuts across the bar's own Y").toHaveCount(3);
  await expect(page.locator("#modelPartPieces li")).toHaveCount(4);
  await expect(page.locator("#modelPartCuts .scrub-label").first()).toHaveText("At Y");
  if ((await page.locator("#modelPartHowOpen").getAttribute("aria-expanded")) === "true") await page.locator("#modelPartHowOpen").click();
  await page.waitForTimeout(400);
  await view(page, "card-form4-turned");
});

test("a new target keeps the cuts the user edited, and refreshes only the note", async ({ page }) => {
  await openBar(page, false, COLUMN);
  await openCard(page);
  await page.locator("#modelPartAdd").click();
  const count = await cuts(page).count();
  const typed = await at(page, 1).inputValue();
  await target(page).selectOption("formlabs-form-4");
  await expect(page.locator("#modelPartNote")).toHaveText(FORM4_NOTE);
  await expect(cuts(page), "the cuts stay").toHaveCount(count);
  await expect(at(page, 1)).toHaveValue(typed);
});

test("Part numbers are on by default and write the labels in full; off stores labels {on: false}", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await expect(page.locator("#modelPartNumbers")).toBeChecked();
  await expect(page.locator("#modelPartNumbersNote")).toHaveText("The number is cut into the part, so renaming the object does not change it.");
  await expect(apply(page)).toBeEnabled();
  await expect.poll(() => (tree.of("probe").at(-1)?.op as { labels?: unknown } | undefined)?.labels).toEqual({ on: true, face: "cut", height: 4, depth: 0.4 });
  await page.locator("#modelPartNumbers").uncheck();
  await expect.poll(() => (tree.of("probe").at(-1)?.op as { labels?: unknown } | undefined)?.labels).toEqual({ on: false });
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(labels(page)).toHaveText(["bar.step", "Split to print, 3 parts"]);
  expect((tree.of("apply").at(-1)!.op as { labels: unknown }).labels).toEqual({ on: false });
});

test("Apply for the Form 4 leaves the plate as it was, Model on the split slices the whole part, a later step refuses, and Explode shows three pieces", async ({ page }) => {
  let slices = 0;
  await page.route("**/api/slice", (route) => {
    slices += 1;
    return route.fulfill({ status: 500, json: { error: "not sliced in this test" } });
  });
  const tree = await openBar(page, false, COLUMN);
  await openCard(page);
  await applyForForm4(page);
  const applied = tree.of("apply").at(-1)!;
  expect((applied.op as { target: { printer: string } }).target.printer).toBe("formlabs-form-4");
  expect((applied.pieceKeys as unknown[]).length).toBe(11);
  await expect(page.locator("#modelPartDonePieces li")).toHaveText(["Part 1 · bar-1", "Part 2 · bar-2", "Part 3 · bar-3"]);
  await expect(page.locator("#modelPartDoneSupport")).toHaveText("Keep supports off the cut faces. They carry the fit and the part number.");
  await expect(page.locator("#modelPartExport")).toBeVisible();
  await expect(labels(page)).toHaveText(["bar.step", "Split to print for Formlabs Form 4, 3 parts"]);
  await expect(page.locator("#objectList .obj"), "no piece is a plate object").toHaveCount(1);

  await page.locator("#modelLookOpen").click();
  await expect(page.locator("#modelExplodeRow")).toBeVisible();
  await page.locator("#modelExplode").check();
  await expect(page.locator("#model")).toHaveAttribute("data-explode-parts", "1:0,0,0 2:0,0,10 3:0,0,20");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await view(page, "explode-form4");

  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  const sentence = "bar.step is cut for the Formlabs Form 4, which this app does not slice for. Export its pieces with export_3mf or model_export_step and pieces: true, or model_goto a step before the cut to print it here.";
  await page.locator("#slice").click();
  await expect.poll(() => slices, "Model on the split is not ahead of the plate: the part slices whole").toBe(1);
  await expect(page.locator("#banner")).not.toContainText(sentence);
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.locator("#fileMenu > summary").click();
  await page.locator("#export3mf").click();
  await expect.poll(() => downloads, "the plate's 3MF is the whole part").toEqual(["bar.3mf"]);

  // A step after the cut is Model ahead of the plate again.
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  await page.locator("#modelX").fill("5");
  await page.locator("#modelX").dispatchEvent("input");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(labels(page)).toHaveCount(3);
  await page.locator("#tabPrepare").click();
  await page.locator("#slice").click();
  await expect(page.locator("#banner")).toContainText(sentence);
  expect(slices, "no second slice started").toBe(1);
});

test("Export… offers STL per piece, one 3MF and one STEP, and writes the expected file names", async ({ page }) => {
  const tree = await openBar(page, false, COLUMN);
  await openCard(page);
  await applyForForm4(page);
  const dialog = page.locator("#splitExport");
  const seen: string[] = [];
  page.on("download", (download) => seen.push(download.suggestedFilename()));
  const choose = async (format: string, count: number) => {
    await page.locator("#modelPartExport").click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-format]:not([data-format=cancel])")).toHaveCount(3);
    await expect(dialog.locator("#splitExportNote")).toHaveText("Keep supports off the cut faces. They carry the fit and the part number.");
    if (format === "stl") await view(page, "export-dialog");
    await dialog.locator(`[data-format="${format}"]`).click();
    await expect.poll(() => seen.length).toBe(count);
    await expect(dialog).toBeHidden();
    await expect(readout(page)).toContainText("Keep supports off the cut faces.");
  };
  await choose("stl", 3);
  expect(seen).toEqual(["bar-1.stl", "bar-2.stl", "bar-3.stl"]);
  await expect(readout(page)).toContainText("Saved bar-1.stl, bar-2.stl, bar-3.stl.");
  await choose("3mf", 4);
  await choose("step", 5);
  expect(seen.slice(3)).toEqual(["bar.3mf", "bar.step"]);
  const request = tree.of("export").at(-1)!;
  expect((request.pieces as unknown[]).length, "the STEP asks for the other two pieces' trees").toBe(2);
  expect(request.names, "and names every solid as the 3MF and the STLs do").toEqual(["bar-1", "bar-2", "bar-3"]);
  await page.locator("#modelPartExport").click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(seen.length, "Cancel writes nothing").toBe(5);
});

test("on the desktop, STL per piece asks for one folder and writes every piece there", async ({ page }) => {
  await openBar(page, false, COLUMN);
  await openCard(page);
  await applyForForm4(page);
  const dialog = page.locator("#splitExport");
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  // The desktop shell answers `invoke`; the app looks for it each time it saves, so it is put in place for this export only.
  const desktop = async (answer: string | null) => {
    await page.evaluate((folder) => {
      const calls: { cmd: string; args: { files: { name: string; bytesB64: string }[] } }[] = [];
      (window as unknown as { __folderCalls: typeof calls }).__folderCalls = calls;
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: { files: { name: string; bytesB64: string }[] }) => {
          calls.push({ cmd, args });
          return folder;
        },
        transformCallback: () => 0,
      };
    }, answer);
  };
  const calls = () => page.evaluate(() => (window as unknown as { __folderCalls: { cmd: string; args: { files: { name: string; bytesB64: string }[] } }[] }).__folderCalls);
  const exportStl = async () => {
    await page.locator("#modelPartExport").click();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-format="stl"]').click();
    await expect(dialog).toBeHidden();
  };
  await desktop("C:\\parts\\bar");
  await exportStl();
  await expect(readout(page)).toContainText("Saved bar-1.stl, bar-2.stl, bar-3.stl in C:\\parts\\bar.");
  const made = await calls();
  expect(made.map((call) => call.cmd), "one call for all three pieces, not one save dialog each").toEqual(["save_files_to_folder"]);
  expect(made[0]!.args.files.map((file) => file.name)).toEqual(["bar-1.stl", "bar-2.stl", "bar-3.stl"]);
  for (const file of made[0]!.args.files) {
    const header = Buffer.from(file.bytesB64, "base64");
    expect(header.length, "a binary STL: 80 bytes of header, a count, then 50 bytes a triangle").toBe(84 + 50 * header.readUInt32LE(80));
  }
  expect(downloads, "the desktop writes files, the page downloads none").toEqual([]);
  await view(page, "folder-export");
  await desktop(null);
  await exportStl();
  await expect(readout(page), "a cancelled folder pick says nothing was saved").toContainText("No folder was picked, so nothing was saved.");
  // The web build has no desktop shell: it downloads each piece, as it did.
  await page.evaluate(() => delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  await exportStl();
  await expect.poll(() => downloads).toEqual(["bar-1.stl", "bar-2.stl", "bar-3.stl"]);
  await expect(readout(page)).toContainText("Saved bar-1.stl, bar-2.stl, bar-3.stl. Keep supports off");
});

test("the partition row's menu offers Export… for an export target", async ({ page }) => {
  await openBar(page, false, COLUMN);
  await openCard(page);
  await applyForForm4(page);
  await page.locator("#modelCancel").click();
  const row = page.getByRole("treeitem", { name: /^Split to print for Formlabs Form 4, 3 parts/ });
  await row.locator(".mh-more").click();
  await expect(page.locator("#modelHistoryMenu [data-act=export]")).toBeVisible();
  await page.locator("#modelHistoryMenu [data-act=export]").click();
  await expect(page.locator("#splitExport")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#splitExport")).toBeHidden();
});

/** Save from Prepare through the app's save path, reload, and open that file; `edit` changes the file first. */
async function saveAndReopen(page: Page, edit?: (doc: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  let file = await readFile((await download.path())!);
  const doc = JSON.parse(file.toString("utf8")) as Record<string, unknown>;
  if (edit) {
    edit(doc);
    file = Buffer.from(JSON.stringify(doc));
  }
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "bar.lime", mimeType: "application/json", buffer: file });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  return doc;
}

const SPLIT_ROW = /^Split to print for Formlabs Form 4, 3 parts/;

/** Model on the reopened file: on the split, with every piece, Explode spreading them, and Export… naming each one. */
async function expectEveryPiece(page: Page, tree: TreeMock, name: string) {
  await expect(page.getByRole("treeitem", { name: SPLIT_ROW }), "Model opens on the split").toHaveAttribute("aria-selected", "true");
  await page.locator("#modelLookOpen").click();
  await expect(page.locator("#modelExplodeRow")).toBeVisible();
  await page.locator("#modelExplode").check();
  await expect(page.locator("#model")).toHaveAttribute("data-explode-parts", "1:0,0,0 2:0,0,10 3:0,0,20");
  await page.keyboard.press("Escape");
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.85);
  await page.mouse.wheel(0, 1500);
  await page.mouse.move(box.x + 4, box.y + box.height - 4);
  await page.waitForTimeout(800);
  await view(page, `${name}-explode`);
  const dialog = page.locator("#splitExport");
  const seen: string[] = [];
  page.on("download", (download) => seen.push(download.suggestedFilename()));
  const choose = async (format: string) => {
    await page.getByRole("treeitem", { name: SPLIT_ROW }).locator(".mh-more").click();
    await page.locator("#modelHistoryMenu [data-act=export]").click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#splitExportStl")).toHaveText("bar-1.stl, bar-2.stl, … bar-3.stl");
    if (format === "stl") await view(page, `${name}-export`);
    await dialog.locator(`[data-format="${format}"]`).click();
    await expect(dialog).toBeHidden();
  };
  await choose("stl");
  await expect.poll(() => seen, "one file for every piece").toEqual(["bar-1.stl", "bar-2.stl", "bar-3.stl"]);
  await choose("step");
  await expect.poll(() => seen.slice(3)).toEqual(["bar.step"]);
  const request = tree.of("export").at(-1)!;
  expect((request.pieces as unknown[]).length, "the STEP takes the other two pieces").toBe(2);
  expect(request.names).toEqual(["bar-1", "bar-2", "bar-3"]);
}

test("a Form 4 cut keeps its pieces through save and reopen: Model opens on the split, Explode and Export… have every piece", async ({ page }) => {
  const tree = await openBar(page, false, COLUMN);
  await openCard(page);
  await applyForForm4(page);
  const cut = tree.of("apply").length;
  const doc = await saveAndReopen(page);
  const held = doc.heldPieces as { object: string; node: number; index: number; mesh: { encoding?: string }; brep?: { encoding?: string } }[];
  expect(held.map((piece) => [piece.object, piece.node, piece.index]), "each piece by its part's object, the cut's step and its number").toEqual([["part", 1, 2], ["part", 1, 3]]);
  for (const piece of held) expect([piece.mesh.encoding, piece.brep], "the mesh, compressed, and no solid: it is cut again when a call needs it").toEqual(["gzip+base64", undefined]);
  await expect(page.locator("#objectList .obj"), "the pieces stay off the plate").toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  await expectEveryPiece(page, tree, "reopened");
  const pieceOpens = tree.of("open").filter((request) => String(request.key).startsWith("part-part#"));
  expect(pieceOpens, "no piece opens from a saved solid").toEqual([]);
  const recut = tree.of("apply").slice(cut);
  expect(recut.map((request) => (request.op as { kind: string }).kind), "the open cuts both pieces again from the part, in one cut").toEqual(["partition"]);
  expect((recut[0]!.pieceKeys as (string | null)[]).every((key) => typeof key === "string"), "naming both pieces' trees").toBe(true);
  await expect(labels(page)).toHaveText(["bar.step", "Split to print for Formlabs Form 4, 3 parts"]);
  await page.locator("#modelUndo").click();
  await expect(page.getByRole("treeitem", { name: /^bar\.step/ }), "one Undo takes the Apply back").toHaveAttribute("aria-selected", "true");
  await page.locator("#tabPrepare").click();
  await page.keyboard.press("Control+z");
  await expect(page.locator("#objectList .obj"), "the reopen left no Prepare step to undo").toHaveCount(1);
});

test("a reopened Form 4 project opens Model on the split, and Prepare slices the whole part", async ({ page }) => {
  let slices = 0;
  await page.route("**/api/slice", (route) => {
    slices += 1;
    return route.fulfill({ status: 500, json: { error: "not sliced in this test" } });
  });
  await openBar(page, false, COLUMN);
  await openCard(page);
  await applyForForm4(page);
  await saveAndReopen(page);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  await expect(page.getByRole("treeitem", { name: SPLIT_ROW })).toHaveAttribute("aria-selected", "true");
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj-split")).toHaveText("Split for the Formlabs Form 4 in Model, 3 parts. The plate prints it whole.");
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => slices).toBe(1);
  await expect(page.locator("#banner")).not.toContainText("does not slice for");
});

test("a file 3.8.0 saved, with the cut but not its pieces, cuts them again when Model opens, and the next save keeps them", async ({ page }) => {
  const tree = await openBar(page, false, COLUMN);
  await openCard(page);
  await applyForForm4(page);
  await saveAndReopen(page, (doc) => delete doc.heldPieces);
  const cut = tree.of("apply").length;
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  await expect(page.getByRole("treeitem", { name: SPLIT_ROW })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => tree.of("apply").length, "one cut on a spare step").toBe(cut + 1);
  const again = tree.of("apply").at(-1)!;
  expect((again.op as { kind: string }).kind).toBe("partition");
  expect((again.pieceKeys as unknown[]).length, "a key for each missing piece").toBe(2);
  await expect(readout(page)).toContainText("cut again");
  await expectEveryPiece(page, tree, "healed");
  const doc = await saveAndReopen(page);
  expect((doc.heldPieces as unknown[]).length, "the next save keeps them").toBe(2);
});

// --- Milestone 5: connectors on a cut.
const jointsOn = (page: Page) => page.locator("#modelPartJointsOn");
const jointFields = (page: Page) => page.locator("#modelPartJointFields");

test("Connectors on shows the fields with the planner's defaults and the ghost's holes; off hides them", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await expect(jointsOn(page)).not.toBeChecked();
  await expect(jointFields(page), "a plain cut shows a plain card").toBeHidden();
  await jointsOn(page).check();
  await expect(jointFields(page)).toBeVisible();
  await expect(page.locator("#modelPartJointType")).toHaveValue("dowel");
  await expect(page.locator("#modelPartJointRadius")).toHaveValue("3");
  await expect(page.locator("#modelPartJointDepth")).toHaveValue("4");
  await expect(page.locator("#modelPartJointCount")).toHaveValue("");
  await expect(page.locator("#modelPartJointCount")).toHaveAttribute("placeholder", "Fit");
  await expect(page.locator("#modelPartJointMargin")).toHaveValue("3.95");
  await expect(page.locator("#modelPartJointGap")).toHaveValue("0.4");
  await expect(page.locator("#modelPartJointFit")).toHaveValue("snug");
  await expect(page.locator("#modelPartJointFitNote")).toHaveText("Starting fit. 0.15 mm each side (0.3 mm on the diameter).");
  await expect(page.locator("#modelPartJointHole")).toHaveValue("teardrop");
  await expect(page.locator("#modelPartJointDiameter"), "a hardware hole's diameter waits for its type").toBeHidden();
  await expect(page.locator("#modelPartJointSide"), "and so does the plug's side").toBeHidden();
  await expect(page.locator("#model"), "the ghost shows the planner's dowel on the selected cut").toHaveAttribute("data-connectors", "1");
  await expect.poll(() => ((tree.of("probe").at(-1)?.op as { cuts: Cut[] } | undefined)?.cuts[0]?.connectors?.placed ?? []).map((row) => row.id), "the check sends the placed dowel").toEqual(["c1-1"]);
  await expect(page.locator("#modelPartPieces li").last()).toContainText("Pins · 1");
  if ((await page.locator("#modelPartHowOpen").getAttribute("aria-expanded")) === "true") await page.locator("#modelPartHowOpen").click();
  await page.waitForTimeout(500);
  await shot(page, "connectors-on");

  await page.locator("#modelPartJointType").selectOption("plug");
  await expect(page.locator("#modelPartJointSide")).toBeVisible();
  await expect(page.locator("#modelPartJointSide")).toHaveValue("positive");
  await page.locator("#modelPartJointType").selectOption("hardware");
  await expect(page.locator("#modelPartJointDiameter")).toBeVisible();
  await expect(page.locator("#modelPartJointRadius")).toBeHidden();
  await expect(page.locator("#modelPartJointHole")).toBeHidden();
  await page.locator("#modelPartJointFit").selectOption("typed");
  await expect(page.locator("#modelPartJointClearance")).toHaveValue("0.15");
  await page.locator("#modelPartJointClearance").fill("0.2");
  await page.locator("#modelPartJointClearance").dispatchEvent("change");
  await expect(page.locator("#modelPartJointFitNote")).toHaveText("Typed. 0.2 mm each side (0.4 mm on the diameter).");

  await jointsOn(page).uncheck();
  await expect(jointFields(page), "off hides every connector field").toBeHidden();
  await expect(page.locator("#model"), "and the ghost's holes").toHaveAttribute("data-connectors", "0");
  await expect(page.locator("#modelPartPieces li"), "the plain cut's check: three pieces and no pins").toHaveCount(3);
});

// --- Milestone 6: the fit table and the fit coupon.
const fitNote = (page: Page) => page.locator("#modelPartJointFitNote");

test("Clearance names its source for each fit, and the XY hole compensation warning stays", async ({ page }) => {
  await openBar(page);
  await openCard(page);
  await jointsOn(page).check();
  await expect(fitNote(page), "PLA's Snug is a starting value").toHaveText("Starting fit. 0.15 mm each side (0.3 mm on the diameter).");
  await page.locator("#modelPartJointFit").selectOption("loose");
  await expect(fitNote(page)).toHaveText("Starting fit. 0.25 mm each side (0.5 mm on the diameter).");
  await page.locator("#modelPartJointFit").selectOption("press");
  await expect(fitNote(page)).toHaveText("Starting fit. 0.05 mm each side (0.1 mm on the diameter).");
  await page.locator("#modelPartJointFit").selectOption("typed");
  await page.locator("#modelPartJointClearance").fill("0.12");
  await page.locator("#modelPartJointClearance").dispatchEvent("change");
  await page.locator("#modelPartJointClearance").blur();
  await expect(fitNote(page), "a typed gap is its own source").toHaveText("Typed. 0.12 mm each side (0.24 mm on the diameter).");
  await page.locator("#modelPartJointFit").selectOption("snug");
  await expect(fitNote(page)).toHaveText("Starting fit. 0.15 mm each side (0.3 mm on the diameter).");
  await page.keyboard.press("Escape");

  // A slice setting changes the hole again: the card says so, and the solid's clearance stays.
  await page.locator("#tabPrepare").click();
  await page.locator("#levelPick").selectOption("advanced");
  await page.locator("#xyhole").fill("0.1");
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  await openCard(page);
  await jointsOn(page).check();
  await expect(fitNote(page)).toHaveText("Starting fit. 0.15 mm each side (0.3 mm on the diameter). XY hole compensation is 0.1 mm. It changes the hole again when slicing. Clearance here is the solid.");
  if ((await page.locator("#modelPartHowOpen").getAttribute("aria-expanded")) === "true") await page.locator("#modelPartHowOpen").click();
  await page.waitForTimeout(400);
  await shot(page, "fit-table-card");
});

test("Print a fit coupon… asks the engine for the layout of the card's dowel and adds the plate and its pin as objects", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await jointsOn(page).check();
  const button = page.locator("#modelPartCoupon");
  await expect(button).toHaveText("Print a fit coupon…");
  await expect(button).toHaveAttribute("data-tip", "Add a fit coupon and its pins to the plate");
  await button.click();
  await expect(page.locator("#modelPartCouponNote")).toContainText("Added fit-coupon-pla.step and fit-coupon-pla-pins.step to the plate. Fit coupon for PLA: 7 holes from 0.05 to 0.35 mm each side, for a 3 mm radius pin, and one pin to try in each.");
  await expect(page.locator("#modelPanelTitle"), "the card stays open on the part it was cutting").toHaveText("Split to print");
  await expect(page.locator("#modelPartCuts .sp-cut")).toHaveCount(2);
  const asked = tree.of("fitCoupon");
  expect(asked, "one engine call").toHaveLength(1);
  const spec = asked[0]!.spec as { holes: { radiusMm: number; teardrop: boolean; depthMm: number }[]; pins: { radiusMm: number; lengthMm: number }[]; sizeMm: number[]; strokes: unknown[][] };
  expect(spec.holes.map((hole) => hole.radiusMm), "the card's 3 mm dowel plus PLA's Snug 0.15 less 0.10 to plus 0.20").toEqual([3.05, 3.1, 3.15, 3.2, 3.25, 3.3, 3.35]);
  expect(spec.holes.every((hole) => hole.teardrop && hole.depthMm === 2.4), "teardrops, as deep as the card's dowel holes").toBe(true);
  expect(spec.pins).toEqual([expect.objectContaining({ radiusMm: 3, lengthMm: 4 })]);
  expect(spec.strokes.length, "the labels are strokes").toBeGreaterThan(20);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await expect(page.locator("#objectList .obj").nth(1)).toContainText("fit-coupon-pla.step");
  await expect(page.locator("#objectList .obj").nth(2)).toContainText("fit-coupon-pla-pins.step");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/split-print/coupon-on-plate.png" });
});

test("a clearance the card types is where the coupon is centred, and a refusal is the card's sentence", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await jointsOn(page).check();
  await page.locator("#modelPartJointFit").selectOption("typed");
  await page.locator("#modelPartJointClearance").fill("0.3");
  await page.locator("#modelPartJointClearance").dispatchEvent("change");
  await page.locator("#modelPartCoupon").click();
  await expect(page.locator("#modelPartCouponNote")).toContainText("7 holes from 0.2 to 0.5 mm each side");
  expect((tree.of("fitCoupon")[0]!.spec as { holes: { radiusMm: number }[] }).holes.map((hole) => hole.radiusMm)).toEqual([3.2, 3.25, 3.3, 3.35, 3.4, 3.45, 3.5]);
  await page.locator("#modelPartJointRadius").fill("1");
  await page.locator("#modelPartJointRadius").dispatchEvent("change");
  await page.locator("#modelPartCoupon").click();
  await expect(page.locator("#modelPartCouponNote")).toHaveText("The pin radius is 1 mm, under the 1.6 mm floor.");
  expect(tree.of("fitCoupon"), "a refusal asks nothing of the engine").toHaveLength(1);
});

test("for the Form 4 Print a fit coupon… saves STEP files and adds nothing to the plate", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await target(page).selectOption("formlabs-form-4");
  await jointsOn(page).check();
  await expect(fitNote(page)).toHaveText("Starting fit. 0.1 mm each side (0.2 mm on the diameter).");
  await expect(page.locator("#modelPartCoupon")).toHaveAttribute("data-tip", "Save a fit coupon for this printer as STEP files");
  const names: string[] = [];
  page.on("download", (download) => names.push(download.suggestedFilename()));
  await page.locator("#modelPartCoupon").click();
  await expect.poll(() => names).toEqual(["fit-coupon-resin.step", "fit-coupon-resin-pins.step"]);
  await expect(page.locator("#modelPartCouponNote")).toContainText("Saved fit-coupon-resin.step and fit-coupon-resin-pins.step. Fit coupon for resin: 7 holes from 0 to 0.3 mm each side");
  const spec = tree.of("fitCoupon")[0]!.spec as { holes: { radiusMm: number; teardrop: boolean }[] };
  expect(spec.holes.map((hole) => hole.radiusMm), "resin: no gap at the first step").toEqual([3, 3.05, 3.1, 3.15, 3.2, 3.25, 3.3]);
  expect(spec.holes.some((hole) => hole.teardrop), "a resin hole stays round").toBe(false);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
});

test("a typed count that does not fit says 2 of 4 and Use 2 writes the count", async ({ page }) => {
  await openBar(page, false, WIDE);
  await openCard(page);
  await jointsOn(page).check();
  await page.locator("#modelPartJointCount").fill("4");
  await page.locator("#modelPartJointCount").dispatchEvent("change");
  await expect(page.locator("#modelPartJointNotes")).toContainText("Cut 1: 2 of 4 dowels fit.");
  const use = page.locator("#modelPartJointUse");
  await expect(use).toBeVisible();
  await expect(use).toHaveText("Use 2");
  await expect(page.locator("#model")).toHaveAttribute("data-connectors", "2");
  if ((await page.locator("#modelPartHowOpen").getAttribute("aria-expanded")) === "true") await page.locator("#modelPartHowOpen").click();
  await page.waitForTimeout(500);
  await shot(page, "two-of-four");
  await use.click();
  await expect(page.locator("#modelPartJointCount")).toHaveValue("2");
  await expect(use).toBeHidden();
  await expect(page.locator("#modelPartJointNotes")).toBeHidden();
  await expect(apply(page)).toBeEnabled();
});

test("Apply with dowels makes the pins one more object, and Explode shows them with the pieces", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await jointsOn(page).check();
  await expect(page.locator("#modelPartPieces li").last()).toContainText("Pins · 1");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(labels(page)).toHaveText(["bar.step", "Split to print, 3 parts, dowels"]);
  const applied = tree.of("apply").at(-1)!;
  expect(typeof applied.pinsKey, "the apply asks for the pins' tree").toBe("string");
  expect((applied.op as { up?: unknown }).up, "and stores the print's up").toEqual([0, 0, 1]);
  await expect(page.locator("#objectList .obj"), "two pieces and the pins join the plate").toHaveCount(4);
  await expect(page.locator("#objectList .obj").nth(3)).toContainText("bar pins");
  await page.locator("#modelLookOpen").click();
  await page.locator("#modelExplode").check();
  await expect(page.locator("#model"), "the pins are exploded with the pieces").toHaveAttribute("data-explode-parts", /(^| )0:/);
  await page.keyboard.press("Escape");

  // One Prepare undo takes the pieces and the pins back together.
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(4);
  await page.keyboard.press("Control+z");
  await expect(page.locator("#objectList .obj"), "one undo takes the pins with the pieces").toHaveCount(1);
});

test("a Form 4 cut with dowels keeps its pins through save and reopen, and a file without them makes them again", async ({ page }) => {
  const tree = await openBar(page, false, COLUMN);
  await openCard(page);
  await target(page).selectOption("formlabs-form-4");
  await jointsOn(page).check();
  await expect(page.locator("#modelPartPieces li").last()).toContainText("Pins");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#modelPartDone")).toBeVisible();
  expect(typeof tree.of("apply").at(-1)!.pinsKey, "the apply asks for the pins' tree").toBe("string");
  const cut = tree.of("apply").length;
  const doc = await saveAndReopen(page);
  const held = doc.heldPieces as { index?: number; pins?: boolean }[];
  expect(held.map((piece) => piece.index ?? (piece.pins ? "pins" : null)), "the pins are kept beside the pieces").toEqual([2, 3, "pins"]);
  const explodeHasPins = async () => {
    await expect(page.getByRole("treeitem", { name: /^Split to print for Formlabs Form 4, 3 parts, dowels/ })).toHaveAttribute("aria-selected", "true");
    await page.locator("#modelLookOpen").click();
    await page.locator("#modelExplode").check();
    await expect(page.locator("#model"), "the pins explode with the pieces").toHaveAttribute("data-explode-parts", /^(?=.*(^| )0:)(?=.*(^| )3:)/);
    await page.keyboard.press("Escape");
    const seen: string[] = [];
    page.on("download", (download) => seen.push(download.suggestedFilename()));
    await page.getByRole("treeitem", { name: /^Split to print for Formlabs Form 4/ }).locator(".mh-more").click();
    await page.locator("#modelHistoryMenu [data-act=export]").click();
    await page.locator('#splitExport [data-format="stl"]').click();
    await expect.poll(() => seen, "the pins export last").toEqual(["bar-1.stl", "bar-2.stl", "bar-3.stl", "bar-pins.stl"]);
  };
  await page.locator("#tabModel").click();
  await explodeHasPins();
  await expect.poll(() => tree.of("apply").length, "the open's background cut, and nothing else").toBe(cut + 1);
  expect(typeof tree.of("apply").at(-1)!.pinsKey, "it makes the pins' solid too").toBe("string");

  const again = tree.of("apply").length;
  await saveAndReopen(page, (file) => delete file.heldPieces);
  await page.locator("#tabModel").click();
  await expect.poll(() => tree.of("apply").length, "one cut on a spare step").toBe(again + 1);
  expect(typeof tree.of("apply").at(-1)!.pinsKey, "which makes the pins again").toBe("string");
  await explodeHasPins();
});

test.describe("short window", () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test("the card opens the drawer the other Model tools use, and Esc closes both", async ({ page }) => {
    await openBar(page);
    const dock = page.locator("#leftDock");
    await expect(dock).toBeHidden();
    await openCard(page);
    await expect(dock, "the card opens the drawer").toBeVisible();
    await expect(cuts(page)).toHaveCount(2);
    await at(page, 1).focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#modelPanel")).toBeHidden();
    await expect(dock, "and the drawer goes with the card").toBeHidden();
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the same menu item in the top strip opens the card as the sheet", async ({ page }) => {
    await openBar(page, true);
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.locator("#modelFeatureMore").scrollIntoViewIfNeeded();
    await openCard(page);
    await expect(cuts(page)).toHaveCount(2);
    const sheet = (await page.locator("#modelPanel").boundingBox())!;
    expect(sheet.width, "full width").toBeGreaterThan(360);
    await expect(apply(page)).toBeEnabled();
    await page.locator("#modelCancel").tap();
    await expect(page.locator("#modelPanel")).toBeHidden();
  });
});

// --- Polish after 4.2.0: drag handles for a cut's joint and its connectors, typed fields in step, one Undo a drag.

/** Where each handle stands on the canvas, in page pixels: an arrow's grip is its head, so grip less seat is its way on screen. */
async function seatsOf(page: Page): Promise<Record<string, { x: number; y: number }>> {
  const text = (await page.locator("#model").getAttribute("data-handle-seat")) ?? "";
  const box = (await page.locator("#model").boundingBox())!;
  const map: Record<string, { x: number; y: number }> = {};
  for (const item of text.split(" ").filter(Boolean)) {
    const [id, place] = item.split(":");
    const [x, y] = place!.split(",").map(Number);
    map[id!] = { x: box.x + x!, y: box.y + y! };
  }
  return map;
}

/** The way cut 1's arrow points on screen, as a unit vector: the cut's normal, which a joint's depth knob slides along. */
async function normalOnScreen(page: Page): Promise<{ x: number; y: number }> {
  const head = await grip(page, "cut-1");
  const seat = (await seatsOf(page))["cut-1"]!;
  const length = Math.hypot(head.x - seat.x, head.y - seat.y) || 1;
  return { x: (head.x - seat.x) / length, y: (head.y - seat.y) / length };
}

/** Drag handle `id` by `dx`, `dy` pixels in eight moves, Ctrl held to snap to whole millimetres. */
async function dragHandle(page: Page, id: string, dx: number, dy: number) {
  const from = await grip(page, id);
  await page.mouse.move(from.x, from.y);
  await page.keyboard.down("Control");
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  await expect(page.locator(".interact-hud:not([hidden])"), "the heads-up field is up while the handle moves").toBeVisible();
  await page.mouse.up();
  await page.keyboard.up("Control");
}

const hud = (page: Page) => page.locator(".interact-hud:not([hidden])");

/** Zoom in on handle `id` until neighbouring dots no longer overlap, and let the camera settle. */
async function zoomOn(page: Page, id: string) {
  const at = await grip(page, id);
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 4; i += 1) await page.mouse.wheel(0, -400);
  await page.waitForTimeout(1500);
}
const typedOp = (tree: TreeMock) => tree.of("probe").at(-1)?.op as { cuts: { profile?: Shaped; connectors?: { on?: boolean; types?: { place?: string; at?: [number, number][] }[]; placed?: { id: string; uvMm: [number, number]; fixed: boolean }[] } }[] } | undefined;
const pointOf = async (page: Page, k: number) => [Number(await page.locator(`#modelPartJointAt-${k}-u`).inputValue()), Number(await page.locator(`#modelPartJointAt-${k}-v`).inputValue())];

test("a lap's depth knob drags along the cut's normal, writes Depth, and one Undo takes the drag and what was typed after it back", async ({ page }) => {
  const tree = await openBar(page);
  await openCard(page);
  await profileKind(page).selectOption("lap");
  await expect.poll(() => lastProfile(tree).depth).toBe(8);
  const probes = tree.of("probe").length;
  const way = await normalOnScreen(page);
  await dragHandle(page, "joint-depth", way.x * 40, way.y * 40);
  const dragged = Number(await page.locator("#modelPartProfileDepth").inputValue());
  expect(dragged, "the drag changed the depth").not.toBe(8);
  expect(Number.isInteger(dragged), `Ctrl snaps to whole millimetres, got ${dragged}`).toBe(true);
  await expect.poll(() => lastProfile(tree).depth, "the release checks the dragged depth").toBe(dragged);
  expect(tree.of("probe").length - probes, "one kernel check, at the release").toBe(1);
  await expect(hud(page).locator("input").first()).toHaveAttribute("data-field", "modelPartProfileDepth");
  await page.keyboard.type("12");
  await page.keyboard.press("Enter");
  await expect(hud(page)).toHaveCount(0);
  await expect(page.locator("#modelPartProfileDepth"), "the typed field follows the heads-up field").toHaveValue("12");
  await expect.poll(() => lastProfile(tree).depth).toBe(12);
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelPartProfileDepth"), "one Undo: the drag and the number typed after it").toHaveValue("");
  await expect(page.locator("#modelPartProfileDepth"), "back to the planner's depth").toHaveAttribute("placeholder", "8");
  await expect(profileKind(page), "the lap itself is a step of its own").toHaveValue("lap");
  await page.locator("#modelRedo").click();
  await expect(page.locator("#modelPartProfileDepth")).toHaveValue("12");
  const knob = await grip(page, "joint-depth");
  await page.locator("#modelPartProfileDepth").fill("30");
  await page.locator("#modelPartProfileDepth").dispatchEvent("change");
  await expect.poll(() => lastProfile(tree).depth).toBe(30);
  await expect.poll(async () => Math.hypot((await grip(page, "joint-depth")).x - knob.x, (await grip(page, "joint-depth")).y - knob.y), "a typed depth moves the knob").toBeGreaterThan(4);
  if ((await page.locator("#modelPartHowOpen").getAttribute("aria-expanded")) === "true") await page.locator("#modelPartHowOpen").click();
  await zoomOn(page, "joint-depth");
  const lit = await grip(page, "joint-depth");
  await page.mouse.move(lit.x, lit.y);
  await expect(page.locator("#model")).toHaveAttribute("data-aspect", "joint-depth");
  await page.waitForTimeout(400);
  await shot(page, "handles-lap-depth");
});

test("dragging a dowel across the cut places the cut's dowels by hand: their U and V fields follow, typing moves them, Refit and Undo", async ({ page }) => {
  const tree = await openBar(page, false, WIDE);
  await openCard(page);
  await jointsOn(page).check();
  await expect.poll(() => (typedOp(tree)?.cuts[0]?.connectors?.placed ?? []).length, "Fit places three dowels across the 60 mm").toBe(3);
  await expect(page.locator("#modelPartJointPoints"), "placed by Fit, there are no points to type").toBeHidden();
  for (const id of ["joint-1", "joint-2", "joint-3"]) await grip(page, id);
  await zoomOn(page, "joint-2");
  await dragHandle(page, "joint-2", 8, 8);
  await expect(page.locator("#modelPartJointPoints")).toBeVisible();
  const moved = await pointOf(page, 2);
  expect(moved, "the middle dowel moved").not.toEqual([0, 0]);
  expect(moved.every(Number.isInteger), `Ctrl snaps to whole millimetres, got ${moved}`).toBe(true);
  expect(await pointOf(page, 1), "the others stay where Fit put them").toEqual([-24, 0]);
  expect(await pointOf(page, 3)).toEqual([24, 0]);
  await expect(page.locator("#modelPartJointCount")).toHaveAttribute("placeholder", "By hand");
  await expect.poll(() => typedOp(tree)?.cuts[0]?.connectors?.types?.[0], "the check sends the points as fixed").toEqual(expect.objectContaining({ place: "fixed", at: [[-24, 0], moved, [24, 0]] }));
  // The heads-up field takes U, then V after Tab.
  await expect(hud(page).locator("input").first()).toHaveAttribute("data-field", "modelPartJointAt-2-u");
  await page.keyboard.type("6");
  await page.keyboard.press("Tab");
  await page.keyboard.type("-3");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelPartJointAt-2-u")).toHaveValue("6");
  await expect(page.locator("#modelPartJointAt-2-v")).toHaveValue("-3");
  await expect.poll(() => typedOp(tree)?.cuts[0]?.connectors?.types?.[0]?.at).toEqual([[-24, 0], [6, -3], [24, 0]]);
  expect((typedOp(tree)?.cuts[0]?.connectors?.placed ?? []).map((row) => [row.uvMm, row.fixed]), "all three are built where they were put").toEqual([[[-24, 0], true], [[6, -3], true], [[24, 0], true]]);
  // A typed V moves the dowel, and its dot with it.
  const before = await grip(page, "joint-1");
  await page.locator("#modelPartJointAt-1-v").fill("4");
  await page.locator("#modelPartJointAt-1-v").dispatchEvent("change");
  await expect.poll(() => typedOp(tree)?.cuts[0]?.connectors?.types?.[0]?.at).toEqual([[-24, 4], [6, -3], [24, 0]]);
  await expect.poll(async () => Math.hypot((await grip(page, "joint-1")).x - before.x, (await grip(page, "joint-1")).y - before.y), "its dot follows the typed V").toBeGreaterThan(1);
  if ((await page.locator("#modelPartHowOpen").getAttribute("aria-expanded")) === "true") await page.locator("#modelPartHowOpen").click();
  await page.locator("#modelPartJointRefit").scrollIntoViewIfNeeded();
  const dot = await grip(page, "joint-2");
  await page.mouse.move(dot.x, dot.y);
  await expect(page.locator("#model")).toHaveAttribute("data-aspect", "joint-2");
  await page.waitForTimeout(400);
  await shot(page, "handles-dowels-by-hand");
  // Undo: the typed V, then the drag with what the heads-up field typed; Redo brings the drag back.
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelPartJointAt-1-v")).toHaveValue("0");
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelPartJointPoints"), "one Undo takes the whole drag back to Fit").toBeHidden();
  await expect(page.locator("#modelPartJointCount")).toHaveAttribute("placeholder", "Fit");
  await page.locator("#modelRedo").click();
  await expect(page.locator("#modelPartJointAt-2-u")).toHaveValue("6");
  await page.locator("#modelPartJointRefit").click();
  await expect(page.locator("#modelPartJointPoints"), "Refit spreads them by Fit again").toBeHidden();
  await expect(page.locator("#modelPartJointCount")).toHaveAttribute("placeholder", "Fit");
  await expect(page.locator("#model"), "and the ghost has the three Fit dowels").toHaveAttribute("data-connectors", "3");
});

test("dowels placed by hand are stored fixed, and the pencil reopens them by hand", async ({ page }) => {
  const tree = await openBar(page, false, WIDE);
  await openCard(page);
  await jointsOn(page).check();
  await expect.poll(() => (typedOp(tree)?.cuts[0]?.connectors?.placed ?? []).length).toBe(3);
  await zoomOn(page, "joint-2");
  await dragHandle(page, "joint-1", 5, -5);
  await page.keyboard.type("-20");
  await page.keyboard.press("Tab");
  await page.keyboard.type("4");
  await page.keyboard.press("Enter");
  expect(await pointOf(page, 1)).toEqual([-20, 4]);
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#objectList .obj")).toHaveCount(4);
  const stored = (tree.of("apply").at(-1)!.op as { cuts: { connectors: { types: { place: string; at: [number, number][] }[]; placed: { uvMm: [number, number]; fixed: boolean }[] } }[] }).cuts[0]!.connectors;
  expect(stored.types[0]!.place).toBe("fixed");
  expect(stored.placed.map((row) => [row.uvMm, row.fixed])).toEqual([[[-20, 4], true], [[0, 0], true], [[24, 0], true]]);
  await page.getByRole("treeitem", { name: /^Split to print, 3 parts/ }).locator(".mh-edit").click();
  await expect(page.locator("#modelPartJointPoints"), "the pencil reopens the dowels by hand").toBeVisible();
  expect(await pointOf(page, 1)).toEqual([-20, 4]);
  await expect(apply(page), "an untouched edit offers no Update").toBeDisabled();
});

test("a tongue takes dowels on the flats beside it, and with no room the cut says what would fit", async ({ page }) => {
  const tree = await openBar(page, false, WIDE);
  await openCard(page);
  await profileKind(page).selectOption("tongue");
  await jointsOn(page).check();
  await expect(page.locator("#modelPartStatus")).toHaveText("Cut 1: no dowel fits beside the tongue. The flats beside it hold a circle 6.8 mm across at most. A dowel of radius 2.47 mm or less fits.");
  await expect(apply(page)).toBeDisabled();
  await page.locator("#modelPartJointRadius").fill("2");
  await page.locator("#modelPartJointRadius").dispatchEvent("change");
  await expect(page.locator("#modelPartStatus")).toBeHidden();
  await expect.poll(() => (typedOp(tree)?.cuts[0]?.connectors?.placed ?? []).length, "three on each side of the tongue").toBe(6);
  await expect(page.locator("#model")).toHaveAttribute("data-connectors", "6");
  await expect(apply(page)).toBeEnabled();
  if ((await page.locator("#modelPartHowOpen").getAttribute("aria-expanded")) === "true") await page.locator("#modelPartHowOpen").click();
  await zoomOn(page, "joint-2");
  await page.mouse.move(1300, 880);
  await page.waitForTimeout(400);
  await shot(page, "tongue-dowels");
});

// --- Polish after 4.2.0: a reopened Form 4 project cuts its held pieces' solids again in the background, one job a cut.

/** A gate for the next partition apply: `arm` holds it until `open`. */
function cutGate() {
  let release = () => {};
  let armed = false;
  const held = new Promise<void>((resolve) => (release = resolve));
  return {
    arm: () => (armed = true),
    open: () => release(),
    applyGate: (request: { op?: unknown }) => {
      if (!armed || (request.op as { kind?: string } | undefined)?.kind !== "partition") return undefined;
      armed = false;
      return held;
    },
  };
}

const partitionCuts = (tree: TreeMock, from: number) => tree.of("apply").slice(from).filter((request) => (request.op as { kind?: string }).kind === "partition");

test("a reopened Form 4 project cuts its pieces again in the background, once, and a STEP export waits for that cut", async ({ page }) => {
  const gate = cutGate();
  const tree = await openBar(page, false, COLUMN, { applyGate: gate.applyGate });
  await openCard(page);
  await applyForForm4(page);
  const before = tree.of("apply").length;
  gate.arm();
  await saveAndReopen(page);
  await expect.poll(() => partitionCuts(tree, before).length, "the open starts the cut by itself").toBe(1);
  await expect(page.locator("#model")).toHaveAttribute("data-held-warm", "1");
  expect(partitionCuts(tree, before)[0]!.pieceKeys, "one cut for both pieces").toEqual([expect.any(String), expect.any(String)]);
  // The plate is in use while the cut is held: Model opens on the split, and Export… STEP waits for that same cut.
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  const seen: string[] = [];
  page.on("download", (download) => seen.push(download.suggestedFilename()));
  await page.getByRole("treeitem", { name: SPLIT_ROW }).locator(".mh-more").click();
  await page.locator("#modelHistoryMenu [data-act=export]").click();
  await page.locator('#splitExport [data-format="step"]').click();
  await expect(readout(page), "the export shows its busy state while it waits").toContainText("Writing the pieces");
  await page.waitForTimeout(500);
  expect(tree.of("export").length, "no export before the cut answers").toBe(0);
  expect(partitionCuts(tree, before).length, "and no second cut").toBe(1);
  await expect(page.locator("#model"), "not ready while the cut is held").not.toHaveAttribute("data-held-ready", /./);
  gate.open();
  await expect.poll(() => seen).toEqual(["bar.step"]);
  await expect(page.locator("#model")).toHaveAttribute("data-held-ready", "1");
  expect((tree.of("export").at(-1)!.pieces as unknown[]).length).toBe(2);
  // A second STEP finds the solids ready: still one cut for this open.
  await page.getByRole("treeitem", { name: SPLIT_ROW }).locator(".mh-more").click();
  await page.locator("#modelHistoryMenu [data-act=export]").click();
  await page.locator('#splitExport [data-format="step"]').click();
  await expect.poll(() => seen.length).toBe(2);
  expect(partitionCuts(tree, before).length, "one job for the open").toBe(1);
  await expect(page.locator("#model")).toHaveAttribute("data-held-warm", "1");
});

test("a background cut that a new file makes stale is discarded: its trees close, and the new plate never sees them", async ({ page }) => {
  const gate = cutGate();
  const tree = await openBar(page, false, COLUMN, { applyGate: gate.applyGate });
  await openCard(page);
  await applyForForm4(page);
  const before = tree.of("apply").length;
  gate.arm();
  await saveAndReopen(page);
  await expect.poll(() => partitionCuts(tree, before).length).toBe(1);
  const pieceKeys = partitionCuts(tree, before)[0]!.pieceKeys as string[];
  // A new file replaces the plate while the cut is held.
  await page.locator("#file").setInputFiles({ name: "other.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await expect(page.locator("#objectList .obj").first()).toContainText("other");
  const closes = tree.of("close").length;
  gate.open();
  await expect.poll(() => tree.of("close").slice(closes).map((request) => request.key), "the stale cut's piece trees close").toEqual(expect.arrayContaining(pieceKeys));
  await expect(page.locator(".toast"), "and nothing is said about it").toHaveCount(0);
  await expect(page.locator("#model")).toHaveAttribute("data-held-warm", "1");
});

test("an Update while the background cut runs keeps both apart: the cut fills the old step's pieces, the export uses the Update's", async ({ page }) => {
  const gate = cutGate();
  const tree = await openBar(page, false, COLUMN, { applyGate: gate.applyGate });
  await openCard(page);
  await applyForForm4(page);
  const before = tree.of("apply").length;
  gate.arm();
  await saveAndReopen(page);
  await expect.poll(() => partitionCuts(tree, before).length).toBe(1);
  const stale = partitionCuts(tree, before)[0]!.pieceKeys as string[];
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  await page.getByRole("treeitem", { name: SPLIT_ROW }).locator(".mh-edit").click();
  await at(page, 1).fill("150");
  await at(page, 1).dispatchEvent("change");
  await expect(apply(page)).toBeEnabled();
  const closes = tree.of("close").length;
  await apply(page).click();
  await expect.poll(() => tree.of("edit").length, "the Update cuts while the background cut is held").toBe(1);
  await expect(page.locator("#modelPartDone")).toBeVisible();
  const fresh = tree.of("edit")[0]!.pieceKeys as string[];
  expect(fresh.some((key) => stale.includes(key)), "with pieces of its own").toBe(false);
  gate.open();
  await page.waitForTimeout(500);
  expect(tree.of("close").slice(closes).map((request) => request.key).some((key) => fresh.includes(String(key))), "the Update's do not").toBe(false);
  const seen: string[] = [];
  page.on("download", (download) => seen.push(download.suggestedFilename()));
  await page.locator("#modelPartExport").click();
  await page.locator('#splitExport [data-format="step"]').click();
  await expect.poll(() => seen).toEqual(["bar.step"]);
  const exported = (tree.of("export").at(-1)!.pieces as { key: string }[]).map((piece) => piece.key);
  expect(exported.length > 0 && exported.every((key) => fresh.includes(key) && !stale.includes(key)), `the export names the Update's pieces, ${exported}`).toBe(true);
  expect(partitionCuts(tree, before).length, "and needs no cut of its own").toBe(1);
});
