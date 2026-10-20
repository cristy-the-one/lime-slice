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
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "line");
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
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "rectangle");
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
  const fits = () => page.locator("#toolRail").evaluate((bar) => bar.scrollHeight <= bar.clientHeight + 1);
  expect(await fits(), "the toolbar fits before the sketch opens").toBe(true);
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  expect(await fits(), "drawing tools are not on the Model toolbar").toBe(true);
  await expect(page.locator("#modelBar")).not.toHaveAttribute("data-tool", /.+/);

  for (const label of ["Line", "Rectangle", "Circle", "Arc", "Spline", "Polygon", "Slot"]) {
    await expect(page.locator(`[data-sketch-section=draw] [data-sketch-tool]`, { hasText: label }).or(page.getByRole("button", { name: label, exact: true }))).toBeVisible();
  }
  for (const label of ["Select", "Trim", "Offset", "Fillet corner", "Construction", "Use"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  if (process.env.LIME_SHOTS) await page.locator("#sketchCards").screenshot({ path: `${process.env.LIME_SHOTS}/ux03-after-sketch-card.png` });
  await page.getByRole("button", { name: "Circle", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "circle");
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
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "polygon");
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
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "offset");
  await page.keyboard.press("G");
  await expect(page.locator("#modelReadout")).toContainText("Fillet corner");
  await page.keyboard.press("U");
  await expect(page.locator("#modelReadout")).toContainText("faint edge");
  await page.keyboard.press("X");
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "construction");
  expect(await fits(), "the toolbar still fits at 1440 px while a sketch is open").toBe(true);
  await expect(page.locator("#modelBar")).not.toHaveAttribute("data-tool", /.+/);
});

test("constraints live in the sketch card and a typed length drives the line", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBox(page);
  const canvas = page.locator("#model");
  const fits = () => page.locator("#toolRail").evaluate((bar) => bar.scrollHeight <= bar.clientHeight + 1);
  expect(await fits(), "the toolbar fits before the sketch opens").toBe(true);
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-camera", "locked");
  expect(await fits(), "constraints are not on the Model toolbar").toBe(true);
  await expect(page.locator("#modelBar")).not.toHaveAttribute("data-tool", /.+/);
  await expect(page.locator("#modelToolSketch")).not.toHaveAttribute("data-tool", /.+/);

  const box = (await canvas.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const end = { x: start.x + 140, y: start.y - 40 };
  await page.mouse.click(start.x, start.y);
  await page.mouse.click(end.x, end.y);
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "1");

  await page.locator("[data-sketch-tool=select]").click();
  await page.mouse.move(start.x - 30, start.y + 30);
  await page.mouse.down();
  await page.mouse.move(end.x + 30, end.y - 30);
  await page.mouse.up();
  await page.locator("[data-sketch-menu=constrain]").click();
  await expect(page.locator("[data-sketch-constrain=horizontal]")).toBeVisible();
  await expect(page.locator("[data-sketch-constrain=coincident]")).toBeVisible();
  await expect(page.locator("[data-sketch-constrain=length]")).toBeVisible();
  await expect(page.locator("[data-sketch-constrain=remove]")).toBeVisible();
  await page.locator("[data-sketch-constrain=horizontal]").click();
  await page.locator("[data-sketch-menu=constrain]").click();
  await page.locator("[data-sketch-constrain=length]").click();

  const label = page.locator(".sketch-dim-input");
  await expect(label).toBeVisible();
  const dimWidth = await label.evaluate((el) => el.getBoundingClientRect().width);
  expect(dimWidth, "the driving dimension stays a short field").toBeLessThan(120);
  expect(dimWidth).toBeGreaterThan(40);
  await label.fill("40");
  await label.press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-measure", "40.000,0.000");
  // A value typed on the label is set when the label loses focus to a click on the canvas.
  await page.locator(".sketch-dim").first().click();
  await expect(label).toBeFocused();
  await page.keyboard.type("45");
  await page.mouse.click(start.x - 60, start.y + 120);
  await expect(canvas).toHaveAttribute("data-sketch-measure", "45.000,0.000");
  // A screen reader hears the label's value, not only what it is.
  await expect(page.locator(".sketch-dim").first()).toHaveAttribute("aria-label", "Length 45 mm. Click to type a new one.");
  // Esc closes an open card menu first, and the sketch stays open.
  await page.locator("[data-sketch-menu=constrain]").click();
  await expect(page.locator("[data-sketch-constrain=length]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-sketch-constrain=length]")).toBeHidden();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-defined", "0");
  await expect(canvas).toHaveAttribute("data-sketch-dof", /^\d+$/);
  await expect(canvas).toHaveAttribute("data-sketch-constraints", "2");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "1");

  for (let step = 0; step < 6; step += 1) {
    if ((await canvas.getAttribute("data-sketch-constraints")) === "0") break;
    await page.keyboard.press("Control+z");
  }
  await expect(canvas).toHaveAttribute("data-sketch-constraints", "0");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "1");
  expect(await fits(), "the toolbar still fits at 1440 px with constraints in the card").toBe(true);
  await expect(page.locator("#modelBar")).not.toHaveAttribute("data-tool", /.+/);
});

test("the sketch card keeps the keyboard while the pointer moves, and its menus are keyboard menus", async ({ page }) => {
  await openBox(page);
  const canvas = page.locator("#model");
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  const box = (await canvas.boundingBox())!;
  const rectangle = page.locator("[data-sketch-tool=rectangle]");
  await rectangle.focus();
  for (let step = 0; step < 6; step += 1) await page.mouse.move(box.x + box.width / 2 + step * 9, box.y + box.height / 2 + step * 5);
  await expect(rectangle).toBeFocused();

  // Draw stays a fixed row. The Constrain menu is still a keyboard menu.
  const draw = page.locator("[data-sketch-section=draw] [data-sketch-tool]");
  await expect(draw).toHaveCount(7);
  await page.locator("[data-sketch-menu=constrain]").focus();
  await page.keyboard.press("Enter");
  const items = page.locator(".sketch-menu:has([data-sketch-menu=constrain]) [role^=menuitem]");
  await expect(items.first()).toBeVisible();
  const count = await items.count();
  expect(count).toBeGreaterThan(2);
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(items.first()).toBeHidden();
  await expect(page.locator("[data-sketch-menu=constrain]")).toBeFocused();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(page.locator(".sketch-menu:has([data-sketch-menu=constrain]) [role=group]")).toHaveCount(3);
});

/** Open a sketch on XY and draw a 12 x 5 rectangle at the canvas centre. Returns that centre. */
async function sketchRectangle(page: Page) {
  const canvas = page.locator("#model");
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await page.keyboard.press("r");
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "rectangle");
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(centre.x, centre.y);
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").nth(0).fill("12");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("5");
  await hud.locator("input").nth(1).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "4");
  return centre;
}

test("a rectangle keeps square sides, its constraints show as marks, and a mark is picked and deleted", async ({ page }) => {
  await openBox(page);
  const canvas = page.locator("#model");
  await sketchRectangle(page);
  await expect(canvas, "a rectangle carries two horizontal and two vertical sides").toHaveAttribute("data-sketch-constraints", "4");
  const marks = page.locator(".sketch-glyph");
  await expect(marks).toHaveText(["H", "V", "H", "V"]);
  await expect(marks.first()).toHaveAttribute("aria-label", /^Horizontal\./);
  await marks.first().click();
  await expect(page.locator(".sketch-glyph[aria-pressed=true]")).toHaveCount(1);
  await page.keyboard.press("Delete");
  await expect(canvas).toHaveAttribute("data-sketch-constraints", "3");
  await expect(marks).toHaveText(["V", "H", "V"]);
  await expect(canvas, "Delete took the constraint, not the rectangle").toHaveAttribute("data-sketch-entities", "4");
});

test("sketch keys leave text fields alone and stop when Model closes", async ({ page }) => {
  await openBox(page);
  const canvas = page.locator("#model");
  await sketchRectangle(page);

  // Any other text field types its own letters and keeps its own undo.
  await page.evaluate(() => {
    const field = document.createElement("input");
    field.id = "zzField";
    field.type = "text";
    document.body.append(field);
  });
  const field = page.locator("#zzField");
  await field.focus();
  await page.keyboard.type("we");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-extrude", "off");
  await expect(canvas).toHaveAttribute("data-sweep", "off");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "4");
  await field.evaluate((node) => (node as HTMLElement).blur());

  // The extrude's size box takes an expression with W, E, M and V in it.
  await page.keyboard.press("e");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  const size = page.locator(".interact-hud:not([hidden]) input").nth(0);
  await expect(size).toBeFocused();
  await page.keyboard.type("wallH * 2 - Mev");
  await expect(canvas).toHaveAttribute("data-sweep", "off");
  await expect(canvas).toHaveAttribute("data-revolve", "off");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await expect(size).toHaveValue(/wallH \* 2 - Mev$/);
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-extrude", "off");

  // A toolbar tool ends the extrude and the sketch instead of opening on top of them.
  await page.keyboard.press("e");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await page.locator("#modelToolShell").click();
  await expect(page.locator("#modelBar")).toHaveAttribute("data-tool", "shell");
  await expect(canvas).toHaveAttribute("data-extrude", "off");
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");
  await expect(page.locator(".interact-hud:not([hidden])")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator("[data-sketch-open]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");

  // Leaving Model keeps the sketch as a card; Prepare's keys do not reach it.
  await page.locator("#tabPrepare").click();
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("r");
  await page.keyboard.press("w");
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "4");
  await expect(canvas).toHaveAttribute("data-sweep", "off");
});

test("extrude waits for a profile, and loft says what to pick", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBox(page);
  const canvas = page.locator("#model");
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  const extrude = page.locator("[data-sketch-extrude]");
  await expect(extrude).toHaveAttribute("aria-disabled", "true");
  await expect(extrude).toHaveAttribute("data-tip", "Draw a closed profile to extrude.");
  await extrude.evaluate((button: HTMLElement) => button.focus({ focusVisible: true }));
  await expect(page.locator(".lime-tip")).toContainText("Draw a closed profile to extrude.");
  await extrude.click({ force: true });
  await expect(page.locator("#toasts")).toContainText("Draw a closed profile to extrude.");

  const box = (await canvas.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.locator("[data-sketch-tool=rectangle]").click();
  await page.mouse.click(start.x, start.y);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill("12");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("5");
  await hud.locator("input").nth(1).press("Enter");
  await expect(extrude).toHaveAttribute("aria-disabled", "false");

  const drawAt = () => page.locator("[data-sketch-section=draw] [data-sketch-tool]").evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { tool: (node as HTMLElement).dataset.sketchTool, x: Math.round(box.x), y: Math.round(box.y) };
  }));
  const before = await drawAt();
  await page.locator("[data-sketch-loft]").click();
  const prompt = page.locator(".sketch-prompt-text");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("Pick at least two sections to loft.");
  const readout = (await page.locator("#modelReadout").innerText()).trim();
  expect(readout.length, readout).toBeLessThanOrEqual(80);
  const how = page.getByRole("button", { name: "How" });
  await how.focus();
  await expect(how).toBeFocused();
  const pop = page.locator("#sketchHow");
  if (await pop.isHidden()) await page.keyboard.press("Enter");
  await expect(pop).toBeVisible();
  await expect(pop.locator("li").first()).toHaveText("Pick sections in order.");
  const after = await drawAt();
  expect(after).toEqual(before);
  const overflow = await page.locator("#sketchCards button").evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => (node as HTMLElement).innerText));
  expect(overflow).toEqual([]);
  if (process.env.LIME_SHOTS) await page.locator("#modelDock .sketch-card").screenshot({ path: `${process.env.LIME_SHOTS}/after-loft-prompt.png` });
  await page.locator("[data-sketch-section=feature] [data-sketch-cancel]").click();
  await expect(prompt).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-loft", "off");
});
