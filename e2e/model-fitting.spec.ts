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

const shots = path.resolve("test-results/model-fitting");

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

async function pickPart(page: Page, kind: string) {
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="part"]').click();
  await page.locator("#modelPartKind").selectOption(kind);
}

const fittings: {
  kind: string;
  ghost: string;
  after: string;
  label: string;
  row: string;
  sent: Record<string, unknown>;
  scrub: (page: Page) => Promise<void>;
}[] = [
  {
    kind: "spacer",
    ghost: "0.00 0.00 6.00 10.00 10.00 12.00",
    after: "0.00 0.00 10.00 10.00 10.00 20.00",
    label: "Spacer ⌀10 × 20",
    row: "tube",
    sent: { primitive: "part", partKind: "spacer", diameter: 10, bore: 4.2, height: 20 },
    scrub: async (page) => { await page.locator("#modelPartLength").fill("20"); },
  },
  {
    kind: "shaft",
    ghost: "0.00 0.00 20.00 7.89 7.89 40.00",
    after: "0.00 0.00 20.00 9.89 9.89 40.00",
    label: "Shaft ⌀10 sliding × 40",
    row: "Printed diameter",
    sent: { primitive: "part", partKind: "shaft", diameter: 10, height: 40, allowance: 0.1, fit: "sliding" },
    scrub: async (page) => { await page.locator("#modelPartDiameter").fill("10"); },
  },
  {
    kind: "collar",
    ghost: "0.00 0.00 3.00 14.00 14.00 6.00",
    after: "0.00 0.00 3.00 16.00 16.00 6.00",
    label: "Collar ⌀16 / ⌀8 × 6",
    row: "Set screw",
    sent: { primitive: "part", partKind: "collar", diameter: 16, bore: 8, height: 6, setScrew: 3 },
    scrub: async (page) => { await page.locator("#modelPartDiameter").fill("16"); },
  },
  {
    kind: "heat-set",
    ghost: "0.00 0.00 2.85 7.80 7.80 5.70",
    after: "0.00 0.00 2.00 6.20 6.20 4.00",
    label: "Heat-set boss RX-M2x4",
    row: "Ruthex RX-M3x5,7",
    sent: { primitive: "part", partKind: "heat-set", article: "RX-M2x4", diameter: 6.2, height: 4 },
    scrub: async (page) => { await page.locator("#modelPartArticle").selectOption("RX-M2x4"); },
  },
];

for (const fitting of fittings) {
  test(`the Part card makes a ${fitting.kind}, scrubs a field, saves, and uses it as a boolean tool`, async ({ page }) => {
    fs.mkdirSync(shots, { recursive: true });
    const tree = await start(page);
    await pickPart(page, fitting.kind);
    await expect(page.locator("#modelPartKind")).toHaveValue(fitting.kind);
    await expect(page.locator("#modelPartNominal"), "a fitting has no screw size").toBeHidden();
    await expect(page.locator("#modelPartRow")).toContainText(fitting.row);
    await expect(page.locator("#model")).toHaveAttribute("data-ghost", fitting.ghost);
    await page.screenshot({ path: path.join(shots, `part-${fitting.kind}.png`) });

    await fitting.scrub(page);
    await expect(page.locator("#model")).toHaveAttribute("data-ghost", fitting.after);
    await expect(apply(page)).toBeEnabled();
    await apply(page).click();
    await expect(readout(page)).toContainText("Part 1.");
    await expect(rows(page).first()).toContainText(fitting.label);
    const sent = tree.of("open").at(-1)!.primitive as Record<string, unknown>;
    expect(sent).toMatchObject(fitting.sent);

    const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
    const saved = fs.readFileSync((await download.path())!).toString("utf8");
    expect(saved).toContain(`"partKind": "${fitting.kind}"`);
    await page.reload();
    await page.locator("#projectFile").setInputFiles({ name: "fitting.lime", mimeType: "application/json", buffer: Buffer.from(saved) });
    await expect(page.locator("#left [data-plate-select]")).toHaveCount(1);
    await page.locator("#tabModel").click();
    await expect(rows(page).filter({ hasText: fitting.label })).toHaveCount(1);
    await page.screenshot({ path: path.join(shots, `part-${fitting.kind}-history.png`) });

    await page.locator("#modelToolBoolean").click();
    if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
    await page.locator('#modelPrim [data-kind="part"]').click();
    await page.locator("#modelPartKind").selectOption(fitting.kind);
    // The boolean origin starts at x = 10. A fitting there misses a shaft or a heat-set boss.
    await page.locator("#modelX").fill("0");
    await apply(page).click();
    const cutLabel = fitting.kind === "heat-set" ? "Cut Heat-set boss" : `Cut ${fitting.label.split(" ")[0]}`;
    await expect(rows(page).last()).toContainText(cutLabel);
    const cut = tree.of("apply").at(-1)!.op as Record<string, unknown>;
    expect(cut).toMatchObject({ kind: "boolean", op: "cut", primitive: "part", partKind: fitting.kind });
  });
}
