import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid, type TreeMock } from "./model-tree-mock";
import { DEMO_DONE, DEMOS, type EditDemoKind } from "../src/sketch/demos.ts";

/**
 * --- Sketch for people, milestone 6 (docs/plan-sketch-for-people.md, section 6): the Edit tools. Each Edit tool's Show
 * me opens from the Edit row's ?, its next click works on the demo, nothing reaches the part, and Back to my sketch puts
 * the person's own drawing back. Then a wall from one line, and the renamed Helper line with Shift+X, on the person's
 * own sketch. ---
 */

type V = [number, number, number];

function boxSolid(size: V = [20, 20, 10]): MockSolid {
  const [sx, sy, sz] = size;
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
  const faces = quads.map((_, id) => ({ id, areaMm2: id < 2 ? sx * sy : id < 4 ? sx * sz : sy * sz }));
  return { volumeMm3: sx * sy * sz, positions, triangles, faces, edges: [] };
}

async function start(page: Page): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: () => boxSolid(), apply: (_request, parent) => parent, probe: () => ({ ok: true }) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await page.locator("#modelEmptySketch").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch", "editing");
  return tree;
}

/** The person's own drawing: a 12 × 8 rectangle typed from the canvas centre. */
async function ownRectangle(page: Page) {
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=rectangle]").click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.5);
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").nth(0).fill("12");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("8");
  await hud.locator("input").nth(1).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line,line,line");
  await page.keyboard.press("Escape");
}

/** A spot on the canvas with nothing drawn under it, to move the pointer through. */
async function aside(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator("#model").boundingBox())!;
  return { x: box.x + box.width - 40, y: box.y + box.height - 40 };
}

/** The demo's next click, on screen, once the camera has settled: two reads in a row agree. */
async function aimOf(page: Page): Promise<{ x: number; y: number }> {
  const canvas = page.locator("#model");
  const spot = await aside(page);
  let last = "";
  for (let i = 0; i < 40; i += 1) {
    await page.mouse.move(spot.x - (i % 2) * 3, spot.y);
    const now = (await canvas.getAttribute("data-sketch-demo-aim")) ?? "";
    if (now && now === last) {
      const [x, y] = now.split(",").map(Number);
      return { x: x!, y: y! };
    }
    last = now;
    await page.waitForTimeout(60);
  }
  throw new Error(`the demo's aim did not settle: ${last}`);
}

/** Open an Edit tool's demo from the Edit row's ?. */
async function showMe(page: Page, kind: EditDemoKind) {
  const how = page.locator("button[data-sketch-edit-how]");
  await expect(how, "the Edit row has its own ?").toBeVisible();
  if ((await how.getAttribute("aria-expanded")) !== "true") await how.click();
  await page.locator(`#sketchEditHow button[data-sketch-demo=${kind}]`).click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch-demo", kind);
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", kind);
  const strip = page.locator("[data-sketch-section=demo]");
  await expect(strip).toContainText(`Show me: ${DEMOS[kind].label}`);
  await expect(strip).toContainText(DEMOS[kind].tryIt);
  await expect(page.locator("button[data-sketch-finish]"), "a demo is never kept as a card").toHaveCount(0);
}

async function made(page: Page, tree: TreeMock, kind: EditDemoKind, calls: number) {
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch-demo-made", kind);
  await expect(page.locator("[data-sketch-section=demo]")).toContainText(DEMOS[kind].made);
  await expect(page.locator("#modelReadout")).toContainText(DEMO_DONE);
  expect(tree.calls.length, "the demo sent nothing to the modeler").toBe(calls);
  await expect(page.locator("#objectList .obj")).toHaveCount(0);
}

/** Back to my sketch: the person's rectangle, with the tool and the undo step they had. */
async function back(page: Page) {
  const canvas = page.locator("#model");
  await page.locator("button[data-sketch-demo-leave]").click();
  await expect(canvas).toHaveAttribute("data-sketch-demo", "");
  await expect(canvas, "the person's rectangle is back, as they drew it").toHaveAttribute("data-sketch-kinds", "line,line,line,line");
  await expect(canvas).toHaveAttribute("data-sketch-construction", "0");
  await expect(page.locator("#sketchEditHow"), "and the Edit row's How as they left it").toBeVisible();
}

const shots = process.env.LIME_SHOTS;

test("The Edit row names Helper line and Copy edge, and its ? lists a Show me per Edit tool", async ({ page }) => {
  await start(page);
  const edit = page.locator("[data-sketch-section=edit]");
  await expect(edit.getByRole("button", { name: "Helper line", exact: true })).toHaveAttribute("data-sketch-tool", "construction");
  await expect(edit.getByRole("button", { name: "Copy edge", exact: true })).toHaveAttribute("data-sketch-tool", "use");
  await expect(edit.locator("[data-sketch-tool=construction]")).toHaveAttribute("data-tip", /\(X\)$/);
  await expect(edit.locator("[data-sketch-tool=use]")).toHaveAttribute("data-tip", /\(U\)$/);
  await page.locator("button[data-sketch-edit-how]").click();
  await expect(page.locator("#sketchEditHow button[data-sketch-demo]")).toHaveText(["Trim", "Offset", "Fillet corner", "Helper line", "Copy edge"]);
  if (shots) await page.screenshot({ path: `${shots}/edit-how.png` });
});

test("Trim: the red piece is shown before the click, one click cuts it, and Back puts the person's sketch back", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await ownRectangle(page);
  const calls = tree.calls.length;
  await showMe(page, "trim");
  await expect(canvas, "every line is drawn as its pieces").toHaveAttribute("data-sketch-trim-pieces", "5");
  await expect(canvas, "the overhang is red before the pointer moves").toHaveAttribute("data-sketch-trim-hot", "3:1");
  if (shots) await page.screenshot({ path: `${shots}/trim-demo.png` });
  const aim = await aimOf(page);
  await page.mouse.move(aim.x, aim.y);
  await expect(canvas).toHaveAttribute("data-sketch-trim-hot", "3:1");
  await page.mouse.click(aim.x, aim.y);
  await made(page, tree, "trim", calls);
  await expect(canvas, "the outline is four clean sides").toHaveAttribute("data-sketch-kinds", "line,line,line,line");
  await expect(page.locator("button[data-sketch-extrude]")).toHaveAttribute("aria-disabled", "false");
  if (shots) await page.screenshot({ path: `${shots}/trim-done.png` });
  await back(page);
});

test("Offset: Both sides and Close the ends are on, 1.5 and Enter make a wall that extrudes", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await ownRectangle(page);
  const calls = tree.calls.length;
  await showMe(page, "offset");
  await expect(canvas).toHaveAttribute("data-sketch-wall", "both,close,helper");
  const options = page.locator("[role=group][aria-label='Offset options']");
  await expect(options.getByRole("button", { name: "Both sides" })).toHaveAttribute("aria-pressed", "true");
  await expect(options.getByRole("button", { name: "Close the ends" })).toHaveAttribute("aria-pressed", "true");
  await expect(options.getByRole("button", { name: "Keep the line as a helper" })).toHaveAttribute("aria-pressed", "true");
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").first().fill("1.5");
  await expect(options, "the wall's thickness shows while it is typed").toContainText("Wall 3 mm");
  if (shots) await page.screenshot({ path: `${shots}/offset-demo.png` });
  await hud.locator("input").first().press("Enter");
  await made(page, tree, "offset", calls);
  await expect(canvas, "the route is a helper line now").toHaveAttribute("data-sketch-construction", "2");
  await expect(page.locator("button[data-sketch-extrude]"), "the wall is a shape").toHaveAttribute("aria-disabled", "false");
  if (shots) await page.screenshot({ path: `${shots}/offset-done.png` });
  await back(page);
  await expect(canvas, "the person's own offset starts with every option off").toHaveAttribute("data-sketch-wall", "");
});

test("Fillet corner: a click on the corner point, 4 and Enter", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await ownRectangle(page);
  const calls = tree.calls.length;
  await showMe(page, "fillet");
  const aim = await aimOf(page);
  await page.mouse.click(aim.x, aim.y);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud.locator("input").first()).toBeVisible();
  await hud.locator("input").first().fill("4");
  if (shots) await page.screenshot({ path: `${shots}/fillet-demo.png` });
  await hud.locator("input").first().press("Enter");
  await made(page, tree, "fillet", calls);
  await expect(canvas).toHaveAttribute("data-sketch-kinds", /arc/);
  await back(page);
});

test("Helper line: one click makes the middle line a helper, and the plate is one shape", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await ownRectangle(page);
  const calls = tree.calls.length;
  await showMe(page, "construction");
  await expect(canvas).toHaveAttribute("data-sketch-construction", "0");
  const aim = await aimOf(page);
  await page.mouse.click(aim.x, aim.y);
  await made(page, tree, "construction", calls);
  await expect(canvas).toHaveAttribute("data-sketch-construction", "1");
  if (shots) await page.screenshot({ path: `${shots}/helper-done.png` });
  await back(page);
});

test("Copy edge: the face brightens under the pointer, and a click inside copies its outline and hole", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await ownRectangle(page);
  const calls = tree.calls.length;
  await showMe(page, "use");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "");
  const aim = await aimOf(page);
  await page.mouse.move(aim.x, aim.y);
  await expect(canvas, "the whole outline brightens: four sides and the hole's 32 pieces").toHaveAttribute("data-sketch-ref-hot", "36");
  if (shots) await page.screenshot({ path: `${shots}/copy-edge-demo.png` });
  await page.mouse.click(aim.x, aim.y);
  await made(page, tree, "use", calls);
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line,line,line,circle");
  await back(page);
});

test("A 2 mm wall from one line: Offset, Close the ends, 2, Enter, then Extrude", async ({ page }) => {
  await start(page);
  const canvas = page.locator("#model");
  // One line, typed: 30 mm along X from the canvas centre.
  await page.locator("[data-sketch-tool=line]").click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").nth(0).fill("30");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("0");
  await hud.locator("input").nth(1).press("Enter");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line");
  await expect(page.locator("button[data-sketch-extrude]")).toHaveAttribute("aria-disabled", "true");

  await page.keyboard.press("F");
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "offset");
  const options = page.locator("[role=group][aria-label='Offset options']");
  await options.getByRole("button", { name: "Close the ends" }).click();
  await expect(canvas, "one side closed: the line stays the wall's side").toHaveAttribute("data-sketch-wall", "close,helper");
  await expect(options.getByRole("button", { name: "Keep the line as a helper" }), "so there is no helper option").toHaveCount(0);
  // Click the line at its middle, between its two points.
  const hits = ((await canvas.getAttribute("data-sketch-hits")) ?? "").split(" ").filter(Boolean).map((item) => item.split(":")[1]!.split(",").map(Number));
  expect(hits.length).toBe(2);
  const mid = { x: (hits[0]![0]! + hits[1]![0]!) / 2, y: (hits[0]![1]! + hits[1]![1]!) / 2 };
  await page.mouse.click(mid.x, mid.y);
  await hud.locator("input").first().fill("2");
  await expect(options).toContainText("Wall 2 mm");
  await hud.locator("input").first().press("Enter");
  await expect(canvas, "the line, its copy, and the two ends").toHaveAttribute("data-sketch-kinds", "line,line,line,line");
  await expect(canvas).toHaveAttribute("data-sketch-construction", "0");
  await expect(page.locator("button[data-sketch-extrude]"), "the wall extrudes").toHaveAttribute("aria-disabled", "false");
  if (shots) await page.screenshot({ path: `${shots}/wall-own.png` });
});

test("Shift+X draws helper lines; L draws solid ones again", async ({ page }) => {
  await start(page);
  const canvas = page.locator("#model");
  await page.mouse.move(700, 500);
  await page.keyboard.press("Shift+X");
  await expect(canvas).toHaveAttribute("data-sketch-helper-line", "1");
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "line");
  await expect(page.locator("#modelReadout")).toContainText("Helper line.");
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").nth(0).fill("20");
  await hud.locator("input").nth(0).press("Enter");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line");
  await expect(canvas, "drawn as a helper line from the start").toHaveAttribute("data-sketch-construction", "1");
  await page.keyboard.press("L");
  await expect(canvas).toHaveAttribute("data-sketch-helper-line", "");
});
