import { DEFAULT_PRESET, presetKeys } from "../presets.ts";
import { CONTROLS, GROUPS, PANEL_GROUPS, STRATEGY_ROWS, UNFIELDED_PRESET_KEYS, controlById, fieldControls, lockedReason, shownAtLevel, strategyCard } from "./settings-schema.ts";
import { ARCS_OFF_REASON, LOCKABLE, settingsRules } from "../settings-rules.ts";

let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

const ids = CONTROLS.map((spec) => spec.id);
check("ids are unique", new Set(ids).size === ids.length);
check("group ids are unique", new Set(GROUPS.map((group) => group.id)).size === GROUPS.length);

const tiers = new Set(["simple", "advanced", "expert"]);
check("every control tier is valid", CONTROLS.every((spec) => tiers.has(spec.tier)));
check("every group tier is valid", GROUPS.every((group) => tiers.has(group.tier)));

const groupIds = new Set<string>([...GROUPS.map((group) => group.id), "calibrate", "gear"]);
check("every control names a known group", CONTROLS.every((spec) => groupIds.has(spec.group)));
check("panel groups are the GROUPS table in order", PANEL_GROUPS.join(",") === GROUPS.map((group) => group.id).join(","));

for (const spec of CONTROLS) {
  if (!spec.parent) continue;
  const parent = controlById(spec.parent);
  check(`${spec.id}: parent ${spec.parent} exists`, !!parent);
  check(`${spec.id}: parent is in the same group`, parent?.group === spec.group);
  check(`${spec.id}: shows no lower than its parent`, !!parent && shownAtLevel(parent.tier, spec.tier));
}

const covered = new Map<string, string[]>();
for (const spec of CONTROLS) {
  if (!spec.preset) continue;
  covered.set(spec.preset, [...(covered.get(spec.preset) ?? []), spec.id]);
}
for (const key of presetKeys()) {
  const owners = covered.get(key) ?? [];
  if (UNFIELDED_PRESET_KEYS.has(key)) {
    check(`${key}: unfielded key has no control`, owners.length === 0);
  } else {
    check(`${key}: exactly one control (${owners.join(",")})`, owners.length === 1);
  }
}

check("every field has get and set", fieldControls().every((spec) => typeof spec.get === "function" && typeof spec.set === "function"));
check("custom slots have neither", CONTROLS.filter((spec) => spec.kind.type === "custom").every((spec) => !spec.get && !spec.set));

// A bound control writes the value it reads back.
const sample = { ...DEFAULT_PRESET, profile: { bedX: 220, bedY: 220, bedZ: 250, maxVolumetricMm3S: 12, maxAccel: 10000, filamentDensityGCm3: 1.24, filamentCostPerKg: 20, nozzleDiameter: 0.4 }, paStart: 0, paEnd: 0.08, paStep: 0.005, flowStart: 0.9, flowEnd: 1.1, flowStep: 0.05, tempStart: 190, tempEnd: 230, tempStep: 5, retractStart: 0.2, retractEnd: 1.2, retractStep: 0.2 } as unknown as Parameters<NonNullable<typeof CONTROLS[number]["get"]>>[0];
const lh = controlById("lh")!;
lh.set!(sample, 0.28);
check("layer height round-trips", lh.get!(sample) === 0.28);
const weight = controlById("weight")!;
weight.set!(sample, 75);
check("toughness weight is stored as a fraction", sample.toughness === 0.75 && weight.get!(sample) === 75);
const ironflow = controlById("ironflow")!;
ironflow.set!(sample, 25);
check("ironing flow is stored as a fraction", sample.ironingFlow === 0.25 && ironflow.get!(sample) === 25);
const bedx = controlById("bedx")!;
bedx.set!(sample, 300);
check("bed X edits the profile", sample.profile.bedX === 300);

const minTime = controlById("minlayer");
const minSpeed = controlById("minlayerspd");
check("minimum layer time is an Advanced speed setting", minTime?.group === "speed" && minTime.tier === "advanced" && minTime.preset === "minLayerTimeS");
check("the slowest speed is an Expert setting under it", minSpeed?.group === "speed" && minSpeed.tier === "expert" && minSpeed.parent === "minlayer" && minSpeed.preset === "minLayerSpeedMmS");
check("the minimum is off (0 s) by default, with a 15 mm/s floor ready", minTime?.get!(sample) === 0 && minSpeed?.get!(sample) === 15 && DEFAULT_PRESET.minLayerTimeS === 0 && DEFAULT_PRESET.minLayerSpeedMmS === 15);
check("the slowest speed hides while the minimum is 0", minSpeed?.when!({ ...sample, minLayerTimeS: 8 }) === true && minSpeed?.when!(sample) === false);
check("both explain themselves", !!minTime?.tip && !!minSpeed?.tip);

check("strategy rows cover the five cards", STRATEGY_ROWS.map((row) => row.id).join(",") === "speed,efficiency,toughness,layer,region");
check("single speed is the speed card", strategyCard({ blendKind: "single", strategy: "speed" }) === "speed");
check("weight is the efficiency card", strategyCard({ blendKind: "weight", strategy: "speed" }) === "efficiency");
check("by region is the region card", strategyCard({ blendKind: "byRegion", strategy: "toughness" }) === "region");

check("simple shows simple", shownAtLevel("simple", "simple"));
check("simple hides expert", !shownAtLevel("expert", "simple"));
check("expert shows advanced", shownAtLevel("advanced", "expert"));

// Each panel group has at least one row that shows in Simple or is itself an Advanced group.
for (const group of GROUPS) {
  const rows = CONTROLS.filter((spec) => spec.group === group.id);
  check(`${group.id}: has controls`, rows.length > 0);
  check(`${group.id}: group tier is no higher than its lowest control`, rows.some((spec) => shownAtLevel(spec.tier, group.tier)));
}

// The panel is 300 px wide: a strategy descriptor and a group summary must fit without a cut word.
check("strategy descriptors are short and carry a full tip", STRATEGY_ROWS.every((row) => row.copy.length <= 22 && row.tip.length > row.copy.length - 4));
const summaryOf = (id: string, s: Record<string, unknown>) => GROUPS.find((group) => group.id === id)!.summary(s as never, { belt: false, lineWidth: 0.45 });
check("infill summary reads auto by default", summaryOf("infill", { gyroid3d: "blend", infillCombine: false }) === "auto");
check("infill summary names the lattice and the combine", summaryOf("infill", { gyroid3d: "on", infillCombine: true }) === "3D gyroid · combined");
check("walls summary counts extra surface effects", summaryOf("walls", { seam: "blend", ironing: true, fuzzySkin: true }) === "blend seam · +2");
check("walls summary names one effect", summaryOf("walls", { seam: "rear", ironing: false, fuzzySkin: true }) === "rear seam · fuzzy");
check("speed summary is one or two values", summaryOf("speed", { featureSpeeds: true, zHop: "smart" }) === "per feature · z-hop");
check("supports summary reads Off", summaryOf("supports", { supports: false, supportSource: "auto" }) === "Off");
check("supports summary reads Auto", summaryOf("supports", { supports: true, supportSource: "auto" }) === "Auto");
check("supports summary reads Painted", summaryOf("supports", { supports: true, supportSource: "paint" }) === "Painted");

// One Simple control picks Off, Automatic or Painted only, and sets the two keys behind it together.
const mode = controlById("supportMode")!;
check("the supports mode is a Simple segmented control", mode?.group === "supports" && mode.tier === "simple" && mode.kind.type === "segmented" && mode.preset === "supports");
check("the supports mode offers Off, Automatic, Painted only in that order", mode?.kind.type === "segmented" && mode.kind.options.map(([v, l]) => `${v}:${l}`).join(",") === "off:Off,auto:Automatic,paint:Painted only");
check("the supports mode is the first row of its group", CONTROLS.find((spec) => spec.group === "supports")?.id === "supportMode");
const modeState = { ...sample };
mode.set!(modeState, "paint");
check("picking Painted only turns supports on from paint", modeState.supports === true && modeState.supportSource === "paint" && mode.get!(modeState) === "paint");
mode.set!(modeState, "auto");
check("picking Automatic turns supports on from the angle", modeState.supports === true && modeState.supportSource === "auto" && mode.get!(modeState) === "auto");
mode.set!(modeState, "off");
check("picking Off turns supports off", modeState.supports === false && mode.get!(modeState) === "off");
const angle = controlById("sangle")!;
check("the overhang angle shows while supports are on, and the rules hide it for Painted only", angle.when!({ ...sample, supports: true }) === true && angle.when!({ ...sample, supports: false }) === false && angle.rule === "supportAngle");
check("the style stays for Painted only", controlById("sstyle")!.when!({ ...sample, supports: true, supportSource: "paint" }) === true);
check("supportSource has no control of its own", UNFIELDED_PRESET_KEYS.has("supportSource"));

for (const group of GROUPS) {
  const worst =summaryOf(group.id, { layerHeight: 0.28, adaptive: true, seam: "aligned", ironing: true, fuzzySkin: true, gyroid3d: "on", infillCombine: true, featureSpeeds: true, zHop: "always", supports: true, supportStyle: "tree", supportAngle: 45, placed: {}, plate: { objects: [1] }, blendKind: "single", strategy: "speed", profile: { bedX: 220, bedY: 220, maxVolumetricMm3S: 15, fanPercent: 100, overhangFanPercent: 100 } });
  check(`${group.id}: summary fits the header (${worst})`, worst.length <= 24);
}

// The Arc fit row is locked, with its reason, on a printer whose firmware takes no arcs.
const arcRow = controlById("arcs")!;
const ir3Rules = settingsRules({ kind: "belt", belt: { raftLayers: 0, maxLengthMm: null }, firmware: "klipper", firmwareArcs: false, objects: 1 });
check("the Arc fit row on the IR3 V2 is locked with the firmware reason", lockedReason(arcRow, ir3Rules) === ARCS_OFF_REASON.klipper);
check("the reason says the firmware takes no arcs", (lockedReason(arcRow, ir3Rules) ?? "").startsWith("This printer's firmware doesn't accept G2/G3 arcs"));
check("the Arc fit row is free on a printer that takes arcs", lockedReason(arcRow, settingsRules({ kind: "cartesian", belt: { raftLayers: 0, maxLengthMm: null }, firmware: "marlin", objects: 1 })) === undefined);
check("a row without a rule is never locked", lockedReason(controlById("travelopt")!, ir3Rules) === undefined);
check("every control a rule can lock is a check", CONTROLS.filter((spec) => spec.rule && LOCKABLE.has(spec.rule)).every((spec) => spec.kind.type === "check"));
check("the Arc fit row is lockable", arcRow.rule !== undefined && LOCKABLE.has(arcRow.rule));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("settings-schema: ids, tiers, parents and preset coverage ok");
