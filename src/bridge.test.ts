import { BRIDGE_RESEND, bridgeBaseline, bridgeConflict, bridgeDrifted, bridgeHolds, bridgeHumanChanges, bridgeIsNew, bridgeMerge, bridgeNextBaseline, bridgePreserveHuman, bridgeProtectedModel, bridgeServerBaseline, bridgeSettings, bridgeTouched, decodeBridgeHistory, mirrorPlate, parkBridge, releaseBridge, type BridgeMessage, type BridgePlateRow, type BridgeSeen, type MirrorObject } from "./bridge.ts";
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

// --- Tandem beta, 2026-11-09. A: the window turned a mirrored sphere by itself as MCP added a duck; the turn was
// reported as the person's and then held every update. B: one part in conflict froze the whole plate.
const flipped = [-0.99539, -0.03253, -0.09025, -0.03253, 0.99947, -0.00147, 0.09025, 0.00147, -0.99592] as Mat3;
const sphereSeen: BridgeSeen = { session: "s1", seq: 16 };
const sphereRow = row("obj-1", "sphere", 0);
const sphereBase = bridgeServerBaseline({ tool: "project_open", session: "s1", seq: 16, ok: true, plate: [sphereRow] });
const drifted: MirrorObject<string>[] = [{ ...mine, id: "obj-1", name: "obj-1", centered: false, meshHash: "sphere", orient: flipped, extra: "own history" }];
const duckAdded: BridgeMessage = { tool: "solid_new", session: "s1", seq: 17, ok: true, objectId: "obj_2", plate: [sphereRow, row("obj_2", "duck", 80)], meshes: { duck: mesh("duck.stl") } };
const nobody = new Set<string>();
check("A: a pose the window drifted to by itself is not a person's change", bridgeHumanChanges(drifted, sphereBase, nobody).length === 0);
check("A: a drift holds nothing back", bridgeHolds(drifted, duckAdded, sphereSeen, sphereBase, new Set(["obj-1"]), { touched: nobody }).length === 0);
const healed = bridgeMerge(drifted, duckAdded, sphereSeen, sphereBase, [], nobody);
const healedPlate = mirrorPlate(drifted, healed.message, sphereSeen, new Set(["obj-1"]));
const sphereAfter = healedPlate.plate.find((obj) => obj.id === "obj-1");
check("A: adding a new object puts the other mirrored part back at MCP's pose", !healed.diverged && sphereAfter?.orient.every((value, at) => value === ID_MATRIX[at]) === true && sphereAfter.offset.x === 0 && healedPlate.plate.some((obj) => obj.id === "obj_2"));
const clean: MirrorObject<string>[] = [{ ...drifted[0]!, orient: [...ID_MATRIX] as Mat3 }];
const cleanPlate = mirrorPlate(clean, bridgeMerge(clean, duckAdded, sphereSeen, sphereBase, [], nobody).message, sphereSeen, new Set(["obj-1"]));
const untouchedSphere = cleanPlate.plate.find((obj) => obj.id === "obj-1");
check("A: a snapshot adding a new object leaves another mirrored object's orient and offset alone", untouchedSphere?.orient.every((value, at) => value === ID_MATRIX[at]) === true && untouchedSphere.offset.x === 0 && untouchedSphere.extra === "own history");
check("A: and creates no human change", bridgeHumanChanges(cleanPlate.plate, bridgeServerBaseline(duckAdded), nobody).length === 0 && bridgeHumanChanges(cleanPlate.plate, bridgeServerBaseline(duckAdded)).length === 0);
check("A: a part the mirror wrote and the window then moved is found", bridgeDrifted(cleanPlate.plate, drifted, cleanPlate.owned).join() === "obj-1" && bridgeDrifted(cleanPlate.plate, cleanPlate.plate, cleanPlate.owned).length === 0);
const turnedByPerson = new Set(["obj-1"]);
check("A: the same turn made by a person is reported as theirs", bridgeHumanChanges(drifted, sphereBase, turnedByPerson).length === 1);
const kept = mirrorPlate(drifted, bridgeMerge(drifted, duckAdded, sphereSeen, sphereBase, [], turnedByPerson).message, sphereSeen, new Set(["obj-1"]));
check("A: and a person's turn survives a snapshot that only adds a part", kept.plate.find((obj) => obj.id === "obj-1")?.orient[0] === flipped[0]);
check("touched names the parts an edit changed, added or removed", bridgeTouched(
  [{ id: "a", name: "a", orient: ID_MATRIX, partScale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, mesh: "m1" }, { id: "b", name: "b", orient: ID_MATRIX, partScale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, mesh: "m2" }, { id: "c", name: "c", orient: ID_MATRIX, partScale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, mesh: "m3" }],
  [{ id: "a", name: "a", orient: ID_MATRIX, partScale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, mesh: "m1" }, { id: "b", name: "b", orient: rotZ(5), partScale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, mesh: "m2" }, { id: "d", name: "d", orient: ID_MATRIX, partScale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, mesh: "m4" }],
).sort().join() === "b,c,d");

// B: Sphere 1 holds a Model history here and MCP fused spheres onto it; it alone waits.
const plateB: MirrorObject<string>[] = [
  { ...mine, id: "obj-1", name: "Sphere 1", centered: false, meshHash: "sphere", extra: "own history" },
  { ...mine, id: "obj_3", name: "Box", centered: false, meshHash: "box", offset: { x: 50, y: 0, z: 0 }, extra: null as unknown as string },
];
const ownedB = new Set(["obj-1", "obj_3"]);
const baseB = bridgeServerBaseline({ tool: "plate_sync", session: "s1", seq: 20, ok: true, plate: [row("obj-1", "sphere"), row("obj_3", "box", 50)] });
const seenB: BridgeSeen = { session: "s1", seq: 20 };
const isModel = (obj: MirrorObject<string>) => obj.extra === "own history";
const fusedAndMore: BridgeMessage = { tool: "object_duplicate", session: "s1", seq: 21, ok: true, objectId: "obj_22", plate: [row("obj-1", "fused"), row("obj_3", "box", 70), row("obj_22", "fused", 140)], meshes: { fused: mesh("fused.stl") } };
const holdsB = bridgeHolds(plateB, fusedAndMore, seenB, baseB, ownedB, { protectedModel: isModel, touched: new Set() });
check("B: only the part whose Model history MCP would discard is held, with a reason", holdsB.length === 1 && holdsB[0]?.object === "obj-1" && holdsB[0].kind === "model-history" && /plate_undo/.test(holdsB[0].reason) && /project_save/.test(holdsB[0].reason));
const mergedB = bridgeMerge(plateB, fusedAndMore, seenB, baseB, holdsB, new Set());
const appliedB = mirrorPlate(plateB, mergedB.message, seenB, ownedB);
const sphereB = appliedB.plate.find((obj) => obj.id === "obj-1");
check("B: the held part keeps the window's mesh, pose and history", appliedB.applied && !appliedB.missing && sphereB?.meshHash === "sphere" && sphereB.mesh === undefined && sphereB.extra === "own history");
check("B: a new object (a duplicate) applies while one part is held", appliedB.plate.find((obj) => obj.id === "obj_22")?.offset.x === 140);
check("B: an edit to a part not in conflict applies", appliedB.plate.find((obj) => obj.id === "obj_3")?.offset.x === 70);
const nextBaseB = bridgeNextBaseline(fusedAndMore, baseB, holdsB);
check("B: the held part keeps the shared version both last agreed on; the rest move on", nextBaseB.get("obj-1")?.meshHash === "sphere" && nextBaseB.get("obj_3")?.offset.x === 70 && nextBaseB.has("obj_22"));
const arranged: BridgeMessage = { tool: "plate_arrange", session: "s1", seq: 22, ok: true, plate: [row("obj-1", "fused", 5), row("obj_3", "box", 90), row("obj_22", "fused", 160)] };
const holdsB2 = bridgeHolds(appliedB.plate, arranged, appliedB.seen, nextBaseB, appliedB.owned, { protectedModel: isModel, touched: new Set() });
const appliedB2 = mirrorPlate(appliedB.plate, bridgeMerge(appliedB.plate, arranged, appliedB.seen, nextBaseB, holdsB2, new Set()).message, appliedB.seen, appliedB.owned);
check("B: a later arrange still moves every other part; the held one stays held", holdsB2.map((hold) => hold.object).join() === "obj-1" && appliedB2.plate.find((obj) => obj.id === "obj_3")?.offset.x === 90 && appliedB2.plate.find((obj) => obj.id === "obj_22")?.offset.x === 160 && appliedB2.plate.find((obj) => obj.id === "obj-1")?.meshHash === "sphere");
const removedB: BridgeMessage = { tool: "object_remove", session: "s1", seq: 23, ok: true, plate: [row("obj_3", "box", 90)] };
const holdsB3 = bridgeHolds(appliedB2.plate, removedB, appliedB2.seen, nextBaseB, appliedB2.owned, { protectedModel: isModel, touched: new Set() });
const appliedB3 = mirrorPlate(appliedB2.plate, bridgeMerge(appliedB2.plate, removedB, appliedB2.seen, nextBaseB, holdsB3, new Set()).message, appliedB2.seen, appliedB2.owned);
check("B: MCP removing the held part keeps it here; MCP's other removal applies", appliedB3.plate.some((obj) => obj.id === "obj-1") && !appliedB3.plate.some((obj) => obj.id === "obj_22"));
// Two parts moved: the person moved Box here, MCP moved Box and Sphere. Box waits, Sphere moves.
const plateC: MirrorObject<string>[] = [{ ...plateB[0]!, extra: "mesh only" }, { ...plateB[1]!, offset: { x: 55, y: 0, z: 0 } }];
const movedBoth: BridgeMessage = { tool: "object_place", session: "s1", seq: 21, ok: true, plate: [row("obj-1", "sphere", 9), row("obj_3", "box", 70)] };
const holdsC = bridgeHolds(plateC, movedBoth, seenB, baseB, ownedB, { protectedModel: isModel, touched: new Set(["obj_3"]) });
const appliedC = mirrorPlate(plateC, bridgeMerge(plateC, movedBoth, seenB, baseB, holdsC, new Set(["obj_3"])).message, seenB, ownedB);
check("B: a part both sides moved is held as both-changed; the other part's move applies", holdsC.length === 1 && holdsC[0]?.kind === "both-changed" && appliedC.plate.find((obj) => obj.id === "obj_3")?.offset.x === 55 && appliedC.plate.find((obj) => obj.id === "obj-1")?.offset.x === 9);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("bridge: mirror waits for a gesture and applies the plate");
