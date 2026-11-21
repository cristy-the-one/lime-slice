/**
 * The Auto ribs panel's state (src/auto-ribs.ts): wall clicks, zones as ribWall reads them, the goal from How much, the
 * run as events arrive, a rib taken out, the sentences of the result and after Apply, the stored request a History row
 * reopens with, and the preview's geometry (the rib under a ray, the boxes drawn).
 */
import { readFileSync } from "node:fs";
import { againstCase, alreadyEnough, bucklesAt, loadTimes, reachedShort } from "./auto-ribs-plan.ts";
import {
  applicable,
  cardFromRibNet,
  cardFromStored,
  caseResultLines,
  checkLines,
  clickWall,
  comparisonLines,
  costText,
  editedNote,
  gainText,
  goalLine,
  looseLine,
  goalOf,
  goalFromTool,
  engineMaterial,
  fallbackHzNote,
  frequencyAside,
  frequencyIgnoredLoads,
  ignoredLoadNote,
  frequencyFactorAt,
  idleRun,
  keptRibs,
  measuredLine,
  loadRequest,
  caseNames,
  duplicateCaseName,
  freeCaseName,
  newAutoRibsCard,
  newZone,
  resultNumbers,
  ribNetSource,
  ribSoup,
  ribUnderRay,
  runDone,
  runEvent,
  sliderNote,
  startedRun,
  toggleRemoved,
  totalsLine,
  wallLine,
  wallReadout,
  notOnWallLines,
  EVEN_PRESSURE_OFFER,
  zoneInputs,
  zoneLanded,
  zoneSoup,
  zoneTitle,
  type CheckNumbers,
} from "./auto-ribs.ts";
import { COMMANDS } from "./ui/commands.ts";
import { caseOutcomes, type RibPlanResult, type V3 } from "./auto-ribs-plan.ts";
import type { RibWallReport } from "./modeling/rib-wall.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const eq = (name: string, a: unknown, b: unknown) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// --- The menu item and the command.
const markup = readFileSync(new URL("./app/model/markup.ts", import.meta.url), "utf8");
check("Auto ribs… sits right before Stress… in the Features menu", /id="modelMenuAutoRibs"[^>]*>Auto ribs…<\/button>\s*\n\s*<button id="modelMenuStress"/.test(markup));
check("the card has its own pane", markup.includes('id="modelAutoRibs" data-card-for="auto-ribs"'));
const command = COMMANDS.find((row) => row.id === "model-auto-ribs");
eq("a Model command with no key", command ? [command.label, command.group, command.keys ?? []] : null, ["Auto ribs", "Model", []]);

// --- Wall clicks: a new face adds, a clicked one comes off, a grown one is excluded, an excluded one comes back.
let card = newAutoRibsCard();
card = clickWall(card, 6, []);
eq("a click adds the face", card.picked, [6]);
card = clickWall(card, 8, [6, 8]);
eq("a taken grown face is excluded", card.excluded, [8]);
card = clickWall(card, 8, [6]);
eq("clicked again it comes back", card.excluded, []);
card = clickWall(card, 6, [6]);
eq("a clicked face clicked again comes off", card.picked, []);

// --- Zones as ribWall reads them.
const zones = [
  newZone(1, "box", [60, 40, 2], 120, [0, 0, 1]),
  { ...newZone(2, "sphere", [10, 10, 2], 120, [0, 0, 1]), mode: "maxHeight" as const, maxHeightMm: 2.5, marginMm: 1 },
  newZone(3, "faces", [0, 0, 0], 120, [0, 0, 1]),
  newZone(4, "obstacle", [0, 0, 0], 120, [0, 0, 1], { object: "gone", name: "Lid" }),
  newZone(5, "nearHoles", [0, 0, 0], 120, [0, 0, 1]),
];
const read = zoneInputs(zones, (id) => (id === "here" ? new Float32Array(9) : null));
eq("a box is its centre and size", read.inputs[0], { region: { box: { centre: [60, 40, 2], size: [24, 24, 24] } }, mode: "noRibs" });
eq("a capped sphere keeps its cap and margin", read.inputs[1], { region: { sphere: { centre: [10, 10, 2], radius: 12 } }, mode: "maxHeight", maxHeightMm: 2.5, marginMm: 1 });
eq("faces with none picked yet, and a gone object, are left out; the gone one is said", [read.rows, read.gone], [[1, 2, 5], [4]]);
eq("near holes is a rule", read.inputs[2], { region: { near: { mm: 5, holes: true } }, mode: "noRibs" });
eq("titles", zones.map(zoneTitle), ["Box 24 × 24 × 24 mm at (60, 40, 2)", "Sphere r 12 mm at (10, 10, 2)", "0 faces", "Lid, 1 mm clear", "Within 5 mm of holes"]);
const cyl = newZone(6, "cylinder", [50, 50, 2], 100, [0, 0, 2]);
eq("a cylinder stands along the wall's normal, centred on the click", cyl.shape, { kind: "cylinder", origin: [50, 50, -8], axis: [0, 0, 1], radius: 10, length: 20 });
eq("where a zone landed", zoneLanded({ index: 0, kind: "box", triangles: 12, areaMm2: 1234.4, centre: null, bounds: null, how: "" }, false).text, "1,234 mm² of the wall");
eq("a zone that missed says so", zoneLanded({ index: 0, kind: "box", triangles: 0, areaMm2: 0, centre: null, bounds: null, how: "", missed: "The zone does not meet the wall; it was left out." }, false), { text: "The zone does not meet the wall; it was left out.", missed: true });
eq("an obstacle whose object left the plate", zoneLanded(undefined, true).missed, true);
check("a box's translucent shape is 12 triangles", zoneSoup(zones[0]!.shape).length === 12 * 9);

// --- How much.
eq("balanced", goalOf({ kind: "slider", stop: 0 }, 1.24, 3), { kind: "balanced" });
eq("off the middle with no balanced plan yet: balanced", goalOf({ kind: "slider", stop: 2 }, 1.24, null), { kind: "balanced" });
eq("stiffest: 1.75 × the balanced gain", goalOf({ kind: "slider", stop: 2 }, 1.24, 3), { kind: "stiffer", factor: 4.5 });
eq("lightest: half the balanced gain", goalOf({ kind: "slider", stop: -2 }, 1.24, 3), { kind: "stiffer", factor: 2 });
eq("a budget in grams is a volume", goalOf({ kind: "budget", grams: 1.24 }, 1.24, null), { kind: "budget", volumeMm3: 1000 });
eq("a deflection target", goalOf({ kind: "deflection", mm: 0.3 }, 1.24, null), { kind: "maxDeflection", mm: 0.3 });
check("the slider says what it needs", sliderNote({ kind: "slider", stop: 1 }, null).includes("needs a balanced plan"));

// --- The run: the fraction never goes back; ribs are added, changed and removed; the totals follow.
const ev = (change: "added" | "changed" | "removed", id: number, fraction: number, factor = 2) => ({ kind: "rib" as const, change, id, points: change === "removed" ? [] : ([[0, 0, 1], [10, 0, 1]] as V3[]), heights: change === "removed" ? [] : [6], ribs: 1, ribVolumeMm3: 72, compliance: 1, stiffnessFactor: factor, fraction });
let run = startedRun();
run = runEvent(run, { kind: "stage", stage: "choosing ribs", fraction: 0.3 });
run = runEvent(run, { kind: "stage", stage: "choosing ribs", fraction: 0.2 });
eq("the fraction never goes back", run.fraction, 0.3);
run = runEvent(run, ev("added", 4, 0.4));
run = runEvent(run, ev("added", 5, 0.5));
run = runEvent(run, { ...ev("changed", 4, 0.55), heights: [4] });
eq("a changed rib is replaced in place", run.ribs.map((r) => [r.id, r.heights[0]]), [[4, 4], [5, 6]]);
run = runEvent(run, ev("removed", 5, 0.6));
eq("a removed rib leaves", run.ribs.map((r) => r.id), [4]);
eq("the running line", totalsLine(run.totals, 1.24, 10000), "1 rib · +0.1 g, +0.7 % · 2× stiffer");
eq("before any rib", totalsLine(null, 1.24, 1), "No rib yet.");

const plan: RibPlanResult = {
  ribs: [
    { points: [[0, 0, 1], [10, 0, 1]], width: 1.2, height: 6, heights: [6], sections: [{ profile: "straight", width: 1.2 }], lengthMm: 10, volumeMm3: 7000, gain: 0.3 },
    { points: [[0, 5, 1], [10, 5, 1]], width: 1.2, height: 6, heights: [6], sections: [{ profile: "straight", width: 1.2 }], lengthMm: 10, volumeMm3: 3000, gain: 0.1 },
  ],
  ribVolumeMm3: 10000,
  bare: { compliance: 3, maxDeflectionMm: 0.9 },
  ribbed: { compliance: 1, maxDeflectionMm: 0.3 },
  stiffnessFactor: 3.1,
  goalMet: true,
  thickening: { addedThicknessMm: 0.62, addedVolumeMm3: 20000 },
  grid: { reached: true, pitchMm: 15, volumeMm3: 14000, gridVolumeMm3: 15000 },
  notBetterThanBaseline: false,
  stoppedEarly: false,
};
run = runDone(run, { ok: true, plan });
eq("the result's gain and cost", resultNumbers(run, 1.24, 200000), { gain: "3.1× stiffer", cost: "+12 g, +5 %", edited: false, ribs: 2 });
check("a full plan applies", applicable(run));
run = toggleRemoved(run, 1);
eq("a rib taken out: material recounted, stiffness the plan's before the edit", resultNumbers(run, 1.24, 200000), { gain: "3.1× stiffer before the edit", cost: "+8.7 g, +3.5 %", edited: true, ribs: 1 });
check("the edited note says stale", editedNote(run).includes("(stale)"));
eq("the kept ribs", keptRibs(run).length, 1);
run = toggleRemoved(run, 0);
check("every rib out: nothing to apply", !applicable(run));
eq("a refusal ends the run with its sentence", runDone(startedRun(), { ok: false, reason: "No." }).error, "No.");
eq("an idle run has nothing", applicable(idleRun()), false);

// --- The comparison lines and the goal.
eq("the plan beats both", comparisonLines(plan, 1.24), ["A wall 0.62 mm thicker all over is as stiff for 24.8 g.", "An even grid of the same ribs is as stiff for 17.4 g (15 mm apart).", "The ribs need 12.4 g, less than either."]);
check("a plan that beats neither says so", comparisonLines({ ...plan, notBetterThanBaseline: true }, 1.24).at(-1)!.startsWith("These ribs are no better"));
eq("an unreached grid", comparisonLines({ ...plan, grid: { reached: false, pitchMm: 10, volumeMm3: null, gridVolumeMm3: 1 } }, 1.24)[1], "No even grid of the same ribs, down to 10 mm apart, is as stiff.");
eq("stopped before the comparisons", comparisonLines({ ...plan, thickening: null, grid: null, stoppedEarly: true }, 1.24), ["Stopped before the comparisons with a thicker wall and an even grid."]);
eq("a target not met", goalLine({ kind: "stiffer", factor: 3 }, { ...plan, goalMet: false, stiffnessFactor: 2.3 }, 1.24), "Reached 2.3× of the 3× asked: no further rib pays enough.");
eq("a met goal says nothing", goalLine({ kind: "stiffer", factor: 3 }, plan, 1.24), "");
eq("loose ends said with why", looseLine({ ...plan, looseEnds: [{ rib: 0, end: 1, reason: "noRibZone" }, { rib: 2, end: 0, reason: "noRibZone" }] }), "2 rib ends stop short of a wall or another rib: 2 at a keep-clear zone.");
eq("an open end is not counted as the budget", looseLine({ ...plan, looseEnds: [{ rib: 0, end: 0, reason: "open" }] }), "1 rib end stops short of a wall or another rib: 1 left where the trace stopped.");
eq("no loose end, no line", looseLine({ ...plan, looseEnds: [] }), "");
eq("gain words", [gainText(1.01), gainText(3.14), gainText(12.6)], ["about as stiff", "3.1× stiffer", "13× stiffer"]);
eq("cost words", costText(9400 / 1.24, 1.24, 9400 / 1.24 / 0.06), "+9.4 g, +6 %");

// --- The wall's line.
const report = { faces: { taken: [6, 7], picked: [6], grown: [7], added: [], excluded: [], stops: [] }, areaMm2: 8816, thickness: { minMm: 1.9, medianMm: 2, maxMm: 2.4, thick: 0, capMm: 6, unread: 0 } } as unknown as RibWallReport;
eq("faces, area and thickness read", wallLine(report, 1), "2 faces · 8,816 mm² · wall 2 mm (1.9–2.4)");
eq("the prompt with nothing picked", wallLine(null, 0), "Click the inside wall to reinforce.");

// --- A hold or load that misses the wall: refused by name, or (asked for) left out and said first.
const missedRow = { kind: "load" as const, index: 0, why: "The load is not on the wall or on its far side; a model of the wall alone cannot carry it.", dropped: true };
eq("a refusal lists what missed", notOnWallLines(null, [missedRow]), ["Load 1: The load is not on the wall or on its far side; a model of the wall alone cannot carry it."]);
const substituted = { ...report, notOnWall: [missedRow], substituted: { holds: [], loads: [0], evenPressure: true, sentence: "Planned under even pressure instead of the given load: load 1 misses the wall and was left out." } } as unknown as RibWallReport;
eq("planned anyway: the sentence first, then each row", notOnWallLines(substituted)[0], "Planned under even pressure instead of the given load: load 1 misses the wall and was left out.");
check("planned anyway: the readout leads with it", wallReadout(substituted, 1).startsWith("Planned under even pressure instead of the given load"));
check("the panel offers its own way to plan without it", EVEN_PRESSURE_OFFER.includes("Plan without it"));
eq("the choice is kept with the card", cardFromStored({ ...newAutoRibsCard(), picked: [1], ifMissed: "evenPressure" })?.ifMissed, "evenPressure");
eq("refusing is the default", newAutoRibsCard().ifMissed, "refuse");
eq("side walls are off", newAutoRibsCard().folded, false);
eq("a stored check comes back on", cardFromStored({ ...newAutoRibsCard(), picked: [6], folded: true })?.folded, true);
const without = { ...newAutoRibsCard(), picked: [6] } as Partial<ReturnType<typeof newAutoRibsCard>>;
delete without.folded;
eq("a stored card without the check stays off", cardFromStored(without)?.folded, false);

// --- After Apply.
eq("measured on the solid", measuredLine(100000, 107600, 1.24), "Added 9.4 g (7.6 % of the part), measured on the solid: 7,600 mm³.");
const bare: CheckNumbers = { overhangMm2: 0, overhang: [], thinMm2: 0, thin: [] };
const worse: CheckNumbers = { overhangMm2: 14, overhang: [{ min: [9, -1, 6], max: [11, 1, 7], areaMm2: 14 }], thinMm2: 0, thin: [] };
const box = (x: number): { min: V3; max: V3 } => ({ min: [x, -1, 0], max: [x + 2, 1, 8] });
eq("a new overhang named on its rib", checkLines("Lime 220", bare, worse, [box(0), box(9)]), { lines: ["Print check on Lime 220: overhang none → 14 mm², thin walls none → none.", "Rib 2: a new overhang of 14 mm²."], problems: [1] });
eq("nothing new", checkLines("Lime 220", bare, bare, [box(0)]).lines.at(-1), "No rib makes anything new to print around.");

// --- What a History row reopens with.
const stored = { ...newAutoRibsCard(), picked: [6], zones: [zones[0]!] };
eq("a rib network row is known", ribNetSource({ kind: "group", source: { kind: "ribNet", paths: [] } }) !== null, true);
eq("another group is not", ribNetSource({ kind: "group", source: { kind: "pocket" } }), null);
eq("the panel's request comes back whole", cardFromRibNet({ kind: "ribNet", auto: { panel: JSON.parse(JSON.stringify(stored)) } }), stored);
eq("ribs_plan's request gives its wall", cardFromRibNet({ kind: "ribNet", auto: { wall: { faces: [3, 4] } } })?.picked, [3, 4]);
eq("ribs_plan's folded wall reopens folded", [cardFromRibNet({ kind: "ribNet", auto: { wall: { faces: [3, 4], folded: true } } })?.folded, cardFromRibNet({ kind: "ribNet", auto: { wall: { faces: [3, 4] } } })?.folded], [true, false]);
eq("a typed network has no request", cardFromRibNet({ kind: "ribNet" }), null);
eq("a stored card that is not one", cardFromStored({ zones: [] }), null);
// A ribs_plan request is stored as source.auto. The panel's own card still comes back whole; a wall-only request stays a fresh card.
const freshPanel = newAutoRibsCard();
const panelMade = {
  picked: [6],
  excluded: freshPanel.excluded,
  justThis: false,
  folded: false,
  amount: { kind: "stiffer" as const, factor: 1.3 },
  quantity: "frequency" as const,
  holds: freshPanel.holds,
  loads: freshPanel.loads,
  cases: [
    { name: "spread", weight: 1, loads: [{ kind: "pressure" as const, faces: [6], magnitude: 0.01, direction: [0, 0, -1] as [number, number, number] }] },
    { name: "point", weight: 4, loads: [{ kind: "force" as const, faces: [6], magnitude: 10, direction: [0, 0, -1] as [number, number, number] }] },
  ],
  zones: freshPanel.zones,
  holeRim: freshPanel.holeRim,
  ribs: { ...freshPanel.ribs, process: "resin" as const },
  ifMissed: freshPanel.ifMissed,
};
eq("a panel-made step reopens exactly as stored", cardFromRibNet({ kind: "ribNet", auto: { panel: JSON.parse(JSON.stringify(panelMade)) } }), panelMade);
const ribsPlan = (auto: Record<string, unknown>, density?: number) => cardFromRibNet({ kind: "ribNet", auto }, density);
eq("a wall-only ribs_plan request is a fresh card on those faces", ribsPlan({ wall: { faces: [3, 4] } }), { ...newAutoRibsCard(), picked: [3, 4] });
eq("a stiffer goal reopens as that factor", ribsPlan({ wall: { faces: [6] }, goal: { stiffer: 2.5 } })?.amount, { kind: "stiffer", factor: 2.5 });
const frequency = ribsPlan({ wall: { faces: [6] }, goal: { frequency: 1.3 } });
eq("a frequency goal reopens as Higher frequency", frequency?.quantity, "frequency");
eq("a frequency goal reopens at that factor", frequency?.amount, { kind: "stiffer", factor: 1.3 });
eq("the reopened frequency goal plans as that frequency", frequency ? goalOf(frequency.amount, 1.24, null, frequency.quantity) : null, { kind: "frequency", factor: 1.3 });
eq("a deflection goal reopens in millimetres", ribsPlan({ wall: { faces: [6] }, goal: { maxDeflectionMm: 0.4 } })?.amount, { kind: "deflection", mm: 0.4 });
eq("a budget in grams reopens as grams", ribsPlan({ wall: { faces: [6] }, goal: { budgetG: 8 } })?.amount, { kind: "budget", grams: 8 });
eq("a budget in mm³ reopens as grams at the filament density", ribsPlan({ wall: { faces: [6] }, goal: { budgetMm3: 4000 } }, 1.24)?.amount, { kind: "budget", grams: (4000 / 1000) * 1.24 });
eq("a balanced goal stays the slider's middle", ribsPlan({ wall: { faces: [6] }, goal: { balanced: true } })?.amount, { kind: "slider", stop: 0 });
eq("resin reopens as resin", ribsPlan({ wall: { faces: [6] }, process: "resin" })?.ribs.process, "resin");
eq("moulded reopens as moulded", ribsPlan({ wall: { faces: [6] }, process: "moulded" })?.ribs.process, "moulded");
eq("grow false reopens as just this face", ribsPlan({ wall: { faces: [6], grow: false } })?.justThis, true);
eq("excluded faces reopen", ribsPlan({ wall: { faces: [6], excludeFaces: [2, 3] } })?.excluded, [2, 3]);
eq("added faces join the picked wall", ribsPlan({ wall: { faces: [6], addFaces: [8] } })?.picked, [6, 8]);
eq("even pressure reopens", ribsPlan({ wall: { faces: [6] }, ifMissed: "evenPressure" })?.ifMissed, "evenPressure");
eq("a hole rim reopens in millimetres", ribsPlan({ wall: { faces: [6] }, holeRimMm: 4 })?.holeRim, { on: true, mm: 4 });
eq("a hole rim of 0 is off", ribsPlan({ wall: { faces: [6] }, holeRimMm: 0 })?.holeRim, { on: false, mm: 0 });
eq("rib width reopens", ribsPlan({ wall: { faces: [6] }, rib: { width: 1.6 } })?.ribs.width, 1.6);
eq("greatest height reopens", ribsPlan({ wall: { faces: [6] }, rib: { maxHeight: 8 } })?.ribs.height, 8);
eq("a straight profile reopens", ribsPlan({ wall: { faces: [6] }, rib: { profile: "straight" } })?.ribs.profile, "straight");
const faceLoad = { kind: "force" as const, faces: [6, 8], magnitude: 12, direction: [0, 0, -1] as [number, number, number] };
eq("a face load reopens on those faces", ribsPlan({ wall: { faces: [6] }, loads: [{ kind: "force", faces: [6, 8], magnitude: 12, direction: [0, 0, -1] }] })?.loads, [faceLoad]);
const sphereLoad = { kind: "force" as const, faces: [] as number[], magnitude: 20, direction: [0, 0, -1] as [number, number, number], place: { sphere: { centre: [1, 2, 3] as [number, number, number], radiusMm: 4 } } };
eq("a sphere place reopens on that sphere", ribsPlan({ wall: { faces: [6] }, loads: [{ kind: "force", region: { sphere: { centre: [1, 2, 3], radiusMm: 4 } }, magnitude: 20, direction: [0, 0, -1] }] })?.loads, [sphereLoad]);
const boxLoad = { kind: "pressure" as const, faces: [] as number[], magnitude: 0.02, direction: [0, 1, 0] as [number, number, number], place: { box: { min: [0, 0, 0] as [number, number, number], max: [2, 3, 4] as [number, number, number] } } };
eq("a box place reopens as that box", ribsPlan({ wall: { faces: [6] }, loads: [{ kind: "pressure", region: { box: { min: [0, 0, 0], max: [2, 3, 4] } }, magnitude: 0.02, direction: [0, 1, 0] }] })?.loads, [boxLoad]);
const pointed = ribsPlan({ wall: { faces: [6] }, loads: [{ kind: "force", region: { point: [4, 5, 6] }, magnitude: 7, direction: [0, 0, -1] }] });
eq("a point region is not on the card", pointed?.loads, []);
check("a point region is named in the left-out line", (pointed?.leftOut ?? "").includes("loads[0]"), pointed?.leftOut ?? "");
const spread = { kind: "pressure" as const, faces: [6], magnitude: 0.01, direction: [0, 0, -1] as [number, number, number] };
const pointCase = { kind: "force" as const, faces: [6], magnitude: 10, direction: [1, 0, 0] as [number, number, number] };
const twoCases = ribsPlan({
  wall: { faces: [6] },
  loadCases: [
    { name: "spread", weight: 1, loads: [{ kind: "pressure", faces: [6], magnitude: 0.01, direction: [0, 0, -1] }] },
    { name: "point", weight: 4, loads: [{ kind: "force", faces: [6], magnitude: 10, direction: [1, 0, 0] }] },
  ],
});
eq("two load cases reopen with their names, weights and loads", twoCases?.cases, [
  { name: "spread", weight: 1, loads: [spread] },
  { name: "point", weight: 4, loads: [pointCase] },
]);
eq("two load cases leave the single load empty", twoCases?.loads, []);
eq("a faces hold reopens", ribsPlan({ wall: { faces: [6] }, holds: [{ kind: "faces", faces: [2] }] })?.holds, [{ kind: "faces", faces: [2] }]);
eq("a bed hold reopens", ribsPlan({ wall: { faces: [6] }, holds: [{ kind: "bed" }] })?.holds, [{ kind: "bed", faces: [] }]);
eq("a box zone reopens", ribsPlan({ wall: { faces: [6] }, zones: [{ region: { box: { centre: [0, 0, 0], size: [10, 8, 4] } } }] })?.zones, [{ id: 1, mode: "noRibs", maxHeightMm: 2, marginMm: 0, shape: { kind: "box", centre: [0, 0, 0], size: [10, 8, 4] } }]);
eq("a sphere zone reopens", ribsPlan({ wall: { faces: [6] }, zones: [{ region: { sphere: { centre: [1, 2, 3], radius: 5 } }, mode: "maxHeight", maxHeightMm: 2, marginMm: 1 }] })?.zones, [{ id: 1, mode: "maxHeight", maxHeightMm: 2, marginMm: 1, shape: { kind: "sphere", centre: [1, 2, 3], radius: 5 } }]);
const oneCase = ribsPlan({ wall: { faces: [6] }, loadCases: [{ name: "sideways", weight: 2, loads: [{ kind: "force", faces: [6], magnitude: 10, direction: [0, 0, -1] }] }] });
eq("one load case reopens as the one load", oneCase?.loads, [{ kind: "force", faces: [6], magnitude: 10, direction: [0, 0, -1] }]);
eq("one load case has no case list", oneCase?.cases, undefined);
check("one load case's name and weight are named as left out", (oneCase?.leftOut ?? "").includes("loadCases[0].name") && (oneCase?.leftOut ?? "").includes("loadCases[0].weight"), oneCase?.leftOut ?? "");
const left = ribsPlan({
  wall: { faces: [6], face: { nearPoint: [0, 0, 2], normal: [0, 0, 1] }, thicknessMm: 2 },
  loads: [
    { kind: "force", faces: [6], magnitude: 10, direction: [0, 0, -1] },
    { kind: "force", faces: { normal: [0, 0, 1], nearPoint: [1, 2, 3] }, magnitude: 5, direction: [0, 0, -1] },
  ],
  holds: [{ kind: "plane", normal: [0, 0, 1], origin: [0, 0, 0] }],
  rib: { width: 1.6, minSpacing: 4 },
  baselines: false,
  buildAxis: [0, 0, 1],
});
eq("a selector load is not on the reopened card", left?.loads, [{ kind: "force", faces: [6], magnitude: 10, direction: [0, 0, -1] }]);
eq("a plane hold is not on the reopened card", left?.holds, []);
eq("the width still reopens beside what was left out", left?.ribs.width, 1.6);
const leftLine = left?.leftOut ?? "";
check(
  "the left-out sentence names each item ribs_plan names, in one line",
  !leftLine.includes("\n") && leftLine === "Left out, because the Auto ribs card cannot show them: wall.face, wall.thicknessMm, loads[1], holds[0], rib.minSpacing, buildAxis, baselines. Run plans without them.",
  leftLine,
);

// --- The request the panel's cases build. One load stays `loads` alone. A blank name is Case N, as ribs_plan names one.
const force = { kind: "force" as const, faces: [6], magnitude: 10, direction: [0, 0, -1] as [number, number, number] };
const pressure = { kind: "pressure" as const, faces: [6], magnitude: 0.01, direction: [0, 0, -1] as [number, number, number] };
eq("one load: loads only, no cases and no weights", loadRequest([force], undefined), { loads: [force] });
eq("a single case stays the one load", loadRequest([force], [{ name: "only", weight: 3, loads: [pressure] }]), { loads: [force] });
const two = loadRequest([], [{ name: "spread", weight: 1, loads: [pressure] }, { name: "point", weight: 4, loads: [force] }]);
eq("two cases: loadCases and caseWeights, and no loads beside them", two, { loads: [], loadCases: [{ name: "spread", loads: [pressure] }, { name: "point", loads: [force] }], caseWeights: [1, 4] });
eq("a weight that is not above zero is 1", loadRequest([], [{ name: "a", weight: 0, loads: [force] }, { name: "b", weight: -2, loads: [pressure] }]).caseWeights, [1, 1]);
eq("a blank name is Case N", loadRequest([], [{ name: "  ", weight: 1, loads: [pressure] }, { name: "", weight: 2, loads: [force] }]).loadCases?.map((row) => row.name), ["Case 1", "Case 2"]);
// Two cases never go out with one name: the verify study finds each case's loads by it.
eq("a name two cases share is suffixed", caseNames([{ name: "lid" }, { name: "lid" }, { name: " lid " }]), ["lid", "lid (2)", "lid (3)"]);
eq("a blank name that is another case's Case N is suffixed", caseNames([{ name: "Case 2" }, { name: "" }]), ["Case 2", "Case 2 (2)"]);
eq("a free name skips the taken ones", freeCaseName("Case 3", ["Case 1", "Case 3", "Case 3 (2)"]), "Case 3 (3)");
eq("the shared name is found as ribs_plan would send it", [duplicateCaseName([{ name: "a" }, { name: " a" }]), duplicateCaseName([{ name: "Case 2" }, { name: "" }]), duplicateCaseName([{ name: "a" }, { name: "b" }])], ["a", "Case 2", null]);
eq("the request carries the distinct names", loadRequest([], [{ name: "lid", weight: 1, loads: [pressure] }, { name: "lid", weight: 2, loads: [force] }]).loadCases?.map((row) => row.name), ["lid", "lid (2)"]);
const kept = [{ name: "spread", weight: 1, loads: [pressure] }, { name: "point", weight: 4, loads: [force] }];
const back = cardFromStored({ ...newAutoRibsCard(), picked: [6], loads: [], cases: kept });
eq("two cases come back with the card", back?.cases, kept);
eq("two cases leave the single load empty", back?.loads, []);
eq("one stored case folds away", cardFromStored({ ...newAutoRibsCard(), picked: [6], loads: [force], cases: [{ name: "only", weight: 3, loads: [pressure] }] })?.cases, undefined);
const outcomes = caseOutcomes(2.4, 0.8, [1, 4]);
eq("two cases, beside the combined factor", caseResultLines(["spread", "point"], outcomes.map((row) => row.factor), outcomes.map((row) => ({ bare: row.bareMm, ribbed: row.ribbedMm }))), ["spread: 1.4× stiffer, deflection 0.8 mm → 0.593 mm", "point: 2.4× stiffer, deflection 0.8 mm → 0.333 mm"]);
eq("one case shows nothing new", caseResultLines(["only"], [2.4], [{ bare: 0.8, ribbed: 0.333 }]), []);

// --- The preview: a box per stretch, and the rib under a ray.
const drawn = [
  { points: [[0, 0, 0], [10, 0, 0]] as V3[], normals: [[0, 0, 1], [0, 0, 1]] as V3[], heights: [6], width: 1.2 },
  { points: [[0, 20, 0], [10, 20, 0], [20, 20, 0]] as V3[], normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1]] as V3[], heights: [6, 3], width: 1.2 },
];
eq("a stretch is ten triangles (no bottom)", [ribSoup(drawn[0]!).length / 9, ribSoup(drawn[1]!).length / 9], [10, 20]);
eq("a ray down onto the second rib", ribUnderRay(drawn, [15, 20, 50], [0, 0, -1], 1), 1);
eq("a ray between the ribs", ribUnderRay(drawn, [5, 10, 50], [0, 0, -1], 1), -1);

// --- Frequency: the tool and the panel build the same request, and a stiffness request stays e and nu.
const panelGoal = goalOf({ kind: "slider", stop: -1 }, 1.24, null, "frequency");
const toolGoal = goalFromTool({ frequency: 1.3 }, 1.24);
eq("the slider stop and the tool ask for the same frequency goal", panelGoal, toolGoal);
eq("the frequency stops, with ×1.5 in the middle", [-2, -1, 0, 1, 2].map(frequencyFactorAt), [1.15, 1.3, 1.5, 1.75, 2]);
const petg = { e: 1800, nu: 0.35, densityGCm3: 1.27, name: "PETG" };
if ("reason" in toolGoal) throw new Error(toolGoal.reason);
eq("the tool and the panel send the same material", engineMaterial(petg, panelGoal), engineMaterial(petg, toolGoal));
eq("a stiffness request drops the density", engineMaterial(petg, { kind: "balanced" }), { material: { e: 1800, nu: 0.35 } });
eq("a frequency goal with a budget names both", goalFromTool({ frequency: 1.3, budgetMm3: 4000 }, 1.24), { reason: "A plan has one goal: frequency and budgetMm3 cannot both be set." });
eq("three goals are not 'both'", goalFromTool({ frequency: 1, stiffer: 2, budgetG: 1 }, 1.24), { reason: "A plan has one goal: frequency, stiffer and budgetG cannot all be set." });
eq("a factor below 1 is refused", goalFromTool({ frequency: 0.5 }, 1.24), { reason: "A frequency goal must be 1 or more." });
eq("a material with no density is refused by name", engineMaterial({ e: 1800, nu: 0.35, name: "PETG" }, toolGoal), { reason: "PETG has no density." });
const freqPlan = { ...plan, goalMet: true, frequencyHz: { bare: 100, ribbed: 130 }, frequencyFactor: 1.3, stiffnessFactor: 1.8 };
eq("hertz before and after", resultNumbers({ ...runDone(startedRun(), { ok: true, plan: freqPlan }), removed: [] }, 1.24, 200000)?.gain, "100 Hz → 130 Hz");
eq("the stiffness factor is information", frequencyAside(freqPlan), "1.8× as stiff, for information.");
eq("a case factor after the Hz is stiffness", caseResultLines(["spread", "point"], [1.35, 2.4], [{ bare: 0.8, ribbed: 0.593 }, { bare: 0.8, ribbed: 0.333 }], true), ["spread: stiffness 1.35×, deflection 0.8 mm → 0.593 mm", "point: stiffness 2.4×, deflection 0.8 mm → 0.333 mm"]);
eq("×1 asks for no change is the panel's fallback sentence's twin", ignoredLoadNote([{ kind: "load", index: 0 }]), "Load 1 misses the wall and is ignored: a frequency plan does not use the loads.");
eq("a missed load of a case is ignored by name", ignoredLoadNote(frequencyIgnoredLoads({ substituted: { holds: [], loads: [] }, notOnWall: [{ kind: "load", index: 0, case: "sideways", dropped: true }] })), "Load 1 of sideways misses the wall and is ignored: a frequency plan does not use the loads.");
eq("one missed load still uses the load index", ignoredLoadNote(frequencyIgnoredLoads({ substituted: { holds: [], loads: [0] }, notOnWall: [] })), "Load 1 misses the wall and is ignored: a frequency plan does not use the loads.");
eq("the default card's Hz are named", fallbackHzNote({ forFilament: false, polymer: "PETG", id: "inhouse-petg" }), "These Hz are the default PETG card's (inhouse-petg): no card in the library is for this filament.");
eq("the filament's own card adds no Hz note", fallbackHzNote({ forFilament: true, polymer: "PETG", id: "inhouse-petg" }), "");
eq("an edit of a frequency plan does not say stiffness", editedNote({ ...runDone(startedRun(), { ok: true, plan: freqPlan }), removed: [0] }).includes("the frequency is the plan's before the edit"), true);
eq("an edit of a stiffness plan still says stiffness", editedNote({ ...runDone(startedRun(), { ok: true, plan }), removed: [0] }).includes("the stiffness is the plan's before the edit"), true);
eq("a stiffness plan has no frequency aside", frequencyAside(plan), "");
eq("an unreached frequency says the ratio", goalLine({ kind: "frequency", factor: 2 }, { ...freqPlan, goalMet: false, frequencyFactor: 1.42 }, 1.24), "Reached 1.42× of the 2× asked: no further rib pays enough.");
eq("stiffness is still the default", newAutoRibsCard().quantity, "stiffness");
eq("a stored frequency choice comes back", cardFromStored({ ...newAutoRibsCard(), picked: [6], quantity: "frequency" })?.quantity, "frequency");

// --- Resist buckling: the same sentences the solver prints, and the tool's refusals.
eq("the buckling stops, with ×3 in the middle", [-2, -1, 0, 1, 2].map((stop) => goalOf({ kind: "slider", stop }, 1.24, null, "buckling").kind === "buckling" ? (goalOf({ kind: "slider", stop }, 1.24, null, "buckling") as { factor: number }).factor : 0), [1.5, 2, 3, 4, 5]);
eq("the middle stop is the default sentence", sliderNote({ kind: "slider", stop: 0 }, null, "buckling"), "Holds 3× the load before it buckles. 1× buckles exactly at the load.");
eq("a whole tenth prints as a whole number", loadTimes(3), "3");
eq("a tenth prints", loadTimes(3.14), "3.1");
eq("the result sentence", bucklesAt(3.1, 0.9), "Buckles at 3.1× the load (was 0.9×).");
eq("already enough", alreadyEnough(3.2, 2), "The wall already holds 3.2× this load before it buckles, above the 2× asked. No ribs needed.");
eq("short of the target", reachedShort(1.7, 3), "Reached 1.7× of the 3× asked: no further rib pays enough.");
eq("against a named case", againstCase("lift"), "Against case: lift");
eq("a buckling goal is that factor", goalFromTool({ buckling: 3 }, 1.24), { kind: "buckling", factor: 3 });
eq("a buckling factor below 1 is refused", goalFromTool({ buckling: 0.5 }, 1.24), { reason: "A buckling goal must be 1 or more." });
eq("a buckling goal with a budget names both", goalFromTool({ buckling: 3, budgetMm3: 4000 }, 1.24), { reason: "A plan has one goal: buckling and budgetMm3 cannot both be set." });
eq("buckling beside frequency names frequency, which is checked first", goalFromTool({ frequency: 1.3, buckling: 3 }, 1.24), { reason: "A plan has one goal: frequency and buckling cannot both be set." });
eq("on with one case is refused", goalFromTool({ buckling: 3, on: "edge" }, 1.24, ["edge"]), { reason: "A buckling goal names a load case only when there is more than one." });
eq("two cases need on", goalFromTool({ buckling: 3 }, 1.24, ["edge", "press"]), { reason: "A buckling goal needs the load case it is solved against." });
eq("on names the case by its place", goalFromTool({ buckling: 3, on: "press" }, 1.24, ["edge", "press"]), { kind: "buckling", factor: 3, on: 1 });
eq("an unknown case is refused", goalFromTool({ buckling: 3, on: "side" }, 1.24, ["edge", "press"]), { reason: "A buckling goal names a load case the request does not have." });
const bucklingCard = ribsPlan({ wall: { faces: [6] }, goal: { buckling: 3, on: "edge" } });
eq("a buckling goal reopens as Resist buckling", bucklingCard?.quantity, "buckling");
eq("a buckling goal reopens at that factor", bucklingCard?.amount, { kind: "stiffer", factor: 3 });
eq("a buckling goal reopens against its case", bucklingCard?.against, "edge");
eq("a stored buckling choice comes back", cardFromStored({ ...newAutoRibsCard(), picked: [6], quantity: "buckling", against: "edge" })?.against, "edge");
const bucklePlan = { ...plan, goalMet: true, ribs: plan.ribs, bucklingFactor: { bare: 0.9, ribbed: 3.1 }, notes: ["This is the ideal buckling load. A curved wall, or one that isn't perfectly flat, can buckle well below it.", "Buckles at 3.1× the load (was 0.9×)."] };
eq("the gain is the buckling sentence", resultNumbers({ ...runDone(startedRun(), { ok: true, plan: bucklePlan }), removed: [] }, 1.24, 200000)?.gain, "Buckles at 3.1× the load (was 0.9×).");
const editedBucklingGain = resultNumbers({ ...runDone(startedRun(), { ok: true, plan: bucklePlan }), removed: [0] }, 1.24, 200000)?.gain;
eq("an edited buckling run's gain names the edit", editedBucklingGain, "Before the edit: Buckles at 3.1× the load (was 0.9×).");
console.log("an edited buckling run's gain names the edit:", editedBucklingGain);
eq("an edit of a buckling plan does not say stiffness", editedNote({ ...runDone(startedRun(), { ok: true, plan: bucklePlan }), removed: [0] }).includes("the buckling load is the plan's before the edit"), true);
eq("a reached note is not repeated as the goal line", goalLine({ kind: "buckling", factor: 3 }, { ...bucklePlan, goalMet: false, notes: [...(bucklePlan.notes ?? []), "Reached 1.7× of the 3× asked: no further rib pays enough."] }, 1.24), "");

if (failed) {
  console.error(`auto-ribs: ${failed} failed`);
  process.exit(1);
}
console.log("auto-ribs: ok");
