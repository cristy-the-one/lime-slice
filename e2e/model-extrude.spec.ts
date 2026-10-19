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

function depthOf(op: unknown): number {
  const body = op as { depth?: number; kind?: string };
  return typeof body.depth === "number" ? Math.abs(body.depth) : 20;
}

/** A feature root is a box of the extrude's depth. A cut shortens Z by that depth. */
function built(request: Body, parent: MockSolid): MockSolid {
  const op = request.op as { kind?: string; op?: string; depth?: number };
  if (op.kind === "extrude" && op.op === "cut") {
    const box = bounds(parent.positions);
    const height = Math.max(1, box.max[2] - box.min[2] - Math.abs(op.depth ?? 0));
    return boxSolid([box.min[0], box.min[1], box.min[2]], [box.max[0] - box.min[0], box.max[1] - box.min[1], height]);
  }
  return parent;
}

function bounds(positions: number[]): { min: V; max: V } {
  const min: V = [Infinity, Infinity, Infinity];
  const max: V = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis]!;
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

async function start(page: Page): Promise<TreeMock> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => {
      const feature = request.feature as { depth?: number } | undefined;
      const height = feature ? depthOf(feature) : 10;
      return boxSolid([0, 0, 0], [20, 20, height]);
    },
    apply: built,
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelEmptySketch")).toBeVisible();
  return tree;
}

async function drawTypedRectangle(page: Page) {
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=rectangle]").click();
  await expect(canvas).toHaveAttribute("data-sketch-tool", "rectangle");
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill("12");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("8");
  await hud.locator("input").nth(1).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "4");
}

/** A rectangle on the bed, then Extrude with a typed distance. */
async function extrudeOnBed(page: Page, distance: string) {
  await page.locator("#modelEmptySketch").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-plane", "XY");
  await expect(canvas).toHaveAttribute("data-sketch-camera", "locked");
  await expect(page.locator("#modelEmpty")).toBeHidden();
  await drawTypedRectangle(page);
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await expect(canvas).toHaveAttribute("data-extrude-regions", "1");
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").first().fill(distance);
  await hud.locator("input").first().press("Enter");
}

async function height(page: Page): Promise<number> {
  const text = (await page.locator("#model").getAttribute("data-solid")) ?? "";
  const box = text.split(",").map(Number);
  return box[5]! - box[2]!;
}

async function facePoint(page: Page, want: (normal: number[]) => boolean): Promise<{ x: number; y: number }> {
  let found: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    const text = (await page.locator("#model").getAttribute("data-faces")) ?? "";
    const box = await page.locator("#model").boundingBox();
    if (!box) return "";
    for (const item of text.split(" ").filter(Boolean)) {
      const [, xy, normalText] = item.split(":");
      const normal = normalText!.split(",").map(Number);
      if (!want(normal)) continue;
      const [x, y] = xy!.split(",").map(Number);
      const point = { x: box.x + x!, y: box.y + y! };
      if (point.x < box.x || point.y < box.y || point.x > box.x + box.width || point.y > box.y + box.height) continue;
      found = point;
      return "on-screen";
    }
    return "";
  }).toBe("on-screen");
  return found!;
}

/** Drag the extrude arrow until Ctrl snaps the distance near `target`. Release does not apply. */
async function dragExtrude(page: Page, target: number) {
  const canvas = page.locator("#model");
  const read = async () => Number((await canvas.getAttribute("data-extrude-depth")) ?? "NaN");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  const box = (await canvas.boundingBox())!;
  // The cards sit on the top of the view. Start below them; dragging down lowers the distance.
  const at = { x: box.x + box.width / 2, y: box.y + Math.min(box.height - 420, 320) };
  const clamp = (point: { x: number; y: number }) => ({
    x: Math.min(box.x + box.width - 8, Math.max(box.x + 8, point.x)),
    y: Math.min(box.y + box.height - 8, Math.max(box.y + 8, point.y)),
  });
  await page.keyboard.down("Control");
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const probe = clamp({ x: at.x, y: at.y - 90 });
  await page.mouse.move(probe.x, probe.y);
  const probed = await read();
  const went = probed - 10;
  const need = target - 10;
  // The probe moved up. Keep going up when that moved toward the distance; otherwise drag down.
  const dir = Number.isFinite(went) && went !== 0 && Math.sign(went) !== Math.sign(need) ? 1 : -1;
  const seen: string[] = [];
  let best = { ...at, depth: Number.NaN };
  for (let step = 16; step <= 700; step += 16) {
    const next = clamp({ x: at.x, y: at.y + dir * step });
    await page.mouse.move(next.x, next.y);
    const depth = await read();
    if (seen.length < 12) seen.push(`${step}:${depth}`);
    if (!Number.isFinite(depth)) continue;
    if (!Number.isFinite(best.depth) || Math.abs(depth - target) < Math.abs(best.depth - target)) best = { ...next, depth };
    if (Math.abs(depth - target) < 0.05) break;
  }
  await page.mouse.move(best.x, best.y);
  const final = await read();
  expect(final, `extrude drag (${seen.join(" ")})`).toBeCloseTo(target, 0);
  await page.mouse.up();
  await page.keyboard.up("Control");
}

test("a rectangle on the bed extrudes 20 into a new object, and History Edit changes the depth", async ({ page }) => {
  const tree = await start(page);
  await extrudeOnBed(page, "20");
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await expect(page.locator("#objectList .obj").first()).toContainText("Extrude 1");
  await expect(page.locator("#modelHistoryTree")).toContainText("Extrude 1-loop profile 20");
  await expect.poll(() => height(page)).toBeCloseTo(20, 0);
  const opened = tree.of("open");
  expect(opened).toHaveLength(1);
  const feature = opened[0]!.feature as { kind?: string; depth?: number; sketch?: unknown; loops?: unknown };
  expect(feature.kind).toBe("extrude");
  expect(feature.depth).toBe(20);
  expect(feature.loops).toBeTruthy();
  expect(feature.sketch, "the engine open does not carry the sketch").toBeUndefined();

  await page.locator("#modelHistoryTree .mh-edit").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await expect(canvas).toHaveAttribute("data-extrude-depth", "20");
  await expect(canvas).toHaveAttribute("data-extrude-mode", "new");
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").first().fill("12");
  await hud.locator("input").first().press("Enter");
  await expect(page.locator("#modelHistoryTree")).toContainText("Extrude 1-loop profile 12");
  await expect.poll(() => height(page)).toBeCloseTo(12, 0);
  const again = tree.of("open").at(-1)!.feature as { depth?: number; sketch?: unknown };
  expect(again.depth).toBe(12);
  expect(again.sketch).toBeUndefined();
});

test("a rectangle on the top face, pushed in with the mouse, cuts 5", async ({ page }) => {
  const tree = await start(page);
  await extrudeOnBed(page, "20");
  await expect.poll(() => height(page)).toBeCloseTo(20, 0);
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(top.x, top.y);
  await page.locator("#modelContextBar").getByRole("button", { name: "Sketch on face" }).click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-plane", "face 1");
  await expect(canvas).toHaveAttribute("data-sketch-camera", "locked");
  await drawTypedRectangle(page);
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude-mode", /fuse|cut/);
  await dragExtrude(page, -5);
  await expect(canvas).toHaveAttribute("data-extrude-mode", "cut");
  await page.locator("[data-sketch-apply]").click();
  await expect(page.locator("#modelHistoryTree")).toContainText("Cut extrude 1-loop profile 5");
  await expect.poll(() => height(page)).toBeCloseTo(15, 0);
  const applied = tree.of("apply").at(-1)!.op as { kind?: string; op?: string; depth?: number; sketch?: unknown; loops?: unknown };
  expect(applied.kind).toBe("extrude");
  expect(applied.op).toBe("cut");
  expect(applied.depth).toBe(-5);
  expect(applied.loops).toBeTruthy();
  expect(applied.sketch, "the engine apply does not carry the sketch").toBeUndefined();
});
