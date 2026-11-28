import { KIND_SHIFT, STYLE_WORDS, type PointRun } from "./preview-geom.ts";
import {
  SHELL_BAND_LAYERS,
  TOP_INFILL_LAYERS,
  beadWidthPx,
  interiorWindow,
  layerKindsOf,
  layoutBeads,
  lineMode,
  revealInterior,
  shellEnclosed,
  shellFromLayerKinds,
  visibleSpans,
} from "./preview-draw.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `\n got ${JSON.stringify(actual)}\n want ${JSON.stringify(expected)}`);
}

/** One path: `points - 1` segments of `slot`, then a terminator. The x of each point is a global counter, so order is visible. */
let seq = 0;
function path(slot: number, points: number, halfUm: number, into: { xyz: number[]; style: number[] }) {
  for (let i = 0; i < points; i++) {
    into.xyz.push(seq, 0, 0);
    seq += 1;
    const end = i === points - 1;
    into.style.push(end ? 0 : slot * KIND_SHIFT, 0, end ? 0 : halfUm, end ? 0 : 200);
  }
}

function runOf(layers: { xyz: number[]; style: number[] }[]): PointRun {
  const xyz: number[] = [];
  const style: number[] = [];
  const at = [0];
  for (const layer of layers) {
    xyz.push(...layer.xyz);
    style.push(...layer.style);
    at.push(xyz.length / 3);
  }
  return { xyz: new Float32Array(xyz), style: new Uint16Array(style), at: new Int32Array(at) };
}

function layer(...paths: { slot: number; points: number; halfUm?: number }[]) {
  const into = { xyz: [] as number[], style: [] as number[] };
  for (const p of paths) path(p.slot, p.points, p.halfUm ?? 225, into);
  return into;
}

const names = ["outer", "sparse", "solid", "top"];
const mixed = runOf([
  layer({ slot: 0, points: 3 }, { slot: 1, points: 4 }, { slot: 0, points: 2 }),
  layer({ slot: 1, points: 3 }, { slot: 2, points: 2 }, { slot: 0, points: 3 }),
]);
const laid = layoutBeads(mixed);

eq("kinds sit in slot order", laid.layouts.map((k) => k.slot), [0, 1, 2]);
eq("each kind keeps its own layer starts", laid.layouts.map((k) => Array.from(k.at)), [
  [0, 5, 8],
  [8, 12, 15],
  [15, 15, 17],
]);
// Outer paths stay in path order (layer 0's two paths, then layer 1), then sparse, then solid.
eq("points are grouped by kind, paths keep their order", Array.from(laid.xyz).filter((_, i) => i % 3 === 0), [
  0, 1, 2, 7, 8, 14, 15, 16, 3, 4, 5, 6, 9, 10, 11, 12, 13,
]);
check("style follows the points", laid.style.length === laid.xyz.length / 3 * STYLE_WORDS);
check("a path terminator still ends the path", laid.style[2 * STYLE_WORDS + 3] === 0 && laid.style[3 * STYLE_WORDS] === 0);
check("nominal width is the usual bead, in mm", Math.abs(laid.nominalWidth - 0.45) < 1e-6);
check("the source run is untouched", mixed.xyz[0] === 0 && mixed.xyz[3] === 1 && mixed.style[0] === 0);

const all = visibleSpans(laid.layouts, names, 0, 1, new Set(), null);
eq("every kind visible is one draw", all, [{ from: 0, count: 16 }]);

const hiddenSparse = visibleSpans(laid.layouts, names, 0, 1, new Set(["sparse"]), null);
eq("a hidden kind is left out, and its neighbours stay apart", hiddenSparse, [
  { from: 0, count: 7 },
  { from: 15, count: 1 },
]);

const tall = layoutBeads(runOf(Array.from({ length: 10 }, () => layer({ slot: 0, points: 2 }, { slot: 1, points: 2 }, { slot: 2, points: 2 }))));
const infillLo = 9 - (TOP_INFILL_LAYERS - 1);
const moving = visibleSpans(tall.layouts, names, 0, 9, new Set(), [[infillLo, 9]]);
eq("while moving, walls stay whole and each interior kind keeps only its top layers", moving, [
  { from: 0, count: tall.layouts[0].at[10] - 1 },
  { from: tall.layouts[1].at[infillLo], count: tall.layouts[1].at[10] - tall.layouts[1].at[infillLo] - 1 },
  { from: tall.layouts[2].at[infillLo], count: tall.layouts[2].at[10] - tall.layouts[2].at[infillLo] - 1 },
]);
check("those N layers are 8", TOP_INFILL_LAYERS === 8);
eq("a chunk below that window draws walls only", visibleSpans(tall.layouts, names, 0, 9, new Set(), [[10, 10]]), [
  { from: 0, count: tall.layouts[0].at[10] - 1 },
]);
eq("the full height, including infill, is one span", visibleSpans(tall.layouts, names, 0, 9, new Set(), [[0, 9]]).length, 1);
eq("a partial slider is one span per kind", visibleSpans(tall.layouts, names, 0, 3, new Set(), null).length, 3);
const skin = layoutBeads(runOf(Array.from({ length: 4 }, () => layer({ slot: 3, points: 2 }, { slot: 1, points: 2 }))));
eq("top skin stays whole on the same draw as the sparse layers under the slider", visibleSpans(skin.layouts, names, 0, 3, new Set(), [[2, 3]]), [
  { from: skin.layouts[0].at[2], count: skin.layouts[1].at[4] - skin.layouts[0].at[2] - 1 },
]);

// 20 layers. The resting window keeps interior infill on 0..7 and 12..19 and skips 8..11.
const deep = layoutBeads(runOf(Array.from({ length: 20 }, () => layer({ slot: 0, points: 2 }, { slot: 1, points: 2 }, { slot: 2, points: 2 }))));
const bottomEnd = TOP_INFILL_LAYERS;
const topStart = 19 - (TOP_INFILL_LAYERS - 1);
const rested = visibleSpans(deep.layouts, names, 0, 19, new Set(), [[0, bottomEnd - 1], [topStart, 19]]);
const outerAt = deep.layouts[0].at;
const sparseAt = deep.layouts[1].at;
const solidAt = deep.layouts[2].at;
eq("at rest, interior infill is drawn at both ends and skipped between them", rested, [
  { from: outerAt[0], count: sparseAt[bottomEnd] - outerAt[0] - 1 },
  { from: sparseAt[topStart], count: solidAt[bottomEnd] - sparseAt[topStart] - 1 },
  { from: solidAt[topStart], count: solidAt[20] - solidAt[topStart] - 1 },
]);
const covers = (index: number) => rested.some((span) => index >= span.from && index < span.from + span.count + 1);
check("the bottom interior layer is in a span", covers(sparseAt[0]));
check("the top interior layer is in a span", covers(sparseAt[topStart]));
check("a middle interior layer is not in any span", !covers(sparseAt[bottomEnd]) && !covers(solidAt[bottomEnd]));
eq("ends that meet cover the whole interior", visibleSpans(tall.layouts, names, 0, 9, new Set(), [[0, 7], [2, 9]]).length, 1);
eq("moving keeps only the top band, even when a rest frame would open the interior", interiorWindow(true, 0, 19, true), [[12, 19]]);
eq("a resting frame keeps both ends", interiorWindow(false, 4, 30, false), [[4, 11], [23, 30]]);
eq("a revealed resting frame draws the whole interior", interiorWindow(false, 0, 19, true), null);
const whole = visibleSpans(deep.layouts, names, 0, 19, new Set(), null);
check("the whole interior includes the middle layer", whole.some((span) => sparseAt[bottomEnd] >= span.from && sparseAt[bottomEnd] < span.from + span.count + 1));

const closed = shellFromLayerKinds([
  { layer: 0, kinds: new Set(["outer", "inner", "solid", "skirt"]) },
  { layer: 8, kinds: new Set(["outer", "inner", "sparse"]) },
  { layer: 40, kinds: new Set(["outer", "top"]) },
  { layer: 41, kinds: new Set(["ironing"]) },
]);
check("a shelled part is enclosed", closed.hasWalls && closed.hasTopSkin && closed.hasBottomSkin);
const openTop = shellFromLayerKinds([
  { layer: 0, kinds: new Set(["outer", "solid"]) },
  { layer: 40, kinds: new Set(["outer", "sparse"]) },
]);
check("no top skin is not enclosed", openTop.hasWalls && openTop.hasBottomSkin && !openTop.hasTopSkin);
const openBottom = shellFromLayerKinds([
  { layer: 0, kinds: new Set(["outer", "sparse"]) },
  { layer: 40, kinds: new Set(["outer", "top"]) },
]);
check("no bottom skin is not enclosed", openBottom.hasWalls && openBottom.hasTopSkin && !openBottom.hasBottomSkin);
const noWalls = shellFromLayerKinds([
  { layer: 0, kinds: new Set(["solid", "sparse"]) },
  { layer: 10, kinds: new Set(["top"]) },
]);
check("no walls is not enclosed", !noWalls.hasWalls && noWalls.hasTopSkin && noWalls.hasBottomSkin);
const classic = shellFromLayerKinds([
  { layer: 0, kinds: new Set(["wall", "infill"]) },
  { layer: 10, kinds: new Set(["wall", "infill"]) },
]);
check("one infill kind cannot show a skin, so it is not enclosed", classic.hasWalls && !classic.hasTopSkin && !classic.hasBottomSkin);
const stepped = shellFromLayerKinds([
  { layer: 0, kinds: new Set(["outer", "solid"]) },
  { layer: 100 - SHELL_BAND_LAYERS, kinds: new Set(["top"]) },
  { layer: 100, kinds: new Set(["outer", "sparse"]) },
]);
check("a top skin a band below the open top does not close it", !stepped.hasTopSkin);
const near = shellFromLayerKinds([
  { layer: 0, kinds: new Set(["outer", "solid"]) },
  { layer: 100 - (SHELL_BAND_LAYERS - 1), kinds: new Set(["top"]) },
  { layer: 100, kinds: new Set(["outer"]) },
]);
check("a top skin inside the band closes the top", near.hasTopSkin);
const rows = layerKindsOf(3, deep.layouts, names);
const firstRow = rows[0];
check("layer kinds follow the chunk's first layer", firstRow?.layer === 3 && firstRow.kinds.size === 3 && ["outer", "sparse", "solid"].every((kind) => firstRow.kinds.has(kind)));
check("one open object opens the plate", !shellEnclosed([closed, openTop]));
check("every closed object stays enclosed", shellEnclosed([closed, near]));

const base = { hidden: new Set<string>(), kindNames: ["outer", "inner", "sparse", "solid", "top"], section: false, cut: false, colorMode: "feature" as const, enclosed: true };
check("a closed shell in feature colour keeps the resting window", !revealInterior(base));
check("weight colours the shell, so the window stays", !revealInterior({ ...base, colorMode: "weight" }));
check("speed colours the shell, so the window stays", !revealInterior({ ...base, colorMode: "speed" }));
check("stress colour shows the inside", revealInterior({ ...base, colorMode: "stress" }));
check("safety colour shows the inside", revealInterior({ ...base, colorMode: "safety" }));
check("a hidden outer wall shows the inside", revealInterior({ ...base, hidden: new Set(["outer"]) }));
check("a hidden wall kind shows the inside when that kind is the perimeter", revealInterior({ ...base, hidden: new Set(["wall"]), kindNames: ["wall", "infill"] }));
check("hiding an outer kind the slice does not have changes nothing", !revealInterior({ ...base, hidden: new Set(["outer"]), kindNames: ["wall", "infill"] }));
check("a hidden inner wall still leaves the outer shell", !revealInterior({ ...base, hidden: new Set(["inner"]) }));
check("a section plane shows the inside", revealInterior({ ...base, section: true }));
check("a cut shows the inside", revealInterior({ ...base, cut: true }));
check("an open shell shows the inside", revealInterior({ ...base, enclosed: false }));

check("zoomed-in beads stay boxes", lineMode(false, 4) === false);
check("under the low threshold they become lines", lineMode(false, 1.1) === true);
check("inside the band a box chunk stays boxes", lineMode(false, 1.3) === false);
check("a line chunk stays lines through the band", lineMode(true, 1.6) === true);
check("well above the threshold lines switch back", lineMode(true, 1.9) === false);

const px = beadWidthPx(100, 0.45, 1000, 40, 1);
const expectPx = 0.45 * 1000 / (2 * 100 * Math.tan((40 * Math.PI) / 360));
check("projected width follows distance, fov, and nominal width", Math.abs(px - expectPx) < 1e-6, `${px} vs ${expectPx}`);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("preview-draw: kind spans, resting infill, and line hysteresis");
