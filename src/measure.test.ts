import {
  chooseEdges, cullByDistance, cullLabels, flatEdges, formatMm, labelBeside, majorTicks, nearBedEdges, niceLengthMm, overlaps, sameBox, scaleBar, tickPriority, unionBox,
  type Box, type Rect,
} from "./measure.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}`);
}

// Labels -------------------------------------------------------------------------------------------------------

eq("one decimal", formatMm(20), "20.0 mm");
eq("rounds to the tenth", formatMm(151.04), "151.0 mm");
eq("rounds up", formatMm(39.96), "40.0 mm");
eq("a negative extent reads as a length", formatMm(-3.25), "3.3 mm");

// Scale bar -----------------------------------------------------------------------------------------------------

eq("1, 2, 5 steps", [0.7, 1, 1.9, 2, 4.99, 5, 9.99, 10, 99, 100, 123456].map(niceLengthMm), [0.5, 1, 1, 2, 2, 5, 5, 10, 50, 100, 100000]);
eq("below one", [0.03, 0.2, 0.99].map(niceLengthMm), [0.02, 0.2, 0.5]);
eq("a bad length falls back to 1", [0, -4, NaN, Infinity].map(niceLengthMm), [1, 1, 1, 1]);

const bar = scaleBar(0.5)!;
eq("0.5 mm per pixel picks 50 mm", [bar.mm, bar.px, bar.label], [50, 100, "50 mm"]);
eq("a metre reads as 1 m", scaleBar(10)!.label, "1 m");
eq("no bar without a scale", [scaleBar(0), scaleBar(NaN), scaleBar(-1)], [null, null, null]);
let worst: [number, number] = [Infinity, 0];
for (let mmPerPx = 0.005; mmPerPx < 400; mmPerPx *= 1.013) {
  const got = scaleBar(mmPerPx)!;
  worst = [Math.min(worst[0], got.px), Math.max(worst[1], got.px)];
  if (got.px > 140.0001 || got.px < 55.99) check(`bar length at ${mmPerPx}`, false, String(got.px));
  if (![1, 2, 5].includes(Number((got.mm / 10 ** Math.floor(Math.log10(got.mm))).toFixed(6)))) check(`bar is nice at ${mmPerPx}`, false, String(got.mm));
}
check("the bar spans about 56 to 140 px over a sweep of zoom", worst[0] >= 55.99 && worst[1] <= 140.0001, String(worst));

// Callout edges ---------------------------------------------------------------------------------------------------

const box: Box = { min: [0, 0, 0], max: [20, 10, 30] };
const corners = (axis: 0 | 1 | 2) => [box.min[axis], box.max[axis]];

const iso = chooseEdges([100, -100, 100], box);
eq("one edge per axis", iso.map((e) => e.axis), ["x", "y", "z"]);
eq("camera over +X and -Y: X runs along the front, at the floor", [iso[0]!.from, iso[0]!.to], [[0, 0, 0], [20, 0, 0]]);
eq("Y runs along the +X side, at the floor", [iso[1]!.from, iso[1]!.to], [[20, 0, 0], [20, 10, 0]]);
eq("Z stands at the right-hand end", [iso[2]!.from, iso[2]!.to], [[20, 10, 0], [20, 10, 30]]);
check("the two floor edges meet at the corner nearest the camera", iso[0]!.to.join() === iso[1]!.from.join());
check("every end is a box corner", iso.every((e) => [e.from, e.to].every((p) => p.every((v, i) => corners(i as 0 | 1 | 2).includes(v)))));
eq("each edge is as long as the box", iso.map((e) => e.to.map((v, i) => v - e.from[i]!).reduce((a, b) => a + b)), [20, 10, 30]);

const behind = chooseEdges([-100, 100, 100], box);
eq("camera over -X and +Y: the front is the far-Y wall, the side is -X", [behind[0]!.from, behind[1]!.from], [[0, 10, 0], [0, 0, 0]]);
eq("Z moves to the end on the camera's right", [behind[2]!.from], [[0, 0, 0]]);

const below = chooseEdges([100, -100, -50], box);
eq("a camera under the middle puts the floor edges on the ceiling", [below[0]!.from[2], below[1]!.from[2]], [30, 30]);
eq("Z still spans the box", [below[2]!.from[2], below[2]!.to[2]], [0, 30]);
const level = chooseEdges([100, -100, 15], box);
eq("a camera at mid height counts as above", level[0]!.from[2], 0);

const down = chooseEdges([10, 5, 400], box);
eq("straight above, still three edges and a floor", [down.length, down[0]!.from[2]], [3, 0]);

// Straight-down layer view
eq("the layer view: X under the box, Y along its left", flatEdges({ min: [2, 3, 0], max: [22, 13, 5] }).map((e) => [e.axis, e.from, e.to]), [["x", [2, 3, 0], [22, 3, 0]], ["y", [2, 3, 0], [2, 13, 0]]]);

// Culling -------------------------------------------------------------------------------------------------------

const rect = (x: number, y: number, w = 40, h = 14): Rect => ({ x, y, w, h });
check("rects overlap", overlaps(rect(0, 0), rect(30, 5)));
check("rects apart", !overlaps(rect(0, 0), rect(50, 0)));
check("padding counts as overlap", overlaps(rect(0, 0), rect(42, 0), 4) && !overlaps(rect(0, 0), rect(42, 0)));

const crowd = [{ id: "a", ...rect(10, 10) }, { id: "b", ...rect(30, 12) }, { id: "c", ...rect(100, 10) }, { id: "d", ...rect(90, 50) }];
eq("the first label wins an overlap, the rest stay", cullLabels(crowd, 300, 200).map((l) => l.id), ["a", "c", "d"]);
eq("order is the priority", cullLabels([crowd[1]!, crowd[0]!, crowd[2]!], 300, 200).map((l) => l.id), ["b", "c"]);
eq("a label leaving the viewport goes", cullLabels(crowd, 120, 200).map((l) => l.id), ["a"]);
eq("a label over a taken rect goes", cullLabels(crowd, 300, 200, [rect(95, 8)]).map((l) => l.id), ["a", "d"]);
eq("nothing is kept in an empty viewport", cullLabels(crowd, 0, 0).length, 0);

const ticks = [0, 20, 30, 70, 85, 160].map((x) => ({ x, y: 0 }));
eq("points nearer than the gap thin out", cullByDistance(ticks, 40).map((p) => p.x), [0, 70, 160]);
eq("a gap of zero keeps all", cullByDistance(ticks, 0).length, ticks.length);

// Bed numbers ---------------------------------------------------------------------------------------------------

eq("every 50 mm, the corner left out", majorTicks(220), [50, 100, 150, 200]);
eq("an end on a multiple is kept", majorTicks(250), [50, 100, 150, 200, 250]);
eq("a short bed has none", majorTicks(40), []);
eq("round numbers first", [200, 100, 150, 50, 400].map(tickPriority), [0, 1, 2, 2, 0]);
eq("camera over +X and -Y: numbers on the y=0 front and the x=max side", nearBedEdges([300, -80, 200], { x0: 0, y0: 0, x1: 220, y1: 220 }), { frontY: 0, sideX: 220, outY: -1, outX: 1 });
eq("camera over -X and +Y", nearBedEdges([-50, 400, 100], { x0: 0, y0: 0, x1: 250, y1: 800 }), { frontY: 800, sideX: 0, outY: 1, outX: -1 });

// Boxes ---------------------------------------------------------------------------------------------------------

eq("no boxes, no union", unionBox([]), null);
eq("union spans both", unionBox([{ min: [0, 5, 0], max: [10, 9, 4] }, { min: [-2, 6, 1], max: [8, 20, 3] }]), { min: [-2, 5, 0], max: [10, 20, 4] });
check("same box", sameBox(box, { min: [0, 0, 0], max: [20, 10, 30] }) && !sameBox(box, { min: [0, 0, 0], max: [20, 10, 31] }) && sameBox(null, null) && !sameBox(box, null));

const beside = labelBeside([100, 100], [0, 1], 40, 14, 6);
eq("a label below a point has its top edge the gap below it", [beside.x, beside.y], [80, 106]);
const right = labelBeside([100, 100], [1, 0], 40, 14, 6);
eq("a label right of a point has its left edge the gap away", [right.x, right.y], [106, 93]);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("measure: scale bar, callout edges, culling and bed numbers ok");
