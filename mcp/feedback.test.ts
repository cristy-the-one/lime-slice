/** Regression cases from the flexi frog MCP workflow. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePaths } from "../src/preview-wire.ts";
import { engineCandidates, fakeEngine, loadNativeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { pathsPng } from "./layer-out.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-feedback-"));
const engine = fakeEngine();
const session = new Session(engine);
const call = async (tool: string, args: Record<string, unknown> = {}) => {
  const reply = await session.call(tool, args);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply;
};

// Before commit the solid is real but the plate mesh is still a placeholder.
const pending = await call("solid_new", { primitive: "box", dx: 8, dy: 12, dz: 6 });
const placed = await call("object_place", { object: pending.object, centreX: 42, centreY: 67 });
assert.deepEqual(placed.centreMm, [42, 67, 3]);
const neighbour = await call("solid_new", { primitive: "box", dx: 4, dy: 4, dz: 4 });
const aligned = await call("object_place", { object: neighbour.object, align: { to: pending.object, how: "on-top" } });
assert.equal((aligned.centreMm as number[])[2], 8);
await call("model_commit", { object: pending.object });
await call("model_commit", { object: neighbour.object });
const afterCommit = (await call("plate_list")).objects as { object: string; centreMm: number[] }[];
assert.deepEqual(afterCommit.find((row) => row.object === pending.object)?.centreMm, placed.centreMm);
assert.deepEqual(afterCommit.find((row) => row.object === neighbour.object)?.centreMm, aligned.centreMm);
await call("object_remove", { object: pending.object });
await call("object_remove", { object: neighbour.object });
console.log("pre-commit placement replies and alignment agree with the committed plate");

// The engine's plate wire carries part-local paths and a separate XY offset per object.
const poll = engine.slicePoll;
let replyFrame: "plate" | "object" | "legacy" = "plate";
engine.slicePoll = async (...args) => {
  const reply = JSON.parse(await poll(...args));
  if (reply.result) {
    const wire = JSON.parse(reply.result);
    wire.objects = [{ id: "obj_1", offset: [30, 40] }, { id: "obj_2", offset: [150, 160] }];
    wire.layers[0].paths = encodePaths([
      { kind: "outer", object: 0, pts: [[0, 0], [10, 0], [10, 10], [0, 0]] },
      { kind: "outer", object: 1, pts: [[0, 0], [10, 0], [10, 10], [0, 0]] },
    ]);
    if (replyFrame !== "plate") {
      delete wire.objects;
      wire.layers[0].paths = encodePaths([{ kind: "outer", pts: [[0, 0], [10, 0], [10, 10], [0, 0]] }]);
      if (replyFrame === "object") wire.offset = [30, 40];
    }
    reply.result = JSON.stringify(wire);
  }
  return JSON.stringify(reply);
};
await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
const second = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
await call("object_place", { object: second.object, centreX: 150, centreY: 160 });
const sliced = await call("slice_start", { scope: "plate" });
await call("slice_wait", { job: sliced.job });
const svg = readFileSync(String((await call("layer_paths", { layer: 0 })).path), "utf8");
assert.ok(svg.includes('viewBox="29 39 132 132"'), svg);
assert.ok(svg.includes('points="150,160 160,160 160,170 150,160"'), svg);
console.log("layer_paths places both objects in bed coordinates");
const png = readFileSync(String((await call("layer_image", { layer: 0 })).path));
const expectedPng = pathsPng([
  { kind: "outer", strategy: "", pts: [[30, 40], [40, 40], [40, 50], [30, 40]], width: 0.45, speed: 40, effectiveSpeed: 40, toughness: 0, beadHeight: 0.2 },
  { kind: "outer", strategy: "", pts: [[150, 160], [160, 160], [160, 170], [150, 160]], width: 0.45, speed: 40, effectiveSpeed: 40, toughness: 0, beadHeight: 0.2 },
], 256, "feature");
assert.deepEqual(png, Buffer.from(expectedPng));
assert.equal(readFileSync(String((await call("layer_paths", { layer: 0 })).path), "utf8"), svg, "drawing must not mutate the stored paths or apply offsets twice");
console.log("layer_image draws the same placed plate as layer_paths");

for (const frame of ["object", "legacy"] as const) {
  replyFrame = frame;
  const job = await call("slice_start", { scope: "object" });
  await call("slice_wait", { job: job.job });
  const text = readFileSync(String((await call("layer_paths", { layer: 0 })).path), "utf8");
  assert.ok(text.includes(frame === "object" ? 'viewBox="29 39 12 12"' : 'viewBox="-1 -1 12 12"'), text);
}
console.log("single-object offsets and legacy print-space replies both render correctly");

// Exercise a real plate slice when the native addon is built (as in the MCP CI job).
const root = fileURLToPath(new URL("..", import.meta.url));
if (engineCandidates(root).some((path) => existsSync(path))) {
  const real = new Session(loadNativeEngine(root));
  const run = async (tool: string, args: Record<string, unknown> = {}) => {
    const reply = await real.call(tool, args);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply;
  };
  for (const [x, y] of [[40, 50], [150, 160]]) {
    const imported = await run("mesh_import", { path: fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url)) });
    await run("object_place", { object: imported.object, centreX: x, centreY: y });
  }
  const job = await run("slice_start", { scope: "plate" });
  await run("slice_wait", { job: job.job });
  const file = await run("layer_paths", { layer: 0, simplifyMm: 0 });
  const text = readFileSync(String(file.path), "utf8");
  const points = [...text.matchAll(/points="([^"]+)"/g)].flatMap((match) => match[1]!.split(" ").map((point) => point.split(",").map(Number)));
  assert.ok(points.some(([x, y]) => x! < 50 && y! < 60), "the first object's paths are at its print position");
  assert.ok(points.some(([x, y]) => x! > 140 && y! > 150), "the second object's paths are at its print position");
  await run("layer_image", { layer: 0 });
  console.log("real native plate slice: both objects appear at their print positions");
} else {
  console.log("native plate preview: skipped (build lime-mcp-engine to run)");
}
