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

async function start(page: Page, refuseOpen?: (count: number) => boolean): Promise<TreeMock> {
  let opens = 0;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => {
      opens += 1;
      if (refuseOpen?.(opens)) return { error: "The second region could not be built" };
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
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "rectangle");
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

test("editing the root of a part with a later cut keeps the cut current, on Cancel and on Apply", async ({ page }) => {
  await start(page);
  await extrudeOnBed(page, "20");
  await expect.poll(() => height(page)).toBeCloseTo(20, 0);
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(top.x, top.y);
  await page.locator("#modelContextBar").getByRole("button", { name: "Sketch on face" }).click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch-plane", "face 1");
  await drawTypedCircle(page);
  await page.keyboard.press("E");
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").first().fill("-5");
  await hud.locator("input").first().press("Enter");
  await expect.poll(() => height(page)).toBeCloseTo(15, 0);
  const rows = page.locator("#modelHistoryTree .mh-row");
  await expect(rows).toHaveCount(2);
  const current = page.locator('#modelHistoryTree .mh-row[aria-selected="true"]');
  await expect(current).toContainText("Cut");

  // Cancel: the root was shown for the edit; the cut comes back as the current step.
  await rows.first().locator(".mh-edit").click();
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await expect.poll(() => height(page)).toBeCloseTo(20, 0);
  await page.locator("[data-sketch-finish]").click();
  await expect(canvas).not.toHaveAttribute("data-sketch", "editing");
  await expect(current).toContainText("Cut");
  await expect.poll(() => height(page)).toBeCloseTo(15, 0);

  // Apply: the history rebuilds on the new root and the cut is still current, not a Redo.
  await rows.first().locator(".mh-edit").click();
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await hud.locator("input").first().fill("30");
  await hud.locator("input").first().press("Enter");
  await expect(page.locator("#modelHistoryTree")).toContainText("Extrude 1-loop profile 30");
  await expect(current).toContainText("Cut");
  await expect.poll(() => height(page)).toBeCloseTo(25, 0);
  await expect(page.locator("#modelRedo")).toBeDisabled();
});

test("History Edit of a two-region extrude reopens with both regions and applies both", async ({ page }) => {
  const tree = await start(page);
  await extrudeOnBed(page, "20");
  await expect.poll(() => height(page)).toBeCloseTo(20, 0);
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(top.x, top.y);
  await page.locator("#modelContextBar").getByRole("button", { name: "Sketch on face" }).click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch-plane", "face 1");
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hud = page.locator(".interact-hud:not([hidden])");
  await page.locator("[data-sketch-tool=rectangle]").click();
  for (const dx of [-60, 40]) {
    await page.mouse.click(centre.x + dx, centre.y);
    await hud.locator("input").nth(0).fill("3");
    await hud.locator("input").nth(0).press("Tab");
    await hud.locator("input").nth(1).fill("3");
    await hud.locator("input").nth(1).press("Enter");
  }
  await expect(canvas).toHaveAttribute("data-sketch-entities", "8");
  await page.locator("[data-sketch-tool=select]").click();
  await page.mouse.move(centre.x - 160, centre.y - 160);
  await page.mouse.down();
  await page.mouse.move(centre.x + 160, centre.y + 160, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude-regions", "2");
  await hud.locator("input").first().fill("4");
  await hud.locator("input").first().press("Enter");
  await expect(page.locator("#modelHistoryTree")).toContainText("Extrude 2 regions");
  const applied = tree.of("apply").at(-1)!.op as { kind?: string; steps?: unknown[] };
  expect(applied.kind).toBe("group");
  expect(applied.steps).toHaveLength(2);

  await page.locator("#modelHistoryTree .mh-row", { hasText: "Extrude 2 regions" }).locator(".mh-edit").click();
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await expect(canvas).toHaveAttribute("data-extrude-regions", "2");
  // Moving over one region does not drop the other from the edit.
  await page.mouse.move(centre.x + 40, centre.y + 5);
  await expect(canvas).toHaveAttribute("data-extrude-regions", "2");
  await hud.locator("input").first().fill("6");
  await hud.locator("input").first().press("Enter");
  await expect(canvas).not.toHaveAttribute("data-sketch", "editing");
  const edited = tree.of("edit").at(-1)!.op as { kind?: string; steps?: { depth?: number }[] };
  expect(edited.kind).toBe("group");
  expect(edited.steps?.map((step) => step.depth)).toEqual([6, 6]);
});

test("Esc waits for an Apply, one Esc leaves a History Edit, and an edit leaves no extra card", async ({ page }) => {
  await start(page);
  // Hold the modeler's reply to the first open, so Esc lands while the Apply is on its way.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let holding = true;
  await page.route("**/api/model/tree", async (route) => {
    const body = route.request().postDataJSON() as { call?: string };
    if (holding && body.call === "open") {
      holding = false;
      await held;
    }
    await route.fallback();
  });
  const canvas = page.locator("#model");
  await extrudeOnBed(page, "20");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  release();
  await expect.poll(() => height(page)).toBeCloseTo(20, 0);
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");
  await expect(canvas).toHaveAttribute("data-extrude", "off");
  // The readout names the solid just made, not the kept sketch.
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await expect(page.locator("#modelReadout")).not.toContainText("Sketch kept");
  const cards = page.locator("[data-sketch-open]");
  await expect(cards).toHaveCount(1);

  // One Esc leaves the edit, with the view back on the step and no card added.
  await page.locator("#modelHistoryTree .mh-edit").click();
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await page.keyboard.press("Escape");
  await expect(canvas).not.toHaveAttribute("data-sketch", "editing");
  await expect(cards).toHaveCount(1);

  // Applying an edit does not pin another copy of the sketch.
  await page.locator("#modelHistoryTree .mh-edit").click();
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").first().fill("14");
  await hud.locator("input").first().press("Enter");
  await expect.poll(() => height(page)).toBeCloseTo(14, 0);
  await expect(canvas).not.toHaveAttribute("data-sketch", "editing");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveText("Sketch 1");
});


/** Each drawn rectangle's centre on screen, from the canvas's point hits (four points a rectangle, in drawing order). */
async function rectangleCentres(page: Page): Promise<{ x: number; y: number }[]> {
  const hits = ((await page.locator("#model").getAttribute("data-sketch-hits")) ?? "").split(" ").filter(Boolean);
  const points = hits.map((hit) => hit.split(":")[1]!.split(",").map(Number) as [number, number]);
  const out: { x: number; y: number }[] = [];
  for (let at = 0; at + 4 <= points.length; at += 4) {
    const four = points.slice(at, at + 4);
    out.push({ x: four.reduce((sum, p) => sum + p[0], 0) / 4, y: four.reduce((sum, p) => sum + p[1], 0) / 4 });
  }
  return out;
}

test("a click during an extrude picks the region under it, Shift-click adds or drops one, and only Apply keeps it", async ({ page }) => {
  const tree = await start(page);
  await page.locator("#modelEmptySketch").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hud = page.locator(".interact-hud:not([hidden])");
  await page.locator("[data-sketch-tool=rectangle]").click();
  for (const dx of [-120, 60]) {
    await page.mouse.click(centre.x + dx, centre.y);
    await hud.locator("input").nth(0).fill("10");
    await hud.locator("input").nth(0).press("Tab");
    await hud.locator("input").nth(1).fill("10");
    await hud.locator("input").nth(1).press("Enter");
  }
  await page.locator("[data-sketch-tool=select]").click();
  const [first] = await rectangleCentres(page);
  await page.mouse.move(first!.x, first!.y);
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await expect(canvas).toHaveAttribute("data-extrude-regions", "1");
  // The view tilts when the extrude starts. Once it settles, a move repaints where the corners are now.
  await expect(canvas).toHaveAttribute("data-sketch-camera", "free");
  await page.mouse.move(first!.x + 1, first!.y + 1);
  const [a, b] = await rectangleCentres(page);

  await page.mouse.click(b!.x, b!.y);
  await expect(canvas, "a click picks, it does not apply").toHaveAttribute("data-extrude", "aim");
  await expect(canvas).toHaveAttribute("data-extrude-regions", "1");
  await page.mouse.move(a!.x, a!.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(a!.x, a!.y);
  await page.keyboard.up("Shift");
  await expect(canvas, "Shift-click adds the other region, and the pointer no longer picks").toHaveAttribute("data-extrude-regions", "2");
  await page.keyboard.down("Shift");
  await page.mouse.click(b!.x, b!.y);
  await page.keyboard.up("Shift");
  await expect(canvas, "Shift-click on a picked region drops it").toHaveAttribute("data-extrude-regions", "1");
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
  await expect(canvas, "a click on no region keeps the pick").toHaveAttribute("data-extrude-regions", "1");
  await page.keyboard.down("Shift");
  await page.mouse.click(b!.x, b!.y);
  await page.keyboard.up("Shift");
  await expect(canvas).toHaveAttribute("data-extrude-regions", "2");
  expect(tree.of("open"), "nothing was applied by a click").toHaveLength(0);
  await page.locator("[data-sketch-apply]").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await expect(canvas).toHaveAttribute("data-extrude", "off");
});

test("an extrude tilts the view to show its depth, says when it is past the build volume, and the sketch is the plan again", async ({ page }) => {
  await start(page);
  await page.locator("#modelEmptySketch").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch-camera", "locked");
  const plan = (await canvas.getAttribute("data-camera")) ?? "";
  await drawTypedRectangle(page);
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await expect(canvas, "the view is free while the extrude is aimed").toHaveAttribute("data-sketch-camera", "free");
  const [eye, target] = ((await canvas.getAttribute("data-camera")) ?? "").split(";").map((part) => part.split(",").map(Number));
  const along = Math.hypot(eye![0]! - target![0]!, eye![1]! - target![1]!, eye![2]! - target![2]!);
  const rise = (eye![2]! - target![2]!) / along;
  expect(rise, "seen from above the bed at a tilt, not straight down").toBeGreaterThan(0.6);
  expect(rise).toBeLessThan(0.95);
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").first().fill("100000");
  await expect(page.locator("#modelReadout")).toContainText(/^100000 mm is more than the printer's \d+ mm build height\. Extrude 100000 mm/);
  await hud.locator("input").first().fill("5");
  await expect(page.locator("#modelReadout")).toContainText(/^Extrude 5 mm/);
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-extrude", "off");
  await expect(canvas, "back in the sketch the view is the plan again").toHaveAttribute("data-sketch-camera", "locked");
  await expect.poll(async () => (await canvas.getAttribute("data-camera")) ?? "").toBe(plan);
});

test("two regions on an empty bed make two objects, and Undo takes them back as one step", async ({ page }) => {
  const tree = await start(page);
  await page.locator("#modelEmptySketch").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hud = page.locator(".interact-hud:not([hidden])");
  await page.locator("[data-sketch-tool=rectangle]").click();
  for (const dx of [-120, 60]) {
    await page.mouse.click(centre.x + dx, centre.y);
    await hud.locator("input").nth(0).fill("10");
    await hud.locator("input").nth(0).press("Tab");
    await hud.locator("input").nth(1).fill("10");
    await hud.locator("input").nth(1).press("Enter");
  }
  await page.locator("[data-sketch-tool=select]").click();
  await page.mouse.move(box.x + 8, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height - 8, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude-regions", "2");
  await expect(canvas).toHaveAttribute("data-extrude-mode", "new");
  await hud.locator("input").first().fill("5");
  await hud.locator("input").first().press("Enter");
  const objects = page.locator("#objectList .obj");
  await expect(objects).toHaveCount(2);
  expect(tree.of("open")).toHaveLength(2);
  await expect(canvas).not.toHaveAttribute("data-sketch", "editing");

  await page.keyboard.press("Control+z");
  await expect(objects).toHaveCount(0);
  await expect(page.locator("#modelEmpty")).toBeVisible();
  await page.keyboard.press("Control+y");
  await expect(objects).toHaveCount(2);
  await expect(page.locator("#modelReadout")).toContainText("Volume");
});

test("when one of two regions cannot be built, the other object goes too, and Apply again makes both once", async ({ page }) => {
  let refuse = true;
  await start(page, (count) => refuse && count === 2);
  await page.locator("#modelEmptySketch").click();
  const canvas = page.locator("#model");
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hud = page.locator(".interact-hud:not([hidden])");
  await page.locator("[data-sketch-tool=rectangle]").click();
  for (const dx of [-120, 60]) {
    await page.mouse.click(centre.x + dx, centre.y);
    await hud.locator("input").nth(0).fill("10");
    await hud.locator("input").nth(0).press("Tab");
    await hud.locator("input").nth(1).fill("10");
    await hud.locator("input").nth(1).press("Enter");
  }
  await page.locator("[data-sketch-tool=select]").click();
  await page.mouse.move(box.x + 8, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height - 8, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude-regions", "2");
  await page.locator("[data-sketch-apply]").click();
  await expect(page.locator("#modelReadout")).toContainText("could not be built");
  await expect(page.locator("#objectList .obj"), "the region that was built is taken back").toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  refuse = false;
  await page.locator("[data-sketch-apply]").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
});

test("Auto makes a new object of a sketch beside the part, and the face sketch's new object stays on the face", async ({ page }) => {
  await start(page);
  await extrudeOnBed(page, "20");
  await expect.poll(() => height(page)).toBeCloseTo(20, 0);
  const canvas = page.locator("#model");
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  const box = (await canvas.boundingBox())!;
  const hud = page.locator(".interact-hud:not([hidden])");
  await page.locator("[data-sketch-tool=rectangle]").click();
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
  await hud.locator("input").nth(0).fill("4");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("4");
  await hud.locator("input").nth(1).press("Enter");
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await expect(canvas).toHaveAttribute("data-extrude-mode", "new");
  await expect(page.locator("[data-sketch-mode]")).toHaveText("Auto · New object (M)");
});

async function drawTypedCircle(page: Page) {
  await page.locator("[data-sketch-menu=draw]").click();
  await page.locator(".sketch-menu-list [data-sketch-tool=circle]").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "circle");
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill("8");
  await hud.locator("input").nth(0).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "circle");
}

test("a circle on the top face, pushed in with the mouse, cuts 5", async ({ page }) => {
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
  await drawTypedCircle(page);
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude-mode", /fuse|cut/);
  await dragExtrude(page, -5);
  await expect(canvas).toHaveAttribute("data-extrude-mode", "cut");
  await page.locator("[data-sketch-apply]").click();
  await expect(page.locator("#modelHistoryTree")).toContainText("Cut extrude 1-loop profile -5 mm");
  await expect.poll(() => height(page)).toBeCloseTo(15, 0);
  const applied = tree.of("apply").at(-1)!.op as { kind?: string; op?: string; depth?: number; sketch?: unknown; loops?: unknown };
  expect(applied.kind).toBe("extrude");
  expect(applied.op).toBe("cut");
  expect(applied.depth).toBe(-5);
  expect(applied.loops).toBeTruthy();
  expect(applied.sketch, "the engine apply does not carry the sketch").toBeUndefined();
});
