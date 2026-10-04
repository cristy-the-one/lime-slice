import { filamentCost, filamentGrams, groupFeatures, withFooterGrams, type Filament } from "./estimate.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}`);
}

const pla: Filament = { filamentDiameter: 1.75, filamentDensityGCm3: 1.24, filamentCostPerKg: 20 };
const petg: Filament = { ...pla, filamentDensityGCm3: 1.27, filamentCostPerKg: 30 };

eq("a metre of 1.75 mm PLA", filamentGrams(1000, pla).toFixed(4), "2.9825");
eq("a metre of 1.75 mm PETG", filamentGrams(1000, petg).toFixed(4), "3.0547");
eq("cost of 250 g at 30 €/kg", filamentCost(250, petg), 7.5);
// The engine's reply for the 20 mm cube at 1.24 g/cm³: filamentMm 862.547532413776, filamentG 2.5725907335234646.
eq("the engine's grams for the cube, to the bit", filamentGrams(862.547532413776, pla), 2.5725907335234646);

const footer = "G1 Z30.000 F600\nM106 S0\n; bed 220x220 mm nozzle 0.40 mm\n; TIME:301.6s FILAMENT_MM:862.55 FILAMENT_G:2.573 ARCS:2\nM84\n";
eq(
  "the footer takes the profile's grams",
  withFooterGrams(footer, filamentGrams(862.547532413776, petg)),
  footer.replace("FILAMENT_G:2.573", "FILAMENT_G:2.635"),
);
eq("G-code without the footer is left alone", withFooterGrams("G1 X1 Y1 E0.1\n", 5), "G1 X1 Y1 E0.1\n");
eq("a comment that only mentions FILAMENT_G is left alone", withFooterGrams("; FILAMENT_G:1\n", 5), "; FILAMENT_G:1\n");

const rows = [
  { kind: "outer", seconds: 10, filamentMm: 400 },
  { kind: "inner", seconds: 5, filamentMm: 300 },
  { kind: "thin-wall", seconds: 1, filamentMm: 100 },
  { kind: "travel", seconds: 3, filamentMm: 0 },
  { kind: "skirt", seconds: 2, filamentMm: 50 },
];
eq(
  "features group with grams at the profile's density",
  groupFeatures(rows, petg).map((g) => [g.label, g.seconds, g.grams.toFixed(3)]),
  [
    ["Outer wall", 10, "1.222"],
    ["Inner wall", 6, "1.222"],
    ["Travel", 3, "0.000"],
    ["Other", 2, "0.153"],
  ],
);

if (failed) throw new Error(`${failed} estimate checks failed`);
console.log("estimate ok");
