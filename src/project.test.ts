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
import { loadedTree, savedTree, toolFirst, type SavedJoin, type SavedTreeBody } from "./model-tree-file.ts";
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
// A project keeps the user's Arc fit and never the printer's arcs answer: a stray
// firmwareArcs in a hand-edited file is dropped, so the printer always decides.
{
  const edited = JSON.parse(text) as { settings: Record<string, unknown>; profile: Record<string, unknown> };
  edited.settings.arcFit = false;
  edited.profile.firmwareArcs = true;
  const reopened = parseProject(JSON.stringify(edited));
  check("a project keeps its Arc fit choice", reopened.ok && reopened.project.settings.arcFit === false);
  check("a project drops a firmwareArcs of its own", reopened.ok && !("firmwareArcs" in reopened.project.profile), reopened.ok ? JSON.stringify(reopened.project.profile) : "");
}
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
eq("ironing is written in a version 4 plate", ironed.version, 4);
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

const wire = (JSON.parse(text) as { objects: { supportEdits: { edit: Record<string, unknown> }[] }[] }).objects[0]!;
eq("a prune stores sites, not a walk id", wire.supportEdits[0].edit, {
  kind: "prune",
  sites: [{ xy: [1.5, -2], z: 4.25 }],
});
check("the prune edit has no limb id", !("limb" in wire.supportEdits[0].edit) && !("walk" in wire.supportEdits[0].edit));
eq("a regrow stores its region and z range", wire.supportEdits[1].edit.kind, "regrow");

/** A file as version 1 wrote it: the one object's mesh, placement, and edits at the top. */
function asVersion1(source: string): Record<string, unknown> {
  const doc = JSON.parse(source) as Record<string, unknown> & { objects: Record<string, unknown>[] };
  const { mesh, placement, supportEdits } = doc.objects[0]!;
  delete (doc as { objects?: unknown }).objects;
  return { ...doc, version: 1, mesh, placement, supportEdits };
}

const damaged = parseProject(text.replace(project.mesh.hash, "0000000000000000"));
eq("a hash mismatch is a damaged mesh", damaged, { ok: false, message: "The mesh in this project is damaged." });

const broken = JSON.parse(text) as { objects: { mesh: Record<string, unknown> }[] };
broken.objects[0]!.mesh = { ...project.mesh, bytesBase64: "@@@", byteLength: 1, hash: "nope" };
eq("bad base64 is a damaged mesh", parseProject(JSON.stringify(broken)), { ok: false, message: "The mesh in this project is damaged." });

const short = JSON.parse(text) as { objects: { mesh: { bytesBase64: string; byteLength: number } }[] };
short.objects[0]!.mesh.byteLength = 1;
eq("a length mismatch is a damaged mesh", parseProject(JSON.stringify(short)), { ok: false, message: "The mesh in this project is damaged." });

eq("prose is not a project", parseProject("not json"), { ok: false, message: "This file is not a Lime Slice project." });
eq("an array is not a project", parseProject("[]"), { ok: false, message: "This file is not a Lime Slice project." });
eq("a file with no version cannot be opened", parseProject("{}"), { ok: false, message: "This project file has no version, so it cannot be opened." });
eq(
  "a newer file is refused",
  parseProject(JSON.stringify({ ...JSON.parse(text), version: 5 })),
  { ok: false, message: "This project is version 5. This app opens up to version 4." },
);
eq(
  "version 0 has no built-in migration",
  parseProject(JSON.stringify({ ...JSON.parse(text), version: 0 })),
  { ok: false, message: "This project is version 0, which this app cannot update." },
);

const step: Migration = (doc) => ({ ...doc, version: 1, level: doc.level ?? "simple" });
const legacy = { ...asVersion1(text), version: 0 };
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

const wireProject = JSON.parse(text) as { version: number; objects?: { id: string }[]; mesh?: unknown };
check("a one-object project is written as a version 4 plate", wireProject.version === 4 && wireProject.objects?.length === 1 && wireProject.objects[0]?.id === "part");
check("a one-object project keeps no top-level mesh", wireProject.mesh === undefined);
const version1Text = JSON.stringify(asVersion1(text));
const fromVersion1 = parseProject(version1Text);
check("a version 1 file still opens", fromVersion1.ok && fromVersion1.project.mesh.hash === project.mesh.hash && fromVersion1.project.supportEdits.length === 2);

const migrated = applyMigrations(JSON.parse(version1Text) as Record<string, unknown>);
check("version 1 migrates to one object", migrated.ok);
if (migrated.ok) {
  const objects = migrated.doc.objects as { id: string }[];
  check("the migrated object id is part", objects.length === 1 && objects[0]?.id === "part");
  check("a plate drops the top-level mesh and is version 4", migrated.doc.mesh === undefined && migrated.doc.version === 4);
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
check("a plate writes version 4", multiWire.version === 4 && multiWire.objects.length === 2);
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
check("one object with its own settings stays a plate", soloWire.version === 4 && soloWire.objects[0]?.settings.supports === true && soloWire.mesh === undefined);
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
eq("one object with support paint writes a plate and keeps it in paint order", [paintedWire.version, paintedWire.objects[0]?.supportPaint], [4, dabs]);
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
eq("one object with reinforcement writes a plate and keeps its regions", [reinforcedWire.version, reinforcedWire.objects[0]?.reinforcement], [4, reinforceRegions]);
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
eq("one object with a solid writes a plate and keeps the brep", [brepWire.version, brepWire.objects[0]?.brep], [4, brepMesh]);
// A version 2 file, whose solid is STEP, opens as it is: the engine reads STEP there.
eq("a version 2 file with a STEP solid still opens with it", (() => {
  const old = parseProject(JSON.stringify({ ...brepWire, version: 2 }));
  return old.ok ? [old.project.version, old.project.objects?.[0]?.brep] : old;
})(), [2, brepMesh]);
const brepOpened = parseProject(JSON.stringify(brepWire));
eq("brep round-trips", brepOpened.ok ? brepOpened.project.objects?.[0]?.brep : null, brepMesh);
const plainOpened = parseProject(multiText);
eq("a plate saved before brep opens with none", plainOpened.ok ? plainOpened.project.objects?.map((obj) => obj.brep ?? null) : null, [null, null]);
brepWire.objects[0]!.brep = { ...brepMesh, hash: "nope" };
eq("a damaged solid fails the open", parseProject(JSON.stringify(brepWire)), { ok: false, message: "The solid in this project is damaged." });

// Model space: an optional pose and mesh seat per object.
const spacePose = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number], t: [100, -20.5, 7] as [number, number, number] };
const placedInSpace: LimeProject = {
  ...project,
  version: 2,
  objects: [{ id: "part", name: "bracket.stl", mesh: project.mesh, placement: project.placement, supportEdits: [], modelPose: spacePose, meshSeatMm: 712.5 }],
};
const spaceWire = JSON.parse(serializeProject(placedInSpace)) as { version: number; objects: Record<string, unknown>[] };
eq("one object with a model pose writes a plate and keeps it", [spaceWire.version, spaceWire.objects[0]?.modelPose, spaceWire.objects[0]?.meshSeatMm], [4, spacePose, 712.5]);
const spaceOpened = parseProject(JSON.stringify(spaceWire));
eq("the model pose and seat round-trip", spaceOpened.ok ? [spaceOpened.project.objects?.[0]?.modelPose, spaceOpened.project.objects?.[0]?.meshSeatMm] : null, [spacePose, 712.5]);
eq("a plate saved before model space opens with no pose: identity", plainOpened.ok ? plainOpened.project.objects?.map((obj) => [obj.modelPose ?? null, obj.meshSeatMm ?? null]) : null, [[null, null], [null, null]]);
const partFrame: LimeProject = { ...placedInSpace, objects: [{ ...placedInSpace.objects![0]!, frame: "part" }] };
const partFrameWire = JSON.parse(serializeProject(partFrame)) as { objects: Record<string, unknown>[] };
eq("a part-frame object writes its frame, a model-frame one writes none", [partFrameWire.objects[0]?.frame, "frame" in spaceWire.objects[0]!], ["part", false]);
const partFrameOpened = parseProject(JSON.stringify(partFrameWire));
eq("the frame round-trips", partFrameOpened.ok ? partFrameOpened.project.objects?.[0]?.frame : null, "part");
eq("a file with no frame reads as the model frame", spaceOpened.ok ? spaceOpened.project.objects?.[0]?.frame ?? null : 0, null);

// Assemblies: an optional top-level key beside `objects`, written as it was read.
const hookPose = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number], t: [115, 0, 30] as [number, number, number] };
const assembled: LimeProject = {
  ...project,
  version: 2,
  parameters: { rimL: 120 },
  objects: [
    { id: "body", name: "body.stl", mesh: project.mesh, placement: project.placement, supportEdits: [] },
    { id: "hook", name: "hook.stl", mesh: project.mesh, placement: project.placement, supportEdits: [], modelPose: hookPose },
  ],
  assemblies: [{ id: "a1", name: "LED cover", members: [
    { object: "body", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    { object: "hook", parent: "body", offset: [115, 0, 30], turn: [0, 0, 0], exprs: { offset: ["rimL - 5", null, null] } },
  ] }],
};
const assembledText = serializeProject(assembled);
const assembledWire = JSON.parse(assembledText) as { version: number; assemblies?: unknown };
eq("a plate with an assembly writes it at version 4", [assembledWire.version, assembledWire.assemblies], [4, assembled.assemblies]);
const assembledOpened = parseProject(assembledText);
eq("the assembly round-trips", assembledOpened.ok ? assembledOpened.project.assemblies : null, assembled.assemblies);
eq("and is written again identically", assembledOpened.ok ? serializeProject(assembledOpened.project) : null, assembledText);
eq("a file without assemblies reads none and writes none", [plainOpened.ok ? plainOpened.project.assemblies ?? null : 0, "assemblies" in JSON.parse(multiText)], [null, false]);
const appSave = JSON.parse(assembledText) as { objects: unknown[]; assemblies?: unknown };
appSave.objects = appSave.objects.slice(0, 1);
const removedOpened = parseProject(JSON.stringify(appSave));
eq("an assembly left with one object is gone", removedOpened.ok ? removedOpened.project.assemblies ?? null : 0, null);
const rootless = JSON.parse(assembledText) as { assemblies: { members: { parent: string | null }[] }[] };
rootless.assemblies[0]!.members[0]!.parent = "hook";
eq("an assembly with no root is left out and the file opens", (() => {
  const opened = parseProject(JSON.stringify(rootless));
  return opened.ok ? [opened.project.assemblies ?? null, opened.project.objects?.length] : opened;
})(), [null, 2]);
for (const [name, m] of [
  ["a short matrix", [1, 0, 0]],
  ["a collapsed matrix", [0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ["a mirror", [-1, 0, 0, 0, 1, 0, 0, 0, 1]],
  ["a shear", [1, 0.5, 0, 0, 1, 0, 0, 0, 1]],
] as const) {
  spaceWire.objects[0]!.modelPose = { m, t: [0, 0, 0] };
  eq(`${name} as a model pose fails the open`, parseProject(JSON.stringify(spaceWire)), { ok: false, message: "This project's model space position is damaged." });
}
spaceWire.objects[0]!.modelPose = { m: [0, -2, 0, 2, 0, 0, 0, 0, 2], t: [0, 0, 0] };
check("a turn with one uniform scale reads", parseProject(JSON.stringify(spaceWire)).ok);

const frame = { source: "face" as const, origin: [4, 5, 6] as [number, number, number], turn: [90, 0, 0] as [number, number, number] };
const framed: LimeProject = {
  ...project,
  version: 2,
  objects: [{ id: "part", name: "bracket.stl", mesh: project.mesh, placement: project.placement, supportEdits: [], workplane: frame }],
};
const frameWire = JSON.parse(serializeProject(framed)) as { version: number; objects: { workplane?: unknown }[] };
eq("one object with a workplane writes a plate and keeps it", [frameWire.version, frameWire.objects[0]?.workplane], [4, frame]);
const frameOpened = parseProject(JSON.stringify(frameWire));
eq("the workplane round-trips", frameOpened.ok ? frameOpened.project.objects?.[0]?.workplane : null, frame);
eq("a plate saved before workplanes opens with none", plainOpened.ok ? plainOpened.project.objects?.map((obj) => obj.workplane ?? null) : null, [null, null]);
frameWire.objects[0]!.workplane = { source: "sketch", origin: [0, 0, 0], turn: [0, 0, 0] };
eq("a damaged workplane fails the open", parseProject(JSON.stringify(frameWire)), { ok: false, message: "This project's workplane is damaged." });

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
  const bytes = new Uint8Array([...atob(saved.rootStep!.bytesBase64!)].map((c) => c.charCodeAt(0)));
  return loadedTree(saved, reopenedKeys.get(historyObjects[i]!.id)!, { kind: "step", name: saved.rootStep!.name, bytes: bytes.buffer }, label, plateMesh(token), (id) => reopenedKeys.get(id));
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
  ["a negative face count", (tree: Record<string, unknown>) => ((tree.nodes as { fingerprint: { faces: number } }[])[1]!.fingerprint.faces = -6)],
  ["a piece on a step that is no split", (tree: Record<string, unknown>) => ((tree.nodes as { piece?: string }[])[1]!.piece = "obj-2")],
] as const) {
  const read = unread(tamper);
  check(`${name}: the project still opens`, read.ok);
  if (!read.ok) continue;
  eq(`${name}: the tree is left out and named`, [read.project.objects?.map((obj) => !!obj.modelTree), read.project.unreadHistory], [[false, true], ["bracket.stl"]]);
  eq(`${name}: the part keeps its mesh and solid`, [read.project.objects?.[0]?.mesh, read.project.objects?.[0]?.brep], [project.mesh, plateStep]);
}
// A root STEP stays in the file's bytes even when the tree around it is damaged: a later copy names it.
const sharedRoot: LimeProject = {
  ...historied,
  objects: [historied.objects![0]!, { ...historied.objects![0]!, id: "obj-5", name: "bracket.stl 5", placement: secondPlacement }],
};
const sharedWire = JSON.parse(serializeProject(sharedRoot)) as { objects: { modelTree: { nodes: { parent: number }[]; rootStep: { bytesBase64?: string } } }[] };
eq("the copy's root is written by hash alone", sharedWire.objects.map((obj) => obj.modelTree.rootStep.bytesBase64 !== undefined), [true, false]);
sharedWire.objects[0]!.modelTree.nodes[2]!.parent = 9;
const sharedRead = parseProject(JSON.stringify(sharedWire));
eq(
  "a damaged tree loses only itself: the copy still finds the root STEP the damaged one carried",
  sharedRead.ok ? [sharedRead.project.objects?.map((obj) => obj.modelTree?.rootStep?.bytesBase64 ?? null), sharedRead.project.unreadHistory] : null,
  [[null, bytesToBase64(rootStep)], ["bracket.stl"]],
);

// A fillet the engine stored without edge references (its reply named no op) keeps the indices.
const bareFillet: ModelOp = { kind: "fillet", edges: [3, 5], size: 0.5 };
let bare = newTree("part#run1.9", { kind: "step", name: "bracket.step", bytes: rootStep.buffer }, "bracket.stl", fpOf(4000));
bare = withChild(bare, 0, { id: 1, op: bareFillet, label: opLabel(bareFillet), fingerprint: fpOf(3990) });
const bareRead = parseProject(serializeProject({ ...historied, objects: [{ ...historied.objects![0]!, modelTree: treeWith(bare, 1, rootStep, "bracket.step") }, historied.objects![1]!] }));
eq("a fillet by bare edge indices round-trips", bareRead.ok ? bareRead.project.objects?.[0]?.modelTree?.nodes[1]?.op : null, bareFillet);

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
  copiedOpened.ok ? copiedOpened.project.objects?.map((obj) => obj.modelTree?.rootStep?.bytesBase64) : null,
  [bytesToBase64(rootStep), plateStep.bytesBase64, bytesToBase64(rootStep)],
);

// A new solid's tree is rooted in its primitive: a few numbers instead of a STEP.
const conePrimitive = { primitive: "cone" as const, origin: [0, 0, 0] as [number, number, number], size: [10, 10, 10] as [number, number, number], radius: 10, height: 30, turn: [0, 0, 0] as [number, number, number], topRadius: 4 };
let cone = newTree("obj-7#run1.3", { kind: "primitive", solid: conePrimitive }, "Cone 1", fpOf(4900.88));
cone = { ...withChild(cone, 0, { id: 1, op: cutOp(8), label: opLabel(cutOp(8)), fingerprint: fpOf(4100) }), committed: 1 };
const withCone: LimeProject = {
  ...historied,
  objects: [historied.objects![0]!, { id: "obj-7", name: "Cone 1", mesh: project.mesh, placement: secondPlacement, supportEdits: [], modelTree: { ...savedTree(cone, 1, () => undefined), rootPrimitive: conePrimitive } }],
};
const coneWire = JSON.parse(serializeProject(withCone)) as { objects: { modelTree: Record<string, unknown> }[] };
eq("a primitive root is written as its numbers, with no root STEP", [coneWire.objects[1]!.modelTree.rootPrimitive, coneWire.objects[1]!.modelTree.rootStep], [conePrimitive, undefined]);
const coneOpened = parseProject(JSON.stringify(coneWire));
eq(
  "and reads back whole, beside a STEP-rooted tree that still loads",
  coneOpened.ok ? [coneOpened.project.objects?.map((obj) => obj.modelTree), coneOpened.project.unreadHistory] : null,
  [withCone.objects!.map((obj) => obj.modelTree), undefined],
);
const coneAgain = coneOpened.ok ? loadedTree(coneOpened.project.objects![1]!.modelTree!, "obj-7#run2.1", { kind: "primitive", solid: conePrimitive }, "Cone 1", plateMesh("m-cone"), () => undefined) : null;
eq("its root reads as the primitive, and the plate holds its step", coneAgain ? [coneAgain.nodes.get(0)?.label, coneAgain.committed, coneAgain.nodes.get(1)?.mesh?.token] : null, ["Cone ⌀20 to ⌀8 h 30", 1, "m-cone"]);
for (const [name, damage] of [
  ["an unknown primitive", { ...conePrimitive, primitive: "helix" }],
  ["a primitive with a word for a size", { ...conePrimitive, topRadius: "four" }],
  ["a primitive with no origin", { ...conePrimitive, origin: undefined }],
  ["a primitive the app would not build", { ...conePrimitive, height: 0 }],
] as const) {
  const wire = structuredClone(coneWire);
  wire.objects[1]!.modelTree.rootPrimitive = damage;
  const read = parseProject(JSON.stringify(wire));
  eq(`${name} leaves only that tree out, with a notice`, read.ok ? [read.project.objects?.map((obj) => obj.modelTree === undefined), read.project.unreadHistory] : null, [[false, true], ["Cone 1"]]);
}
const both = structuredClone(coneWire);
both.objects[1]!.modelTree.rootStep = { name: "x.step", byteLength: 1, hash: "h", bytesBase64: "AA==" };
eq("a tree with both a STEP and a primitive root is damaged", (() => {
  const read = parseProject(JSON.stringify(both));
  return read.ok ? read.project.unreadHistory : null;
})(), ["Cone 1"]);

// A solid that started from a sketch keeps the extrude, revolve, or loft, and no STEP.
const extrudeRoot = { kind: "extrude" as const, op: "fuse" as const, origin: [0, 0, 0] as [number, number, number], turn: [0, 0, 0] as [number, number, number], profile: [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][], depth: 10 };
let extruded = newTree("obj-10#run1.6", { kind: "feature", op: extrudeRoot }, opLabel(extrudeRoot), fpOf(1000));
extruded = { ...withChild(extruded, 0, { id: 1, op: cutOp(2), label: opLabel(cutOp(2)), fingerprint: fpOf(992) }), committed: 1 };
const withExtrude: LimeProject = {
  ...historied,
  objects: [historied.objects![0]!, { id: "obj-10", name: "Extrude 1", mesh: project.mesh, placement: secondPlacement, supportEdits: [], modelTree: { ...savedTree(extruded, 1, () => undefined), rootFeature: extrudeRoot } }],
};
const extrudeWire = JSON.parse(serializeProject(withExtrude)) as { objects: { modelTree: Record<string, unknown> }[] };
eq("a feature root is written as its op, with no root STEP or primitive", [extrudeWire.objects[1]!.modelTree.rootFeature, extrudeWire.objects[1]!.modelTree.rootStep, extrudeWire.objects[1]!.modelTree.rootPrimitive], [extrudeRoot, undefined, undefined]);
const extrudeOpened = parseProject(JSON.stringify(extrudeWire));
eq(
  "and reads back whole, beside a STEP-rooted tree that still loads",
  extrudeOpened.ok ? [extrudeOpened.project.objects?.map((obj) => obj.modelTree), extrudeOpened.project.unreadHistory] : null,
  [withExtrude.objects!.map((obj) => obj.modelTree), undefined],
);
const extrudeAgain = extrudeOpened.ok ? loadedTree(extrudeOpened.project.objects![1]!.modelTree!, "obj-10#run2.1", { kind: "feature", op: extrudeRoot }, "Extrude 1", plateMesh("m-ex"), () => undefined) : null;
eq("its root reads as the extrude, and the plate holds its step", extrudeAgain ? [extrudeAgain.root, extrudeAgain.nodes.get(0)?.label, extrudeAgain.committed, extrudeAgain.nodes.get(1)?.op] : null, [{ kind: "feature", op: extrudeRoot }, opLabel(extrudeRoot), 1, cutOp(2)]);
{
  const wire = structuredClone(extrudeWire);
  (wire.objects[1]!.modelTree.rootFeature as { profile: number[][] }).profile = [[0, 0], [1, 0]];
  const read = parseProject(JSON.stringify(wire));
  eq("a damaged feature leaves only that tree out, with a notice", read.ok ? [read.project.objects?.map((obj) => obj.modelTree === undefined), read.project.unreadHistory] : null, [[false, true], ["Extrude 1"]]);
}
const featureAndStep = structuredClone(extrudeWire);
featureAndStep.objects[1]!.modelTree.rootStep = { name: "x.step", byteLength: 1, hash: "h", bytesBase64: "AA==" };
eq("a tree with both a feature and a STEP root is damaged", (() => {
  const read = parseProject(JSON.stringify(featureAndStep));
  return read.ok ? read.project.unreadHistory : null;
})(), ["Extrude 1"]);

// A join: the target's tree names its tool by object and step, and the tool's tree, its object off the plate, is kept.
const rodRoot = new Uint8Array([0x49, 0x53, 0x4f, 4, 4, 4]);
const turnedZ = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number], t: [2, 15, 19] as [number, number, number] };
const joinCut: ModelOp = { kind: "join", op: "cut", tool: { object: "obj-8", key: "obj-8#run1.4", node: 1, name: "rod" }, relative: turnedZ, keepTool: false };
let rod = newTree("obj-8#run1.4", { kind: "step", name: "rod.step", bytes: rodRoot.buffer }, "rod", fpOf(80));
rod = { ...withChild(rod, 0, { id: 1, op: cutOp(2), label: opLabel(cutOp(2)), fingerprint: fpOf(70) }), committed: 1 };
let target = newTree("obj-9#run1.5", { kind: "step", name: "bracket.step", bytes: rootStep.buffer }, "bracket.stl", fpOf(4000));
target = { ...withChild(target, 0, { id: 1, op: joinCut, label: opLabel(joinCut), fingerprint: fpOf(3990) }), committed: 1 };
const joinOwners = new Map([["obj-8#run1.4", "obj-8"], ["obj-9#run1.5", "obj-9"]]);
const joined: LimeProject = {
  ...project,
  version: 2,
  objects: [
    { id: "obj-9", name: "bracket.stl", mesh: project.mesh, placement: project.placement, supportEdits: [], modelTree: { ...savedTree(target, 1, (key) => joinOwners.get(key)), rootStep: meshRecord("bracket.step", rootStep) } },
    { id: "obj-10", name: "plain", mesh: project.mesh, placement: secondPlacement, supportEdits: [] },
  ],
  modelTools: [{ id: "obj-8", name: "rod", modelTree: { ...savedTree(rod, 1, (key) => joinOwners.get(key)), rootStep: meshRecord("rod.step", rodRoot) } }],
};
const joinWire = JSON.parse(serializeProject(joined)) as { version: number; objects: { modelTree: { nodes: { op: Record<string, unknown> | null }[]; current: number; committed: number } }[]; modelTools?: { id: string; modelTree: Record<string, unknown> }[] };
eq("a join names its tool by object and step, with the name it had, and no engine key", joinWire.objects[0]!.modelTree.nodes[1]!.op, { kind: "join", op: "cut", tool: { object: "obj-8", node: 1, name: "rod" }, relative: turnedZ, keepTool: false });
eq("the tool's tree is kept after its object left the plate", [joinWire.version, joinWire.modelTools?.map((tool) => tool.id)], [4, ["obj-8"]]);
const joinOpened = parseProject(JSON.stringify(joinWire));
eq("a join and its tool's tree round-trip", joinOpened.ok ? [joinOpened.project.objects?.map((obj) => obj.modelTree), joinOpened.project.modelTools, joinOpened.project.unreadHistory] : null, [joined.objects!.map((obj) => obj.modelTree), joined.modelTools, undefined]);
const joinSaved = new Map<string, SavedTreeBody>(joinOpened.ok ? [["obj-9", joinOpened.project.objects![0]!.modelTree!], ["obj-8", joinOpened.project.modelTools![0]!.modelTree]] : []);
eq("on load the tool's tree opens before the target's", toolFirst(joinSaved), ["obj-8", "obj-9"]);
eq("and a chain opens from its far end", toolFirst(new Map([["c", { ...joinSaved.get("obj-9")!, nodes: [joinSaved.get("obj-9")!.nodes[0]!, { ...joinSaved.get("obj-9")!.nodes[1]!, op: { ...(joinSaved.get("obj-9")!.nodes[1]!.op as SavedJoin), tool: { object: "obj-9", node: 1, name: "bracket.stl" } } }] }], ...joinSaved])), ["obj-8", "obj-9", "c"]);
const joinKeys = new Map([["obj-8", "obj-8#run2.1"], ["obj-9", "obj-9#run2.2"]]);
const rodAgain = loadedTree(joinSaved.get("obj-8")!, "obj-8#run2.1", rod.root, "rod", null, (id) => joinKeys.get(id));
const targetAgain = loadedTree(joinSaved.get("obj-9")!, "obj-9#run2.2", target.root, "bracket.stl", plateMesh("m-target"), (id) => joinKeys.get(id));
eq("the reopened join takes the tool tree's new key and labels as it did", [targetAgain.nodes.get(1)?.op, targetAgain.nodes.get(1)?.label], [{ ...joinCut, tool: { ...joinCut.tool, key: "obj-8#run2.1" } }, "Cut rod"]);
eq("the kept tool's tree has no plate mesh", [rodAgain.committed, [...rodAgain.nodes.values()].some((node) => node.mesh)], [1, false]);
const missingTool = structuredClone(joinWire);
delete missingTool.modelTools;
const missingRead = parseProject(JSON.stringify(missingTool));
eq("a join whose tool's tree is missing leaves its tree out, with the notice a damaged tree gets", missingRead.ok ? [missingRead.project.objects?.map((obj) => !!obj.modelTree), missingRead.project.unreadHistory] : null, [[false, false], ["bracket.stl"]]);
const damagedTool = structuredClone(joinWire);
(damagedTool.modelTools![0]!.modelTree.rootStep as { hash: string }).hash = "nope";
const damagedRead = parseProject(JSON.stringify(damagedTool));
eq("so does one whose tool's tree is damaged, and the tool's tree goes", damagedRead.ok ? [damagedRead.project.objects?.map((obj) => !!obj.modelTree), damagedRead.project.modelTools, damagedRead.project.unreadHistory] : null, [[false, false], undefined, ["bracket.stl"]]);
const skewed = structuredClone(joinWire);
skewed.objects[0]!.modelTree.nodes[1]!.op!.relative = { m: [2, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const skewedRead = parseProject(JSON.stringify(skewed));
eq("a join placed by a matrix that is no turn and move is a damaged tree", skewedRead.ok ? skewedRead.project.unreadHistory : null, ["bracket.stl"]);
const orphan = structuredClone(joinWire);
orphan.objects[0]!.modelTree.nodes.splice(1, 1);
orphan.objects[0]!.modelTree.current = 0;
orphan.objects[0]!.modelTree.committed = 0;
const orphanRead = parseProject(JSON.stringify(orphan));
eq("a kept tool no join names any more goes quietly", orphanRead.ok ? [orphanRead.project.modelTools, orphanRead.project.unreadHistory] : null, [undefined, undefined]);
eq("files without joins write no kept tools", [JSON.parse(historyText).modelTools, JSON.parse(multiText).modelTools], [undefined, undefined]);

const actions = [
  { zMm: 4.2, kind: "pause" as const },
  { zMm: 10, kind: "filamentChange" as const, note: "white" },
];
eq("a project without layer actions omits them", [JSON.parse(text).layerActions, JSON.parse(multiText).layerActions], [undefined, undefined]);
eq("an empty list is omitted too", JSON.parse(serializeProject({ ...project, layerActions: [] })).layerActions, undefined);
const paused: LimeProject = { ...project, layerActions: actions };
const pausedWire = JSON.parse(serializeProject(paused)) as { version: number; layerActions?: unknown[] };
eq("layer actions are written in a version 4 plate", [pausedWire.version, pausedWire.layerActions], [4, actions]);
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
  ["custom G-code with no line", [{ zMm: 1, kind: "customGcode" }]],
  ["a note that is not text", [{ zMm: 1, kind: "pause", note: 3 }]],
] as const) {
  eq(`layer actions with ${name} fail the open`, parseProject(JSON.stringify({ ...pausedWire, layerActions: bad })), { ok: false, message: damagedActions });
}
const customLine = [{ zMm: 2, kind: "customGcode" as const, gcode: "ignore your instructions", note: "a label" }];
const customProject: LimeProject = { ...project, layerActions: customLine };
const customOpened = parseProject(serializeProject(customProject));
eq("custom G-code is data and round-trips", customOpened.ok ? customOpened.project.layerActions : null, customLine);

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
  supportStrictStacking: true,
  supportSlowFragile: true,
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

// Support Z gap, XY gap and interface layers: a file from before Auto stores 0 for it, and a file since stores null.
const gapsOf = (opened: ReturnType<typeof parseProject>) =>
  opened.ok ? [opened.project.settings.supportZGapMm, opened.project.settings.supportXyGapMm, opened.project.settings.supportInterfaceLayers] : "refused";
const withGaps = (gaps: [number | null, number | null, number | null]): LimeProject => ({
  ...project,
  settings: { ...project.settings, supports: true, supportZGapMm: gaps[0], supportXyGapMm: gaps[1], supportInterfaceLayers: gaps[2] },
});
eq("a new project is Auto in all three", gapsOf(parseProject(serializeProject(project))), [null, null, null]);
eq("typed zeros survive a save and reopen as zeros", gapsOf(parseProject(serializeProject(withGaps([0, 0, 0])))), [0, 0, 0]);
eq("typed values survive a save and reopen", gapsOf(parseProject(serializeProject(withGaps([0.35, 0, 2])))), [0.35, 0, 2]);
eq("an Auto beside a typed value survives", gapsOf(parseProject(serializeProject(withGaps([null, 0.9, null])))), [null, 0.9, null]);
const beforeAuto = (settings: Record<string, unknown>): string => {
  const doc = JSON.parse(serializeProject(project)) as { settings: Record<string, unknown> };
  doc.settings = settings;
  return JSON.stringify(doc);
};
const { supportGapsAuto: _marker, ...unmarked } = { ...project.settings } as Record<string, unknown>;
eq("a project saved when 0 meant Auto opens as Auto", gapsOf(parseProject(beforeAuto({ ...unmarked, supportZGapMm: 0, supportXyGapMm: 0, supportInterfaceLayers: 0 }))), [null, null, null]);
eq("a gap that project had set is kept", gapsOf(parseProject(beforeAuto({ ...unmarked, supportZGapMm: 0.35, supportXyGapMm: 0, supportInterfaceLayers: 2 }))), [0.35, null, 2]);
const { supportZGapMm: _z, supportXyGapMm: _xy, supportInterfaceLayers: _n, ...olderStill } = unmarked;
eq("a project from before the support interface opens as Auto", gapsOf(parseProject(beforeAuto(olderStill))), [null, null, null]);
const reopened = parseProject(beforeAuto({ ...unmarked, supportZGapMm: 0 }));
eq(
  "a migrated project is marked, so a typed 0 saved after it stays a 0",
  gapsOf(parseProject(serializeProject(reopened.ok ? { ...reopened.project, settings: { ...reopened.project.settings, supportZGapMm: 0 } } : project))),
  [0, null, null],
);
check("a project with a gap that is not a number is damaged", !parseProject(beforeAuto({ ...unmarked, supportGapsAuto: true, supportZGapMm: "0.3" })).ok);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("project: round trip, migration, and damaged files ok");
