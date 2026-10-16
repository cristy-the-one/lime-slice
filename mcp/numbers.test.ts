/**
 * Placement, layer lines, slice scope, export review, and measure.
 * These are the checks the review named for F-12, F-14, F-16, F-17, F-22, and F-26.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyBridge, emptyBridgeView, type BridgePlacement } from "../src/bridge.ts";
import { placeMesh } from "../src/mesh-place.ts";
import { builtinLibrary, fileFromSelection, heatFor, serializeMachineFile } from "../src/ui/machine-library.ts";

import { FAKE_LAYER_SECONDS, fakeEngine, fakeSliceGcode } from "./engine.ts";
import { exportGcode } from "./export-gcode.ts";
import { TOOLS } from "./schema.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-numbers-"));
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
const ledgePath = new URL("../samples/overhang_ledge.stl", import.meta.url);

const first = await call("mesh_import", { path: cube.pathname });
const second = await call("mesh_import", { path: cube.pathname });
check("a second import notes the overlap", String(second.note).includes("These parts overlap"));
const crowded = await call("plate_list", {});
const crowdedRows = Array.isArray(crowded.objects) ? crowded.objects as { notes?: string[] }[] : [];
check("plate_list notes the overlap", crowdedRows.length === 2 && crowdedRows.every((row) => (row.notes ?? []).some((note) => note.includes("These parts overlap"))));

const cubePlace = await call("object_place", { object: first.object, centreX: 50, centreY: 60 });
const cubeCentre = cubePlace.centreMm as number[];
check("the cube centre is 50, 60", Math.abs(cubeCentre[0]! - 50) < 0.01 && Math.abs(cubeCentre[1]! - 60) < 0.01, JSON.stringify(cubeCentre));
const mirror = session.bridgeSnapshot();
const mirrored = mirror?.placement as BridgePlacement | undefined;
const preview = JSON.parse(String(await engine.meshPreview(JSON.stringify({ filename: "cube.stl", dataB64: "" })))) as { positionsB64?: string };
const raw = Buffer.from(preview.positionsB64 ?? "", "base64");
const positions = new Float32Array(Uint8Array.from(raw).buffer);
const patch = mirrored
  ? applyBridge(emptyBridgeView(String(mirror?.objectName ?? "")), {
      tool: "object_place",
      objectId: String(mirror?.objectId ?? ""),
      objectName: String(mirror?.objectName ?? ""),
      ok: true,
      placement: mirrored,
    })
  : null;
const desktop = patch?.offset && patch.orient
  ? placeMesh(positions, patch.orient, patch.partScale ?? 1, 220, 220, patch.centered === true, patch.offset)
  : null;
const desktopX = desktop ? (desktop.bounds.min[0] + desktop.bounds.max[0]) / 2 : 0;
const desktopY = desktop ? (desktop.bounds.min[1] + desktop.bounds.max[1]) / 2 : 0;
check("the desktop mirror matches the placed centre within 0.01 mm", Math.abs(desktopX - 50) < 0.01 && Math.abs(desktopY - 60) < 0.01 && patch?.offset?.x !== 50, JSON.stringify(patch?.offset));

const ledge = await call("mesh_import", { path: ledgePath.pathname });
const ledgePlace = await call("object_place", { object: ledge.object, centreX: 50, centreY: 60 });
const ledgeCentre = ledgePlace.centreMm as number[];
check("an off-origin mesh centres on 50, 60", Math.abs(ledgeCentre[0]! - 50) < 0.01 && Math.abs(ledgeCentre[1]! - 60) < 0.01, JSON.stringify(ledgeCentre));
const listed = await call("plate_list", {});
const rows = Array.isArray(listed.objects) ? listed.objects as { object?: string; notes?: string[] }[] : [];
const placedRows = rows.filter((row) => row.object === first.object || row.object === ledge.object);
check("placed parts are not off the bed", placedRows.length === 2 && placedRows.every((row) => !(row.notes ?? []).some((note) => note.includes("outside the bed"))), JSON.stringify(placedRows));

const tall = await call("settings_apply", { layerHeight: 0.9 });
check("layer height 0.9 is refused with the range", tall.ok === false && String(tall.reason).includes("0.08") && String(tall.reason).includes("0.4"), JSON.stringify(tall));

await call("object_select", { object: first.object });
await call("settings_apply", { preset: "region" });
const regionStart = await call("slice_start", {});
await call("slice_wait", { job: regionStart.job });
const regionBody = JSON.parse(engine.lastSlice) as { blend?: { mode?: string; atMm?: number } };
await call("settings_apply", { preset: "speed" });
const speedStart = await call("slice_start", {});
check("the slice result names the object", speedStart.ok === true && speedStart.object === first.object && typeof speedStart.name === "string", JSON.stringify(speedStart));
await call("slice_wait", { job: speedStart.job });
const speedBody = JSON.parse(engine.lastSlice) as { blend?: { mode?: string } };
check("a region slice of the cube differs from speed", regionBody.blend?.mode === "byRegion" && regionBody.blend.atMm !== 10 && JSON.stringify(regionBody) !== JSON.stringify(speedBody), JSON.stringify(regionBody.blend));

const sliceTool = TOOLS.find((tool) => tool.name === "slice_start");
check("slice_start says it slices the selected object", !!sliceTool && sliceTool.description.includes("selected object") && !sliceTool.description.includes("Slice the plate"));

const library = builtinLibrary();
const file = fileFromSelection(library);
const machine = file
  ? { ...file, printer: { ...file.printer, startGcode: "M502\nM500", endGcode: file.printer.endGcode } }
  : null;
check("a machine file can be built", machine !== null);
const machinePath = join(workspace, "custom.limemachine.json");
if (machine) writeFileSync(machinePath, serializeMachineFile(machine));
const loaded = await call("machine_load", { path: machinePath });
check("the custom machine loads", loaded.ok === true, JSON.stringify(loaded));
const reviewedStart = await call("slice_start", {});
await call("slice_wait", { job: reviewedStart.job });
const summary = await call("gcode_summary", { job: reviewedStart.job });
const review = Array.isArray(summary.review) ? summary.review as { text: string }[] : [];
const reviewText = review.map((line) => line.text).join("\n");
check("the review lists M502 and M500", reviewText.includes("M502") && reviewText.includes("M500"), JSON.stringify(review));

const layers = await call("layer_summary", { job: reviewedStart.job });
const exported = await call("gcode_export", { job: reviewedStart.job, name: "layers.gcode", now: "2020-01-02T03:04:05.000Z" });
const text = exported.ok === true ? readFileSync(String(exported.path), "utf8") : "";
const markers = text.split("\n").filter((line) => line.startsWith(";LAYER:")).length;
check("layer_summary counts the layer markers", layers.layers === markers && markers === FAKE_LAYER_SECONDS.length, JSON.stringify(layers));
const printer = library.printers[0]!;
const filament = library.filaments[0]!;
const expected = machine
  ? exportGcode({
      gcode: fakeSliceGcode(""),
      grams: 1,
      now: new Date("2020-01-02T03:04:05.000Z"),
      layerSeconds: FAKE_LAYER_SECONDS,
      layerHeight: 0.2,
      nozzleDiameter: 0.4,
      filamentType: filament.material,
      printerName: machine.printer.name,
      startGcode: machine.printer.startGcode,
      endGcode: machine.printer.endGcode,
      startOwnsHoming: machine.printer.startOwnsHoming,
      heat: heatFor(printer, filament.nozzleTemp, filament.bedTemp),
    })
  : "";
const m73 = (value: string) => value.split("\n").filter((line) => line.startsWith("M73 ")).join("\n");
check("exported M73 lines match the app file", m73(text) !== "" && m73(text) === m73(expected), m73(text));

const solid = await call("solid_new", { dx: 20, dy: 20, dz: 20 });
const turned = await call("model_place", { object: solid.object, turnZ: 30 });
const shifted = await call("model_place", { object: solid.object, x: 5 });
check("an omitted turn stays", turned.ok === true && Math.abs(Number(shifted.turnZ) - 30) < 0.05 && shifted.x === 5, JSON.stringify(shifted));
const measured = await call("measure", { object: solid.object, faceA: 2, faceB: 3 });
check("opposite faces of the 20 mm cube are 20 mm apart", measured.ok === true && Math.abs(Number(measured.distanceMm) - 20) < 0.05, JSON.stringify(measured));
const points = await call("measure", { object: solid.object, a: [0, 0, 0], b: [10, 0, 0] });
check("two points are still a distance", points.ok === true && points.distanceMm === 10);

await call("settings_apply", { layerHeight: 0.28 });
const settingsMirror = session.bridgeSnapshot()?.settings as { layerHeight?: number } | undefined;
check("the settings mirror carries 0.28", settingsMirror?.layerHeight === 0.28);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("numbers: ok");
