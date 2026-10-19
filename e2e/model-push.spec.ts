import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

type V = [number, number, number];

/** A box the modeler can draw. Face 0 is −Z, 1 is +Z, 2 is y = 0, 3 is y = 1, 4 is x = 0, 5 is x = 1. */
function boxSolid(min: V = [0, 0, 0], size: V = [20, 20, 20]) {
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
  const area = (face: number) => {
    const q = quads[face]!;
    const u = [q[1]![0] - q[0]![0], q[1]![1] - q[0]![1], q[1]![2] - q[0]![2]];
    const v = [q[3]![0] - q[0]![0], q[3]![1] - q[0]![1], q[3]![2] - q[0]![2]];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    return Math.hypot(...n);
  };
  const faces = quads.map((_, id) => ({ id, areaMm2: area(id) }));
  return { volumeMm3: sx * sy * sz, positions, triangles, faces, edges };
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

/** Grow the parent along the face's outward axis by `distance`. Face 1 is +Z, face 5 is +X. */
function pulled(parent: ReturnType<typeof boxSolid>, face: number, distance: number) {
  const box = bounds(parent.positions);
  const size: V = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const min: V = [...box.min];
  if (face === 1) size[2] += distance;
  else if (face === 0) {
    min[2] -= distance;
    size[2] += distance;
  } else if (face === 5) size[0] += distance;
  else if (face === 4) {
    min[0] -= distance;
    size[0] += distance;
  } else if (face === 3) size[1] += distance;
  else if (face === 2) {
    min[1] -= distance;
    size[1] += distance;
  }
  return boxSolid(min, size);
}

test("dragging a face pulls it, Alt adds a prism, and Tab edits the distance", async ({ page }) => {
  const applied: Record<string, unknown>[] = [];
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, {
    open: () => solid,
    apply: (request, parent) => {
      const op = request.op as { kind?: string; distance?: number; face?: number; faces?: { face: number; distance: number }[] };
      applied.push(op);
      const row = op.kind === "moveFaces" ? op.faces?.[0] : { face: op.face ?? 0, distance: op.distance ?? 0 };
      return pulled(parent as ReturnType<typeof boxSolid>, row?.face ?? 0, row?.distance ?? 0);
    },
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");

  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await dragFace(page, top, 10);
  expect(applied.at(-1)?.kind).toBe("moveFaces");
  await expect(page.locator("#modelHistoryTree")).toContainText("Pull face 10 mm");
  expect(await height(page)).toBeCloseTo(30, 0);

  const side = await facePoint(page, (normal) => normal[0]! > 0.5);
  await dragFace(page, side, 8, true);
  expect(applied.at(-1)?.kind).toBe("faceExtrude");
  await expect.poll(async () => (await extent(page))[0]).toBeGreaterThan(20);

  await page.keyboard.press("Tab");
  const typed = page.locator(".interact-hud input").first();
  await expect(typed).toBeVisible();
  await typed.fill("12");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelHistoryTree")).toContainText("Pull face 12 mm");
  const edited = await extent(page);
  expect(edited[0]).toBeCloseTo(32, 0);
  expect(edited[2]).toBeCloseTo(30, 0);
});

async function facePoint(page: Page, want: (normal: number[]) => boolean): Promise<{ x: number; y: number }> {
  await expect.poll(async () => page.locator("#model").getAttribute("data-faces")).not.toBe("");
  const text = (await page.locator("#model").getAttribute("data-faces")) ?? "";
  const box = (await page.locator("#model").boundingBox())!;
  for (const item of text.split(" ").filter(Boolean)) {
    const [, xy, normalText] = item.split(":");
    const normal = normalText!.split(",").map(Number);
    if (!want(normal)) continue;
    const [x, y] = xy!.split(",").map(Number);
    return { x: box.x + x!, y: box.y + y! };
  }
  throw new Error(`no face in ${text}`);
}

/**
 * Drag from `at` until Ctrl snaps the distance to `target`. The arrow on the hovered face is the
 * outward normal, so the pointer walks that way on screen (and the other way if that pushes).
 */
async function dragFace(page: Page, at: { x: number; y: number }, target: number, alt = false) {
  const canvas = page.locator("#model");
  const read = async () => Number((await canvas.getAttribute("data-pull")) ?? "NaN");
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => canvas.getAttribute("data-handles") ?? "").toContain("pull:");
  const box = (await canvas.boundingBox())!;
  const handles = (await canvas.getAttribute("data-handles")) ?? "";
  const grip = /pull:(-?\d+),(-?\d+)/.exec(handles);
  if (!grip) throw new Error(`no pull arrow in ${handles}`);
  let dx = box.x + Number(grip[1]) - at.x;
  let dy = box.y + Number(grip[2]) - at.y;
  const length = Math.hypot(dx, dy);
  if (length < 2) throw new Error(`the pull arrow has no screen direction from ${at.x},${at.y}`);
  dx /= length;
  dy /= length;
  const place = (step: number) => ({
    x: Math.min(box.x + box.width - 4, Math.max(box.x + 4, at.x + dx * step)),
    y: Math.min(box.y + box.height - 4, Math.max(box.y + 4, at.y + dy * step)),
  });

  await page.keyboard.down("Control");
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.down();
  const probe = place(48);
  await page.mouse.move(probe.x, probe.y);
  const probed = await read();
  if (Number.isFinite(probed) && probed !== 0 && Math.sign(probed) !== Math.sign(target)) {
    dx = -dx;
    dy = -dy;
  }

  const seen: string[] = [];
  let best = { ...at, pull: Number.NaN };
  for (let step = 8; step <= 720; step += 8) {
    const next = place(step);
    await page.mouse.move(next.x, next.y);
    const pull = await read();
    if (seen.length < 16) seen.push(`${step}:${pull}`);
    if (!Number.isFinite(pull)) continue;
    if (!Number.isFinite(best.pull) || Math.abs(pull - target) < Math.abs(best.pull - target)) best = { ...next, pull };
    if (Math.abs(pull - target) < 0.05) break;
  }
  await page.mouse.move(best.x, best.y);
  const final = await read();
  expect(final, `push/pull along the arrow (${seen.join(" ")})`).toBeCloseTo(target, 0);
  await page.mouse.up();
  await page.keyboard.up("Control");
  if (alt) await page.keyboard.up("Alt");
}

async function solidBox(page: Page): Promise<number[]> {
  const text = (await page.locator("#model").getAttribute("data-solid")) ?? "";
  return text.split(",").map(Number);
}

async function height(page: Page): Promise<number> {
  const box = await solidBox(page);
  return box[5]! - box[2]!;
}

async function extent(page: Page): Promise<V> {
  const box = await solidBox(page);
  return [box[3]! - box[0]!, box[4]! - box[1]!, box[5]! - box[2]!];
}
