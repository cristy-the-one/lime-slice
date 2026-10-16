/**
 * The plate, the machine, and the solid tools that the app can do by hand.
 * A slice of two objects is the same body the app's builder writes, field by field.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eulerOrient } from "../src/mesh-place.ts";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-batch2-"));
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

const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);

const cube = new URL("../samples/calibration_cube_20mm.stl", import.meta.url);
const first = await call("mesh_import", { path: fileURLToPath(cube) });
const second = await call("mesh_import", { path: fileURLToPath(cube) });
const a = String(first.object);
const b = String(second.object);

const stacked = await call("slice_start", { scope: "plate" });
const stackedCollisions = stacked.collisions as { a: string; b: string }[];
check("two cubes on the same spot are named", stacked.ok === true && stackedCollisions.length === 1, JSON.stringify(stackedCollisions));
await call("object_place", { object: b, centreX: 160, centreY: 110 });
const apart = await call("slice_start", { scope: "plate", cancelRunning: true });
const apartCollisions = apart.collisions as unknown[];
const apartBody = JSON.parse(engine.lastSlice) as { objects?: { id: string }[]; filename?: string; printOrder?: string };
check("a 30 mm gap has no collisions", apart.ok === true && apartCollisions.length === 0, JSON.stringify(apart));
check("the plate slice names both objects and no lone file", apartBody.objects?.length === 2 && apartBody.filename === undefined, JSON.stringify(Object.keys(apartBody)));

await call("plate_print_order", { order: "sequential", clearanceMm: 4, gantryMm: 30 });
await call("slice_start", { scope: "plate", cancelRunning: true });
const ordered = JSON.parse(engine.lastSlice) as { printOrder?: string; sequentialClearanceMm?: number; sequentialGantryMm?: number };
check("sequential order matches the app fields", ordered.printOrder === "sequential" && ordered.sequentialClearanceMm === 4 && ordered.sequentialGantryMm === 30, JSON.stringify(ordered));

const copied = await call("object_duplicate", { object: a, count: 1 });
check("a duplicate is a new object", copied.ok === true && (copied.objects as string[]).length === 1, JSON.stringify(copied));
const before = await call("plate_list", {});
const dry = await call("plate_arrange", { gapMm: 2, dryRun: true });
const after = await call("plate_list", {});
check("arrange dry run moves nothing", dry.ok === true && dry.dryRun === true && JSON.stringify(before) === JSON.stringify(after), JSON.stringify(dry));

const shellsFile = join(workspace, "two-shells.stl");
writeFileSync(shellsFile, readFileSync(fileURLToPath(cube)));
const shells = new Session(fakeEngine());
const shellCall = (name: string, args: unknown = {}) => shells.call(name, args);
const imported = await shellCall("mesh_import", { path: shellsFile });
const split = await shellCall("object_split_shells", { object: imported.object });
check("two shells become two objects", split.ok === true && (split.objects as string[]).length === 2, JSON.stringify(split));

const range = await call("range_add", { zFromMm: 0, zToMm: 4, walls: 6 });
const outside = await call("range_add", { zFromMm: 30, zToMm: 40, walls: 3 });
check("a range on the part is kept", range.ok === true, JSON.stringify(range));
check("a range above the part is refused", outside.ok === false && String(outside.reason).includes("outside the part"), JSON.stringify(outside));
const missed = await call("modifier_add", { kind: "box", centre: [0, 0, 0], sizeMm: [4, 4, 4], infillPercent: 80 });
const touched = await call("modifier_add", { kind: "box", centre: [110, 110, 2], sizeMm: [10, 10, 4], infillPercent: 80 });
check("a modifier that misses is refused", missed.ok === false && missed.reason === "That volume does not touch the part.", JSON.stringify(missed));
check("a modifier on the part is kept", touched.ok === true, JSON.stringify(touched));
await call("slice_start", { scope: "object", cancelRunning: true });
const overrides = JSON.parse(engine.lastSlice) as { heightRanges?: { z: number[]; walls?: number }[]; modifierVolumes?: { center: number[] }[] };
check(
  "ranges and volumes are the app's fields",
  overrides.heightRanges?.[0]?.z[0] === 0 && overrides.heightRanges?.[0]?.walls === 6 && (overrides.modifierVolumes?.length ?? 0) === 1,
  JSON.stringify(overrides.heightRanges),
);

await call("slice_wait", { job: String((await call("slice_start", { cancelRunning: true })).job), timeoutS: 2 });
const action = await call("layer_action_set", { zMm: 0.15, kind: "customGcode", gcode: "M104 S200" });
const long = await call("layer_action_set", { zMm: 0.2, kind: "customGcode", gcode: "M104 S200 ; " + "x".repeat(400) });
check("a layer action snaps up to a layer top", action.ok === true && action.zMm === 0.2, JSON.stringify(action));
check("a long custom line is refused", long.ok === false && String(long.reason).includes("400"), JSON.stringify(long));

const machine = await call("machine_get", {});
check("a machine read has no host or key", machine.ok === true && !JSON.stringify(machine).includes("apiKey") && !JSON.stringify(machine).includes("\"host\""));
const set = await call("machine_set", { printer: { bedX: 200, startGcode: "M502" }, filament: { nozzleTemp: 205 } });
check("start G-code is reviewed", set.ok === true && JSON.stringify(set.review).includes("M502"), JSON.stringify(set.review));
const saved = await call("machine_save", { name: "bench" });
const machineText = readFileSync(String(saved.path), "utf8");
check("the machine file leaves out the host", saved.ok === true && !machineText.includes("apiKey") && !machineText.includes("\"host\"") && machineText.includes("205"), machineText.slice(0, 180));
const profile = await call("profile_save", { name: "Bench" });
const profileText = JSON.parse(readFileSync(String(profile.path), "utf8")) as { name?: string; settings?: { layerHeight?: number } };
check("a profile round-trips the settings", profile.ok === true && profileText.name === "Bench" && profileText.settings?.layerHeight === 0.2);

const solid = new Session(fakeEngine());
const model = (name: string, args: unknown = {}) => solid.call(name, args);
const made = await model("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
const object = String(made.object);
const bed = await model("workplane_set", { object, source: "bed" });
check("the bed frame sits under the part", bed.ok === true && bed.source === "bed" && (bed.origin as number[])[2] === 0, JSON.stringify(bed));
const screw = await model("model_probe", { object, op: { kind: "hole", screw: "M3", at: { u: 0, v: 0 } } });
const screwTyped = screw.typed as { diameterMm?: number; counterboreDiameterMm?: number; counterboreDepth?: number; through?: boolean };
check(
  "an M3 hole is the clearance and the counterbore",
  screw.ok === true && screwTyped.diameterMm === 3.4 && screwTyped.counterboreDiameterMm === 6.5 && screwTyped.counterboreDepth === 3.4 && screwTyped.through === true,
  JSON.stringify(screw.typed),
);
const cone = await model("model_probe", { object, op: { kind: "boolean", op: "cut", primitive: "cone", dx: 4, dz: 6, topRadius: 1, origin: [0, 0, 0] } });
check("a cone keeps its top radius", cone.ok === true && (cone.stored as { topRadius?: number }).topRadius === 1, JSON.stringify(cone.stored));
const root = await model("model_probe", { object, op: { kind: "root", primitive: "box", dx: 30, dy: 30, dz: 10 } });
const edited = await model("model_edit", { object, node: "node_0", op: { kind: "root", primitive: "box", dx: 30, dy: 30, dz: 10 } });
const described = await model("model_describe", { object, limit: 1 });
check("a root edit rebuilds the solid", root.ok === true && edited.ok === true && described.volumeMm3 === 9000, JSON.stringify(described));
const renamed = await model("model_rename", { object, node: "node_0", label: "Wider box" });
const history = await model("model_history", { object });
check("a step can be renamed", renamed.ok === true && JSON.stringify(history).includes("Wider box"));
const turned = await model("object_place", { object, rotZ: 90 });
check("an absolute turn matches the app's rings", turned.ok === true && JSON.stringify(turned.orient) === JSON.stringify(eulerOrient(0, 0, 90)), JSON.stringify(turned.orient));

if (failed) {
  console.error(`batch2: ${failed} failed`);
  process.exit(1);
}
console.log("batch2: ok");
