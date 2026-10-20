import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 × 20 × 10 box from the origin, as the modeler reports a solid, `volumeMm3` of it left. */
function boxSolid(volumeMm3 = 4000): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * 10];
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
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 400 })), edges: [] };
}

interface HoleBody {
  radius: number;
  depth: number;
  through?: boolean;
  counterboreRadius?: number;
  counterboreDepth?: number;
}

/** A hole down through the 10 mm box takes its cylinders off, rounded to whole mm³ as the readout shows them. */
function holeVolume(parent: MockSolid, op: HoleBody): number {
  const length = op.through ? 10 : op.depth;
  const bore = op.counterboreRadius != null ? Math.PI * (op.counterboreRadius ** 2 - op.radius ** 2) * op.counterboreDepth! : 0;
  return Math.round(parent.volumeMm3 - Math.PI * op.radius ** 2 * length - bore);
}

async function openModel(page: Page): Promise<TreeMock> {
  const root = boxSolid();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => root,
    apply: (request: Body, parent: MockSolid) => boxSolid(holeVolume(parent, request.op as HoleBody)),
    probe: () => ({ ok: true }),
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
const note = (page: Page) => page.locator("#modelNote");
const apply = (page: Page) => page.locator("#modelApply");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const canvas = (page: Page) => page.locator("#model");
const positionRow = (page: Page) => page.locator("#modelPositionOpen");
const positionText = (page: Page) => page.locator("#modelPositionText");
const reset = (page: Page) => page.locator("#modelPositionReset");

async function openHole(page: Page) {
  if ((await page.locator("#modelToolHole").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelPanel")).toBeVisible();
}

/** The handles on the canvas, by id. */
async function grips(page: Page): Promise<Record<string, { x: number; y: number }>> {
  const text = (await canvas(page).getAttribute("data-handles")) ?? "";
  const box = (await canvas(page).boundingBox())!;
  const map: Record<string, { x: number; y: number }> = {};
  for (const item of text.split(" ").filter(Boolean)) {
    const [id, at] = item.split(":");
    const [x, y] = at!.split(",").map(Number);
    map[id!] = { x: box.x + x!, y: box.y + y! };
  }
  return map;
}

/** The ghost's world box: its centre and its size in millimetres. */
async function ghost(page: Page): Promise<{ at: number[]; size: number[] }> {
  const numbers = ((await canvas(page).getAttribute("data-ghost")) ?? "").split(" ").map(Number);
  return { at: numbers.slice(0, 3), size: numbers.slice(3, 6) };
}

/** The last op an `edit` call sent. */
const lastEdit = (tree: TreeMock) => tree.of("edit").at(-1)!.op as Record<string, unknown>;

test("Hole says where it drills: straight down until a face is picked, then into that face", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelPickEdge").click();
  await openHole(page);
  await expect(page.locator("#modelPickFace"), "Hole picks faces, so a click is a face to drill into").toHaveAttribute("aria-pressed", "true");
  await expect(note(page)).toContainText("Straight down; click a face to drill into it.");
  await page.locator("#modelCancel").click();

  // A click on the solid picks a face; Hole opens on it.
  const [x, y, w, h] = ((await canvas(page).getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + x! + w! * 0.5, box.y + y! + h! * 0.5);
  await expect(readout(page)).toContainText("Face");
  await openHole(page);
  await expect(note(page)).toContainText("Into the picked face.");
});

test("Through all turns Depth and its knob off, sends a flag rather than a length, and labels the step", async ({ page }) => {
  const tree = await openModel(page);
  await openHole(page);
  await expect(page.locator("#modelHoleD")).toBeEnabled();
  await expect.poll(async () => Object.keys(await grips(page))).toContain("hole-depth");
  await page.locator("#modelHoleR").fill("4");
  await page.locator("#modelHoleR").dispatchEvent("input");

  await page.locator("#modelThrough").check();
  await expect(page.locator("#modelHoleD"), "no depth to type").toBeDisabled();
  await expect.poll(async () => Object.keys(await grips(page)), "no depth to drag").not.toContain("hole-depth");
  // The ghost runs from the top through the 10 mm box and 1 mm past it, as the kernel cuts it.
  await expect.poll(async () => (await ghost(page)).size[2]).toBeCloseTo(11, 1);

  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText(`Volume ${holeVolume(boxSolid(), { radius: 2, depth: 12, through: true })} mm³`);
  const op = tree.of("apply").at(-1)!.op as Record<string, unknown>;
  expect(op).toMatchObject({ kind: "hole", radius: 2, depth: 12, through: true });
  expect(op, "no counterbore is sent while its box is off").not.toHaveProperty("counterboreRadius");
  await expect(rows(page).nth(1)).toContainText("Hole ⌀4 through");
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();

  // Opened again, Hole starts from the numbers applied last.
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelThrough")).toBeChecked();
  await page.locator("#modelThrough").uncheck();
  await expect(page.locator("#modelHoleD")).toBeEnabled();
  await page.locator("#modelCancel").click();

  // An edit of the through step ticks the box for itself only: a new hole after it opens as the panel had it.
  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelThrough")).toBeChecked();
  await page.locator("#modelCancel").click();
  await openHole(page);
  await expect(page.locator("#modelThrough"), "the edit's Through all does not stay").not.toBeChecked();
  await expect(page.locator("#modelHoleD")).toBeEnabled();
});

test("a counterbore has its fields and knobs, a screw fills them, and Edit step opens and updates each new field", async ({ page }) => {
  const tree = await openModel(page);
  await openHole(page);
  await expect(page.locator("#modelBoreR"), "the counterbore's fields wait for its box").toBeHidden();
  await page.locator("#modelCounterbore").check();
  await expect(page.locator("#modelBoreR")).toBeVisible();
  await expect(page.locator("#modelBoreD")).toBeVisible();
  await expect.poll(async () => Object.keys(await grips(page)).sort()).toEqual(["bore-depth", "bore-radius", "hole-depth", "hole-move-u", "hole-move-v", "hole-origin", "hole-radius"]);

  // A knob drags its number, as every Model number drags.
  const before = Number(await page.locator("#modelBoreR").inputValue());
  const knob = (await grips(page))["bore-radius"]!;
  const centre = (await grips(page))["hole-radius"]!;
  await page.mouse.move(knob.x, knob.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(knob.x + ((knob.x - centre.x) * i) / 40, knob.y + ((knob.y - centre.y) * i) / 40 - i * 3);
  await page.mouse.up();
  await expect.poll(async () => Number(await page.locator("#modelBoreR").inputValue())).not.toBe(before);

  // M3: a ⌀3.4 clearance hole through, counterbored ⌀6.5 × 3.4.
  await page.locator("#modelScrew").selectOption("M3");
  await expect(page.locator("#modelThrough")).toBeChecked();
  await expect(page.locator("#modelCounterbore")).toBeChecked();
  for (const [id, value] of [["#modelHoleR", "3.4"], ["#modelBoreR", "6.5"], ["#modelBoreD", "3.4"]] as const) await expect(page.locator(id)).toHaveValue(value);
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  // The click returns before the apply request is recorded. Wait for that call.
  await expect.poll(() => tree.of("apply").at(-1)?.op).toMatchObject({ kind: "hole", radius: 1.7, through: true, counterboreRadius: 3.25, counterboreDepth: 3.4 });
  await expect(rows(page).nth(1)).toContainText("Hole ⌀3.4 through, counterbore ⌀6.5 × 3.4");
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();

  // Edit step: every new field comes back as the step has it.
  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelEditHead")).toHaveText("Editing step 1: Hole ⌀3.4 through, counterbore ⌀6.5 × 3.4");
  await expect(page.locator("#modelThrough")).toBeChecked();
  await expect(page.locator("#modelCounterbore")).toBeChecked();
  await expect(page.locator("#modelHoleD")).toBeDisabled();
  for (const [id, value] of [["#modelHoleR", "3.4"], ["#modelBoreR", "6.5"], ["#modelBoreD", "3.4"]] as const) await expect(page.locator(id)).toHaveValue(value);
  await expect(page.locator("#modelScrew")).toHaveValue("M3");
  await expect(apply(page), "the step as it is would change nothing").toBeDisabled();

  // Each field, edited in turn: Through all off with a depth, then the bore's radius, its depth, and the bore itself off.
  const update = async () => {
    await expect(apply(page)).toBeEnabled();
    await apply(page).click();
    await expect(page.locator("#modelPanel")).toBeHidden();
  };
  await page.locator("#modelThrough").uncheck();
  await page.locator("#modelHoleD").fill("8");
  await update();
  expect(lastEdit(tree)).toMatchObject({ radius: 1.7, depth: 8, counterboreRadius: 3.25, counterboreDepth: 3.4 });
  expect(lastEdit(tree)).not.toHaveProperty("through");

  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelThrough")).not.toBeChecked();
  await expect(page.locator("#modelHoleD")).toHaveValue("8");
  await page.locator("#modelBoreR").fill("8");
  await update();
  expect(lastEdit(tree)).toMatchObject({ depth: 8, counterboreRadius: 4, counterboreDepth: 3.4 });

  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelBoreR")).toHaveValue("8");
  await page.locator("#modelBoreD").fill("2");
  await update();
  expect(lastEdit(tree)).toMatchObject({ counterboreRadius: 4, counterboreDepth: 2 });

  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelBoreD")).toHaveValue("2");
  await page.locator("#modelCounterbore").uncheck();
  await expect(page.locator("#modelBoreR")).toBeHidden();
  await update();
  expect(lastEdit(tree)).toMatchObject({ kind: "hole", radius: 1.7, depth: 8 });
  expect(lastEdit(tree)).not.toHaveProperty("counterboreRadius");
  await expect(rows(page).filter({ hasText: "Hole ⌀3.4 depth 8" }).first()).toBeVisible();
});

test("the Position row shows the pose, opens Place, and Reset is one undoable step that asks the engine nothing", async ({ page }) => {
  const tree = await openModel(page);
  await expect(page.getByRole("group", { name: "Position" })).toBeVisible();
  await expect(positionText(page)).toHaveText("At file position");
  await expect(reset(page), "nothing to reset at the file position").toBeHidden();
  await expect(page.locator("#modelHistoryTree #modelPosition"), "the row is not in the tree").toHaveCount(0);
  await openHole(page);
  await apply(page).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  const calls = tree.calls.length;

  // Clicking the row opens Place.
  await positionRow(page).click();
  await expect(page.locator("#modelToolPlace")).toHaveAttribute("aria-pressed", "true");
  // A row's element is kept: a move repaints the Position row, never the tree.
  await rows(page).first().evaluate((el) => ((el as HTMLElement & { kept?: boolean }).kept = true));
  await page.locator("#modelPlaceX").fill("10");
  await expect(positionText(page), "it follows Place as it types").toHaveText("X 10");
  await page.locator("#modelPlaceRz").fill("30");
  await page.locator("#modelPlaceRz").press("Tab");
  await expect(positionText(page)).toHaveText("X 10 · Turn Z 30°");
  await expect(positionRow(page)).toHaveAttribute("aria-label", "Position: X 10 · Turn Z 30°. Opens Place.");
  expect(await rows(page).first().evaluate((el) => (el as HTMLElement & { kept?: boolean }).kept)).toBe(true);

  // Reset while Place is open: the part is back where its file put it, and Undo takes it back as a Place step.
  await expect(reset(page)).toBeVisible();
  await reset(page).click();
  await expect(positionText(page)).toHaveText("At file position");
  await expect(reset(page)).toBeHidden();
  await expect(canvas(page)).toHaveAttribute("data-solid", "0.00,0.00,0.00,20.00,20.00,10.00");
  await expect(page.locator("#modelPlaceX")).toHaveValue("0");
  await page.locator("#modelUndo").click();
  await expect(positionText(page)).toHaveText("X 10 · Turn Z 30°");
  await page.locator("#modelCancel").click();
  expect(tree.calls.length, "the row asks the engine nothing").toBe(calls);

  // Leave Model with the part moved, come back, Reset, leave: Prepare undo takes the Reset back.
  await page.locator("#tabPrepare").click();
  await page.locator("#tabModel").click();
  await expect(positionText(page)).toHaveText("X 10 · Turn Z 30°");
  await reset(page).click();
  await expect(positionText(page)).toHaveText("At file position");
  await page.locator("#tabPrepare").click();
  await page.keyboard.press("Control+z");
  await page.locator("#tabModel").click();
  await expect(positionText(page), "Prepare undo puts the pose back").toHaveText("X 10 · Turn Z 30°");

  // Reset with Hole open goes through Place, which closes Hole: its checked numbers were for the old pose.
  await openHole(page);
  await reset(page).click();
  await expect(page.locator("#modelToolPlace")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelToolHole")).toHaveAttribute("aria-pressed", "false");
  await expect(positionText(page)).toHaveText("At file position");
  await page.locator("#modelUndo").click();
  await expect(positionText(page)).toHaveText("X 10 · Turn Z 30°");

  // The row is no step: no menu, no rename, and tree keys pass it by. Leaving Model wrote a STEP and Hole checked
  // its hole above; from here on nothing asks.
  await expect.poll(() => tree.of("export").length).toBeGreaterThan(0);
  const asked = tree.calls.length;
  await positionRow(page).click({ button: "right" });
  await expect(page.locator("#modelHistoryMenu")).toBeHidden();
  await positionText(page).dblclick();
  await expect(page.locator(".mh-rename")).toHaveCount(0);
  await page.locator("#modelCancel").click();
  await positionRow(page).focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("F2");
  await expect(page.locator(".mh-rename")).toHaveCount(0);
  await expect(rows(page), "Delete on the row drops no branch").toHaveCount(2);
  expect(tree.of("drop")).toHaveLength(0);
  await page.keyboard.press("Shift+H");
  await expect(rows(page).nth(1), "Shift+H goes into the tree, past the row").toBeFocused();
  expect(tree.calls.length, "nothing here asks the engine").toBe(asked);
});
