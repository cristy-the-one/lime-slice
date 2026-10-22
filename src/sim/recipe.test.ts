/**
 * The recipe the study smears, and the provisional cards the library keeps.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyOverrides, addRange, addVolume, defaultVolume } from "../overrides.ts";
import { builtinLibrary, cardsOf, ensureBuiltins, parseLibrary, saveMaterialCard, serializeLibrary } from "../ui/machine-library.ts";
import { provisionalCards, readBeadSection, withBeads } from "./cards.ts";
import { recipeRefusal, REGIONS_REFUSAL, simRecipe } from "./recipe.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const speed = simRecipe({ toughness: 0.8, layerHeightMm: 0.2, lineWidthMm: 0.45, blendKind: "single", strategy: "speed" });
check("a speed strategy is lightning at two walls", speed.pattern === "lightning" && speed.walls === 2 && speed.infill === 0.12 && speed.patternMeasured === false && speed.patternFactor === 1 && speed.skinLayers === 3);

const weighted = simRecipe({ toughness: 1, layerHeightMm: 0.2, lineWidthMm: 0.45, blendKind: "weight" });
check("full toughness is gyroid", weighted.pattern === "gyroid" && weighted.walls === 5 && Math.abs(weighted.infill - 0.48) < 1e-9);

const object = simRecipe({
  toughness: 0,
  layerHeightMm: 0.2,
  lineWidthMm: 0.45,
  blendKind: "weight",
  object: { walls: 8, infill: 0.3 },
});
check("the object replaces walls and infill", object.walls === 8 && object.infill === 0.3 && object.pattern === "lightning");

const ranged = simRecipe({
  toughness: 0,
  layerHeightMm: 0.2,
  lineWidthMm: 0.45,
  object: { walls: 2, infill: 0.2 },
  overrides: addRange(addVolume(emptyOverrides(), { ...defaultVolume("box", 220, 220), id: "volume-1", override: { infill: 0.55 } }), {
    id: "range-1",
    zFrom: 0,
    zTo: 4,
    override: { walls: 6 },
  }),
  reinforcementDensities: [0.1, 0.9],
});
check("the smear keeps the object's walls and infill", ranged.walls === 2 && ranged.infill === 0.2);
check("a range wins on walls inside its band", ranged.regions.some((region) => region.id === "range-1" && region.walls === 6 && region.infill === undefined));
check("a modifier wins on infill inside its volume", ranged.regions.some((region) => region.id === "volume-1" && region.infill === 0.55));
check("reinforcement raises and does not lower", ranged.reinforcedInfill === 0.9);
check("a modifier region is refused, not solved as if it were absent", recipeRefusal(ranged) === REGIONS_REFUSAL);
check("a recipe with no region and no raised reinforcement is solved", recipeRefusal(object) === null);

const root = join(dirname(fileURLToPath(import.meta.url)));
for (const name of readdirSync(root)) {
  if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
  const text = readFileSync(join(root, name), "utf8");
  check(`${name} does not reference the slicer strength heuristic`, !text.includes("InfillPattern"));
}

const petg = provisionalCards().find((card) => card.id === "inhouse-petg");
check(
  "PETG matches the plan",
  !!petg && petg.polymer === "PETG" && petg.provisional && petg.EInPlaneMPa === 1800 && petg.EAcrossLayersMPa === 1500 && petg.nu === 0.35 && petg.strengthInPlaneMPa === 30 && petg.strengthAcrossLayersMPa === 15 && petg.compressionInPlaneMPa === 30 && petg.compressionAcrossLayersMPa === 15 && petg.shearAcrossLayersMPa === 7.5 && petg.densityGCm3 === 1.27 && petg.measuredAtC === null && petg.specimen === "placeholder, not measured" && petg.method === null && petg.source === "in-house" && petg.isotropic === false,
);
check("the four polymers we ship, and no others", provisionalCards().map((card) => card.polymer).join(",") === "PLA,PETG,ABS,TPU");

const plain = parseLibrary(serializeLibrary(builtinLibrary()));
check("an old library has no card array", plain.materialCards === undefined);
check("the placeholders are still offered", cardsOf(plain).length === 4 && cardsOf(plain)[1]?.id === "inhouse-petg");

const stored = parseLibrary(JSON.stringify({ ...JSON.parse(serializeLibrary(builtinLibrary())), materialCards: provisionalCards() }));
check("a saved array is kept", stored.materialCards?.length === 4 && stored.materialCards[1]?.EInPlaneMPa === 1800);
check("ensureBuiltins does not drop the array", ensureBuiltins(stored).materialCards?.length === 4);
const edited = saveMaterialCard(plain, { ...provisionalCards()[1]!, provisional: false, specimen: "bars, 2026-10-21" });
check("saving a card writes the array", edited.materialCards?.length === 4 && edited.materialCards?.find((card) => card.id === "inhouse-petg")?.provisional === false);
check("the saved card comes back", parseLibrary(serializeLibrary(edited)).materialCards?.find((card) => card.id === "inhouse-petg")?.specimen === "bars, 2026-10-21");

// Bead sections: the Rust placeholder cards' numbers, derived from the card so an edit can't leave them stale.
check(
  "PETG carries the Rust placeholder bead section",
  JSON.stringify(petg?.beads) === JSON.stringify({
    provisional: true, EAlongBeadMPa: 1800, EAcrossBeadMPa: 1500, EAcrossLayersMPa: 1500,
    strengthAlongBeadMPa: 30, strengthAcrossBeadMPa: 15, strengthAcrossLayersMPa: 15, shearAcrossLayersMPa: 7.5, bridgeFactor: 0.5,
  }),
  JSON.stringify(petg?.beads),
);
const stiffer = withBeads({ ...petg!, EInPlaneMPa: 2400 });
check("an edited card's provisional beads follow the edit", stiffer.beads?.EAlongBeadMPa === 2400);
const measured = { ...petg!.beads!, provisional: false, bridgeFactor: 0.8 };
check("a measured bead section is sent as given", withBeads({ ...petg!, EInPlaneMPa: 2400, beads: measured }).beads === measured);
const { beads: _dropped, ...old } = petg!;
check("a card saved before beads gets the placeholder section", withBeads(old).beads?.EAcrossBeadMPa === 1500);
const kept = parseLibrary(serializeLibrary(saveMaterialCard(plain, { ...petg!, beads: measured })));
check("a stored bead section comes back", JSON.stringify(kept.materialCards?.find((card) => card.id === "inhouse-petg")?.beads) === JSON.stringify(measured));
const broken = parseLibrary(JSON.stringify({ ...JSON.parse(serializeLibrary(builtinLibrary())), materialCards: [{ ...petg!, beads: { ...measured, bridgeFactor: 1.5 } }] }));
check("a card with a bridgeFactor past 1 is not read", broken.materialCards?.length === 0);
check("a bead section with a missing modulus is not read", readBeadSection({ ...measured, EAcrossBeadMPa: undefined }) === null);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("recipe: ok");
