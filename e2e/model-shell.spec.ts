import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 × 20 × 10 box from the origin, as the modeler reports a solid, `volumeMm3` of it left. */
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
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: id === 0 || id === 1 ? 400 : 200 })), edges: [] };
}

/**
 * The volume a shell of a 20 × 20 × 10 box leaves, as the kernel's hand check: the box minus the
 * void. An open face shrinks the height by one wall; a closed void shrinks it by two.
 */
function shellVolume(thickness: number, open: boolean): number {
  const inner = 20 - 2 * thickness;
  const height = open ? 10 - thickness : 10 - 2 * thickness;
  return 4000 - inner * inner * height;
}

async function openModel(page: Page): Promise<TreeMock> {
  const root = boxSolid();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => root,
    apply: (request: Body) => {
      const op = request.op as { thickness?: number; openFaces?: unknown[] };
      const open = (op.openFaces?.length ?? 0) > 0;
      return boxSolid(shellVolume(op.thickness ?? 1, open));
    },
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 4000 mm³");
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
const apply = (page: Page) => page.locator("#modelApply");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");

async function grips(page: Page): Promise<Record<string, { x: number; y: number }>> {
  const text = (await page.locator("#model").getAttribute("data-handles")) ?? "";
  const box = (await page.locator("#model").boundingBox())!;
  const map: Record<string, { x: number; y: number }> = {};
  for (const item of text.split(" ").filter(Boolean)) {
    const [id, at] = item.split(":");
    const [x, y] = at!.split(",").map(Number);
    map[id!] = { x: box.x + x!, y: box.y + y! };
  }
  return map;
}

/** Where the middle of the solid's top face is on screen: the Hole tool's origin dot starts there. */
async function topMiddle(page: Page) {
  await page.locator("#modelToolHole").click();
  await expect.poll(async () => (await grips(page))["hole-origin"]).toBeTruthy();
  const at = (await grips(page))["hole-origin"]!;
  await page.locator("#modelCancel").click();
  return at;
}

async function setField(page: Page, id: string, text: string) {
  await page.locator(`#${id}`).fill(text);
  await page.locator(`#${id}`).press("Tab");
}

test("Shell opens the top face at thickness 2, then an edit to 3 rebuilds", async ({ page }) => {
  const tree = await openModel(page);
  const top = await topMiddle(page);
  await page.locator("#modelToolShell").click();
  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(page.locator("#modelPickFace"), "Shell picks faces").toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelShell")).toBeVisible();
  await expect(page.locator("#modelShell")).toHaveValue("1");
  await expect(page.locator("#modelShellFaces")).toHaveText("No face open.");
  await expect(page.locator("#model")).not.toHaveAttribute("data-ghost", /.+/);

  await page.mouse.click(top.x, top.y);
  await expect(readout(page)).toContainText("Face 2");
  await expect(page.locator("#modelShellFaces")).toHaveText("1 face open");
  await expect(page.locator("#model")).toHaveAttribute("data-removed-faces", "1");

  await page.locator("#modelShellClosed").check();
  await expect(page.locator("#modelShellFaces")).toHaveText("Closed inside.");
  await expect(page.locator("#model")).toHaveAttribute("data-removed-faces", "0");
  await page.locator("#modelShellClosed").uncheck();
  await expect(page.locator("#modelShellFaces")).toHaveText("1 face open");

  const before = Number(await page.locator("#modelShell").inputValue());
  await expect.poll(async () => (await grips(page))["shell"]).toBeTruthy();
  const grip = (await grips(page))["shell"]!;
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(grip.x, grip.y + i * 6);
  await page.mouse.up();
  await expect.poll(async () => Number(await page.locator("#modelShell").inputValue())).not.toBe(before);

  await setField(page, "modelShell", "2");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText(`Shell. Volume ${shellVolume(2, true)} mm³`);
  await expect(page.locator("#modelPanel")).toBeHidden();
  await expect(rows(page).nth(1)).toContainText("Shell 2, 1 face open");
  expect(tree.of("apply").at(-1)!.op).toEqual({ kind: "shell", thickness: 2, openFaces: [1] });

  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelEditHead")).toHaveText("Editing step 1: Shell 2, 1 face open");
  await expect(page.locator("#modelShell")).toHaveValue("2");
  await expect(page.locator("#modelShellClosed")).not.toBeChecked();
  await expect(page.locator("#modelShellFaces")).toHaveText("1 face open");
  await expect(apply(page)).toBeDisabled();
  await setField(page, "modelShell", "3");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText(`Volume ${shellVolume(3, true)} mm³`);
  await expect(page.locator("#modelHistoryTree [role=treeitem][data-state=current]")).toContainText("Shell 3, 1 face open");
  const edited = tree.of("edit").at(-1)!.op as { thickness: number; openFaces: number[] };
  expect(edited).toMatchObject({ kind: "shell", thickness: 3, openFaces: [1] });
});

test("Closed inside starts off each time Shell opens", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelToolShell").click();
  await page.locator("#modelShellClosed").check();
  await expect(page.locator("#modelShellFaces")).toHaveText("Closed inside.");
  await page.locator("#modelCancel").click();
  await page.locator("#modelToolShell").click();
  await expect(page.locator("#modelShellClosed")).not.toBeChecked();
  await expect(page.locator("#modelShellFaces")).toHaveText("No face open.");
});
