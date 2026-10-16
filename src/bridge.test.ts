import { BRIDGE_RESEND, bridgeIsNew, bridgeSettings, mirrorPlate, parkBridge, releaseBridge, type BridgeMessage, type BridgePlateRow, type BridgeSeen, type MirrorObject } from "./bridge.ts";
import { ID_MATRIX, rotZ, type Mat3 } from "./mesh-place.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const triangle = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
const mesh = (name: string) => ({
  fileName: name,
  bytesB64: Buffer.from(`solid ${name}`).toString("base64"),
  positionsB64: Buffer.from(triangle.buffer).toString("base64"),
  seatMm: 1.5,
});
const row = (object: string, hash: string, x = 0, orient: Mat3 = [...ID_MATRIX]): BridgePlateRow => ({
  object,
  name: object,
  scalePercent: 100,
  centered: false,
  offset: { x, y: 0, z: 0 },
  orient,
  meshHash: hash,
});
const mine: MirrorObject<string> = {
  id: "obj-1",
  name: "mine",
  scalePercent: 100,
  centered: true,
  offset: { x: 0, y: 0, z: 0 },
  orient: [...ID_MATRIX],
  meshHash: "own",
  extra: "desktop paint",
};
const start: BridgeSeen = { session: "", seq: 0 };

const added = mirrorPlate([mine], {
  tool: "solid_new",
  session: "s1",
  seq: 1,
  ok: true,
  objectId: "obj_1",
  plate: [row("obj_1", "h1")],
  meshes: { h1: mesh("sphere.step") },
}, start);
const fresh = added.plate.find((obj) => obj.id === "obj_1");
check("a new server object arrives with its mesh", added.applied && fresh?.mesh?.source.length === 9 && fresh.mesh.fileName === "sphere.step" && fresh.mesh.seatMm === 1.5);
check("the desktop's own object stays", added.plate[0]?.id === "obj-1" && added.plate[0].extra === "desktop paint");
check("the new object is the server's and selected", added.owned.has("obj_1") && !added.owned.has("obj-1") && added.selectId === "obj_1");

const placed = mirrorPlate(added.plate, {
  tool: "object_place",
  session: "s1",
  seq: 2,
  ok: true,
  objectId: "obj_1",
  plate: [row("obj_1", "h1", 12, [...rotZ(90)])],
}, added.seen, added.owned);
const moved = placed.plate.find((obj) => obj.id === "obj_1");
check("a place copies the resulting pose and keeps the mesh", placed.applied && moved?.offset.x === 12 && moved.orient[1] !== 0 && moved.mesh === undefined);

const stale = mirrorPlate(placed.plate, { tool: "object_place", session: "s1", seq: 2, ok: true, plate: [] }, placed.seen, placed.owned);
check("an older message changes nothing", !stale.applied && stale.plate.length === 2);

const gap = mirrorPlate(placed.plate, {
  tool: "plate_undo",
  session: "s1",
  seq: 9,
  ok: true,
  plate: [row("obj_1", "h1", 3)],
}, placed.seen, placed.owned);
check("a skipped sequence still applies the snapshot", gap.applied && gap.seen.seq === 9 && gap.plate.find((obj) => obj.id === "obj_1")?.offset.x === 3);

const unsent = mirrorPlate(gap.plate, {
  tool: "model_commit",
  session: "s1",
  seq: 10,
  ok: true,
  commit: { object: "obj_1", meshHash: "h2" },
  plate: [row("obj_1", "h2")],
}, gap.seen, gap.owned);
check("a mesh that never arrived leaves the plate and asks again", unsent.missing === BRIDGE_RESEND && !unsent.applied && unsent.seen.seq === 9 && unsent.plate.length === 2);

const committed = mirrorPlate(gap.plate, {
  tool: "model_commit",
  session: "s1",
  seq: 11,
  ok: true,
  commit: { object: "obj_1", meshHash: "h2" },
  plate: [row("obj_1", "h2")],
  meshes: { h2: mesh("sphere.step") },
}, gap.seen, gap.owned);
check("a commit replaces the mesh", committed.applied && committed.plate.find((obj) => obj.id === "obj_1")?.meshHash === "h2" && committed.plate.find((obj) => obj.id === "obj_1")?.mesh !== undefined);

const removed = mirrorPlate(committed.plate, { tool: "object_remove", session: "s1", seq: 12, ok: true, plate: [] }, committed.seen, committed.owned);
check("remove drops the server's object and nothing else", removed.applied && removed.plate.length === 1 && removed.plate[0]?.id === "obj-1");

const restarted = mirrorPlate(committed.plate, { tool: "project_create", session: "s2", seq: 1, ok: true, plate: [] }, committed.seen, committed.owned);
check("a new server keeps what the old one sent, as the desktop's", restarted.applied && restarted.plate.length === 2 && restarted.owned.size === 0 && restarted.seen.session === "s2");

const shared = mirrorPlate([{ ...mine, id: "obj_1", meshHash: "h1" }], {
  tool: "object_place",
  session: "s1",
  seq: 1,
  ok: true,
  plate: [row("obj_1", "h1", 7)],
}, start);
check("an object both opened from one project is moved, not copied", shared.applied && shared.plate.length === 1 && shared.plate[0]?.offset.x === 7 && shared.plate[0].extra === "desktop paint");

const failedTool = mirrorPlate(committed.plate, { tool: "object_place", session: "s1", seq: 13, ok: false, plate: [] }, committed.seen, committed.owned);
check("a refused tool moves the sequence and leaves the plate", failedTool.applied && failedTool.seen.seq === 13 && failedTool.plate.length === 2);

check("a settings mirror reads the result", bridgeSettings({ tool: "settings_apply", ok: true, settings: { layerHeight: 0.28 } })?.layerHeight === 0.28);
check("a plate tool has no settings", bridgeSettings({ tool: "object_place", ok: true }) === null);
check("a new session is always new", bridgeIsNew({ session: "a", seq: 50 }, { session: "b", seq: 1 }));

let queued: BridgeMessage[] = [];
const duringDrag: BridgeMessage = { tool: "object_place", session: "s1", seq: 3, ok: true, plate: [] };
for (let i = 0; i < 20; i += 1) queued = parkBridge(queued, duringDrag);
let heldAll = true;
for (let i = 0; i < 20; i += 1) {
  const held = releaseBridge(queued, "dragging");
  heldAll = heldAll && held.ready.length === 0 && held.waiting.length === 20;
  queued = held.waiting;
}
check("a mirror during a drag stays queued", heldAll);
const after = releaseBridge(queued, "");
check("the queued mirrors apply after the drag", after.ready.length === 20 && after.waiting.length === 0);

// The desktop keeps one queue and empties it in place after a release. The ready list must survive that.
const live: BridgeMessage[] = [duringDrag, duringDrag];
const freed = releaseBridge(live, "");
live.splice(0, live.length, ...freed.waiting);
check("emptying the queue in place keeps what was released", freed.ready.length === 2);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("bridge: mirror waits for a gesture and applies the plate");
