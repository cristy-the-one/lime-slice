import {
  addDiskToRegion,
  allReinforceDisks,
  defaultReinforceVolume,
  dropEmptyReinforce,
  emptyPaintRegion,
  moveReinforceVolume,
  normalInfillDensity,
  readReinforcement,
  reinforceDiskFromHit,
  reinforcementRequestFields,
  reinforceStrokeTakes,
  scaleReinforceVolume,
  totalReinforceDisks,
  type ReinforceDisk,
  type ReinforceRegion,
} from "./reinforcement.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const frame = { centre: [10, 20, 30] as [number, number, number], scale: 2 };
const dab: ReinforceDisk = { p: [11, 22, 33], n: [0, 0, 1], r: 3 };

check(
  "an empty reinforcement list is omitted",
  !("reinforcement" in reinforcementRequestFields([], frame, 0.12)),
);

const firstAdd = addDiskToRegion([], 0, dab, { depthMm: 5, fillThrough: false });
check(
  "the first stroke creates a paint region at density 1, depth 5, fillThrough false",
  firstAdd.regions.length === 1 &&
    firstAdd.activeIndex === 0 &&
    firstAdd.regions[0]?.kind === "paint" &&
    firstAdd.regions[0]?.density === 1 &&
    firstAdd.regions[0]?.depthMm === 5 &&
    !firstAdd.regions[0]?.fillThrough &&
    firstAdd.regions[0]?.disks.length === 1,
);

const secondDab: ReinforceDisk = { p: [14, 22, 33], n: [0, 0, 1], r: 3 };
const secondAdd = addDiskToRegion(firstAdd.regions, firstAdd.activeIndex, secondDab, {
  depthMm: 5,
  fillThrough: false,
});
check(
  "a second stroke appends to the active paint region",
  secondAdd.regions.length === 1 &&
    secondAdd.regions[0]?.kind === "paint" &&
    secondAdd.regions[0]?.disks.length === 2,
);

check(
  "stroke spacing rejects close dabs on the same face",
  !reinforceStrokeTakes(dab, { p: [11.2, 22, 33], n: [0, 0, 1], r: 3 }) &&
    reinforceStrokeTakes(dab, secondDab),
);

const sent = reinforcementRequestFields(secondAdd.regions, frame, 0.12);
check(
  "a paint region above normal density is sent in the mesh frame with scaled depth and radii",
  sent.reinforcement?.length === 1 &&
    sent.reinforcement[0]?.kind === "paint" &&
    sent.reinforcement[0]?.density === 1 &&
    sent.reinforcement[0]?.depthMm === 10 &&
    !("fillThrough" in sent.reinforcement[0]!) &&
    sent.reinforcement[0]?.disks.length === 2 &&
    sent.reinforcement[0]?.disks[0]?.p[0] === 12 &&
    sent.reinforcement[0]?.disks[0]?.r === 6,
  JSON.stringify(sent),
);

const throughRegion: ReinforceRegion = {
  kind: "paint",
  density: 0.6,
  depthMm: 5,
  fillThrough: true,
  disks: [dab],
};
const sentThrough = reinforcementRequestFields([throughRegion], { centre: [0, 0, 0], scale: 1 }, 0.12);
check(
  "fillThrough is sent when true",
  sentThrough.reinforcement?.[0]?.kind === "paint" && sentThrough.reinforcement[0].fillThrough === true,
);

const atNormal: ReinforceRegion = {
  kind: "paint",
  density: 0.12,
  depthMm: 5,
  disks: [dab],
};
check(
  "every region at or below normal density omits the reinforcement field",
  !("reinforcement" in reinforcementRequestFields([atNormal], frame, 0.12)),
);

const emptyPaint = emptyPaintRegion(1, 5, false);
check(
  "an empty paint region is omitted from the request and dropped on Done",
  !("reinforcement" in reinforcementRequestFields([emptyPaint], frame, 0.12)) &&
    dropEmptyReinforce([emptyPaint, throughRegion]).length === 1,
);

const boxRegion: ReinforceRegion = {
  kind: "box",
  density: 0.8,
  center: [15, 25, 35],
  size: [10, 12, 14],
};
const sentBox = reinforcementRequestFields([boxRegion], frame, 0.25);
check(
  "a box volume is transformed into the mesh frame",
  sentBox.reinforcement?.[0]?.kind === "box" &&
    sentBox.reinforcement[0].center[0] === 20 &&
    sentBox.reinforcement[0].size[0] === 20,
  JSON.stringify(sentBox),
);

const defCyl = defaultReinforceVolume("cylinder", { min: [0, 0, 0], max: [20, 20, 20] });
check(
  "defaultReinforceVolume places volume at bounds centre with 10 mm size",
  defCyl.kind === "cylinder" &&
    defCyl.density === 1 &&
    defCyl.center[0] === 10 &&
    defCyl.center[1] === 10 &&
    defCyl.center[2] === 10 &&
    defCyl.size[0] === 10 &&
    defCyl.size[1] === 10 &&
    defCyl.size[2] === 10,
  JSON.stringify(defCyl),
);

const movedCyl = moveReinforceVolume(defCyl, "x", 6, 2);
const scaledCyl = scaleReinforceVolume(movedCyl, "x", 4, 2);
check(
  "moveReinforceVolume and scaleReinforceVolume divide mesh delta by part scale",
  movedCyl.center[0] === 13 && scaledCyl.size[0] === 12,
  JSON.stringify({ movedCyl, scaledCyl }),
);

check(
  "normalInfillDensity follows the strategy or sparser side of a blend",
  Math.abs(normalInfillDensity({ blendKind: "single", strategy: "speed", toughness: 0 }) - 0.12) < 1e-6 &&
    Math.abs(normalInfillDensity({ blendKind: "single", strategy: "toughness", toughness: 1 }) - 0.48) < 1e-6 &&
    Math.abs(normalInfillDensity({ blendKind: "byLayer", strategy: "toughness", toughness: 1 }) - 0.12) < 1e-6 &&
    Math.abs(normalInfillDensity({ blendKind: "single", strategy: "speed", toughness: 0, objectInfill: 0.4 }) - 0.4) < 1e-6,
);

const hitDisk = reinforceDiskFromHit(
  [2, 4, 6],
  [0, 0, 1],
  4,
  { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], pivot: [10, 20, 30], translation: [2, 4, 6] },
  { centre: [10, 20, 30], scale: 2 },
);
check(
  "reinforceDiskFromHit stores source-frame point, normal, and radius",
  hitDisk.p[0] === 10 && hitDisk.p[1] === 20 && hitDisk.p[2] === 30 && hitDisk.r === 2,
  JSON.stringify(hitDisk),
);

check(
  "totalReinforceDisks and allReinforceDisks count paint disks across regions",
  totalReinforceDisks([secondAdd.regions[0]!, boxRegion, throughRegion]) === 3 &&
    allReinforceDisks([secondAdd.regions[0]!, boxRegion, throughRegion]).length === 3,
);

check(
  "a missing project list is empty",
  Array.isArray(readReinforcement(undefined)) && (readReinforcement(undefined) as ReinforceRegion[]).length === 0,
);
check(
  "a project list with paint and volume regions round-trips",
  JSON.stringify(readReinforcement([throughRegion, boxRegion])) === JSON.stringify([throughRegion, boxRegion]),
);
check(
  "a damaged project list is refused",
  readReinforcement([{ kind: "paint", density: 2, depthMm: 5, disks: [] }]) ===
    "The reinforcement in this project is damaged." &&
    readReinforcement([{ kind: "box", density: 0.5, center: [0, 0, 0], size: [0, 10, 10] }]) ===
      "The reinforcement in this project is damaged.",
);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("reinforcement: regions, request field, and project read ok");
