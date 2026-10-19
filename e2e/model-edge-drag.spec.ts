import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 x 20 x 10 mm box, as the modeler reports it. */
function boxSolid(volume = 4000): MockSolid {
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
  return { volumeMm3: volume, positions, triangles, faces, edges };
}

interface Op {
  kind?: string;
  size?: number;
  edges?: number[];
}

async function openBox(page: Page, probe: (op: Op) => Record<string, unknown>, applied: Op[], preview?: MockSolid) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions } }));
  await mockModelTree(page, {
    open: () => boxSolid(),
    apply: (request) => {
      applied.push(request.op as Op);
      return boxSolid(3900);
    },
    probe: (request) => probe(request.op as Op),
    preview: () => preview ?? null,
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await expect(page.locator("#modelBar")).not.toHaveAttribute("data-tool", /.+/);
  // The file input keeps focus after the drop, and a key aimed at it never reaches the view.
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

/** Move across the solid until an edge lights, and return that knob in page pixels. */
async function knobAt(page: Page): Promise<{ x: number; y: number }> {
  const canvas = page.locator("#model");
  const hit = await canvas.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    for (let y = rect.top + rect.height * 0.12; y <= rect.top + rect.height * 0.88; y += 12) {
      for (let x = rect.left + rect.width * 0.12; x <= rect.left + rect.width * 0.88; x += 12) {
        node.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse" }));
        if (node.dataset.edgeDrag === "hover") return true;
      }
    }
    return false;
  });
  expect(hit, "an edge lights when the pointer crosses it").toBe(true);
  await expect(canvas).toHaveAttribute("data-handles", /edge-blend:/);
  const box = (await canvas.boundingBox())!;
  const handles = (await canvas.getAttribute("data-handles")) ?? "";
  const at = handles.match(/edge-blend:(-?\d+),(-?\d+)/);
  expect(at).toBeTruthy();
  return { x: box.x + Number(at![1]), y: box.y + Number(at![2]) };
}

/** Drag from the knob until the radius passes `min`, and leave the button down. */
async function dragPast(page: Page, at: { x: number; y: number }, min: number): Promise<{ x: number; y: number }> {
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const canvas = page.locator("#model");
  let best = { x: at.x, y: at.y, size: 0 };
  for (const [dx, dy] of [
    [140, 0], [-140, 0], [0, 140], [0, -140],
    [100, 100], [-100, 100], [100, -100], [-100, -100],
    [180, 40], [-40, 180], [40, -180], [-180, -40],
  ]) {
    const x = at.x + dx;
    const y = at.y + dy;
    await page.mouse.move(x, y);
    const size = Number(await canvas.getAttribute("data-edge-size"));
    if (size > best.size) best = { x, y, size };
  }
  if (best.size < min) {
    const dx = best.x - at.x;
    const dy = best.y - at.y;
    const span = Math.hypot(dx, dy) || 1;
    for (const reach of [220, 320, 420]) {
      const x = at.x + (dx / span) * reach;
      const y = at.y + (dy / span) * reach;
      await page.mouse.move(x, y);
      const size = Number(await canvas.getAttribute("data-edge-size"));
      if (size > best.size) best = { x, y, size };
      if (size >= min) break;
    }
  }
  await page.mouse.move(best.x, best.y);
  expect(Number(await canvas.getAttribute("data-edge-size")), "the drag moves the radius").toBeGreaterThanOrEqual(min);
  return { x: best.x, y: best.y };
}

test("dragging an edge knob fillets it, and Alt chamfers it", async ({ page }) => {
  const probes: Op[] = [];
  const applied: Op[] = [];
  await openBox(page, (op) => {
    probes.push(op);
    return { ok: true };
  }, applied, boxSolid(4100));
  const at = await knobAt(page);
  await expect(page.locator("#modelReadout")).toContainText("Drag to fillet");
  await expect(page.locator("#modelReadout")).toContainText("Alt: chamfer");

  const during = probes.length;
  const moved = await dragPast(page, at, 0.5);
  // The probe waits until the pointer has been still. It is what puts the preview on the canvas.
  await expect(page.locator("#model")).toHaveAttribute("data-preview", "4100.00", { timeout: 2000 });
  expect(probes.length).toBeGreaterThan(during);
  await page.mouse.move(moved.x, moved.y);
  await page.mouse.up();
  await expect(page.locator("#modelReadout")).toContainText("Tab to edit");
  expect(applied.at(-1)?.kind).toBe("fillet");
  expect(applied.at(-1)?.size ?? 0).toBeGreaterThanOrEqual(0.5);
  await expect(page.locator("#model")).not.toHaveAttribute("data-edge-drag", /./);

  const again = await knobAt(page);
  await page.keyboard.down("Alt");
  const alt = await dragPast(page, again, 0.5);
  await page.mouse.move(alt.x, alt.y);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect(page.locator("#modelReadout")).toContainText("Chamfer");
  await expect(page.locator("#modelReadout")).toContainText("Tab to edit");
  expect(applied.at(-1)?.kind).toBe("chamfer");
});

test("a typed size fillets the hovered edge", async ({ page }) => {
  const applied: Op[] = [];
  await openBox(page, () => ({ ok: true }), applied);
  await knobAt(page);
  await page.keyboard.press("2");
  await expect(page.locator("#tabModel")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".interact-hud:not([hidden])")).toBeVisible();
  await expect(page.locator("#model")).toHaveAttribute("data-edge-drag", "type");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelReadout")).toContainText("Fillet 2 mm · Tab to edit");
  expect(applied.at(-1)).toMatchObject({ kind: "fillet", size: 2 });
});

test("a typed size too big for the edge is refused with the largest that fits, and the box stays open", async ({ page }) => {
  const applied: Op[] = [];
  await openBox(page, (op) => {
    if ((op.size ?? 0) > 1) return { ok: false, error: "The fillet is too big.", maxMm: 1 };
    return { ok: true };
  }, applied);
  await knobAt(page);
  // Typing asks the kernel once the box has a number. It says the largest size, and keeps the number typed.
  await page.keyboard.press("5");
  await expect(page.locator("#modelReadout")).toContainText("The largest that fits is 1 mm.", { timeout: 2000 });
  await expect(page.locator("#model")).toHaveAttribute("data-edge-size", "5");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelReadout")).toContainText("The fillet is too big. The largest that fits is 1 mm.");
  const box = page.locator(".interact-hud:not([hidden]) input");
  await expect(box, "the box stays open for another number").toBeVisible();
  await page.waitForTimeout(300);
  expect(applied, "nothing is applied at a size nobody typed").toHaveLength(0);
  await page.keyboard.type("0.8");
  await expect(box).toHaveValue("0.8");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelReadout")).toContainText("Fillet 0.8 mm · Tab to edit");
  expect(applied.at(-1)).toMatchObject({ kind: "fillet", size: 0.8 });
});

test("Tab reopens the fillet, Esc cancels, and Enter edits it", async ({ page }) => {
  const applied: Op[] = [];
  await openBox(page, () => ({ ok: true }), applied);
  await knobAt(page);
  await page.keyboard.press("2");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelReadout")).toContainText("Tab to edit");
  await page.keyboard.press("Tab");
  await expect(page.locator("#model")).toHaveAttribute("data-edge-drag", "edit");
  await expect(page.locator(".interact-hud:not([hidden])")).toBeVisible();
  const input = page.locator(".interact-hud:not([hidden]) input");
  await input.fill("3");
  await input.press("Enter");
  await expect(page.locator("#modelReadout")).toContainText("Fillet 3 mm · Tab to edit");
  expect(applied.at(-1)).toMatchObject({ kind: "fillet", size: 3 });

  await page.keyboard.press("Tab");
  await expect(page.locator(".interact-hud:not([hidden])")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".interact-hud:not([hidden])")).toBeHidden();
  await expect(page.locator("#model")).not.toHaveAttribute("data-edge-drag", /./);
});

test("P opens Push/Pull, D opens Split, and L still opens Fillet", async ({ page }) => {
  await openBox(page, () => ({ ok: true }), []);
  await page.keyboard.press("p");
  await expect(page.locator("#modelBar")).toHaveAttribute("data-tool", "pushpull");
  await page.keyboard.press("p");
  await expect(page.locator("#modelBar")).not.toHaveAttribute("data-tool", /.+/);
  await page.keyboard.press("d");
  await expect(page.locator("#modelBar")).toHaveAttribute("data-tool", "split");
  await page.keyboard.press("d");
  await expect(page.locator("#modelBar")).not.toHaveAttribute("data-tool", /.+/);
  // Fillet's button waits for an edge. Enabling it and pressing L is the same click the shortcut sends.
  await page.locator("#modelToolFillet").evaluate((button) => button.removeAttribute("disabled"));
  await page.keyboard.press("l");
  await expect(page.locator("#modelBar")).toHaveAttribute("data-tool", "fillet");
  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(page.locator("#model")).not.toHaveAttribute("data-edge-drag", /./);
});

test("after Undo, Tab leaves the undone fillet alone", async ({ page }) => {
  const applied: Op[] = [];
  await openBox(page, () => ({ ok: true }), applied);
  await knobAt(page);
  await page.keyboard.press("2");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelReadout")).toContainText("Tab to edit");
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelReadout")).not.toContainText("Tab to edit");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  await expect(page.locator("#model"), "Tab does not reopen an undone step").not.toHaveAttribute("data-edge-drag", "edit");
  await expect(page.locator(".interact-hud:not([hidden])")).toBeHidden();
});

test("a typed 0 or negative size is refused in a sentence, and the box stays open", async ({ page }) => {
  const applied: Op[] = [];
  await openBox(page, () => ({ ok: true }), applied);
  await knobAt(page);
  const box = page.locator(".interact-hud:not([hidden]) input");
  await page.keyboard.type("-2");
  await expect(box, "a minus starts the box, so the size is not read as 2").toHaveValue("-2");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelReadout")).toContainText("A fillet needs a radius of at least 0.05 mm.");
  await expect(box).toBeVisible();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("0");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelReadout")).toContainText("A fillet needs a radius of at least 0.05 mm.");
  await page.waitForTimeout(300);
  expect(applied, "nothing is applied").toHaveLength(0);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("1.5");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelReadout")).toContainText("Fillet 1.5 mm · Tab to edit");
  expect(applied.at(-1)).toMatchObject({ kind: "fillet", size: 1.5 });
});

test("a smooth edge, between faces that carry on flat, offers no knob", async ({ page }) => {
  const solid = boxSolid();
  // The top's two triangles are two faces in one plane, and the diagonal between them is the only edge.
  const top = [2, 3];
  top.forEach((tri) => {
    solid.triangles[tri] = tri === 2 ? 1 : 6;
  });
  solid.faces.push({ id: 6, areaMm2: 0 });
  // The diagonal is smooth; edge 1, the top's front edge, is a real corner and lights as a control.
  solid.edges = [
    { id: 0, lengthMm: Math.hypot(20, 20), points: [0, 0, 10, 20, 20, 10] },
    { id: 1, lengthMm: 20, points: [0, 0, 10, 20, 0, 10] },
  ];
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid, probe: () => ({ ok: true }) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  const canvas = page.locator("#model");
  const lit = await canvas.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const seen = new Set<string>();
    for (let y = rect.top + rect.height * 0.12; y <= rect.top + rect.height * 0.88; y += 6) {
      for (let x = rect.left + rect.width * 0.12; x <= rect.left + rect.width * 0.88; x += 6) {
        node.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse" }));
        if (node.dataset.edgeDrag === "hover") seen.add(node.dataset.edgeEdges ?? "");
      }
    }
    return [...seen].sort();
  });
  expect(lit, "the corner lights, the smooth diagonal never does").toEqual(["1"]);
});

test("the drag's ghost is the fillet's own surface, inside the corner it rounds", async ({ page }) => {
  const applied: Op[] = [];
  await openBox(page, () => ({ ok: true }), applied);
  const canvas = page.locator("#model");
  await knobAt(page);
  // A typed size draws the same ghost as a drag, at a size this box can take.
  await page.keyboard.type("2.5");
  await expect(canvas).toHaveAttribute("data-edge-size", "2.5");
  await expect(canvas).toHaveAttribute("data-ghost", /\d/);
  const [cx, cy, cz, sx, sy, sz] = ((await canvas.getAttribute("data-ghost")) ?? "").split(" ").map(Number);
  const solid = ((await canvas.getAttribute("data-solid")) ?? "").split(",").map(Number);
  const lo = [cx! - sx! / 2, cy! - sy! / 2, cz! - sz! / 2];
  const hi = [cx! + sx! / 2, cy! + sy! / 2, cz! + sz! / 2];
  for (let axis = 0; axis < 3; axis += 1) {
    expect(lo[axis]!, `the ghost stays inside the box on axis ${axis}`).toBeGreaterThanOrEqual(solid[axis]! - 0.01);
    expect(hi[axis]!, `the ghost stays inside the box on axis ${axis}`).toBeLessThanOrEqual(solid[axis + 3]! + 0.01);
  }
  // Across the edge it spans the radius on each face, not a tube twice as wide.
  const across = [sx!, sy!, sz!].sort((a, b) => a - b).slice(0, 2);
  expect(across.map((span) => Math.round(span * 100) / 100), "2.5 mm along each face").toEqual([2.5, 2.5]);
  await page.keyboard.press("Escape");
});
