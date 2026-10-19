import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 x 20 x 10 mm box, as the modeler reports it. */
function boxSolid(): MockSolid {
  const min: V = [0, 0, 0];
  const size: V = [20, 20, 10];
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
  return { volumeMm3: 4000, positions, triangles, faces, edges };
}

async function openBox(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions } }));
  await mockModelTree(page, { open: () => boxSolid() });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelEmptySketch")).toBeVisible();
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await expect(page.locator("#modelToolPull")).toBeVisible();
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

test("a sketch draws a line and a rectangle, then pins", async ({ page }) => {
  await openBox(page);
  const canvas = page.locator("#model");
  await page.locator("#modelToolSketch").click();
  await expect(canvas).toHaveAttribute("data-sketch", "choosing");
  await expect(page.locator("#modelReadout")).toContainText("origin plane");
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-tool", "line");
  await expect(canvas).toHaveAttribute("data-sketch-plane", "XY");
  await expect(canvas).toHaveAttribute("data-sketch-camera", "locked");
  const camera = (await canvas.getAttribute("data-camera")) ?? "";
  const [eye, target] = camera.split(";");
  const pz = Number(eye?.split(",")[2]);
  const tz = Number(target?.split(",")[2]);
  expect(pz).toBeGreaterThan(tz);

  const box = (await canvas.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(start.x, start.y);
  await page.mouse.click(start.x + 140, start.y - 40);
  await expect(canvas).toHaveAttribute("data-sketch-entities", "1");
  await page.keyboard.press("Escape");

  const hud = page.locator(".interact-hud:not([hidden])");
  await page.mouse.click(start.x - 30, start.y + 20);
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill("25");
  await hud.locator("input").nth(0).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "2");

  await page.locator("[data-sketch-tool=rectangle]").click();
  await expect(canvas).toHaveAttribute("data-sketch-tool", "rectangle");
  await page.mouse.click(start.x, start.y);
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill("12");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("5");
  await hud.locator("input").nth(1).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "6");

  await page.keyboard.press("Control+z");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "2");
  await expect(page.locator("#modelBar")).not.toHaveAttribute("data-tool", "fillet");

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");
  await expect(page.locator("[data-sketch-open]")).toHaveText("Sketch 1");
  await page.locator("[data-sketch-discard]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "off");
  await expect(page.locator("#modelToolPull")).toBeVisible();
});

test("drawing tools stay in the sketch card and take a typed size", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBox(page);
  const canvas = page.locator("#model");
  const fits = () => page.locator(".model-tools").evaluate((bar) => bar.scrollWidth <= bar.clientWidth);
  expect(await fits(), "the toolbar fits before the sketch opens").toBe(true);
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  expect(await fits(), "drawing tools are not on the Model toolbar").toBe(true);
  await expect(page.locator("#modelBar")).not.toHaveAttribute("data-tool", /.+/);

  await page.locator("[data-sketch-menu=draw]").click();
  await expect(page.locator(".sketch-menu-list")).toBeVisible();
  for (const label of ["Circle", "Arc", "Polygon", "Slot", "Spline", "Trim", "Offset", "Fillet corner", "Construction", "Use"]) {
    await expect(page.locator(`.sketch-menu-list [data-sketch-tool]`, { hasText: label })).toBeVisible();
  }
  await page.locator(".sketch-menu-list [data-sketch-tool=circle]").click();
  await expect(canvas).toHaveAttribute("data-sketch-tool", "circle");
  await expect(page.locator("#modelReadout")).toContainText("Type a diameter");

  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(centre.x, centre.y);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill("20");
  await hud.locator("input").nth(0).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "1");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "circle");

  await page.keyboard.press("N");
  await expect(canvas).toHaveAttribute("data-sketch-tool", "polygon");
  await expect(page.locator("#modelReadout")).toContainText("across corners");
  await page.mouse.click(centre.x, centre.y);
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill("20");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(2).fill("4");
  await hud.locator("input").nth(2).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "circle,line,line,line,line");

  await page.keyboard.press("T");
  await expect(page.locator("#modelReadout")).toContainText("Trim");
  await page.keyboard.press("F");
  await expect(canvas).toHaveAttribute("data-sketch-tool", "offset");
  await page.keyboard.press("G");
  await expect(page.locator("#modelReadout")).toContainText("Fillet corner");
  await page.keyboard.press("U");
  await expect(page.locator("#modelReadout")).toContainText("faint edge");
  await page.keyboard.press("X");
  await expect(canvas).toHaveAttribute("data-sketch-tool", "construction");
  expect(await fits(), "the toolbar still fits at 1440 px while a sketch is open").toBe(true);
  await expect(page.locator("#modelBar")).not.toHaveAttribute("data-tool", /.+/);
});
