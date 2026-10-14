import { supportSliceFields } from "./support-interface.ts";
import { DEFAULT_PRESET, readPresetSettings } from "./presets.ts";

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

const zero = {
  supports: true,
  supportStyle: "tree",
  supportZGapMm: 0,
  supportXyGapMm: 0,
  supportInterfaceLayers: 0,
  supportTreeBrimMm: 0,
};
check("zeros stay off the request", Object.keys(supportSliceFields(zero)).length === 0);

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

const grid = supportSliceFields({ ...zero, supportStyle: "grid", supportTreeBrimMm: 4, supportZGapMm: 0.2 });
check("a grid keeps the z gap and drops the brim", grid.supportZGapMm === 0.2 && grid.supportTreeBrimMm === undefined);

const {
  supportZGapMm: _z,
  supportXyGapMm: _xy,
  supportInterfaceLayers: _n,
  supportTreeBrimMm: _b,
  ...old
} = DEFAULT_PRESET;
check(
  "a file from before the support interface reads as zero",
  readPresetSettings(old)?.supportZGapMm === 0 &&
    readPresetSettings(old)?.supportInterfaceLayers === 0 &&
    readPresetSettings(old)?.supportTreeBrimMm === 0,
);
