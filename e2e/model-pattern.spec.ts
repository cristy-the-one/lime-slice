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
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const [pa, pb] = [corners[a!]!, corners[b!]!];
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 400 })), edges };
}

/**
 * Cylinder cuts, a pocket, or a mirror. A pattern's group holds only the new copies; the source step is its own row.
 */
function cutVolume(parent: MockSolid, op: Body): number {
  const source = (op.source ?? {}) as { kind?: string; width?: number; height?: number; depth?: number };
  if (source.kind === "pocket") return Math.round(parent.volumeMm3 - (source.width ?? 0) * (source.height ?? 0) * (source.depth ?? 0));
  if (source.kind === "mirror") return parent.volumeMm3 - 32;
  if (op.kind === "boolean" && op.op === "cut" && op.primitive === "cylinder") {
    const radius = op.radius as number;
    const height = op.height as number;
    return Math.round(parent.volumeMm3 - Math.PI * radius * radius * height);
  }
  if (op.kind === "group" && source.kind === "pattern") {
    const steps = ((op.steps ?? []) as Body[]).filter((step) => step.kind === "boolean" && step.op === "cut" && step.primitive === "cylinder");
    const seen = new Set(steps.map((step) => (step.origin as number[]).map((value) => value.toFixed(3)).join(",")));
    const radius = (steps[0]?.radius as number) ?? 0;
    const height = (steps[0]?.height as number) ?? 0;
    return Math.round(parent.volumeMm3 - seen.size * Math.PI * radius * radius * height);
  }
  return parent.volumeMm3;
}

async function openModel(page: Page): Promise<TreeMock> {
  const root = boxSolid();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => root,
    apply: (request: Body, parent: MockSolid) => boxSolid(cutVolume(parent, request.op as Body)),
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

async function setField(page: Page, id: string, value: string) {
  await page.locator(`#${id}`).fill(value);
  await page.locator(`#${id}`).dispatchEvent("input");
}

async function cutCylinder(page: Page) {
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelCut").click();
  await page.locator("#modelPrim [data-kind=cylinder]").click();
  await setField(page, "modelX", "10");
  await setField(page, "modelY", "14");
  await setField(page, "modelZ", "0");
  await setField(page, "modelRadius", "1.5");
  await setField(page, "modelHeight", "10");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree [role=treeitem]")).toHaveCount(2);
}

test("a polar pattern of a cylinder is one row of six cuts", async ({ page }) => {
  const tree = await openModel(page);
  await cutCylinder(page);
  const one = Math.round(4000 - Math.PI * 1.5 * 1.5 * 10);
  await expect(page.locator("#modelReadout")).toContainText(`Volume ${one} mm³`);

  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuPattern").click();
  await expect(page.locator("#modelToolFeatures")).toHaveText("Pattern");
  const rows = page.locator("#modelHistoryTree [role=treeitem]");
  await expect(rows.nth(1)).toHaveAttribute("data-repeat", "");
  await rows.nth(1).click({ modifiers: ["Control"] });
  await expect(rows.nth(1)).not.toHaveAttribute("data-repeat", "");
  await rows.nth(1).click({ modifiers: ["Control"] });
  await expect(rows.nth(1)).toHaveAttribute("data-repeat", "");

  await page.locator("#modelPatMode [data-pat=polar]").click();
  await expect(page.locator("#modelPatCx")).toHaveValue("10");
  await expect(page.locator("#modelPatCy")).toHaveValue("10");
  await expect(page.locator("#modelPatCz")).toHaveValue("5");
  await setField(page, "modelPatCount", "6");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();

  const six = Math.round(4000 - 6 * Math.PI * 1.5 * 1.5 * 10);
  await expect(page.locator("#modelReadout")).toContainText(`Volume ${six} mm³`);
  await expect(page.locator("#modelHistoryTree [role=treeitem]").filter({ hasText: "Pattern" })).toHaveCount(1);
  const op = tree.of("apply").at(-1)!.op as { kind: string; source: { kind: string; of: number[]; polar: { count: number } }; steps: unknown[] };
  expect(op.kind).toBe("group");
  expect(op.source.kind).toBe("pattern");
  expect(op.source.of).toEqual([1]);
  expect(op.source.polar.count).toBe(6);
  expect(op.steps, "five copies; the original stays its own row").toHaveLength(5);

  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await expect(page.locator("#modelPatCount")).toHaveValue("6");
  await setField(page, "modelPatCount", "4");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree [role=treeitem]").filter({ hasText: "Pattern × 4" })).toHaveCount(1);
  const edited = tree.of("edit").at(-1)!.op as { source: { polar: { count: number } }; steps: unknown[] };
  expect(edited.source.polar.count).toBe(4);
  expect(edited.steps).toHaveLength(3);
});

test("a step arrow drags the pattern distance", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuPattern").click();
  await expect(page.locator("#modelPatSx")).toHaveValue("10");
  await expect.poll(async () => page.locator("#model").getAttribute("data-handles")).toContain("pat-step-x");
  const box = (await page.locator("#model").boundingBox())!;
  const handles = ((await page.locator("#model").getAttribute("data-handles")) ?? "").split(" ");
  const at = handles.find((item) => item.startsWith("pat-step-x:"))!.split(":")[1]!.split(",").map(Number);
  await page.mouse.move(box.x + at[0]!, box.y + at[1]!);
  await page.mouse.down();
  await page.mouse.move(box.x + at[0]! + 40, box.y + at[1]!, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Number(await page.locator("#modelPatSx").inputValue())).not.toBe(10);
});

test("a mirror of a pocket is one row of the reflection; the pocket stays its own row", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolFeatures").click();
  const [x, y, w, h] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const canvas = (await page.locator("#model").boundingBox())!;
  await page.mouse.click(canvas.x + x! + w! * 0.5, canvas.y + y! + h! * 0.5);
  await setField(page, "modelFeatW", "4");
  await setField(page, "modelFeatH", "4");
  await setField(page, "modelFeatDepth", "2");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3968 mm³");

  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuMirror").click();
  await page.locator("#modelMirPlane [data-plane=x]").click();
  await expect(page.locator("#modelMirX")).toHaveValue("10");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3936 mm³");
  const op = tree.of("apply").at(-1)!.op as { kind: string; source: { kind: string; keepOriginal?: boolean; of: number[] }; steps: unknown[] };
  expect(op.kind).toBe("group");
  expect(op.source.kind).toBe("mirror");
  expect(op.source.keepOriginal).toBeUndefined();
  expect(op.source.of).toEqual([1]);
  expect(op.steps, "the reflection only").toHaveLength(1);
  await expect(page.locator("#modelMirKeep"), "Mirror always keeps the pocket").toHaveCount(0);
});

test("editing the patterned step moves the copies with it", async ({ page }) => {
  const tree = await openModel(page);
  await cutCylinder(page);
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuPattern").click();
  const rows = page.locator("#modelHistoryTree [role=treeitem]");
  await expect(rows.nth(1), "the step on screen is the source").toHaveAttribute("data-repeat", "");
  await page.locator("#modelPatMode [data-pat=linear]").click();
  await setField(page, "modelPatSx", "5");
  await setField(page, "modelPatSy", "0");
  await setField(page, "modelPatSz", "0");
  await setField(page, "modelPatCount", "3");
  await setField(page, "modelPatCount2", "1");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(rows.filter({ hasText: "Pattern × 3" })).toHaveCount(1);

  await rows.nth(1).click();
  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await setField(page, "modelX", "12");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(rows.filter({ hasText: "Pattern × 3" })).toHaveCount(2);
  const edit = tree.of("edit").at(-1)!;
  const replayed = (edit.replay as { op: { source: { of: number[] }; steps: { origin: number[] }[] } }[])[0]!.op;
  expect(replayed.source.of, "the pattern names the edited step's new id").toEqual([edit.node]);
  expect(replayed.steps.map((step) => step.origin[0]), "the copies follow the source to X 12").toEqual([17, 22]);
});

test("a polar pattern about an edge turns about that edge, where it is", async ({ page }) => {
  await openModel(page);
  await cutCylinder(page);
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuPattern").click();
  await page.locator("#modelPatMode [data-pat=polar]").click();
  await page.locator("#modelPatAxis [data-axis=pick]").click();
  await expect(page.locator("#modelPickEdge"), "Edge picks edges").toHaveAttribute("aria-pressed", "true");
  const box = (await page.locator("#model").boundingBox())!;
  let picked = "";
  for (let r = 0; r < 9 && !picked; r += 1) {
    for (let col = 0; col < 9 && !picked; col += 1) {
      await page.mouse.click(box.x + box.width * (0.18 + col * 0.08), box.y + box.height * (0.18 + r * 0.08));
      const text = await page.locator("#modelReadout").innerText();
      if (/Edge \d+/.test(text)) picked = text;
    }
  }
  expect(picked, "an edge is under the scan").not.toBe("");
  // Every box edge lies on x, y in {0, 20} or z in {0, 10}: the centre sits on the picked edge, not the solid's middle.
  const centre = [Number(await page.locator("#modelPatCx").inputValue()), Number(await page.locator("#modelPatCy").inputValue()), Number(await page.locator("#modelPatCz").inputValue())];
  const onEdge = [centre[0] === 0 || centre[0] === 20, centre[1] === 0 || centre[1] === 20, centre[2] === 0 || centre[2] === 10].filter(Boolean).length;
  expect(onEdge, `centre ${centre.join(", ")} lies on an edge`).toBe(2);
});

test("while Pattern is open, History rows are chosen by a click or Space, and the arrows show no step", async ({ page }) => {
  const tree = await openModel(page);
  await cutCylinder(page);
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuPattern").click();
  const list = page.locator("#modelHistoryTree");
  const rows = list.locator("[role=treeitem]");
  await expect(list).toHaveAttribute("aria-multiselectable", "true");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "step");

  // A plain click takes the row out, and the solid on screen stays.
  const gotos = tree.of("goto").length;
  await rows.nth(1).click();
  await expect(rows.nth(1)).not.toHaveAttribute("data-repeat", "");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#modelNote")).toHaveText("Click history rows to choose steps.");
  // Up moves to the root without showing it; Down and Space choose the cut again.
  await page.keyboard.press("ArrowUp");
  await expect(rows.nth(0)).toBeFocused();
  await page.waitForTimeout(400);
  await expect(rows.nth(1)).toHaveAttribute("data-state", "current");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(rows.nth(1)).toHaveAttribute("data-repeat", "");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  expect(tree.of("goto").length, "no step was asked for").toBe(gotos);

  // Closed, History shows the step on screen again.
  await page.locator("#modelCancel").click();
  await expect(list).toHaveAttribute("aria-multiselectable", "false");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "false");
  await expect(rows.nth(1)).not.toHaveAttribute("aria-current", /.*/);
});
