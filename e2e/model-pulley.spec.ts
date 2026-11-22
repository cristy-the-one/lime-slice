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

const shots = path.resolve("test-results/model-pulley");

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

test("the Part card makes a GT2 pulley and a V pulley, scrubs parameters, saves, and uses them as boolean tools", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const tree = await start(page);
  const dupes = await page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const id of [...document.querySelectorAll("[id]")].map((el) => el.id).filter(Boolean)) seen.set(id, (seen.get(id) ?? 0) + 1);
    return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  });
  expect(dupes, "an element id is used twice").toEqual([]);
  await expect(page.locator("#modelPartTeeth")).toHaveCount(1);
  await expect(page.locator("#modelGearTeeth")).toHaveCount(1);
  await expect(page.locator("#modelPartSection")).toHaveCount(1);
  await expect(page.locator("#modelPartGrooves")).toHaveCount(1);

  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="part"]').click();
  await page.locator("#modelPartKind").selectOption("gt2");
  await expect(page.locator("#modelPartKind")).toHaveValue("gt2");
  await expect(page.locator("#modelPartRow")).toContainText("approximate GT2 groove");
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", "0.00 0.00 3.00 12.22 12.22 6.00");
  await page.screenshot({ path: path.join(shots, "part-gt2.png") });

  await page.locator("#modelPartKind").selectOption("v");
  await expect(page.locator("#modelPartSection")).toHaveValue("SPZ");
  await expect(page.locator("#modelPartRow")).toContainText("ISO 4183 SPZ: outside ⌀67 mm, width 16 mm, angle 34°.");
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", "0.00 0.00 8.00 67.00 67.00 16.00");
  await expect(apply(page)).toBeEnabled();

  // Small pulley under older ISO minimum (63 mm) still builds, with a note shown once in the row.
  await page.locator("#modelPartDiameter").fill("45");
  await expect(page.locator("#modelPartRow")).toContainText("Under 63 mm the belt bends more than its maker allows, and wears sooner.");
  await expect(page.locator("#modelNote")).not.toContainText("Under 63 mm");
  await expect(apply(page)).toBeEnabled();

  // Bore past the groove wall is refused in the note only, disabling Create.
  await page.locator("#modelPartBore").fill("30");
  await expect(page.locator("#modelNote")).toContainText("The bore is at most 23 mm on this pulley, so 2 mm stays under the grooves.");
  await expect(page.locator("#modelPartRow")).not.toContainText("The bore is at most");
  await expect(apply(page)).toBeDisabled();

  // Switch section to SPB, 3 grooves, datum 200, bore 25 and create it.
  await page.locator("#modelPartKind").selectOption("gt2");
  await page.locator("#modelPartKind").selectOption("v");
  await page.locator("#modelPartSection").selectOption("SPB");
  await expect(page.locator("#modelPartDiameter")).toHaveValue("140");
  await page.locator("#modelPartDiameter").fill("200");
  await page.locator("#modelPartGrooves").fill("3");
  await page.locator("#modelPartBore").fill("25");
  await expect(page.locator("#modelPartRow")).toContainText("ISO 4183 SPB: outside ⌀207 mm, width 63 mm, angle 38°.");
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", "0.00 0.00 31.50 207.00 207.00 63.00");
  await expect(apply(page)).toBeEnabled();
  await page.screenshot({ path: path.join(shots, "part-v.png") });
  await apply(page).click();
  await expect(rows(page).first()).toContainText("V pulley SPB ⌀200, 3 grooves");
  const vSent = tree.of("open").at(-1)!.primitive as Record<string, unknown>;
  expect(vSent).toMatchObject({ primitive: "part", partKind: "v", section: "SPB", diameter: 200, grooves: 3, bore: 25 });

  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="part"]').click();
  await page.locator("#modelPartKind").selectOption("gt2");
  await page.locator("#modelPartTeeth").fill("36");
  // The V pulley already occupies the origin, so the new GT2 pulley parks clear along +X with exact Z and bounds.
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", /^-?\d+\.\d{2} 0\.00 3\.00 22\.41 22\.41 6\.00$/);
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText("Part 2.");
  await expect(rows(page).first()).toContainText("GT2 pulley 36 teeth");
  const sent = tree.of("open").at(-1)!.primitive as Record<string, unknown>;
  expect(sent).toMatchObject({ primitive: "part", partKind: "gt2", teeth: 36, height: 6, bore: 5 });

  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = fs.readFileSync((await download.path())!).toString("utf8");
  expect(saved).toContain('"partKind": "gt2"');
  expect(saved).toContain('"teeth": 36');
  expect(saved).toContain('"partKind": "v"');
  expect(saved).toContain('"section": "SPB"');
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "pulley.lime", mimeType: "application/json", buffer: Buffer.from(saved) });
  await expect(page.locator("#left [data-plate-select]")).toHaveCount(2);
  await page.locator("#tabModel").click();
  await expect(rows(page).filter({ hasText: "V pulley SPB ⌀200, 3 grooves" })).toHaveCount(1);
  await page.locator("#tabPrepare").click();
  await page.locator("#left [data-plate-select]").nth(1).click();
  await page.locator("#tabModel").click();
  await expect(rows(page).filter({ hasText: "GT2 pulley 36 teeth" })).toHaveCount(1);
  await page.screenshot({ path: path.join(shots, "part-gt2-history.png") });

  await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  await page.locator('#modelPrim [data-kind="part"]').click();
  await page.locator("#modelPartKind").selectOption("gt2");
  await apply(page).click();
  await expect(rows(page).last()).toContainText("Cut GT2 pulley 20 teeth");
  const cut = tree.of("apply").at(-1)!.op as Record<string, unknown>;
  expect(cut).toMatchObject({ kind: "boolean", op: "cut", primitive: "part", partKind: "gt2", teeth: 20 });
});
