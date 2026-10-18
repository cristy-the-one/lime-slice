import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A box the modeler reports as a solid, in its own CAD frame, from `z0` up. */
function boxSolid(size: V, z0 = 0) {
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
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, face) => ({ id: face, areaMm2: 0 })), edges: [] };
}

const SOLID = boxSolid([20, 20, 10]);
const CUT = boxSolid([20, 20, 5]);

interface Calls {
  tree: TreeMock;
  opens: Body[];
  probes: number;
  /** Each check's op, in the order the engine got them. */
  asked: Body[];
  release: (() => void) | null;
  holdProbes: boolean;
}

/** The modeler, mocked. Each export writes different STEP bytes, so a test can tell which one landed. */
async function modeler(page: Page, exportMs = 0): Promise<Calls> {
  const calls: Calls = { tree: null as unknown as TreeMock, opens: [], probes: 0, asked: [], release: null, holdProbes: false };
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: SOLID.positions } }));
  calls.tree = await mockModelTree(page, {
    open(request) {
      calls.opens.push(request);
      return SOLID;
    },
    apply(request) {
      const op = request.op as { kind: string; origin: number[] };
      if (op.kind !== "split") return CUT;
      const z = op.origin[2]!;
      return { kept: boxSolid([20, 20, z]), other: boxSolid([20, 20, 10 - z], z) };
    },
    exportMs,
    async probe(request) {
      calls.probes += 1;
      calls.asked.push(request.op as Body);
      if (calls.holdProbes) await new Promise<void>((resolve) => (calls.release = resolve));
      return { ok: true };
    },
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

test("Apply asks no second check, undo and redo ask the engine nothing, and a typed number asks once", async ({ page }) => {
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
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  await page.waitForTimeout(700);
  expect(calls.probes, "Apply asks nothing afterwards").toBe(1);
  await page.locator("#modelToolBoolean").click();
  await expect(apply, "opened again on the numbers just applied, which cannot change the cut solid").toBeDisabled();
  await expect(page.locator("#modelNote")).not.toContainText("Checking");

  await page.locator("#modelUndo").click();
  await expect(readout).toContainText("Volume 4000 mm³");
  await expect(apply, "undo returns to a shape these numbers were checked on").toBeEnabled();
  await page.locator("#modelRedo").click();
  await expect(readout).toContainText("Volume 2000 mm³");
  await expect(apply).toBeDisabled();
  await page.waitForTimeout(700);
  expect(calls.probes, "undo and redo ask nothing").toBe(1);
  expect(calls.tree.of("goto"), "both steps were just shown, so the client draws them itself").toHaveLength(0);

  await page.locator("#modelDx").selectText();
  await page.keyboard.type("12.5", { delay: 120 });
  await expect(apply).toBeEnabled();
  await page.waitForTimeout(700);
  expect(calls.probes, "typing 12.5 asks once").toBe(2);
});

test("numbers settled while a check runs ask only for the newest once it answers, and a settled number asks at once", async ({ page }) => {
  const calls = await modeler(page);
  await openModel(page);
  const apply = page.locator("#modelApply");
  calls.holdProbes = true;
  await page.locator("#modelToolBoolean").click();
  await expect.poll(() => calls.release !== null).toBe(true);
  for (const [field, value] of [["#modelDx", "11"], ["#modelDy", "12"], ["#modelDz", "13"]] as const) {
    await page.locator(field).fill(value);
    await page.locator(field).press("Tab");
  }
  await page.waitForTimeout(700);
  expect(calls.probes, "nothing more is sent while the engine still runs a check").toBe(1);
  calls.holdProbes = false;
  calls.release?.();
  await expect.poll(() => calls.probes).toBe(2);
  expect((calls.asked[1] as { size: number[] }).size, "the one sent then is the newest").toEqual([11, 12, 13]);
  await expect(apply).toBeEnabled();
  await page.waitForTimeout(700);
  expect(calls.probes, "the numbers in between are never asked").toBe(2);

  // Tab settles a number: the check goes then, not after the pause kept for typing, which a held clock would hold back.
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.locator("#modelDx").fill("14");
  await page.locator("#modelDx").press("Tab");
  await expect.poll(() => calls.probes).toBe(3);
  expect((calls.asked[2] as { size: number[] }).size).toEqual([14, 12, 13]);
});

test("Apply writes no STEP; leaving Model writes the edited solid once, and save and reopen keep it", async ({ page }) => {
  const calls = await modeler(page);
  await openModel(page);
  await page.locator("#modelToolBoolean").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 2000 mm³");
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelDz").fill("4");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelApply")).toBeDisabled();
  expect(calls.tree.of("export"), "no STEP per Apply").toHaveLength(0);

  await page.locator("#tabPrepare").click();
  await expect.poll(() => calls.tree.of("export").length, { message: "leaving Model writes the solid" }).toBe(1);
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = fs.readFileSync((await download.path())!);
  const written = Buffer.from("LIMEBREP 1 mock 0 *\nEDITED-1").toString("base64");
  expect(saved.toString("utf8"), "the project keeps the edited solid").toContain(written);
  expect(calls.tree.of("export"), "a save after leaving writes nothing new").toHaveLength(1);

  // One part is already listed, and the readout still says Volume, so neither marks the
  // file landing or the solid it opens. The row is replaced when the file is applied.
  await page.locator("#objectList .obj").evaluate((el) => el.setAttribute("data-seen", "before"));
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#projectFile").setInputFiles({ name: "edited.lime", mimeType: "application/json", buffer: saved });
  await page.waitForFunction(() => !document.querySelector("#objectList .obj[data-seen=before]"));
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  const opens = calls.opens.length;
  await page.locator("#tabModel").click();
  await expect.poll(() => calls.opens.length).toBe(opens + 1);
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  const reopened = calls.opens.at(-1)!;
  expect(reopened.filename).toMatch(/\.step$/);
  expect((reopened.seed as Body | undefined)?.dataB64, "Model reopens the edited solid, not the file's").toBe(written);
});

test("a save while the STEP from leaving Model is on its way waits for it instead of exporting again", async ({ page }) => {
  const calls = await modeler(page, 600);
  await openModel(page);
  await page.locator("#modelToolBoolean").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 2000 mm³");

  await page.locator("#tabPrepare").click();
  await expect.poll(() => calls.tree.of("export").length).toBe(1);
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = fs.readFileSync((await download.path())!).toString("utf8");
  expect(saved, "the save carries the solid leaving Model wrote").toContain(Buffer.from("LIMEBREP 1 mock 0 *\nEDITED-1").toString("base64"));
  expect(calls.tree.of("export"), "one export for one solid").toHaveLength(1);
});

test("the piece a split adds opens as a solid of its own and splits again", async ({ page }) => {
  const calls = await modeler(page);
  await openModel(page);
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelPlane").fill("4");
  await page.locator("#modelApply").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await expect(page.locator("#modelReadout")).toContainText("Split. Volume 1600 mm³");

  await page.locator("[data-plate-select]").nth(1).click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 2400 mm³");
  await expect(page.locator("#modelEmpty"), "the piece is no mesh").toBeHidden();
  expect(calls.opens, "the piece is a tree of its own already, with no STEP read").toHaveLength(1);

  await expect(page.locator("#modelPanel"), "Apply ended Split").toBeHidden();
  await page.locator("#modelToolSplit").click();
  await page.locator("#modelPlane").fill("7");
  await page.locator("#modelApply").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  const splits = calls.tree.of("apply");
  expect(splits.map((request) => request.key)).toEqual([splits[0]!.key, splits[0]!.otherKey]);
});
