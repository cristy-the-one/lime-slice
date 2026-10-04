import { defaultProfile } from "./profiles.ts";
import { DEFAULT_PRESET } from "./presets.ts";
import {
  applyMigrations,
  bytesToBase64,
  meshRecord,
  parseProject,
  serializeProject,
  type LimeProject,
  type Migration,
} from "./project.ts";
import type { EditEntry } from "./support-edit-list.ts";

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

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("project: round trip, migration, and damaged files ok");
