import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";
import { primitiveMesh, type PrimitiveSpec } from "../src/model-primitive";

/** What the engine builds from a primitive: its mesh where `origin` puts it. The volume is not the point here. */
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

/** An empty plate in Model mode, the engine mocked. */
async function start(page: Page): Promise<TreeMock> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: (request) => primitiveSolid(request.primitive as PrimitiveSpec), apply: built });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  return tree;
}

async function pickGear(page: Page) {
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="gear"]').click();
  await expect(page.locator("#modelGearTeeth")).toBeVisible();
}

test("the Gear card sends teeth, module, thickness, a hex bore and a hub, and its ghost follows the teeth", async ({ page }) => {
  const tree = await start(page);
  await pickGear(page);
  await expect(page.locator("#modelHeightLabel"), "Height reads Thickness for a gear").toHaveText("Thickness");
  await expect(page.locator("#modelHeight"), "a gear starts 6 mm thick").toHaveValue("6");
  await expect(page.locator("#modelGearTeeth")).toHaveValue("20");
  await expect(page.locator("#modelGearModule")).toHaveValue("1.5");
  await expect(page.locator("#modelGearBoreFlat"), "Flat is for a D bore").toBeHidden();
  await expect(page.locator("#modelGearPressure"), "the tooth form waits under More").toBeHidden();
  await expect(page.locator("#modelRadius"), "no other primitive's fields").toBeHidden();

  await expect.poll(() => ghost(page), { message: "a ghost is drawn" }).toBeTruthy();
  const twenty = await ghost(page);
  await page.locator("#modelGearTeeth").fill("24");
  await expect.poll(() => ghost(page), { message: "more teeth, a wider ghost" }).not.toBe(twenty);
  await page.locator("#modelGearModule").fill("2");
  await page.locator("#modelHeight").fill("8");
  await page.locator("#modelGearBore").fill("5");
  await page.locator("#modelGearBoreShape").selectOption("hex");
  await expect(page.locator("#modelGearBoreFlat")).toBeHidden();
  await page.locator("#modelGearBoreShape").selectOption("d");
  await expect(page.locator("#modelGearBoreFlat"), "a D bore shows its Flat").toBeVisible();
  await page.locator("#modelGearBoreShape").selectOption("hex");
  await page.locator("#modelGearHub").fill("12");
  await page.locator("#modelGearHubH").fill("4");
  await page.locator("#modelGearHubH").press("Tab");
  // Tip ⌀ 24 × 2 + 2 × 2 = 52 (a tooth's tip a hair inside it, for the backlash); the hub stands 4 mm on the 8 mm gear.
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", /12\.00$/);
  const [, , , dx, dy] = ((await ghost(page)) ?? "").split(" ").map(Number);
  expect(dx).toBeCloseTo(52, 0);
  expect(dy).toBeCloseTo(52, 0);

  await expect(apply(page)).toHaveText("Create");
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(readout(page)).toContainText("Gear 1.");
  const sent = tree.of("open").at(-1)!.primitive as Record<string, unknown>;
  expect(sent).toMatchObject({ primitive: "gear", teeth: 24, module: 2, height: 8, bore: 5, boreShape: "hex", hubDiameter: 12, hubHeight: 4 });
  expect(sent.boreFlat, "a hex bore sends no flat").toBeUndefined();
  expect(sent.pressureDeg, "the tooth form at its defaults is not sent").toBeUndefined();
  expect(sent.backlash).toBeUndefined();
  await expect(rows(page).first()).toContainText(/gear 24 teeth m 2 h 8/i);
});

test("5 teeth is refused on the card, and Apply waits", async ({ page }) => {
  const tree = await start(page);
  await pickGear(page);
  await page.locator("#modelGearTeeth").fill("5");
  await expect(page.locator("#modelNote")).toHaveText("A gear takes 6 to 150 teeth.");
  await expect(page.locator("#modelNote")).toHaveClass(/is-bad/);
  await expect(apply(page)).toBeDisabled();
  await page.locator("#modelGearTeeth").press("Enter");
  await page.waitForTimeout(300);
  expect(tree.of("open"), "nothing is sent").toHaveLength(0);
  await page.locator("#modelGearTeeth").fill("6");
  await expect(page.locator("#modelNote")).not.toHaveText("A gear takes 6 to 150 teeth.");
  await expect(apply(page)).toBeEnabled();
});

test("the tooth form under More is sent when changed, and a D bore sends its flat", async ({ page }) => {
  const tree = await start(page);
  await pickGear(page);
  await page.locator("#modelGearMore > summary").click();
  await page.locator("#modelGearPressure").fill("25");
  await page.locator("#modelGearShift").fill("0.2");
  await page.locator("#modelGearBore").fill("6");
  await page.locator("#modelGearBoreShape").selectOption("d");
  await page.locator("#modelGearBoreFlat").fill("5");
  await page.locator("#modelGearHub").fill("10");
  await page.locator("#modelGearBoreFlat").press("Tab");
  await apply(page).click();
  await expect(readout(page)).toContainText("Gear 1.");
  const sent = tree.of("open").at(-1)!.primitive as Record<string, unknown>;
  expect(sent).toMatchObject({ primitive: "gear", teeth: 20, module: 1.5, height: 6, pressureDeg: 25, profileShift: 0.2, bore: 6, boreShape: "d", boreFlat: 5 });
  expect(sent.hubDiameter, "a hub needs its height too").toBeUndefined();
  expect(sent.hubHeight).toBeUndefined();
});

test("a second gear says it is clear of the first", async ({ page }) => {
  await start(page);
  await pickGear(page);
  await apply(page).click();
  await expect(readout(page)).toContainText("Gear 1.");
  await pickGear(page);
  await expect(page.locator("#modelGearMesh")).toHaveText("Clear of Gear 1.");
  await expect(page.locator("#modelGearMesh")).not.toHaveClass(/is-bad/);
});

test("editing a gear step reopens the card with its numbers and its bore shape", async ({ page }) => {
  await start(page);
  await pickGear(page);
  await page.locator("#modelGearTeeth").fill("32");
  await page.locator("#modelGearBore").fill("5");
  await page.locator("#modelGearBoreShape").selectOption("hex");
  await page.locator("#modelGearHub").fill("12");
  await page.locator("#modelGearHubH").fill("3");
  await page.locator("#modelGearHubH").press("Tab");
  await apply(page).click();
  await expect(readout(page)).toContainText("Gear 1.");
  await expect(page.locator("#modelPanel")).toBeHidden();

  // Other numbers typed and cancelled must not leak into the reopened card.
  await pickGear(page);
  await page.locator("#modelGearTeeth").fill("10");
  await page.locator("#modelGearBoreShape").selectOption("round");
  await page.locator("#modelCancel").click();

  await rows(page).first().locator(".mh-more").click();
  await page.getByRole("menuitem", { name: /Edit step/ }).click();
  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(page.locator('#modelPrim [data-kind="gear"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#modelGearTeeth")).toHaveValue("32");
  await expect(page.locator("#modelGearModule")).toHaveValue("1.5");
  await expect(page.locator("#modelHeight")).toHaveValue("6");
  await expect(page.locator("#modelHeightLabel")).toHaveText("Thickness");
  await expect(page.locator("#modelGearBore")).toHaveValue("5");
  await expect(page.locator("#modelGearBoreShape")).toHaveValue("hex");
  await expect(page.locator("#modelGearHub")).toHaveValue("12");
  await expect(page.locator("#modelGearHubH")).toHaveValue("3");
  await expect(apply(page), "unchanged numbers would change nothing").toBeDisabled();
});
