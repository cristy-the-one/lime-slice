import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

type V = [number, number, number];

/** A box the modeler can draw, with the kernel's planar normals. Face 0 is −Z, 1 is +Z, 2 is y = 0, 3 is y = 1, 4 is x = 0, 5 is x = 1. */
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
  // The kernel sends a normal for every planar face.
  const normals: V[] = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];
  const faces = quads.map((_, id) => ({ id, areaMm2: area(id), normal: normals[id]! }));
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
  await page.keyboard.type("12");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelHistoryTree")).toContainText("Extrude face 12 mm");
  const edited = await extent(page);
  expect(edited[0]).toBeCloseTo(32, 0);
  expect(edited[2]).toBeCloseTo(30, 0);
});

async function facePoint(page: Page, want: (normal: number[]) => boolean): Promise<{ x: number; y: number }> {
  // The list is cleared for a frame while a dry-run replaces the solid, so the point is taken from the same read.
  let found: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    const text = (await page.locator("#model").getAttribute("data-faces")) ?? "";
    const box = await page.locator("#model").boundingBox();
    if (!box || text === "") return "";
    for (const item of text.split(" ").filter(Boolean)) {
      const [, xy, normalText] = item.split(":");
      const normal = normalText!.split(",").map(Number);
      if (!want(normal)) continue;
      const [x, y] = xy!.split(",").map(Number);
      found = { x: box.x + x!, y: box.y + y! };
      return text;
    }
    return "";
  }).not.toBe("");
  if (!found) throw new Error("no face");
  return found;
}

/**
 * Drag from `at` until Ctrl snaps the distance to `target`. The arrow on the hovered face is the
 * outward normal, so the pointer walks that way on screen (and the other way if that pushes).
 */
async function dragFace(page: Page, at: { x: number; y: number }, target: number, alt = false) {
  const canvas = page.locator("#model");
  const read = async () => Number((await canvas.getAttribute("data-pull")) ?? "NaN");
  let nudge = 0;
  // A hover that lands while the solid is being replaced is redrawn on the next move, so each try moves a pixel.
  await expect.poll(async () => {
    nudge = (nudge + 1) % 3;
    await page.mouse.move(at.x + nudge, at.y);
    return canvas.getAttribute("data-handles") ?? "";
  }).toContain("pull:");
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

/** A box on a mocked engine. Each Apply grows it by the pulled distance. */
async function openPushBox(page: Page) {
  const applied: { kind?: string; faces?: { face: number; distance: number }[]; face?: number; distance?: number }[] = [];
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  const tree = await mockModelTree(page, {
    open: () => solid,
    apply: (request, parent) => {
      const op = request.op as { kind?: string; faces?: { face: number; distance: number }[]; face?: number; distance?: number };
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
  return { applied, tree };
}

test("a typed distance replaces the live one, with Ctrl held through the drag, and Esc cancels with Ctrl held", async ({ page }) => {
  const { applied } = await openPushBox(page);
  const hud = page.locator(".interact-hud input").first();

  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await pressAndPull(page, top, 40);
  await expect(hud).toBeVisible();
  await expect(hud).not.toHaveValue("0");
  await page.keyboard.type("7");
  await expect(hud, "the first key replaces the live distance").toHaveValue("7");
  await page.keyboard.press("Enter");
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(page.locator("#modelHistoryTree")).toContainText("Pull face 7 mm");
  expect(applied.at(-1)?.faces?.[0]?.distance).toBe(7);

  await page.keyboard.press("Tab");
  await expect(hud).toHaveValue("7");
  await page.keyboard.type("4");
  await expect(hud, "a Tab edit starts from an empty box too").toHaveValue("4");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelHistoryTree")).toContainText("Pull face 4 mm");
  expect(applied.at(-1)?.faces?.[0]?.distance).toBe(4);
  // History names the step before the view has the rebuilt solid: the top's point is read off the new one.
  await expect.poll(async () => height(page)).toBeCloseTo(24, 0);

  const count = applied.length;
  const again = await facePoint(page, (normal) => normal[2]! > 0.5);
  await pressAndPull(page, again, 40);
  await expect(hud).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hud, "Esc closes the box with Ctrl still down").toBeHidden();
  await page.mouse.up();
  await page.keyboard.up("Control");
  await page.waitForTimeout(300);
  expect(applied, "a cancelled drag applies nothing").toHaveLength(count);
});

/** Press a face with Ctrl held and move `px` along its arrow. The button and Ctrl stay down. */
async function pressAndPull(page: Page, at: { x: number; y: number }, px: number) {
  const canvas = page.locator("#model");
  // Leave whatever the pointer lit last (an edge knob from the step before), then come back to the face.
  const frame = (await canvas.boundingBox())!;
  await page.mouse.move(frame.x + 4, frame.y + 4);
  let nudge = 0;
  // A hover that lands while the solid is being replaced is redrawn on the next move, so each try moves a pixel.
  await expect.poll(async () => {
    nudge = (nudge + 1) % 3;
    await page.mouse.move(at.x + nudge, at.y);
    return canvas.getAttribute("data-handles") ?? "";
  }).toContain("pull:");
  const box = (await canvas.boundingBox())!;
  const grip = /pull:(-?\d+),(-?\d+)/.exec((await canvas.getAttribute("data-handles")) ?? "")!;
  const dx = box.x + Number(grip[1]) - at.x;
  const dy = box.y + Number(grip[2]) - at.y;
  const length = Math.hypot(dx, dy);
  await page.keyboard.down("Control");
  await page.mouse.down();
  for (let step = 8; step <= px; step += 8) await page.mouse.move(at.x + (dx / length) * step, at.y + (dy / length) * step);
}

test("a pointer the system cancels mid-drag applies nothing", async ({ page }) => {
  const { applied } = await openPushBox(page);
  await page.evaluate(() => {
    window.addEventListener("pointerdown", (ev) => {
      (window as unknown as { lastPointer: number }).lastPointer = ev.pointerId;
    }, { capture: true });
  });
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await pressAndPull(page, top, 40);
  await expect(page.locator(".interact-hud input").first()).toBeVisible();
  await page.locator("#model").evaluate((canvas) => {
    const pointerId = (window as unknown as { lastPointer: number }).lastPointer;
    canvas.dispatchEvent(new PointerEvent("pointercancel", { pointerId, bubbles: true }));
  });
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(page.locator(".interact-hud input").first()).toBeHidden();
  await page.waitForTimeout(400);
  expect(applied, "the cancelled push is not applied").toHaveLength(0);
  await expect(page.locator("#modelHistoryTree")).not.toContainText("Pull face");
});

test("after Undo, Tab and a double-click leave the undone pull alone", async ({ page }) => {
  const { applied, tree } = await openPushBox(page);
  const hud = page.locator(".interact-hud input").first();
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await dragFace(page, top, 10);
  await expect(page.locator("#modelHistoryTree")).toContainText("Pull face 10 mm");
  await page.locator("#modelUndo").click();
  await expect.poll(async () => height(page)).toBeCloseTo(20, 0);
  await page.locator("#model").hover({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  await expect(hud, "Tab does not reopen an undone step").toBeHidden();
  expect(tree.of("edit"), "the undone step is not rebuilt").toHaveLength(0);

  const again = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.dblclick(again.x, again.y);
  await page.waitForTimeout(400);
  expect(applied, "a double-click after Undo repeats nothing").toHaveLength(1);
  expect(await height(page)).toBeCloseTo(20, 0);
});

test("leaving Model with a Tab edit open closes the box, and the app's keys work again", async ({ page }) => {
  await openPushBox(page);
  const hud = page.locator(".interact-hud input").first();
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await dragFace(page, top, 10);
  await expect(page.locator("#modelReadout")).toContainText("Tab to edit");
  await page.keyboard.press("Tab");
  await expect(hud).toBeVisible();
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#tabPrepare")).toHaveAttribute("aria-selected", "true");
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("2");
  await expect(page.locator("#tabPreview"), "2 opens Preview: the hidden box took no key").toHaveAttribute("aria-selected", "true");
  await page.locator("#tabModel").click();
  await expect(hud, "the box does not come back with Model").toBeHidden();
});

test("History edits a pull and a prism in Push/Pull, and a prism stays a prism", async ({ page }) => {
  const { applied } = await openPushBox(page);
  const history = page.locator("#modelHistoryTree");
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await dragFace(page, top, 10);
  await expect(history).toContainText("Pull face 10 mm");
  const side = await facePoint(page, (normal) => normal[0]! > 0.5);
  await dragFace(page, side, 8, true);
  await expect(history).toContainText("Extrude face 8 mm");

  const row = (text: string) => page.getByRole("treeitem", { name: new RegExp(`^${text}`) });
  await row("Pull face 10 mm").hover();
  await row("Pull face 10 mm").locator(".mh-edit").click();
  await expect(page.locator("#modelEditHead")).toHaveText("Editing step 1: Pull face 10 mm");
  const distance = page.locator("#modelPull");
  await expect(distance).toHaveValue("10");
  await distance.selectText();
  await page.keyboard.type("6");
  await page.locator("#modelApply").click();
  await expect(history).toContainText("Pull face 6 mm");
  expect(applied.at(-2)).toMatchObject({ kind: "moveFaces", faces: [{ face: 1, distance: 6 }] });

  // The update forked the history: the prism on screen is the one replayed after the new pull.
  const prism = row("Extrude face 8 mm").and(page.locator("[aria-selected=true]"));
  await prism.hover();
  await prism.locator(".mh-edit").click();
  await expect(distance).toHaveValue("8");
  await distance.selectText();
  await page.keyboard.type("5");
  await page.locator("#modelApply").click();
  await expect(history).toContainText("Extrude face 5 mm");
  expect(applied.at(-1)).toMatchObject({ kind: "faceExtrude", face: 5, distance: 5 });
});

test("a distance no printer reaches is refused in the panel", async ({ page }) => {
  await openPushBox(page);
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(top.x, top.y);
  await page.locator("#modelToolPull").click();
  const distance = page.locator("#modelPull");
  await expect(distance).toBeVisible();
  await distance.selectText();
  await page.keyboard.type("1000000");
  await expect(page.locator("#modelNote")).toContainText("1000000 mm is farther than any printer reaches.");
  await expect(page.locator("#modelApply")).toBeDisabled();
});

test("a push as deep as the part is refused in its own words, and nothing is applied", async ({ page }) => {
  const { applied } = await openPushBox(page);
  const hud = page.locator(".interact-hud input").first();
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await pressAndPull(page, top, 40);
  await expect(hud).toBeVisible();
  await page.keyboard.type("-20");
  await expect(hud).toHaveValue("-20");
  await page.keyboard.press("Enter");
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(page.locator("#modelReadout")).toContainText("That push goes through the part: it is 20 mm deep there.");
  await page.waitForTimeout(300);
  expect(applied, "the push through the part is not applied").toHaveLength(0);
  expect(await height(page)).toBeCloseTo(20, 0);
});

test("a drag that rests three times waits for each dry-run before it sends the next", async ({ page }) => {
  const solid = boxSolid();
  let running = 0;
  let most = 0;
  let sent = 0;
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, {
    open: () => solid,
    probe: async () => {
      sent += 1;
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 900));
      running -= 1;
      return { ok: true };
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await pressAndPull(page, top, 24);
  for (const px of [12, 24, 36]) {
    await page.mouse.move(top.x, top.y - 24 - px);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2000);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.keyboard.up("Control");
  expect(sent, "the drag asked the engine").toBeGreaterThan(1);
  expect(most, "one dry-run at a time").toBe(1);
});

test("after a tool is closed with Esc or Cancel, the next hover offers the push at once", async ({ page }) => {
  const { applied } = await openPushBox(page);
  const canvas = page.locator("#model");
  // The box does not move, so the top's point on screen is read once, while the push is live.
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  for (const [tool, close] of [["#modelToolSplit", "Escape"], ["#modelToolScale", "cancel"], ["#modelToolShell", "Escape"], ["#modelToolHole", "cancel"]] as const) {
    await page.locator(tool).click();
    await expect(page.locator("#modelPanel")).toBeVisible();
    if (close === "Escape") await page.keyboard.press("Escape");
    else await page.locator("#modelCancel").click();
    await expect(page.locator("#modelPanel")).toBeHidden();
    await page.mouse.move(top.x, top.y);
    await page.mouse.move(top.x + 1, top.y);
    await expect(canvas, `the arrow is back after ${tool} and ${close}, with no click`).toHaveAttribute("data-handles", /pull:/);
  }
  await dragFace(page, top, 10);
  expect(applied.at(-1)?.kind).toBe("moveFaces");
});

test("with a section on, the half it hides is neither hovered nor picked", async ({ page }) => {
  await openPushBox(page);
  const canvas = page.locator("#model");
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  const side = await facePoint(page, (normal) => normal[0]! > 0.5);
  await page.locator("#modelLookOpen").click();
  await page.locator("#modelSection").check();
  // The section cuts at the box's middle, z = 10, and hides the top half with its top face.
  await expect(canvas).toHaveAttribute("data-section", "10.00 10.00 10.00 0.00 0.00 1.00");
  await page.locator("#modelLookOpen").click();
  await page.mouse.move(top.x, top.y);
  await page.mouse.move(top.x + 1, top.y);
  await page.waitForTimeout(200);
  expect(await canvas.getAttribute("data-handles") ?? "", "no arrow on the hidden top").not.toContain("pull:");
  await page.mouse.click(top.x + 1, top.y);
  await expect(canvas, "a click there lands on the cut, not on the hidden top").toHaveAttribute("data-selection-bar", "empty");

  await page.mouse.click(side.x, side.y + 20);
  await expect(canvas, "the shown half of a side is still picked").toHaveAttribute("data-selection-bar", "flat-face");
});

test("the push arrow stays put while the pointer walks to its tip, and grabbing the tip starts from 0", async ({ page }) => {
  const { applied } = await openPushBox(page);
  const canvas = page.locator("#model");
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  let nudge = 0;
  await expect.poll(async () => {
    nudge = (nudge + 1) % 3;
    await page.mouse.move(top.x + nudge, top.y);
    return canvas.getAttribute("data-handles") ?? "";
  }).toContain("pull:");
  const box = (await canvas.boundingBox())!;
  const grip = /pull:(-?\d+),(-?\d+)/.exec((await canvas.getAttribute("data-handles")) ?? "")!;
  const tip = { x: box.x + Number(grip[1]), y: box.y + Number(grip[2]) };
  const from = { x: top.x + nudge, y: top.y };
  const length = Math.hypot(tip.x - from.x, tip.y - from.y);
  expect(length, "the arrow has a length on screen").toBeGreaterThan(10);
  for (let t = 0.2; t <= 1.001; t += 0.2) {
    await page.mouse.move(from.x + (tip.x - from.x) * t, from.y + (tip.y - from.y) * t);
    await expect(canvas, `the arrow is still at its seat ${Math.round(t * 100)}% of the way`).toHaveAttribute("data-handles", new RegExp(`pull:${grip[1]},${grip[2]}`));
  }
  const ux = (tip.x - from.x) / length;
  const uy = (tip.y - from.y) / length;
  await page.mouse.down();
  await page.mouse.move(tip.x + ux * 6, tip.y + uy * 6);
  await expect(page.locator(".interact-hud input").first()).toBeVisible();
  const start = Number(await canvas.getAttribute("data-pull"));
  expect(Math.abs(start), `6 px past the grabbed tip is close to 0 mm, not the arrow's length (${start})`).toBeLessThan(2);
  for (let step = 12; step <= 60; step += 12) await page.mouse.move(tip.x + ux * step, tip.y + uy * step);
  const pulled = Number(await canvas.getAttribute("data-pull"));
  expect(pulled, "dragging on along the arrow pulls").toBeGreaterThan(start + 1);
  await page.mouse.up();
  await expect.poll(() => applied.length).toBe(1);
  expect(applied[0]?.kind).toBe("moveFaces");
  expect(applied[0]?.faces?.[0]?.face).toBe(1);
});
