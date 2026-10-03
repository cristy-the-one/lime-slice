import {
  advanceFor,
  builtinLibrary,
  deleteActive,
  duplicateActive,
  enginePrinter,
  ensureBuiltins,
  fileFromSelection,
  importInto,
  machineFileName,
  parseLibrary,
  parseMachineFile,
  saveActive,
  savePrinterName,
  selectIn,
  selection,
  serializeLibrary,
  serializeMachineFile,
  setAdvance,
  type MachineNumbers,
} from "./machine-library.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const library = builtinLibrary();
check("built-in printers", library.printers.map((printer) => printer.name).join(",") === "Lime 220,Lime 300,Lime 180");
check("built-in filaments", library.filaments.map((filament) => filament.material).join(",") === "PLA,PETG,ABS,TPU");

const pla = library.filaments.find((filament) => filament.id === "lime-pla");
const petg = library.filaments.find((filament) => filament.id === "lime-petg");
check("pla at 0.4 mm is the factory advance", pla !== undefined && advanceFor(pla.pressureAdvance, 0.4) === 0);
check("petg advance depends on the nozzle", petg !== undefined && advanceFor(petg.pressureAdvance, 0.4) === 0.05 && advanceFor(petg.pressureAdvance, 0.6) === 0.06);

const picked = selection(library);
check("selection is lime 220 and pla", picked?.printer.id === "lime-220" && picked.filament.id === "lime-pla");
const sent = picked ? enginePrinter(picked.printer, picked.filament, 0.4) : null;
const sentKeys = sent ? Object.keys(sent).sort() : [];
check("the slice printer has no start or end g-code", sent !== null && !("startGcode" in sent) && !("endGcode" in sent));
check(
  "the slice printer is the existing fields",
  sentKeys.join(",") === ["bedTemp", "bedX", "bedY", "bedZ", "filamentCostPerKg", "filamentDensityGCm3", "filamentDiameter", "linearAdvance", "maxAccel", "maxVolumetricMm3S", "name", "nozzleDiameter", "nozzleTemp", "pressureAdvance"].join(","),
);
check("petg at 0.6 mm is sent as pressure advance", (() => {
  const next = selectIn(library, "lime-220", "lime-petg", 0.6);
  if (typeof next === "string") return false;
  const row = selection(next);
  return row !== null && enginePrinter(row.printer, row.filament, next.nozzleMm).pressureAdvance === 0.06 && enginePrinter(row.printer, row.filament, next.nozzleMm).nozzleTemp === 240;
})());

const remembered = setAdvance(selectIn(library, "lime-220", "lime-pla", 0.6) as typeof library, 0.02, 0.1);
check("advance is stored on that filament and nozzle", selection(remembered)?.filament.pressureAdvance["0.6"] === 0.02 && selection(remembered)?.filament.linearAdvance["0.6"] === 0.1);
check("the other nozzle is unchanged", selection(remembered)?.filament.pressureAdvance["0.4"] === 0);

const numbers: MachineNumbers = {
  nozzleDiameter: 0.4,
  filamentDiameter: 1.75,
  nozzleTemp: 205,
  bedTemp: 55,
  bedX: 250,
  bedY: 210,
  bedZ: 200,
  maxVolumetricMm3S: 11,
  maxAccel: 3000,
  filamentDensityGCm3: 1.24,
  filamentCostPerKg: 18,
  pressureAdvance: 0.03,
  linearAdvance: 0,
  startGcode: "; shop",
  endGcode: "; end",
};
const named = savePrinterName(library, "Shop", numbers, "shop");
check("save as adds a printer", typeof named !== "string" && named.printers.some((printer) => printer.name === "Shop" && printer.bedX === 250 && !printer.builtin));
check("save as keeps the g-code off the slice printer", typeof named !== "string" && selection(named) !== null && !("startGcode" in enginePrinter(selection(named)!.printer, selection(named)!.filament, named.nozzleMm)) && selection(named)!.printer.startGcode === "; shop");

const saved = typeof named === "string" ? library : saveActive(named, { ...numbers, bedX: 260 });
check("save writes the active printer", typeof saved !== "string" && selection(saved)?.printer.bedX === 260);

const copied = typeof saved === "string" ? library : duplicateActive(saved, "p2", "f2");
check("duplicate adds a user copy", typeof copied !== "string" && copied.printerId === "p2" && selection(copied)?.printer.name === "Shop copy" && selection(copied)?.printer.builtin === false);
check("a built-in pair cannot be deleted", deleteActive(library) === "Built-in profiles stay in the catalog. Duplicate one to change the copy.");
const removed = typeof copied === "string" ? library : deleteActive(copied);
check("delete drops the copy", typeof copied !== "string" && removed !== copied && typeof removed !== "string" && removed.printers.every((printer) => printer.id !== "p2"));

const file = fileFromSelection(library);
check("export round-trips", file !== null && parseMachineFile(serializeMachineFile(file)).ok);
const badJson = parseMachineFile("{");
check("bad json is refused", !badJson.ok && badJson.message === "This file is not a Lime Slice machine profile.");
const missingVersion = parseMachineFile("{}");
check("a missing version is refused", !missingVersion.ok && missingVersion.message === "This machine profile has no version, so it cannot be opened.");
const future = parseMachineFile(`{"version":9}`);
check("a future version is refused", !future.ok && future.message.includes("version 9"));
const broken = parseMachineFile(JSON.stringify({ version: 1, printer: { name: "X" }, filament: { name: "Y" }, nozzleMm: 0.4 }));
check("an incomplete file is refused", !broken.ok && broken.message === "This machine profile is incomplete.");
const imported = file ? importInto(library, file, "imp", "impf") : library;
check("import keeps a unique name", imported.printers.some((printer) => printer.name === "Lime 220 2") && imported.printerId === "imp");
check("file name uses the machine suffix", machineFileName("Lime 220", "PLA") === "Lime_220__PLA.limemachine.json");

const stored = parseLibrary(serializeLibrary(library));
check("the library round-trips", stored.printers.length === 3 && stored.filaments.length === 4 && stored.printerId === "lime-220");
const restored = ensureBuiltins(parseLibrary("nope"));
check("a corrupt library grows the built-ins back", restored.printers.some((printer) => printer.id === "lime-220") && restored.filaments.some((filament) => filament.id === "lime-tpu"));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("machine-library: catalog, pressure advance, file, and slice fields ok");
