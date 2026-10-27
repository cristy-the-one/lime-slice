import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const shots = path.resolve("test-results/measure-points");
fs.mkdirSync(shots, { recursive: true });

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

/** Two 20 mm cubes, centred at (90, 100) and (150, 100). The second is added last. */
async function twoCubes(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-closed-groups", "[]");
    localStorage.setItem("lime-slice-theme", "dark");
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await commit(page, "#placeX", 90);
  await commit(page, "#placeY", 100);
  await page.locator("#plateAddFile").setInputFiles("samples/calibration_cube_20mm.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await commit(page, "#placeX", 150);
  await commit(page, "#placeY", 100);
  await page.locator("#viewPresets button").nth(0).click();
  await page.waitForTimeout(1200);
  const box = (await page.locator("#prepare").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, 300);
  await page.waitForTimeout(800);
}

type Rect = { x: number; y: number; w: number; h: number };

/** Where a grey object's box is on the page, once the camera has stopped. */
async function greyRect(page: Page, id: string): Promise<Rect> {
  const canvas = page.locator("#prepare");
  const read = async () => {
    const raw = (await canvas.getAttribute("data-plate-context-screen")) ?? "";
    const entry = raw.split(" ").find((item) => item.startsWith(`${id}:`));
    return entry ? entry.split(":")[1]!.split(",").map(Number) : null;
  };
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await read());
    const same = now === last && now !== "null";
    last = now;
    return same;
  }).toBe(true);
  const [x, y, w, h] = (await read())!;
  const box = (await canvas.boundingBox())!;
  return { x: box.x + x!, y: box.y + y!, w: w!, h: h! };
}

const snapOf = (page: Page) => page.locator("#prepare").getAttribute("data-measure-snap");

/**
 * The Top preset looks down the bed's diagonal, so a cube is a diamond and its left and right corners are the middles of
 * the box's left and right sides on the page. Walk in from one of them until the pointer is on a vertex, or give up.
 */
async function hoverVertex(page: Page, r: Rect, side: "left" | "right"): Promise<string> {
  const inward = side === "left" ? 1 : -1;
  const ox = side === "left" ? r.x : r.x + r.w;
  const oy = r.y + r.h / 2;
  for (const dx of [4, 8, 12, 16, 22, 28]) {
    for (const dy of [0, -5, 5, -10, 10]) {
      await page.mouse.move(ox + inward * dx, oy + dy, { steps: 2 });
      const snap = (await snapOf(page)) ?? "";
      if (snap.startsWith("vertex:")) return snap;
    }
  }
  return (await snapOf(page)) ?? "";
}

const points = async (page: Page) => {
  const raw = (await page.locator("#prepare").getAttribute("data-point-measure")) ?? "";
  return raw ? raw.split("|").map((p) => p.split(",").map(Number)) : [];
};

/** The first cube is selected, the second is grey; both boxes' places on the page are read before Measure turns on. */
async function ready(page: Page) {
  await twoCubes(page);
  const second = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  await page.locator("[data-plate-select='part']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");
  const rect2 = await greyRect(page, second);
  await page.locator(`[data-plate-select='${second}']`).click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", second);
  const rect1 = await greyRect(page, "part");
  await page.locator("[data-plate-select='part']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");
  return { rect1, rect2, second };
}

test("two clicks snap to a vertex of each object, and the readout is the exact distance between them", async ({ page }) => {
  const { rect1, rect2 } = await ready(page);
  await page.locator("#measurePoints").click();
  await expect(page.locator("#measurePoints")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#pointMeasureReadout")).toContainText("Click a point");

  expect(await hoverVertex(page, rect1, "right"), "hovering the first cube reaches a vertex").toMatch(/^vertex:/);
  await expect(page.locator(".pm-hover span")).toContainText("Vertex");
  await page.mouse.down();
  await page.mouse.up();
  expect((await points(page)).length).toBe(1);
  await expect(page.locator("#pointMeasureReadout")).toContainText("second point");

  expect(await hoverVertex(page, rect2, "left"), "hovering the second cube reaches a vertex").toMatch(/^vertex:/);
  await page.screenshot({ path: path.join(shots, "measure-points-hover.png") });
  await page.mouse.down();
  await page.mouse.up();

  const [a, b] = await points(page);
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  // The first cube spans X 80..100, Y 90..110, Z 0..20; the second X 140..160.
  expect([80, 100]).toContain(Math.round(a![0]!));
  expect([90, 110]).toContain(Math.round(a![1]!));
  expect([0, 20]).toContain(Math.round(a![2]!));
  expect([140, 160]).toContain(Math.round(b![0]!));
  expect([90, 110]).toContain(Math.round(b![1]!));
  expect([0, 20]).toContain(Math.round(b![2]!));

  const d = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!];
  const exact = Math.hypot(d[0]!, d[1]!, d[2]!);
  const shown = (n: number) => String(Object.is(Math.round(n * 100) / 100, -0) ? 0 : Math.round(n * 100) / 100);
  const text = (await page.locator("#pointMeasureReadout").textContent()) ?? "";
  expect(text).toContain(`Distance ${shown(exact)} mm`);
  expect(text).toContain(`ΔX ${shown(d[0]!)}`);
  expect(text).toContain(`ΔY ${shown(d[1]!)}`);
  expect(text).toContain(`ΔZ ${shown(d[2]!)}`);
  expect(text).toMatch(/A: Vertex · /);
  expect(text).toMatch(/B: Vertex · /);
  await page.screenshot({ path: path.join(shots, "measure-points-between-cubes.png") });

  // Esc clears the pair; Measure moved nothing.
  await page.keyboard.press("Escape");
  expect(await points(page)).toEqual([]);
  expect(Number(await page.locator("#placeX").inputValue())).toBe(90);
});

test("a third click starts a new measurement", async ({ page }) => {
  const { rect1, rect2 } = await ready(page);
  await page.locator("#measurePoints").click();
  await hoverVertex(page, rect1, "right");
  await page.mouse.down();
  await page.mouse.up();
  await hoverVertex(page, rect2, "left");
  await page.mouse.down();
  await page.mouse.up();
  expect((await points(page)).length).toBe(2);
  await hoverVertex(page, rect1, "right");
  await page.mouse.down();
  await page.mouse.up();
  expect((await points(page)).length).toBe(1);
});

test("Alt turns the snap off, and the point lands on the surface", async ({ page }) => {
  const { rect1 } = await ready(page);
  await page.locator("#measurePoints").click();
  await page.keyboard.down("Alt");
  await page.mouse.move(rect1.x + rect1.w / 2, rect1.y + rect1.h / 2, { steps: 4 });
  expect(await snapOf(page)).toBeNull();
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const [a] = await points(page);
  expect(a![2]).toBeCloseTo(20, 1);
  expect(a![0]).toBeGreaterThan(80);
  expect(a![0]).toBeLessThan(100);
});

test("a drag still orbits while Measure is on, and places no point", async ({ page }) => {
  const { rect1 } = await ready(page);
  await page.locator("#measurePoints").click();
  const cam = () => page.locator("#prepare").getAttribute("data-cam");
  const before = await cam();
  await page.mouse.move(rect1.x + rect1.w / 2, rect1.y + rect1.h / 2);
  await page.mouse.down();
  await page.mouse.move(rect1.x + rect1.w / 2 + 90, rect1.y + rect1.h / 2 - 20, { steps: 8 });
  await page.mouse.up();
  await expect.poll(cam).not.toBe(before);
  expect(await points(page)).toEqual([]);
  expect(Number(await page.locator("#placeX").inputValue())).toBe(90);
});

test("Measure rests when a gizmo tool is picked, and again in another stage", async ({ page }) => {
  await ready(page);
  await page.locator("#measurePoints").click();
  await expect(page.locator("#measurePoints")).toHaveAttribute("aria-pressed", "true");
  await page.locator('#toolRail [data-tool="move"]').click();
  await expect(page.locator("#measurePoints")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#pointMeasureReadout")).toBeHidden();
  await page.locator("#measurePoints").click();
  await page.locator("#tabModel").click();
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#measurePoints")).toHaveAttribute("aria-pressed", "false");
});
