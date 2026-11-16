import { DEFAULT_PRESET, type PresetSettings } from "../src/presets.ts";
import { applyObjectSetting, applySetting, beltOnlyWarning, inactiveWarning, settingRows } from "./settings-rows.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name} ${detail}`);
}

const ctx = { belt: false, lineWidth: 0.45 };
const on: PresetSettings = { ...DEFAULT_PRESET, supports: true, supportSource: "auto" };

function set(settings: PresetSettings, key: string, value: unknown) {
  return applySetting(settings, key, value, ctx);
}

const off = set(on, "supports", false);
check("supports false turns supports off", "settings" in off && off.settings.supports === false, JSON.stringify(off));
const auto = set({ ...DEFAULT_PRESET, supports: false }, "supports", true);
check("supports true turns Automatic on", "settings" in auto && auto.settings.supports === true && auto.settings.supportSource === "auto", JSON.stringify(auto));
const named = set(on, "supports", "off");
check("supports \"off\" still turns supports off", "settings" in named && named.settings.supports === false);
const paint = set(on, "supports", "paint");
check("supports \"paint\" is Painted only", "settings" in paint && paint.settings.supports === true && paint.settings.supportSource === "paint");

const typo = set(on, "supports", "none");
check("an unknown supports mode is refused", "reason" in typo && typo.reason.includes("\"off\"") && typo.reason.includes("\"paint\""), JSON.stringify(typo));
const zero = set(on, "supports", 0);
check("a number for supports is refused", "reason" in zero);

const style = set(on, "supportStyle", false);
check("a boolean for another choice is refused, not coerced", "reason" in style && style.reason.includes("\"tree\""), JSON.stringify(style));
const tree = set(on, "supportStyle", "tree");
check("a listed choice is taken", "settings" in tree && tree.settings.supportStyle === "tree");

const object = applyObjectSetting(on, "supports", false, ctx);
check("an object's supports false is off", "value" in object && object.value === false, JSON.stringify(object));

const rows = settingRows({ settings: on, ctx, query: "supports", all: true });
const mode = rows.find((row) => row.key === "supports");
check("the supports row lists its choices", JSON.stringify(mode?.options) === JSON.stringify(["off", "auto", "paint"]), JSON.stringify(mode));

const allRows = settingRows({ settings: on, ctx, all: true });
const row = (key: string) => allRows.find((r) => r.key === key);
check("gentle printing is a row", row("supportSlowFragile")?.label === "Print supports gently", JSON.stringify(row("supportSlowFragile")));
check("the gentle speed is in mm/s and Auto by default", row("supportGentleSpeedMmS")?.unit === "mm/s" && row("supportGentleSpeedMmS")?.default === null, JSON.stringify(row("supportGentleSpeedMmS")));
check("the gentle accel is in mm/s²", row("supportGentleAccelMmS2")?.unit === "mm/s²" && row("supportGentleAccelMmS2")?.label === "Gentle accel", JSON.stringify(row("supportGentleAccelMmS2")));
check("the gentle values depend on gentle printing", row("supportGentleAccelMmS2")?.dependsOn === "supportSlowFragile");
const beltRows = settingRows({ settings: on, ctx: { belt: true, lineWidth: 0.45 }, all: true });
const beltRow = (key: string) => beltRows.find((r) => r.key === key);
check("belt anchor lines are a row, on by default", beltRow("supportBeltAnchors")?.label === "Belt anchor lines" && beltRow("supportBeltAnchors")?.default === true, JSON.stringify(beltRow("supportBeltAnchors")));
check("the anchor spacing is in mm, 10 by default", beltRow("supportBeltAnchorMm")?.unit === "mm" && beltRow("supportBeltAnchorMm")?.default === 10, JSON.stringify(beltRow("supportBeltAnchorMm")));
const spaced = applySetting(on, "supportBeltAnchorMm", 15, { belt: true, lineWidth: 0.45 });
check("an anchor spacing is taken", "settings" in spaced && spaced.settings.supportBeltAnchorMm === 15, JSON.stringify(spaced));
const anchorsOff = applySetting(on, "supportBeltAnchors", false, { belt: true, lineWidth: 0.45 });
check("belt anchors can be turned off", "settings" in anchorsOff && anchorsOff.settings.supportBeltAnchors === false, JSON.stringify(anchorsOff));
check("thin belt edges are a row, off by default", beltRow("supportBeltHoldThin")?.label === "Support thin belt edges" && beltRow("supportBeltHoldThin")?.default === false && beltRow("supportBeltHoldThin")?.type === "check", JSON.stringify(beltRow("supportBeltHoldThin")));
check("thin belt edges say what they cost", !!beltRow("supportBeltHoldThin")?.help?.includes("30 %"));
const thin = applySetting(on, "supportBeltHoldThin", true, { belt: true, lineWidth: 0.45 });
check("thin belt edges can be turned on", "settings" in thin && thin.settings.supportBeltHoldThin === true, JSON.stringify(thin));
check("thin belt edges read back on", "settings" in thin && settingRows({ settings: thin.settings, ctx: { belt: true, lineWidth: 0.45 } }).some((r) => r.key === "supportBeltHoldThin" && r.value === true));
check("thin belt edges take only true or false", "reason" in applySetting(on, "supportBeltHoldThin", 1, ctx));
check("thin belt edges on a flat printer warn that the slice leaves them out", beltOnlyWarning("supportBeltHoldThin", true, ctx)?.includes("belt printer") === true);
check("no warning on a belt", beltOnlyWarning("supportBeltHoldThin", true, { belt: true, lineWidth: 0.45 }) === null);
check("no warning when turned off", beltOnlyWarning("supportBeltHoldThin", false, ctx) === null);
check("the bridge limit is a row in mm, 0 by default", row("supportBridgeMm")?.unit === "mm" && row("supportBridgeMm")?.default === 0 && row("supportBridgeMm")?.max === 50, JSON.stringify(row("supportBridgeMm")));
const bridged = set(on, "supportBridgeMm", 5);
check("a bridge limit is taken", "settings" in bridged && bridged.settings.supportBridgeMm === 5, JSON.stringify(bridged));
check("a bridge limit reads back", "settings" in bridged && settingRows({ settings: bridged.settings, ctx }).some((r) => r.key === "supportBridgeMm" && r.value === 5));
const tooLong = set(on, "supportBridgeMm", 80);
check("a bridge limit past 50 mm is refused", "reason" in tooLong && tooLong.reason.includes("50"), JSON.stringify(tooLong));
check("a bridge limit says it does nothing while supports are off", inactiveWarning({ ...DEFAULT_PRESET, supports: false, supportBridgeMm: 5 }, "supportBridgeMm")?.includes("supports is off") === true);
check("the support brim is one row for every style", row("supportTreeBrimMm")?.label === "Support brim" && row("supportTreeBrimMm")?.unit === "mm");
const gentle = set(on, "supportGentleAccelMmS2", 1500);
check("a gentle accel is taken", "settings" in gentle && gentle.settings.supportGentleAccelMmS2 === 1500, JSON.stringify(gentle));
const autoAccel = "settings" in gentle ? set(gentle.settings, "supportGentleAccelMmS2", null) : gentle;
check("null puts the gentle accel back to Auto", "settings" in autoAccel && autoAccel.settings.supportGentleAccelMmS2 === null, JSON.stringify(autoAccel));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("settings rows: supports booleans, choice checks, listed options ok");
