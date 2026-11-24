/**
 * Organic fix round, item 1, against Open CASCADE: a closed control-point spline drawn in a sketch (the Spline tool's
 * default) builds the solid the sketch shows. Four poles on a 20 mm square close into a periodic cubic whose widest
 * point is 115/6 = 19.17 mm from the first pole; the old loop sent an interpolating spline THROUGH the poles, which
 * reaches 20 mm. The loop here comes from the app's own sketch code (sketchRegions -> toLoops), and the solid's mesh
 * is read back: its extent and its volume must be the preview's.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { curveOf } from "../src/sketch/geom.ts";
import { addNurbs, emptySketch } from "../src/sketch/model.ts";
import { sketchRegions, toLoops } from "../src/sketch/regions.ts";
import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("sketch-nurbs-closed-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("sketch-nurbs-closed-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-sketch-nurbs-closed-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail.slice(0, 1500)}` : ""}`);
}
type Reply = Record<string, unknown>;
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;
await call("project_create", {});

// The sketch: a closed CV spline over the corners of a 20 mm square, as the Spline tool draws it.
const sketch = addNurbs(emptySketch(), [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]).sketch;
const shown = curveOf(sketch, sketch.entities[0]!);
const samples = shown && shown.kind === "spline" ? shown.samples : [];
const previewMaxX = Math.max(...samples.map((p) => p[0]));
let previewArea = 0;
for (let i = 0; i + 1 < samples.length; i += 1) previewArea += (samples[i]![0] * samples[i + 1]![1] - samples[i + 1]![0] * samples[i]![1]) / 2;
const regions = sketchRegions(sketch);
const loop = regions.length === 1 ? toLoops(regions[0]!)[0]! : null;
check("the sketch gives one loop of one nurbs segment", loop?.segments.length === 1 && loop.segments[0]!.kind === "nurbs", JSON.stringify(loop));

/** Mesh volume from triangle positions (signed tetrahedra about the origin). */
function meshVolume(positions: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i]!, ay = positions[i + 1]!, az = positions[i + 2]!;
    const bx = positions[i + 3]!, by = positions[i + 4]!, bz = positions[i + 5]!;
    const cx = positions[i + 6]!, cy = positions[i + 7]!, cz = positions[i + 8]!;
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(v);
}

if (loop) {
  // A 10 x 40 x 4 block; the curve's region is fused on at the block's -x edge, so the solid's +x extent is the curve's.
  const made = await call("solid_new", { primitive: "box", dx: 10, dy: 40, dz: 4, name: "block" });
  if (made.ok !== true) throw new Error(JSON.stringify(made));
  const object = String(made.object);
  const box = session.find(object)!.solid!.bounds;
  const blockVolume = meshVolume(session.find(object)!.solid!.positions);
  const dx = box.min[0];
  const dy = box.min[1] + 10;
  const shifted = JSON.parse(JSON.stringify(loop, (_key, value) => (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number") ? [value[0] + dx, value[1] + dy] : value)));
  const fused = await call("model_apply", { object, op: { kind: "extrude", op: "fuse", origin: [0, 0, box.min[2]], depth: box.max[2] - box.min[2], loops: [shifted], label: "cv window" }, probe: true });
  check("the extrude of the closed CV loop builds", fused.ok === true, JSON.stringify(fused));
  const solid = session.find(object)!.solid!;
  const maxX = solid.bounds.max[0] - dx;
  console.log(`SKETCH_NURBS_CLOSED previewMaxX=${previewMaxX.toFixed(4)} solidMaxX=${maxX.toFixed(4)} (an interpolating spline reaches 20)`);
  check("the solid's extent is the preview's (19.17 mm, not 20)", Math.abs(maxX - previewMaxX) < 0.05 && maxX < 19.5, `solid=${maxX} preview=${previewMaxX}`);
  // The fused volume is the block plus the curve's region outside the block (x > 10).
  let outside = 0;
  const clipped = samples.map((p) => [Math.max(10, p[0]), p[1]] as [number, number]);
  for (let i = 0; i + 1 < clipped.length; i += 1) outside += (clipped[i]![0] * clipped[i + 1]![1] - clipped[i + 1]![0] * clipped[i]![1]) / 2;
  const expected = blockVolume + Math.abs(outside) * (box.max[2] - box.min[2]);
  const volume = meshVolume(solid.positions);
  console.log(`SKETCH_NURBS_CLOSED volume=${volume.toFixed(2)} expected=${expected.toFixed(2)} previewArea=${Math.abs(previewArea).toFixed(2)}`);
  check("the solid's volume is the preview region's (within 1 %)", Math.abs(volume - expected) < 0.01 * expected, `volume=${volume} expected=${expected}`);
}

if (failed) {
  console.error(`sketch-nurbs-closed-occt: ${failed} failed`);
  process.exit(1);
}
console.log("sketch-nurbs-closed-occt: ok");
// The engine workers are child processes. Without this the test stays up and the OCCT job hits its time limit.
process.exit(0);
