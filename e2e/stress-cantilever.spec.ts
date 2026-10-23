/**
 * The Stress guide's worked example, end to end in Model: a 100 × 10 × 10 mm
 * PLA cantilever, its left end held, 20 N down on its right end. The solve is
 * the real engine's reply for that study (`e2e/fixtures/sim-cantilever.json`,
 * written by `mcp/sim-paint.test.ts`, which also checks it against beam
 * theory), so this spec proves what the user sees: the part painted red at the
 * held end and blue at the free end, on the part itself, with the legend's
 * peak at P L c / I. And a part the load cannot bend says so instead of
 * drawing noise.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { facePoints, openStress, openStressModel } from "./stress-mock";

const SHOTS = "test-results/stress-heatmap";
const CANTILEVER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sim-cantilever.json"), "utf8");
/** P L c / I for 20 N on a 100 mm beam, 10 × 10 mm. */
const SIGMA = (20 * 100 * 5) / ((10 * 10 ** 3) / 12);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
});

/** Pick `face` for the hold or the load, through the panel's pick mode. */
async function pick(page: Page, which: "Hold" | "Load", at: { x: number; y: number }) {
  await page.locator(`#stress${which}Pick`).click();
  await page.mouse.click(at.x, at.y);
  await expect(page.locator(`#stress${which}Chips .stress-chip`)).toHaveCount(1);
  await page.locator(`#stress${which}Pick`).click();
}

/** Red-dominant and blue-dominant pixels in a square around `at`, read from a screenshot of the page. */
async function hues(page: Page, png: Buffer, at: { x: number; y: number }, half = 14) {
  return page.evaluate(
    async ({ data, x, y, half }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(Math.round(x - half), Math.round(y - half), half * 2, half * 2).data;
      let red = 0;
      let blue = 0;
      for (let i = 0; i < px.length; i += 4) {
        const [r, g, b] = [px[i]!, px[i + 1]!, px[i + 2]!];
        if (r > 150 && r > b + 60 && r > g) red += 1;
        if (b > 120 && b > r + 40) blue += 1;
      }
      return { red, blue };
    },
    { data: png.toString("base64"), x: at.x, y: at.y, half },
  );
}

test("the cantilever example is painted on the part: red at the held end, blue at the free end", async ({ page }) => {
  await openStressModel(page, CANTILEVER, { width: 1440, height: 1000 }, [100, 10, 10]);
  await openStress(page);
  // Model opens looking at the +X end, the free one. A bar shows one end at a time, so the view turns between picks.
  let faces = await facePoints(page);
  const right = faces.get(5);
  if (!right) throw new Error(`faces on screen: ${[...faces.keys()].join(" ")}`);
  await pick(page, "Load", right);
  await expect(page.locator("#stressLoadChips .stress-chip")).toHaveText(["Face 6"]);
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.move(box.x + box.width - 60, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 460, box.y + 80, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(2500);
  faces = await facePoints(page);
  const left = faces.get(4);
  if (!left) throw new Error(`faces on screen: ${[...faces.keys()].join(" ")}`);
  await page.locator("#stressHoldFaces").click();
  await pick(page, "Hold", left);
  await expect(page.locator("#stressHoldChips .stress-chip")).toHaveText(["Face 5"]);
  await page.locator("#stressForce").fill("20");
  await page.locator("#stressForce").press("Tab");
  await page.locator("#stressCard").selectOption("inhouse-pla");
  await page.locator("#stressRun").click();

  const model = page.locator("#model");
  await expect(model).toHaveAttribute("data-stress-solid", "hidden");
  await expect(model).toHaveAttribute("data-stress", /shown [1-9]/);
  await expect(page.locator("#stressNothing")).toBeHidden();
  const legend = page.locator("#stressLegend");
  await expect(legend).toContainText("In-house estimate · as sliced");
  const text = (await page.locator("#stressLegendText").textContent()) ?? "";
  const peak = Number(/peak ([\d.]+) MPa/.exec(text)?.[1]);
  // The fixture is painted on 5 mm triangles to stay small, so its corners can miss the peak by half a triangle.
  // The desktop splits at the cell size; mcp/sim-paint.test.ts holds that to 3%.
  expect(Math.abs(peak / SIGMA - 1), `legend "${text}" against P L c / I = ${SIGMA} MPa`).toBeLessThanOrEqual(0.05);
  await expect(page.locator("#stressDeform"), "the deformed shape is opt-in").not.toBeChecked();

  await page.waitForTimeout(500);
  const png = await page.screenshot({ path: `${SHOTS}/cantilever.png` });
  faces = await facePoints(page);
  const top = [...faces.values()].find((at) => at.normal[2]! > 0.5)!;
  /** A point on the top face, `s` of the way from its centre toward an end face's centre. */
  const toward = (end: { x: number; y: number }, s: number) => ({ x: top.x + s * (end.x - top.x), y: top.y + s * (end.y - top.y) });
  const held = await hues(page, png, toward(faces.get(4)!, 0.75));
  const free = await hues(page, png, toward(faces.get(5)!, 0.75));
  expect(held.red, `held end ${JSON.stringify(held)}`).toBeGreaterThan(held.blue);
  expect(held.red).toBeGreaterThan(20);
  expect(free.blue, `free end ${JSON.stringify(free)}`).toBeGreaterThan(free.red);
  expect(free.blue).toBeGreaterThan(20);

  // The deformed shape, when asked for, states its scale.
  await page.locator("#stressDeform").check();
  await expect(page.locator("#stressDeformLabel")).toHaveText(/^Deformed shape ×[\d.,]+$/);
  await expect(page.locator("#stressScaleRow")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/cantilever-deformed.png` });
});

/** The owner's case: a 500 mm bar held on the bed, 10 N pressing it into the bed. The engine's peak is 0.0025 MPa. */
function quietReply(): string {
  const f32 = (values: number[]) => Buffer.from(Float32Array.from(values).buffer).toString("base64");
  return JSON.stringify({
    ok: true,
    report: {
      representation: "sliced",
      trust: "rough",
      notes: ["Provisional card, not a measurement.", "The sliced result moved 99% between two cell sizes."],
      margins: [],
      maxDisplacementMm: 0.00034,
      minSafetyFactor: 1379,
      massG: 38,
      resolutions: [{ governingValue: 1379 }, { governingValue: 12 }],
    },
    surface: {
      triangles: 1,
      painted: true,
      positionsB64: f32([0, 0, 0, 500, 0, 0, 0, 20, 0]),
      displacementB64: f32([0, 0, -0.0003, 0, 0, 0.0002, 0, 0, 0]),
      vonMisesB64: f32([0.0025, 0.0001, 0.001]),
      safetyB64: f32([6000, 150000, 15000]),
    },
  });
}

test("a load the bed takes is not drawn as a shape: the panel says what is missing", async ({ page }) => {
  await openStressModel(page, quietReply(), { width: 1440, height: 1000 }, [500, 20, 20]);
  await openStress(page);
  const faces = await facePoints(page);
  const top = [...faces.values()].find((at) => at.normal[2]! > 0.5);
  if (!top) throw new Error("no top face on screen");
  await page.locator("#stressBed").click();
  await expect(page.locator("#stressBedHint")).toContainText("hold an end face with Faces");
  await pick(page, "Load", top);
  await page.locator("#stressRun").click();

  const nothing = page.locator("#stressNothing");
  await expect(nothing).toHaveText(
    "Nothing bends this part: the bed holds it, and the load presses it into the bed (peak 0.00250 MPa). Hold one end with Faces, and load the other end.",
  );
  await expect(page.locator("#model"), "the part stays as it is, with its hold and load").toHaveAttribute("data-stress-solid", "shown");
  await expect(page.locator("#stressLegend")).toBeHidden();
  await expect(page.locator("#stressField")).toBeHidden();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/nothing-to-show.png` });
});
