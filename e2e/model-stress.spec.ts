import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
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

function f32b64(values: number[]): string {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buf.writeFloatLE(value, index * 4));
  return buf.toString("base64");
}

const SAVED_STUDY = "/tmp/lime-stress-box.json";

/** A one-triangle reply the spec controls. The desktop box, when saved, is a second test. */
function mockReply(): string {
  return JSON.stringify({
    ok: true,
    report: {
      representation: "sliced",
      trust: "usable",
      notes: ["Solved at one cell size."],
      margins: [{ kind: "minSafetyFactor", value: 2.5, margin: 1.5, met: true, note: "above the band", hotSpot: { at: [1, 2, 3], role: "outer", governs: "across-layers" } }],
      maxDisplacementMm: 0.1,
      minSafetyFactor: 2.5,
      massG: 1,
    },
    surface: {
      triangles: 1,
      positionsB64: f32b64([0, 0, 0, 4, 0, 0, 0, 4, 0]),
      displacementB64: f32b64([0, 0, 0, 0, 0, 0, 0, 0, -0.2]),
      vonMisesB64: f32b64([1, 4, 9]),
      safetyB64: f32b64([3, 2, 1]),
    },
  });
}

async function openModel(page: Page, reply = mockReply()) {
  await page.addInitScript((text: string) => {
    (window as unknown as { __limeSimStudy?: (body: string) => string }).__limeSimStudy = () => text;
  }, reply);
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
  const patternFits = await page.locator("#stressVariantPattern").evaluate((select) => {
    const style = getComputedStyle(select);
    const canvas = document.createElement("canvas").getContext("2d");
    if (!canvas) return false;
    canvas.font = style.font;
    const text = canvas.measureText("As printed").width;
    const pad = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    return select.clientWidth >= text + pad + 24;
  });
  expect(patternFits).toBe(true);
  const pinned = await page.locator("#stressRun").evaluate((button) => {
    const dock = document.querySelector("#modelDock")?.getBoundingClientRect();
    const scroll = document.querySelector(".model-stress-scroll");
    if (!dock || !(scroll instanceof HTMLElement)) return false;
    const before = button.getBoundingClientRect();
    const top = scroll.scrollTop;
    scroll.scrollTop = scroll.scrollHeight;
    const after = button.getBoundingClientRect();
    scroll.scrollTop = top;
    return before.top >= dock.top - 1 && before.bottom <= dock.bottom + 1 && Math.abs(after.top - before.top) < 1;
  });
  expect(pinned).toBe(true);
  await page.screenshot({ path: "/opt/cursor/artifacts/stress-dock.png" });

  await page.locator("#stressForce").fill("25");
  await page.locator("#stressBed").check();
  await page.locator("#stressRun").click();
  await expect(page.locator("#stressStatus")).toHaveText("");
  await expect(page.locator("#model")).toHaveAttribute("data-stress", /shown [1-9]/);
  await expect(page.locator("#model")).toHaveAttribute("data-stress-solid", "hidden");
  await expect(page.locator("#stressLegend")).toContainText("In-house estimate · as sliced");
  await expect(page.locator("#stressLegend")).toContainText("usable");
  await expect(page.locator("#stressLegend")).toContainText("Solved at one cell size.");
  await expect(page.locator("#model")).toHaveAttribute("data-stress-hotspot", /1\.000,2\.000,3\.000/);
  await expect(page.locator("#stressMargins")).toContainText("minSafetyFactor");
  await expect(page.locator("#stressMargins")).toContainText("2.50");
  await expect(page.locator("#stressMargins")).toContainText("met");
  await expect(page.locator("#stressMargins")).toContainText("above the band");
  await page.locator("#stressProbeX").fill("0");
  await page.locator("#stressProbeY").fill("0");
  await page.locator("#stressProbeZ").fill("0");
  await page.locator("#stressProbeGo").click();
  await expect(page.locator("#stressProbe")).toContainText("1.00 MPa");
  await page.screenshot({ path: "/opt/cursor/artifacts/stress-sliced.png" });
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

test("a saved desktop solve is drawn as sliced", async ({ page }) => {
  test.skip(!existsSync(SAVED_STUDY), "the desktop command did not leave a reply");
  await openModel(page, readFileSync(SAVED_STUDY, "utf8"));
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuStress").click();
  await page.locator("#stressBed").check();
  await page.locator("#stressRun").click();
  await expect(page.locator("#stressLegend")).toContainText("In-house estimate · as sliced");
  await expect(page.locator("#stressLegend")).toContainText("rough");
  await expect(page.locator("#model")).toHaveAttribute("data-stress", /shown [1-9]/);
  await expect(page.locator("#model")).toHaveAttribute("data-stress-solid", "hidden");
  await expect(page.locator("#model")).toHaveAttribute("data-stress-hotspot", /\d/);
  await page.screenshot({ path: "/opt/cursor/artifacts/stress-solved.png" });
});
