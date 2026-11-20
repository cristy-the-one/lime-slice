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
const ghost = (page: Page) => page.locator("#model").getAttribute("data-ghost");

const shots = path.resolve("test-results/model-fastener");

/** An empty plate in Model mode, the engine mocked, dark theme, 1440×1000. */
async function start(page: Page): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  // A saved plate step can open from its own solid, with no primitive on that call. The history labels come from the file.
  const tree = await mockModelTree(page, {
    open: (request) => (request.primitive ? primitiveSolid(request.primitive as PrimitiveSpec) : primitiveSolid({ primitive: "box", origin: [0, 0, 0], size: [20, 20, 10], radius: 0, height: 0, turn: [0, 0, 0] })),
    apply: built,
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  return tree;
}

async function pickPart(page: Page) {
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="part"]').click();
  await expect(page.locator("#modelPartKind")).toBeVisible();
}

test("the Part card makes a nut, scrubs the nominal, edits, saves, and cuts with a washer", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const tree = await start(page);
  await pickPart(page);
  await expect(page.locator("#modelPartKind")).toHaveValue("nut");
  await expect(page.locator("#modelPartNominal")).toHaveValue("M6");
  await expect(page.locator("#modelPartRow")).toContainText("10");
  await expect(page.locator("#modelPartRow")).toContainText("5.2");
  await expect(page.locator("#modelPartLength"), "a nut has no length under a head").toBeHidden();
  await expect(page.locator("#modelPartAllowance")).toBeVisible();
  await expect(page.locator("#modelRadius"), "no other primitive's fields").toBeHidden();

  // M6 nut: across flats 10, so the box is 11.55 × 10 × 5.2, centred at z 2.6.
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", "0.00 0.00 2.60 11.55 10.00 5.20");
  await page.screenshot({ path: path.join(shots, "part-nut-m6.png") });

  await page.locator("#modelPartNominal").selectOption("M12");
  await expect(page.locator("#modelPartRow")).toContainText("18");
  await expect(page.locator("#modelPartRow")).toContainText("10.8");
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", "0.00 0.00 5.40 20.78 18.00 10.80");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText("Part 1.");
  await expect(rows(page).first()).toContainText("Nut M12");
  const sent = tree.of("open").at(-1)!.primitive as Record<string, unknown>;
  expect(sent).toMatchObject({ primitive: "part", partKind: "nut", nominal: "M12" });

  await rows(page).first().locator(".mh-more").click();
  await page.getByRole("menuitem", { name: /Edit step/ }).click();
  await expect(page.locator("#modelPartNominal")).toHaveValue("M12");
  await expect(apply(page), "the numbers as they are would change nothing").toBeDisabled();
  await page.locator("#modelPartNominal").selectOption("M6");
  await page.locator("#modelPartNominal").press("Tab");
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", "0.00 0.00 2.60 11.55 10.00 5.20");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  // A new solid's root edits as a sibling under the root, the way a box does: the first row stays the original.
  await expect(readout(page)).toContainText("Updated “Nut M6”");
  await expect(rows(page)).toHaveText([/^Nut M12/, /^Nut M6/]);
  const edited = tree.of("edit").at(-1)!;
  expect(edited).toMatchObject({ parent: 0, op: { kind: "root", primitive: "part", partKind: "nut", nominal: "M6" } });
  await page.screenshot({ path: path.join(shots, "part-history-nut.png") });

  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = fs.readFileSync((await download.path())!).toString("utf8");
  expect(saved).toContain('"partKind": "nut"');
  expect(saved).toContain('"nominal": "M6"');
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "fastener.lime", mimeType: "application/json", buffer: Buffer.from(saved) });
  await expect(page.locator("#left [data-plate-select]")).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(rows(page).filter({ hasText: "Nut M6" })).toHaveCount(1);

  await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  await page.locator('#modelPrim [data-kind="part"]').click();
  await page.locator("#modelPartKind").selectOption("washer");
  await expect(page.locator("#modelPartNominal")).toHaveValue("M6");
  await expect(page.locator("#modelPartRow")).toContainText("ISO 7089");
  await page.screenshot({ path: path.join(shots, "part-washer-boolean.png") });
  await apply(page).click();
  await expect(rows(page).last()).toContainText("Cut Washer M6");
  const cut = tree.of("apply").at(-1)!.op as Record<string, unknown>;
  expect(cut).toMatchObject({ kind: "boolean", op: "cut", primitive: "part", partKind: "washer", nominal: "M6" });
});
