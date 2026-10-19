/**
 * Every built-in filament, and filaments brought in through a machine file the way an
 * OrcaSlicer or IdeaFormer profile is, on the IR3 V2 and on a cartesian printer.
 * The ask, the sent temperature, the fields, the readout, and M104/M109/M140/M190 agree.
 * A printer limit is the only thing that changes a number.
 */
import { withMachineGcode } from "./machine-gcode.ts";
import { settingMatches } from "./ui/settings-search.ts";
import { controlById, keywordsOf, type Settings } from "./ui/settings-schema.ts";
import {
  builtinLibrary,
  fieldHeat,
  filamentMatching,
  fileFromSelection,
  heatFor,
  heatReadout,
  heatWarnings,
  importInto,
  parseMachineFile,
  resolvedAsks,
  selectIn,
  selection,
  serializeMachineFile,
  setTemps,
  type MachineFile,
  type MachineLibrary,
} from "./ui/machine-library.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function importedFile(name: string, material: string, nozzle: number, bed: number, density: number): MachineFile {
  const base = fileFromSelection(builtinLibrary());
  if (!base) throw new Error("the built-in library has no selection");
  const parsed = parseMachineFile(serializeMachineFile({
    ...base,
    filament: { ...base.filament, name, material, nozzleTemp: nozzle, bedTemp: bed, densityGCm3: density },
  }));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.file;
}

let library = builtinLibrary();
const imported = [
  ["orca-petg", importedFile("Orca PETG", "PETG", 255, 70, 1.27)],
  ["idea-petg", importedFile("IdeaFormer PETG", "PETG", 240, 80, 1.27)],
  ["orca-abs", importedFile("Orca ABS", "ABS", 260, 100, 1.04)],
  ["orca-pc", importedFile("Orca PC", "PC", 310, 110, 1.2)],
] as const;
for (const [id, file] of imported) {
  library = importInto(library, file, `${id}-printer`, id);
}
eq("an imported file keeps its own temperatures", selection(selectIn(library, "lime-220", "orca-petg", 0.4) as MachineLibrary)?.filament.nozzleTemp, 255);

interface Row {
  name: string;
  printerId: string;
  filamentId: string;
  /** Left out, the profile carries the filament's own ask, as a fresh selection does. */
  profileNozzle?: number;
  profileBed?: number;
  askN: number;
  askB: number;
  sentN: number;
  sentB: number;
}

const rows: Row[] = [
  { name: "IR3 PLA", printerId: "ideaformer-ir3-v2", filamentId: "lime-pla", askN: 200, askB: 60, sentN: 200, sentB: 60 },
  { name: "IR3 PETG", printerId: "ideaformer-ir3-v2", filamentId: "lime-petg", askN: 240, askB: 80, sentN: 240, sentB: 80 },
  { name: "IR3 ABS", printerId: "ideaformer-ir3-v2", filamentId: "lime-abs", askN: 250, askB: 100, sentN: 250, sentB: 90 },
  { name: "IR3 TPU", printerId: "ideaformer-ir3-v2", filamentId: "lime-tpu", askN: 230, askB: 40, sentN: 230, sentB: 40 },
  { name: "Lime 220 PLA", printerId: "lime-220", filamentId: "lime-pla", askN: 200, askB: 60, sentN: 200, sentB: 60 },
  { name: "Lime 220 PETG", printerId: "lime-220", filamentId: "lime-petg", askN: 240, askB: 80, sentN: 240, sentB: 80 },
  { name: "Lime 220 ABS", printerId: "lime-220", filamentId: "lime-abs", askN: 250, askB: 100, sentN: 250, sentB: 100 },
  { name: "Lime 220 TPU", printerId: "lime-220", filamentId: "lime-tpu", askN: 230, askB: 40, sentN: 230, sentB: 40 },
  { name: "IR3 Orca PETG", printerId: "ideaformer-ir3-v2", filamentId: "orca-petg", askN: 255, askB: 70, sentN: 255, sentB: 70 },
  { name: "Lime 220 Orca PETG", printerId: "lime-220", filamentId: "orca-petg", askN: 255, askB: 70, sentN: 255, sentB: 70 },
  { name: "IR3 IdeaFormer PETG", printerId: "ideaformer-ir3-v2", filamentId: "idea-petg", askN: 240, askB: 80, sentN: 240, sentB: 80 },
  { name: "Lime 220 IdeaFormer PETG", printerId: "lime-220", filamentId: "idea-petg", askN: 240, askB: 80, sentN: 240, sentB: 80 },
  { name: "IR3 Orca ABS", printerId: "ideaformer-ir3-v2", filamentId: "orca-abs", askN: 260, askB: 100, sentN: 260, sentB: 90 },
  { name: "Lime 220 Orca ABS", printerId: "lime-220", filamentId: "orca-abs", askN: 260, askB: 100, sentN: 260, sentB: 100 },
  { name: "IR3 Orca PC", printerId: "ideaformer-ir3-v2", filamentId: "orca-pc", askN: 310, askB: 110, sentN: 300, sentB: 90 },
  { name: "Lime 220 Orca PC", printerId: "lime-220", filamentId: "orca-pc", askN: 310, askB: 110, sentN: 300, sentB: 110 },
  // A profile left on the PLA defaults while PETG is selected used to slice at 200/60.
  { name: "IR3 PETG stale profile", printerId: "ideaformer-ir3-v2", filamentId: "lime-petg", profileNozzle: 200, profileBed: 60, askN: 240, askB: 80, sentN: 240, sentB: 80 },
  // A saved project that already says 240/80, or a per-print edit, is kept.
  { name: "IR3 PETG saved project", printerId: "ideaformer-ir3-v2", filamentId: "lime-pla", profileNozzle: 240, profileBed: 80, askN: 240, askB: 80, sentN: 240, sentB: 80 },
  { name: "IR3 PETG custom edit", printerId: "ideaformer-ir3-v2", filamentId: "lime-petg", profileNozzle: 235, profileBed: 75, askN: 235, askB: 75, sentN: 235, sentB: 75 },
];

function engineFile(printerName: string, nozzle: number, bed: number): string {
  return [
    "; generated by Lime Slice — FDM strategy blender",
    `; printer: ${printerName}`,
    `M140 S${bed}`,
    `M104 S${nozzle}`,
    `M190 S${bed}`,
    `M109 S${nozzle}`,
    "G21",
    "G90",
    "M82",
    "G28",
    "G92 E0",
    "G1 X1",
    "M106 S0",
    "M104 S0",
    "M140 S0",
    "M84",
    "",
  ].join("\n");
}

function heatCommands(gcode: string): { code: string; temp: number }[] {
  const out: { code: string; temp: number }[] = [];
  for (const line of gcode.split("\n")) {
    const match = /^M(104|109|140|190) S(\d+(?:\.\d+)?)$/.exec(line);
    if (!match) continue;
    const temp = Number(match[2]);
    if (temp === 0) continue;
    out.push({ code: `M${match[1]}`, temp });
  }
  return out;
}

for (const row of rows) {
  const selected = selectIn(library, row.printerId, row.filamentId, 0.4);
  if (typeof selected === "string") {
    eq(`${row.name} selects`, selected, "");
    continue;
  }
  const picked = selection(selected);
  if (!picked) {
    eq(`${row.name} has a selection`, false, true);
    continue;
  }
  const profileNozzle = row.profileNozzle ?? picked.filament.nozzleTemp;
  const profileBed = row.profileBed ?? picked.filament.bedTemp;
  const asks = resolvedAsks(picked.filament, profileNozzle, profileBed);
  eq(`${row.name} ask`, asks, { nozzleTemp: row.askN, bedTemp: row.askB });
  const heat = heatFor(picked.printer, asks.nozzleTemp, asks.bedTemp);
  eq(`${row.name} sent`, { nozzle: heat.nozzleC, bed: heat.bedC }, { nozzle: row.sentN, bed: row.sentB });
  eq(`${row.name} fields`, fieldHeat(heat), { nozzleC: row.sentN, bedC: row.sentB });
  eq(`${row.name} readout`, heatReadout(heat), `Nozzle ${row.sentN} °C · bed ${row.sentB} °C`);
  const gcode = withMachineGcode(engineFile(picked.printer.name, row.sentN, row.sentB), picked.printer.startGcode, picked.printer.endGcode, {
    startOwnsHoming: picked.printer.startOwnsHoming,
    heat: { bedC: heat.bedC, nozzleC: heat.nozzleC },
    notes: [],
  });
  eq(`${row.name} placeholders`, gcode.includes("{bed}") || gcode.includes("{nozzle}"), false);
  const commands = heatCommands(gcode);
  const nozzleLines = commands.filter((line) => line.code === "M104" || line.code === "M109");
  const bedLines = commands.filter((line) => line.code === "M140" || line.code === "M190");
  eq(`${row.name} M104/M109`, nozzleLines.length > 0 && nozzleLines.every((line) => line.temp === row.sentN), true);
  eq(`${row.name} M140/M190`, bedLines.length > 0 && bedLines.every((line) => line.temp === row.sentB), true);
  if (row.askN !== row.sentN) eq(`${row.name} nozzle ask is not in the file`, gcode.includes(`S${row.askN}`), false);
  if (row.askB !== row.sentB) eq(`${row.name} bed ask is not in the file`, gcode.includes(`S${row.askB}`), false);
}

const absIr3 = selectIn(library, "ideaformer-ir3-v2", "lime-abs", 0.4) as MachineLibrary;
const absHeat = heatFor(selection(absIr3)!.printer, 250, 100);
eq("IR3 ABS says why the bed is held down", heatWarnings(absHeat, "ABS"), [
  "Bed set to 90 °C: ABS asks for 100 °C, but this printer's limit is 90 °C. Change the limit in Edit printer.",
]);
const pcIr3 = selectIn(library, "ideaformer-ir3-v2", "orca-pc", 0.4) as MachineLibrary;
const pcHeat = heatFor(selection(pcIr3)!.printer, 310, 110);
eq("IR3 PC names both limits", heatWarnings(pcHeat, "Orca PC"), [
  "Bed set to 90 °C: Orca PC asks for 110 °C, but this printer's limit is 90 °C. Change the limit in Edit printer.",
  "Nozzle set to 300 °C: Orca PC asks for 310 °C, but this printer's limit is 300 °C. Change the limit in Edit printer.",
]);
eq("a temperature inside the limits has no warning", heatWarnings(heatFor(selection(absIr3)!.printer, 240, 80), "PETG"), []);

const kept = setTemps(absIr3, 250, 100);
eq("saving the ask does not apply the printer limit", selection(kept)?.filament.bedTemp, 100);
eq("another filament is left alone", kept.filaments.find((filament) => filament.id === "lime-petg")?.nozzleTemp, 240);

eq("a PETG project matches PETG", filamentMatching(library, { nozzleTemp: 240, bedTemp: 80, filamentDensityGCm3: 1.27, filamentDiameter: 1.75 }), "lime-petg");
eq("a custom project matches no filament", filamentMatching(library, { nozzleTemp: 235, bedTemp: 75, filamentDensityGCm3: 1.27, filamentDiameter: 1.75 }), null);

const nozzle = controlById("nozzlec");
const bed = controlById("bedc");
eq("the fields are simple and scrub", !!nozzle && !!bed && nozzle.tier === "simple" && bed.tier === "simple" && nozzle.group === "temperature" && bed.group === "temperature" && nozzle.scrub === true && bed.scrub === true, true);
const draft = { profile: { nozzleTemp: 240, bedTemp: 80 } } as Settings;
nozzle!.set!(draft, 236);
bed!.set!(draft, 78);
eq("typing stores the ask", [draft.profile.nozzleTemp, draft.profile.bedTemp, nozzle!.get!(draft), bed!.get!(draft)], [236, 78, 236, 78]);
for (const word of ["temperature", "nozzle", "hotend"]) {
  eq(`search ${word}`, settingMatches(word, nozzle!.label.toLowerCase(), keywordsOf("nozzlec")), true);
}
eq("search bed", settingMatches("bed", bed!.label.toLowerCase(), keywordsOf("bedc")), true);
eq("search temperature on the bed", settingMatches("temperature", bed!.label.toLowerCase(), keywordsOf("bedc")), true);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("temperature: filaments, printers, fields, and G-code agree");
