import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

const out = path.resolve("artifacts/model-drag");
fs.mkdirSync(out, { recursive: true });

type V = [number, number, number];

/** A 20 x 20 x 10 mm box as the modeler reports it: one face id per triangle and twelve straight edges. */
function boxSolid(min: V = [0, 0, 0], size: V = [20, 20, 10]) {
  const [ox, oy, oz] = min;
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [ox + x * sx, oy + y * sy, oz + z * sz];
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
  const faces = quads.map((_, id) => ({ id, areaMm2: 0 }));
  return { volumeMm3: sx * sy * sz, positions, triangles, faces, edges };
}

async function openSolid(page: Page, probes: Record<string, unknown>[], solid = boxSolid(), built = solid, applied: Record<string, unknown>[] = []) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, {
    open: () => solid,
    apply: (request) => {
      applied.push(request.op as Record<string, unknown>);
      return built;
    },
    probe: (request) => {
      probes.push(request.op as Record<string, unknown>);
      return { ok: true };
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
}

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

/** Where the dock's middle is, in page pixels. */
async function dock(page: Page): Promise<{ x: number; y: number }> {
  await expect(page.locator("#model")).toHaveAttribute("data-gizmo-at", /\d+,\d+/);
  const [x, y] = ((await page.locator("#model").getAttribute("data-gizmo-at")) ?? "0,0").split(",").map(Number);
  const box = (await page.locator("#model").boundingBox())!;
  return { x: box.x + x!, y: box.y + y! };
}

/** The ghost's world box: its centre and its size in millimetres. */
async function ghost(page: Page): Promise<{ at: number[]; size: number[] }> {
  const numbers = ((await page.locator("#model").getAttribute("data-ghost")) ?? "").split(" ").map(Number);
  return { at: numbers.slice(0, 3), size: numbers.slice(3, 6) };
}

/** The smallest distance between any two handle grips, in pixels. */
async function minGripGap(page: Page): Promise<number> {
  const all = Object.entries(await grips(page));
  let least = Infinity;
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) least = Math.min(least, Math.hypot(all[i]![1].x - all[j]![1].x, all[i]![1].y - all[j]![1].y));
  }
  return least;
}

async function setField(page: Page, id: string, text: string) {
  await page.locator(`#${id}`).fill(text);
  await page.locator(`#${id}`).dispatchEvent("input");
}

async function grip(page: Page, id: string) {
  await expect.poll(async () => Object.keys(await grips(page))).toContain(id);
  return (await grips(page))[id]!;
}

async function drag(page: Page, id: string, dx: number, dy: number, keys: string[] = []) {
  const from = await grip(page, id);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const key of keys) await page.keyboard.down(key);
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  await page.mouse.up();
  for (const key of keys) await page.keyboard.up(key);
}

const value = async (page: Page, id: string) => Number(await page.locator(`#${id}`).inputValue());

test("the split plane drags inside the part, Shift is fine, and Ctrl snaps", async ({ page }) => {
  await openSolid(page, []);
  await page.locator("#modelToolSplit").click();
  await expect(page.locator("#modelPlaneZ")).toHaveValue("5");
  await drag(page, "plane", 0, -40);
  const coarse = (await value(page, "modelPlaneZ")) - 5;
  expect(coarse).toBeGreaterThan(0.5);
  await expect(page.locator("#modelNote")).toContainText("From 0.25 to 9.75 mm");

  await page.locator("#modelPlaneZ").fill("5");
  await page.locator("#modelPlaneZ").dispatchEvent("input");
  await drag(page, "plane", 0, -40, ["Shift"]);
  const fine = (await value(page, "modelPlaneZ")) - 5;
  expect(fine).toBeGreaterThan(0);
  expect(fine).toBeLessThan(coarse / 3);

  await drag(page, "plane", 0, -400);
  expect(await value(page, "modelPlaneZ")).toBeLessThanOrEqual(9.75);

  await page.locator("#modelPlaneZ").fill("5");
  await page.locator("#modelPlaneZ").dispatchEvent("input");
  await drag(page, "plane", 0, -40, ["Control"]);
  expect(Number.isInteger(await value(page, "modelPlaneZ"))).toBe(true);
  await expect(page.locator("#modelApply")).toBeEnabled();
});

test("the dock stays put through orbit, zoom, pan, a tool change, and a number typed into a field", async ({ page }) => {
  await openSolid(page, [], boxSolid([-110, -110, 0], [220, 220, 5.1]));
  await page.locator("#modelToolBoolean").click();
  const start = await dock(page);
  const canvas = (await page.locator("#model").boundingBox())!;
  const empty = { x: canvas.x + canvas.width * 0.5, y: canvas.y + canvas.height * 0.88 };
  const still = async (step: string) => {
    await page.waitForTimeout(600);
    const now = await dock(page);
    expect(Math.hypot(now.x - start.x, now.y - start.y), `${step} moves the dock`).toBeLessThanOrEqual(1);
  };

  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x - 160, empty.y - 70, { steps: 10 });
  await page.mouse.up();
  await still("orbit");

  await page.mouse.move(empty.x, empty.y - 120);
  await page.mouse.wheel(0, -600);
  await still("zoom in");
  await page.mouse.wheel(0, 1200);
  await still("zoom out");

  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(empty.x - 120, empty.y - 40, { steps: 10 });
  await page.mouse.up({ button: "right" });
  await still("pan");

  await page.locator("#modelX").fill("-60");
  await page.locator("#modelX").dispatchEvent("input");
  await still("a typed X");
  await page.locator("#modelToolHole").click();
  await still("the Hole tool");
  await page.locator("#modelToolScale").click();
  await still("the Scale tool");
  await page.locator("#modelToolSplit").click();
  await expect(page.locator("#model")).not.toHaveAttribute("data-gizmo-at", /.+/);
});

test("a boolean primitive moves, resizes, and turns from the dock, in sync with its numbers", async ({ page }) => {
  const probes: Record<string, unknown>[] = [];
  await openSolid(page, probes);
  await page.locator("#modelToolBoolean").click();
  const before = await grip(page, "move-x");

  await page.locator("#modelX").fill("0");
  await page.locator("#modelX").dispatchEvent("input");
  await page.waitForTimeout(300);
  const after = await grip(page, "move-x");
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThanOrEqual(1);

  const x0 = await value(page, "modelX");
  await drag(page, "move-x", 60, 25);
  expect(await value(page, "modelX")).not.toBe(x0);

  const dz0 = await value(page, "modelDz");
  await drag(page, "size-2", 0, -30);
  expect(await value(page, "modelDz")).toBeGreaterThan(dz0);

  await page.screenshot({ path: path.join(out, "boolean-handles.png") });
  await drag(page, "turn-modelRz", -140, -90, ["Control"]);
  const rz = await value(page, "modelRz");
  expect(rz).not.toBe(0);
  expect(Math.abs(rz % 15)).toBe(0);
  await expect.poll(() => (probes.at(-1)?.turn as number[] | undefined)?.[2]).toBe(rz);
  await page.screenshot({ path: path.join(out, "boolean-turned.png") });
});

test("a 2 mm primitive still has every handle on its own spot, and its Size X knob grows it", async ({ page }) => {
  await openSolid(page, []);
  await page.locator("#modelToolBoolean").click();
  for (const id of ["modelDx", "modelDy", "modelDz"]) await setField(page, id, "2");
  await expect.poll(async () => (await ghost(page)).size[0]).toBeCloseTo(2, 1);
  expect(await minGripGap(page)).toBeGreaterThanOrEqual(14);

  const start = await grip(page, "size-0");
  const centre = await dock(page);
  const length = Math.hypot(start.x - centre.x, start.y - centre.y);
  expect(length, "the knob stands out of the dock's middle").toBeGreaterThan(40);
  const outward: [number, number] = [((start.x - centre.x) / length) * 10, ((start.y - centre.y) / length) * 10];
  const dx0 = await value(page, "modelDx");
  await drag(page, "size-0", outward[0], outward[1]);
  const dx1 = await value(page, "modelDx");
  expect(dx1).toBeGreaterThan(dx0);
  expect((await ghost(page)).size[0]).toBeCloseTo(dx1, 1);
  await page.screenshot({ path: path.join(out, "boolean-tiny.png") });

  await page.locator("#modelPrim").selectOption("cylinder");
  for (const id of ["modelRadius", "modelHeight"]) await setField(page, id, "1");
  await expect.poll(async () => Object.keys(await grips(page))).toContain("height");
  expect(await minGripGap(page)).toBeGreaterThanOrEqual(14);
  await page.locator("#modelPrim").selectOption("sphere");
  await expect.poll(async () => Object.keys(await grips(page))).not.toContain("height");
  expect(await minGripGap(page)).toBeGreaterThanOrEqual(14);
});

test("the ghost of the edited object stands out while a docked handle is hovered or dragged", async ({ page }) => {
  await openSolid(page, []);
  await page.locator("#modelToolBoolean").click();
  expect(await page.locator("#model").getAttribute("data-ghost-lit")).not.toBe("1");
  const at = await grip(page, "size-1");
  await page.mouse.move(at.x, at.y);
  await expect(page.locator("#model")).toHaveAttribute("data-ghost-lit", "1");
  await expect(page.locator(".model-drag-tip")).toContainText("Size Y");
  await page.mouse.move(at.x - 300, at.y + 200);
  await expect(page.locator("#model")).toHaveAttribute("data-ghost-lit", "0");
  await expect(page.locator(".model-drag-tip")).toBeHidden();

  await page.locator("#modelToolMeasure").click();
  const dot = await grip(page, "measure-a");
  await page.mouse.move(dot.x, dot.y);
  await expect(page.locator("#model")).toHaveAttribute("data-ghost-lit", "0");
});

test("a hole slides in its face plane from two docked arrows, and its origin dot still drags over the solid", async ({ page }) => {
  const probes: Record<string, unknown>[] = [];
  await openSolid(page, probes);
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelZ")).toHaveValue("10");
  await expect.poll(async () => Object.keys(await grips(page)).sort()).toEqual(["hole-depth", "hole-move-u", "hole-move-v", "hole-origin", "hole-radius"]);
  expect(await minGripGap(page)).toBeGreaterThanOrEqual(14);

  const slide = async (id: string) => {
    const from = await grip(page, id);
    const centre = await dock(page);
    const length = Math.hypot(from.x - centre.x, from.y - centre.y);
    await drag(page, id, ((from.x - centre.x) / length) * 40, ((from.y - centre.y) / length) * 40);
  };

  const first = { x: await value(page, "modelX"), y: await value(page, "modelY"), z: await value(page, "modelZ") };
  const ghost0 = await ghost(page);
  await slide("hole-move-u");
  const moved = { x: await value(page, "modelX"), y: await value(page, "modelY"), z: await value(page, "modelZ") };
  expect(moved.x).not.toBe(first.x);
  expect(moved.y).toBe(first.y);
  expect(moved.z).toBe(10);
  expect((await ghost(page)).at[0]).toBeCloseTo(ghost0.at[0] + (moved.x - first.x), 1);

  await slide("hole-move-v");
  expect(await value(page, "modelY")).not.toBe(first.y);
  expect(await value(page, "modelX")).toBe(moved.x);
  expect(await value(page, "modelZ")).toBe(10);
  await expect.poll(() => (probes.at(-1)?.origin as number[] | undefined)?.[2]).toBe(10);
  await page.screenshot({ path: path.join(out, "hole-handles.png") });

  const x1 = await value(page, "modelX");
  const dot = await grip(page, "hole-origin");
  await page.mouse.move(dot.x, dot.y);
  await expect(page.locator(".model-drag-tip")).toContainText("Origin");
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) await page.mouse.move(dot.x - 4 * i, dot.y - 2 * i);
  await page.mouse.up();
  expect(await value(page, "modelX")).not.toBe(x1);

  const depth0 = await value(page, "modelHoleD");
  const knob = await grip(page, "hole-depth");
  const centre = await dock(page);
  const length = Math.hypot(knob.x - centre.x, knob.y - centre.y);
  await drag(page, "hole-depth", ((knob.x - centre.x) / length) * 30, ((knob.y - centre.y) / length) * 30);
  expect(await value(page, "modelHoleD")).not.toBe(depth0);
});

test("a docked drag is one undo step: nothing until Apply, then one", async ({ page }) => {
  const solid = boxSolid();
  const cut = boxSolid([0, 0, 0], [20, 20, 9]);
  const hole: Record<string, unknown>[] = [];
  await openSolid(page, [], solid, cut, hole);
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelUndo")).toBeDisabled();
  const from = await grip(page, "hole-move-u");
  const centre = await dock(page);
  const length = Math.hypot(from.x - centre.x, from.y - centre.y);
  const x0 = await value(page, "modelX");
  await drag(page, "hole-move-u", ((from.x - centre.x) / length) * 40, ((from.y - centre.y) / length) * 40);
  const x1 = await value(page, "modelX");
  expect(x1).not.toBe(x0);
  await expect(page.locator("#modelUndo")).toBeDisabled();

  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelUndo")).toBeEnabled();
  expect(hole).toHaveLength(1);
  expect((hole[0]!.origin as number[])[0]).toBe(x1);
  expect((hole[0]!.origin as number[])[2]).toBe(10);
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelUndo")).toBeDisabled();
});

test("scale and measure each have a drag", async ({ page }) => {
  await openSolid(page, []);
  await page.locator("#modelToolScale").click();
  const factor0 = await value(page, "modelFactor");
  for (const [dx, dy] of [[80, 0], [0, -80], [-60, 40]] as const) {
    await drag(page, "factor", dx, dy);
    if ((await value(page, "modelFactor")) !== factor0) break;
  }
  expect(await value(page, "modelFactor")).not.toBe(factor0);

  await page.locator("#modelToolMeasure").click();
  await expect(page.locator("#modelApply")).toBeHidden();
  await expect(page.locator("#modelNote")).toContainText("Distance 30 mm");
  const a = await grip(page, "measure-a");
  const b = await grip(page, "measure-b");
  await drag(page, "measure-b", (a.x - b.x) * 0.5, (a.y - b.y) * 0.5);
  await expect(page.locator("#modelNote")).not.toContainText("Distance 30 mm");
  await expect(page.locator("#modelNote")).toContainText("Distance");
  await page.screenshot({ path: path.join(out, "measure-handles.png") });
});
