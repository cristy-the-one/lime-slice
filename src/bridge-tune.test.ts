import { bridgeSliceFields } from "./bridge-tune.ts";
import { DEFAULT_PRESET, readPresetSettings } from "./presets.ts";

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

const zero = {
  overhangControl: true,
  bridgeFlowRatio: 0,
  bridgeSpeedMmS: 0,
  bridgeFanPercent: 0,
};
check("zeros stay off the request", Object.keys(bridgeSliceFields(zero)).length === 0);
check(
  "a flow of 1 stays off the request",
  bridgeSliceFields({ ...zero, bridgeFlowRatio: 1 }).bridgeFlowRatio === undefined,
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

const {
  bridgeFlowRatio: _flow,
  bridgeSpeedMmS: _speed,
  bridgeFanPercent: _fan,
  ...old
} = DEFAULT_PRESET;
check(
  "a file from before bridge tuning reads as zero",
  readPresetSettings(old)?.bridgeFlowRatio === 0 &&
    readPresetSettings(old)?.bridgeSpeedMmS === 0 &&
    readPresetSettings(old)?.bridgeFanPercent === 0,
);
