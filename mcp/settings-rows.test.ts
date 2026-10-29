import { DEFAULT_PRESET, type PresetSettings } from "../src/presets.ts";
import { applyObjectSetting, applySetting, settingRows } from "./settings-rows.ts";

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

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("settings rows: supports booleans, choice checks, listed options ok");
