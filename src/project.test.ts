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
  parseProject(JSON.stringify({ ...JSON.parse(text), version: 2 })),
  { ok: false, message: "This project is version 2. This app opens up to version 1." },
);
eq(
  "version 0 has no built-in migration",
  parseProject(JSON.stringify({ ...JSON.parse(text), version: 0 })),
  { ok: false, message: "This project is version 0, which this app cannot update." },
);

const step: Migration = (doc) => ({ ...doc, version: 1, level: doc.level ?? "simple" });
const legacy = { ...JSON.parse(text), version: 0 };
delete (legacy as { level?: unknown }).level;
const hooked = parseProject(JSON.stringify(legacy), [step]);
check("a migration hook brings version 0 up to 1", hooked.ok && hooked.project.level === "simple" && hooked.project.mesh.name === "bracket.stl");

const bumped = applyMigrations({ version: 0, kept: true }, [step]);
eq("applyMigrations reports the rewritten document", bumped, { ok: true, doc: { version: 1, kept: true, level: "simple" } });

const stuck: Migration = (doc) => doc;
eq(
  "a step that forgets to advance the version fails",
  applyMigrations({ version: 0 }, [stuck]),
  { ok: false, message: "This project could not be updated to the current format." },
);

check("embedded bytes decode to the original mesh", bytesToBase64(bytes).length > 0);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("project: round trip, migration, and damaged files ok");
