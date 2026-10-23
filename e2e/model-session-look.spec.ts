import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

function boxSolid(size: V, min: V = [0, 0, 0]): MockSolid {
  const c = (x: number, y: number, z: number): V => [min[0] + x * size[0], min[1] + y * size[1], min[2] + z * size[2]];
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
  return { volumeMm3: size[0] * size[1] * size[2], positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

/** A 400 mm tall column: the Form 4 builds 210 mm, so it takes three pieces across Z; the Lime 220 takes them across Z too. */
const COLUMN = boxSolid([20, 20, 400]);
const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");

type Cut = { origin: V; normal: V };

function piecesOf(parent: MockSolid, cuts: Cut[]): MockSolid[] {
  const stops = cuts.map((cut) => cut.origin[2]).sort((a, b) => a - b);
  const bounds = [0, ...stops, 400];
  return bounds.slice(1).map((hi, k) => boxSolid([20, 20, hi - bounds[k]!], [0, 0, bounds[k]!]));
}

function built(request: Body, parent: MockSolid): Built {
  const op = request.op as { kind: string; cuts?: Cut[] };
  if (op.kind === "partition") {
    const [kept, ...pieces] = piecesOf(parent, op.cuts!);
    return { kept: kept!, pieces };
  }
  return parent;
}

async function openColumn(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: COLUMN.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, {
    open: () => COLUMN,
    apply: built,
    probe(request, on) {
      const op = request.op as { kind: string; cuts?: Cut[] };
      if (op.kind !== "partition") return { ok: true };
      const parts = piecesOf(on, op.cuts!).map((piece) => ({ volumeMm3: piece.volumeMm3, min: [0, 0, 0], max: [20, 20, 1] }));
      return { ok: true, volumeMm3: parts[0]!.volumeMm3, parts };
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "bar.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeAttached();
}

async function addPart(page: Page, name: string) {
  await page.locator("#plateAddFile").setInputFiles({ name, mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj-row")).toHaveCount(2);
}

const readout = (page: Page) => page.locator("#modelReadout");
const canvas = (page: Page) => page.locator("#model");

async function toModel(page: Page) {
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
}

async function split(page: Page, target?: string, pieces = 3) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuSplitPrint").click();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Split to print");
  if (target) await page.locator("#modelPartTarget").selectOption(target);
  await expect(page.locator("#modelPartPieces li")).toHaveCount(pieces);
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree .mh-label").last()).toContainText("Split to print");
}

test.use({ viewport: { width: 1440, height: 1000 } });

test("Explode and Section stay on through Prepare and back, and start over for another part", async ({ page }) => {
  await openColumn(page);
  await toModel(page);
  await split(page, "formlabs-form-4");

  await page.locator("#modelLookOpen").click();
  await page.locator("#modelExplode").check();
  await page.locator("#modelExplodeGap").fill("25");
  await page.locator("#modelSection").check();
  await page.locator('#modelSectionAxis [data-axis="x"]').click();
  await page.locator("#modelSectionOffset").fill("4");
  await page.locator("#modelSectionFlip").check();
  await page.locator("#modelColourSteps").check();
  await expect(canvas(page)).toHaveAttribute("data-explode", "25");
  const section = await canvas(page).getAttribute("data-section");
  expect(section).toBeTruthy();
  await page.keyboard.press("Escape");

  await page.locator("#tabPrepare").click();
  await toModel(page);
  await expect(canvas(page), "Explode is still on").toHaveAttribute("data-explode", "25");
  await expect(canvas(page), "the section plane is where it was").toHaveAttribute("data-section", section!);
  await page.locator("#modelLookOpen").click();
  await expect(page.locator("#modelExplode")).toBeChecked();
  await expect(page.locator("#modelExplodeGap")).toHaveValue("25");
  await expect(page.locator("#modelSection")).toBeChecked();
  await expect(page.locator('#modelSectionAxis [data-axis="x"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelSectionOffset")).toHaveValue("4");
  await expect(page.locator("#modelSectionFlip")).toBeChecked();
  await expect(page.locator("#modelColourSteps")).toBeChecked();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/model-session-look/model-after-prepare.png" });

  await page.locator("#tabPrepare").click();
  await addPart(page, "other.step");
  await toModel(page);
  await expect(canvas(page), "another part starts over").not.toHaveAttribute("data-section", /.*/);
  await expect(canvas(page)).not.toHaveAttribute("data-explode", /.*/);
  await page.locator("#modelLookOpen").click();
  await expect(page.locator("#modelSection")).not.toBeChecked();
  await expect(page.locator("#modelExplode")).not.toBeChecked();
  await expect(page.locator("#modelExplodeGap")).toHaveValue("10");
  await expect(page.locator("#modelColourSteps")).not.toBeChecked();
});

test("Explode stays remembered while the part has no pieces, and shows again with them", async ({ page }) => {
  await openColumn(page);
  await toModel(page);
  await split(page, "formlabs-form-4");
  await page.locator("#modelLookOpen").click();
  await page.locator("#modelExplode").check();
  await expect(canvas(page)).toHaveAttribute("data-explode", "10");
  await page.keyboard.press("Escape");

  await page.locator("#modelHistoryTree .mh-label").first().click();
  await expect(canvas(page), "the first step has no pieces to spread").not.toHaveAttribute("data-explode", /.*/);
  await page.locator("#modelLookOpen").click();
  await expect(page.locator("#modelExplodeRow")).toBeHidden();
  await page.keyboard.press("Escape");

  await page.locator("#modelHistoryTree .mh-label").last().click();
  await expect(canvas(page), "the split is back, so Explode is too").toHaveAttribute("data-explode", "10");
});

/** The name the next Save downloads. */
async function savedAs(page: Page): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  return { name: download.suggestedFilename(), text: (await readFile((await download.path())!)).toString("utf8") };
}

test("Save offers the opened project's name, whichever object is selected", async ({ page }) => {
  await openColumn(page);
  await addPart(page, "other.step");
  const first = await savedAs(page);
  await page.locator("#projectFile").setInputFiles({ name: "bar.lime", mimeType: "application/json", buffer: Buffer.from(first.text) });
  await expect(page.locator("#projectTitle")).toHaveText("bar.lime");
  await expect(page.locator("#objectList .obj-row")).toHaveCount(2);
  await page.locator("#objectList .obj-select").first().click();
  expect((await savedAs(page)).name).toBe("bar.lime");
  await page.locator("#objectList .obj-select").nth(1).click();
  expect((await savedAs(page)).name).toBe("bar.lime");
});

test("a new project saved once offers that name again, and a never-saved one offers its object", async ({ page }) => {
  await openColumn(page);
  await addPart(page, "other.step");
  await page.locator("#objectList .obj-select").first().click();
  const first = await savedAs(page);
  expect(first.name, "never saved: the selected object's name").toBe("bar.lime");
  await page.locator("#objectList .obj-select").nth(1).click();
  expect((await savedAs(page)).name, "saved once: the name it was saved under").toBe("bar.lime");
  await expect(page.locator("#projectTitle")).toHaveText("bar.lime");
});

const note = (page: Page) => page.locator("#objectList .obj-split");

test("Prepare notes a part split for the Form 4, with its count, and says nothing for an FDM split", async ({ page }) => {
  await openColumn(page);
  await expect(note(page)).toHaveCount(0);
  await toModel(page);
  await split(page, "formlabs-form-4");
  await page.locator("#tabPrepare").click();
  await expect(note(page)).toHaveCount(1);
  await expect(note(page)).toHaveText("Split for the Formlabs Form 4 in Model, 3 parts. The plate keeps it whole, and Slice and the 3MF wait while Model is on the split.");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/model-session-look/prepare-note.png" });
});

test("an FDM split shows no note in Prepare", async ({ page }) => {
  await openColumn(page);
  await toModel(page);
  await split(page, undefined, 2);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#objectList .obj-row")).toHaveCount(2);
  await expect(note(page)).toHaveCount(0);
});
