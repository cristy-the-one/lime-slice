import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

const shots = path.resolve("test-results/place-snap");
fs.mkdirSync(shots, { recursive: true });

type V = [number, number, number];

/** A 20 x 20 x 10 mm box as the modeler reports it: one face id per triangle and twelve straight edges. */
function boxSolid() {
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
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const pa = corners[a!]!;
    const pb = corners[b!]!;
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  const faces = quads.map((_, id) => ({ id, areaMm2: 0 }));
  return { volumeMm3: 4000, positions, triangles, faces, edges };
}

async function openSolid(page: Page) {
  const solid = boxSolid();
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid, apply: () => solid, probe: () => ({ ok: true }) });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?perf=1");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
}

async function grip(page: Page, id: string) {
  const read = async () => {
    const text = (await page.locator("#model").getAttribute("data-handles")) ?? "";
    const found = text.split(" ").find((item) => item.startsWith(`${id}:`));
    return found ? found.split(":")[1]!.split(",").map(Number) : null;
  };
  await expect.poll(read).not.toBeNull();
  const [x, y] = (await read())!;
  const box = (await page.locator("#model").boundingBox())!;
  return { x: box.x + x!, y: box.y + y! };
}

const value = async (page: Page, id: string) => Number(await page.locator(`#${id}`).inputValue());
const snapOf = (page: Page) => page.locator("#model").getAttribute("data-measure-snap");

/** Drag B down the left edge of the solid on screen, where its leftmost corner is, until it snaps to something of this kind. */
async function dragBUntil(page: Page, kind: string, along: "left" | "top"): Promise<string> {
  const box = (await page.locator("#model").boundingBox())!;
  const [sx, sy, sw, sh] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const from = await grip(page, "measure-b");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 60;
  for (let i = 0; i <= steps; i += 1) {
    const x = along === "left" ? box.x + sx! + 7 : box.x + sx! + (sw! * i) / steps;
    const y = along === "left" ? box.y + sy! + (sh! * i) / steps : box.y + sy! + 7;
    await page.mouse.move(x, y);
    const snap = (await snapOf(page)) ?? "";
    if (snap.startsWith(`${kind}:`)) return snap;
  }
  return "";
}

test("a Measure point snaps to a vertex, and the readout is the exact distance between the snapped points", async ({ page }) => {
  await openSolid(page);
  await page.locator("#modelToolMeasure").click();
  await expect(page.locator("#modelNote")).toContainText("Distance");

  const snap = await dragBUntil(page, "vertex", "left");
  expect(snap, "B reached a vertex").toMatch(/^vertex:/);
  const [px, py, pz] = snap.split(":")[1]!.split(",").map(Number);
  expect([0, 20]).toContain(Math.round(px!));
  expect([0, 20]).toContain(Math.round(py!));
  expect([0, 10]).toContain(Math.round(pz!));
  await expect(page.locator("#model .model-snap-mark, .model-snap-mark").first()).toBeVisible();
  await expect(page.locator(".model-snap-mark span").first()).toHaveText("Vertex");
  await page.screenshot({ path: path.join(shots, "measure-snap.png") });
  await page.mouse.up();

  const b = [await value(page, "modelBx"), await value(page, "modelBy"), await value(page, "modelBz")];
  expect(b).toEqual([Math.round(px!), Math.round(py!), Math.round(pz!)]);
  const a = [await value(page, "modelAx"), await value(page, "modelAy"), await value(page, "modelAz")];
  const exact = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  const note = (await page.locator("#modelNote").textContent()) ?? "";
  expect(note).toContain(`Distance ${Number(exact.toFixed(2))} mm`);
  expect(note).toContain(`ΔX ${Number((b[0]! - a[0]!).toFixed(2)) === 0 ? "0" : Number((b[0]! - a[0]!).toFixed(2))}`);
});

test("holding Alt turns the Measure snap off for that drag", async ({ page }) => {
  await openSolid(page);
  await page.locator("#modelToolMeasure").click();
  await page.keyboard.down("Alt");
  const snap = await dragBUntil(page, "vertex", "left");
  expect(snap).toBe("");
  await page.mouse.up();
  await page.keyboard.up("Alt");
});
