import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";
import { plateClick } from "./plate-rows";

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

/**
 * STEP files by name, each a box in its own coordinates. The first opens; the rest are added.
 * `reportSeat` false answers as an engine from before `seatMm` did. `seatOf` overrides the seat a file reports.
 */
async function openFiles(page: Page, files: Record<string, MockSolid>, reportSeat = true, seatOf?: (name: string, minZ: number) => Promise<number>): Promise<TreeMock> {
  const named = (name: unknown) => files[String(name)]!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  // As the slicer does, the mesh it reads from a STEP sits on Z = 0; with `reportSeat` it says how far it lowered the file.
  const seated = async (name: string, positions: number[]) => {
    const minZ = Math.min(...positions.filter((_, i) => i % 3 === 2));
    const seatMm = seatOf ? await seatOf(name, minZ) : minZ;
    return { positions: positions.map((value, i) => (i % 3 === 2 ? value - minZ : value)), ...(reportSeat ? { seatMm } : {}) };
  };
  await page.route("**/api/mesh", async (route) => {
    const name = String(route.request().postDataJSON().filename);
    await route.fulfill({ json: await seated(name, named(name).positions) });
  });
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
  await plateClick(page, "select");
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
  await page.locator("#modelPlane").fill("4");
  await page.locator("#modelApply").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await plateClick(page, "select", 1);
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

test("a STEP the slicer lowered onto the bed sits at its own Z in model space before Model has opened it", async ({ page }) => {
  await openFiles(page, { "low.step": boxSolid([40, 30, 20]), "high.step": boxSolid([40, 30, 20], [100, 0, 50]) });
  expect(Object.values(await contextBoxes(page))).toEqual([[100, 0, 50, 140, 30, 70]]);
  await plateClick(page, "select", 1);
  await expect(canvas(page)).toHaveAttribute("data-solid", "100.00,0.00,50.00,140.00,30.00,70.00");
});

test("with an engine that does not say how far it lowered a STEP, Model learns it the first time it opens the part", async ({ page }) => {
  await openFiles(page, { "low.step": boxSolid([40, 30, 20]), "high.step": boxSolid([40, 30, 20], [100, 0, 50]) }, false);
  expect(Object.values(await contextBoxes(page))).toEqual([[100, 0, 0, 140, 30, 20]]);
  await plateClick(page, "select", 1);
  await expect(canvas(page)).toHaveAttribute("data-solid", "100.00,0.00,50.00,140.00,30.00,70.00");
  await plateClick(page, "select");
  await expect(canvas(page)).toHaveAttribute("data-solid", "0.00,0.00,0.00,40.00,30.00,20.00");
  expect(Object.values(await contextBoxes(page))).toEqual([[100, 0, 50, 140, 30, 70]]);
});

test("a STEP re-read that another selection overtook leaves the seat as it was", async ({ page }) => {
  let reads = 0;
  let asked = () => {};
  const arrived = new Promise<void>((resolve) => (asked = resolve));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await openFiles(page, { "low.step": boxSolid([40, 30, 20]), "high.step": boxSolid([40, 30, 20], [100, 0, 50]) }, true, async (name, minZ) => {
    if (name !== "high.step" || (reads += 1) === 1) return minZ;
    asked();
    await gate;
    return minZ + 10;
  });
  await page.locator("#tabPrepare").click();
  await plateClick(page, "select", 1);
  await page.locator("#stepTol").fill("0.2");
  await arrived;
  await plateClick(page, "select");
  release();
  await page.waitForTimeout(300);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 24000");
  expect(Object.values(await contextBoxes(page))).toEqual([[100, 0, 50, 140, 30, 70]]);
});

test("pieces Separated from a raised STEP assembly sit at their own Z in model space", async ({ page }) => {
  const lower = boxSolid([20, 20, 10], [100, 0, 50]);
  const upper = boxSolid([20, 20, 10], [140, 0, 65]);
  const assembly = { ...lower, positions: [...lower.positions, ...upper.positions], triangles: [...lower.triangles, ...upper.triangles.map((face) => face + 6)] };
  await openFiles(page, { "base.step": boxSolid([40, 30, 20]), "asm.step": assembly });
  await page.locator("#tabPrepare").click();
  await plateClick(page, "select", 1);
  await page.locator("#separateShells").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await plateClick(page, "select");
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 24000");
  const boxes = Object.values(await contextBoxes(page)).sort((a, b) => a[0]! - b[0]!);
  expect(boxes).toEqual([[100, 0, 50, 120, 20, 60], [140, 0, 65, 160, 20, 75]]);
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
  await plateClick(page, "select", 1);
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

test("a split typed along model X on a moved part sends the engine the plane on the solid, and is labelled there", async ({ page }) => {
  const tree = await openFiles(page, { "box.step": boxSolid([20, 20, 10]) });
  await place(page, "modelPlaceX", 10);
  await page.locator("#modelToolSplit").click();
  await page.locator('#modelPlaneModes [data-plane="x"]').click();
  // The part sits from X 10 to 30 in model space, so its middle is X 20 there.
  await expect(page.locator("#modelPlane")).toHaveValue("20");
  await page.locator("#modelPlane").fill("15");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const op = tree.of("apply").at(-1)!.op as { origin: number[]; normal: number[] };
  expect(op.normal).toEqual([1, 0, 0]);
  expect(op.origin[0]).toBeCloseTo(5, 9);
  await expect(page.locator("#modelHistoryTree [role=treeitem]").last()).toContainText("Split at X 5");
});

/** E3. Bed and Reset view are in the rail's View menu. A click on the view closes it, so this opens it when shut. */
async function openView(page: Page) {
  if (await page.locator("#modelLookPanel").isHidden()) await page.locator("#modelLookOpen").click();
}

test("the bed toggle hides and shows the bed, and the choice stays", async ({ page }) => {
  await openFiles(page, { "box.step": boxSolid([20, 20, 10]) });
  const toggle = page.locator("#modelBedToggle");
  await expect(canvas(page)).toHaveAttribute("data-bed-visible", "1");
  await openView(page);
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
  await openView(page);
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
  await openView(page);
  await page.locator("#modelResetView").click();
  await openView(page);
  await page.locator("#modelResetView").click({ modifiers: ["Shift"] });
  expect(await restingCamera(page)).toBe(all);

  await zoomAndOrbit(page);
  const moved = await restingCamera(page);
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 2000");
  expect(await restingCamera(page), "an Apply leaves the camera where the user put it").toBe(moved);
});

for (const [width, height] of [[960, 640], [1280, 800], [1440, 900]] as const) {
  test(`Reset view, in the rail's View menu, opens clear of the readout, the dock and the view cube at ${width}×${height}`, async ({ page }) => {
    await openFiles(page, { "box.step": boxSolid([20, 20, 10]) });
    await page.setViewportSize({ width, height });
    await page.locator("#modelToolBoolean").click();
    await expect(canvas(page)).toHaveAttribute("data-handles", /.+/);
    // E3. Over the view stay only the pick filter, the view cube and the context bar: Reset view is in View.
    await page.locator("#modelLookOpen").click();
    await expect(page.locator("#modelResetView")).toBeVisible();
    const reset = (await page.locator("#modelResetView").boundingBox())!;
    const view = (await canvas(page).boundingBox())!;
    const meets = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const id of ["#modelReadout", "#modelPick", "#toolRail"]) {
      const box = await page.locator(id).boundingBox();
      if (box) expect(meets(reset, box), `clear of ${id}`).toBe(false);
    }
    const grips = ((await canvas(page).getAttribute("data-handles")) ?? "").split(" ").map((item) => Number(item.split(":")[1]!.split(",")[0]) + view.x);
    expect(reset.x + reset.width, "left of the dock").toBeLessThan(Math.min(...grips) - 8);
    expect(reset.x + reset.width, "left of the view cube").toBeLessThan(view.x + view.width - 128);
  });
}

test.describe("phone", () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const [width, height] of [[390, 844], [844, 390], [667, 375]] as const) {
    test(`every tool's sheet shows a row of fields above its buttons, under the readout and clear of Slice, at ${width}×${height}`, async ({ page }) => {
      const solid = boxSolid([40, 30, 20]);
      await page.setViewportSize({ width, height });
      await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
      await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions, seatMm: 0 } }));
      await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
      await mockModelTree(page, { open: () => solid });
      await page.goto("/?layout=compact");
      await autoSliceOff(page);
      await page.locator("#file").setInputFiles({ name: "a.step", mimeType: "model/step", buffer: STEP });
      await expect(page.locator("#objectList .obj").first()).toBeVisible();
      await page.locator("#compactTabs [data-tab=model]").click();
      await expect(page.locator("#modelReadout")).toContainText("Volume");
      for (const tool of ["New", "Boolean", "Split", "Hole", "Scale", "Measure", "Place"]) {
        await page.locator(`#modelTool${tool}`).click();
        const sheet = (await page.locator("#modelPanel").boundingBox())!;
        const bar = (await page.locator("#modelPanel .model-actions").boundingBox())!;
        const field = (await page.locator("#modelPanel .model-fields input:visible, #modelPanel .model-fields select:visible").first().boundingBox())!;
        expect(field.y >= sheet.y && field.y + field.height <= bar.y + 0.5, `${tool}: a row of fields above the buttons`).toBe(true);
        expect(bar.x - sheet.x <= 1.5 && sheet.x + sheet.width - (bar.x + bar.width) <= 1.5, `${tool}: the bar spans the sheet`).toBe(true);
        const readout = (await page.locator("#modelReadout").boundingBox())!;
        expect(readout.y + readout.height <= sheet.y + 0.5, `${tool}: under the readout`).toBe(true);
        const slice = await page.locator("#slice").boundingBox();
        for (const button of await page.locator("#modelPanel .model-actions .btn:visible").all()) {
          const box = (await button.boundingBox())!;
          if (slice) expect(box.x + box.width <= slice.x || box.y >= slice.y + slice.height || box.y + box.height <= slice.y, `${tool}: clear of Slice`).toBe(true);
        }
        await page.locator(`#modelTool${tool}`).click();
      }
    });

    test(`Place's Done stays inside the sheet and on screen, and closes it, at ${width}×${height}`, async ({ page }) => {
      const solid = boxSolid([40, 30, 20]);
      await page.setViewportSize({ width, height });
      await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
      await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions, seatMm: 0 } }));
      await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
      await mockModelTree(page, { open: () => solid });
      await page.goto("/?layout=compact");
      await autoSliceOff(page);
      await page.locator("#file").setInputFiles({ name: "a.step", mimeType: "model/step", buffer: STEP });
      await expect(page.locator("#objectList .obj").first()).toBeVisible();
      await page.locator("#compactTabs [data-tab=model]").click();
      await expect(page.locator("#modelReadout")).toContainText("Volume");
      await page.locator("#modelToolPlace").click();
      const done = page.locator("#modelCancel");
      await expect(done).toHaveText("Done");
      const button = (await done.boundingBox())!;
      const sheet = (await page.locator("#modelPanel").boundingBox())!;
      expect(button.y >= sheet.y && button.y + button.height <= sheet.y + sheet.height + 0.5, "inside the sheet").toBe(true);
      expect(button.x >= 0 && button.y >= 0 && button.x + button.width <= width && button.y + button.height <= height, "on screen").toBe(true);
      await done.click();
      await expect(page.locator("#modelPanel")).toBeHidden();
    });
  }
});

test("Frame in the Objects list frames that object in Model and stays in Model", async ({ page }) => {
  await openFiles(page, { "left.step": boxSolid([40, 30, 20]), "right.step": boxSolid([40, 30, 20], [200, 0, 0]) });
  const opening = await restingCamera(page);
  await zoomAndOrbit(page);
  expect(await restingCamera(page)).not.toBe(opening);
  await plateClick(page, "frame");
  expect(await restingCamera(page)).toBe(opening);
  await expect(page.locator("#modelBody")).toBeVisible();
  await expect(page.locator("#prepareBody")).toBeHidden();

  await plateClick(page, "frame", 1);
  await expect(canvas(page)).toHaveAttribute("data-solid", "200.00,0.00,0.00,240.00,30.00,20.00");
  const target = (await restingCamera(page)).split(";")[1]!.split(",").map(Number);
  expect(target).toEqual([220, 15, 10]);
  await expect(page.locator("#modelBody")).toBeVisible();
});
