/**
 * The six golden configs, through the same in-process slice the tools call,
 * against `lime-slice slice` on one cube. This is the CLI request, not a
 * centred Lime 220 slice: the app's library printer changes the file.
 * Set LIME_MCP_GOLDEN=1. Without it, this file prints golden: SKIPPED and
 * exits 0, unless CI is set, in which case a skip fails the job.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { bytesToBase64 } from "../src/base64.ts";

import { loadNativeEngine } from "./engine.ts";
import { cliSliceRequest, type GoldenConfig } from "./request.ts";

function syncText(value: string | Promise<string>): string {
  if (typeof value !== "string") {
    console.error("golden: the engine answered asynchronously");
    process.exit(1);
  }
  return value;
}

if (process.env.LIME_MCP_GOLDEN !== "1") {
  console.error("golden: SKIPPED");
  process.exit(process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 1 : 0);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = process.env.LIME_SLICE_BIN ?? join(root, "target", "release", "lime-slice");
const mesh = join(root, "samples", "calibration_cube_20mm.stl");
const engine = loadNativeEngine(root);
const bytes = readFileSync(mesh);
const preview = JSON.parse(syncText(engine.meshPreview(JSON.stringify({ filename: "calibration_cube_20mm.stl", dataB64: bytesToBase64(new Uint8Array(bytes)), stepToleranceMm: 0.05 })))) as { min?: number[]; max?: number[]; error?: string };
if (!preview.min || !preview.max) {
  console.error(preview.error ?? "no preview");
  process.exit(1);
}
const atMm = (preview.min[0]! + preview.max[0]!) / 2;
const configs: { name: GoldenConfig; flags: string[] }[] = [
  { name: "speed", flags: ["--blend", "speed"] },
  { name: "tough", flags: ["--blend", "toughness"] },
  { name: "region", flags: ["--blend", "region"] },
  { name: "grid", flags: ["--blend", "speed", "--supports"] },
  { name: "tree", flags: ["--blend", "toughness", "--supports", "--support-style", "tree"] },
  { name: "adaptive", flags: ["--blend", "layer", "--adaptive"] },
];

const dir = mkdtempSync(join(tmpdir(), "lime-golden-"));
let failed = 0;
for (const config of configs) {
  const body = cliSliceRequest("calibration_cube_20mm.stl", bytesToBase64(new Uint8Array(bytes)), config.name, atMm);
  const started = JSON.parse(syncText(engine.sliceStart(JSON.stringify(body)))) as { id?: number; error?: string };
  if (typeof started.id !== "number") {
    failed += 1;
    console.error(`FAIL ${config.name} start ${started.error}`);
    continue;
  }
  let gcode = "";
  for (let i = 0; i < 200 && !gcode; i += 1) {
    const poll = JSON.parse(syncText(engine.slicePoll(String(started.id)))) as { status?: string; result?: string; error?: string };
    if (poll.status === "done" && poll.result) {
      const wire = JSON.parse(poll.result) as { gcode?: string };
      gcode = wire.gcode ?? "";
    } else if (poll.status === "error" || poll.error) {
      failed += 1;
      console.error(`FAIL ${config.name} ${poll.error ?? poll.status}`);
      break;
    } else {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  const out = join(dir, `${config.name}.gcode`);
  const cli = spawnSync(bin, ["slice", mesh, ...config.flags, "-o", out], { encoding: "utf8" });
  if (cli.status !== 0) {
    failed += 1;
    console.error(`FAIL ${config.name} cli ${cli.stderr || cli.stdout}`);
    continue;
  }
  const expected = readFileSync(out, "utf8");
  if (gcode === expected) console.log(`${config.name}: byte-identical`);
  else {
    failed += 1;
    console.error(`FAIL ${config.name}: ${gcode.length} bytes vs cli ${expected.length}`);
  }
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("golden: the MCP slice matches lime-slice");
