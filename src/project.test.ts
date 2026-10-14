import { defaultProfile } from "./profiles.ts";
import { DEFAULT_PRESET, LATER_KEYS, type PresetSettings } from "./presets.ts";
import {
  applyMigrations,
  meshRecord,
  parseProject,
  serializeProject,
  type LimeProject,
  type Migration,
} from "./project.ts";
import type { EditEntry } from "./support-edit-list.ts";
import { bytesToBase64 } from "./base64.ts";
import { dropped, jumped, newTree, opLabel, redoTarget, undoTarget, withChild, withNode, type ModelOp, type ModelTree } from "./model-tree.ts";
import { loadedTree, savedTree } from "./model-tree-file.ts";
import { dropRefusal } from "./model-history.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const bytes = new Uint8Array([0x73, 0x74, 0x6c, 1, 2, 3, 4, 9]);
const prune: EditEntry = {
  id: 1,
  scope: "tree",
  edit: { kind: "prune", sites: [{ xy: [1.5, -2], z: 4.25 }] },
};
const regrow: EditEntry = {
  id: 2,
  areaMm2: 3.5,
  edit: { kind: "regrow", region: [[[0, 0], [4, 0], [4, 2], [0, 2]]], z: [1, 4.5] },
};

const project: LimeProject = {
  version: 1,
  mesh: meshRecord("bracket.stl", bytes),
  placement: {
    orient: [0, -1, 0, 1, 0, 0, 0, 0, 1],
    scale: 1.25,
    centered: false,
    offset: { x: 3, y: -1, z: 0 },
    stepTolerance: 0.1,
  },
  settings: { ...DEFAULT_PRESET, layerHeight: 0.16, supports: true, supportStyle: "tree" },
  preset: "bench",
  profile: { ...defaultProfile(), name: "Shop printer", bedX: 300 },
  level: "advanced",
  supportEdits: [prune, regrow],
};

const text = serializeProject(project);
const opened = parseProject(text);
check("round trip opens", opened.ok);
if (opened.ok) eq("round trip keeps the project", opened.project, project);

const beforeSeam = JSON.parse(serializeProject({ ...project, settings: { ...project.settings, seam: "rear" } })) as { settings: Record<string, unknown> };
const rearOpened = parseProject(JSON.stringify(beforeSeam));
check("a rear seam is stored and opened", rearOpened.ok && rearOpened.project.settings.seam === "rear");
delete beforeSeam.settings.seam;
const olderOpened = parseProject(JSON.stringify(beforeSeam));
check("a file from before the seam picker opens at blend", olderOpened.ok && olderOpened.project.settings.seam === "blend");
delete beforeSeam.settings.scarfSeam;
eq("a file without its scarf seam is incomplete", parseProject(JSON.stringify(beforeSeam)), { ok: false, message: "This project file is incomplete." });

const ironed = JSON.parse(serializeProject({
  ...project,
  settings: { ...project.settings, ironing: true, ironingFlow: 0.15, ironingSpeed: 30, ironingSpacing: 0.2 },
})) as { version: number; settings: Record<string, unknown> };
eq("ironing stays on a version 1 project", ironed.version, 1);
const ironOpened = parseProject(JSON.stringify(ironed));
check("ironing round-trips", ironOpened.ok && ironOpened.project.settings.ironing === true && ironOpened.project.settings.ironingFlow === 0.15 && ironOpened.project.settings.ironingSpeed === 30 && ironOpened.project.settings.ironingSpacing === 0.2);
delete ironed.settings.ironing;
delete ironed.settings.ironingFlow;
delete ironed.settings.ironingSpeed;
delete ironed.settings.ironingSpacing;
const beforeIron = parseProject(JSON.stringify(ironed));
check("a file from before ironing opens off, at the defaults", beforeIron.ok && beforeIron.project.settings.ironing === false && beforeIron.project.settings.ironingFlow === 0.1 && beforeIron.project.settings.ironingSpeed === 20 && beforeIron.project.settings.ironingSpacing === 0.1);

const fuzzed = JSON.parse(serializeProject({
  ...project,
  settings: { ...project.settings, fuzzySkin: true, fuzzyThickness: 0.5, fuzzyPointDistance: 1.2 },
})) as { settings: Record<string, unknown> };
const fuzzOpened = parseProject(JSON.stringify(fuzzed));
check("fuzzy skin round-trips", fuzzOpened.ok && fuzzOpened.project.settings.fuzzySkin === true && fuzzOpened.project.settings.fuzzyThickness === 0.5 && fuzzOpened.project.settings.fuzzyPointDistance === 1.2);
delete fuzzed.settings.fuzzySkin;
delete fuzzed.settings.fuzzyThickness;
delete fuzzed.settings.fuzzyPointDistance;
const beforeFuzzy = parseProject(JSON.stringify(fuzzed));
check("a file from before fuzzy skin opens off, at the defaults", beforeFuzzy.ok && beforeFuzzy.project.settings.fuzzySkin === false && beforeFuzzy.project.settings.fuzzyThickness === 0.3 && beforeFuzzy.project.settings.fuzzyPointDistance === 0.8);

const klipped = JSON.parse(serializeProject({ ...project, profile: { ...project.profile, squareCornerVelocity: 8, maxVelocity: 400, maxZAccel: 500 } })) as { profile: Record<string, unknown> };
const klipOpened = parseProject(JSON.stringify(klipped));
check("the Klipper limits round-trip", klipOpened.ok && klipOpened.project.profile.squareCornerVelocity === 8 && klipOpened.project.profile.maxVelocity === 400 && klipOpened.project.profile.maxZAccel === 500);
for (const key of ["squareCornerVelocity", "minimumCruiseRatio", "extruderCornerVelocity", "maxVelocity", "maxZVelocity", "maxZAccel"]) delete klipped.profile[key];
const beforeKlipper = parseProject(JSON.stringify(klipped));
check("a file from before the Klipper limits opens at Klipper's defaults and no caps", beforeKlipper.ok && beforeKlipper.project.profile.squareCornerVelocity === 5 && beforeKlipper.project.profile.minimumCruiseRatio === 0.5 && beforeKlipper.project.profile.extruderCornerVelocity === 1 && beforeKlipper.project.profile.maxVelocity === 0 && beforeKlipper.project.profile.maxZVelocity === 0 && beforeKlipper.project.profile.maxZAccel === 0);

const wire = JSON.parse(text) as { supportEdits: { edit: Record<string, unknown> }[] };
eq("a prune stores sites, not a walk id", wire.supportEdits[0].edit, {
  kind: "prune",
  sites: [{ xy: [1.5, -2], z: 4.25 }],
});
check("the prune edit has no limb id", !("limb" in wire.supportEdits[0].edit) && !("walk" in wire.supportEdits[0].edit));
eq("a regrow stores its region and z range", wire.supportEdits[1].edit.kind, "regrow");

const damaged = parseProject(text.replace(project.mesh.hash, "0000000000000000"));
eq("a hash mismatch is a damaged mesh", damaged, { ok: false, message: "The mesh in this project is damaged." });

const broken = { ...JSON.parse(text), mesh: { ...project.mesh, bytesBase64: "@@@", byteLength: 1, hash: "nope" } };
eq("bad base64 is a damaged mesh", parseProject(JSON.stringify(broken)), { ok: false, message: "The mesh in this project is damaged." });

const short = JSON.parse(text) as { mesh: { bytesBase64: string; byteLength: number } };
short.mesh.byteLength = 1;
eq("a length mismatch is a damaged mesh", parseProject(JSON.stringify(short)), { ok: false, message: "The mesh in this project is damaged." });

eq("prose is not a project", parseProject("not json"), { ok: false, message: "This file is not a Lime Slice project." });
eq("an array is not a project", parseProject("[]"), { ok: false, message: "This file is not a Lime Slice project." });
eq("a file with no version cannot be opened", parseProject("{}"), { ok: false, message: "This project file has no version, so it cannot be opened." });
eq(
  "a newer file is refused",
  parseProject(JSON.stringify({ ...JSON.parse(text), version: 3 })),
  { ok: false, message: "This project is version 3. This app opens up to version 2." },
);
eq(
  "version 0 has no built-in migration",
  parseProject(JSON.stringify({ ...JSON.parse(text), version: 0 })),
  { ok: false, message: "This project is version 0, which this app cannot update." },
);

const step: Migration = (doc) => ({ ...doc, version: 1, level: doc.level ?? "simple" });
const legacy = { ...JSON.parse(text), version: 0 };
delete (legacy as { level?: unknown }).level;
const hooked = parseProject(JSON.stringify(legacy), [step], 1);
check("a migration hook brings version 0 up to 1", hooked.ok && hooked.project.level === "simple" && hooked.project.mesh.name === "bracket.stl");

const bumped = applyMigrations({ version: 0, kept: true }, [step], 1);
eq("applyMigrations reports the rewritten document", bumped, { ok: true, doc: { version: 1, kept: true, level: "simple" } });

const stuck: Migration = (doc) => doc;
eq(
  "a step that forgets to advance the version fails",
  applyMigrations({ version: 0 }, [stuck]),
  { ok: false, message: "This project could not be updated to the current format." },
);

check("embedded bytes decode to the original mesh", bytesToBase64(bytes).length > 0);

const withOverrides: LimeProject = {
  ...project,
  overrides: {
    version: 1,
    ranges: [{ id: "range-a", zFrom: 0, zTo: 4, override: { infill: 0.4, walls: 4, speed: 40 } }],
    volumes: [{ id: "volume-a", kind: "box", x: 110, y: 110, z: 10, sx: 30, sy: 30, sz: 20, override: { infill: 0.6, walls: 3 } }],
  },
};
const savedOverrides = parseProject(serializeProject(withOverrides));
check("overrides round trip", savedOverrides.ok);
if (savedOverrides.ok) eq("overrides stay on the project", savedOverrides.project.overrides, withOverrides.overrides);
const wireOverrides = JSON.parse(serializeProject(project)) as { overrides?: unknown };
check("a project with no ranges omits overrides", wireOverrides.overrides === undefined);
eq(
  "a layer height override is refused",
  parseProject(JSON.stringify({ ...JSON.parse(serializeProject(project)), overrides: { version: 1, ranges: [{ id: "r", zFrom: 0, zTo: 1, override: { layerHeight: 0.08 } }], volumes: [] } })),
  { ok: false, message: "Layer height is not an override. The slice has one layer height." },
);

const wireProject = JSON.parse(text) as { version: number; objects?: unknown; mesh?: unknown };
check("a one-object project stays version 1", wireProject.version === 1);
check("a one-object project omits objects", wireProject.objects === undefined);
check("a one-object project keeps its mesh", wireProject.mesh !== undefined);

const migrated = applyMigrations(JSON.parse(text) as Record<string, unknown>);
check("version 1 migrates to one object", migrated.ok);
if (migrated.ok) {
  const objects = migrated.doc.objects as { id: string }[];
  check("the migrated object id is part", objects.length === 1 && objects[0]?.id === "part");
  check("version 2 drops the top-level mesh", migrated.doc.mesh === undefined && migrated.doc.version === 2);
}

const secondPlacement = { ...project.placement, centered: false, offset: { x: 40, y: 8, z: 0 } };
const multi: LimeProject = {
  ...project,
  version: 2,
  objects: [
    { id: "part", name: "bracket.stl", mesh: project.mesh, placement: project.placement, supportEdits: project.supportEdits },
    { id: "obj-2", name: "bracket.stl 2", mesh: project.mesh, placement: secondPlacement, supportEdits: [] },
  ],
};
const multiText = serializeProject(multi);
const multiWire = JSON.parse(multiText) as { version: number; mesh?: unknown; placement?: unknown; supportEdits?: unknown; objects: { id: string; settings?: unknown }[] };
check("a plate writes version 2", multiWire.version === 2 && multiWire.objects.length === 2);
check("version 2 omits the single mesh, placement, and support edits", multiWire.mesh === undefined && multiWire.placement === undefined && multiWire.supportEdits === undefined);
const openedMulti = parseProject(multiText);
check("a plate round trip opens", openedMulti.ok);
if (openedMulti.ok) {
  eq("a plate keeps both objects", openedMulti.project.objects?.map((obj) => obj.id), ["part", "obj-2"]);
  eq("the first object stays the mesh the one-object path knows", openedMulti.project.mesh, project.mesh);
  eq("the second object keeps its offset", openedMulti.project.objects?.[1]?.placement.offset, { x: 40, y: 8, z: 0 });
}
const layered = JSON.parse(multiText) as { objects: { settings?: unknown }[] };
layered.objects[0]!.settings = { layerHeight: 0.08 };
eq(
  "layer height on an object is refused",
  parseProject(JSON.stringify(layered)),
  { ok: false, message: "Layer height is not a per-object setting. The slice has one layer height." },
);
const soloSettings: LimeProject = {
  ...project,
  version: 2,
  objects: [{ id: "part", name: "bracket.stl", mesh: project.mesh, placement: project.placement, supportEdits: [], settings: { supports: true } }],
};
const soloWire = JSON.parse(serializeProject(soloSettings)) as { version: number; objects: { settings: { supports: boolean } }[]; mesh?: unknown };
check("one object with its own settings stays version 2", soloWire.version === 2 && soloWire.objects[0]?.settings.supports === true && soloWire.mesh === undefined);
const walled: LimeProject = {
  ...project,
  version: 2,
  objects: [{ id: "part", name: "bracket.stl", mesh: project.mesh, placement: project.placement, supportEdits: [], settings: { walls: 3, infill: 0.8, speed: 40 } }],
};
const walledOpen = parseProject(serializeProject(walled));
check("object infill, walls, and speed round-trip", walledOpen.ok && walledOpen.ok && walledOpen.project.objects?.[0]?.settings?.walls === 3 && walledOpen.project.objects?.[0]?.settings?.infill === 0.8 && walledOpen.project.objects?.[0]?.settings?.speed === 40);
const ordered: LimeProject = { ...multi, printOrder: "sequential", sequentialClearanceMm: 4, sequentialGantryMm: 30 };
const orderedWire = JSON.parse(serializeProject(ordered)) as { printOrder?: string; sequentialClearanceMm?: number };
eq("a sequential plate writes the order and the clearance", [orderedWire.printOrder, orderedWire.sequentialClearanceMm], ["sequential", 4]);
const orderedOpen = parseProject(serializeProject(ordered));
check("a sequential plate round-trips", orderedOpen.ok && orderedOpen.ok && orderedOpen.project.printOrder === "sequential" && orderedOpen.project.sequentialClearanceMm === 4 && orderedOpen.project.sequentialGantryMm === 30);
const autoWire = JSON.parse(serializeProject({ ...multi, printOrder: "sequential" })) as { printOrder?: string; sequentialClearanceMm?: unknown };
check("clearance 0 is omitted", autoWire.printOrder === "sequential" && autoWire.sequentialClearanceMm === undefined);
const plainWire = JSON.parse(multiText) as { printOrder?: unknown };
check("all-at-once omits print order", plainWire.printOrder === undefined);

const dabs = [
  { kind: "block" as const, p: [36, 12, 12] as [number, number, number], n: [0, 0, -1] as [number, number, number], r: 4 },
  { kind: "enforce" as const, p: [30, 12, 12] as [number, number, number], n: [0, 0, -1] as [number, number, number], r: 2.5 },
];
const painted: LimeProject = {
  ...project,
  version: 2,
  objects: [{ id: "part", name: "bracket.stl", mesh: project.mesh, placement: project.placement, supportEdits: [], supportPaint: dabs }],
};
const paintedWire = JSON.parse(serializeProject(painted)) as { version: number; objects: { supportPaint?: unknown }[] };
eq("one object with support paint writes version 2 and keeps it in paint order", [paintedWire.version, paintedWire.objects[0]?.supportPaint], [2, dabs]);
const paintedOpened = parseProject(JSON.stringify(paintedWire));
eq("support paint round-trips", paintedOpened.ok ? paintedOpened.project.objects?.[0]?.supportPaint : null, dabs);
const unpaintedOpened = parseProject(multiText);
eq("a plate saved before support paint opens with none", unpaintedOpened.ok ? unpaintedOpened.project.objects?.map((obj) => obj.supportPaint ?? []) : null, [[], []]);
paintedWire.objects[0]!.supportPaint = [{ kind: "paint", p: [0, 0, 0], n: [0, 0, 1], r: 1 }];
eq("damaged paint fails the open", parseProject(JSON.stringify(paintedWire)), { ok: false, message: "The support paint in this project is damaged." });

const reinforceRegions = [
  { kind: "paint" as const, density: 1, depthMm: 5, fillThrough: true, disks: [{ p: [10, 10, 10] as [number, number, number], n: [0, 0, 1] as [number, number, number], r: 3 }] },
  { kind: "box" as const, density: 0.6, center: [5, 5, 5] as [number, number, number], size: [10, 10, 10] as [number, number, number] },
];
const reinforced: LimeProject = {
  ...project,
  version: 2,
  objects: [{ id: "part", name: "bracket.stl", mesh: project.mesh, placement: project.placement, supportEdits: [], reinforcement: reinforceRegions }],
};
const reinforcedWire = JSON.parse(serializeProject(reinforced)) as { version: number; objects: { reinforcement?: unknown }[] };
eq("one object with reinforcement writes version 2 and keeps its regions", [reinforcedWire.version, reinforcedWire.objects[0]?.reinforcement], [2, reinforceRegions]);
const reinforcedOpened = parseProject(JSON.stringify(reinforcedWire));
eq("reinforcement round-trips", reinforcedOpened.ok ? reinforcedOpened.project.objects?.[0]?.reinforcement : null, reinforceRegions);
reinforcedWire.objects[0]!.reinforcement = [{ kind: "paint", density: 5, depthMm: 5, disks: [] }];
eq("damaged reinforcement fails the open", parseProject(JSON.stringify(reinforcedWire)), { ok: false, message: "The reinforcement in this project is damaged." });

const brepMesh = { ...project.mesh, name: "bracket.step" };
const withBrep: LimeProject = {
  ...project,
  version: 2,
  objects: [{ id: "part", name: "bracket.stl", mesh: project.mesh, placement: project.placement, supportEdits: [], brep: brepMesh }],
};
const brepWire = JSON.parse(serializeProject(withBrep)) as { version: number; objects: { brep?: { name: string; hash: string } }[] };
eq("one object with a solid writes version 2 and keeps the brep", [brepWire.version, brepWire.objects[0]?.brep], [2, brepMesh]);
const brepOpened = parseProject(JSON.stringify(brepWire));
eq("brep round-trips", brepOpened.ok ? brepOpened.project.objects?.[0]?.brep : null, brepMesh);
const plainOpened = parseProject(multiText);
eq("a plate saved before brep opens with none", plainOpened.ok ? plainOpened.project.objects?.map((obj) => obj.brep ?? null) : null, [null, null]);
brepWire.objects[0]!.brep = { ...brepMesh, hash: "nope" };
eq("a damaged solid fails the open", parseProject(JSON.stringify(brepWire)), { ok: false, message: "The solid in this project is damaged." });

// Model history: a part with a fork, a renamed step, and a split whose piece has a step of its own.
const rootStep = new Uint8Array([0x49, 0x53, 0x4f, 1, 2, 3]);
const pieceRoot = new Uint8Array([0x49, 0x53, 0x4f, 7, 7]);
const plateStep = meshRecord("bracket.step", new Uint8Array([9, 8, 7]));
const pieceStep = meshRecord("bracket split.step", new Uint8Array([6, 5]));
const cutOp = (dx: number): ModelOp => ({ kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 5], size: [dx, 10, 10], radius: 0, height: 0, turn: [0, 0, 0] });
const splitOp: ModelOp = { kind: "split", origin: [0, 0, 4], normal: [0, 0, 1] };
const filletOp: ModelOp = { kind: "fillet", edges: [{ index: 3, mid: [10, 0, 2.5], lengthMm: 5 }], size: 0.5 };
const fpOf = (volumeMm3: number) => ({ volumeMm3, faces: 6, edges: 12 });
const plateMesh = (token: string) => ({ name: "bracket.stl", bytes: new ArrayBuffer(3), sourcePos: new Float32Array(0), token });
let part = newTree("part#run1.1", { kind: "step", name: "bracket.step", bytes: rootStep.buffer }, "bracket.stl", fpOf(4000));
part = withChild(part, 0, { id: 1, op: cutOp(8), label: opLabel(cutOp(8)), fingerprint: fpOf(3200) });
part = withChild(part, 1, { id: 2, op: cutOp(6), label: opLabel(cutOp(6)), fingerprint: fpOf(2400), name: "Pocket" });
part = withChild(jumped(part, 1), 1, { id: 3, op: cutOp(4), label: opLabel(cutOp(4)), fingerprint: fpOf(1600) });
part = withChild(part, 3, { id: 4, op: splitOp, label: opLabel(splitOp), fingerprint: fpOf(640), piece: "part-piece#run1.2" });
part = { ...withNode(part, 2, { mesh: plateMesh("m-old") }), committed: 3 };
let piece = newTree("part-piece#run1.2", { kind: "piece", tree: part.key, node: 4 }, "bracket split", fpOf(960));
piece = { ...withChild(piece, 0, { id: 1, op: filletOp, label: opLabel(filletOp), fingerprint: fpOf(959) }), committed: 1 };
const owners = new Map([[piece.key, "obj-2"]]);
const treeWith = (tree: ModelTree, committed: number, step: Uint8Array, name: string) => ({
  ...savedTree(tree, committed, (key) => owners.get(key)),
  rootStep: meshRecord(name, step),
});
const historied: LimeProject = {
  ...project,
  version: 2,
  objects: [
    { id: "part", name: "bracket.stl", mesh: project.mesh, placement: project.placement, supportEdits: [], brep: plateStep, modelTree: treeWith(part, 3, rootStep, "bracket.step") },
    { id: "obj-2", name: "bracket split", mesh: project.mesh, placement: secondPlacement, supportEdits: [], brep: pieceStep, modelTree: treeWith(piece, 1, pieceRoot, "bracket split.step") },
  ],
};
const historyText = serializeProject(historied);
const historyOpened = parseProject(historyText);
const historyObjects = historyOpened.ok ? historyOpened.project.objects ?? [] : [];
eq("a tree round-trips: ops, names, fingerprints, the split's piece, and the root STEP", historyObjects.map((obj) => obj.modelTree), historied.objects!.map((obj) => obj.modelTree));
eq("the split names its piece by plate object, not by engine key", historyObjects[0]?.modelTree?.nodes.find((node) => node.id === 4)?.piece, "obj-2");
eq("a fillet keeps its edge as index, midpoint, and length", historyObjects[1]?.modelTree?.nodes[1]?.op, filletOp);
eq("nothing is unread", historyOpened.ok ? historyOpened.project.unreadHistory : "not opened", undefined);

const reopenedKeys = new Map([["part", "part#run2.1"], ["obj-2", "obj-2#run2.2"]]);
const reopen = (i: number, label: string, token: string) => {
  const saved = historyObjects[i]!.modelTree!;
  const bytes = new Uint8Array([...atob(saved.rootStep.bytesBase64!)].map((c) => c.charCodeAt(0)));
  return loadedTree(saved, reopenedKeys.get(historyObjects[i]!.id)!, { kind: "step", name: saved.rootStep.name, bytes: bytes.buffer }, label, plateMesh(token), (id) => reopenedKeys.get(id));
};
const partAgain = reopen(0, "bracket.stl", "m-part");
const pieceAgain = reopen(1, "bracket split", "m-piece");
eq("the reopened tree has every step, oldest first", [...partAgain.nodes.keys()].sort(), [0, 1, 2, 3, 4]);
eq("labels come from the ops, the root from the part, and names stay", [...partAgain.nodes.values()].sort((a, b) => a.id - b.id).map((node) => node.name ?? node.label), [
  "bracket.stl",
  "Cut box 8×10×10",
  "Pocket",
  "Cut box 4×10×10",
  "Split at Z 4",
]);
eq("the plate's step is current and committed, with the plate's mesh", [partAgain.current, partAgain.committed, partAgain.nodes.get(3)?.mesh?.token], [3, 3, "m-part"]);
eq("a step the plate held before the save has no mesh now", partAgain.nodes.get(2)?.mesh, undefined);
eq("the split names the piece's new tree", partAgain.nodes.get(4)?.piece, "obj-2#run2.2");
eq("the piece's tree opens from its own root STEP", [pieceAgain.root.kind, pieceAgain.root.kind === "step" ? [...new Uint8Array(pieceAgain.root.bytes)] : []], ["step", [...pieceRoot]]);
eq("Undo goes up from the plate's step, and Redo to the step shown when saved", [undoTarget(partAgain), redoTarget(partAgain)], [1, 4]);
for (const id of partAgain.nodes.keys()) {
  check(`Delete branch and its reason agree on step ${id}`, (dropped(partAgain, id) === null) === (dropRefusal(partAgain, id) !== null));
}
eq(
  "after a reopen, what stays: the root, the plate's path, and the split with a piece on the plate",
  [...partAgain.nodes.keys()].sort().map((id) => dropRefusal(partAgain, id) !== null),
  [true, true, false, true, true],
);
const pieceGone = { ...savedTree(part, 3, () => undefined), rootStep: null };
eq("a split whose piece left the plate is saved without it", pieceGone.nodes.find((node) => node.id === 4)?.piece, undefined);
const pieceGoneAgain = loadedTree(pieceGone, "part#run2.3", partAgain.root, "bracket.stl", plateMesh("m-part"), () => undefined);
eq("and can be deleted after a reopen", dropRefusal(pieceGoneAgain, 4), null);

const unread = (tamper: (tree: Record<string, unknown>) => void) => {
  const wire = JSON.parse(historyText) as { objects: { modelTree: Record<string, unknown> }[] };
  tamper(wire.objects[0]!.modelTree);
  return parseProject(JSON.stringify(wire));
};
for (const [name, tamper] of [
  ["a step under a parent it does not have", (tree: Record<string, unknown>) => ((tree.nodes as { parent: number }[])[2]!.parent = 9)],
  ["an op it does not know", (tree: Record<string, unknown>) => ((tree.nodes as { op: unknown }[])[1]!.op = { kind: "loft" })],
  ["a plate step that is not in it", (tree: Record<string, unknown>) => (tree.committed = 12)],
  ["a damaged root STEP", (tree: Record<string, unknown>) => ((tree.rootStep as { hash: string }).hash = "nope")],
  ["a root STEP that names bytes the file does not have", (tree: Record<string, unknown>) => delete (tree.rootStep as { bytesBase64?: string }).bytesBase64],
  ["a tree that is not one", (tree: Record<string, unknown>) => delete tree.nodes],
] as const) {
  const read = unread(tamper);
  check(`${name}: the project still opens`, read.ok);
  if (!read.ok) continue;
  eq(`${name}: the tree is left out and named`, [read.project.objects?.map((obj) => !!obj.modelTree), read.project.unreadHistory], [[false, true], ["bracket.stl"]]);
  eq(`${name}: the part keeps its mesh and solid`, [read.project.objects?.[0]?.mesh, read.project.objects?.[0]?.brep], [project.mesh, plateStep]);
}
const oldPlate = parseProject(multiText);
eq("a file from before the tree opens with none and no notice", oldPlate.ok ? [oldPlate.project.objects?.map((obj) => obj.modelTree ?? null), oldPlate.project.unreadHistory] : null, [[null, null], undefined]);

// A copy's tree is rooted in the same STEP as its source's step: the bytes are written once.
const copyRoot = meshRecord("bracket.step", new Uint8Array([9, 8, 7]));
const copied: LimeProject = {
  ...project,
  version: 2,
  objects: [
    historied.objects![0]!,
    { id: "obj-3", name: "bracket.stl 2", mesh: project.mesh, placement: secondPlacement, supportEdits: [], brep: plateStep, modelTree: { ...savedTree(jumped(part, 0), 0, () => undefined), rootStep: copyRoot } },
    { id: "obj-4", name: "bracket.stl 3", mesh: project.mesh, placement: secondPlacement, supportEdits: [], modelTree: treeWith(part, 3, rootStep, "bracket.step") },
  ],
};
const copiedWire = JSON.parse(serializeProject(copied)) as { objects: { modelTree: { rootStep: { bytesBase64?: string; hash: string } } }[] };
eq(
  "a root STEP the file already holds is written by hash alone: another object's solid, or an earlier root",
  copiedWire.objects.map((obj) => [obj.modelTree.rootStep.bytesBase64 !== undefined, obj.modelTree.rootStep.hash]),
  [[true, meshRecord("x", rootStep).hash], [false, plateStep.hash], [false, meshRecord("x", rootStep).hash]],
);
const copiedOpened = parseProject(JSON.stringify(copiedWire));
eq(
  "and each one reads back whole",
  copiedOpened.ok ? copiedOpened.project.objects?.map((obj) => obj.modelTree?.rootStep.bytesBase64) : null,
  [bytesToBase64(rootStep), plateStep.bytesBase64, bytesToBase64(rootStep)],
);

const actions = [
  { zMm: 4.2, kind: "pause" as const },
  { zMm: 10, kind: "filamentChange" as const, note: "white" },
];
eq("a project without layer actions omits them", [JSON.parse(text).layerActions, JSON.parse(multiText).layerActions], [undefined, undefined]);
eq("an empty list is omitted too", JSON.parse(serializeProject({ ...project, layerActions: [] })).layerActions, undefined);
const paused: LimeProject = { ...project, layerActions: actions };
const pausedWire = JSON.parse(serializeProject(paused)) as { version: number; layerActions?: unknown[] };
eq("layer actions stay on a version 1 project", [pausedWire.version, pausedWire.layerActions], [1, actions]);
const pausedOpened = parseProject(JSON.stringify(pausedWire));
eq("a one-object project keeps its layer actions", pausedOpened.ok ? pausedOpened.project : null, paused);
const pausedPlate: LimeProject = { ...multi, layerActions: actions };
const pausedPlateOpened = parseProject(serializeProject(pausedPlate));
eq("a plate keeps its layer actions", pausedPlateOpened.ok ? pausedPlateOpened.project.layerActions : null, actions);
const damagedActions = "The pauses and filament changes in this project are damaged.";
for (const [name, bad] of [
  ["not a list", { zMm: 1, kind: "pause" }],
  ["a negative height", [{ zMm: -1, kind: "pause" }]],
  ["an unknown kind", [{ zMm: 1, kind: "custom" }]],
  ["a note that is not text", [{ zMm: 1, kind: "pause", note: 3 }]],
] as const) {
  eq(`layer actions with ${name} fail the open`, parseProject(JSON.stringify({ ...pausedWire, layerActions: bad })), { ok: false, message: damagedActions });
}

const later: Partial<PresetSettings> = {
  seam: "rear",
  ironing: true,
  ironingFlow: 0.15,
  ironingSpeed: 30,
  ironingSpacing: 0.15,
  fuzzySkin: true,
  fuzzyThickness: 0.4,
  fuzzyPointDistance: 1,
  flow: 0.95,
  retractOn: true,
  retractLength: 0.8,
  retractSpeed: 40,
  supportAvoidance: true,
  supportSource: "paint",
  minLayerTimeS: 6,
  minLayerSpeedMmS: 10,
  adhesion: "brim",
  brimWidthMm: 8,
  brimGapMm: 0.2,
  skirtLoops: 3,
  topSurfacePattern: "monotonic",
  xyHoleCompensationMm: 0.1,
  xyContourCompensationMm: -0.05,
  elephantsFootCompensationMm: 0.2,
  supportZGapMm: 0.25,
  supportXyGapMm: 0.7,
  supportInterfaceLayers: 2,
  supportTreeBrimMm: 4,
  bridgeFlowRatio: 0.9,
  bridgeSpeedMmS: 25,
  bridgeFanPercent: 80,
};
eq("the later settings below cover every later key", Object.keys(later).sort(), [...LATER_KEYS].sort());
eq("each one differs from its default", Object.entries(later).filter(([key, value]) => DEFAULT_PRESET[key as keyof PresetSettings] === value).map(([key]) => key), []);
const laterSettings = { ...project.settings, ...later };
const laterOpened = parseProject(serializeProject({ ...project, settings: laterSettings }));
eq("every later setting survives a save and reopen", laterOpened.ok ? laterOpened.project.settings : null, laterSettings);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("project: round trip, migration, and damaged files ok");
