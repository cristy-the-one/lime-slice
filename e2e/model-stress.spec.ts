import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionalCards } from "../src/sim/cards.ts";
import { cannedBeam, emptyStudy, type CannedResult } from "../src/sim/study.ts";
import { facePoints, openStressModel as openModel } from "./stress-mock";

const SAVED_STUDY = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sim-study-box.json");

/** Load the top face through Stress's pick mode, as a user does. */
async function loadTopFace(page: Page) {
  const faces = await facePoints(page);
  const top = [...faces.values()].find((at) => at.normal[2]! > 0.5);
  if (!top) throw new Error("no top face on screen");
  await page.locator("#stressLoadPick").click();
  await page.mouse.click(top.x, top.y);
  await expect(page.locator("#stressLoadChips .stress-chip")).toHaveCount(1);
  await page.locator("#stressLoadPick").click();
}

test("stress menu, canned estimate, probe, section, and plate undo", async ({ page }) => {
  await openModel(page);
  const rows = await page.locator("#modelHistoryTree .mh-row").count();
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuStress").click();
  await expect(page.locator("#modelStressMain")).toBeVisible();
  await expect(page.locator("#modelStress")).toContainText("In-house estimate");
  await expect(page.locator("#stressProvisional")).toHaveText("Provisional card, not a measurement.");
  await page.locator("#stressVariants > summary").click();
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

  await loadTopFace(page);
  await page.locator("#stressForce").fill("25");
  await page.locator("#stressBed").click();
  await page.locator("#stressRun").click();
  await expect(page.locator("#stressStatus")).toHaveText("");
  await expect(page.locator("#model")).toHaveAttribute("data-stress", /shown [1-9]/);
  await expect(page.locator("#model")).toHaveAttribute("data-stress-solid", "hidden");
  await expect(page.locator("#stressLegend")).toContainText("In-house estimate · as sliced");
  await expect(page.locator("#stressLegend")).toContainText("usable");
  await expect(page.locator("#stressLegend")).toContainText("Solved at one cell size.");
  await expect(page.locator("#model")).toHaveAttribute("data-stress-hotspot", /1\.000,2\.000,3\.000/);
  await expect(page.locator("#stressMargins")).toContainText("Safety factor ≥ 1.0");
  await expect(page.locator("#stressMargins")).toContainText("2.50");
  await expect(page.locator("#stressMargins")).toContainText("(margin 1.50)");
  await expect(page.locator("#stressMargins")).toContainText("met");
  await expect(page.locator("#stressMargins")).toContainText("above the band");
  await expect(page.locator("#stressMargins")).toContainText("across-layers");
  await expect(page.locator("#stressMargins")).toContainText("workplane_print_up");
  await page.screenshot({ path: "/opt/cursor/artifacts/stress-sliced.png" });
  await page.locator("#stressVariantScale").fill("2");
  await page.locator("#stressVariantAdd").click();
  await page.locator("#stressVariantWalls").fill("7");
  await page.locator("#stressVariantScale").fill("1");
  await page.locator("#stressVariantAdd").click();
  await page.locator("#stressSweep").click();
  await expect(page.locator("#stressSweepStatus")).toHaveText("Each variant is a slice plus a solve.");
  await expect(page.locator("#stressSweepTable")).toBeVisible();
  await expect(page.locator("#stressSweepBody tr")).toHaveCount(2);
  await expect(page.locator("#stressSweepBody tr").nth(0)).toContainText("0.200");
  await expect(page.locator("#stressSweepBody tr").nth(0)).toContainText("1.25");
  await expect(page.locator("#stressSweepBody tr").nth(0)).toContainText("not met");
  await expect(page.locator("#stressSweepBody tr").nth(0)).toContainText("Provisional card, not a measurement.");
  await expect(page.locator("#stressSweepBody tr").nth(1)).toContainText("7 walls");
  await expect(page.locator("#stressSweepBody tr").nth(1)).toContainText("0.100");
  await expect(page.locator("#stressSweepBody tr").nth(1)).toContainText("2.50");
  await expect(page.locator("#stressSweepBody tr").nth(1)).toContainText("above the band");
  await expect(page.locator("#stressSweepBody tr").nth(1)).not.toContainText("not met");
  await page.locator("#stressMinSafety").fill("2");
  await page.locator("#stressMaxDeflection").fill("1.5");
  await page.locator("#stressSweep").click();
  await page.waitForFunction(() => ((window as unknown as { __limeSimBodies?: string[] }).__limeSimBodies?.length ?? 0) >= 4);
  const bodies = await page.evaluate(() => (window as unknown as { __limeSimBodies?: string[] }).__limeSimBodies ?? []);
  const parsedBodies = bodies.map((text) => JSON.parse(text) as { request?: { walls?: number }; study?: { constraints?: { kind: string; value: number }[]; loads?: { force?: number[] }[] } });
  expect(parsedBodies).toHaveLength(4);
  expect(parsedBodies.filter((body) => body.request?.walls === 7)).toHaveLength(2);
  const first = parsedBodies[0]?.study?.constraints ?? [];
  expect(first).toEqual([{ kind: "minSafetyFactor", value: 1 }]);
  const targeted = parsedBodies[3]?.study?.constraints ?? [];
  expect(targeted).toEqual([{ kind: "minSafetyFactor", value: 2 }, { kind: "maxDeflectionMm", value: 1.5 }]);
  await page.locator("#stressForce").fill("40");
  await page.locator("#stressSweep").click();
  await page.waitForFunction(() => ((window as unknown as { __limeSimBodies?: string[] }).__limeSimBodies?.length ?? 0) >= 6);
  const afterLoad = await page.evaluate(() => (window as unknown as { __limeSimBodies?: string[] }).__limeSimBodies ?? []);
  const latest = JSON.parse(afterLoad[4] ?? "{}") as { study?: { loads?: { force?: number[] }[] } };
  expect(latest.study?.loads?.[0]?.force).toEqual([0, 0, -40]);
  await page.locator("#modelUndo").click();
  await expect(page.locator("#stressForce")).toHaveValue("25");
  await page.locator("#stressVariants").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/opt/cursor/artifacts/stress-sweep.png" });

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
  await page.screenshot({ path: "/opt/cursor/artifacts/stress-view.png" });

  const canvas = page.locator("#model");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("the model view has no box");
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.locator("#stressProbe")).toContainText(/\d.*MPa/);

  await expect(page.locator("#modelHistoryTree .mh-row")).toHaveCount(rows);
  await page.locator("#modelUndo").click();
  await expect(page.locator("#stressBed")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#modelHistoryTree .mh-row")).toHaveCount(rows);

  await page.locator("#modelLookOpen").click();
  await page.locator("#modelSection").check();
  await expect(page.locator("#model")).toHaveAttribute("data-stress", /shown [1-9]\d* hidden [1-9]\d*/);
  await page.screenshot({ path: "/opt/cursor/artifacts/stress-section.png" });

  await page.locator("#stressForce").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelStressMain")).toBeHidden();
  await expect(page.locator("#stressLegend"), "folding keeps the study on the part").toBeVisible();

  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuStress").click();
  await page.locator("#stressBed").click();
  await page.locator("#tabPrepare").click();
  await expect(page.locator("[data-plate-stress]")).toHaveCount(1);
  await expect(page.locator("[data-plate-stress]")).toHaveText("In-house estimate");
});

test("a saved desktop solve is drawn as sliced", async ({ page }) => {
  await openModel(page, readFileSync(SAVED_STUDY, "utf8"));
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuStress").click();
  await loadTopFace(page);
  await page.locator("#stressBed").click();
  await page.locator("#stressRun").click();
  await expect(page.locator("#stressLegend")).toContainText("In-house estimate · as sliced");
  await expect(page.locator("#stressLegend")).toContainText("rough");
  await expect(page.locator("#model")).toHaveAttribute("data-stress", /shown [1-9]/);
  await expect(page.locator("#model")).toHaveAttribute("data-stress-solid", "hidden");
  await expect(page.locator("#model")).toHaveAttribute("data-stress-hotspot", /\d/);
  await page.screenshot({ path: "/opt/cursor/artifacts/stress-solved.png" });
});
