/**
 * Live bridge: plate snapshots, each mesh sent once, and a commit as a new mesh.
 * The Tauri listener is not started here.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mirrorPlate, type BridgeMessage, type BridgeSeen, type MirrorObject } from "../src/bridge.ts";

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

/** The desktop keeps the last mesh each object was sent, as the app does. */
type Held = { source: Float32Array; fileName: string };
let desktop: MirrorObject<Held>[] = [];
let seen: BridgeSeen = { session: "", seq: 0 };
let owned = new Set<string>();

async function take(name: string, args: unknown = {}) {
  const value = await call(name, args);
  const message = session.bridgeSnapshot() as BridgeMessage | null;
  const mirrored = message ? mirrorPlate(desktop, message, seen, owned) : null;
  if (mirrored?.applied) {
    desktop = mirrored.plate.map((obj) => (obj.mesh ? { ...obj, extra: { source: obj.mesh.source, fileName: obj.mesh.fileName } } : obj));
    seen = mirrored.seen;
    owned = mirrored.owned;
  }
  return { value, message, mirrored };
}

const made = await take("solid_new", { dx: 20, dy: 20, dz: 20 });
const object = String(made.value.object);
check("a new solid is not on the plate before its first commit", made.mirrored?.applied === true && desktop.length === 0 && made.message?.plate?.length === 0, JSON.stringify(made.message?.plate));
const first = await take("model_commit", { object });
const firstMesh = first.message?.meshes?.[String(first.message?.commit?.meshHash)];
check(
  "its first commit sends the mesh the server slices",
  first.value.ok === true && desktop.length === 1 && desktop[0]?.id === object && (desktop[0].extra?.source.length ?? 0) >= 9 && firstMesh?.fileName.endsWith(".step") === true,
  JSON.stringify({ plate: first.message?.plate, meshes: Object.keys(first.message?.meshes ?? {}) }),
);

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
check("undo puts the object back and sends the mesh the desktop dropped", back.value.ok === true && desktop.length === 1 && desktop[0]?.id === object && back.message?.meshes !== undefined);
const listedAgain = await take("plate_list", {});
check("a step that keeps the plate sends no mesh", listedAgain.message?.meshes === undefined);
const listed = await take("plate_list", {});
const listedIds = Array.isArray(listed.value.objects) ? (listed.value.objects as { object?: string }[]).map((row) => row.object) : [];
check("the mirrored plate matches plate_list", listedIds.length === desktop.length && listedIds[0] === desktop[0]?.id, JSON.stringify({ listedIds, desktop: desktop.map((row) => row.id) }));

const skipped = mirrorPlate(desktop, { tool: "plate_undo", session: seen.session, seq: seen.seq + 4, ok: true, plate: [] }, seen, owned);
check("a gap still applies the snapshot", skipped.applied && skipped.plate.length === 0);

const probed = await take("model_probe", { object, op: { kind: "hole", diameterMm: 4, depth: 5, origin: [10, 10, 20], axis: [0, 0, -1] } });
const applied = await take("model_apply", { object, op: { kind: "hole", diameterMm: 4, depth: 5, origin: [10, 10, 20], axis: [0, 0, -1] } });
check("an apply is not a commit", probed.value.ok === true && applied.value.ok === true && applied.message?.commit === undefined && !("op" in (applied.message ?? {})));

const before = desktop[0]?.extra?.source;
const committed = await take("model_commit", { object });
const commit = committed.message?.commit;
check(
  "a commit names the new mesh and carries it",
  committed.value.ok === true && commit?.object === object && commit.meshHash !== first.message?.commit?.meshHash && committed.message?.meshes?.[commit.meshHash] !== undefined && !("op" in (committed.message ?? {})),
  JSON.stringify(commit),
);
check(
  "the desktop takes the committed mesh",
  committed.mirrored?.applied === true && desktop[0]?.meshHash === commit?.meshHash && (desktop[0]?.extra?.source.length ?? 0) >= 9 && desktop[0]?.extra?.source !== before,
  JSON.stringify({ hash: desktop[0]?.meshHash, triangles: (desktop[0]?.extra?.source.length ?? 0) / 9 }),
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
