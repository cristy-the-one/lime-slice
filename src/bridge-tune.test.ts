import { BRIDGE_LIMITS, bridgeSliceFields, readBridgeValue } from "./bridge-tune.ts";
import { DEFAULT_PRESET, parseLegacyPresets, readPresetSettings, type PresetSettings } from "./presets.ts";
import { parseSettingsProfile, serializeSettingsProfile } from "./ui/settings-profiles.ts";
import { controlById } from "./ui/settings-schema.ts";

function check(name: string, ok: boolean) {
  if (!ok) throw new Error(name);
  console.log(name);
}

const off = {
  overhangControl: false,
  bridgeFlowRatio: 0.9,
  bridgeSpeedMmS: 15,
  bridgeFanPercent: 80,
};
check("overhang off omits the tune", Object.keys(bridgeSliceFields(off)).length === 0);

const auto = {
  overhangControl: true,
  bridgeFlowRatio: null,
  bridgeSpeedMmS: null,
  bridgeFanPercent: null,
};
check("Auto stays off the request", Object.keys(bridgeSliceFields(auto)).length === 0);
check("the default settings are Auto in all three", DEFAULT_PRESET.bridgeFlowRatio === null && DEFAULT_PRESET.bridgeSpeedMmS === null && DEFAULT_PRESET.bridgeFanPercent === null);
check(
  "a flow of 1 stays off the request",
  bridgeSliceFields({ ...auto, bridgeFlowRatio: 1 }).bridgeFlowRatio === undefined,
);

const sent = bridgeSliceFields({
  overhangControl: true,
  bridgeFlowRatio: 0.9,
  bridgeSpeedMmS: 15,
  bridgeFanPercent: 80,
});
check("flow is sent", sent.bridgeFlowRatio === 0.9);
check("speed is sent", sent.bridgeSpeedMmS === 15);
check("fan is sent", sent.bridgeFanPercent === 80);
check(
  "the request is held to the engine's own range",
  JSON.stringify(bridgeSliceFields({ overhangControl: true, bridgeFlowRatio: 0.1, bridgeSpeedMmS: 2, bridgeFanPercent: 0.4 })) === '{"bridgeFlowRatio":0.2,"bridgeSpeedMmS":5,"bridgeFanPercent":1}',
);

// A file stores what the request sent before Auto existed: 0 was Auto, and a number outside the range printed at the bound.
check("a stored 0 is Auto", readBridgeValue("bridgeFlowRatio", 0) === null && readBridgeValue("bridgeSpeedMmS", 0) === null && readBridgeValue("bridgeFanPercent", 0) === null);
check("a stored flow of 0.1 reads as the 0.2 it printed", readBridgeValue("bridgeFlowRatio", 0.1) === 0.2);
check("a stored speed of 2 reads as the 5 it printed", readBridgeValue("bridgeSpeedMmS", 2) === 5);
check("a stored flow of 3 reads as the 2 it printed", readBridgeValue("bridgeFlowRatio", 3) === 2);
check("a stored value that is not a number is refused", readBridgeValue("bridgeFanPercent", "80") === undefined);
const zeros = { ...DEFAULT_PRESET, bridgeFlowRatio: 0, bridgeSpeedMmS: 0, bridgeFanPercent: 0 };
check("zeros send the same request as Auto", JSON.stringify(bridgeSliceFields({ ...zeros, overhangControl: true })) === JSON.stringify(bridgeSliceFields(auto)));
for (const [flow, speed, fan] of [[0.1, 2, 0.4], [0.95, 25, 80], [3, 500, 250], [1, 0, 0], [-1, -1, -1], [0.2004, 4.96, 1.4]]) {
  const before = bridgeSliceFields({ overhangControl: true, bridgeFlowRatio: flow, bridgeSpeedMmS: speed, bridgeFanPercent: fan });
  const read = readPresetSettings({ ...DEFAULT_PRESET, bridgeFlowRatio: flow, bridgeSpeedMmS: speed, bridgeFanPercent: fan });
  const after = read && bridgeSliceFields({ ...read, overhangControl: true });
  check(`a file with ${flow}, ${speed}, ${fan} sends the request it sent before`, JSON.stringify(after) === JSON.stringify(before));
}

const {
  bridgeFlowRatio: _flow,
  bridgeSpeedMmS: _speed,
  bridgeFanPercent: _fan,
  ...old
} = DEFAULT_PRESET;
const fromBefore = readPresetSettings(old);
check(
  "a file from before bridge tuning reads as Auto",
  fromBefore?.bridgeFlowRatio === null && fromBefore?.bridgeSpeedMmS === null && fromBefore?.bridgeFanPercent === null,
);
const fromZeros = readPresetSettings(zeros);
check("a file from when 0 meant Auto reads as Auto", fromZeros?.bridgeFlowRatio === null && fromZeros?.bridgeSpeedMmS === null && fromZeros?.bridgeFanPercent === null);
const typed: PresetSettings = { ...DEFAULT_PRESET, bridgeFlowRatio: 0.85, bridgeSpeedMmS: 20, bridgeFanPercent: 100 };
const reread = readPresetSettings(JSON.parse(JSON.stringify(typed)));
check("a set value survives being written and read", reread?.bridgeFlowRatio === 0.85 && reread?.bridgeSpeedMmS === 20 && reread?.bridgeFanPercent === 100);
const profile = parseSettingsProfile(serializeSettingsProfile({ version: 1, name: "Bridges", settings: typed, level: "advanced" }));
check("a profile file keeps a set value", profile.ok && profile.profile.settings.bridgeFlowRatio === 0.85);
const olderProfile = parseSettingsProfile(JSON.stringify({ version: 1, name: "Old", settings: zeros, level: "advanced" }));
check("a profile file from when 0 meant Auto opens as Auto", olderProfile.ok && olderProfile.profile.settings.bridgeFlowRatio === null && olderProfile.profile.settings.bridgeFanPercent === null);
const legacyPresets = parseLegacyPresets(JSON.stringify({ Old: { bridgeFlowRatio: 0, bridgeSpeedMmS: 18 } }));
check("a preset from before profiles reads 0 as Auto", legacyPresets.Old?.bridgeFlowRatio === null && legacyPresets.Old?.bridgeSpeedMmS === 18);

const state = { ...DEFAULT_PRESET } as never;
for (const [id, key] of [["bflow", "bridgeFlowRatio"], ["bspeed", "bridgeSpeedMmS"], ["bfan", "bridgeFanPercent"]] as const) {
  const control = controlById(id)!;
  check(`${id} is empty and says Auto`, control.get!(state) === "" && control.placeholder!(state) === "Auto");
  check(`${id} takes the engine's range`, control.kind.type === "number" && control.kind.min === BRIDGE_LIMITS[key].min && control.kind.max === BRIDGE_LIMITS[key].max);
  control.set!(state, BRIDGE_LIMITS[key].min);
  check(`${id} keeps a set value`, (state as PresetSettings)[key] === BRIDGE_LIMITS[key].min && control.get!(state) === BRIDGE_LIMITS[key].min);
  control.set!(state, "");
  check(`${id} emptied is Auto again`, (state as PresetSettings)[key] === null && control.get!(state) === "");
}
const flowTip = controlById("bflow")!.tip ?? "";
check("the flow tip says it is a ratio, 1 is normal, the usual 0.8–1.0, and the range", /ratio of normal flow/.test(flowTip) && /1 is normal/.test(flowTip) && /0\.8–1\.0/.test(flowTip) && /0\.2–2/.test(flowTip) && /Auto: 1\b/.test(flowTip));
check("the speed tip says the Auto slowdown", /Auto: bridges slow to 18–36 mm\/s/.test(controlById("bspeed")!.tip ?? ""));
check("the fan tip says the Auto fan", /Auto: bridges take Overhang fan %/.test(controlById("bfan")!.tip ?? ""));
