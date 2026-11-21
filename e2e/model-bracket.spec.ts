import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";
import { primitiveMesh, type PrimitiveSpec } from "../src/model-primitive";

/** What the engine builds from a primitive: its mesh where `origin` puts it. */
function primitiveSolid(spec: PrimitiveSpec): MockSolid {
  const mesh = primitiveMesh(spec);
  const positions = [...mesh].map((value, i) => value + spec.origin[i % 3]!);
  return { volumeMm3: 1000, positions, triangles: positions.filter((_, i) => i % 9 === 0).map(() => 0), faces: [{ id: 0, areaMm2: 0 }], edges: [] };
}

function built(_request: Body, parent: MockSolid): Built {
  return { ...parent, volumeMm3: parent.volumeMm3 - 100 };
}

const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const apply = (page: Page) => page.locator("#modelApply");

const shots = path.resolve("test-results/model-bracket");

/** An empty plate in Model mode, the engine mocked, dark theme, 1440×1000. */
async function start(page: Page): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => (request.primitive ? primitiveSolid(request.primitive as PrimitiveSpec) : primitiveSolid({ primitive: "box", origin: [0, 0, 0], size: [20, 20, 10], radius: 0, height: 0, turn: [0, 0, 0] })),
    apply: built,
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  return tree;
}

test("the Part card makes a plate, scrubs Hole for, saves, and cuts with an L-bracket", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const tree = await start(page);
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="part"]').click();
  await page.locator("#modelPartKind").selectOption("plate");
  await expect(page.locator("#modelPartHoleFor")).toHaveValue("M4");
  await expect(page.locator("#modelPartRow")).toContainText("ISO 273");
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", "0.00 0.00 2.00 80.00 60.00 4.00");
  await page.screenshot({ path: path.join(shots, "part-plate.png") });

  await page.locator("#modelPartHoleFor").selectOption("free");
  await expect(page.locator("#modelPartBore")).toBeVisible();
  await expect(page.locator("#modelPartBore")).toHaveValue("4.7");
  await expect(page.locator("#modelPartAllowance")).toBeHidden();

  await page.locator("#modelPartHoleFor").selectOption("M6");
  await expect(page.locator("#modelPartAllowance")).toBeVisible();
  await expect(page.locator("#modelPartRow")).toContainText("M6");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText("Part 1.");
  await expect(rows(page).first()).toContainText("Plate 80 × 60 × 4, M6");
  const sent = tree.of("open").at(-1)!.primitive as Record<string, unknown>;
  expect(sent).toMatchObject({ primitive: "part", partKind: "plate", holeFor: "M6", size: [80, 60, 4], holes: 4, allowance: 0.2 });

  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = fs.readFileSync((await download.path())!).toString("utf8");
  expect(saved).toContain('"partKind": "plate"');
  expect(saved).toContain('"holeFor": "M6"');
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "bracket.lime", mimeType: "application/json", buffer: Buffer.from(saved) });
  await expect(page.locator("#left [data-plate-select]")).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(rows(page).filter({ hasText: "Plate 80 × 60 × 4, M6" })).toHaveCount(1);
  await page.screenshot({ path: path.join(shots, "part-plate-history.png") });

  await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  await page.locator('#modelPrim [data-kind="part"]').click();
  await page.locator("#modelPartKind").selectOption("bracket");
  await page.locator("#modelX").fill("0");
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", "0.00 0.00 20.00 40.00 30.00 40.00");
  await apply(page).click();
  await expect(rows(page).last()).toContainText("Cut L-bracket");
  const cut = tree.of("apply").at(-1)!.op as Record<string, unknown>;
  expect(cut).toMatchObject({ kind: "boolean", op: "cut", primitive: "part", partKind: "bracket" });
});
