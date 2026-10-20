/**
 * The aspect a handle lights: rims, holes, a plane, the keyboard, and a count with no edge.
 */
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

function boxSolid() {
  const c = (x: number, y: number, z: number) => [x * 20, y * 20, z * 10];
  const quads = [
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
  const corners = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => ({ id, lengthMm: 1, points: [...corners[a!]!, ...corners[b!]!] }));
  return { volumeMm3: 4000, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 1 })), edges };
}

async function openModel(page: Page) {
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid, probe: () => ({ ok: true }) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
}

async function expectLit(page: Page, field: string, tip: RegExp) {
  await page.locator(field).focus();
  await expect(page.locator("#model")).toHaveAttribute("data-aspect-field", new RegExp(field.replace("#", "")));
  const lines = Number(await page.locator("#model").getAttribute("data-aspect-lines"));
  expect(lines).toBeGreaterThan(0);
  await expect(page.locator("#model")).toHaveAttribute("data-aspect-tip", tip);
  await expect(page.locator("#model")).toHaveAttribute("data-aspect-mapped", "1");
}

test("cylinder radius, cone top, hole depth, and the split plane each light their own edge", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelToolBoolean").click();
  await page.locator(`#modelPrim [data-kind="cylinder"]`).click();
  await expectLit(page, "#modelRadius", /Radius/);
  await page.locator(`#modelPrim [data-kind="cone"]`).click();
  await expectLit(page, "#modelTopR", /Top radius/);
  await page.locator("#modelToolHole").click();
  await expectLit(page, "#modelHoleD", /Depth/);
  await page.locator("#modelToolSplit").click();
  await expectLit(page, "#modelPlane", /Plane|Offset/);
});

test("Tab into Depth lights it, and Shift+Tab out of the fields clears it", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelDx").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#modelDy")).toBeFocused();
  await expect(page.locator("#model")).toHaveAttribute("data-aspect", "size-1");
  for (let i = 0; i < 10; i += 1) {
    const inside = await page.evaluate(() => document.activeElement instanceof HTMLInputElement && !!document.activeElement.closest("#modelPanel"));
    if (!inside) break;
    await page.keyboard.press("Shift+Tab");
  }
  await expect(page.locator("#model")).not.toHaveAttribute("data-aspect", /.+/);
});

test("a count field keeps the tooltip and does not dim the solid", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelToolPattern").click();
  await page.locator("#modelPatCount").focus();
  await expect(page.locator("#model")).toHaveAttribute("data-aspect-mapped", "0");
  await expect(page.locator("#model")).toHaveAttribute("data-aspect-lines", "0");
  await expect(page.locator("#model")).toHaveAttribute("data-aspect-tip", /Count/);
  await expect(page.locator("#model")).toHaveAttribute("data-aspect-dim", "0");
  await expect(page.locator("#model")).toHaveAttribute("data-solid-opacity", "1");
});

test("a picked edge's fillet and a pushed face light their distance", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelPickEdge").click();
  const box = (await page.locator("#model").boundingBox())!;
  let picked = false;
  for (let r = 0; r < 6 && !picked; r += 1) {
    for (let col = 0; col < 6 && !picked; col += 1) {
      await page.mouse.click(box.x + box.width * (0.25 + col * 0.08), box.y + box.height * (0.25 + r * 0.08));
      picked = /Edge \d+/.test(await page.locator("#modelReadout").innerText());
    }
  }
  expect(picked).toBe(true);
  await page.locator("#modelToolFillet").click();
  await expectLit(page, "#modelBlend", /Fillet/);

  await page.keyboard.press("Escape");
  await page.locator("#modelPickFace").click();
  const screen = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  await page.mouse.click(box.x + screen[0]! + screen[2]! / 2, box.y + screen[1]! + screen[3]! / 2);
  await page.locator("#modelToolPull").click();
  await expectLit(page, "#modelPull", /Distance/);
});
