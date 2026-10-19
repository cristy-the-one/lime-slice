/**
 * A parameter change rebuilds a sketch feature from its drawing: a group of several regions keeps every region.
 */
import { refreshOp } from "./param-rebuild.ts";
import { withRectangleConstraints } from "./sketch/constrain.ts";
import { buildSketchExtrude } from "./sketch/extrude.ts";
import { addLine, addPoint, emptySketch, type SketchData } from "./sketch/model.ts";
import { sketchRegions } from "./sketch/regions.ts";
import type { ExtrudeOp } from "./model-tree.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}

function rectangle(sketch: SketchData, x: number, w: number, h: number): { sketch: SketchData; bottom: number } {
  let next = sketch;
  const ids: number[] = [];
  for (const corner of [[x, 0], [x + w, 0], [x + w, h], [x, h]] as [number, number][]) {
    const added = addPoint(next, corner);
    next = added.sketch;
    ids.push(added.id);
  }
  const sides: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const added = addLine(next, ids[i]!, ids[(i + 1) % 4]!);
    next = added.sketch;
    sides.push(added.id);
  }
  return { sketch: withRectangleConstraints(next, sides as [number, number, number, number]), bottom: sides[0]! };
}

const first = rectangle(emptySketch(), 0, 10, 5);
const second = rectangle(first.sketch, 20, 10, 5);
let drawn = second.sketch;
const id = Math.max(0, ...(drawn.dims ?? []).map((dim) => dim.id)) + 1;
drawn = { ...drawn, dims: [...(drawn.dims ?? []), { id, kind: "length", line: first.bottom, value: 10, expr: "w" }] };
const built = buildSketchExtrude({ sketch: drawn, regions: [...sketchRegions(drawn)], distance: 4, depth2: null, draftDeg: null, upTo: null, mode: "fuse" });
if (!("op" in built) || built.op.kind !== "group") throw new Error("two regions build a group");

const after = refreshOp(built.op, { w: 14 });
eq("a two-region group rebuilds with no error", after.error, undefined);
const steps = after.op.kind === "group" ? after.op.steps.filter((step): step is ExtrudeOp => step.kind === "extrude") : [];
eq("and keeps both regions", steps.length, 2);
const widths = steps.map((step) => {
  const xs = [step.loops![0]!.start[0], ...step.loops![0]!.segments.map((segment) => segment.to[0])];
  return Math.round((Math.max(...xs) - Math.min(...xs)) * 1e4) / 1e4;
}).sort((a, b) => a - b);
eq("the driven rectangle is 14 wide and the other is still 10", widths, [10, 14]);

if (failed) {
  console.error(`param-rebuild: ${failed} failed`);
  process.exit(1);
}
console.log("param-rebuild: ok");
