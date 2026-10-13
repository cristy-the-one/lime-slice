import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const out = path.resolve("artifacts/model-drag");
fs.mkdirSync(out, { recursive: true });

type V = [number, number, number];

/** A 20 x 20 x 10 mm box as the modeler reports it: one face id per triangle and twelve straight edges. */
function boxSolid() {
  const [sx, sy, sz] = [20, 20, 10];
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
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const pa = corners[a!]!;
    const pb = corners[b!]!;
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  const faces = quads.map((_, id) => ({ id, areaMm2: 0 }));
  return { id: 1, volumeMm3: sx * sy * sz, positions, triangles, faces, edges };
}

async function openSolid(page: Page, probes: Record<string, unknown>[]) {
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await page.route("**/api/model/probe", (route) => {
    probes.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/model", (route) => route.fulfill({ json: solid }));
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
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

test("a boolean primitive moves, resizes, and turns from the viewport, in sync with its numbers", async ({ page }) => {
  const probes: Record<string, unknown>[] = [];
  await openSolid(page, probes);
  await page.locator("#modelToolBoolean").click();
  const before = await grip(page, "move-x");

  await page.locator("#modelX").fill("0");
  await page.locator("#modelX").dispatchEvent("input");
  await expect.poll(async () => (await grip(page, "move-x")).x).not.toBe(before.x);

  const x0 = await value(page, "modelX");
  await drag(page, "move-x", 60, 25);
  expect(await value(page, "modelX")).not.toBe(x0);

  const dz0 = await value(page, "modelDz");
  await drag(page, "size-2", 0, -30);
  expect(await value(page, "modelDz")).toBeGreaterThan(dz0);

  await page.screenshot({ path: path.join(out, "boolean-handles.png") });
  await drag(page, "turn-modelRz", 0, -70, ["Control"]);
  const rz = await value(page, "modelRz");
  expect(rz).not.toBe(0);
  expect(Math.abs(rz % 15)).toBe(0);
  await expect.poll(() => probes.at(-1)?.rz).toBe(rz);
  await page.screenshot({ path: path.join(out, "boolean-turned.png") });
});

test("hole, scale, and measure each have a drag", async ({ page }) => {
  await openSolid(page, []);
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#modelZ")).toHaveValue("10");
  const depth0 = await value(page, "modelHoleD");
  await drag(page, "hole-depth", 0, 30);
  expect(await value(page, "modelHoleD")).toBeGreaterThan(depth0);
  await page.screenshot({ path: path.join(out, "hole-handles.png") });

  await page.locator("#modelToolScale").click();
  const factor0 = await value(page, "modelFactor");
  const knob = await grip(page, "factor");
  const box = (await page.locator("#model").boundingBox())!;
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await drag(page, "factor", (mid.x - knob.x) * 0.3, (mid.y - knob.y) * 0.3);
  expect(await value(page, "modelFactor")).toBeLessThan(factor0);

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
