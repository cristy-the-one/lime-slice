import { expect, test, type Page } from "@playwright/test";
import { FEATURE_COLOR, featureColor, hexRgb } from "../src/colors";
import { groupFeatures } from "../src/estimate";
import { buildPreviewGeometry, fillHiddenKindMask } from "../src/preview-geom";
import { encodePaths } from "../src/preview-wire";

const THIN = FEATURE_COLOR["thin-wall"];
const GAP = FEATURE_COLOR["gap-fill"];

test("thin wall and gap fill use different legend colors, and the preview reads the same palette", () => {
  expect(THIN).toBe("#E85D4C");
  expect(GAP).toBe("#D946EF");
  expect(THIN).not.toBe(GAP);
  expect(featureColor("thin-wall")).toBe(THIN);
  expect(featureColor("gap-fill")).toBe(GAP);
  expect(contrastOnDark(THIN)).toBeGreaterThan(4.5);
  expect(contrastOnDark(GAP)).toBeGreaterThan(4.5);
});

test("thin-wall time sits with inner walls; gap fill stays with infill", () => {
  const groups = groupFeatures([
    { kind: "outer", seconds: 10, filamentG: 0.2 },
    { kind: "inner", seconds: 20, filamentG: 0.4 },
    { kind: "wall", seconds: 4, filamentG: 0.05 },
    { kind: "thin-wall", seconds: 15, filamentG: 0.15 },
    { kind: "gap-fill", seconds: 8, filamentG: 0.1 },
    { kind: "sparse", seconds: 7, filamentG: 0.08 },
    { kind: "solid", seconds: 3, filamentG: 0.04 },
    { kind: "skirt", seconds: 3, filamentG: 0.02 },
  ]);
  const row = (label: string) => groups.find((group) => group.label === label);
  expect(row("Inner wall")?.seconds).toBeCloseTo(39);
  expect(row("Inner wall")?.grams).toBeCloseTo(0.6);
  expect(row("Infill")?.seconds).toBeCloseTo(18);
  expect(row("Infill")?.grams).toBeCloseTo(0.22);
  expect(row("Other")?.seconds).toBeCloseTo(3);
  expect(row("Other")?.grams).toBeCloseTo(0.02);
  expect(groups.some((group) => group.label === "Thin wall")).toBe(false);
});

test("hiding thin wall does not hide gap fill in the preview slots", () => {
  const built = buildPreviewGeometry({
    layers: [
      {
        z: 0.2,
        paths: [
          { kind: "thin-wall", pts: [[0, 0], [8, 0]], width: 0.4 },
          { kind: "gap-fill", pts: [[0, 2], [8, 2]], width: 0.4 },
        ],
      },
    ],
    min: [0, -1, 0],
    max: [8, 3, 1],
  });
  expect(built.kinds).toEqual(["thin-wall", "gap-fill"]);
  const thinSlot = built.ribbonInfo[0];
  let gapSlot = -1;
  for (let i = 0; i < built.ribbonInfo.length; i += 3) {
    if (built.ribbonInfo[i] !== thinSlot) {
      gapSlot = built.ribbonInfo[i];
      break;
    }
  }
  expect(thinSlot).toBe(0);
  expect(gapSlot).toBe(1);

  const mask = new Float32Array(8);
  fillHiddenKindMask(mask, built.kinds, new Set(["thin-wall"]));
  expect(Array.from(mask.slice(0, 2))).toEqual([1, 0]);
  fillHiddenKindMask(mask, built.kinds, new Set(["gap-fill"]));
  expect(Array.from(mask.slice(0, 2))).toEqual([0, 1]);
});

function voidSlice() {
  const paths = encodePaths([
    { kind: "outer", pts: [[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]], width: 0.45, speed: 40 },
    { kind: "inner", pts: [[1, 1], [19, 1], [19, 9], [1, 9], [1, 1]], width: 0.45, speed: 50 },
    { kind: "thin-wall", pts: [[2, 3], [18, 3]], width: 0.4, speed: 45 },
    { kind: "gap-fill", pts: [[2, 7], [18, 7]], width: 0.4, speed: 45 },
    { kind: "sparse", pts: [[3, 5], [17, 5]], width: 0.45, speed: 80 },
    { kind: "skirt", pts: [[-2, -2], [22, -2]], width: 0.45, speed: 40 },
  ]);
  const layers = Array.from({ length: 8 }, (_, i) => ({
    index: i,
    z: (i + 1) * 0.2,
    height: 0.2,
    note: "void split",
    speedWalls: 2,
    toughnessWalls: 0,
    supportPaths: 0,
    seconds: 1,
    paths,
  }));
  return {
    coreMs: 1,
    baselineMs: 0,
    blend: "speed",
    mesh: { triangles: 12, min: [0, 0, 0], max: [20, 10, 1.6] },
    sanity: { ok: true, notes: [], layers: layers.length, finalE: 1, extrusionLengthMm: 1 },
    estimate: {
      seconds: 63,
      filamentMm: 100,
      filamentG: 1.5,
      arcMoves: 0,
      travelMm: 0,
      retracts: 0,
      scarfedLoops: 0,
      byFeature: [
        { kind: "outer", seconds: 10, filamentMm: 10, filamentG: 0.2 },
        { kind: "inner", seconds: 20, filamentMm: 20, filamentG: 0.4 },
        { kind: "thin-wall", seconds: 15, filamentMm: 8, filamentG: 0.15 },
        { kind: "gap-fill", seconds: 8, filamentMm: 6, filamentG: 0.1 },
        { kind: "sparse", seconds: 7, filamentMm: 5, filamentG: 0.08 },
        { kind: "skirt", seconds: 3, filamentMm: 2, filamentG: 0.02 },
      ],
    },
    compare: [],
    gcode: "; fixture\n",
    layers,
  };
}

test("legend toggles and the estimate table keep thin wall and gap fill apart", async ({ page }) => {
  const slice = voidSlice();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: slice }));
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("Inner wall");

  const estimate = await page.locator("#estimate table.est tr").evaluateAll((trs) =>
    trs.map((tr) => {
      const cells = [...tr.querySelectorAll("td")].map((td) => (td.textContent ?? "").trim());
      return `${cells[0]} ${cells[1]}`;
    }),
  );
  expect(estimate).toEqual(["Outer wall 10 s", "Inner wall 35 s", "Infill 15 s", "Other 3 s"]);

  const swatch = (label: string) =>
    page.locator("#legend label", { hasText: new RegExp(`^${label}`) }).locator(".swatch").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await swatch("Thin wall")).toBe(cssRgb(THIN));
  expect(await swatch("Gap fill")).toBe(cssRgb(GAP));

  await page.locator("#theme").selectOption("dark");
  await page.locator("#rangeHigh").evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = input.max;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const settled = async (sel: string) => {
    const loc = page.locator(sel);
    let prev = await loc.screenshot();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(200);
      const next = await loc.screenshot();
      if (next.equals(prev)) return next;
      prev = next;
    }
    throw new Error(`${sel} did not settle`);
  };
  const both2d = await settled("#view");
  const both3d = await settled("#view3d");

  await legend(page, "Thin wall").uncheck();
  await expect(legend(page, "Gap fill")).toBeChecked();
  const thinOff2d = await settled("#view");
  const thinOff3d = await settled("#view3d");
  expect(thinOff2d.equals(both2d)).toBe(false);
  expect(thinOff3d.equals(both3d)).toBe(false);

  await legend(page, "Gap fill").uncheck();
  const neither2d = await settled("#view");
  const neither3d = await settled("#view3d");
  // Gap fill was still drawn after thin wall was hidden, so hiding it changes the picture.
  expect(neither2d.equals(thinOff2d)).toBe(false);
  expect(neither3d.equals(thinOff3d)).toBe(false);

  await legend(page, "Thin wall").check();
  await expect(legend(page, "Gap fill")).not.toBeChecked();
  const gapOff2d = await settled("#view");
  const gapOff3d = await settled("#view3d");
  expect(gapOff2d.equals(both2d)).toBe(false);
  expect(gapOff2d.equals(thinOff2d)).toBe(false);
  expect(gapOff2d.equals(neither2d)).toBe(false);
  expect(gapOff3d.equals(both3d)).toBe(false);
  expect(gapOff3d.equals(thinOff3d)).toBe(false);
  expect(gapOff3d.equals(neither3d)).toBe(false);
});

function legend(page: Page, label: string) {
  return page.locator("#legend label", { hasText: new RegExp(`^${label}`) }).locator("input");
}

function cssRgb(hex: string) {
  const [r, g, b] = hexRgb(hex);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Contrast of an sRGB hex against the dark stage `#0c0e12`. */
function contrastOnDark(hex: string) {
  const [r, g, b] = hexRgb(hex).map(linear);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const stage = 0.2126 * linear(12) + 0.7152 * linear(14) + 0.0722 * linear(18);
  const [hi, lo] = lum > stage ? [lum, stage] : [stage, lum];
  return (hi + 0.05) / (lo + 0.05);
}

function linear(channel: number) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
