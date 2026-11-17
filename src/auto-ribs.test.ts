/**
 * The Auto ribs panel's state (src/auto-ribs.ts): wall clicks, zones as ribWall reads them, the goal from How much, the
 * run as events arrive, a rib taken out, the sentences of the result and after Apply, the stored request a History row
 * reopens with, and the preview's geometry (the rib under a ray, the boxes drawn).
 */
import { readFileSync } from "node:fs";
import {
  applicable,
  cardFromRibNet,
  cardFromStored,
  checkLines,
  clickWall,
  comparisonLines,
  costText,
  editedNote,
  gainText,
  goalLine,
  goalOf,
  idleRun,
  keptRibs,
  measuredLine,
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
  zoneInputs,
  zoneLanded,
  zoneSoup,
  zoneTitle,
  type CheckNumbers,
} from "./auto-ribs.ts";
import { COMMANDS } from "./ui/commands.ts";
import type { RibPlanResult, V3 } from "./auto-ribs-plan.ts";
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
eq("gain words", [gainText(1.01), gainText(3.14), gainText(12.6)], ["about as stiff", "3.1× stiffer", "13× stiffer"]);
eq("cost words", costText(9400 / 1.24, 1.24, 9400 / 1.24 / 0.06), "+9.4 g, +6 %");

// --- The wall's line.
const report = { faces: { taken: [6, 7], picked: [6], grown: [7], added: [], excluded: [], stops: [] }, areaMm2: 8816, thickness: { minMm: 1.9, medianMm: 2, maxMm: 2.4, thick: 0, capMm: 6, unread: 0 } } as unknown as RibWallReport;
eq("faces, area and thickness read", wallLine(report, 1), "2 faces · 8,816 mm² · wall 2 mm (1.9–2.4)");
eq("the prompt with nothing picked", wallLine(null, 0), "Click the inside wall to reinforce.");

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
eq("a typed network has no request", cardFromRibNet({ kind: "ribNet" }), null);
eq("a stored card that is not one", cardFromStored({ zones: [] }), null);

// --- The preview: a box per stretch, and the rib under a ray.
const drawn = [
  { points: [[0, 0, 0], [10, 0, 0]] as V3[], normals: [[0, 0, 1], [0, 0, 1]] as V3[], heights: [6], width: 1.2 },
  { points: [[0, 20, 0], [10, 20, 0], [20, 20, 0]] as V3[], normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1]] as V3[], heights: [6, 3], width: 1.2 },
];
eq("a stretch is ten triangles (no bottom)", [ribSoup(drawn[0]!).length / 9, ribSoup(drawn[1]!).length / 9], [10, 20]);
eq("a ray down onto the second rib", ribUnderRay(drawn, [15, 20, 50], [0, 0, -1], 1), 1);
eq("a ray between the ribs", ribUnderRay(drawn, [5, 10, 50], [0, 0, -1], 1), -1);

if (failed) {
  console.error(`auto-ribs: ${failed} failed`);
  process.exit(1);
}
console.log("auto-ribs: ok");
