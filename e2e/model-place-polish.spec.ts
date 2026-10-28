import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";

/**
 * Model's Place tool after 4.2: Settle on the bed with Prepare's rest pose and switch, angles that read back as typed,
 * and a Windows precision touchpad that orbits and zooms the Model and Prepare viewports.
 */

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "model-place-polish");

type V = [number, number, number];

function boxSolid(size: V, at: V = [0, 0, 0]): MockSolid {
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

const SLAB = boxSolid([40, 30, 20]);

async function commit(page: Page, id: string, value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

const canvas = (page: Page) => page.locator("#model");
const turns = async (page: Page) => Promise.all(["#modelPlaceRx", "#modelPlaceRy", "#modelPlaceRz"].map(async (id) => page.locator(id).inputValue()));
const solidBox = async (page: Page) => ((await canvas(page).getAttribute("data-solid")) ?? "").split(",").map(Number);

/** One slab on the plate, open in Model. `settle` is the remembered switch. */
async function openSlab(page: Page, settle: boolean) {
  await page.addInitScript((on) => {
    localStorage.setItem("lime-slice-theme", "dark");
    localStorage.setItem("lime-slice-settle", on ? "1" : "0");
  }, settle);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: SLAB.positions } }));
  await mockModelTree(page, { open: () => SLAB, probe: () => ({ ok: true }) });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "slab.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 24000");
}

async function openPlace(page: Page) {
  if ((await page.locator("#modelToolPlace").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolPlace").click();
  await expect(page.locator("#modelPlaceX")).toBeVisible();
}

/** The camera at rest: the same reading twice in a row. */
async function still(page: Page, read: () => Promise<string | null>) {
  let last: string | null = "";
  await expect.poll(async () => {
    const now = await read();
    const same = now === last;
    last = now;
    return same;
  }, { intervals: [150] }).toBe(true);
  return last ?? "";
}

/** Drag the Turn Y ring round its centre by `degrees` on screen, from the front view where it faces the camera. */
async function turnRingY(page: Page, degrees: number) {
  const box = (await canvas(page).boundingBox())!;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("y");
  await still(page, () => canvas(page).getAttribute("data-camera"));
  const at = (name: string) => {
    const text = name.split(" ").find((item) => item.startsWith("turn-modelPlaceRy:"));
    const [x, y] = (text ?? ":0,0").split(":")[1]!.split(",").map(Number);
    return { x: box.x + x!, y: box.y + y! };
  };
  await expect.poll(async () => (await canvas(page).getAttribute("data-handles")) ?? "").toContain("turn-modelPlaceRy:");
  const grip = at((await canvas(page).getAttribute("data-handles"))!);
  const [cx, cy] = ((await canvas(page).getAttribute("data-gizmo-at")) ?? "0,0").split(",").map(Number);
  const centre = { x: box.x + cx!, y: box.y + cy! };
  const r = Math.hypot(grip.x - centre.x, grip.y - centre.y);
  const a0 = Math.atan2(grip.y - centre.y, grip.x - centre.x);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i += 1) {
    const a = a0 + ((degrees * Math.PI) / 180) * (i / steps);
    await page.mouse.move(centre.x + r * Math.cos(a), centre.y + r * Math.sin(a));
  }
  await page.mouse.up();
}

test("Settle on the bed: a ring turn near a face rests on it, on the floor the part stood on; off keeps the angle", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  await openSlab(page, true);
  await openPlace(page);
  await expect(page.locator("#modelSettleOn")).toBeChecked();
  expect(await solidBox(page)).toEqual([0, 0, 0, 40, 30, 20]);

  // A ring turn of about 80 degrees ends near the side face: it lands on it, at 90, resting on Z 0 where the slab stood.
  await turnRingY(page, 80);
  await expect.poll(async () => Math.abs(Number((await turns(page))[1]))).toBe(90);
  const [rx, , rz] = await turns(page);
  expect([rx, rz]).toEqual(["0", "0"]);
  await expect.poll(async () => (await solidBox(page))[2]).toBeCloseTo(0, 2);
  const settled = await solidBox(page);
  expect(settled[5]! - settled[2]!, "standing on its 30 x 20 side, it is 40 high").toBeCloseTo(40, 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "settled.png") });

  // One Place Undo takes the settled turn back.
  await page.locator("#modelUndo").click();
  await expect.poll(() => solidBox(page)).toEqual([0, 0, 0, 40, 30, 20]);

  // Typed angles stay exact with Settle on.
  await commit(page, "#modelPlaceRy", 80);
  await expect.poll(async () => (await turns(page))[1]).toBe("80");
  await page.waitForTimeout(500);

  // The switch is Prepare's: off here is off there, and a ring turn then keeps its angle, turning about the centre.
  await page.locator("#modelSettleOn").uncheck();
  expect(await page.evaluate(() => localStorage.getItem("lime-slice-settle"))).toBe("0");
  await page.locator("#modelUndo").click();
  await expect.poll(() => solidBox(page)).toEqual([0, 0, 0, 40, 30, 20]);
  await turnRingY(page, 80);
  await expect.poll(async () => Math.abs(Number((await turns(page))[1]))).toBeGreaterThan(60);
  const free = Math.abs(Number((await turns(page))[1]));
  expect(free, "off, the ring keeps the angle it was turned to").toBeLessThan(89);
  expect((await solidBox(page))[2], "turned about its centre, a corner goes under the floor").toBeLessThan(-1);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#settleOn")).not.toBeChecked();
});

test("Place angles read back as typed, and a turn past 90 degrees keeps its own reading", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  await openSlab(page, false);
  await openPlace(page);
  // On main, Rz 30 then Ry 120 read back as 180 / 60 / -150, and Ry 90 moved Rz 30 into Rx.
  await commit(page, "#modelPlaceRz", 30);
  await commit(page, "#modelPlaceRy", 120);
  await page.waitForTimeout(500);
  await page.locator("#modelCancel").click();
  await openPlace(page);
  expect(await turns(page)).toEqual(["0", "120", "30"]);
  await expect(page.locator("#modelPositionText")).toHaveText("Turn Y 120° · Turn Z 30°");
  await page.screenshot({ path: path.join(shots, "angles.png") });

  await commit(page, "#modelPlaceRy", 90);
  await page.waitForTimeout(500);
  await page.locator("#modelCancel").click();
  await openPlace(page);
  expect(await turns(page), "at Ry 90 Rz keeps its 30").toEqual(["0", "90", "30"]);
  await commit(page, "#modelPlaceRx", -45);
  await page.waitForTimeout(500);
  await page.locator("#modelCancel").click();
  await openPlace(page);
  expect(await turns(page)).toEqual(["-45", "90", "30"]);

  // Every typed angle reads back, and Place Undo walks back through the same readings.
  for (const [id, value] of [["#modelPlaceRx", 170], ["#modelPlaceRy", -135], ["#modelPlaceRz", -90]] as const) {
    await commit(page, id, value);
    await page.waitForTimeout(450);
  }
  await page.locator("#modelCancel").click();
  await openPlace(page);
  expect(await turns(page)).toEqual(["170", "-135", "-90"]);
  await page.locator("#modelUndo").click();
  await expect.poll(() => turns(page)).toEqual(["170", "-135", "30"]);
});

/** Wheel events as a Windows precision touchpad sends them: pixel deltas, a pinch with ctrlKey. */
async function wheel(page: Page, selector: string, init: { deltaX?: number; deltaY?: number; ctrlKey?: boolean }, times: number) {
  await page.evaluate(({ selector, init, times }) => {
    const el = document.querySelector(selector) as HTMLElement;
    const r = el.getBoundingClientRect();
    for (let i = 0; i < times; i += 1) {
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 3, deltaMode: 0, ...init }));
    }
  }, { selector, init, times });
}

type P = [number, number, number];
const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dir = (a: P, b: P): P => {
  const d = dist(a, b);
  return [(a[0] - b[0]) / d, (a[1] - b[1]) / d, (a[2] - b[2]) / d];
};
const angle = (u: P, v: P) => (Math.acos(Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])) * 180) / Math.PI;

test("a touchpad orbits with two fingers and zooms with a pinch, in Model and in Prepare", async ({ page }) => {
  await openSlab(page, false);
  const read = async () => {
    const [eye, aim] = (await still(page, () => canvas(page).getAttribute("data-camera"))).split(";").map((part) => part.split(",").map(Number) as P);
    return { eye: eye!, aim: aim! };
  };
  const start = await read();

  // Two fingers sideways: the camera goes round the target, at the same distance and height.
  await wheel(page, "#model", { deltaX: 12 }, 12);
  const sideways = await read();
  expect(sideways.aim).toEqual(start.aim);
  expect(dist(sideways.eye, sideways.aim)).toBeCloseTo(dist(start.eye, start.aim), 0);
  expect(sideways.eye[2], "an orbit about the up axis keeps the height").toBeCloseTo(start.eye[2], 0);
  expect(angle(dir(sideways.eye, sideways.aim), dir(start.eye, start.aim)), "it turned").toBeGreaterThan(10);

  // Two fingers up and down orbit over the top, a fraction or a small step at a time.
  await wheel(page, "#model", { deltaY: 3.5 }, 12);
  const tilted = await read();
  expect(dist(tilted.eye, tilted.aim)).toBeCloseTo(dist(start.eye, start.aim), 0);
  expect(Math.abs(tilted.eye[2] - sideways.eye[2]), "it tilted").toBeGreaterThan(2);

  // A pinch zooms in, toward the same target, without turning.
  await wheel(page, "#model", { deltaY: -4, ctrlKey: true }, 10);
  const pinched = await read();
  expect(dist(pinched.eye, pinched.aim)).toBeLessThan(dist(tilted.eye, tilted.aim) * 0.9);
  expect(angle(dir(pinched.eye, pinched.aim), dir(tilted.eye, tilted.aim))).toBeLessThan(0.5);

  // A mouse wheel still zooms: a whole notch is not a touchpad.
  await page.mouse.move(700, 400);
  await wheel(page, "#model", { deltaY: 100 }, 3);
  const wheeled = await read();
  expect(dist(wheeled.eye, wheeled.aim)).toBeGreaterThan(dist(pinched.eye, pinched.aim) * 1.1);
  expect(angle(dir(wheeled.eye, wheeled.aim), dir(pinched.eye, pinched.aim))).toBeLessThan(0.5);

  // Prepare: Y is up there. A sideways scroll goes round at the same height; a pinch moves the camera in.
  await page.locator("#tabPrepare").click();
  const cam = async () => (await still(page, () => page.locator("#prepare").getAttribute("data-cam"))).split(" ").map(Number) as P;
  const before = await cam();
  await wheel(page, "#prepare", { deltaX: -12 }, 12);
  const round = await cam();
  expect(round[1], "the same height").toBeCloseTo(before[1], 1);
  expect(Math.hypot(round[0] - before[0], round[2] - before[2]), "it went round").toBeGreaterThan(10);
  await wheel(page, "#prepare", { deltaY: -4, ctrlKey: true }, 10);
  const closer = await cam();
  expect(closer[1], "a pinch zooms in, down toward the bed").toBeLessThan(round[1] - 2);
});
