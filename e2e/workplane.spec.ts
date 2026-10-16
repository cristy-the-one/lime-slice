import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 × 20 × 10 mm box from the origin as the modeler reports it, `volumeMm3` of it left. */
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
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

async function openModel(page: Page): Promise<TreeMock> {
  const root = boxSolid();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: () => root, apply: (_request: Body, parent: MockSolid) => boxSolid(parent.volumeMm3 - 100), probe: () => ({ ok: true }) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  return tree;
}

const canvas = (page: Page) => page.locator("#model");
const note = (page: Page) => page.locator("#modelNote");
const apply = (page: Page) => page.locator("#modelApply");
const label = (page: Page, id: string) => page.locator(`label:has(#${id}) .scrub-label`);
/** The plate pose's turn, as Prepare's fields show it: Model never changes it unless asked. */
const plateTurn = async (page: Page) => Promise.all(["#placeRx", "#placeRy", "#placeRz"].map((id) => page.locator(id).inputValue()));

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

async function drag(page: Page, id: string, dx: number, dy: number) {
  await expect.poll(async () => Object.keys(await grips(page))).toContain(id);
  const from = (await grips(page))[id]!;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  await page.mouse.up();
}

/** The ghost's model-space box: its centre and its size. */
async function ghost(page: Page): Promise<{ at: number[]; size: number[] }> {
  const numbers = ((await canvas(page).getAttribute("data-ghost")) ?? "").split(" ").map(Number);
  return { at: numbers.slice(0, 3), size: numbers.slice(3, 6) };
}

/** A click on the box's +X side, as the Model camera first frames it. */
async function clickSide(page: Page) {
  const [x, y, w, h] = ((await canvas(page).getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + x! + w! * 0.75, box.y + y! + h! * 0.75);
}

const SIDE = "face:20.00,10.00,5.00:90.00,0.00,90.00";

async function onSide(page: Page) {
  await page.locator("#modelToolWorkplane").click();
  await page.locator("#modelWpFace").click();
  await expect(note(page)).toHaveText("Click a flat face to put the frame on it.");
  await expect(page.locator("#modelWpFace"), "Face waits for a pick").toHaveAttribute("aria-pressed", "true");
  await clickSide(page);
  await expect(canvas(page)).toHaveAttribute("data-workplane", SIDE);
}

test("the toolbar fits at 1440 px with the Workplane tool, a pick chip and Bed", async ({ page }) => {
  await openModel(page);
  const fits = () => page.locator(".model-tools").evaluate((bar) => bar.scrollWidth <= bar.clientWidth);
  expect(await fits()).toBe(true);
  await clickSide(page);
  await expect(page.locator("#modelCount")).toBeVisible();
  expect(await fits(), "a pick's chip still fits").toBe(true);
  await expect(page.locator("#modelBedToggle")).toBeInViewport();
  await expect(page.locator("#modelToolWorkplane")).toHaveText("Workplane");
  await expect(page.locator("#modelUndo"), "an icon button keeps its name").toHaveAccessibleName("Undo");
});

test("the frame is typed and dragged, moves no plate pose, and steps back with Undo", async ({ page }) => {
  await openModel(page);
  const turn = await plateTurn(page);
  await page.keyboard.press("Shift+U");
  await expect(page.locator("#modelBar")).toHaveAttribute("data-tool", "workplane");
  await expect(page.locator("#modelCancel")).toHaveText("Done");
  await expect(apply(page)).toBeHidden();
  await expect(canvas(page)).toHaveAttribute("data-workplane", "global:0.00,0.00,0.00:0.00,0.00,0.00");
  await expect(canvas(page)).toHaveAttribute("data-datum-pick", "1");
  await expect(note(page)).toHaveText("U, V, W are X, Y, Z. Pick Bed or Face, or type a frame.");
  for (const [id, text] of [["modelWpX", "X"], ["modelWpRz", "Turn Z"]]) await expect(label(page, id!)).toHaveText(text!);
  await expect(page.locator("#modelWpPrint"), "the file's own way up already prints W up").toBeDisabled();

  await page.locator("#modelWpBed").click();
  await expect(canvas(page)).toHaveAttribute("data-workplane", "bed:10.00,10.00,0.00:0.00,0.00,0.00");
  await expect(page.locator("#modelWpX")).toHaveValue("10");

  // The U arrow slides the origin along U; the turn stays exactly as it was.
  await drag(page, "wp-u", 80, 0);
  const moved = Number(await page.locator("#modelWpX").inputValue());
  expect(moved).not.toBe(10);
  await expect(page.locator("#modelWpY")).toHaveValue("10");
  await page.locator("#modelWpRx").fill("90");
  await page.locator("#modelWpRx").dispatchEvent("input");
  await expect(canvas(page)).toHaveAttribute("data-workplane", new RegExp(`^bed:.*:90\\.00,0\\.00,0\\.00$`));
  expect(await plateTurn(page), "a tilted frame does not turn the part on the plate").toEqual(turn);

  // The typed turn settles into a step; Undo takes back the turn, then the drag, then Bed.
  await expect(page.locator("#modelUndo")).toBeEnabled();
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelWpRx")).toHaveValue("0");
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelWpX")).toHaveValue("10");
  await page.locator("#modelUndo").click();
  await expect(canvas(page)).toHaveAttribute("data-workplane", "global:0.00,0.00,0.00:0.00,0.00,0.00");
  await page.locator("#modelRedo").click();
  await expect(canvas(page)).toHaveAttribute("data-workplane", "bed:10.00,10.00,0.00:0.00,0.00,0.00");

  await page.locator("#modelWpGlobal").click();
  await page.locator("#modelCancel").click();
  await expect(canvas(page), "the untouched global frame is not drawn").not.toHaveAttribute("data-workplane", /./);
});

test("on a side face, Hole drills into it and Boolean grows out of it, and the plate stays until Print with W up", async ({ page }) => {
  const tree = await openModel(page);
  const turn = await plateTurn(page);
  await onSide(page);
  await expect(note(page)).toHaveText("On the picked face, W out of it. Hole, Boolean, and Split use this frame.");
  expect(await plateTurn(page), "a frame on a face does not turn the part").toEqual(turn);

  await page.locator("#modelToolHole").click();
  await expect(canvas(page), "the frame stays drawn under Hole").toHaveAttribute("data-workplane", SIDE);
  for (const [id, text] of [["modelX", "U"], ["modelY", "V"], ["modelZ", "W"]]) await expect(label(page, id!)).toHaveText(text!);
  await expect(page.locator("#modelX")).toHaveValue("0");
  await expect.poll(async () => Object.keys(await grips(page))).toEqual(expect.arrayContaining(["hole-move-u", "hole-move-v", "hole-origin"]));
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3900 mm³");
  const hole = tree.of("apply").at(-1)!.op as { origin: number[]; axis: number[] };
  expect(hole.origin.map((value) => Math.round(value * 1e9) / 1e9), "it starts on the face's middle").toEqual([20, 10, 5]);
  expect(hole.axis.map((value) => Math.round(value * 1e9) / 1e9), "and drills along −W, into the part").toEqual([-1, 0, 0]);

  // A box 4 × 6 × 10 at U, V, W 0 sits on the face and grows along U, V, W: 10 out along X, 4 along Y, 6 up Z.
  await page.locator("#modelToolBoolean").click();
  for (const [id, value] of [["modelDx", "4"], ["modelDy", "6"], ["modelDz", "10"], ["modelX", "0"], ["modelY", "0"], ["modelZ", "0"]]) await page.locator(`#${id}`).fill(value!);
  await page.locator("#modelDz").dispatchEvent("input");
  await expect.poll(async () => (await ghost(page)).size.map((value) => Math.round(value * 100) / 100)).toEqual([10, 4, 6]);
  expect((await ghost(page)).at.map((value) => Math.round(value * 100) / 100)).toEqual([25, 12, 8]);
  await page.locator("#modelCancel").click();

  // Print with W up is the one way the frame turns the part, and Undo takes it back.
  await page.locator("#modelToolWorkplane").click();
  await expect(page.locator("#modelWpPrint")).toBeEnabled();
  await page.locator("#modelWpPrint").click();
  await expect.poll(() => plateTurn(page)).not.toEqual(turn);
  await expect(page.locator("#modelWpPrint"), "W is up now").toBeDisabled();
  await page.locator("#modelUndo").click();
  await expect.poll(() => plateTurn(page)).toEqual(turn);
});

test("Edit step opens a hole cut on a face frame with its own model-space numbers, and sends them back exactly", async ({ page }) => {
  const tree = await openModel(page);
  await onSide(page);
  await page.locator("#modelToolHole").click();
  await page.locator("#modelHoleR").fill("1.5");
  await page.locator("#modelHoleR").dispatchEvent("input");
  await apply(page).click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3900 mm³");
  const applied = tree.of("apply").at(-1)!.op as Record<string, unknown>;

  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelEditHead")).toContainText("Editing step 1");
  for (const [id, text, value] of [["modelX", "X", "20"], ["modelY", "Y", "10"], ["modelZ", "Z", "5"]]) {
    await expect(label(page, id!)).toHaveText(text!);
    await expect(page.locator(`#${id}`)).toHaveValue(value!);
  }
  await expect(canvas(page), "the frame is not drawn while the step's own numbers show").not.toHaveAttribute("data-workplane", /./);
  await expect(apply(page), "the step as it is would change nothing").toBeDisabled();
  await page.locator("#modelHoleR").fill("2");
  await page.locator("#modelHoleR").dispatchEvent("input");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(page.locator("#modelPanel")).toBeHidden();
  const edited = tree.of("edit").at(-1)!.op as Record<string, unknown>;
  expect(edited).toEqual({ ...applied, radius: 2 });
  await expect(canvas(page), "the frame is back after the edit").toHaveAttribute("data-workplane", SIDE);
});

test("the frame moves with its part under Place", async ({ page }) => {
  await openModel(page);
  await onSide(page);
  await page.locator("#modelCancel").click();
  await page.locator("#modelToolPlace").click();
  await page.locator("#modelPlaceX").fill("30");
  await page.locator("#modelPlaceX").dispatchEvent("input");
  await expect(canvas(page)).toHaveAttribute("data-workplane", "face:50.00,10.00,5.00:90.00,0.00,90.00");
  await page.locator("#modelCancel").click();
  await page.locator("#modelToolWorkplane").click();
  await expect(page.locator("#modelWpX"), "the panel reads where the frame now is").toHaveValue("50");
});
