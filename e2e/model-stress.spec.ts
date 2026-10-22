import { expect, test, type Page } from "@playwright/test";
import { provisionalCards } from "../src/sim/cards.ts";
import { NOT_WIRED } from "../src/sim/label.ts";
import { cannedBeam, emptyStudy, type CannedResult } from "../src/sim/study.ts";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

function boxSolid(volumeMm3: number): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 10, y * 10, z * 10];
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
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 100 })), edges: [] };
}

function volumeOf(request: Body): number {
  const primitive = request.primitive as { size?: number[] } | undefined;
  const op = request.op as { kind?: string; size?: number[] } | undefined;
  const size = primitive?.size ?? (op?.kind === "root" ? op.size : undefined);
  if (size && size.length >= 3) return (size[0] ?? 0) * (size[1] ?? 0) * (size[2] ?? 0);
  return 4000;
}

async function openModel(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid(4000).positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, {
    open: (request) => boxSolid(volumeOf(request)),
    apply: (request) => boxSolid(volumeOf(request)),
    probe: () => ({ ok: true }),
  });
  await page.goto("/?stressFixture=1");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
}

test("stress menu, canned estimate, probe, section, and plate undo", async ({ page }) => {
  await openModel(page);
  const rows = await page.locator("#modelHistoryTree .mh-row").count();
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuStress").click();
  await expect(page.locator("#modelStressMain")).toBeVisible();
  await expect(page.locator("#modelStress")).toContainText("In-house estimate");
  await expect(page.locator("#stressProvisional")).toHaveText("Provisional card, not a measurement.");

  await page.locator("#stressForce").fill("25");
  await page.locator("#stressBed").check();
  await page.locator("#stressRun").click();
  await expect(page.locator("#stressStatus")).toHaveText(NOT_WIRED);
  await expect(page.locator("#stressLegend")).toBeHidden();
  await page.locator("#stressVariantScale").fill("2");
  await page.locator("#stressVariantAdd").click();
  await page.locator("#stressSweep").click();
  await expect(page.locator("#stressSweepStatus")).toHaveText(NOT_WIRED);
  await expect(page.locator("#stressSweepTable")).toBeHidden();

  const study = emptyStudy();
  study.holds = [{ kind: "bed", faces: [] }];
  study.loads = [{ kind: "force", faces: [], magnitude: 25, direction: [0, 0, -1] }];
  const made = cannedBeam(study, { min: [0, 0, 0], max: [10, 10, 10] }, provisionalCards()[1]!, "vonMises");
  if ("error" in made) throw new Error(made.error);
  await page.evaluate((next: CannedResult) => {
    const show = (window as unknown as { __limeStressFixture?: (value: CannedResult) => void }).__limeStressFixture;
    if (!show) throw new Error("the stress fixture is not on this page");
    show(next);
  }, made);
  await expect(page.locator("#stressLegend")).toContainText("In-house estimate");
  await expect(page.locator("#stressLegend")).toContainText("rough");
  await expect(page.locator("#stressLegend")).toContainText("Provisional card, not a measurement.");
  await page.locator("#stressVariants").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/opt/cursor/artifacts/stress-sweep.png" });
  await page.screenshot({ path: "/opt/cursor/artifacts/stress-view.png" });

  const canvas = page.locator("#model");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("the model view has no box");
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.locator("#stressProbe")).toContainText(/\d/);

  await page.locator("#stressProbeX").fill("10");
  await page.locator("#stressProbeY").fill("5");
  await page.locator("#stressProbeZ").fill("5");
  await page.locator("#stressProbeGo").click();
  await expect(page.locator("#stressProbe")).toContainText("MPa");

  await expect(page.locator("#modelHistoryTree .mh-row")).toHaveCount(rows);
  await page.locator("#modelUndo").click();
  await expect(page.locator("#stressBed")).not.toBeChecked();
  await expect(page.locator("#modelHistoryTree .mh-row")).toHaveCount(rows);

  await page.locator("#modelLookOpen").click();
  await page.locator("#modelSection").check();
  await expect(page.locator("#model")).toHaveAttribute("data-stress", /shown [1-9]\d* hidden [1-9]\d*/);
  await page.screenshot({ path: "/opt/cursor/artifacts/stress-section.png" });

  await page.locator("#stressForce").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelStressMain")).toBeHidden();
  await expect(page.locator("#stressLegend")).toBeHidden();

  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuStress").click();
  await page.locator("#stressBed").check();
  await page.locator("#tabPrepare").click();
  await expect(page.locator("[data-plate-stress]")).toHaveCount(1);
  await expect(page.locator("[data-plate-stress]")).toHaveText("In-house estimate");
});
