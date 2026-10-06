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
  setFlow,
  setActiveBelt,
  setNozzleTemp,
  setLink,
  adoptLegacyLink,
  type MachineNumbers,
} from "./machine-library.ts";
import { defaultBelt } from "../belt.ts";

let failed = 0;

function stripLink(printer: Record<string, unknown>): Record<string, unknown> {
  const next = { ...printer };
  delete next.host;
  delete next.apiKey;
  delete next.startPrint;
  return next;
}

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const library = builtinLibrary();
check("built-in printers", library.printers.map((printer) => printer.name).join(",") === "Lime 220,Lime 300,Lime 180");
check("built-in printers leave the host empty", library.printers.every((printer) => printer.host === "" && printer.apiKey === "" && printer.startPrint === false));
check("built-in printers leave start and end G-code empty", library.printers.every((printer) => printer.startGcode === "" && printer.endGcode === ""));
check("built-in filaments", library.filaments.map((filament) => filament.material).join(",") === "PLA,PETG,ABS,TPU");

const pla = library.filaments.find((filament) => filament.id === "lime-pla");
const petg = library.filaments.find((filament) => filament.id === "lime-petg");
check("pla at 0.4 mm is the factory advance", pla !== undefined && advanceFor(pla.pressureAdvance, 0.4) === 0);
check("built-in filaments start at flow 1", library.filaments.every((filament) => filament.flow === 1));
const flowed = setFlow(library, 1.05);
check("flow is stored on the filament", selection(flowed)?.filament.flow === 1.05);
check("a missing flow reads as 1", (() => {
  const raw = JSON.parse(serializeLibrary(library)) as { filaments: { flow?: number }[] };
  delete raw.filaments[0].flow;
  return parseLibrary(JSON.stringify(raw)).filaments[0]?.flow === 1;
})());
check("petg advance depends on the nozzle", petg !== undefined && advanceFor(petg.pressureAdvance, 0.4) === 0.05 && advanceFor(petg.pressureAdvance, 0.6) === 0.06);

const picked = selection(library);
check("selection is lime 220 and pla", picked?.printer.id === "lime-220" && picked.filament.id === "lime-pla");
const sent = picked ? enginePrinter(picked.printer, picked.filament, 0.4) : null;
const sentKeys = sent ? Object.keys(sent).sort() : [];
check("the slice printer has no start g-code, end g-code, or host", sent !== null && !("startGcode" in sent) && !("endGcode" in sent) && !("host" in sent) && !("apiKey" in sent));
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
  flow: 1.05,
  startGcode: "; shop",
  endGcode: "; end",
  host: "http://shop.local",
  apiKey: "shop-key",
  startPrint: true,
};
const named = savePrinterName(library, "Shop", numbers, "shop");
check("save as adds a printer", typeof named !== "string" && named.printers.some((printer) => printer.name === "Shop" && printer.bedX === 250 && !printer.builtin));
check("save as keeps the g-code off the slice printer", typeof named !== "string" && selection(named) !== null && !("startGcode" in enginePrinter(selection(named)!.printer, selection(named)!.filament, named.nozzleMm)) && selection(named)!.printer.startGcode === "; shop");
check("save as keeps the host on the printer", typeof named !== "string" && selection(named)?.printer.host === "http://shop.local" && selection(named)?.printer.apiKey === "shop-key" && selection(named)?.printer.startPrint === true);

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

const linked = setLink(library, "http://printer.local/extra", "secret", true);
check("the host is stored on the active printer", selection(linked)?.printer.host === "http://printer.local/extra" && selection(linked)?.printer.apiKey === "secret" && selection(linked)?.printer.startPrint === true);
const linkedFile = fileFromSelection(linked);
const linkedRound = linkedFile ? parseMachineFile(serializeMachineFile(linkedFile)) : null;
check("the host round-trips through the machine file", linkedRound?.ok === true && linkedRound.file.printer.host === "http://printer.local/extra" && linkedRound.file.printer.apiKey === "secret" && linkedRound.file.printer.startPrint === true);

const legacyFile = fileFromSelection(library);
const version1 = legacyFile
  ? parseMachineFile(JSON.stringify({
      ...JSON.parse(serializeMachineFile(legacyFile)),
      version: 1,
      printer: stripLink(JSON.parse(serializeMachineFile(legacyFile)).printer),
    }))
  : null;
check("a version 1 file gains an empty host", version1?.ok === true && version1.file.version === 3 && version1.file.printer.host === "" && version1.file.printer.apiKey === "" && version1.file.printer.startPrint === false);
check("a version 1 file stays cartesian", version1?.ok === true && version1.file.printer.kind === "cartesian" && version1.file.printer.belt.angleDeg === 45 && version1.file.printer.belt.maxLengthMm === null);

const stored = parseLibrary(serializeLibrary(library));
check("the library round-trips", stored.version === 3 && stored.printers.length === 3 && stored.filaments.length === 4 && stored.printerId === "lime-220" && stored.printers.every((printer) => printer.host === "" && printer.kind === "cartesian"));
const version1Library = JSON.parse(serializeLibrary(library)) as { version: number; printers: Record<string, unknown>[] };
version1Library.version = 1;
for (const printer of version1Library.printers) {
  delete printer.host;
  delete printer.apiKey;
  delete printer.startPrint;
}
const migratedLibrary = parseLibrary(JSON.stringify(version1Library));
check("a version 1 library gains an empty host", migratedLibrary.version === 3 && migratedLibrary.printers.length === 3 && migratedLibrary.printers.every((printer) => printer.host === "" && printer.apiKey === "" && printer.startPrint === false && printer.kind === "cartesian" && printer.belt.axis === "z"));
const adopted = adoptLegacyLink(builtinLibrary(), { url: "http://printer.local", apiKey: "secret", startPrint: true });
check("a legacy host lands on the active printer", selection(adopted)?.printer.host === "http://printer.local" && selection(adopted)?.printer.apiKey === "secret" && selection(adopted)?.printer.startPrint === true);
check("a printer that already has a host keeps it", selection(adoptLegacyLink(linked, { url: "http://other.local", apiKey: "nope", startPrint: false }))?.printer.host === "http://printer.local/extra");
check("an empty legacy host changes nothing", selection(adoptLegacyLink(library, { url: "  ", apiKey: "x", startPrint: true }))?.printer.host === "");
const version2 = JSON.parse(serializeLibrary(library)) as { version: number; printers: Record<string, unknown>[] };
version2.version = 2;
for (const printer of version2.printers) {
  delete printer.kind;
  delete printer.belt;
}
const fromVersion2 = parseLibrary(JSON.stringify(version2));
const lime = fromVersion2.printers.find((printer) => printer.id === "lime-220");
check("a version 2 library gains a cartesian belt block", fromVersion2.version === 3 && lime?.bedX === 220 && lime.kind === "cartesian" && lime.belt.angleDeg === 45 && lime.belt.copies === 1 && lime.belt.maxLengthMm === null && lime.belt.widthMm === 220 && lime.belt.raftLayers === 0 && lime.belt.seamOnEdge === false);

const belted = setActiveBelt(library, "belt", { ...defaultBelt(180), angleDeg: 35, axis: "y", direction: -1, copies: 3, gapMm: 8, maxLengthMm: null });
const beltRow = selection(belted);
const beltSent = beltRow ? enginePrinter(beltRow.printer, beltRow.filament, 0.4) : null;
check("a belt printer still sends today's fields", beltSent !== null && Object.keys(beltSent).sort().join(",") === sentKeys.join(","));
check("belt settings stay on the record", beltRow?.printer.kind === "belt" && beltRow.printer.belt.copies === 3 && beltRow.printer.belt.axis === "y" && beltRow.printer.belt.direction === -1);
const beltFile = fileFromSelection(belted);
const beltRound = beltFile ? parseMachineFile(serializeMachineFile(beltFile)) : null;
check("a belt file round-trips", beltRound?.ok === true && beltRound.file.version === 3 && beltRound.file.printer.kind === "belt" && beltRound.file.printer.belt.angleDeg === 35 && beltRound.file.printer.belt.gapMm === 8 && beltRound.file.printer.belt.maxLengthMm === null && beltRound.file.printer.bedX === 220 && beltRound.file.printer.belt.raftLayers === 0);

const warmed = setNozzleTemp(builtinLibrary(), 215.4);
const warmRow = selection(warmed);
check("the chosen temperature lands on the active filament", warmRow?.filament.nozzleTemp === 215 && warmRow.filament.id === "lime-pla");
check("another filament keeps its temperature", warmed.filaments.find((filament) => filament.id === "lime-petg")?.nozzleTemp === 240);
check("a cold temperature is held at 150", selection(setNozzleTemp(builtinLibrary(), 10))?.filament.nozzleTemp === 150);
check("a hot temperature is held at 320", selection(setNozzleTemp(builtinLibrary(), 400))?.filament.nozzleTemp === 320);

const restored = ensureBuiltins(parseLibrary("nope"));
check("a corrupt library grows the built-ins back", restored.printers.some((printer) => printer.id === "lime-220") && restored.filaments.some((filament) => filament.id === "lime-tpu"));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("machine-library: catalog, pressure advance, file, and slice fields ok");
