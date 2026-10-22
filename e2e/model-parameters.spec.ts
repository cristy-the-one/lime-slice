import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

function boxSolid(volumeMm3: number): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 10, y * 10, z * 10];
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
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 100 })), edges: [] };
}

function volumeOf(request: Body): number {
  const primitive = request.primitive as { size?: number[] } | undefined;
  const op = request.op as { kind?: string; size?: number[] } | undefined;
  const size = primitive?.size ?? (op?.kind === "root" ? op.size : undefined);
  if (size && size.length >= 3) return (size[0] ?? 0) * (size[1] ?? 0) * (size[2] ?? 0);
  return 4000;
}

async function openModel(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid(4000).positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => boxSolid(volumeOf(request)),
    apply: (request) => boxSolid(volumeOf(request)),
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

test("parameters panel and an expression in a number field", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuParameters").click();
  await expect(page.locator("#modelParamsMain")).toBeVisible();
  await page.keyboard.press("Control+Alt+p");
  await expect(page.locator("#modelParamsMain")).toBeHidden();
  await page.keyboard.press("Control+Alt+p");
  await expect(page.locator("#modelParamsMain")).toBeVisible();

  await page.locator("#modelParams [data-param-name]").fill("wallH");
  await page.locator("#modelParams [data-param-value]").fill("30");
  await page.locator("#modelToolNew").click();
  const height = page.locator("#modelDz");
  await height.focus();
  await height.fill("wallH");
  await height.blur();
  await expect(height).toHaveValue("30");
  await expect(height.locator("xpath=following-sibling::span[contains(@class,'expr-mark')]")).toBeVisible();

  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3000 mm³");

  await page.locator("#modelParams [data-param-value]").fill("40");
  await page.locator("#modelParams [data-param-value]").blur();
  await expect(page.locator("#modelParamsRebuild")).toHaveText("Rebuild 1 step");
  await page.locator("#modelParamsRebuild").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await expect(page.locator("#modelParamsRebuild")).toBeHidden();

  // Undo shows the 30 tall step again: it is out of date at wallH 40, and Rebuild brings it back.
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3000 mm³");
  await expect(page.locator("#modelParamsRebuild")).toHaveText("Rebuild 1 step");
  await page.locator("#modelParamsRebuild").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await expect(page.locator("#modelParamsRebuild")).toBeHidden();
});

// The owner's 3.1.0 report: "Rebuild 2 steps" over a new ellipsoid whose History is only its root, with 0 parameters.
// The count was the last object's, painted before the new solid opened.
test("Rebuild counts the open object's steps: none on a new solid after an out-of-date one", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuParameters").click();
  await page.locator("#modelParams [data-param-name]").fill("wallH");
  await page.locator("#modelParams [data-param-value]").fill("30");
  await page.locator("#modelToolNew").click();
  const height = page.locator("#modelDz");
  await height.focus();
  await height.fill("wallH");
  await height.blur();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3000 mm³");
  await page.locator("#modelParams [data-param-value]").fill("40");
  await page.locator("#modelParams [data-param-value]").blur();
  await expect(page.locator("#modelParamsRebuild")).toHaveText("Rebuild 1 step");

  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="ellipsoid"]').click();
  for (const [id, text] of [["modelDx", "86.2"], ["modelDy", "10"], ["modelDz", "24"]] as const) {
    await page.locator(`#${id}`).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type(text);
  }
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree")).toHaveText("Ellipsoid 86.2×10×24");
  await expect(page.locator("#modelParamsRebuild"), "the new solid has nothing out of date").toBeHidden();

  // Undo takes the new solid back off the plate. Back on the box, its step is still out of date at wallH 40.
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelHistoryTree")).not.toContainText("Ellipsoid");
  await expect(page.locator("#modelParamsRebuild")).toHaveText("Rebuild 1 step");
});

test("a repaint keeps every row valid, and a row that names an edited parameter follows it", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuParameters").click();
  const rows = page.locator("#modelParams [data-param-row]");
  await rows.nth(0).locator("[data-param-name]").click();
  await page.keyboard.type("a");
  await rows.nth(0).locator("[data-param-value]").click();
  await page.keyboard.type("2");
  await page.locator("#modelParamsAdd").click();
  await rows.nth(1).locator("[data-param-name]").click();
  await page.keyboard.type("b");
  await rows.nth(1).locator("[data-param-value]").click();
  await page.keyboard.type("a * 3");
  await expect(rows.nth(1).locator("[data-param-eval]")).toHaveText("6");

  await page.keyboard.press("Control+Alt+p");
  await page.keyboard.press("Control+Alt+p");
  await expect(rows).toHaveCount(2);
  await expect(page.locator("#modelParams [data-param-error]:not([hidden])"), "a repaint marks no row a duplicate").toHaveCount(0);
  await expect(rows.nth(0).locator("[data-param-eval]")).toHaveText("2");
  await expect(rows.nth(1).locator("[data-param-eval]")).toHaveText("6");

  await rows.nth(0).locator("[data-param-value]").selectText();
  await page.keyboard.type("5");
  await expect(rows.nth(1).locator("[data-param-eval]"), "b = a * 3 follows a").toHaveText("15");
});

test("an open tool's expression field and its dry-run follow a changed parameter", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuParameters").click();
  const row = page.locator("#modelParams [data-param-row]").first();
  await row.locator("[data-param-name]").click();
  await page.keyboard.type("w");
  await row.locator("[data-param-value]").click();
  await page.keyboard.type("6");

  await page.locator("#modelToolFeatures").click();
  const [x, y, w, h] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.click(box.x + x! + w! * 0.5, box.y + y! + h! * 0.5);
  const width = page.locator("#modelFeatW");
  await width.click();
  await page.keyboard.type("w");
  await page.keyboard.press("Tab");
  await expect(width).toHaveValue("6");
  await expect.poll(() => (tree.of("probe").at(-1)?.op as { source?: { width?: number } } | undefined)?.source?.width).toBe(6);

  await row.locator("[data-param-value]").selectText();
  await page.keyboard.type("8");
  await expect(width, "the field shows the new value").toHaveValue("8");
  await expect.poll(() => (tree.of("probe").at(-1)?.op as { source?: { width?: number } } | undefined)?.source?.width, "the dry-run asks again").toBe(8);
  // Typing a parameter is one dry-run after the pause, not one per keystroke.
  const probes = tree.of("probe").length;
  await row.locator("[data-param-value]").selectText();
  await page.keyboard.type("12");
  await expect(width).toHaveValue("12");
  await page.waitForTimeout(1000);
  expect(tree.of("probe").length - probes, "one probe for two keystrokes").toBe(1);

  // A name the table does not have is told in the app's words.
  await width.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("nope");
  await page.keyboard.press("Tab");
  await expect(width).toHaveAttribute("title", '"nope" is not a parameter. Add it in Parameters, or type a number.');
});

test("Parameters folds on Escape, Add focuses the new row, and the Features menu takes arrow keys", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelFeatureMore").click();
  const items = page.locator("#modelFeatureMenu [role=menuitem]");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.last(), "Up from the first goes round to the last").toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await expect(page.locator("#modelFeatureMenu [role=menuitem][aria-pressed]"), "a menu item is not a toggle").toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelFeatureMenu")).toBeHidden();
  await expect(page.locator("#modelFeatureMore")).toBeFocused();

  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  // Parameters is no longer the last item (Stress… follows it), so it is reached by name.
  await page.locator("#modelMenuParameters").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelParamsMain")).toBeVisible();
  await expect(page.locator("#modelParams th").last()).toHaveText("Order and delete");
  await page.locator("#modelParams [data-param-name]").first().click();
  await page.keyboard.type("a");
  await page.locator("#modelParamsAdd").click();
  await expect(page.locator("#modelParams [data-param-name]").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelParamsMain")).toBeHidden();
  await expect(page.locator("#modelParamsToggle")).toBeFocused();
});
