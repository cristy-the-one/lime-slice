import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 mm box. Face 1 is the top. Face 5 can be reported as a cylinder. */
function boxSolid(cylinderFace = false) {
  const [sx, sy, sz] = [20, 20, 20];
  const c = (x: number, y: number, z: number): V => [x * sx, y * sy, z * sz];
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
  const faces = quads.map((_, id) =>
    cylinderFace && id === 1
      ? { id, areaMm2: sx * sy, surface: "cylinder", radiusMm: 10, axisPoint: [10, 10, 10], axis: [0, 0, 1] }
      : { id, areaMm2: 0 },
  );
  return { volumeMm3: sx * sy * sz, positions, triangles, faces, edges };
}

async function openModel(page: Page, cylinderFace = false) {
  const solid = boxSolid(cylinderFace);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid, probe: () => ({ ok: true }) });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await expect(page.locator("#modelContextBar")).toBeHidden();
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function facePoint(page: Page, want: (normal: number[]) => boolean): Promise<{ x: number; y: number }> {
  // A missing attribute is null, which is not "", so wait for a published list.
  // The list is cleared for a frame while a dry-run replaces the solid, so the point is taken from the same read.
  let found: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    const text = (await page.locator("#model").getAttribute("data-faces")) ?? "";
    const box = await page.locator("#model").boundingBox();
    found = null;
    if (!box || text === "") return "";
    for (const item of text.split(" ").filter(Boolean)) {
      const [, xy, normalText] = item.split(":");
      if (!xy || !normalText) continue;
      const normal = normalText.split(",").map(Number);
      if (!want(normal)) continue;
      const [x, y] = xy.split(",").map(Number);
      found = { x: box.x + x!, y: box.y + y! };
      return text;
    }
    return "";
  }).not.toBe("");
  if (!found) throw new Error("no face");
  return found;
}

/** The bar, the solid, the toolbar, and the readout, in page pixels. */
async function layout(page: Page) {
  const canvas = (await page.locator("#model").boundingBox())!;
  const bar = (await page.locator("#modelContextBar").boundingBox())!;
  const [x, y, width, height] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const solid = { x: canvas.x + x!, y: canvas.y + y!, width: width!, height: height! };
  const tools = (await page.locator("#toolRail").boundingBox())!;
  const readout = (await page.locator("#modelReadout").boundingBox())!;
  // E3. The size is in Inspect; over the view sits the pick filter.
  const fit = (await page.locator("#modelPick").boundingBox())!;
  return { canvas, bar, solid, tools, readout, fit };
}

test("a face click opens Push/Pull, Hole, and Shell off the solid, and Enter types the distance", async ({ page }) => {
  await openModel(page);
  const fits = () => page.locator("#toolRail").evaluate((node) => node.scrollHeight <= node.clientHeight + 1);
  expect(await fits(), "the toolbar still fits at 1440 px").toBe(true);

  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(top.x, top.y);
  const bar = page.locator("#modelContextBar");
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-kind", "flat-face");
  await expect(page.locator("#model")).toHaveAttribute("data-selection-bar", "flat-face");
  await expect(bar.locator("[data-action='push-pull']")).toBeVisible();
  await expect(bar.locator("[data-action='hole']")).toBeVisible();
  await expect(bar.locator("[data-action='shell-face']")).toHaveText("Shell (open this face)");
  expect(await fits(), "the selection bar is not part of the toolbar").toBe(true);

  const placed = await layout(page);
  expect(overlaps(placed.bar, placed.solid), "the bar stays off the solid").toBe(false);
  expect(overlaps(placed.bar, { x: top.x - 2, y: top.y - 2, width: 4, height: 4 }), "the bar stays off the pointer").toBe(false);
  expect(overlaps(placed.bar, placed.tools), "the toolbar does not cover the bar").toBe(false);
  expect(overlaps(placed.bar, placed.readout), "the readout does not cover the bar").toBe(false);
  expect(overlaps(placed.bar, placed.fit), "the pick filter does not cover the bar").toBe(false);
  expect(placed.bar.x).toBeGreaterThanOrEqual(placed.canvas.x);
  expect(placed.bar.y).toBeGreaterThanOrEqual(placed.canvas.y);
  expect(placed.bar.x + placed.bar.width).toBeLessThanOrEqual(placed.canvas.x + placed.canvas.width + 1);

  await bar.locator("[data-action='push-pull']").focus();
  await page.keyboard.press("ArrowRight");
  await expect(bar.locator("[data-action='hole']")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(bar.locator("[data-action='push-pull']")).toBeFocused();
  await page.keyboard.press("Enter");
  const distance = page.locator("#modelPull");
  await expect(distance).toBeVisible();
  await distance.fill("7");
  await expect(distance).toHaveValue("7");
  await expect(page.locator("#modelPullDiameter"), "a flat face has no diameter").toBeHidden();
  await expect(bar).toBeHidden();
});

test("several faces, a cylinder, an edge, and empty space each offer their own actions", async ({ page }) => {
  await openModel(page);
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  const side = await facePoint(page, (normal) => normal[0]! > 0.5);
  await page.mouse.click(top.x, top.y);
  // mouse.click ignores `modifiers`; the key has to be down, as the other model specs do.
  await page.keyboard.down("Shift");
  await page.mouse.click(side.x, side.y);
  await page.keyboard.up("Shift");
  const bar = page.locator("#modelContextBar");
  await expect(bar).toHaveAttribute("data-kind", "faces");
  await expect(bar.locator("[data-action='move-faces']")).toBeVisible();
  await expect(bar.locator("[data-action='shell-faces']")).toHaveText("Shell (open these)");
  // --- A4. Pattern and Mirror register on several faces and click the Features menu. ---
  await expect(bar.locator("[data-action='pattern']")).toBeVisible();
  await expect(bar.locator("[data-action='mirror']")).toBeVisible();
  await bar.locator("[data-action='pattern']").click();
  await expect(page.locator("#modelBar")).toHaveAttribute("data-tool", "pattern");
  await expect(page.locator("#modelPatCount")).toBeVisible();
  await expect(bar).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelPatCount")).toBeHidden();
  await expect(bar).toBeVisible();
  await bar.locator("[data-action='shell-faces']").click();
  await expect(page.locator("#modelShell")).toBeVisible();
  await expect(page.locator("#modelShellFaces")).toContainText("2 faces open");
  await expect(bar).toBeHidden();

  await page.keyboard.press("Escape");
  await expect(page.locator("#modelShell")).toBeHidden();
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-kind", "faces");
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
});

test("a cylinder offers Change diameter, and empty space offers a typed primitive", async ({ page }) => {
  await openModel(page, true);
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(top.x, top.y);
  const bar = page.locator("#modelContextBar");
  await expect(bar).toHaveAttribute("data-kind", "cylinder");
  await expect(bar.locator("[data-action='change-diameter']")).toBeVisible();
  await bar.locator("[data-action='change-diameter']").click();
  await expect(page.locator("#modelPull")).toBeVisible();
  // One cylinder: the panel types its diameter too, and Distance is the offset that reaches it.
  const diameter = page.locator("#modelPullDiameter");
  await expect(diameter).toBeVisible();
  await expect(diameter).toHaveValue("20");
  await diameter.selectText();
  await page.keyboard.type("12");
  await expect(page.locator("#modelPull")).toHaveValue(/^-?4$/);
  await page.keyboard.press("Escape");

  const canvasBox = (await page.locator("#model").boundingBox())!;
  const [sx, sy, sw, sh] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const solid = { x: canvasBox.x + sx!, y: canvasBox.y + sy!, width: sw!, height: sh! };
  const tools = (await page.locator("#modelPick").boundingBox())!;
  const selection = await page.locator("#modelContextBar").boundingBox();
  const blocked = [solid, tools, ...(selection ? [selection] : [])];
  const empty = [
    { x: canvasBox.x + 28, y: canvasBox.y + 28 },
    { x: canvasBox.x + canvasBox.width - 28, y: canvasBox.y + 28 },
    { x: canvasBox.x + 28, y: canvasBox.y + canvasBox.height * 0.5 },
  ].find((point) => blocked.every((box) => !overlaps({ x: point.x - 2, y: point.y - 2, width: 4, height: 4 }, box)));
  expect(empty, "a click misses the solid and the toolbar").toBeTruthy();
  await page.mouse.click(empty!.x, empty!.y);
  await expect(bar).toHaveAttribute("data-kind", "empty");
  await bar.locator("[data-action='new-primitive-menu']").click();
  const menu = page.locator("#modelContextMenu");
  await expect(menu).toBeVisible();
  await menu.locator("[data-action='box']").click();
  const size = page.locator("#modelDx");
  await expect(size).toBeVisible();
  await size.fill("12");
  await expect(size).toHaveValue("12");
  await expect(page.locator("#modelBar")).toHaveAttribute("data-tool", "create");
});

test("an edge offers Fillet and Chamfer, and the bar fades until the pointer returns", async ({ page }) => {
  await openModel(page);
  const canvas = page.locator("#model");
  const hit = await canvas.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    for (let y = rect.top + rect.height * 0.2; y <= rect.top + rect.height * 0.8; y += 14) {
      for (let x = rect.left + rect.width * 0.2; x <= rect.left + rect.width * 0.8; x += 14) {
        node.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse" }));
        if ((node.getAttribute("data-handles") ?? "").includes("edge-blend:")) return true;
      }
    }
    return false;
  });
  expect(hit, "an edge lights").toBe(true);
  const box = (await canvas.boundingBox())!;
  const at = /edge-blend:(-?\d+),(-?\d+)/.exec((await canvas.getAttribute("data-handles")) ?? "");
  expect(at).toBeTruthy();
  const edge = { x: box.x + Number(at![1]), y: box.y + Number(at![2]) };

  await page.locator("#modelPickEdge").click();
  await page.mouse.click(edge.x, edge.y);
  const bar = page.locator("#modelContextBar");
  await expect(bar).toHaveAttribute("data-kind", "edges");
  await expect(bar.locator("[data-action='fillet']")).toBeVisible();
  await expect(bar.locator("[data-action='chamfer']")).toBeVisible();
  await bar.locator("[data-action='chamfer']").click();
  await expect(page.locator("#modelBlend")).toBeVisible();
  await page.locator("#modelBlend").fill("1.5");
  await expect(page.locator("#modelBlend")).toHaveValue("1.5");
  await page.keyboard.press("Escape");
  await page.locator("#modelPickFace").click();

  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(top.x, top.y);
  await expect(bar).toHaveAttribute("data-kind", "flat-face");
  await expect(bar).toHaveAttribute("data-faded", "0");
  await page.waitForTimeout(3200);
  await expect(bar).toHaveAttribute("data-faded", "1");
  await expect(bar.locator("#contextBarRestore"), "a count chip stays when the actions fade").toBeVisible();
  await expect(bar.locator("#contextBarRestore")).toHaveText("1 face ▾");
  const tone = await page.evaluate(() => {
    const chip = getComputedStyle(document.querySelector("#contextBarRestore")!);
    const dock = getComputedStyle(document.querySelector("#modelPanel")!);
    return { chip: chip.backgroundColor, dock: dock.backgroundColor, ink: chip.color, dockInk: dock.color };
  });
  expect(tone.chip, "the chip uses the dock surface").toBe(tone.dock);
  expect(tone.ink).toBe(tone.dockInk);
  const canvasBox = (await canvas.boundingBox())!;
  const [sx, , sw] = ((await canvas.getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const chipBox = (await bar.boundingBox())!;
  const solidLeft = canvasBox.x + sx!;
  const solidRight = solidLeft + sw!;
  expect(chipBox.x + chipBox.width <= solidLeft + 2 || chipBox.x >= solidRight - 2, "the chip sits beside the solid").toBe(true);
  if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/ux09-after-chip.png` });
  await expect(bar.locator("[data-action='push-pull']")).toBeHidden();
  const chip = (await bar.locator("#contextBarRestore").boundingBox())!;
  expect(chip.x, "the chip stays on screen").toBeGreaterThanOrEqual(0);
  expect(chip.y).toBeGreaterThanOrEqual(0);
  expect(chip.x + chip.width).toBeLessThanOrEqual(1440);
  await page.mouse.move(top.x + 3, top.y + 3);
  await expect(bar).toHaveAttribute("data-faded", "0");
});

test("a face drag takes the bar away, and so does a sketch on the face", async ({ page }) => {
  await openModel(page);
  const bar = page.locator("#modelContextBar");
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(top.x, top.y);
  await expect(bar).toBeVisible();

  // The press lands on the face, which push/pull takes before anything else hears it.
  await page.mouse.move(top.x, top.y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) await page.mouse.move(top.x, top.y - step * 6);
  await expect(bar, "the bar leaves while the face is dragged").toBeHidden();
  await page.keyboard.press("Escape");
  await page.mouse.up();

  const again = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(again.x, again.y);
  await expect(bar).toBeVisible();
  await bar.locator("[data-action='sketch-on-face']").click();
  await expect(page.locator("#model")).not.toHaveAttribute("data-sketch", "off");
  await expect(bar, "the face's actions are not for the sketch").toBeHidden();
});

test("the bar is one Tab stop, stays while it has the focus, and hands the focus to the panel it opens", async ({ page }) => {
  await openModel(page);
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(top.x, top.y);
  const bar = page.locator("#modelContextBar");
  await expect(bar).toBeVisible();
  const stops = await bar.locator("button").evaluateAll((nodes) => nodes.map((node) => (node as HTMLButtonElement).tabIndex));
  expect(stops, "a roving tab stop: only the first button is in the tab order").toEqual([0, ...Array(stops.length - 1).fill(-1)]);
  await bar.locator("[data-action='push-pull']").focus();
  await page.keyboard.press("ArrowRight");
  await expect(bar.locator("[data-action='hole']")).toHaveAttribute("tabindex", "0");
  await expect(bar.locator("[data-action='push-pull']")).toHaveAttribute("tabindex", "-1");
  await page.waitForTimeout(3400);
  await expect(bar, "a focused bar does not fade").toHaveAttribute("data-faded", "0");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  const distance = page.locator("#modelPull");
  await expect(distance).toBeVisible();
  await expect(distance, "the focus goes to the distance, not the page").toBeFocused();
  await page.keyboard.type("6");
  await expect(distance).toHaveValue("6");
});
