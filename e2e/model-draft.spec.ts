/**
 * Draft from the face menu: pick a side wall, Draft 3°, the History row appears, and undo removes it.
 * The kernel is mocked here. The volume against the frustum is the Open CASCADE test.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "model-draft");

type V = [number, number, number];

function boxSolid() {
  const size: V = [40, 30, 20];
  const c = (x: number, y: number, z: number): V => [x * size[0], y * size[1], z * size[2]];
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
  const normals: V[] = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];
  const faces = quads.map((_, id) => ({ id, areaMm2: 1, normal: normals[id]! }));
  return { volumeMm3: 40 * 30 * 20, positions, triangles, faces, edges: [] as { id: number; lengthMm: number; points: number[] }[] };
}

async function facePoint(page: Page, want: (normal: number[]) => boolean): Promise<{ x: number; y: number }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  let found: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    const text = (await page.locator("#model").getAttribute("data-faces")) ?? "";
    const box = await page.locator("#model").boundingBox();
    if (!box || text === "") return "";
    for (const item of text.split(" ").filter(Boolean)) {
      const [, xy, normalText] = item.split(":");
      const normal = normalText!.split(",").map(Number);
      if (!want(normal)) continue;
      const [x, y] = xy!.split(",").map(Number);
      found = { x: box.x + x!, y: box.y + y! };
      return text;
    }
    return "";
  }).not.toBe("");
  if (!found) throw new Error("no face");
  return found;
}

test.use({ viewport: { width: 1440, height: 1000 } });

test("a side wall drafts from the face menu and undo removes the row", async ({ page }) => {
  const applied: Record<string, unknown>[] = [];
  const solid = boxSolid();
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, {
    open: () => solid,
    apply: (request) => {
      applied.push(request.op as Record<string, unknown>);
      return { ...solid, volumeMm3: solid.volumeMm3 - 1 };
    },
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "draft-before.png") });

  const side = await facePoint(page, (normal) => normal[0]! > 0.5);
  await page.mouse.click(side.x, side.y);
  const action = page.locator("#modelContextBar [data-action=draft]");
  await expect(action).toBeVisible();
  await page.screenshot({ path: path.join(shots, "draft-menu.png") });
  await action.click();
  await expect(page.locator("#modelDraft")).toBeVisible();
  await page.locator("#modelDraft").fill("3");
  await page.locator("#modelDraft").blur();
  const apply = page.locator("#modelApply");
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.locator("#modelHistoryTree")).toContainText("Draft 1 wall 3°");
  expect(applied.at(-1)).toEqual({ kind: "draft", faces: [5], angleDeg: 3 });
  await page.screenshot({ path: path.join(shots, "draft-after.png") });

  const rail = page.locator("#toolRail");
  expect(await rail.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);

  const undo = page.locator("#modelUndo");
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.locator("#modelReadout")).toContainText("Edit undone");
  await expect(page.locator("#modelHistoryTree [aria-selected=true]")).not.toContainText("Draft");
  await expect(page.locator("#modelReadout")).toContainText("Volume 24000");
});
