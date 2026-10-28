import { supportSliceFields } from "./support-interface.ts";
import { DEFAULT_PRESET, parseLegacyPresets, readPresetSettings, type PresetSettings } from "./presets.ts";
import { parseSettingsProfile, serializeSettingsProfile } from "./ui/settings-profiles.ts";
import { controlById } from "./ui/settings-schema.ts";

function check(name: string, ok: boolean) {
  if (!ok) throw new Error(name);
  console.log(name);
}

const off = {
  supports: false,
  supportStyle: "tree",
  supportZGapMm: 0.4,
  supportXyGapMm: 0.8,
  supportInterfaceLayers: 2,
  supportTreeBrimMm: 4,
};
check("supports off omits the interface", Object.keys(supportSliceFields(off)).length === 0);

const auto = {
  supports: true,
  supportStyle: "tree",
  supportZGapMm: null,
  supportXyGapMm: null,
  supportInterfaceLayers: null,
  supportTreeBrimMm: 0,
};
check("Auto stays off the request", Object.keys(supportSliceFields(auto)).length === 0);
check("the default settings are Auto in all three", DEFAULT_PRESET.supportZGapMm === null && DEFAULT_PRESET.supportXyGapMm === null && DEFAULT_PRESET.supportInterfaceLayers === null);

const zero = supportSliceFields({ ...auto, supportZGapMm: 0, supportXyGapMm: 0, supportInterfaceLayers: 0 });
check("a typed 0 z gap is sent as 0", zero.supportZGapMm === 0);
check("a typed 0 xy gap is sent as 0", zero.supportXyGapMm === 0);
check("0 interface layers are sent as 1, the fewest the engine prints", zero.supportInterfaceLayers === 1);
check("a tree brim of 0 is still no brim", zero.supportTreeBrimMm === undefined);
check("a typed 0 beside Auto sends only the 0", JSON.stringify(supportSliceFields({ ...auto, supportXyGapMm: 0 })) === '{"supportXyGapMm":0}');

const sent = supportSliceFields({
  supports: true,
  supportStyle: "tree",
  supportZGapMm: 0.35,
  supportXyGapMm: 0.9,
  supportInterfaceLayers: 2,
  supportTreeBrimMm: 4,
});
check("a z gap is sent", sent.supportZGapMm === 0.35);
check("an xy gap is sent", sent.supportXyGapMm === 0.9);
check("interface layers are sent", sent.supportInterfaceLayers === 2);
check("a tree brim is sent", sent.supportTreeBrimMm === 4);
check("interface layers are held to the most the engine takes", supportSliceFields({ ...auto, supportInterfaceLayers: 20 }).supportInterfaceLayers === 8);
check("a number that is not finite is Auto", Object.keys(supportSliceFields({ ...auto, supportZGapMm: Number.NaN })).length === 0);

const grid = supportSliceFields({ ...auto, supportStyle: "grid", supportTreeBrimMm: 4, supportZGapMm: 0.2 });
check("a grid keeps the z gap and drops the brim", grid.supportZGapMm === 0.2 && grid.supportTreeBrimMm === undefined);

const {
  supportZGapMm: _z,
  supportXyGapMm: _xy,
  supportInterfaceLayers: _n,
  supportTreeBrimMm: _b,
  ...old
} = DEFAULT_PRESET;
const read = readPresetSettings(old);
check(
  "a file from before the support interface reads as Auto and no brim",
  read?.supportZGapMm === null && read?.supportXyGapMm === null && read?.supportInterfaceLayers === null && read?.supportTreeBrimMm === 0,
);

const { supportGapsAuto: _marker, ...unmarked } = DEFAULT_PRESET;
const legacy = readPresetSettings({ ...unmarked, supportZGapMm: 0, supportXyGapMm: 0.7, supportInterfaceLayers: 0 });
check("a file from when 0 meant Auto reads 0 as Auto and keeps a typed gap", legacy?.supportZGapMm === null && legacy?.supportXyGapMm === 0.7 && legacy?.supportInterfaceLayers === null);
check("a file with a gap that is not a number is refused", readPresetSettings({ ...DEFAULT_PRESET, supportZGapMm: "0" }) === null);
const typed: PresetSettings = { ...DEFAULT_PRESET, supportZGapMm: 0, supportXyGapMm: 0, supportInterfaceLayers: 1 };
const reread = readPresetSettings(JSON.parse(JSON.stringify(typed)));
check("a typed 0 survives being written and read", reread?.supportZGapMm === 0 && reread?.supportXyGapMm === 0 && reread?.supportInterfaceLayers === 1);

const profile = parseSettingsProfile(serializeSettingsProfile({ version: 1, name: "Belt", settings: typed, level: "advanced" }));
check("a profile file keeps a typed 0", profile.ok && profile.profile.settings.supportZGapMm === 0 && profile.profile.settings.supportXyGapMm === 0);
const olderProfile = parseSettingsProfile(JSON.stringify({ version: 1, name: "Old", settings: { ...unmarked, supportZGapMm: 0, supportXyGapMm: 0, supportInterfaceLayers: 0 }, level: "advanced" }));
check("a profile file from when 0 meant Auto opens as Auto", olderProfile.ok && olderProfile.profile.settings.supportZGapMm === null && olderProfile.profile.settings.supportInterfaceLayers === null);
const legacyPresets = parseLegacyPresets(JSON.stringify({ Old: { supportZGapMm: 0, supportXyGapMm: 0.6 } }));
check("a preset from before profiles reads 0 as Auto", legacyPresets.Old?.supportZGapMm === null && legacyPresets.Old?.supportXyGapMm === 0.6);

const z = controlById("szgap")!;
const state = { ...DEFAULT_PRESET, layerHeight: 0.16 } as never;
check("an Auto box is empty and says Auto", z.get!(state) === "" && z.placeholder!(state) === "Auto");
z.set!(state, 0);
check("a typed 0 is a stored 0 that shows as 0", (state as PresetSettings).supportZGapMm === 0 && z.get!(state) === 0);
z.set!(state, "");
check("an emptied box is Auto again", (state as PresetSettings).supportZGapMm === null && z.get!(state) === "");
const layers = controlById("sifacel")!;
layers.set!(state, 0);
check("0 interface layers are stored as 1", (state as PresetSettings).supportInterfaceLayers === 1);
layers.set!(state, "");
check("an emptied interface layers box is Auto", (state as PresetSettings).supportInterfaceLayers === null && layers.placeholder!(state) === "Auto");
check("the xy gap says Auto", controlById("sxygap")!.placeholder!(state) === "Auto");
