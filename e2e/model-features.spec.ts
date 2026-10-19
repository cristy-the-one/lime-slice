import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 × 20 × 10 box from the origin. Face 1 is the top. */
function boxSolid(volumeMm3 = 4000): MockSolid {
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
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 400 })), edges: [] };
}

/** A rect pocket's volume: the cut comes out, the bars fuse back. The cut's extra millimetre is outside the solid. */
function pocketVolume(parent: MockSolid, op: Body): number {
  const source = (op.source ?? {}) as { width?: number; height?: number; depth?: number; bars?: { vertical?: number; horizontal?: number; width?: number } };
  const width = source.width ?? 0;
  const height = source.height ?? 0;
  const depth = source.depth ?? 0;
  const bars = source.bars;
  const bar = bars?.width ?? 1;
  const back = (bars?.vertical ?? 0) * bar * height * depth + (bars?.horizontal ?? 0) * width * bar * depth;
  return Math.round(parent.volumeMm3 - width * height * depth + back);
}

async function openModel(page: Page): Promise<TreeMock> {
  const root = boxSolid();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => root,
    apply: (request: Body, parent: MockSolid) => boxSolid(pocketVolume(parent, request.op as Body)),
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  return tree;
}

async function pickFace(page: Page) {
  const [x, y, w, h] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.click(box.x + x! + w! * 0.5, box.y + y! + h! * 0.5);
}

test("a pocket with bars is one history row, and editing its width rebuilds it", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolFeatures").click();
  await expect(page.locator("#modelNote")).toHaveText("Pick one flat face.");
  await expect(page.locator("#modelPickFace")).toHaveAttribute("aria-pressed", "true");
  await pickFace(page);
  await expect(page.locator("#modelReadout")).toContainText("Face");
  await page.locator("#modelFeatBarsV").fill("2");
  await page.locator("#modelFeatBarsV").dispatchEvent("input");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3840 mm³");
  await expect(page.locator("#modelHistoryTree [role=treeitem]")).toHaveCount(2);
  await expect(page.locator("#modelHistoryTree [role=treeitem]").nth(1)).toContainText("Pocket");
  const op = tree.of("apply").at(-1)!.op as { kind: string; label: string; steps: unknown[]; source: { kind: string; width: number; bars: { vertical: number } } };
  expect(op.kind).toBe("group");
  expect(op.label.startsWith("Pocket")).toBe(true);
  expect(op.steps).toHaveLength(3);
  expect(op.source.kind).toBe("pocket");
  expect(op.source.bars.vertical).toBe(2);

  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await expect(page.locator("#modelFeatW")).toHaveValue("10");
  await page.locator("#modelFeatW").fill("12");
  await page.locator("#modelFeatW").dispatchEvent("input");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3800 mm³");
  await expect(page.locator("#modelHistoryTree [role=treeitem]").filter({ hasText: "12" })).toHaveCount(1);
  const edited = tree.of("edit").at(-1)!.op as { source: { width: number }; label: string };
  expect(edited.source.width).toBe(12);
  expect(edited.label).toContain("12");
});

test("the Features menu keeps the last choice on the button", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelFeatureMore").click();
  await expect(page.locator("#modelFeatureMenu")).toBeVisible();
  await page.locator("#modelFeatureMenu [data-tool=boss]").click();
  await expect(page.locator("#modelFeatureMenu")).toBeHidden();
  await expect(page.locator("#modelToolFeatures")).toHaveText("Boss");
  await expect(page.locator("#modelToolFeatures")).toHaveAttribute("data-tool", "boss");
  await expect(page.locator("#modelToolFeatures")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelNote")).toHaveText("Pick one flat face.");
});

test("a texture pitch typed below its minimum, or one too small for the face, is refused before the engine sees it", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelFeatureMenu [data-tool=texture]").click();
  await pickFace(page);
  await expect(page.locator("#modelApply")).toBeEnabled();
  const probes = tree.of("probe").length;

  await page.locator("#modelTexPitchU").selectText();
  await page.keyboard.type("0.02");
  await expect(page.locator("#modelNote")).toHaveText("Pitch along U is at least 0.1.");
  await expect(page.locator("#modelApply")).toBeDisabled();
  await page.waitForTimeout(500);
  expect(tree.of("probe").length, "no dry-run of a value below the field's minimum").toBe(probes);

  await page.locator("#modelTexPattern [data-pattern=brick]").click();
  await page.locator("#modelTexGroove").selectText();
  await page.keyboard.type("0.1");
  await page.locator("#modelTexPitchU").selectText();
  await page.keyboard.type("0.5");
  await page.locator("#modelTexPitchV").selectText();
  await page.keyboard.type("0.5");
  await expect(page.locator("#modelNote")).toHaveText(/This texture makes about \d+ grooves, more than 400\./);
  await expect(page.locator("#modelApply")).toBeDisabled();

  await page.locator("#modelTexPitchV").selectText();
  await page.keyboard.type("0.1");
  await expect(page.locator("#modelNote")).toHaveText("A groove must be narrower than the pitch.");
});

test("the position dot follows From, where the pocket is cut", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelToolFeatures").click();
  await pickFace(page);
  await expect(page.locator("#modelApply")).toBeEnabled();
  const dot = async () => ((await page.locator("#model").getAttribute("data-handles")) ?? "").split(" ").find((item) => item.startsWith("feat-at:")) ?? "";
  await expect.poll(dot).not.toBe("");
  const centred = await dot();
  await page.locator("#modelFeatFrom [data-from=corner]").click();
  await expect.poll(dot, "the dot moves to the face's corner, as the cut does").not.toBe(centred);
});
