/**
 * --- F3. A sweep along a smooth arc, and a sharp corner that is refused. ---
 */
import { keepSketch, withoutSketch } from "../model-request.ts";
import { opLabel } from "../model-tree.ts";
import { addArc, addLine, emptySketch, type SketchData } from "./model.ts";
import { sketchRegions } from "./regions.ts";
import { SHARP_CORNER, buildSketchSweep, extendPath, openChain, sharpCorner, sweepEditOf, turningDeg } from "./sweep.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}
function near(a: number, b: number, tol = 1e-3) {
  return Math.abs(a - b) < tol;
}

function squareSketch(): SketchData {
  let sketch = emptySketch();
  sketch = addLine(sketch, [0, 0], [4, 0]).sketch;
  sketch = addLine(sketch, [4, 0], [4, 4]).sketch;
  sketch = addLine(sketch, [4, 4], [0, 4]).sketch;
  sketch = addLine(sketch, [0, 4], [0, 0]).sketch;
  return sketch;
}

const profileSketch = squareSketch();
const profile = sketchRegions(profileSketch)[0];
check("the square is a region", !!profile);

const elbow = sharpCorner([[0, 0, 0], [10, 0, 0], [10, 10, 0]]);
eq("an L is a sharp corner", elbow, SHARP_CORNER);
check("a right angle is 90°", near(turningDeg([1, 0, 0], [0, 1, 0]), 90, 1e-6));
eq("a straight run is not sharp", sharpCorner([[0, 0, 0], [5, 0, 0], [10, 0, 0]]), null);

if (profile) {
  const refused = buildSketchSweep({ profileSketch, profile, path: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], scale: 1, mode: "new" });
  eq("a sharp path is refused and not lofted", "error" in refused ? refused.error : "", SHARP_CORNER);

  const radius = 20;
  const mid = radius / Math.SQRT2;
  let arc = emptySketch();
  arc = addArc(arc, [radius, 0], [0, radius], [mid, mid]).sketch;
  const chain = openChain(arc);
  check("a quarter-circle arc is an open path", !!chain && chain.path.length >= 4);
  if (chain) {
    eq("samples inside the arc are not corners", sharpCorner(chain.path, chain.check), null);
    const swept = buildSketchSweep({
      profileSketch,
      profile,
      path: chain.path,
      check: chain.check,
      pathSketch: arc,
      scale: 1,
      mode: "new",
    });
    check("the arc sweeps", "op" in swept);
    if ("op" in swept) {
      check("the sweep is a loft of at least two sections", swept.op.kind === "loft" && swept.op.sections.length >= 2);
      check("each section is a point profile", swept.op.sections.every((section) => (section.profile?.length ?? 0) >= 3));
      const sent = withoutSketch(swept.op);
      check("the engine op has no drawing", !("drawing" in sent));
      eq("the drawing comes back on the echo", keepSketch(sent, swept.op), swept.op);
      check("the row says sweep", opLabel(swept.op).startsWith("Sweep along "));
      const again = sweepEditOf(swept.op, true);
      check("History Edit reopens the profile and the path", !!again && again.kind === "sweep" && again.choice === "new" && again.path.length === chain.path.length && again.profile.entities.length === profileSketch.entities.length);
    }
  }

  const scaled = buildSketchSweep({
    profileSketch,
    profile,
    path: [[0, 0, 0], [0, 0, 10], [0, 0, 20]],
    scale: [1, 2, 1],
    mode: "fuse",
  });
  check("a scale per point is accepted", "op" in scaled);
  if ("op" in scaled && scaled.op.kind === "loft") {
    const middle = scaled.op.sections[1]?.profile ?? [];
    const reach = Math.max(...middle.map(([u, v]) => Math.hypot(u, v)));
    const end = scaled.op.sections[0]?.profile ?? [];
    const endReach = Math.max(...end.map(([u, v]) => Math.hypot(u, v)));
    check("the middle section is twice the end", near(reach, endReach * 2, 0.05));
    eq("the stored scale is the list", scaled.op.drawing?.sweep?.scale, [1, 2, 1]);
  }
}

const closed = openChain(profileSketch);
eq("a closed rectangle is not a sweep path", closed, null);

const met = extendPath([[0, 0, 0], [10, 0, 0]], [true, true], [[10, 0, 0], [10, 8, 0]]);
check("an edge that meets is appended", "path" in met && met.path.length === 3 && met.path[2]![1] === 8);
const missed = extendPath([[0, 0, 0], [10, 0, 0]], [true, true], [[0, 5, 0], [0, 9, 0]]);
eq("an edge that misses says so", "error" in missed ? missed.error : "", "Pick an edge that meets the path.");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sweep tests passed");
