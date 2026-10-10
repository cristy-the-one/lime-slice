import { DEFAULT_PRESET, presetKeys } from "../presets.ts";
import { CONTROLS, GROUPS, PANEL_GROUPS, STRATEGY_ROWS, UNFIELDED_PRESET_KEYS, controlById, fieldControls, shownAtLevel, strategyCard } from "./settings-schema.ts";

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

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("settings-schema: ids, tiers, parents and preset coverage ok");
