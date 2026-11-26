import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

const BUILDING = "Model is still building.";

type V = [number, number, number];

/** One open quad: a sheet the modeler reports as not a solid, with one naked edge. */
function sheet(): MockSolid {
  const corners: V[] = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0]];
  const positions = [...corners[0]!, ...corners[1]!, ...corners[2]!, ...corners[0]!, ...corners[2]!, ...corners[3]!];
  return {
    volumeMm3: 0,
    positions,
    triangles: [0, 0],
    faces: [{ id: 0, areaMm2: 400 }],
    edges: [{ id: 0, lengthMm: 20, points: [...corners[0]!, ...corners[1]!] }],
    solid: false,
    nakedEdges: [0],
  };
}

/** The same quad, closed, after Thicken. */
function closed(): MockSolid {
  const open = sheet();
  return { ...open, volumeMm3: 800, solid: true, nakedEdges: [] };
}

/** A 20 x 20 x 10 box, as the modeler reports a solid. */
function box(): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * 10];
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
  return { volumeMm3: 4000, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [{ id: 0, lengthMm: 20, points: [0, 0, 0, 20, 0, 0] }] };
}

let releaseHold = () => {};
const held = new Promise<void>((resolve) => {
  releaseHold = resolve;
});
let holdApply = false;

async function load(page: Page, root: MockSolid) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => root,
    apply: (request) => {
      const kind = (request.op as Body | undefined)?.kind;
      if (kind === "boolean") return sheet();
      if (kind === "thicken" || kind === "sew") return closed();
      return { error: `unexpected ${String(kind)}` };
    },
    probe: () => ({ ok: true }),
    applyGate(request) {
      const kind = (request.op as Body | undefined)?.kind;
      if (!holdApply || kind !== "sew") return;
      holdApply = false;
      return held;
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "roof.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  return tree;
}

test("Thicken, Edit and Undo wait while Model is still building", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const tree = await load(page, box());
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelCut").click();
  await page.locator("#modelDx").fill("8");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelSheetBar")).toBeVisible();

  holdApply = true;
  const applies = tree.of("apply").length;
  const gotos = tree.of("goto").length;
  await page.locator("#modelSheetSewGo").click();
  await expect.poll(() => tree.of("apply").length).toBe(applies + 1);

  const edit = page.locator("#modelHistoryTree .mh-edit:visible");
  const thicken = page.locator("#modelSheetThickenGo");
  const undo = page.locator("#modelUndo");
  await expect(thicken).toBeDisabled();
  await expect(thicken).toHaveAttribute("title", BUILDING);
  await expect(page.locator("#modelSheetSewGo")).toBeDisabled();
  await expect(page.locator("#modelSheetSewGo")).toHaveAttribute("title", BUILDING);
  await expect(edit).toBeDisabled();
  await expect(edit).toHaveAttribute("title", BUILDING);
  await expect(undo).toBeDisabled();
  await expect(undo).toHaveAttribute("title", BUILDING);
  await expect(page.locator("#modelApply")).toBeDisabled();
  await expect(page.locator("#modelApply")).toHaveAttribute("title", BUILDING);
  await page.screenshot({ path: "test-results/model-busy/disabled.png" });

  await page.keyboard.press("Control+z");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Enter");
  await expect.poll(() => tree.of("goto").length).toBe(gotos);
  await expect.poll(() => tree.of("apply").length).toBe(applies + 1);

  releaseHold();
  await expect(page.locator("#modelSheetBar")).toBeHidden();
  await expect(edit).toBeEnabled();
  await expect(edit).not.toHaveAttribute("title", BUILDING);
  await expect(undo).toBeEnabled();
  await expect(undo).not.toHaveAttribute("title", BUILDING);
  await page.evaluate(() => document.querySelectorAll<HTMLButtonElement>('[role="alert"] button').forEach((button) => button.click()));

  await undo.click();
  await expect(page.locator("#modelSheetBar")).toBeVisible();
  await expect(thicken).toBeEnabled();
  await expect(thicken).not.toHaveAttribute("title", BUILDING);

  const redo = page.locator("#modelRedo");
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(page.locator("#modelSheetBar")).toBeHidden();
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(page.locator("#modelDx")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelDx")).toBeHidden();
  await expect(page.locator("#modelSheetBar")).toBeVisible();
  await page.locator("#modelSheetThickenMm").fill("2");
  await expect(thicken).toBeEnabled();
  await thicken.click();
  await expect.poll(() => tree.of("apply").filter((call) => (call.op as Body | undefined)?.kind === "thicken").length).toBe(1);
  await expect(page.locator("#modelSheetBar")).toBeHidden();
});
