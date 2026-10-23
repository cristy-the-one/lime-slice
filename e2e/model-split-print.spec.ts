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

type Cut = { origin: V; normal: V };

/** A 400 mm tall column: the Form 4 builds 210 mm, so it takes three pieces across Z. */
const COLUMN = boxSolid([20, 20, 400]);

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
    return { kept: kept!, pieces };
  }
  // A Boolean cut takes its box out of the part, and misses a part it does not reach.
  if (op.kind === "boolean" && op.origin && op.size) {
    const { min, max } = boxOf(parent);
    if (op.origin[0] >= max[0] || op.origin[0] + op.size[0] <= min[0]) return { error: "The tool misses the solid" };
    return { ...parent, volumeMm3: parent.volumeMm3 - op.size[0] * op.size[1] * op.size[2] };
  }
  return parent;
}

async function openBar(page: Page, compact = false, part: MockSolid = BAR): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: part.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => part,
    apply: built,
    probe(request, on) {
      const op = request.op as { kind: string; cuts?: Cut[] };
      if (op.kind !== "partition") return { ok: true };
      const parts = piecesOf(on, op.cuts!).map((piece) => ({ volumeMm3: piece.volumeMm3, ...boxOf(piece) }));
      return { ok: true, volumeMm3: parts[0]!.volumeMm3, parts };
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

async function save(page: Page): Promise<{ objects: { id: string; name: string; placement: { offset: { x: number; y: number } }; modelTree?: unknown }[] }> {
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

test("Apply for the Form 4 leaves the plate as it was, the commit and a slice refuse, and Explode shows three pieces", async ({ page }) => {
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
  await expect(page.locator("#banner")).toContainText(sentence);
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.locator("#fileMenu > summary").click();
  await page.locator("#export3mf").click();
  await page.waitForTimeout(400);
  expect(downloads, "the plate's 3MF is refused too").toEqual([]);
  await expect(page.locator("#banner")).toContainText(sentence);
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
