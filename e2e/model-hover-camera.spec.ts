import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

/**
 * Model and the camera. The grey object a Ctrl-click would select is outlined under the pointer; Ctrl-click selects it
 * and the camera stays; Ctrl+double-click selects and frames it; an object added to the plate is brought into view with the
 * least camera move, and none when it already is.
 */

type V = [number, number, number];

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "ux-glass-hover");

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
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

const SOLIDS: Record<string, ReturnType<typeof boxSolid>> = {
  "big.step": boxSolid([40, 30, 20], [60, 0, 0]),
  "small.step": boxSolid([20, 20, 10]),
  "third.step": boxSolid([30, 30, 30]),
};

const canvas = (page: Page) => page.locator("#model");

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

/** Two objects on the plate: big at (100, 100), small at (160, 100). Model opens on `small`; big is grey. Returns big's id. */
async function modelWithGrey(page: Page): Promise<string> {
  const named = (route: { request(): { postDataJSON(): { filename?: string } } }) => SOLIDS[route.request().postDataJSON().filename ?? ""]!;
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: named(route).positions } }));
  await mockModelTree(page, { open: (request) => SOLIDS[String(request.filename)]! });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  const step = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  await page.locator("#file").setInputFiles({ name: "big.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabPrepare").click();
  await commit(page, "#placeX", 100);
  await commit(page, "#placeY", 100);
  const big = await page.locator("#prepare").getAttribute("data-plate-selected");
  await page.locator("#plateAddFile").setInputFiles({ name: "small.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await commit(page, "#placeX", 160);
  await commit(page, "#placeY", 100);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await expect(canvas(page)).toHaveAttribute("data-context-count", "1");
  // Model opens on the open solid alone; Shift+Home frames every object, so the grey one is in view.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Shift+Home");
  await restingCamera(page);
  return big!;
}

/** The camera once it has stopped gliding. */
async function restingCamera(page: Page): Promise<string> {
  let last = "";
  let still = 0;
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(150);
    const now = (await canvas(page).getAttribute("data-camera")) ?? "";
    still = now && now === last ? still + 1 : 0;
    if (still >= 4) return now;
    last = now;
  }
  return last;
}

/** Where the grey objects, as one box, sit on the canvas: `[x, y, w, h]`. */
async function greyBox(page: Page): Promise<number[]> {
  const raw = (await canvas(page).getAttribute("data-context-screen")) ?? "";
  return raw.split(",").map(Number);
}

async function greyCentre(page: Page): Promise<{ x: number; y: number }> {
  await restingCamera(page);
  const [x, y, w, h] = await greyBox(page);
  const box = (await canvas(page).boundingBox())!;
  return { x: box.x + x! + w! / 2, y: box.y + y! + h! / 2 };
}

const selectedId = (page: Page) => page.locator("#prepare").getAttribute("data-plate-selected");

test("Model outlines the grey object under the pointer, and clears it when the pointer leaves", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const big = await modelWithGrey(page);
  await expect(canvas(page)).toHaveAttribute("data-hover-object", "");
  const centre = await greyCentre(page);
  await page.mouse.move(centre.x, centre.y);
  await expect(canvas(page)).toHaveAttribute("data-hover-object", big);
  await expect(canvas(page)).toHaveAttribute("data-hover-drawn", "true");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "hover-model.png") });

  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + box.height - 8);
  await expect(canvas(page)).toHaveAttribute("data-hover-object", "");

  // Not while a button is down.
  await page.mouse.down();
  await page.mouse.move(centre.x, centre.y, { steps: 6 });
  await expect(canvas(page)).toHaveAttribute("data-hover-object", "");
  await page.mouse.up();

  // Leaving the canvas clears it.
  const moved = await greyCentre(page);
  await page.mouse.move(moved.x, moved.y);
  await expect(canvas(page)).toHaveAttribute("data-hover-object", big);
  await page.mouse.move(box.x - 30, box.y + 100);
  await expect(canvas(page)).toHaveAttribute("data-hover-object", "");
});

test("Ctrl-click in Model selects the grey object and leaves the camera exactly where it was", async ({ page }) => {
  const big = await modelWithGrey(page);
  const box = (await canvas(page).boundingBox())!;
  // The view the person left it in: zoomed and turned, not the one Model opened with.
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, 200);
  const before = await restingCamera(page);
  const centre = await greyCentre(page);
  expect(await selectedId(page)).not.toBe(big);

  await page.keyboard.down("Control");
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.up("Control");
  await expect.poll(() => selectedId(page)).toBe(big);
  // The open solid is now big; give the view time to swap, then compare.
  await expect(canvas(page)).toHaveAttribute("data-context-count", "1");
  await page.waitForTimeout(600);
  expect(await restingCamera(page), "a Ctrl-click selects and does not move the camera").toBe(before);
});

test("Ctrl+double-click in Model selects the grey object and frames it", async ({ page }) => {
  const big = await modelWithGrey(page);
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, 200);
  const before = await restingCamera(page);
  const centre = await greyCentre(page);

  await page.keyboard.down("Control");
  await page.mouse.dblclick(centre.x, centre.y);
  await page.keyboard.up("Control");
  await expect.poll(() => selectedId(page)).toBe(big);
  await expect.poll(async () => restingCamera(page), { timeout: 10_000 }).not.toBe(before);
  // Framed: big now fills the view's middle.
  await expect(canvas(page)).toHaveAttribute("data-solid-screen", /^-?\d+,-?\d+,\d+,\d+$/);
  const [x, y, w, h] = ((await canvas(page).getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const view = (await canvas(page).boundingBox())!;
  expect(x! >= 0 && y! >= 0 && x! + w! <= view.width && y! + h! <= view.height, "the framed solid is inside the view").toBe(true);
  expect(Math.max(w! / view.width, h! / view.height), "and it fills a good part of it").toBeGreaterThan(0.2);
  // Only the object is selected: the second click's face pick is taken back.
  await expect(page.locator("#modelReadout")).toContainText("Pick a face or an edge");
  await expect(page.locator("#modelReadout")).not.toContainText(/^Face/);
});

test("an object added to the plate that is out of view brings the camera back just far enough; one in view leaves it", async ({ page }) => {
  const big = await modelWithGrey(page);
  expect(big).toBeTruthy();
  const view = (await canvas(page).boundingBox())!;
  const inside = (rect: number[]) => rect[0]! >= 0 && rect[1]! >= 0 && rect[0]! + rect[2]! <= view.width && rect[1]! + rect[3]! <= view.height;
  const step = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");

  // Close in on the open solid, so any new part lands out of view.
  await page.mouse.move(view.x + view.width * 0.5, view.y + view.height * 0.5);
  for (let i = 0; i < 16; i += 1) await page.mouse.wheel(0, -300);
  const close = await restingCamera(page);
  await page.locator("#plateAddFile").setInputFiles({ name: "third.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await expect(canvas(page)).toHaveAttribute("data-context-count", "2");
  await expect.poll(async () => restingCamera(page), { timeout: 10_000 }).not.toBe(close);
  const after = await restingCamera(page);
  const solid = ((await canvas(page).getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  expect(inside(solid), "the new part is in view").toBe(true);
  // The least move: the camera backed away along its line of sight and kept its target, so what was in view still is.
  const [position0, target0] = close.split(";").map((text) => text.split(",").map(Number)) as [number[], number[]];
  const [position1, target1] = after.split(";").map((text) => text.split(",").map(Number)) as [number[], number[]];
  expect(target1, "the camera still looks at the same point").toEqual(target0);
  const distance = (p: number[], t: number[]) => Math.hypot(p[0]! - t[0]!, p[1]! - t[1]!, p[2]! - t[2]!);
  expect(distance(position1, target1)).toBeGreaterThan(distance(position0, target0));
  const direction = (p: number[], t: number[]) => { const d = distance(p, t); return [(p[0]! - t[0]!) / d, (p[1]! - t[1]!) / d, (p[2]! - t[2]!) / d]; };
  for (let i = 0; i < 3; i += 1) expect(direction(position1, target1)[i]).toBeCloseTo(direction(position0, target0)[i]!, 1);

  // Back off a long way: a fourth part lands in view, and the camera does not move.
  await page.mouse.move(view.x + view.width * 0.5, view.y + view.height * 0.5);
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, 300);
  const far = await restingCamera(page);
  await page.locator("#plateAddFile").setInputFiles({ name: "third.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(4);
  await expect(canvas(page)).toHaveAttribute("data-context-count", "3");
  await page.waitForTimeout(800);
  expect(await restingCamera(page), "a new part already in view does not move the camera").toBe(far);
  expect(inside(((await canvas(page).getAttribute("data-solid-screen")) ?? "").split(",").map(Number))).toBe(true);
});
