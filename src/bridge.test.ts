import { BRIDGE_RESEND, bridgeBaseline, bridgeConflict, bridgeHumanChanges, bridgeIsNew, bridgePreserveHuman, bridgeProtectedModel, bridgeServerBaseline, bridgeSettings, decodeBridgeHistory, mirrorPlate, parkBridge, releaseBridge, type BridgeMessage, type BridgePlateRow, type BridgeSeen, type MirrorObject } from "./bridge.ts";
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

const baseline = bridgeBaseline(placed.plate, placed.owned);
const humanMoved = placed.plate.map((obj) => obj.id === "obj_1" ? { ...obj, offset: { ...obj.offset, x: 19 } } : obj);
const humanSummary = bridgeHumanChanges(humanMoved, baseline);
check("the assistant can inspect the human's changed pose", humanSummary.length === 1 && (humanSummary[0]?.offset as { x: number }).x === 19 && humanSummary[0]?.meshChanged === false);
check("a removed mirrored part is visible in human changes", bridgeHumanChanges([], baseline)[0]?.removed === true);
const incoming: BridgeMessage = { tool: "object_place", session: "s1", seq: 3, ok: true, plate: [row("obj_1", "h1", 25)] };
const protectedPlate = placed.plate.map((obj) => obj.id === "obj_1" ? { ...obj, extra: "model" } : obj);
check("a mesh replacement cannot overwrite an editable desktop Model tree", bridgeProtectedModel(protectedPlate, { ...incoming, tool: "model_commit", plate: [row("obj_1", "new-mesh")] }, placed.seen, placed.owned, (extra) => extra === "model") === "obj_1");
check("a remote removal cannot discard an editable desktop Model tree", bridgeProtectedModel(protectedPlate, { ...incoming, tool: "object_remove", plate: [] }, placed.seen, placed.owned, (extra) => extra === "model") === "obj_1");
check("a new server does not claim an unlisted desktop Model tree", bridgeProtectedModel(protectedPlate, { ...incoming, session: "s2", tool: "plate_sync", plate: [] }, placed.seen, placed.owned, (extra) => extra === "model") === null);
check("a placement that keeps the mesh does not block an editable desktop Model tree", bridgeProtectedModel(protectedPlate, incoming, placed.seen, placed.owned, (extra) => extra === "model") === null);
check("a concurrent desktop move is detected before a snapshot can overwrite it", bridgeConflict(humanMoved, incoming, placed.seen, baseline) === "obj_1");
const unchangedRemote = { ...incoming, plate: [row("obj_1", "h1", 12, [...rotZ(90)])] };
check("a desktop move does not conflict with an unchanged server row", bridgeConflict(humanMoved, unchangedRemote, placed.seen, baseline) === null);
const preserved = mirrorPlate(humanMoved, bridgePreserveHuman(humanMoved, unchangedRemote, placed.seen, baseline), placed.seen, placed.owned);
check("a desktop move survives an unchanged server snapshot", preserved.plate.find((obj) => obj.id === "obj_1")?.offset.x === 19);
check("the baseline still records the server's pose", bridgeServerBaseline(unchangedRemote).get("obj_1")?.offset.x === 12);
const twoObjects = [...placed.plate, { ...mine, id: "obj_2", name: "obj_2", centered: false, meshHash: "h2" }];
const twoOwned = new Set(["obj_1", "obj_2"]);
const twoBaseline = bridgeBaseline(twoObjects, twoOwned);
const humanFirst = twoObjects.map((obj) => obj.id === "obj_1" ? { ...obj, offset: { ...obj.offset, x: 19 } } : obj);
const remoteSecond: BridgeMessage = { ...incoming, plate: [row("obj_1", "h1", 12, [...rotZ(90)]), row("obj_2", "h2", 30)] };
check("independent human and assistant changes do not conflict", bridgeConflict(humanFirst, remoteSecond, placed.seen, twoBaseline) === null);
const combined = mirrorPlate(humanFirst, bridgePreserveHuman(humanFirst, remoteSecond, placed.seen, twoBaseline), placed.seen, twoOwned);
check("independent changes to two parts both survive", combined.plate.find((obj) => obj.id === "obj_1")?.offset.x === 19 && combined.plate.find((obj) => obj.id === "obj_2")?.offset.x === 30);
const laterConflict = { ...remoteSecond, seq: 4, plate: [row("obj_1", "h1", 25), row("obj_2", "h2", 30)] };
check("a later change to the human-edited part still conflicts", bridgeConflict(combined.plate, laterConflict, combined.seen, bridgeServerBaseline(remoteSecond)) === "obj_1");
check("an unmodified desktop accepts the assistant's change", bridgeConflict(placed.plate, incoming, placed.seen, baseline) === null);
check("a desktop deletion is protected", bridgeConflict(placed.plate.filter((obj) => obj.id !== "obj_1"), incoming, placed.seen, baseline) === "obj_1");

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

const savedHistory = { tree: { nodes: [{ id: 0, parent: null, op: null, fingerprint: null }], current: 0, committed: 0, nextId: 1, rootStep: { name: "root.step", bytesBase64: "YWJj", byteLength: 3, hash: "test" } }, brepB64: "ZGVm" } satisfies NonNullable<BridgeMessage["modelHistories"]>[string];
const decodedHistory = decodeBridgeHistory(savedHistory);
check("a self-contained history and solid are decoded", !!decodedHistory && !!decodedHistory.tree.rootStep && new TextDecoder().decode(decodedHistory.tree.rootStep.bytes) === "abc" && new TextDecoder().decode(decodedHistory.brep) === "def");
check("a truncated root is refused", decodeBridgeHistory({ ...savedHistory, tree: { ...savedHistory.tree, rootStep: { name: "root.step", bytesBase64: "YWJj", byteLength: 4, hash: "test" } } }) === null);
check("histories with linked split pieces are refused", decodeBridgeHistory({ ...savedHistory, tree: { ...savedHistory.tree, nodes: [{ ...savedHistory.tree.nodes[0]!, piece: "other" }] } }) === null);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("bridge: mirror waits for a gesture and applies the plate");
