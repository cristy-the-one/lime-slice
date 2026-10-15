import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** Triangles as the modeler sends them: a soup and one face id per triangle. */
function solidOf(faces: V[][][], volumeMm3: number): MockSolid {
  const positions: number[] = [];
  const triangles: number[] = [];
  faces.forEach((tris, face) => {
    for (const tri of tris) {
      for (const point of tri) positions.push(...point);
      triangles.push(face);
    }
  });
  return { volumeMm3, positions, triangles, faces: faces.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

/** A box from `min`, faces −Z, +Z, −Y, +Y, −X, +X. With `apex`, the top is a low roof that peaks there: a face that is not flat. */
function boxSolid(size: V, min: V = [0, 0, 0], apex?: V): MockSolid {
  const c = (x: number, y: number, z: number): V => [min[0] + x * size[0], min[1] + y * size[1], min[2] + z * size[2]];
  const quad = (q: V[]): V[][] => [[q[0]!, q[1]!, q[2]!], [q[0]!, q[2]!, q[3]!]];
  const top = [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  return solidOf(
    [
      quad([c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)]),
      apex ? top.map((p, i) => [p, top[(i + 1) % 4]!, apex]) : quad(top),
      quad([c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)]),
      quad([c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)]),
      quad([c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)]),
      quad([c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)]),
    ],
    size[0] * size[1] * size[2],
  );
}

const ROOT = boxSolid([20, 20, 10]);

/** A split along an axis keeps the box below the plane; a slanted one keeps a box of the same volume as the root's half. */
function built(request: Body): Built {
  const op = request.op as { kind: string; origin: V; normal: V };
  const axis = op.normal.findIndex((value) => Math.abs(value) > 0.999999);
  if (axis < 0) return { kept: boxSolid([20, 20, 5]), other: boxSolid([20, 20, 5], [0, 0, 5]) };
  const size: V = [20, 20, 10];
  const at = op.origin[axis]!;
  const kept: V = [...size];
  kept[axis] = at;
  const other: V = [...size];
  other[axis] = size[axis]! - at;
  const from: V = [0, 0, 0];
  from[axis] = at;
  return { kept: boxSolid(kept), other: boxSolid(other, from) };
}

async function openModel(page: Page, root = ROOT): Promise<TreeMock> {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: () => root, apply: built });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(`Volume ${root.volumeMm3} mm³`);
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
const note = (page: Page) => page.locator("#modelNote");
const labels = (page: Page) => page.locator("#modelHistoryTree .mh-label");

async function grips(page: Page): Promise<Record<string, { x: number; y: number }>> {
  const text = (await page.locator("#model").getAttribute("data-handles")) ?? "";
  const box = (await page.locator("#model").boundingBox())!;
  const map: Record<string, { x: number; y: number }> = {};
  for (const item of text.split(" ").filter(Boolean)) {
    const [id, at] = item.split(":");
    const [x, y] = at!.split(",").map(Number);
    map[id!] = { x: box.x + x!, y: box.y + y! };
  }
  return map;
}

async function grip(page: Page, id: string) {
  await expect.poll(async () => Object.keys(await grips(page))).toContain(id);
  return (await grips(page))[id]!;
}

async function setField(page: Page, id: string, text: string) {
  await page.locator(`#${id}`).fill(text);
  await page.locator(`#${id}`).dispatchEvent("input");
}

/** Where the middle of the solid's top face is on screen: the Hole tool's origin dot starts there. */
async function topMiddle(page: Page) {
  await page.locator("#modelToolHole").click();
  const at = await grip(page, "hole-origin");
  await page.locator("#modelCancel").click();
  return at;
}

async function applySplit(page: Page, tree: TreeMock) {
  const before = tree.of("apply").length;
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Split.");
  expect(tree.of("apply")).toHaveLength(before + 1);
  return tree.of("apply").at(-1)!.op as { kind: string; origin: V; normal: V };
}

const near = (got: readonly number[], want: readonly number[]) => got.every((value, i) => Math.abs(value - want[i]!) < 1e-6);

test("X cuts square to the view's X: the request's normal is X, the plane starts mid-part, and History says so", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelSplitX").click();
  await expect(page.locator("#modelSplitX")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelPlaneLabel")).toHaveText("Plane X");
  await expect(page.locator("#modelPlane")).toHaveValue("10");
  await expect(note(page)).toHaveText("From 0.4 to 19.6 mm. The middle is 10.");
  await setField(page, "modelPlane", "6");
  const op = await applySplit(page, tree);
  expect(op.normal).toEqual([1, 0, 0]);
  expect(op.origin).toEqual([6, 10, 5]);
  await expect(labels(page)).toHaveText(["plate.step", "Split at X 6"]);

  await page.locator("#modelToolSplit").click();
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelSplitY").click();
  await expect(page.locator("#modelPlaneLabel")).toHaveText("Plane Y");
  const y = await applySplit(page, tree);
  expect(y.normal).toEqual([0, 1, 0]);
  await expect(labels(page).last()).toHaveText(/^Split at Y /);
});

test("Face cuts parallel to a picked flat face, an offset into the part, and the op keeps only the plane", async ({ page }) => {
  const tree = await openModel(page);
  const top = await topMiddle(page);
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelSplitFace").click();
  await expect(page.locator("#modelPlaneLabel")).toHaveText("Offset into the part");
  await expect(note(page)).toHaveText("Pick a flat face to cut from.");
  await expect(page.locator("#modelApply")).toBeDisabled();
  await page.mouse.click(top.x, top.y);
  await expect(readout(page)).toContainText("Face 2");
  await expect(note(page)).toHaveText("From 0.25 to 9.75 mm into the part. The middle is 5.");
  await setField(page, "modelPlane", "2");
  const op = await applySplit(page, tree);
  expect(Object.keys(op).sort()).toEqual(["kind", "normal", "origin"]);
  expect(op.normal, "the face's outward normal").toEqual([0, 0, 1]);
  expect(near(op.origin, [10, 10, 8]), `2 mm in from the face's middle, got ${op.origin}`).toBe(true);
});

test("a curved face is refused with a plain hint", async ({ page }) => {
  await openModel(page, boxSolid([20, 20, 10], [0, 0, 0], [10, 10, 12]));
  const top = await topMiddle(page);
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelSplitFace").click();
  await page.mouse.click(top.x, top.y + 6);
  await expect(readout(page)).toContainText("Face 2");
  await expect(note(page)).toHaveText("Pick a flat face. This one is curved.");
  await expect(note(page)).toHaveClass(/is-bad/);
  await expect(page.locator("#modelApply")).toBeDisabled();
});

test("the tilt fields turn the request's normal about the pivot, and History names the tilt", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolSplit").click();
  await setField(page, "modelTiltA", "15");
  await expect(page.locator("#modelPlane"), "a tilt keeps the plane where it was").toHaveValue("5");
  const op = await applySplit(page, tree);
  expect(near(op.normal, [0, -Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)]), `tilted 15° about X, got ${op.normal}`).toBe(true);
  expect(op.origin).toEqual([10, 10, 5]);
  // The plane crosses the world Z axis (x = y = 0) at 5 − 10·tan 15° = 2.32.
  await expect(labels(page).last()).toHaveText("Split at Z 2.32, tilt 15° / 0°");
});

test("a typed tilt past ±85° stops there, in the field and in the request", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelTiltA").fill("120");
  await page.locator("#modelTiltA").press("Tab");
  await expect(page.locator("#modelTiltA")).toHaveValue("85");
  await expect(note(page)).toHaveText(/^From .* The middle is 5\.$/);
  const op = await applySplit(page, tree);
  const a = (85 * Math.PI) / 180;
  expect(near(op.normal, [0, -Math.sin(a), Math.cos(a)]), `tilted 85° about X, got ${op.normal}`).toBe(true);
});

test("Split opens untilted, and in Face mode it picks faces again after Edge picking", async ({ page }) => {
  await openModel(page);
  const top = await topMiddle(page);
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelSplitFace").click();
  await setField(page, "modelTiltA", "20");
  await page.locator("#modelCancel").click();
  await page.locator("#modelPickEdge").click();
  await page.locator("#modelToolSplit").click();
  await expect(page.locator("#modelSplitFace")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelPickFace"), "Face mode picks faces").toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTiltA"), "a tilt does not carry over").toHaveValue("0");
  await page.locator("#modelPickEdge").click();
  await expect(note(page)).toHaveText("Switch to Face picking, then pick a flat face to cut from.");
  await page.locator("#modelPickFace").click();
  await page.mouse.click(top.x, top.y);
  await expect(note(page)).toHaveText("From 0.25 to 9.75 mm into the part. The middle is 5.");
});

test("a drag on a docked tilt ring changes the tilt, turns the plane ghost, and is one Apply", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolSplit").click();
  const ghost = async () => ((await page.locator("#model").getAttribute("data-ghost")) ?? "").split(" ").map(Number);
  const flat = await ghost();
  const ring = await grip(page, "tilt-b");
  const [cx, cy] = ((await page.locator("#model").getAttribute("data-gizmo-at")) ?? "").split(",").map(Number);
  const canvas = (await page.locator("#model").boundingBox())!;
  const off = { x: ring.x - canvas.x - cx!, y: ring.y - canvas.y - cy! };
  const length = Math.hypot(off.x, off.y);
  // The default camera looks along +Y from below it, X to the right and Z up, so a right-handed turn
  // about +Y runs clockwise on screen: at the grip, along (−y, x) in screen pixels.
  const along = { x: (-off.y / length) * 6, y: (off.x / length) * 6 };
  await page.mouse.move(ring.x, ring.y);
  await expect(page.locator(".model-drag-tip")).toContainText("Tilt B");
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(ring.x + along.x * i, ring.y + along.y * i);
  await page.mouse.up();
  const tilt = Number(await page.locator("#modelTiltB").inputValue());
  expect(tilt, "dragged clockwise, the B ring turns right-handed about +Y: B grows").toBeGreaterThan(0);
  await expect.poll(async () => (await ghost())[5], "the ghost turns out of the flat").toBeGreaterThan(flat[5]! + 1);
  expect(tree.of("apply")).toHaveLength(0);
  const op = await applySplit(page, tree);
  const b = (tilt * Math.PI) / 180;
  expect(near(op.normal, [Math.sin(b), 0, Math.cos(b)]), `the request has the dragged tilt, got ${op.normal} for ${tilt}°`).toBe(true);
});

test("a saved project labels its splits the same after a reopen: an old Z split and an X split", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolSplit").click();
  await setField(page, "modelPlane", "4");
  await applySplit(page, tree);
  await page.locator("#modelSplitX").click();
  await setField(page, "modelPlane", "10");
  await applySplit(page, tree);
  await page.locator("#modelCancel").click();
  await expect(labels(page)).toHaveText(["plate.step", "Split at Z 4", "Split at X 10"]);

  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  const saved = await readFile((await download.path())!);
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "plate.lime", mimeType: "application/json", buffer: saved });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#objectList .obj").first().click();
  await page.locator("#tabModel").click();
  await expect(labels(page)).toHaveText(["plate.step", "Split at Z 4", "Split at X 10"]);
});
