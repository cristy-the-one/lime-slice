/**
 * Live bridge: plate snapshots and a commit as a mesh hash plus a STEP file.
 * The Tauri listener is not started here.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRIDGE_RELOAD, mirrorPlate, type BridgeMessage, type MirrorObject } from "../src/bridge.ts";
import { fnv1aHex } from "../src/slice-action.ts";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-batch4-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_FAKE = "1";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const session = new Session(fakeEngine());
const call = (name: string, args: unknown = {}) => session.call(name, args);

let desktop: MirrorObject[] = [];
let seen = 0;
const history = { steps: ["desktop"] };

async function take(name: string, args: unknown = {}) {
  const value = await call(name, args);
  const message = session.bridgeSnapshot() as BridgeMessage | null;
  const mirrored = message
    ? mirrorPlate(desktop, message, seen, (path) => {
        try {
          return new Uint8Array(readFileSync(path));
        } catch {
          return null;
        }
      })
    : null;
  if (mirrored?.applied) {
    desktop = mirrored.plate.map((obj) => (obj.history ? obj : { ...obj, history }));
    seen = mirrored.seenSeq;
  }
  return { value, message, mirrored };
}

const made = await take("solid_new", { dx: 20, dy: 20, dz: 20 });
const object = String(made.value.object);
check("a new solid is on the mirrored plate", made.mirrored?.applied === true && desktop.length === 1 && desktop[0]?.id === object, JSON.stringify(made.message?.plate));

const plane = await take("workplane_set", { object, source: "face", origin: [0, 0, 20], turn: [0, 90, 0] });
check("setting a workplane does not commit a mesh", plane.value.ok === true && plane.message?.commit === undefined && desktop.length === 1);

const pointed = await take("workplane_print_up", { object });
const pointedRow = pointed.message?.plate?.find((row) => row.object === object);
const turned = pointedRow != null && (pointedRow.orient[2] !== 0 || pointedRow.orient[6] !== 0);
check("print-up is on the plate snapshot", pointed.value.ok === true && turned && desktop[0]?.orient[2] === pointedRow?.orient[2], JSON.stringify(pointedRow?.orient));

const undone = await take("plate_undo");
check("undo restores the pose from the snapshot", undone.value.ok === true && desktop[0]?.orient[0] === 1 && desktop[0]?.orient[2] === 0 && desktop[0]?.id === object, JSON.stringify(desktop[0]?.orient));

const gone = await take("object_remove", { object });
check("remove clears the mirrored plate", gone.value.ok === true && desktop.length === 0, JSON.stringify(gone.message?.plate));

const back = await take("plate_undo");
check("undo puts the object back", back.value.ok === true && desktop.length === 1 && desktop[0]?.id === object);
const listed = await take("plate_list", {});
const listedIds = Array.isArray(listed.value.objects) ? (listed.value.objects as { object?: string }[]).map((row) => row.object) : [];
check("the mirrored plate matches plate_list", listedIds.length === desktop.length && listedIds[0] === desktop[0]?.id, JSON.stringify({ listedIds, desktop: desktop.map((row) => row.id) }));

const skipped = mirrorPlate(desktop, { tool: "plate_undo", seq: seen + 4, ok: true, plate: [] }, seen);
check("a gap asks to reload and leaves the plate", skipped.reload === BRIDGE_RELOAD && skipped.plate.length === 1 && skipped.plate[0]?.history === history);

const probed = await take("model_probe", { object, op: { kind: "hole", diameterMm: 4, depth: 5, origin: [10, 10, 20], axis: [0, 0, -1] } });
const applied = await take("model_apply", { object, op: { kind: "hole", diameterMm: 4, depth: 5, origin: [10, 10, 20], axis: [0, 0, -1] } });
check("an apply is not a commit", probed.value.ok === true && applied.value.ok === true && applied.message?.commit === undefined && !("op" in (applied.message ?? {})));

const committed = await take("model_commit", { object });
const commit = committed.message?.commit;
const fileBytes = commit ? new Uint8Array(readFileSync(commit.file)) : new Uint8Array();
check(
  "a commit names the mesh hash and the STEP file",
  committed.value.ok === true && commit?.object === object && commit.meshHash === fnv1aHex(fileBytes) && fileBytes.byteLength > 0 && !("op" in (committed.message ?? {})),
  JSON.stringify(commit),
);
check(
  "the desktop reloads that mesh and keeps its history",
  committed.mirrored?.applied === true && desktop[0]?.meshHash === commit?.meshHash && (desktop[0]?.source?.length ?? 0) >= 9 && desktop[0]?.history === history,
  JSON.stringify({ hash: desktop[0]?.meshHash, triangles: (desktop[0]?.source?.length ?? 0) / 9 }),
);

const tuned = await call("settings_set", { values: { ironingSpeed: 15 } });
const tunedMirror = session.bridgeSnapshot();
const values = (tunedMirror?.settings as { values?: { ironingSpeed?: number }; layerHeight?: number } | undefined)?.values;
check("a settings change is on the snapshot", tuned.ok === true && values?.ironingSpeed === 15 && (tunedMirror?.settings as { layerHeight?: number }).layerHeight === 0.2, JSON.stringify(tunedMirror?.settings));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("batch4: ok");
