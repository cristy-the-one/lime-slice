import { adhesionSliceFields, warps } from "./adhesion.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const skirt = { adhesion: "skirt" as const, brimWidthMm: 5, brimGapMm: 0.1, skirtLoops: 0 };
check("a skirt sends nothing", Object.keys(adhesionSliceFields(skirt, false)).length === 0);
check("a belt sends nothing even with a brim", Object.keys(adhesionSliceFields({ ...skirt, adhesion: "brim" }, true)).length === 0);
check("extra skirt loops are sent", adhesionSliceFields({ ...skirt, skirtLoops: 3 }, false).skirtLoops === 3);
check("none turns the skirt off", adhesionSliceFields({ ...skirt, adhesion: "none" }, false).adhesion === "none");
const brim = adhesionSliceFields({ ...skirt, adhesion: "brim", brimWidthMm: 5, brimGapMm: 0.1 }, false);
check("a brim sends its width and gap", brim.adhesion === "brim" && brim.brimWidthMm === 5 && brim.brimGapMm === 0.1);
const ears = adhesionSliceFields({ ...skirt, adhesion: "mouseEars" }, false);
check("mouse ears use the brim width as a radius", ears.adhesion === "mouseEars" && ears.brimWidthMm === 5);

check("ABS, ASA, and PC warp", warps("ABS") && warps("asa") && warps("PC-HT") && warps("ABS-GF"));
check("PLA and PETG do not", !warps("PLA") && !warps("PETG") && !warps("ABSORB"));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("adhesion: skirt stays off the request, brim and ears opt in");
