import { fanDefaults, projectFan, restoreFan, snapFan, type FanSettings } from "./fan.ts";
import { defaultProfile } from "./profiles.ts";
import { DEFAULT_PRESET } from "./presets.ts";
import { meshRecord, parseProject, serializeProject, type LimeProject } from "./project.ts";
import {
  builtinLibrary,
  enginePrinter,
  fileFromSelection,
  parseLibrary,
  parseMachineFile,
  selectIn,
  selection,
  serializeLibrary,
  serializeMachineFile,
  setFan,
  setNozzleTemp,
  type MachineLibrary,
} from "./ui/machine-library.ts";
import { controlById, GROUPS, type Settings } from "./ui/settings-schema.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const fanOfRow = (row: FanSettings): FanSettings => {
  const out: FanSettings = { fanPercent: row.fanPercent, overhangFanPercent: row.overhangFanPercent, fanOffLayers: row.fanOffLayers };
  if (row.supportFanPercent !== undefined) out.supportFanPercent = row.supportFanPercent;
  return out;
};

const pick = (library: MachineLibrary, filamentId: string): MachineLibrary => {
  const next = selectIn(library, library.printerId, filamentId, library.nozzleMm);
  if (typeof next === "string") throw new Error(next);
  return next;
};

// Each built-in filament carries its fan, as it carries its temperature.
const library = builtinLibrary();
const byMaterial = Object.fromEntries(library.filaments.map((row) => [row.material, fanOfRow(row)]));
eq("PETG is IdeaFormer's Generic PETG, support following the fan", byMaterial.PETG, { fanPercent: 20, overhangFanPercent: 100, fanOffLayers: 3 });
eq("PLA is OrcaSlicer's generic PLA", byMaterial.PLA, { fanPercent: 100, overhangFanPercent: 100, fanOffLayers: 1 });
eq("ABS is OrcaSlicer's generic ABS", byMaterial.ABS, { fanPercent: 10, overhangFanPercent: 80, fanOffLayers: 3 });
eq("TPU is OrcaSlicer's generic TPU", byMaterial.TPU, { fanPercent: 100, overhangFanPercent: 100, fanOffLayers: 1 });
eq("a material the table does not name gets PLA's", fanDefaults("PEEK"), fanDefaults("PLA"));
eq("the material is matched without case", fanDefaults(" petg "), fanDefaults("PETG"));
eq("the factory profile is PLA's", fanOfRow(defaultProfile()), fanDefaults("PLA"));

// Choosing a filament sets the fan the slice sends, the way it sets the temperature.
const petg = pick(library, "lime-petg");
const sent = enginePrinter(selection(petg)!.printer, selection(petg)!.filament, 0.4);
eq("choosing PETG sends its fan and temperature", [sent.fanPercent, sent.overhangFanPercent, sent.fanOffLayers, sent.supportFanPercent, sent.nozzleTemp], [20, 100, 3, undefined, 240]);
eq("the request leaves a following support fan out", "supportFanPercent" in sent, false);

// A per-print change is kept on the active filament, exactly like a temperature change.
const edited = setFan(setNozzleTemp(petg, 235), { fanPercent: 30, overhangFanPercent: 90, fanOffLayers: 2, supportFanPercent: 10 });
const editedPetg = edited.filaments.find((row) => row.id === "lime-petg")!;
eq("the edit lands on the active filament with the temperature", [fanOfRow(editedPetg), editedPetg.nozzleTemp], [{ fanPercent: 30, overhangFanPercent: 90, fanOffLayers: 2, supportFanPercent: 10 }, 235]);
eq("other filaments keep theirs", fanOfRow(edited.filaments.find((row) => row.id === "lime-pla")!), fanDefaults("PLA"));
const away = pick(pick(edited, "lime-pla"), "lime-petg");
eq("switching away and back brings the edit back", fanOfRow(selection(away)!.filament), { fanPercent: 30, overhangFanPercent: 90, fanOffLayers: 2, supportFanPercent: 10 });
const following = setFan(edited, { fanPercent: 30, overhangFanPercent: 90, fanOffLayers: 2 });
eq("an emptied support fan follows again", "supportFanPercent" in selection(following)!.filament, false);

// Libraries and machine files from before fan settings read their material's fan.
const stored = JSON.parse(serializeLibrary(edited)) as { filaments: Record<string, unknown>[] };
for (const row of stored.filaments) {
  delete row.fanPercent;
  delete row.overhangFanPercent;
  delete row.fanOffLayers;
  delete row.supportFanPercent;
}
stored.filaments.push({ ...stored.filaments[2]!, id: "my-abs", name: "My ABS", builtin: false });
const legacy = parseLibrary(JSON.stringify(stored));
eq("a legacy PETG reads 20/100/3", fanOfRow(legacy.filaments.find((row) => row.id === "lime-petg")!), fanDefaults("PETG"));
eq("a legacy user ABS reads ABS's", fanOfRow(legacy.filaments.find((row) => row.id === "my-abs")!), fanDefaults("ABS"));
eq("a stored library keeps its fan", fanOfRow(parseLibrary(serializeLibrary(edited)).filaments.find((row) => row.id === "lime-petg")!), fanOfRow(editedPetg));
const file = JSON.parse(serializeMachineFile(fileFromSelection(edited)!)) as { filament: Record<string, unknown> };
eq("a machine file carries the fan", [file.filament.fanPercent, file.filament.supportFanPercent], [30, 10]);
delete file.filament.fanPercent;
const oldFile = parseMachineFile(JSON.stringify(file));
eq("a machine file without the fan reads its material's", oldFile.ok ? oldFile.file.filament.fanPercent : -1, 20);

// Projects: one that saved a fan keeps it, one from before takes the active filament's.
const project: LimeProject = {
  version: 1,
  mesh: meshRecord("part.stl", new Uint8Array([1, 2, 3])),
  placement: { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.1 },
  settings: { ...DEFAULT_PRESET },
  preset: null,
  profile: { ...defaultProfile(), fanPercent: 35, overhangFanPercent: 70, fanOffLayers: 2 },
  level: "advanced",
  supportEdits: [],
};
const petgFan = fanOfRow(selection(petg)!.filament);
const saved = parseProject(serializeProject(project));
eq("a saved fan opens as saved, support following", saved.ok ? projectFan(saved.project.profile, { ...petgFan, supportFanPercent: 5 }) : null, { fanPercent: 35, overhangFanPercent: 70, fanOffLayers: 2 });
const before = JSON.parse(serializeProject(project)) as { profile: Record<string, unknown> };
for (const key of ["fanPercent", "overhangFanPercent", "fanOffLayers", "supportFanPercent"]) delete before.profile[key];
const old = parseProject(JSON.stringify(before));
eq("a project from before opens", old.ok, true);
eq("and takes the active filament's fan", old.ok ? projectFan(old.project.profile, petgFan) : null, petgFan);

// Undo: a step keeps the fan, a following support fan included.
const now: FanSettings = { fanPercent: 40, overhangFanPercent: 100, fanOffLayers: 1, supportFanPercent: 15 };
eq("a step restores its fan", restoreFan(now, snapFan(petgFan)), petgFan);
eq("a step restores a support fan of its own", restoreFan(petgFan, snapFan(now)), now);
eq("a step from before fan settings leaves the fan", restoreFan(now, {}), now);

// The fields: whole percents and layers, and an empty Support fan % follows Fan %.
const state = { profile: { ...defaultProfile() }, overhangControl: true, supports: true } as unknown as Settings;
controlById("fanpct")!.set!(state, 22.6);
controlById("ovfanpct")!.set!(state, 140);
controlById("fanoff")!.set!(state, -2);
controlById("supfanpct")!.set!(state, 7);
eq("typed values are held to whole numbers in range", fanOfRow(state.profile), { fanPercent: 23, overhangFanPercent: 100, fanOffLayers: 0, supportFanPercent: 7 });
controlById("supfanpct")!.set!(state, "");
eq("an emptied Support fan % follows", [controlById("supfanpct")!.get!(state), controlById("supfanpct")!.placeholder!(state)], ["", "23"]);
eq("Cooling sits between Speed and Supports", GROUPS.map((group) => group.id).slice(5, 8), ["speed", "cooling", "supports"]);
eq("the overhang fan hides with overhang control, the support fan with supports", [controlById("ovfanpct")!.when!({ ...state, overhangControl: false }), controlById("supfanpct")!.when!({ ...state, supports: false })], [false, false]);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("fan: filament defaults, per-print edits, legacy files, projects, undo, and fields ok");
