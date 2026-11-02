import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid, type TreeMock } from "./model-tree-mock";
import { DEMO_DONE, DEMOS, type DemoKind } from "../src/sketch/demos.ts";

/**
 * --- Sketch for people, milestone 5 (docs/plan-sketch-for-people.md, P2): Show me. Each Make tool's demo opens from a
 * How popover on a small ready-made sketch, the tool's next click works on it, Apply there sends nothing to the part,
 * and Back to my sketch puts the person's own sketch and feature back as they were. A broken tool or demo fails here. ---
 */

type V = [number, number, number];

/** A box the modeler can pick. Face 1 is +Z. */
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
  const tree = await mockModelTree(page, {
    open: () => boxSolid(),
    apply: (_request, parent) => parent,
    probe: () => ({ ok: true }),
  });
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
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill("12");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("8");
  await hud.locator("input").nth(1).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line,line,line");
  await page.keyboard.press("Escape");
}

/** The card's demo strip says which tool, and the next click. Nothing scrolls sideways. */
async function inDemo(page: Page, kind: DemoKind) {
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch-demo", kind);
  const strip = page.locator("[data-sketch-section=demo]");
  await expect(strip).toContainText(`Show me: ${DEMOS[kind].label}`);
  await expect(strip).toContainText(DEMOS[kind].tryIt);
  await expect(page.locator("#modelReadout")).toContainText(DEMOS[kind].tryIt);
  await expect(page.locator("button[data-sketch-finish]"), "a demo is never kept as a card").toHaveCount(0);
  await expect(page.locator("button[data-sketch-demo-leave]")).toHaveText("Back to my sketch");
  const sideways = await page.locator("#sketchCards").evaluate((node) => {
    let total = 0;
    for (let at: HTMLElement | null = node as HTMLElement; at && at !== document.body; at = at.parentElement) total += at.scrollLeft + Math.max(0, at.scrollWidth - at.clientWidth - 1);
    return total;
  });
  expect(sideways, "the demo fits the card").toBe(0);
}

/** Apply ran in the demo: the op its tool builds, the done line, and nothing sent to the part. */
async function made(page: Page, tree: TreeMock, kind: DemoKind, calls: number, objects: number) {
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch-demo-made", DEMOS[kind].op);
  await expect(page.locator("[data-sketch-section=demo]")).toContainText(DEMOS[kind].made);
  await expect(page.locator("#modelReadout")).toContainText(DEMO_DONE);
  await expect(canvas, "still in the demo").toHaveAttribute("data-sketch-demo", kind);
  expect(tree.calls.length, "the demo sent nothing to the modeler").toBe(calls);
  await expect(page.locator("#objectList .obj")).toHaveCount(objects);
}

const shots = process.env.LIME_SHOTS;

test("Extrude: Show me from the How, 8 and Enter, then back to the person's own extrude, which still applies", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await ownRectangle(page);
  await page.locator("button[data-sketch-extrude]").click();
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  // Their own distance, typed and not yet applied.
  const own = page.locator(".interact-hud:not([hidden])").locator("input").first();
  await own.fill("6");
  const value = page.locator("[data-sketch-section=feature] input[data-sketch-value]");
  await expect(value).toHaveValue("6");
  const how = page.locator("#sketchHow");
  await expect(how, "the How is open on a first visit").toBeVisible();
  const show = how.locator("button[data-sketch-demo]");
  await expect(show, "Show me is the How's first line").toHaveText("Show me");
  expect(await how.evaluate((node) => (node.firstElementChild as HTMLElement).dataset.sketchDemo)).toBe("extrude");
  if (shots) await page.screenshot({ path: `${shots}/extrude-how.png` });
  const calls = tree.calls.length;
  await show.click();

  await inDemo(page, "extrude");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  await expect(canvas, "the plate and its hole").toHaveAttribute("data-sketch-kinds", "line,line,line,line,circle");
  await expect(page.locator("[data-sketch-section=feature] .sketch-modes"), "a demo is a new object: no Join or Cut").toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/extrude-demo.png` });
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").first().fill("8");
  await hud.locator("input").first().press("Enter");
  await made(page, tree, "extrude", calls, 0);
  if (shots) await page.screenshot({ path: `${shots}/extrude-done.png` });

  await page.locator("button[data-sketch-demo-leave]").click();
  await expect(canvas).toHaveAttribute("data-sketch-demo", "");
  await expect(canvas, "the person's rectangle is back").toHaveAttribute("data-sketch-kinds", "line,line,line,line");
  await expect(canvas, "with their extrude still open").toHaveAttribute("data-extrude", "aim");
  await expect(value).toHaveValue("6");
  await expect(page.locator("#sketchHow"), "and the How as they left it").toBeVisible();
  await expect(page.locator("[data-sketch-section=demo]")).toHaveCount(0);
  await expect(page.locator("button[data-sketch-finish]")).toBeVisible();
  await page.locator("button[data-sketch-apply]").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  const feature = tree.of("open").at(-1)!.feature as { kind?: string; depth?: number };
  expect(feature.kind).toBe("extrude");
  expect(feature.depth, "their 6 mm, not the demo's 8").toBe(6);
});

test("Revolve: the helper line under Spin around, then Apply; Esc twice leaves the demo", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await ownRectangle(page);
  await page.locator("button[data-sketch-revolve]").click();
  await expect(canvas).toHaveAttribute("data-revolve", "aim");
  const calls = tree.calls.length;
  await page.locator("#sketchHow button[data-sketch-demo=revolve]").click();

  await inDemo(page, "revolve");
  await expect(canvas).toHaveAttribute("data-revolve", "aim");
  const axes = page.locator("[role=group][aria-label='Spin around']");
  await axes.getByRole("button", { name: "your helper line" }).click();
  await expect(axes.getByRole("button", { name: "your helper line" })).toHaveAttribute("aria-pressed", "true");
  await page.locator("button[data-sketch-apply]").click();
  await made(page, tree, "revolve", calls, 0);
  if (shots) {
    await page.mouse.move(190, 940);
    await page.screenshot({ path: `${shots}/revolve-done.png` });
  }

  // The first Esc closes the tool, the second the demo, as they close a feature and then the sketch.
  await page.mouse.move(700, 500);
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-revolve", "off");
  await expect(canvas).toHaveAttribute("data-sketch-demo", "revolve");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-sketch-demo", "");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line,line,line");
  await expect(canvas, "the person's revolve is back").toHaveAttribute("data-revolve", "aim");
  await expect(page.locator("#objectList .obj")).toHaveCount(0);
});

test("Loft: the top shape's card adds the second section, then Apply", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await ownRectangle(page);
  await page.locator("button[data-sketch-loft]").click();
  await expect(canvas).toHaveAttribute("data-loft", "pick");
  await expect(canvas).toHaveAttribute("data-loft-sections", "1");
  const calls = tree.calls.length;
  await page.locator("#sketchHow button[data-sketch-demo=loft]").click();

  await inDemo(page, "loft");
  await expect(canvas).toHaveAttribute("data-loft-sections", "1");
  await expect(canvas, "the person's sketch isn't a card in the demo").toHaveAttribute("data-sketch-kinds", "line,line,line,line");
  const top = page.locator("[data-sketch-open]").filter({ hasText: "Top shape" });
  await expect(top).toHaveCount(1);
  await expect(page.locator("[data-sketch-open]")).toHaveCount(1);
  await top.click();
  await expect(canvas).toHaveAttribute("data-loft-sections", "2");
  if (shots) await page.screenshot({ path: `${shots}/loft-demo.png` });
  await page.locator("button[data-sketch-apply]").click();
  await made(page, tree, "loft", calls, 0);

  await page.locator("button[data-sketch-demo-leave]").click();
  await expect(canvas).toHaveAttribute("data-loft", "pick");
  await expect(canvas, "the person's loft has its one section").toHaveAttribute("data-loft-sections", "1");
  await expect(page.locator("[data-sketch-open]").filter({ hasText: "Top shape" })).toHaveCount(0);
});

test("Sweep and Pipe from the Make row's How: Apply, and 8 then Enter", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await ownRectangle(page);
  const makeHow = page.locator("button[data-sketch-make-how]");
  await expect(makeHow).toHaveAttribute("aria-expanded", "false");
  await makeHow.click();
  const list = page.locator("#sketchMakeHow");
  await expect(list).toBeVisible();
  await expect(list.locator("button[data-sketch-demo]")).toHaveText(["Extrude", "Revolve", "Loft", "Sweep", "Pipe", "Holes"]);
  if (shots) await page.screenshot({ path: `${shots}/make-how.png` });
  const calls = tree.calls.length;
  await list.locator("button[data-sketch-demo=sweep]").click();

  await inDemo(page, "sweep");
  await expect(canvas).toHaveAttribute("data-sweep-made", "up");
  if (shots) await page.screenshot({ path: `${shots}/sweep-demo.png` });
  await page.locator("button[data-sketch-apply]").click();
  await made(page, tree, "sweep", calls, 0);
  await page.locator("button[data-sketch-demo-leave]").click();
  await expect(canvas).toHaveAttribute("data-sketch-demo", "");
  await expect(canvas).toHaveAttribute("data-sweep-made", "");
  await expect(page.locator("#sketchMakeHow"), "the Make row's How is as it was").toBeVisible();

  await page.locator("#sketchMakeHow button[data-sketch-demo=pipe]").click();
  await inDemo(page, "pipe");
  await expect(canvas).toHaveAttribute("data-sweep-made", "pipe");
  await expect(canvas, "the route's corner is rounded for the 5 mm pipe").toHaveAttribute("data-sweep-round", "2.5");
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").nth(0).fill("8");
  await expect(canvas).toHaveAttribute("data-sweep-round", "4");
  if (shots) await page.screenshot({ path: `${shots}/pipe-demo.png` });
  await hud.locator("input").nth(0).press("Enter");
  await made(page, tree, "pipe", calls, 0);
  await page.locator("button[data-sketch-demo-leave]").click();
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line,line,line");
});

test("Holes on a part: H and Yes pick the three circles, the part is untouched, and the Hole panel isn't opened", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await ownRectangle(page);
  await page.locator("button[data-sketch-extrude]").click();
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").first().fill("10");
  await hud.locator("input").first().press("Enter");
  await expect(page.locator("#objectList .obj")).toHaveCount(1);

  // A new sketch on the bed beside the part, with a circle of the person's own.
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await page.locator("[data-sketch-tool=circle]").click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await hud.locator("input").nth(0).fill("5");
  await hud.locator("input").nth(0).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "circle");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Holes (H)" })).toHaveAttribute("aria-disabled", "true");

  const calls = tree.calls.length;
  await page.locator("button[data-sketch-make-how]").click();
  await page.locator("#sketchMakeHow button[data-sketch-demo=holes]").click();
  await inDemo(page, "holes");
  await expect(canvas, "the demo stands on a face of its own").toHaveAttribute("data-sketch-plane", "face -1");
  await expect(page.getByRole("button", { name: "Holes (H)" })).toHaveAttribute("aria-disabled", "false");
  if (shots) await page.screenshot({ path: `${shots}/holes-demo.png` });
  await page.mouse.move(700, 500);
  await page.keyboard.press("H");
  await expect(page.locator("button[data-sketch-drill-yes]")).toHaveText("Yes, drill 3 holes");
  await page.locator("button[data-sketch-drill-yes]").click();
  await made(page, tree, "holes", calls, 1);
  await expect(page.locator("#modelPanel"), "the part's Hole panel stays shut").toBeHidden();
  await expect(canvas).toHaveAttribute("data-sketch-holes", "off");
  if (shots) await page.screenshot({ path: `${shots}/holes-done.png` });

  await page.locator("button[data-sketch-demo-leave]").click();
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "circle");
  await expect(canvas).toHaveAttribute("data-sketch-plane", "XY");
  expect(tree.calls.length, "nothing was sent while the demo was open").toBe(calls);
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
});
