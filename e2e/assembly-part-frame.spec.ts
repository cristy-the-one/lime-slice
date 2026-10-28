import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid, type TreeMock } from "./model-tree-mock";

/**
 * Assemblies M10 (docs/plan-assemblies.md, D12). A part-frame member that stands turned in its assembly opens in Model in
 * its own frame: it is drawn as it was modelled, the other objects turn around it, a typed number is a number of the
 * part's own frame, and Place and Ctrl-drag move the assembly pose while the part stays put on screen.
 */

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "assembly-part-frame");

type V = [number, number, number];

/** A box the modeler reports as a solid, in its own CAD frame, from `at`. */
function boxSolid(size: V, at: V = [0, 0, 0]): MockSolid {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [at[0] + x * sx, at[1] + y * sy, at[2] + z * sz];
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
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

const SOLIDS: Record<string, MockSolid> = {
  // The body sits 60 mm along X in its own file, as parts exported from one assembly do.
  "body.step": boxSolid([40, 30, 20], [60, 0, 0]),
  "hook.step": boxSolid([20, 20, 10]),
};

async function commit(page: Page, id: string, value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

const canvas = (page: Page) => page.locator("#model");
const field = async (page: Page, id: string) => Number(await page.locator(id).inputValue());
const placed = async (page: Page) => Promise.all(["#modelPlaceX", "#modelPlaceY", "#modelPlaceZ", "#modelPlaceRz"].map((id) => field(page, id)));
const solidBox = async (page: Page) => (await canvas(page).getAttribute("data-solid")) ?? "";
const contextBox = async (page: Page) => (((await canvas(page).getAttribute("data-context")) ?? "").split(" ")[0] ?? "").split(":")[1] ?? "";

/** The body and the hook on the bed, the hook attached to the body: the body is the root, the hook a part-frame member. */
async function assembled(page: Page): Promise<{ tree: TreeMock; hook: string }> {
  const named = (route: { request(): { postDataJSON(): { filename?: string } } }) => SOLIDS[route.request().postDataJSON().filename ?? ""]!;
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-theme", "dark");
    localStorage.setItem("lime-slice-closed-groups", "[]");
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: named(route).positions } }));
  const tree = await mockModelTree(page, {
    open: (request) => SOLIDS[String(request.filename)]!,
    apply: (_request, parent) => ({ ...parent, volumeMm3: parent.volumeMm3 - 50 }),
    probe: () => ({ ok: true }),
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  const step = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  await page.locator("#file").setInputFiles({ name: "body.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabPrepare").click();
  await commit(page, "#placeX", 100);
  await commit(page, "#placeY", 100);
  await page.locator("#plateAddFile").setInputFiles({ name: "hook.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await commit(page, "#placeX", 160);
  await commit(page, "#placeY", 100);
  const hook = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  const body = (await page.locator("[data-plate-select]").first().getAttribute("data-plate-select"))!;
  await page.locator(`[data-plate-select='${body}']`).click();
  await page.locator(`[data-plate-attach='${hook}']`).click();
  await expect(page.locator("[data-assembly-head]")).toContainText("2 parts");
  await page.locator(`[data-plate-select='${hook}']`).click();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000");
  await expect(canvas(page)).toHaveAttribute("data-context-count", "1");
  return { tree, hook };
}

async function openPlace(page: Page) {
  if ((await page.locator("#modelToolPlace").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolPlace").click();
  await expect(page.locator("#modelPlaceX")).toBeVisible();
}

/** The top view, pulled back until both boxes are on screen, with the camera at rest. */
async function topView(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  // The key is the view's, not a field's that still has the focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("t");
  for (let i = 0; i < 9; i += 1) await page.mouse.wheel(0, 400);
  let last = "";
  await expect.poll(async () => {
    const now = `${await canvas(page).getAttribute("data-solid-screen")}|${await canvas(page).getAttribute("data-context-screen")}`;
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
}

async function screenRect(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  const [x, y, w, h] = ((await canvas(page).getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  return { cx: box.x + x! + w! / 2, cy: box.y + y! + h! / 2, w: w! };
}

test("a turned member opens in its own frame: typed numbers, Place and Ctrl-drag", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const { tree } = await assembled(page);
  // Where the files put them, the hook is in model space and the body beside it.
  expect(await solidBox(page)).toBe("0.00,0.00,0.00,20.00,20.00,10.00");
  expect(await contextBox(page)).toBe("60.00,0.00,0.00,100.00,30.00,20.00");

  // Turn the hook a quarter about Z in the assembly and move it: the hook stays as it was modelled, and the body turns
  // the other way about it. The hook turns about its centre (10, 10, 5), so its pose is Rz 90 then (50, 0, 0), and the
  // body's corners (60..100, 0..30) come back to (0..30, -50..-10) in the hook's own frame.
  await openPlace(page);
  await commit(page, "#modelPlaceRz", 90);
  await commit(page, "#modelPlaceX", 30);
  await expect.poll(() => contextBox(page)).toBe("0.00,-50.00,0.00,30.00,-10.00,20.00");
  expect(await solidBox(page), "the hook is drawn unturned").toBe("0.00,0.00,0.00,20.00,20.00,10.00");
  expect(await placed(page)).toEqual([30, 0, 0, 90]);
  // Place's arrows point along model X and Y, which the turn shows along the hook's own Y and -X.
  const arrows = (await canvas(page).getAttribute("data-handles")) ?? "";
  expect(arrows).toContain("place-x:");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, "part-frame-place.png") });
  await page.locator("#modelCancel").click();
  const view = (await canvas(page).boundingBox())!;
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  for (let i = 0; i < 4; i += 1) await page.mouse.wheel(0, 400);
  await page.mouse.move(view.x + view.width - 120, view.y + 260);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(shots, "part-frame-context.png") });

  // A hole typed at X = 10, Y = 5 is drilled at the hook's own (10, 5), exactly as typed.
  await page.locator("#modelToolHole").click();
  await commit(page, "#modelX", 10);
  await commit(page, "#modelY", 5);
  await commit(page, "#modelZ", 10);
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3950");
  const hole = tree.of("apply").at(-1)!.op as { kind: string; origin: number[]; axis: number[] };
  expect(hole.kind).toBe("hole");
  expect(hole.origin).toEqual([10, 5, 10]);
  expect(hole.axis).toEqual([0, 0, -1]);
  const applies = tree.of("apply").length;

  // Ctrl-drag moves the assembly pose: the view's +X is the hook's own +X, which the turn points along model +Y. The hook
  // stays put on screen and keeps its numbers; the body slides the other way.
  await openPlace(page);
  await topView(page);
  const at = await screenRect(page);
  const k = at.w / 20;
  await page.keyboard.down("Control");
  await page.mouse.move(at.cx, at.cy);
  await page.mouse.down();
  await page.mouse.move(at.cx + 8 * k, at.cy, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  const [x, y, z, rz] = await placed(page);
  expect(x, "model X is the hook's own Y, which did not move").toBeCloseTo(30, 1);
  expect(y).toBeGreaterThan(4);
  expect(y).toBeLessThan(12);
  expect([z, rz]).toEqual([0, 90]);
  expect(await solidBox(page), "the hook's own numbers stay").toBe("0.00,0.00,0.00,20.00,20.00,10.00");
  const [cx0] = (await contextBox(page)).split(",").map(Number);
  expect(cx0!, "the body moved back along the hook's X by the drag").toBeCloseTo(-y, 1);
  expect(tree.of("apply").length, "a move rebuilds nothing").toBe(applies);

  // Place moves it too, and Place Undo takes each step back.
  await commit(page, "#modelPlaceZ", 4);
  await expect.poll(() => contextBox(page)).toMatch(/,-4\.00,[^,]+,[^,]+,16\.00$/);
  await page.waitForTimeout(500);
  await page.locator("#modelUndo").click();
  await expect.poll(() => field(page, "#modelPlaceZ")).toBe(0);
  await page.locator("#modelUndo").click();
  await expect.poll(() => placed(page)).toEqual([30, 0, 0, 90]);
  await expect.poll(() => contextBox(page)).toBe("0.00,-50.00,0.00,30.00,-10.00,20.00");
  expect(await solidBox(page)).toBe("0.00,0.00,0.00,20.00,20.00,10.00");
});

test("a model-frame object still opens in model space", async ({ page }) => {
  const { tree } = await assembled(page);
  await openPlace(page);
  await commit(page, "#modelPlaceRz", 90);
  await page.locator("#modelCancel").click();

  // The body is the root, in the model frame: it is drawn where it sits in model space, and its numbers are model space.
  await page.locator("#tabPrepare").click();
  await page.locator("[data-plate-select]").first().click();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 24000");
  expect(await solidBox(page)).toBe("60.00,0.00,0.00,100.00,30.00,20.00");
  await openPlace(page);
  await commit(page, "#modelPlaceX", 5);
  await expect.poll(() => solidBox(page), "a move of the root moves it on screen").toBe("65.00,0.00,0.00,105.00,30.00,20.00");
  await page.locator("#modelCancel").click();

  // A hole typed at model X = 70 lands at the body's own X = 65.
  await page.locator("#modelToolHole").click();
  await commit(page, "#modelX", 70);
  await commit(page, "#modelY", 5);
  await commit(page, "#modelZ", 20);
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 23950");
  const hole = tree.of("apply").at(-1)!.op as { origin: number[] };
  expect(hole.origin).toEqual([65, 5, 20]);
});
