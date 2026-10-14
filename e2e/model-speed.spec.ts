import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { autoSliceOff } from "./auto-slice";

type V = [number, number, number];

/** A box the modeler reports as a solid, in its own CAD frame, from `z0` up. */
function boxSolid(id: number, size: V, z0 = 0) {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [x * sx, y * sy, z0 + z * sz];
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
  return { id, volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, face) => ({ id: face, areaMm2: 0 })), edges: [] };
}

const SOLID = boxSolid(1, [20, 20, 10]);
const CUT = boxSolid(1, [20, 20, 5]);

interface Calls {
  opens: { filename: string; dataB64: string }[];
  probes: number;
  exports: number;
  splits: number[];
  release: (() => void) | null;
  holdProbes: boolean;
}

/** The modeler, mocked. Each export writes different STEP bytes, so a test can tell which one landed. */
async function modeler(page: Page): Promise<Calls> {
  const calls: Calls = { opens: [], probes: 0, exports: 0, splits: [], release: null, holdProbes: false };
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: SOLID.positions } }));
  await page.route("**/api/model/probe", async (route) => {
    calls.probes += 1;
    if (calls.holdProbes) await new Promise<void>((resolve) => (calls.release = resolve));
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/model/boolean", (route) => route.fulfill({ json: CUT }));
  await page.route("**/api/model/undo", (route) => route.fulfill({ json: SOLID }));
  await page.route("**/api/model/redo", (route) => route.fulfill({ json: CUT }));
  await page.route("**/api/model/export", (route) => {
    calls.exports += 1;
    const bytes = Buffer.from(`EDITED-STEP-${calls.exports}`);
    return route.fulfill({ json: { bytesBase64: bytes.toString("base64"), byteLength: bytes.length } });
  });
  await page.route("**/api/model/split", (route) => {
    const { id, z } = route.request().postDataJSON() as { id: number; z: number };
    calls.splits.push(id);
    const kept = boxSolid(id, [20, 20, z]);
    const other = boxSolid(id + 1, [20, 20, 10 - z], z);
    return route.fulfill({ json: { ...kept, other } });
  });
  await page.route("**/api/model", (route) => {
    calls.opens.push(route.request().postDataJSON() as { filename: string; dataB64: string });
    return route.fulfill({ json: SOLID });
  });
  return calls;
}

async function openModel(page: Page) {
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
}

test("Apply, undo, and redo ask the kernel nothing, and a typed number asks once", async ({ page }) => {
  const calls = await modeler(page);
  await openModel(page);
  const apply = page.locator("#modelApply");
  const readout = page.locator("#modelReadout");

  calls.holdProbes = true;
  await page.locator("#modelToolBoolean").click();
  await expect.poll(() => calls.release !== null).toBe(true);
  await expect(apply).toBeDisabled();
  calls.holdProbes = false;
  calls.release?.();
  await expect(apply, "Apply is on as soon as the answer lands").toBeEnabled({ timeout: 250 });
  expect(calls.probes).toBe(1);

  await apply.click();
  await expect(readout).toContainText("Volume 2000 mm³");
  await page.waitForTimeout(700);
  expect(calls.probes, "Apply asks nothing afterwards").toBe(1);
  await expect(apply, "the numbers just applied cannot change the cut solid").toBeDisabled();
  await expect(page.locator("#modelNote")).not.toContainText("Checking");

  await page.locator("#modelUndo").click();
  await expect(readout).toContainText("Volume 4000 mm³");
  await expect(apply, "undo returns to a shape these numbers were checked on").toBeEnabled();
  await page.locator("#modelRedo").click();
  await expect(readout).toContainText("Volume 2000 mm³");
  await expect(apply).toBeDisabled();
  await page.waitForTimeout(700);
  expect(calls.probes, "undo and redo ask nothing").toBe(1);

  await page.locator("#modelDx").selectText();
  await page.keyboard.type("12.5", { delay: 120 });
  await expect(apply).toBeEnabled();
  await page.waitForTimeout(700);
  expect(calls.probes, "typing 12.5 asks once").toBe(2);
});

test("Apply writes no STEP; leaving Model writes the edited solid once, and save and reopen keep it", async ({ page }) => {
  const calls = await modeler(page);
  await openModel(page);
  await page.locator("#modelToolBoolean").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 2000 mm³");
  await page.locator("#modelDz").fill("4");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelApply")).toBeDisabled();
  expect(calls.exports, "no STEP per Apply").toBe(0);

  await page.locator("#tabPrepare").click();
  await expect.poll(() => calls.exports, { message: "leaving Model writes the solid" }).toBe(1);
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = fs.readFileSync((await download.path())!);
  const written = Buffer.from("EDITED-STEP-1").toString("base64");
  expect(saved.toString("utf8"), "the project keeps the edited solid").toContain(written);
  expect(calls.exports, "a save after leaving writes nothing new").toBe(1);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#projectFile").setInputFiles({ name: "edited.lime", mimeType: "application/json", buffer: saved });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  const reopened = calls.opens.at(-1)!;
  expect(reopened.filename).toMatch(/\.step$/);
  expect(reopened.dataB64, "Model reopens the edited solid, not the file's").toBe(written);
});

test("the piece a split adds opens as a solid of its own and splits again", async ({ page }) => {
  const calls = await modeler(page);
  await openModel(page);
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelPlaneZ").fill("4");
  await page.locator("#modelApply").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await expect(page.locator("#modelReadout")).toContainText("Split. Volume 1600 mm³");

  await page.locator("[data-plate-select]").nth(1).click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 2400 mm³");
  await expect(page.locator("#modelReadout")).not.toContainText("This file is a mesh");
  expect(calls.opens, "the piece opens from the session, with no STEP read").toHaveLength(1);

  await expect(page.locator("#modelToolSplit"), "Split stays open on the piece").toHaveAttribute("aria-pressed", "true");
  await page.locator("#modelPlaneZ").fill("7");
  await page.locator("#modelApply").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  expect(calls.splits).toEqual([1, 2]);
});
