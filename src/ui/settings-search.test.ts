import { keywordsOf } from "./settings-schema.ts";
import { settingMatches } from "./settings-search.ts";

let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

check("empty query matches", settingMatches("", "Layer height mm"));
check("blank query matches", settingMatches("  ", "Layer height mm"));
check("label match is case insensitive", settingMatches("LAYER", "Layer height mm"));
check("both words must match", settingMatches("layer height", "Layer height mm"));
check("mixed words miss", !settingMatches("layer scarf", "Layer height mm"));
check("keyword matches when the label does not", settingMatches("lattice", "3D gyroid", keywordsOf("gyroid3d")));
check("seam keyword matches the scarf control", settingMatches("seam", "Scarf seam", keywordsOf("scarf")));
check("rear finds the seam position", settingMatches("rear", "Seam position", keywordsOf("seam")));
check("top skin finds ironing", settingMatches("skin", "Ironing", keywordsOf("ironing")));
check("noise finds fuzzy skin", settingMatches("noise", "Fuzzy skin", keywordsOf("fuzzy")));
check("unknown word misses", !settingMatches("nozzleplate", "Layer height mm", keywordsOf("lh")));
check("an unknown id has no keywords", keywordsOf("nothing") === "");
check("ampersand matches and", settingMatches("Overhang & bridges", "Overhang and bridges"));
check("and matches an ampersand heading", settingMatches("Walls and surface", "Walls & surface"));
check("an escaped ampersand matches and", settingMatches("Speed &amp; travel", "Speed & travel"));
check("a unit token stays whole", settingMatches("mm/s", "Bridge speed mm/s"));
check("a percent sign stays", settingMatches("fan %", "Bridge fan %"));
check("a cubic millimetre stays", settingMatches("mm³", "Max flow mm³/s"));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("settings-search: label and keyword filter ok");
