/**
 * A one-object slice is only the selected object, even when another object
 * overlaps it. The stand-in checks the request. The real engine, when this
 * checkout has built it, checks the G-code and the grams.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeStl } from "../src/mesh-place.ts";
import { engineCandidates, fakeEngine, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-slice-scope-"));
process.env.LIME_MCP_WORKSPACE = workspace;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type SliceBody = { objects?: { id?: string; settings?: { walls?: number } }[]; filename?: string };

function objectIds(body: SliceBody): string[] {
  return (body.objects ?? []).map((row) => row.id ?? "");
}

const cube = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));
const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);

const first = await call("mesh_import", { path: cube });
const second = await call("mesh_import", { path: cube });
const a = String(first.object);
const b = String(second.object);
const selected = await call("object_select", { object: b });
const started = await call("slice_start", {});
const body = JSON.parse(engine.lastSlice) as SliceBody;
const listed = objectIds(body);
check(
  "the default slice of an overlapping pair sends only the selected object",
  selected.ok === true && started.ok === true && started.object === b && started.scope === "object"
    && JSON.stringify(started.sliced) === JSON.stringify([b]) && !listed.includes(a)
    && (listed.length === 0 || (listed.length === 1 && listed[0] === b)),
  JSON.stringify({ started, listed, filename: body.filename }),
);
const hits = started.collisions as { a: string; b: string }[];
check("the overlap is still reported, and it is not what was sliced", hits.length === 1 && hits[0]?.a === a && hits[0]?.b === b, JSON.stringify(hits));

const walls = await call("settings_set", { object: a, values: { walls: 7 } });
await call("object_select", { object: b });
await call("slice_start", { cancelRunning: true });
const without = JSON.parse(engine.lastSlice) as SliceBody;
check(
  "the other object's walls stay out of the selected slice",
  walls.ok === true && !JSON.stringify(without).includes(a) && !objectIds(without).includes(a),
  JSON.stringify(without.objects),
);
await call("object_select", { object: a });
await call("slice_start", { cancelRunning: true });
const withWalls = JSON.parse(engine.lastSlice) as SliceBody;
check(
  "selecting the object that has its own walls slices that object alone",
  objectIds(withWalls).length === 1 && withWalls.objects?.[0]?.id === a && withWalls.objects?.[0]?.settings?.walls === 7,
  JSON.stringify(withWalls.objects),
);

const plate = await call("slice_start", { scope: "plate", cancelRunning: true });
const plateBody = JSON.parse(engine.lastSlice) as SliceBody;
const plateIds = objectIds(plateBody).slice().sort();
check(
  "scope plate still slices both and says so",
  plate.ok === true && plate.scope === "plate" && plate.object === undefined
    && String(plate.note).includes("whole plate")
    && JSON.stringify((plate.sliced as string[]).slice().sort()) === JSON.stringify([a, b].sort())
    && JSON.stringify(plateIds) === JSON.stringify([a, b].sort()),
  JSON.stringify({ plate, plateIds }),
);

/** A closed box sitting on Z = 0, short enough that a real slice stays small. */
function slabPositions(): Float32Array {
  const [x0, y0, x1, y1, z1] = [0, 0, 30, 30, 1];
  const c = [
    [x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [4, 5, 6, 7],
    [0, 3, 2, 1],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
    [3, 7, 6, 2],
    [0, 1, 5, 4],
  ];
  const positions = new Float32Array(quads.length * 18);
  quads.forEach((quad, face) => {
    const corner = (index: number) => c[quad[index]!]!;
    const write = (tri: number, p: number[], q: number[], r: number[]) => {
      positions.set([...p, ...q, ...r], (face * 2 + tri) * 9);
    };
    write(0, corner(0), corner(1), corner(2));
    write(1, corner(0), corner(2), corner(3));
  });
  return positions;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path));
if (!addon) {
  console.log("slice-scope: real slice skipped (lime-mcp-engine is not built)");
} else {
  const slab = join(workspace, "slab.stl");
  writeFileSync(slab, Buffer.from(encodeStl(slabPositions(), "slab")));
  const live = new Session(loadEngineWorker(root));
  const slice = (name: string, args: unknown = {}) => live.call(name, args);
  const left = await slice("mesh_import", { path: slab });
  const right = await slice("mesh_import", { path: slab });
  const one = String(left.object);
  const two = String(right.object);
  const box = right.bboxMm as { min: number[]; max: number[] };
  // Ten millimetres along X: the slabs still overlap, and each keeps a strip of its own.
  const shifted = await slice("object_place", {
    object: two,
    centreX: (box.min[0]! + box.max[0]!) / 2 + 10,
    centreY: (box.min[1]! + box.max[1]!) / 2,
  });
  check("the second slab stays overlapping the first", shifted.ok === true, JSON.stringify(shifted));
  await slice("object_select", { object: two });
  const both = await slice("slice_start", { scope: "plate" });
  const bothWait = await slice("slice_wait", { job: both.job, timeoutS: 120 });
  const bothFile = await slice("gcode_export", { job: both.job, name: "both.gcode", now: "2020-01-02T03:04:05.000Z" });
  const bothText = bothFile.ok === true ? readFileSync(String(bothFile.path), "utf8") : "";
  const alone = await slice("slice_start", { cancelRunning: true });
  const aloneWait = await slice("slice_wait", { job: alone.job, timeoutS: 120 });
  const aloneFile = await slice("gcode_export", { job: alone.job, name: "alone.gcode", now: "2020-01-02T03:04:05.000Z" });
  const aloneText = aloneFile.ok === true ? readFileSync(String(aloneFile.path), "utf8") : "";
  const labels = (text: string) => [...text.matchAll(/^;OBJECT:(.*)$/gm)].map((row) => row[1] ?? "");
  const aloneLabels = labels(aloneText);
  check(
    "the real one-object slice names only the selection",
    alone.ok === true && alone.object === two && alone.scope === "object" && JSON.stringify(alone.sliced) === JSON.stringify([two])
      && aloneWait.ok === true && aloneWait.object === two
      && !aloneText.includes(`;OBJECT:${one}`)
      && aloneLabels.every((label) => label === two),
    JSON.stringify({ alone, aloneWait, labels: aloneLabels.slice(0, 6), export: aloneFile }),
  );
  check(
    "the real plate slice of the same overlap contains both objects",
    both.ok === true && both.scope === "plate" && bothWait.ok === true
      && bothText.includes(`;OBJECT:${one}`) && bothText.includes(`;OBJECT:${two}`),
    JSON.stringify({ both, bothWait, labels: labels(bothText).slice(0, 6) }),
  );
  await slice("object_remove", { object: one });
  const solo = await slice("slice_start", { cancelRunning: true });
  const soloWait = await slice("slice_wait", { job: solo.job, timeoutS: 120 });
  console.log(`grams selected ${aloneWait.grams}, on its own ${soloWait.grams}, plate ${bothWait.grams}`);
  check(
    "the grams match the slice of that object on its own",
    solo.ok === true && soloWait.ok === true
      && typeof aloneWait.grams === "number" && aloneWait.grams === soloWait.grams
      && typeof bothWait.grams === "number" && bothWait.grams > aloneWait.grams,
    JSON.stringify({ alone: aloneWait.grams, solo: soloWait.grams, plate: bothWait.grams }),
  );
}

if (failed) console.error(`slice-scope: ${failed} failed`);
else console.log("slice-scope: ok");
// The engine worker stays up after the last call. Exit so the unit chain continues.
process.exit(failed ? 1 : 0);
