import { SETTING_KEYWORDS, settingMatches } from "./settings-search.ts";

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
check("keyword matches when the label does not", settingMatches("lattice", "3D gyroid", SETTING_KEYWORDS.gyroid3d));
check("placement keyword matches scale", settingMatches("placement", "scale %", SETTING_KEYWORDS.partScale));
check("seam keyword matches the scarf control", settingMatches("seam", "Scarf seam", SETTING_KEYWORDS.scarf));
check("rear finds the seam position", settingMatches("rear", "Seam position", SETTING_KEYWORDS.seam));
check("top skin finds ironing", settingMatches("skin", "Ironing", SETTING_KEYWORDS.ironing));
check("noise finds fuzzy skin", settingMatches("noise", "Fuzzy skin", SETTING_KEYWORDS.fuzzy));
check("unknown word misses", !settingMatches("nozzleplate", "Layer height mm", SETTING_KEYWORDS.lh));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("settings-search: label and keyword filter ok");
