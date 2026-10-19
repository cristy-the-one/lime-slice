import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A box the modeler can pick. Face 0 is −Z, face 1 is +Z. */
function boxSolid(min: V = [0, 0, 0], size: V = [20, 20, 20]): MockSolid {
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
  const faces = quads.map((_, id) => ({ id, areaMm2: (id < 2 ? sx * sy : id < 4 ? sx * sz : sy * sz) }));
  return { volumeMm3: sx * sy * sz, positions, triangles, faces, edges };
}

async function start(page: Page): Promise<TreeMock> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => boxSolid([0, 0, 0], [20, 20, 20]),
    apply: (_request: Body, parent: MockSolid) => parent,
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelEmptySketch")).toBeVisible();
  return tree;
}

async function drawRectangle(page: Page, at: { x: number; y: number }, width: string, height: string, fromCentre: boolean) {
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=rectangle]").click();
  await expect(canvas).toHaveAttribute("data-sketch-tool", "rectangle");
  if (fromCentre) await page.keyboard.down("Control");
  await page.mouse.click(at.x, at.y);
  if (fromCentre) await page.keyboard.up("Control");
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill(width);
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill(height);
  await hud.locator("input").nth(1).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "4");
}

test("a rectangle off the axis revolves, the ring drag sets the angle, and History Edit reopens it", async ({ page }) => {
  const tree = await start(page);
  const tools = page.locator(".model-tools");
  expect(await tools.evaluate((bar) => bar.scrollWidth <= bar.clientWidth), "the toolbar fits at 1440").toBe(true);
  await expect(page.locator("#modelToolRevolve")).toHaveCount(0);

  await page.locator("#modelEmptySketch").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  const box = (await canvas.boundingBox())!;
  await drawRectangle(page, { x: box.x + box.width * 0.62, y: box.y + box.height * 0.45 }, "10", "6", false);
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.55);
  await page.keyboard.press("V");
  await expect(canvas).toHaveAttribute("data-revolve", "aim");
  await expect(canvas).toHaveAttribute("data-revolve-axis", "v");
  await expect(canvas).toHaveAttribute("data-revolve-cross", "0");
  await expect(canvas).toHaveAttribute("data-revolve-regions", "1");
  await expect(canvas).toHaveAttribute("data-revolve-angle", "360");
  await expect(canvas).toHaveAttribute("data-revolve-mode", "new");
  expect(await tools.evaluate((bar) => bar.scrollWidth <= bar.clientWidth), "revolve adds no toolbar button").toBe(true);

  const read = async () => Number((await canvas.getAttribute("data-revolve-angle")) ?? "NaN");
  const at = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.55 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x - 40, at.y);
  await expect.poll(read).toBeLessThan(360);
  await page.mouse.up();
  await expect(canvas).toHaveAttribute("data-revolve", "aim");

  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").first().fill("360");
  await expect(canvas).toHaveAttribute("data-revolve-angle", "360");
  await hud.locator("input").first().fill("90");
  await hud.locator("input").first().press("Enter");

  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await expect(page.locator("#objectList .obj").first()).toContainText("Revolve 1");
  await expect(page.locator("#modelHistoryTree")).toContainText("Revolve 1-loop profile 90°");
  const opened = tree.of("open");
  expect(opened).toHaveLength(1);
  const feature = opened[0]!.feature as {
    kind?: string;
    angleDeg?: number;
    axisOrigin?: number[];
    axisDir?: number[];
    loops?: unknown;
    sketch?: unknown;
  };
  expect(feature.kind).toBe("revolve");
  expect(feature.angleDeg).toBe(90);
  expect(feature.axisOrigin).toEqual([0, 0]);
  expect(feature.axisDir).toEqual([0, 1]);
  expect(feature.loops).toBeTruthy();
  expect(feature.sketch, "the engine open does not carry the sketch").toBeUndefined();

  await page.locator("#modelHistoryTree .mh-edit").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-revolve", "aim");
  await expect(canvas).toHaveAttribute("data-revolve-angle", "90");
  await expect(canvas).toHaveAttribute("data-revolve-mode", "new");
  await expect(canvas).toHaveAttribute("data-revolve-axis", "v");
  const again = page.locator(".interact-hud:not([hidden])");
  await again.locator("input").first().fill("45");
  await again.locator("input").first().press("Enter");
  await expect(canvas).toHaveAttribute("data-revolve", "off");
  await expect(page.locator("#modelHistoryTree")).toContainText("Revolve 1-loop profile 45°");
  await expect.poll(() => tree.of("open").length).toBe(2);
  const edited = tree.of("open").at(-1)!.feature as { angleDeg?: number; sketch?: unknown };
  expect(edited.angleDeg).toBe(45);
  expect(edited.sketch).toBeUndefined();
});

test("a region that crosses the axis is refused and the sketch stays open", async ({ page }) => {
  await start(page);
  await page.locator("#modelEmptySketch").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  const box = (await canvas.boundingBox())!;
  await drawRectangle(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, "12", "8", true);
  await page.keyboard.press("V");
  await expect(canvas).toHaveAttribute("data-revolve", "aim");
  await expect(canvas).toHaveAttribute("data-revolve-cross", "1");
  await page.locator("[data-sketch-apply]").click();
  await expect(page.locator("#modelReadout")).toContainText("The profile crosses the revolve axis. Keep it on one side.");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-revolve", "aim");
  await expect(page.locator("#objectList .obj")).toHaveCount(0);
});
