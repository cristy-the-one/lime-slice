import { ADVANCE, orderFields, sequentialClearance, settingsRules, tallestLast, type PrintOrder, type RuleInput } from "./settings-rules.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq(name: string, got: unknown, want: unknown): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  check(name, a === b, `${a} vs ${b}`);
}

const flat: RuleInput = { kind: "cartesian", belt: { raftLayers: 0, maxLengthMm: null }, firmware: "klipper", objects: 1 };
const belt: RuleInput = { ...flat, kind: "belt" };
const hidden = (input: RuleInput) => [...settingsRules(input).hidden].sort();

eq("a flat printer with one object hides only the belt block, its length, and its raft layers", hidden(flat), ["beltFields", "beltMaxLength", "beltRaftLayers", "printOrder"]);
eq("a flat printer with two objects shows the print order", hidden({ ...flat, objects: 2 }), ["beltFields", "beltMaxLength", "beltRaftLayers"]);

// Ruling 1: a belt raft hides Adaptive and drops it from the request.
check("a belt raft hides adaptive layers", settingsRules({ ...belt, belt: { raftLayers: 2, maxLengthMm: null } }).hidden.has("adaptive"));
check("a belt without a raft keeps adaptive layers", !settingsRules(belt).hidden.has("adaptive"));
check("a raft on a flat printer does not hide adaptive layers", !settingsRules({ ...flat, belt: { raftLayers: 2, maxLengthMm: null } }).hidden.has("adaptive"));
const adaptive = { adaptive: true, adaptiveMin: 0.08, adaptiveMax: 0.2, layerHeight: 0.2 };
eq("adaptive is not sent with a raft", settingsRules({ ...belt, belt: { raftLayers: 2, maxLengthMm: null } }).coerce(adaptive), { layerHeight: 0.2 });
eq("adaptive is sent without one", settingsRules(belt).coerce(adaptive), adaptive);

// Ruling 2: a belt hides the print order and never sends it.
check("a belt hides the print order however many objects it holds", settingsRules({ ...belt, objects: 3 }).hidden.has("printOrder"));
const sequential: PrintOrder = { printOrder: "sequential", clearanceMm: 40, gantryMm: 0 };
eq("a belt plate never sends the order", orderFields(settingsRules({ ...belt, objects: 3 }), sequential), {});
eq("a one-object plate never sends the order", orderFields(settingsRules(flat), sequential), {});
eq("a sequential plate sends the order and its clearance", orderFields(settingsRules({ ...flat, objects: 2 }), sequential), { printOrder: "sequential", sequentialClearanceMm: 40 });
eq("a sequential plate sends the gantry too, capped", orderFields(settingsRules({ ...flat, objects: 2 }), { printOrder: "sequential", clearanceMm: 0, gantryMm: 900 }), { printOrder: "sequential", sequentialGantryMm: 500 });
eq("all at once sends nothing", orderFields(settingsRules({ ...flat, objects: 2 }), { printOrder: "all-at-once", clearanceMm: 40, gantryMm: 0 }), {});
eq("the order keys are dropped from a belt's hash input", settingsRules(belt).coerce({ printOrder: "sequential", sequentialClearanceMm: 40, sequentialGantryMm: 20, mesh: "m" }), { mesh: "m" });

// Ruling 3: Blend compare is a flat-bed estimate.
check("a belt hides Blend compare", settingsRules(belt).hidden.has("blendCompare"));
check("a flat printer shows Blend compare, whatever the object count", !settingsRules({ ...flat, objects: 4 }).hidden.has("blendCompare"));

// Ruling 6: sequential Arrange keeps the toolhead clearance.
eq("a sequential plate arranges with the typed clearance", sequentialClearance(settingsRules({ ...flat, objects: 2 }), sequential), 40);
eq("a sequential plate with no clearance typed arranges with the engine's 35 mm", sequentialClearance(settingsRules({ ...flat, objects: 2 }), { printOrder: "sequential", clearanceMm: 0, gantryMm: 0 }), 35);
eq("an all-at-once plate has no clearance", sequentialClearance(settingsRules({ ...flat, objects: 2 }), { printOrder: "all-at-once", clearanceMm: 0, gantryMm: 0 }), null);
eq("objects print tallest last", tallestLast([{ id: "a", h: 30 }, { id: "b", h: 10 }, { id: "c", h: 20 }, { id: "d", h: 10 }], (o) => o.h).map((o) => o.id), ["b", "d", "c", "a"]);

// Ruling 8: a belt forces Z-hop and scarf off, so they are hidden and not sent.
check("a belt hides Z-hop and scarf", settingsRules(belt).hidden.has("zHop") && settingsRules(belt).hidden.has("scarf"));
check("a flat printer shows Z-hop and scarf", !settingsRules(flat).hidden.has("zHop") && !settingsRules(flat).hidden.has("scarf"));
const hopAndScarf = { zHop: "smart", zHopHeight: 0.4, zHopMinTravel: 2, scarfSeam: "outer", scarfLength: 10, scarfSteps: 8, scarfStartHeight: 0.15, scarfStartFlow: 0.55, gyroid3d: "blend" };
eq("a belt request carries neither", settingsRules(belt).coerce(hopAndScarf), { gyroid3d: "blend" });
eq("a flat request carries both", settingsRules(flat).coerce(hopAndScarf), hopAndScarf);

// Ruling 10: one advance control, and only the matching field is sent.
eq("Klipper edits pressure advance", [ADVANCE.klipper.label, ADVANCE.klipper.key], ["Pressure advance", "pressureAdvance"]);
eq("Marlin edits linear advance K", [ADVANCE.marlin.label, ADVANCE.marlin.key], ["Linear advance K", "linearAdvance"]);
const printed = { layerHeight: 0.2, printer: { name: "p", pressureAdvance: 0.05, linearAdvance: 0.8 } };
eq("a Klipper request sends pressure advance only", settingsRules(flat).coerce(printed), { layerHeight: 0.2, printer: { name: "p", pressureAdvance: 0.05 } });
eq("a Marlin request sends linear advance only", settingsRules({ ...flat, firmware: "marlin" }).coerce(printed), { layerHeight: 0.2, printer: { name: "p", linearAdvance: 0.8 } });
eq("a state record drops the unused advance too", settingsRules({ ...flat, firmware: "marlin" }).coerce({ pressureAdvance: 0.05, linearAdvance: 0.8 }), { linearAdvance: 0.8 });

// Ruling 15: dependent sub-fields are hidden, not disabled.
check("Max length is hidden while the belt is unlimited", settingsRules(belt).hidden.has("beltMaxLength"));
check("Max length shows once the belt has a cap", !settingsRules({ ...belt, belt: { raftLayers: 0, maxLengthMm: 300 } }).hidden.has("beltMaxLength"));
check("Raft layers is hidden while the raft is off", settingsRules(belt).hidden.has("beltRaftLayers"));
check("Raft layers shows once the raft is on", !settingsRules({ ...belt, belt: { raftLayers: 3, maxLengthMm: null } }).hidden.has("beltRaftLayers"));
check("the belt block shows on a belt and hides on a flat printer", !settingsRules(belt).hidden.has("beltFields") && settingsRules(flat).hidden.has("beltFields"));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("settings-rules: hidden controls, request coercion, order ok");
