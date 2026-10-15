import {
  acceptsArcs,
  setActiveFirmwareArcs,
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
  setRetract,
  setActiveFirmware,
  legacySeamOnEdge,
  setLink,
  adoptLegacyLink,
  beltStamp,
  heatFor,
  heatNotes,
  heatWarnings,
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
check("built-in printers", library.printers.map((printer) => printer.name).join(",") === "Lime 220,Lime 300,Lime 180,Generic belt 45°,Ideaformer IR3 V2");
const genericBelt = library.printers.find((printer) => printer.id === "generic-belt-45");
check(
  "the generic belt is a 45° belt along Z with no length limit",
  genericBelt?.builtin === true &&
    genericBelt.kind === "belt" &&
    JSON.stringify(genericBelt.belt) === JSON.stringify({ angleDeg: 45, axis: "z", direction: 1, widthMm: 200, maxLengthMm: null, copies: 1, gapMm: 5, raftLayers: 0 }),
  JSON.stringify(genericBelt),
);
const ir3 = library.printers.find((printer) => printer.id === "ideaformer-ir3-v2");
check(
  "the IR3 V2 is a 250 mm wide 45° belt with an open length, 12 mm³/s, and its 20000 mm/s² limit",
  ir3?.builtin === true &&
    ir3.kind === "belt" &&
    ir3.bedX === 250 && ir3.bedY === 250 && ir3.bedZ === 250 &&
    ir3.maxVolumetricMm3S === 12 && ir3.maxAccel === 20000 &&
    JSON.stringify(ir3.belt) === JSON.stringify({ angleDeg: 45, axis: "z", direction: 1, widthMm: 250, maxLengthMm: null, copies: 1, gapMm: 5, raftLayers: 0 }),
  JSON.stringify(ir3),
);
check(
  "the IR3 V2 carries its printer.cfg limits: 400 mm/s, scv 5, cruise ratio 0.5, extruder corner 1, belt 20 mm/s at 500 mm/s²",
  ir3 !== undefined &&
    JSON.stringify([ir3.maxVelocity, ir3.squareCornerVelocity, ir3.minimumCruiseRatio, ir3.extruderCornerVelocity, ir3.maxZVelocity, ir3.maxZAccel]) === JSON.stringify([400, 5, 0.5, 1, 20, 500]),
  JSON.stringify(ir3),
);
check(
  "a library stored before the limits gets the IR3 V2's own, and Klipper's defaults for any other printer",
  (() => {
    const stored = JSON.parse(serializeLibrary(library)) as { printers: Record<string, unknown>[] };
    for (const row of stored.printers) for (const key of ["maxVelocity", "squareCornerVelocity", "minimumCruiseRatio", "extruderCornerVelocity", "maxZVelocity", "maxZAccel"]) delete row[key];
    const read = parseLibrary(JSON.stringify(stored));
    const old = read.printers.find((printer) => printer.id === "ideaformer-ir3-v2");
    const lime = read.printers.find((printer) => printer.id === "lime-220");
    return old?.maxVelocity === 400 && old.maxZAccel === 500 && lime?.maxVelocity === 0 && lime.squareCornerVelocity === 5 && lime.minimumCruiseRatio === 0.5 && lime.extruderCornerVelocity === 1;
  })(),
);
const onBelt = selectIn(library, "generic-belt-45", "lime-pla", 0.4);
check("picking the generic belt slices on the belt", typeof onBelt !== "string" && beltStamp(onBelt)?.angleDeg === 45, String(onBelt));
check("the default printer slices without a belt", beltStamp(library) === null);
check("built-in printers leave the host empty", library.printers.every((printer) => printer.host === "" && printer.apiKey === "" && printer.startPrint === false));
check("built-in printers other than the IR3 V2 leave start and end G-code empty", library.printers.filter((printer) => printer.id !== "ideaformer-ir3-v2").every((printer) => printer.startGcode === "" && printer.endGcode === ""));
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
  sentKeys.join(",") === ["bedTemp", "bedX", "bedY", "bedZ", "extruderCornerVelocity", "filamentCostPerKg", "filamentDensityGCm3", "filamentDiameter", "linearAdvance", "maxAccel", "maxVelocity", "maxVolumetricMm3S", "maxZAccel", "maxZVelocity", "minimumCruiseRatio", "name", "nozzleDiameter", "nozzleTemp", "pressureAdvance", "squareCornerVelocity"].join(","),
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
  squareCornerVelocity: 8,
  minimumCruiseRatio: 0.25,
  extruderCornerVelocity: 2,
  maxVelocity: 300,
  maxZVelocity: 10,
  maxZAccel: 250,
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
  maxBedC: 110,
  maxNozzleC: 280,
  startOwnsHoming: true,
};
const named = savePrinterName(library, "Shop", numbers, "shop");
check("save as adds a printer", typeof named !== "string" && named.printers.some((printer) => printer.name === "Shop" && printer.bedX === 250 && !printer.builtin));
check("save as keeps the g-code off the slice printer", typeof named !== "string" && selection(named) !== null && !("startGcode" in enginePrinter(selection(named)!.printer, selection(named)!.filament, named.nozzleMm)) && selection(named)!.printer.startGcode === "; shop");
check("save as keeps the host on the printer", typeof named !== "string" && selection(named)?.printer.host === "http://shop.local" && selection(named)?.printer.apiKey === "shop-key" && selection(named)?.printer.startPrint === true);

check(
  "save as keeps the Klipper limits and sends them on the slice printer",
  typeof named !== "string" &&
    (() => {
      const sent = enginePrinter(selection(named)!.printer, selection(named)!.filament, named.nozzleMm);
      return JSON.stringify([sent.squareCornerVelocity, sent.minimumCruiseRatio, sent.extruderCornerVelocity, sent.maxVelocity, sent.maxZVelocity, sent.maxZAccel]) === JSON.stringify([8, 0.25, 2, 300, 10, 250]);
    })(),
);
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
check("the library round-trips", stored.version === 3 && stored.printers.length === 5 && stored.filaments.length === 4 && stored.printerId === "lime-220" && stored.printers.every((printer) => printer.host === "" && printer.kind === (printer.id === "generic-belt-45" || printer.id === "ideaformer-ir3-v2" ? "belt" : "cartesian")));
// Libraries saved before version 3 predate belt printers.
const cartesianOnly = { ...library, printers: library.printers.filter((printer) => printer.kind === "cartesian") };
const version1Library = JSON.parse(serializeLibrary(cartesianOnly)) as { version: number; printers: Record<string, unknown>[] };
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
const version2 = JSON.parse(serializeLibrary(cartesianOnly)) as { version: number; printers: Record<string, unknown>[] };
version2.version = 2;
for (const printer of version2.printers) {
  delete printer.kind;
  delete printer.belt;
}
const fromVersion2 = parseLibrary(JSON.stringify(version2));
const lime = fromVersion2.printers.find((printer) => printer.id === "lime-220");
check("a version 2 library gains a cartesian belt block", fromVersion2.version === 3 && lime?.bedX === 220 && lime.kind === "cartesian" && lime.belt.angleDeg === 45 && lime.belt.copies === 1 && lime.belt.maxLengthMm === null && lime.belt.widthMm === 220 && lime.belt.raftLayers === 0);

const belted = setActiveBelt(library, "belt", { ...defaultBelt(180), angleDeg: 35, axis: "y", direction: -1, copies: 3, gapMm: 8, maxLengthMm: null });
const beltRow = selection(belted);
const beltSent = beltRow ? enginePrinter(beltRow.printer, beltRow.filament, 0.4) : null;
check("a belt printer still sends today's fields", beltSent !== null && Object.keys(beltSent).sort().join(",") === sentKeys.join(","));
check("belt settings stay on the record", beltRow?.printer.kind === "belt" && beltRow.printer.belt.copies === 3 && beltRow.printer.belt.axis === "y" && beltRow.printer.belt.direction === -1);
const beltFile = fileFromSelection(belted);
const beltRound = beltFile ? parseMachineFile(serializeMachineFile(beltFile)) : null;
check("a belt file round-trips", beltRound?.ok === true && beltRound.file.version === 3 && beltRound.file.printer.kind === "belt" && beltRound.file.printer.belt.angleDeg === 35 && beltRound.file.printer.belt.gapMm === 8 && beltRound.file.printer.belt.maxLengthMm === null && beltRound.file.printer.bedX === 220 && beltRound.file.printer.belt.raftLayers === 0);

const pulled = setRetract(builtinLibrary(), 1.2, 45);
const pulledRow = selection(pulled);
check("a retract length lands on the active filament", pulledRow?.filament.retractLength === 1.2 && pulledRow.filament.retractSpeed === 45);
check("30 mm/s is left off the filament", setRetract(builtinLibrary(), 0.8, 30).filaments.find((filament) => filament.id === "lime-pla")?.retractSpeed === undefined);
check("clearing retract removes it", selection(setRetract(pulled, null, null))?.filament.retractLength === undefined);
const parsedRetract = parseLibrary(JSON.stringify(pulled));
check("a saved retract length reads back", selection(parsedRetract)?.filament.retractLength === 1.2 && selection(parsedRetract)?.filament.retractSpeed === 45);

const warmed = setNozzleTemp(builtinLibrary(), 215.4);
const warmRow = selection(warmed);
check("the chosen temperature lands on the active filament", warmRow?.filament.nozzleTemp === 215 && warmRow.filament.id === "lime-pla");
check("another filament keeps its temperature", warmed.filaments.find((filament) => filament.id === "lime-petg")?.nozzleTemp === 240);
check("a cold temperature is held at 150", selection(setNozzleTemp(builtinLibrary(), 10))?.filament.nozzleTemp === 150);
check("a hot temperature is held at 320", selection(setNozzleTemp(builtinLibrary(), 400))?.filament.nozzleTemp === 320);

const withSecond = parseLibrary(JSON.stringify({ ...JSON.parse(serializeLibrary(library)), secondFilamentId: "lime-petg" }));
check("a stored second filament from an older save is ignored", !("secondFilamentId" in withSecond) && !serializeLibrary(ensureBuiltins(withSecond)).includes("secondFilamentId"));

check("every built-in printer is Klipper", library.printers.every((printer) => printer.firmware === "klipper"));
const marlin = setActiveFirmware(library, "marlin");
check("the firmware is stored on the active printer only", selection(marlin)?.printer.firmware === "marlin" && marlin.printers.filter((printer) => printer.firmware === "marlin").length === 1);
check("the firmware round-trips through the library", selection(parseLibrary(serializeLibrary(marlin)))?.printer.firmware === "marlin");
const marlinFile = fileFromSelection(marlin);
const marlinRound = marlinFile ? parseMachineFile(serializeMachineFile(marlinFile)) : null;
check("the firmware round-trips through a machine file", marlinRound?.ok === true && marlinRound.file.printer.firmware === "marlin");
const oldFirmwareless = JSON.parse(serializeLibrary(library)) as { printers: Record<string, unknown>[] };
for (const printer of oldFirmwareless.printers) delete printer.firmware;
check("a printer saved before firmware reads as Klipper", parseLibrary(JSON.stringify(oldFirmwareless)).printers.every((printer) => printer.firmware === "klipper"));
const oldBelt = JSON.parse(serializeLibrary(library)) as { printers: { belt: Record<string, unknown> }[] };
for (const printer of oldBelt.printers) Object.assign(printer.belt, { seamOnEdge: true, floorSupports: true });
check("an old belt block's seam and floor supports flags are dropped on load", parseLibrary(JSON.stringify(oldBelt)).printers.every((printer) => !("seamOnEdge" in printer.belt) && !("floorSupports" in printer.belt)));
check("an old machine file that put its seam on the belt edge is noticed", legacySeamOnEdge(JSON.stringify({ printer: { kind: "belt", belt: { seamOnEdge: true } } })) && !legacySeamOnEdge(JSON.stringify({ printer: { kind: "belt", belt: { seamOnEdge: false } } })) && !legacySeamOnEdge(JSON.stringify({ printer: { kind: "cartesian", belt: { seamOnEdge: true } } })) && !legacySeamOnEdge("nope"));


// Temperature limits and a start block that owns heating and homing.
check("the IR3 V2 stops at 90 C on the bed and 300 C at the nozzle", ir3?.maxBedC === 90 && ir3.maxNozzleC === 300, JSON.stringify(ir3));
check("other built-in printers allow 120 C bed and 300 C nozzle", library.printers.filter((printer) => printer.id !== "ideaformer-ir3-v2").every((printer) => printer.maxBedC === 120 && printer.maxNozzleC === 300));
check("only the IR3 V2 owns heating and homing", library.printers.every((printer) => printer.startOwnsHoming === (printer.id === "ideaformer-ir3-v2")));
check(
  "the IR3 V2 start block is the maker's sequence with placeholders",
  ir3 !== undefined &&
    ir3.startGcode.startsWith("PRINT_START\nM140 S{bed}\nM104 S{nozzle}\nM109 S{nozzle}\nG90\nM83\nG92 E0\nG1 Y0.1 F6000\n") &&
    ir3.startGcode.includes("\nG28 Y\n") && !/^G28$/m.test(ir3.startGcode) &&
    ir3.startGcode.trimEnd().endsWith("G92 E0 Z0\nM82") && ir3.endGcode === "PRINT_END",
  JSON.stringify(ir3?.startGcode),
);

const absAt100 = heatFor({ maxBedC: 90, maxNozzleC: 300 }, 250, 100);
check("a bed above the printer limit is held at it", absAt100.bedC === 90 && absAt100.nozzleC === 250 && absAt100.bedAskC === 100 && absAt100.nozzleAskC === 250, JSON.stringify(absAt100));
check("a temperature inside the limits is untouched", JSON.stringify(heatFor({ maxBedC: 90, maxNozzleC: 300 }, 200, 60)) === JSON.stringify({ nozzleC: 200, bedC: 60, nozzleAskC: 200, bedAskC: 60 }));
check("a nozzle above the limit is held too", heatFor({ maxBedC: 120, maxNozzleC: 260 }, 280, 60).nozzleC === 260);
check("no printer means no cap", heatFor(undefined, 250, 100).bedC === 100);
check("a cap writes a comment line", JSON.stringify(heatNotes(absAt100)) === JSON.stringify(["; bed capped at 90 C (filament 100 C)"]), JSON.stringify(heatNotes(absAt100)));
check("both caps write two comment lines", JSON.stringify(heatNotes(heatFor({ maxBedC: 90, maxNozzleC: 240 }, 250, 100))) === JSON.stringify(["; bed capped at 90 C (filament 100 C)", "; nozzle capped at 240 C (filament 250 C)"]));
check("no cap writes no comment", heatNotes(heatFor({ maxBedC: 90, maxNozzleC: 300 }, 200, 60)).length === 0);
check(
  "the warning names the filament, the ask, and the limit",
  JSON.stringify(heatWarnings(absAt100, "ABS")) === JSON.stringify(["Bed 90 °C (ABS asks 100 °C, this printer stops at 90 °C)"]),
  JSON.stringify(heatWarnings(absAt100, "ABS")),
);
check("no cap, no warning", heatWarnings(heatFor({ maxBedC: 90, maxNozzleC: 300 }, 200, 60), "PLA").length === 0);

const limited = fileFromSelection(selectIn(library, "ideaformer-ir3-v2", "lime-abs", 0.4) as typeof library);
const limitedRound = limited ? parseMachineFile(serializeMachineFile(limited)) : null;
check("the limits and the flag round-trip through a machine file", limitedRound?.ok === true && limitedRound.file.printer.maxBedC === 90 && limitedRound.file.printer.maxNozzleC === 300 && limitedRound.file.printer.startOwnsHoming === true);
const limitedLibrary = parseLibrary(serializeLibrary(library));
check("the limits and the flag round-trip through the library", limitedLibrary.printers.find((printer) => printer.id === "ideaformer-ir3-v2")?.maxBedC === 90 && limitedLibrary.printers.find((printer) => printer.id === "ideaformer-ir3-v2")?.startOwnsHoming === true);
const named2 = savePrinterName(library, "Shop", numbers, "shop");
check("Save writes the limits and the flag", typeof named2 !== "string" && selection(named2)?.printer.maxBedC === 110 && selection(named2)?.printer.maxNozzleC === 280 && selection(named2)?.printer.startOwnsHoming === true);

// A library saved before these fields existed.
const before = JSON.parse(serializeLibrary(library)) as { printers: Record<string, unknown>[] };
for (const printer of before.printers) {
  delete printer.maxBedC;
  delete printer.maxNozzleC;
  delete printer.startOwnsHoming;
  printer.startGcode = "";
  printer.endGcode = "";
}
const beforeRead = parseLibrary(JSON.stringify(before));
check("a printer saved before the limits reads as 120 C bed, 300 C nozzle, no owning start", beforeRead.printers.every((printer) => printer.maxBedC === 120 && printer.maxNozzleC === 300 && printer.startOwnsHoming === false));
const beforeFile = JSON.parse(serializeMachineFile(fileFromSelection(library)!)) as { printer: Record<string, unknown> };
delete beforeFile.printer.maxBedC;
delete beforeFile.printer.maxNozzleC;
delete beforeFile.printer.startOwnsHoming;
const beforeFileRead = parseMachineFile(JSON.stringify(beforeFile));
check("a machine file saved before the limits reads the same defaults", beforeFileRead.ok && beforeFileRead.file.printer.maxBedC === 120 && beforeFileRead.file.printer.maxNozzleC === 300 && beforeFileRead.file.printer.startOwnsHoming === false);
const refreshed = ensureBuiltins(beforeRead).printers.find((printer) => printer.id === "ideaformer-ir3-v2");
check(
  "an untouched stored IR3 V2 takes the catalog's limits, start block, and flag",
  refreshed?.maxBedC === 90 && refreshed.maxNozzleC === 300 && refreshed.startOwnsHoming === true && refreshed.startGcode.startsWith("PRINT_START\n") && refreshed.endGcode === "PRINT_END",
  JSON.stringify(refreshed),
);
const edited = parseLibrary(JSON.stringify({ ...before, printers: before.printers.map((printer) => printer.id === "ideaformer-ir3-v2" ? { ...printer, startGcode: "G28 ; mine" } : printer) }));
const editedKept = ensureBuiltins(edited).printers.find((printer) => printer.id === "ideaformer-ir3-v2");
check("a stored IR3 V2 whose start text was edited keeps its text and flag", editedKept?.startGcode === "G28 ; mine" && editedKept.startOwnsHoming === false);
const userCopy = parseLibrary(JSON.stringify({ ...before, printers: before.printers.map((printer) => printer.id === "ideaformer-ir3-v2" ? { ...printer, id: "copy", name: "IR3 mine", builtin: false } : printer) }));
const copyKept = ensureBuiltins(userCopy).printers.find((printer) => printer.id === "copy");
check("a user copy of the IR3 V2 is left alone", copyKept?.maxBedC === 120 && copyKept.startGcode === "" && copyKept.startOwnsHoming === false);
check("refreshing twice changes nothing", JSON.stringify(ensureBuiltins(ensureBuiltins(beforeRead))) === JSON.stringify(ensureBuiltins(beforeRead)));

const restored = ensureBuiltins(parseLibrary("nope"));
check("a corrupt library grows the built-ins back", restored.printers.some((printer) => printer.id === "lime-220") && restored.filaments.some((filament) => filament.id === "lime-tpu"));

// Firmware arcs: the IR3 V2 preset says no; the other built-ins are Klipper, so no; Marlin yes.
{
  const lib = builtinLibrary();
  const byId = (l: typeof lib, id: string) => l.printers.find((p) => p.id === id)!;
  check("the IR3 V2 preset turns firmware arcs off", byId(lib, "ideaformer-ir3-v2").firmwareArcs === false && !acceptsArcs(byId(lib, "ideaformer-ir3-v2")));
  for (const id of ["lime-220", "lime-300", "lime-180", "generic-belt-45"]) {
    check(`${id} is Klipper with no arcs answer, so no arcs`, byId(lib, id).firmwareArcs === undefined && !acceptsArcs(byId(lib, id)));
  }
  check("a Marlin printer that does not say takes arcs", acceptsArcs({ firmware: "marlin" }));
  check("no printer is a Klipper one", !acceptsArcs(undefined));

  // A library stored before the answer existed: no key on any printer.
  const old = JSON.parse(serializeLibrary(lib)) as { printers: Record<string, unknown>[] };
  for (const row of old.printers) delete row.firmwareArcs;
  old.printers.push({ ...old.printers[0], id: "custom-marlin", name: "Shop Marlin", builtin: false, firmware: "marlin" });
  const reread = parseLibrary(JSON.stringify(old));
  check("an old stored IR3 V2 reads as no arcs", byId(reread, "ideaformer-ir3-v2").firmwareArcs === false);
  check("an old stored Lime 220 keeps its firmware's default", byId(reread, "lime-220").firmwareArcs === undefined && !acceptsArcs(byId(reread, "lime-220")));
  check("an old stored Marlin printer takes arcs", acceptsArcs(byId(reread, "custom-marlin")));

  const ticked = setActiveFirmwareArcs(selectIn(lib, "lime-220", lib.filamentId, 0.4) as typeof lib, true);
  check("ticking the box stores it on the active printer only", byId(ticked, "lime-220").firmwareArcs === true && byId(ticked, "lime-300").firmwareArcs === undefined);
  check("a stored answer survives a save and a read", byId(parseLibrary(serializeLibrary(ticked)), "lime-220").firmwareArcs === true);

  // Machine files: the answer travels; a file without it gets the firmware's default.
  const ir3File = fileFromSelection(selectIn(lib, "ideaformer-ir3-v2", lib.filamentId, 0.4) as typeof lib)!;
  const ir3Parsed = parseMachineFile(serializeMachineFile(ir3File));
  check("an exported IR3 V2 file keeps arcs off", ir3Parsed.ok && ir3Parsed.file.printer.firmwareArcs === false);
  const oldFile = JSON.parse(serializeMachineFile(ir3File)) as { printer: Record<string, unknown> };
  delete oldFile.printer.firmwareArcs;
  const oldParsed = parseMachineFile(JSON.stringify(oldFile));
  check("an old machine file without the key loads", oldParsed.ok && oldParsed.file.printer.firmwareArcs === undefined);
  check("and its Klipper printer gets no arcs", oldParsed.ok && !acceptsArcs(oldParsed.file.printer));
}

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("machine-library: catalog, pressure advance, file, and slice fields ok");
