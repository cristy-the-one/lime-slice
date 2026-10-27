import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";
import { plateClick } from "./plate-rows";

const shots = path.resolve("test-results/model-placement");
fs.mkdirSync(shots, { recursive: true });

type V = [number, number, number];

/** A box the modeler reports as a solid, in its own CAD frame, from `at`. */
function boxSolid(size: V, at: V = [0, 0, 0]) {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [at[0] + x * sx, at[1] + y * sy, at[2] + z * sz];
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
    const pa = corners[a!]!;
    const pb = corners[b!]!;
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges };
}

/** `solid` with one more B-rep edge: a closed ring of radius 3 about (10, 10, 10), the rim of a hole in its top face. */
function withHoleRim(solid: ReturnType<typeof boxSolid>) {
  const points: number[] = [];
  for (let i = 0; i <= 48; i += 1) points.push(10 + 3 * Math.cos((i / 48) * 2 * Math.PI), 10 + 3 * Math.sin((i / 48) * 2 * Math.PI), 10);
  return { ...solid, edges: [...solid.edges, { id: solid.edges.length, lengthMm: 2 * Math.PI * 3, points }] };
}

const SOLIDS: Record<string, ReturnType<typeof boxSolid>> = {
  // The two files sit 60 mm apart in X in their own coordinates, as parts exported from one assembly do.
  "big.step": boxSolid([40, 30, 20], [60, 0, 0]),
  "small.step": withHoleRim(boxSolid([20, 20, 10])),
};

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

/** Two objects on the plate, `small` open in Model beside the grey `big`. Returns the grey object's id. */
async function openSmall(page: Page): Promise<string> {
  const named = (route: { request(): { postDataJSON(): { filename?: string } } }) => SOLIDS[route.request().postDataJSON().filename ?? ""]!;
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: named(route).positions } }));
  await mockModelTree(page, { open: (request) => SOLIDS[String(request.filename)]! });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  const step = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  await page.locator("#file").setInputFiles({ name: "big.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabPrepare").click();
  await commit(page, "#placeX", 100);
  await commit(page, "#placeY", 100);
  await page.locator("#plateAddFile").setInputFiles({ name: "small.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await commit(page, "#placeX", 160);
  await commit(page, "#placeY", 100);
  await page.locator("#tabPrepare").click();
  await page.locator("[data-plate-select]").nth(1).click();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000");
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-context-count", "1");
  const raw = (await canvas.getAttribute("data-context")) ?? "";
  return raw.split(":")[0]!;
}

async function settled(page: Page) {
  let last = "";
  await expect.poll(async () => {
    const now = `${await page.locator("#model").getAttribute("data-solid-screen")}|${await page.locator("#model").getAttribute("data-context-screen")}`;
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
}

/** The top view, pulled back until both boxes are on screen, with the camera at rest. */
async function topView(page: Page) {
  // Ctrl-drag grabs only while Place is open; idle, a Ctrl press is the face push's (it rounds the distance).
  if ((await page.locator("#modelToolPlace").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolPlace").click();
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("t");
  await settled(page);
  for (let i = 0; i < 9; i += 1) await page.mouse.wheel(0, 400);
  await settled(page);
}

/** Pixels one millimetre of the open 20 mm box draws at, in the top view. */
async function pxPerMm(page: Page): Promise<number> {
  return (await rect(page, "data-solid-screen")).w / 20;
}

async function rect(page: Page, attr: "data-solid-screen" | "data-context-screen") {
  const box = (await page.locator("#model").boundingBox())!;
  const [x, y, w, h] = ((await page.locator("#model").getAttribute(attr)) ?? "").split(",").map(Number);
  return { x: box.x + x!, y: box.y + y!, w: w!, h: h!, cx: box.x + x! + w! / 2, cy: box.y + y! + h! / 2 };
}

const field = async (page: Page, id: string) => Number(await page.locator(id).inputValue());
const placeXYZ = async (page: Page) => [await field(page, "#modelPlaceX"), await field(page, "#modelPlaceY"), await field(page, "#modelPlaceZ")];

async function dragWith(page: Page, from: { x: number; y: number }, by: { dx: number; dy: number }, button: "left" | "right" = "left", steps = 8) {
  await page.keyboard.down("Control");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(from.x + by.dx, from.y + by.dy, { steps });
  await page.mouse.up({ button });
  await page.keyboard.up("Control");
}

test("Ctrl-click on a grey object opens that object in Model; a plain click does not", async ({ page }) => {
  await openSmall(page);
  await topView(page);
  const grey = await rect(page, "data-context-screen");
  await page.keyboard.press("Escape");
  await page.mouse.click(grey.cx, grey.cy);
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000");

  await page.keyboard.down("Control");
  await page.mouse.click(grey.cx, grey.cy);
  await page.keyboard.up("Control");
  await expect(page.locator("#modelReadout")).toContainText("Volume 24000");
  const ids = Object.keys(Object.fromEntries(((await page.locator("#model").getAttribute("data-context")) ?? "").split(" ").map((entry) => entry.split(":"))));
  expect(ids).toHaveLength(1);
});

test("Ctrl-drag, with Place open, moves the object in model space, and one Undo takes the whole move back", async ({ page }) => {
  await openSmall(page);
  await topView(page);
  const solid = await rect(page, "data-solid-screen");
  expect(await placeXYZ(page)).toEqual([0, 0, 0]);
  const k = await pxPerMm(page);
  await dragWith(page, { x: solid.cx, y: solid.cy }, { dx: 12 * k, dy: -6 * k });
  await expect(page.locator("#modelToolPlace")).toHaveAttribute("aria-pressed", "true");
  const [x, y, z] = await placeXYZ(page);
  expect(x).toBeGreaterThan(5);
  expect(y).toBeGreaterThan(1);
  expect(z).toBe(0);
  await expect(page.locator("#modelUndo")).toBeEnabled();
  await page.locator("#modelUndo").click();
  expect(await placeXYZ(page)).toEqual([0, 0, 0]);
  await expect(page.locator("#modelUndo")).toBeDisabled();
});

test("a slow Ctrl-drag, with the pointer resting mid-way, is still one step", async ({ page }) => {
  await openSmall(page);
  await topView(page);
  const solid = await rect(page, "data-solid-screen");
  await page.keyboard.down("Control");
  await page.mouse.move(solid.cx, solid.cy);
  await page.mouse.down();
  const k = await pxPerMm(page);
  await page.mouse.move(solid.cx + 6 * k, solid.cy, { steps: 4 });
  await page.waitForTimeout(500);
  await page.mouse.move(solid.cx + 12 * k, solid.cy - 3 * k, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  expect((await placeXYZ(page))[0]).toBeGreaterThan(5);
  await page.locator("#modelUndo").click();
  expect(await placeXYZ(page)).toEqual([0, 0, 0]);
  await expect(page.locator("#modelUndo")).toBeDisabled();
});

test("Esc during a Ctrl-drag puts the object back and leaves no step", async ({ page }) => {
  await openSmall(page);
  await topView(page);
  const solid = await rect(page, "data-solid-screen");
  await page.keyboard.down("Control");
  await page.mouse.move(solid.cx, solid.cy);
  await page.mouse.down();
  const k = await pxPerMm(page);
  await page.mouse.move(solid.cx + 12 * k, solid.cy, { steps: 6 });
  expect((await placeXYZ(page))[0]).toBeGreaterThan(5);
  await page.keyboard.press("Escape");
  expect(await placeXYZ(page)).toEqual([0, 0, 0]);
  await page.mouse.move(solid.cx + 16 * k, solid.cy, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  expect(await placeXYZ(page)).toEqual([0, 0, 0]);
  await expect(page.locator("#modelUndo")).toBeDisabled();
});

test("a Ctrl-right-drag turns the object about Z, X picks another axis, and one Undo takes each turn back", async ({ page }) => {
  await openSmall(page);
  await topView(page);
  const height = async () => {
    const [, , z0, , , z1] = ((await page.locator("#model").getAttribute("data-solid")) ?? "").split(",").map(Number);
    return z1! - z0!;
  };
  const solid = await rect(page, "data-solid-screen");
  await page.keyboard.down("Control");
  await page.mouse.move(solid.cx, solid.cy);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(solid.cx + 180, solid.cy, { steps: 12 });
  await page.mouse.up({ button: "right" });
  await page.keyboard.up("Control");
  expect(await field(page, "#modelPlaceRz")).toBeCloseTo(90, 0);

  const turned = await rect(page, "data-solid-screen");
  await page.keyboard.down("Control");
  await page.mouse.move(turned.cx, turned.cy);
  await page.mouse.down({ button: "right" });
  await page.keyboard.press("x");
  await page.mouse.move(turned.cx + 90, turned.cy, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await page.keyboard.up("Control");
  // Turned about X by 45 degrees, the 10 mm tall box now stands about 21 mm tall.
  expect(await height()).toBeGreaterThan(20);

  await page.locator("#modelUndo").click();
  expect(await height()).toBeCloseTo(10, 1);
  expect(await field(page, "#modelPlaceRz")).toBeCloseTo(90, 0);
  await page.locator("#modelUndo").click();
  expect(await field(page, "#modelPlaceRz")).toBeCloseTo(0, 1);
});

test("a plain drag still orbits, and moves nothing", async ({ page }) => {
  await openSmall(page);
  const box = (await page.locator("#model").boundingBox())!;
  const cam = () => page.locator("#model").getAttribute("data-camera");
  const before = await cam();
  await page.mouse.move(box.x + 70, box.y + box.height - 70);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + box.height - 100, { steps: 8 });
  await page.mouse.up();
  await expect.poll(cam).not.toBe(before);
  expect(await placeXYZ(page)).toEqual([0, 0, 0]);
  await expect(page.locator("#modelUndo")).toBeDisabled();
  await expect(page.locator("#modelToolPlace")).toHaveAttribute("aria-pressed", "false");
});

test("dragging an object near another snaps it flush, shows what it met, and tints that object", async ({ page }) => {
  const grey = await openSmall(page);
  await topView(page);
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-snap-target", "");
  const solid = await rect(page, "data-solid-screen");
  await page.keyboard.down("Control");
  await page.mouse.move(solid.cx, solid.cy);
  await page.mouse.down();
  let x = solid.cx;
  let snapped = false;
  for (let i = 0; i < 160 && !snapped; i += 1) {
    x += 2;
    await page.mouse.move(x, solid.cy);
    snapped = ((await canvas.getAttribute("data-snap")) ?? "").includes("Touching");
  }
  expect(snapped, "the drag reached a snap").toBe(true);
  expect(await canvas.getAttribute("data-snap")).toMatch(/Touching .* · X/);
  await expect(canvas).toHaveAttribute("data-snap-target", grey);
  // Touching along X: the open object's far side meets the other's near side, 60 - 20 mm along.
  expect(Math.abs((await field(page, "#modelPlaceX")) - 40)).toBeLessThan(0.06);
  await page.screenshot({ path: path.join(shots, "model-snap-during-drag.png") });
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(canvas).toHaveAttribute("data-snap-target", "");
  expect(await field(page, "#modelPlaceX")).toBeCloseTo(40, 1);
});

test("holding Alt turns the snap off for that drag", async ({ page }) => {
  await openSmall(page);
  await topView(page);
  const canvas = page.locator("#model");
  const solid = await rect(page, "data-solid-screen");
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.mouse.move(solid.cx, solid.cy);
  await page.mouse.down();
  let x = solid.cx;
  let sawSnap = false;
  let passed = false;
  for (let i = 0; i < 160 && !passed; i += 1) {
    x += 2;
    await page.mouse.move(x, solid.cy);
    sawSnap ||= ((await canvas.getAttribute("data-snap")) ?? "") !== "";
    passed = (await field(page, "#modelPlaceX")) > 44;
  }
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  // Ctrl and Alt together are not a grab: the object stayed, and the drag was the camera's.
  expect(passed).toBe(false);
  expect(sawSnap).toBe(false);
});

test("the Place arrows snap too, and Alt holds it off", async ({ page }) => {
  await openSmall(page);
  await page.locator("#modelToolPlace").click();
  await topView(page);
  const canvas = page.locator("#model");
  const grip = async (id: string) => {
    const read = async () => {
      const text = (await canvas.getAttribute("data-handles")) ?? "";
      const found = text.split(" ").find((item) => item.startsWith(`${id}:`));
      return found ? found.split(":")[1]!.split(",").map(Number) : null;
    };
    await expect.poll(read).not.toBeNull();
    const [gx, gy] = (await read())!;
    const box = (await canvas.boundingBox())!;
    return { x: box.x + gx!, y: box.y + gy! };
  };
  const from = await grip("place-x");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  let x = from.x;
  let snapped = false;
  for (let i = 0; i < 200 && !snapped; i += 1) {
    x += 2;
    await page.mouse.move(x, from.y);
    snapped = ((await canvas.getAttribute("data-snap")) ?? "").includes("Touching");
  }
  expect(snapped, "the arrow reached a snap").toBe(true);
  expect(Math.abs((await field(page, "#modelPlaceX")) - 40)).toBeLessThan(0.06);
  await page.mouse.up();
  await expect(canvas).toHaveAttribute("data-snap-target", "");
});

test("Align to... in the Place card lines the object up with another, tints it, and one Undo puts it back", async ({ page }) => {
  const grey = await openSmall(page);
  await page.locator("#modelToolPlace").click();
  const row = page.locator("#modelAlign");
  await expect(row).toBeVisible();
  await expect(row.locator("#modelAlignTo option")).toHaveCount(1);
  const canvas = page.locator("#model");
  await row.locator("#modelAlignTo").focus();
  await expect(canvas).toHaveAttribute("data-snap-target", grey);
  await row.locator("#modelAlignHow").selectOption("flush-right");
  await page.screenshot({ path: path.join(shots, "model-align-to.png") });
  await row.locator("#modelAlignGo").click();
  // The open box ends at X 20 and the other at 100: flush right moves it 80 mm.
  await expect.poll(() => field(page, "#modelPlaceX")).toBeCloseTo(80, 2);
  await expect(canvas).toHaveAttribute("data-snap-target", "");
  await page.locator("#modelUndo").click();
  expect(await field(page, "#modelPlaceX")).toBeCloseTo(0, 2);
});

test("Align to... on top stacks the object on the other", async ({ page }) => {
  await openSmall(page);
  await page.locator("#modelToolPlace").click();
  const row = page.locator("#modelAlign");
  await row.locator("#modelAlignHow").selectOption("on-top");
  await row.locator("#modelAlignGo").click();
  // The open box's floor is 0 and the other's top is 20.
  await expect.poll(() => field(page, "#modelPlaceZ")).toBeCloseTo(20, 2);
});

test("the first Ctrl over the open object says what a drag does, and only the first time", async ({ page }) => {
  await openSmall(page);
  await topView(page);
  const solid = await rect(page, "data-solid-screen");
  const hint = page.locator("#grabHint");
  await page.mouse.move(solid.cx, solid.cy);
  await expect(hint).toBeHidden();
  await page.keyboard.down("Control");
  await page.mouse.move(solid.cx + 3, solid.cy + 2);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Drag to move");
  await page.keyboard.up("Control");
  await expect(hint).toBeHidden();
  await page.keyboard.down("Control");
  await page.mouse.move(solid.cx, solid.cy);
  await page.waitForTimeout(150);
  await expect(hint).toBeHidden();
  await page.keyboard.up("Control");
});

test("a Ctrl-drag with another tool open is left to that tool", async ({ page }) => {
  await openSmall(page);
  await topView(page);
  await page.locator("#modelToolMeasure").click();
  const solid = await rect(page, "data-solid-screen");
  await dragWith(page, { x: solid.cx, y: solid.cy }, { dx: 12 * (await pxPerMm(page)), dy: 0 });
  await page.locator("#modelToolPlace").click();
  expect(await placeXYZ(page)).toEqual([0, 0, 0]);
});

test("Measure reaches a second object: B snaps to the other object's corner, and the readout names both ends", async ({ page }) => {
  await openSmall(page);
  await topView(page);
  await page.locator("#modelToolMeasure").click();
  await expect(page.locator("#modelNote")).toContainText("Distance");
  const canvas = page.locator("#model");
  const grip = async (id: string) => {
    const read = async () => {
      const text = (await canvas.getAttribute("data-handles")) ?? "";
      const found = text.split(" ").find((item) => item.startsWith(`${id}:`));
      return found ? found.split(":")[1]!.split(",").map(Number) : null;
    };
    await expect.poll(read).not.toBeNull();
    const [gx, gy] = (await read())!;
    const box = (await canvas.boundingBox())!;
    return { x: box.x + gx!, y: box.y + gy! };
  };
  const grey = await rect(page, "data-context-screen");
  const from = await grip("measure-b");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Walk to the grey box's near corner, and a few pixels in along its edges until the pointer is on the box.
  await page.mouse.move(grey.x + 8, grey.y + 8, { steps: 24 });
  let snap = "";
  for (const [dx, dy] of [[8, 8], [6, 14], [14, 6], [10, 20], [20, 10], [4, 30]] as const) {
    await page.mouse.move(grey.x + dx, grey.y + dy, { steps: 3 });
    snap = (await canvas.getAttribute("data-measure-snap")) ?? "";
    if (snap.startsWith("vertex:")) break;
  }
  expect(snap).toMatch(/^vertex:/);
  const [px, py, pz] = snap.split(":")[1]!.split(",").map(Number);
  // The grey box spans X 60..100, Y 0..30, Z 0..20.
  expect([60, 100]).toContain(Math.round(px!));
  expect([0, 30]).toContain(Math.round(py!));
  expect([0, 20]).toContain(Math.round(pz!));
  await expect(page.locator(".model-snap-mark span").first()).toContainText("Vertex");
  await page.screenshot({ path: path.join(shots, "model-measure-to-other.png") });
  await page.mouse.up();

  const b = [await field(page, "#modelBx"), await field(page, "#modelBy"), await field(page, "#modelBz")];
  expect(b).toEqual([Math.round(px!), Math.round(py!), Math.round(pz!)]);
  const a = [await field(page, "#modelAx"), await field(page, "#modelAy"), await field(page, "#modelAz")];
  const exact = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  const note = (await page.locator("#modelNote").textContent()) ?? "";
  expect(note).toContain(`Distance ${Number(exact.toFixed(2))} mm`);
  expect(note).toMatch(/B: Vertex · big\.step/);
});

test("a plain Measure point on the other object lands on its surface, and Alt keeps it off the features", async ({ page }) => {
  await openSmall(page);
  await topView(page);
  await page.locator("#modelToolMeasure").click();
  const canvas = page.locator("#model");
  const read = async () => ((await canvas.getAttribute("data-handles")) ?? "").split(" ").find((item) => item.startsWith("measure-b:"))?.split(":")[1]?.split(",").map(Number) ?? null;
  await expect.poll(read).not.toBeNull();
  const [gx, gy] = (await read())!;
  const box = (await canvas.boundingBox())!;
  const grey = await rect(page, "data-context-screen");
  await page.keyboard.down("Alt");
  await page.mouse.move(box.x + gx!, box.y + gy!);
  await page.mouse.down();
  await page.mouse.move(grey.cx, grey.cy, { steps: 24 });
  expect(await canvas.getAttribute("data-measure-snap")).toBeNull();
  await page.mouse.up();
  await page.keyboard.up("Alt");
  expect(await field(page, "#modelBz")).toBeCloseTo(20, 0);
  expect(await field(page, "#modelBx")).toBeGreaterThan(60);
  await expect(page.locator("#modelNote")).toContainText("B: Surface · big.step");
});

test("Measure snaps to the middle of a circular edge when the pointer is on its rim", async ({ page }) => {
  await openSmall(page);
  await topView(page);
  await page.locator("#modelToolMeasure").click();
  const canvas = page.locator("#model");
  const read = async () => ((await canvas.getAttribute("data-handles")) ?? "").split(" ").find((item) => item.startsWith("measure-b:"))?.split(":")[1]?.split(",").map(Number) ?? null;
  await expect.poll(read).not.toBeNull();
  const [gx, gy] = (await read())!;
  const box = (await canvas.boundingBox())!;
  const solid = await rect(page, "data-solid-screen");
  const k = solid.w / 20;
  await page.mouse.move(box.x + gx!, box.y + gy!);
  await page.mouse.down();
  // The rim is 3 mm out from the middle of the top face; walk to it from the side, clear of every corner.
  await page.mouse.move(solid.cx + 8 * k, solid.cy, { steps: 12 });
  let snap = "";
  for (const offset of [3, 2.7, 3.3, 2.4, 3.6]) {
    await page.mouse.move(solid.cx + offset * k, solid.cy, { steps: 3 });
    snap = (await canvas.getAttribute("data-measure-snap")) ?? "";
    if (snap.startsWith("circle:")) break;
  }
  expect(snap).toMatch(/^circle:/);
  const [px, py, pz] = snap.split(":")[1]!.split(",").map(Number);
  expect(px).toBeCloseTo(10, 2);
  expect(py).toBeCloseTo(10, 2);
  expect(pz).toBeCloseTo(10, 2);
  await expect(page.locator(".model-snap-mark span").first()).toHaveText("Circle centre");
  await page.screenshot({ path: path.join(shots, "model-measure-circle-centre.png") });
  await page.mouse.up();
  expect(await field(page, "#modelBx")).toBeCloseTo(10, 2);
  expect(await field(page, "#modelBy")).toBeCloseTo(10, 2);
  await expect(page.locator("#modelNote")).toContainText("B: Circle centre");
});

test("with the object removed from the plate, Align to... has nothing to align to", async ({ page }) => {
  await openSmall(page);
  await page.locator("#modelToolPlace").click();
  await expect(page.locator("#modelAlignGo")).toBeEnabled();
  await page.locator("#tabPrepare").click();
  await page.locator("[data-plate-select]").nth(0).click();
  await plateClick(page, "remove", 0);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await page.locator("#modelToolPlace").click();
  await expect(page.locator("#modelAlignGo")).toBeDisabled();
});
