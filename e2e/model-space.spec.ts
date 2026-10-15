import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A box the modeler reports as a solid, in its own CAD frame, from `at`. */
function boxSolid(size: V, at: V = [0, 0, 0]): MockSolid {
  const c = (x: number, y: number, z: number): V => [at[0] + x * size[0], at[1] + y * size[1], at[2] + z * size[2]];
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

/** A split keeps what is under the plane and gives the rest to the piece, both where they were cut. A hole or a cut leaves a 10 mm slab. */
function built(request: Body): Built {
  const op = request.op as { kind: string; origin?: number[] };
  if (op.kind === "split") {
    const z = op.origin![2]!;
    return { kept: boxSolid([20, 20, z]), other: boxSolid([20, 20, 10 - z], [0, 0, z]) };
  }
  return boxSolid([20, 20, 5]);
}

const STEP = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");

/** STEP files by name, each a box in its own coordinates. The first opens; the rest are added. */
async function openFiles(page: Page, files: Record<string, MockSolid>): Promise<TreeMock> {
  const named = (name: unknown) => files[String(name)]!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  // As the slicer does, the mesh it reads from a STEP sits on Z = 0.
  const seated = (positions: number[]) => {
    const minZ = Math.min(...positions.filter((_, i) => i % 3 === 2));
    return positions.map((value, i) => (i % 3 === 2 ? value - minZ : value));
  };
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: seated(named(route.request().postDataJSON().filename).positions) } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: (request) => named(request.filename), apply: built });
  await page.goto("/");
  await autoSliceOff(page);
  const names = Object.keys(files);
  await page.locator("#file").setInputFiles({ name: names[0]!, mimeType: "model/step", buffer: STEP });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  for (const [i, name] of names.slice(1).entries()) {
    await page.locator("#plateAddFile").setInputFiles({ name, mimeType: "model/step", buffer: STEP });
    await expect(page.locator("#objectList .obj")).toHaveCount(i + 2);
  }
  await page.locator("[data-plate-select]").first().click();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  return tree;
}

const canvas = (page: Page) => page.locator("#model");

/** A numeric `data-*` list off the Model canvas. */
async function numbers(page: Page, attribute: string): Promise<number[]> {
  const raw = (await canvas(page).getAttribute(attribute)) ?? "";
  return raw.split(",").map(Number);
}

/** Every grey object's model-space box, by id. */
async function contextBoxes(page: Page): Promise<Record<string, number[]>> {
  const raw = (await canvas(page).getAttribute("data-context")) ?? "";
  return Object.fromEntries(raw.split(" ").filter(Boolean).map((entry) => {
    const [id, list] = entry.split(":");
    return [id!, list!.split(",").map(Number)];
  }));
}

/** The camera once it has stopped gliding. */
async function restingCamera(page: Page): Promise<string> {
  let last = "";
  let still = 0;
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(150);
    const now = (await canvas(page).getAttribute("data-camera")) ?? "";
    still = now && now === last ? still + 1 : 0;
    // A damped orbit creeps for a while after the pointer stops; a tenth of a millimetre can hold for one sample.
    if (still >= 4) return now;
    last = now;
  }
  return last;
}

/** Zoom in and orbit over empty space, so the view is not the one Model opened with. */
async function zoomAndOrbit(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.25);
  await page.mouse.wheel(0, -500);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.2, { steps: 8 });
  await page.mouse.up();
}

async function place(page: Page, field: string, value: number) {
  if ((await page.locator("#modelToolPlace").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolPlace").click();
  await page.locator(`#${field}`).fill(String(value));
  await page.locator(`#${field}`).press("Tab");
}

test("a split piece opens with its parent grey directly under it, where it was cut", async ({ page }) => {
  await openFiles(page, { "box.step": boxSolid([20, 20, 10]) });
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelPlaneZ").fill("4");
  await page.locator("#modelApply").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await page.locator("[data-plate-select]").nth(1).click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 2400");

  await expect(canvas(page)).toHaveAttribute("data-solid", "0.00,0.00,4.00,20.00,20.00,10.00");
  expect(Object.values(await contextBoxes(page))).toEqual([[0, 0, 0, 20, 20, 4]]);
  // On screen the grey parent is under the piece, not on top of it at one centre.
  const [sx, sy, sw, sh] = await numbers(page, "data-solid-screen");
  const [gx, gy, gw, gh] = await numbers(page, "data-context-screen");
  expect(Math.abs(gx! + gw! / 2 - (sx! + sw! / 2))).toBeLessThan(sw! * 0.1);
  expect(gy! + gh! / 2).toBeGreaterThan(sy! + sh! / 2);
});

test("two STEP files 100 mm apart in their own coordinates show 100 mm apart", async ({ page }) => {
  await openFiles(page, { "left.step": boxSolid([40, 30, 20]), "right.step": boxSolid([40, 30, 20], [100, 0, 0]) });
  await expect(canvas(page)).toHaveAttribute("data-solid", "0.00,0.00,0.00,40.00,30.00,20.00");
  expect(Object.values(await contextBoxes(page))).toEqual([[100, 0, 0, 140, 30, 20]]);
});

test("a STEP the slicer lowered onto the bed goes back to its own Z once Model has opened it", async ({ page }) => {
  await openFiles(page, { "low.step": boxSolid([40, 30, 20]), "high.step": boxSolid([40, 30, 20], [100, 0, 50]) });
  // The slicer's read of the file does not say how far it lowered it, so until Model opens it, it sits on Z = 0.
  expect(Object.values(await contextBoxes(page))).toEqual([[100, 0, 0, 140, 30, 20]]);
  await page.locator("[data-plate-select]").nth(1).click();
  await expect(canvas(page)).toHaveAttribute("data-solid", "100.00,0.00,50.00,140.00,30.00,70.00");
  await page.locator("[data-plate-select]").nth(0).click();
  await expect(canvas(page)).toHaveAttribute("data-solid", "0.00,0.00,0.00,40.00,30.00,20.00");
  expect(Object.values(await contextBoxes(page))).toEqual([[100, 0, 50, 140, 30, 70]]);
});

test("Place moves the open object in model space and leaves the plate and its mesh alone", async ({ page }) => {
  const tree = await openFiles(page, { "left.step": boxSolid([40, 30, 20]), "right.step": boxSolid([40, 30, 20], [100, 0, 0]) });
  const plateX = await page.locator("#placeX").inputValue();
  const plateY = await page.locator("#placeY").inputValue();
  const mesh = await canvas(page).getAttribute("data-plate-mesh");
  const calls = tree.calls.length;
  const context = await canvas(page).getAttribute("data-context");

  await place(page, "modelPlaceX", 10);
  await expect(canvas(page)).toHaveAttribute("data-solid", "10.00,0.00,0.00,50.00,30.00,20.00");
  await expect(canvas(page)).toHaveAttribute("data-context", context!);
  expect(await canvas(page).getAttribute("data-plate-mesh")).toBe(mesh);
  expect(tree.calls.length, "a move asks the engine nothing").toBe(calls);
  expect([await page.locator("#placeX").inputValue(), await page.locator("#placeY").inputValue()]).toEqual([plateX, plateY]);

  // While Place is open, Undo and Redo step the move.
  await expect(page.locator("#modelUndo")).toBeEnabled();
  await page.locator("#modelUndo").click();
  await expect(canvas(page)).toHaveAttribute("data-solid", "0.00,0.00,0.00,40.00,30.00,20.00");
  await expect(page.locator("#modelPlaceX")).toHaveValue("0");
  await page.locator("#modelRedo").click();
  await expect(canvas(page)).toHaveAttribute("data-solid", "10.00,0.00,0.00,50.00,30.00,20.00");

  // The other object, opened, sees the moved one where it now is.
  await page.locator("[data-plate-select]").nth(1).click();
  await expect(canvas(page)).toHaveAttribute("data-solid", "100.00,0.00,0.00,140.00,30.00,20.00");
  expect(Object.values(await contextBoxes(page))).toEqual([[10, 0, 0, 50, 30, 20]]);
});

test("with a turned pose a Hole typed at a model-space point sends the engine that point on the solid", async ({ page }) => {
  const tree = await openFiles(page, { "box.step": boxSolid([20, 20, 10]) });
  await place(page, "modelPlaceRz", 90);
  await page.locator("#modelToolHole").click();
  for (const [field, value] of [["#modelX", 15], ["#modelY", 8], ["#modelZ", 10]] as const) await page.locator(field).fill(String(value));
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Hole");
  const op = tree.of("apply").at(-1)!.op as { origin: number[]; axis: number[] };
  // Turned a quarter about Z around the box's centre (10, 10, 5): model (15, 8) is the solid's (8, 5).
  const want = [8, 5, 10];
  op.origin.forEach((value, i) => expect(value).toBeCloseTo(want[i]!, 9));
  [0, 0, -1].forEach((value, i) => expect(op.axis[i]!).toBeCloseTo(value, 9));
});

test("the bed toggle hides and shows the bed, and the choice stays", async ({ page }) => {
  await openFiles(page, { "box.step": boxSolid([20, 20, 10]) });
  const toggle = page.locator("#modelBedToggle");
  await expect(canvas(page)).toHaveAttribute("data-bed-visible", "1");
  await toggle.click();
  await expect(canvas(page)).toHaveAttribute("data-bed-visible", "0");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(canvas(page)).toHaveAttribute("data-bed-visible", "1");
  await toggle.click();
  await page.reload();
  await expect(canvas(page)).toHaveAttribute("data-bed-visible", "0");
  await expect(page.locator("#modelBedToggle")).toHaveAttribute("aria-pressed", "false");
});

test("Reset view and Home go back to the view Model opened with, and an Apply keeps the user's view", async ({ page }) => {
  await openFiles(page, { "left.step": boxSolid([40, 30, 20]), "right.step": boxSolid([40, 30, 20], [200, 0, 0]) });
  const opening = await restingCamera(page);

  await zoomAndOrbit(page);
  expect(await restingCamera(page)).not.toBe(opening);
  await page.locator("#modelResetView").click();
  expect(await restingCamera(page)).toBe(opening);

  await zoomAndOrbit(page);
  expect(await restingCamera(page)).not.toBe(opening);
  await canvas(page).focus();
  await page.keyboard.press("Home");
  expect(await restingCamera(page)).toBe(opening);

  await page.keyboard.press("Shift+Home");
  const all = await restingCamera(page);
  expect(all.split(";")[1], "Shift+Home looks at the middle of both objects").toBe("120.0,15.0,10.0");
  await page.locator("#modelResetView").click();
  await page.locator("#modelResetView").click({ modifiers: ["Shift"] });
  expect(await restingCamera(page)).toBe(all);

  await zoomAndOrbit(page);
  const moved = await restingCamera(page);
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 2000");
  expect(await restingCamera(page), "an Apply leaves the camera where the user put it").toBe(moved);
});

test("Frame in the Objects list frames that object in Model and stays in Model", async ({ page }) => {
  await openFiles(page, { "left.step": boxSolid([40, 30, 20]), "right.step": boxSolid([40, 30, 20], [200, 0, 0]) });
  const opening = await restingCamera(page);
  await zoomAndOrbit(page);
  expect(await restingCamera(page)).not.toBe(opening);
  await page.locator("[data-plate-frame]").first().click();
  expect(await restingCamera(page)).toBe(opening);
  await expect(page.locator("#modelBody")).toBeVisible();
  await expect(page.locator("#prepareBody")).toBeHidden();

  await page.locator("[data-plate-frame]").nth(1).click();
  await expect(canvas(page)).toHaveAttribute("data-solid", "200.00,0.00,0.00,240.00,30.00,20.00");
  const target = (await restingCamera(page)).split(";")[1]!.split(",").map(Number);
  expect(target).toEqual([220, 15, 10]);
  await expect(page.locator("#modelBody")).toBeVisible();
});
