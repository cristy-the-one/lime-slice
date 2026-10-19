/**
 * --- B29. The loop helpers extrude, revolve, loft and sweep share.
 */
import { copyLoop, drawLoop, lineLoop, sampleLoopPoints, sentence } from "./loops.ts";
import { emptySketch } from "./model.ts";
import { sampleSpline } from "./geom.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}

const square = lineLoop([[0, 0], [4, 0], [4, 4], [0, 4]]);
eq("a point profile closes back to its start", square.segments.map((segment) => segment.to), [[4, 0], [4, 4], [0, 4], [0, 0]]);
const copy = copyLoop(square);
copy.segments[0]!.to[0] = 99;
eq("a copy does not share points", square.segments[0]!.to, [4, 0]);
eq("a drawn loop is one line a side", drawLoop(emptySketch(), square).entities.map((entity) => entity.kind), ["line", "line", "line", "line"]);

// A ghost follows a spline along its curve, the same curve the sketch draws, not the chords between its points.
const wave = { start: [0, 0] as [number, number], segments: [{ kind: "spline" as const, through: [[5, 3]] as [number, number][], to: [10, 0] as [number, number] }, { kind: "line" as const, to: [0, 0] as [number, number] }] };
const ghost = sampleLoopPoints(wave);
const drawn = sampleSpline([[0, 0], [5, 3], [10, 0]], false, 1);
eq("the spline's ghost is the sketch's curve", ghost.slice(0, drawn.length), drawn);
eq("an engine reason ends with a full stop", [sentence(" no solid "), sentence("Done.")], ["no solid.", "Done."]);

if (failed) {
  console.error(`loops: ${failed} failed`);
  process.exit(1);
}
console.log("loops: ok");
