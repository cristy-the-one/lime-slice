import { DEFAULT_PRESET } from "../presets.ts";
import {
  deleteIn,
  displayId,
  duplicateIn,
  emptyLibrary,
  importInto,
  parseLibrary,
  parseSettingsProfile,
  profileFileName,
  renameIn,
  saveInto,
  serializeLibrary,
  serializeSettingsProfile,
  type ProfileLibrary,
} from "./settings-profiles.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const thick = { ...DEFAULT_PRESET, layerHeight: 0.28 };
let library: ProfileLibrary = emptyLibrary();
const saved = saveInto(library, "Thick", thick, "expert", "a");
check("save names a profile", typeof saved !== "string" && saved.profiles.length === 1 && saved.activeId === "a");
library = saved as ProfileLibrary;
const again = saveInto(library, "Thick", { ...thick, layerHeight: 0.3 }, "simple", "b");
check("save overwrites the same name", typeof again !== "string" && again.profiles.length === 1 && again.profiles[0]?.settings.layerHeight === 0.3 && again.profiles[0]?.level === "simple" && again.activeId === "a");
library = again as ProfileLibrary;
check("a blank name is refused", saveInto(library, "  ", thick, "expert", "c") === "Name the profile first.");

const renamed = renameIn(library, "a", "Bench");
check("rename keeps the id", typeof renamed !== "string" && renamed.profiles[0]?.name === "Bench" && renamed.profiles[0]?.id === "a");
library = renamed as ProfileLibrary;
check("rename keeps its own name", typeof renameIn(library, "a", "Bench") !== "string");
const other = saveInto(library, "Other", DEFAULT_PRESET, "expert", "b");
library = other as ProfileLibrary;
check("rename refuses another profile's name", renameIn(library, "b", "Bench") === "A profile named Bench already exists.");

const copied = duplicateIn(library, "a", "c");
check("duplicate adds a copy", typeof copied !== "string" && copied.profiles.length === 3 && copied.activeId === "c");
library = copied as ProfileLibrary;
const copy = library.profiles.find((profile) => profile.id === "c");
check("duplicate names the copy", copy?.name === "Bench copy" && copy.level === "simple" && copy.settings.layerHeight === 0.3);
const copiedAgain = duplicateIn(library, "a", "d");
check("a second copy is numbered", typeof copiedAgain !== "string" && copiedAgain.profiles.some((profile) => profile.name === "Bench copy 2"));

const removed = deleteIn(library, "c");
check("delete drops the active profile", removed.profiles.every((profile) => profile.id !== "c") && removed.activeId == null);
check("delete leaves the others", removed.profiles.length === 2);

const shown = displayId(removed, { ...thick, layerHeight: 0.3 }, "simple");
check("display matches the saved profile", shown === "a");
check("a drifted setting matches nothing", displayId(removed, thick, "simple") === "");

const file = parseSettingsProfile(serializeSettingsProfile({ version: 1, name: "Imported", settings: DEFAULT_PRESET, level: "advanced" }));
check("a profile file round-trips", file.ok && file.profile.name === "Imported" && file.profile.level === "advanced");
const imported = file.ok ? importInto(emptyLibrary(), file.profile, "z") : emptyLibrary();
check("import stores the file", imported.profiles[0]?.name === "Imported" && imported.activeId === "z");
const clash = importInto(imported, file.ok ? file.profile : { version: 1, name: "Imported", settings: DEFAULT_PRESET, level: "advanced" }, "y");
check("import keeps a unique name", clash.profiles.map((profile) => profile.name).join(",") === "Imported,Imported 2");

const rear = parseSettingsProfile(serializeSettingsProfile({ version: 1, name: "Rear", settings: { ...DEFAULT_PRESET, seam: "rear" }, level: "advanced" }));
check("a rear seam round-trips", rear.ok && rear.profile.settings.seam === "rear");
const { seam: _seam, ...beforeSeam } = DEFAULT_PRESET;
const older = parseSettingsProfile(JSON.stringify({ version: 1, name: "Older", settings: beforeSeam, level: "expert" }));
check("a profile from before the seam picker reads blend", older.ok && older.profile.settings.seam === "blend");
const olderLibrary = parseLibrary(JSON.stringify({ version: 1, activeId: "o", profiles: [{ id: "o", name: "Older", settings: beforeSeam, level: "expert" }] }));
check("a stored profile from before the seam picker stays", olderLibrary.profiles.length === 1 && olderLibrary.activeId === "o" && olderLibrary.profiles[0]?.settings.seam === "blend");
const { ironing: _ironing, ironingFlow: _flow, ironingSpeed: _speed, ironingSpacing: _spacing, ...beforeIron } = DEFAULT_PRESET;
const olderIron = parseSettingsProfile(JSON.stringify({ version: 1, name: "Before iron", settings: beforeIron, level: "advanced" }));
check("a profile from before ironing stays off", olderIron.ok && olderIron.profile.settings.ironing === false && olderIron.profile.settings.ironingFlow === 0.1 && olderIron.profile.settings.ironingSpeed === 20 && olderIron.profile.settings.ironingSpacing === 0.1);

const badJson = parseSettingsProfile("{");
check("bad json is refused", !badJson.ok && badJson.message === "This file is not a Lime Slice settings profile.");
const missingVersion = parseSettingsProfile("{}");
check("a missing version is refused", !missingVersion.ok && missingVersion.message === "This settings profile has no version, so it cannot be opened.");
const future = parseSettingsProfile(`{"version":9,"name":"X"}`);
check("a future version is refused", !future.ok && future.message.includes("version 9"));
const broken = { version: 1, name: "X", level: "expert", settings: { ...DEFAULT_PRESET, layerHeight: "tall" } };
const badSetting = parseSettingsProfile(JSON.stringify(broken));
check("a bad setting is refused", !badSetting.ok && badSetting.message === "This settings profile is incomplete.");
check("file name is the profile suffix", profileFileName("Bench speed") === "Bench_speed.limeprofile.json");

const stored = parseLibrary(serializeLibrary(removed));
check("the library round-trips", stored.profiles.length === 2 && stored.profiles[0]?.name === "Bench");
check("a corrupt library is empty", parseLibrary("nope").profiles.length === 0);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("settings-profiles: save, rename, duplicate, delete, and file ok");
