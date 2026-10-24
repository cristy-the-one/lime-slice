import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ID_MATRIX } from "../mesh-place.ts";
import { oneObjectPlate, revivePlate, snapPlate } from "../plate.ts";
import { defaultProfile } from "../profiles.ts";
import { DEFAULT_PRESET } from "../presets.ts";
import { meshRecord, parseProject, serializeProject, type LimeProject } from "../project.ts";
import { provisionalCards } from "./cards.ts";
import { LABEL, NOT_HELD, PROVISIONAL_SENTENCE } from "./label.ts";
import { loadArrow } from "./arrow.ts";
import {
  arrowLength,
  arrowSeat,
  beltLayerNormal,
  boxOf,
  cannedBeam,
  defaultScale,
  emptyStudy,
  formatProbe,
  constraintVerdict,
  holdRefusal,
  notShown,
  onBed,
  probeNearest,
  readStudy,
  sectionHides,
  setupGap,
  shownTrust,
  vertexColours,
  type Vec3,
} from "./study.ts";
import { MODEL_TOOLS } from "../model-drag.ts";
import { COMMANDS } from "../ui/commands.ts";

let failed = 0;
function eq<T>(name: string, actual: T, expected: T) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got ${JSON.stringify(actual)}\n  want ${JSON.stringify(expected)}`);
}
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const petg = provisionalCards()[1]!;
const box = boxOf(new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 10]))!;
eq("a box is its corners", box, { min: [0, 0, 0], max: [10, 10, 10] });

const bare = emptyStudy();
eq("nothing held is refused", holdRefusal(bare), NOT_HELD);
bare.holds = [{ kind: "bed", faces: [] }];
eq("the bed is a hold", holdRefusal(bare), null);
{
  const setup = emptyStudy();
  eq("a new study asks for a hold first", setupGap(setup), { step: "hold", text: "Hold the part: pick the faces that are fixed, or the bed." });
  setup.holds = [{ kind: "faces", faces: [2] }];
  eq("held, it asks for the load's faces", setupGap(setup), { step: "load", text: "Pick the faces the load pushes on." });
  setup.loads[0]!.faces = [5];
  eq("a held part with a loaded face can run", setupGap(setup), null);
  setup.loads[0]!.magnitude = 0;
  eq("a zero load is not done", setupGap(setup)?.step, "load");
  const centres: Record<number, Vec3> = { 1: [0, 0, 10], 5: [10, 0, 0] };
  eq("no loaded face, no arrow", arrowSeat(emptyStudy(), (index) => centres[index] ?? null), null);
  setup.loads[0]!.faces = [1, 5];
  eq("the arrow sits at the loaded faces' centre", arrowSeat(setup, (index) => centres[index] ?? null), [5, 0, 5]);
}

eq("a provisional card is rough", shownTrust(petg), { level: "rough", sentence: PROVISIONAL_SENTENCE });
eq("a measured card is not capped", shownTrust({ provisional: false }), { level: "usable", sentence: "" });

const beam = cannedBeam(bare, box, petg, "vonMises");
if ("error" in beam) {
  check("the canned beam solves", false, beam.error);
} else {
  eq("the label is the shared one", beam.label, LABEL);
  eq("trust stays rough", beam.trust, "rough");
  eq("the sentence is on the result", beam.trustSentence, PROVISIONAL_SENTENCE);
  const tip = beam.nodes[beam.nodes.length - 1]!;
  const root = beam.nodes[0]!;
  check("the tip moves and the root does not", tip.displacement > root.displacement && root.displacement === 0, `${root.displacement} ${tip.displacement}`);
  const peak = Math.max(...beam.nodes.map((node) => node.displacement));
  const diagonal = Math.hypot(10, 10, 10);
  eq("the default scale is 5% of the diagonal", beam.scale, defaultScale(peak, diagonal));
  check("colours are not green", !vertexColours(beam).some((value, index) => index % 3 === 1 && value > 0.55 && vertexColours(beam)[index - 1]! < 0.4));
  const hit = probeNearest(beam, [10, 5, 5], "rest");
  check("a probe reports a number", Number.isFinite(hit.value), String(hit.value));
  check("the readout has a unit", formatProbe(hit.value, "vonMises").endsWith(" MPa"));
  const centre = [5, 5, 5];
  const normal = [0, 0, 1];
  const hidden = beam.nodes.filter((node) => sectionHides(node.at, centre, normal));
  const shown = beam.nodes.length - hidden.length;
  check("a mid-height plane hides the cut half", hidden.length > 0 && shown > 0 && hidden.length === shown, `${shown} ${hidden.length}`);
}

eq("the bed is the bottom 0.05 mm", [onBed(0), onBed(0.05), onBed(0.06)], [true, true, false]);
{
  const got = beltLayerNormal(45);
  const want = [0, -0.7071067811865476, 0.7071067811865476];
  check("IR3's layer normal is the locked vector", got.every((value, index) => Math.abs(value - want[index]!) < 1e-12), JSON.stringify(got));
}
check("a longer force lengthens the arrow", arrowLength(1, 20) < arrowLength(40, 20));

const arrow = loadArrow([10, 5, 5], [0, 0, -1], 25, "Force");
eq("the load arrow is an axis handle on the face", [arrow.kind, arrow.seat.at, arrow.values[0]], ["axis", "feature", 25]);

const stress = COMMANDS.find((command) => command.id === "model-stress");
eq("stress is a Model command with no key", stress ? [stress.group, stress.keys ?? [], stress.keywords] : null, ["Model", [], "stress fem load fixture safety"]);
check("stress is not a toolbar tool", !(MODEL_TOOLS as readonly string[]).includes("stress"));

const study = emptyStudy();
study.holds = [{ kind: "bed", faces: [] }];
eq("a study reads back", readStudy(JSON.parse(JSON.stringify(study))), study);
eq("a damaged study is left out", readStudy({ holds: "bed" }), null);
study.beam = { lengthMm: 100, widthMm: 10, heightMm: 10 };
study.pattern = "grid";
eq("a generated beam reads back", readStudy(JSON.parse(JSON.stringify(study))), study);
eq("a damaged beam is left out", readStudy({ ...study, beam: { lengthMm: 0, widthMm: 10, heightMm: 10 } }), null);
const sliced = emptyStudy();
sliced.holds = [{ kind: "bed", faces: [] }];
sliced.representation = "sliced";
sliced.constraints = [{ kind: "minSafetyFactor", value: 2 }];
eq("a sliced study reads back", readStudy(JSON.parse(JSON.stringify(sliced))), sliced);
eq("a bad representation is left out", readStudy({ ...sliced, representation: "foam" }), null);
const placed = emptyStudy();
placed.holds = [{ kind: "faces", faces: [], place: { box: { min: [-31, -6, -1], max: [-28, 6, 7] } } }];
placed.loads = [{ kind: "force", faces: [], magnitude: 5, direction: [0, 0, -1], place: { sphere: { centre: [29, 0, 3], radiusMm: 4 } } }];
placed.constraints = [
  { kind: "maxDeflectionMm", value: 2, region: { sphere: { centre: [29, 0, 3], radiusMm: 4 } } },
  { kind: "deflectionBandMm", value: 0, band: [0.5, 2], region: { faces: [3] } },
  { kind: "relativeDeflectionMm", value: 1, region: { box: { min: [0, 0, 0], max: [1, 1, 1] } }, other: { faces: [4] } },
];
placed.facesKey = "abc123";
eq("places, region targets and the faces key read back", readStudy(JSON.parse(JSON.stringify(placed))), placed);
eq("a place with no radius is left out", readStudy({ ...placed, loads: [{ ...placed.loads[0], place: { sphere: { centre: [0, 0, 0] } } }] }), null);
eq("a place reads as held", holdRefusal(placed), null);
eq(
  "a rough row is not met",
  constraintVerdict({ provisional: true, trust: "rough", maxDisplacementMm: 0.01, minSafetyFactor: 4, massG: 1 }, { maxDeflectionMm: 1 }),
  { met: false, reason: PROVISIONAL_SENTENCE },
);
eq(
  "a converged row can pass",
  constraintVerdict({ provisional: false, trust: "converged", maxDisplacementMm: 0.2, minSafetyFactor: 3, massG: 12 }, { maxDeflectionMm: 1, minSafetyFactor: 2 }),
  { met: true, reason: "" },
);

const plate = oneObjectPlate({
  name: "beam",
  fileName: "beam.stl",
  bytes: new ArrayBuffer(4),
  sourcePos: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  orient: [...ID_MATRIX],
  partScale: 1,
  centered: false,
  offset: { x: 0, y: 0, z: 0 },
  stepTolerance: 0.1,
  supportEdits: [],
  supportPaint: [],
  seamPaint: [],
});
plate.objects[0]!.sim = study;
const revived = revivePlate(snapPlate(plate));
eq("undo keeps the fixture", revived?.objects[0]?.sim, study);

const mesh = meshRecord("beam.stl", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
const placement = {
  orient: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number],
  scale: 1,
  centered: false,
  offset: { x: 0, y: 0, z: 0 },
  stepTolerance: 0.1,
};
const saved: LimeProject = {
  version: 2,
  mesh,
  placement,
  settings: DEFAULT_PRESET,
  preset: "bench",
  profile: defaultProfile(),
  level: "simple",
  supportEdits: [],
  objects: [{ id: "part", name: "beam", mesh, placement, supportEdits: [], sim: study }],
};
const opened = parseProject(serializeProject(saved));
check("a study survives a project", opened.ok && JSON.stringify(opened.project.objects?.[0]?.sim) === JSON.stringify(study));
const damaged = JSON.parse(serializeProject(saved)) as { objects: { sim?: unknown }[] };
damaged.objects[0]!.sim = { holds: "bed" };
const dropped = parseProject(JSON.stringify(damaged));
check("a damaged study is omitted", dropped.ok && dropped.project.objects?.[0]?.sim === undefined);

function tsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsSources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}
const callers = tsSources("src").filter((path) => readFileSync(path, "utf8").includes("cannedBeam("));
eq("the canned beam is only defined, not run from the panel", callers, [join("src", "sim", "study.ts")]);

{
  // The owner's case: a bar on the bed, 10 N pressing it down. 0.001 MPa is noise, not a shape.
  const node = (vonMises: number) => ({ at: [0, 0, 0] as Vec3, u: [0, 0, 0] as Vec3, vonMises, displacement: 0, safety: 1e6 });
  const study = emptyStudy();
  study.holds = [{ kind: "bed", faces: [] }];
  study.loads = [{ kind: "force", faces: [5], magnitude: 10, direction: [0, 0, -1] }];
  eq(
    "a load pressing a bed-held part into the bed is not drawn",
    notShown({ nodes: [node(0.001)], moved: 0.99 }, study, petg),
    "Nothing bends this part: the bed holds it, and the load presses it into the bed (peak 0.00100 MPa). Hold one end with Faces, and load the other end.",
  );
  study.holds = [{ kind: "faces", faces: [0] }];
  eq(
    "a tiny peak elsewhere says how small it is",
    notShown({ nodes: [node(0.002)], moved: null }, study, petg),
    "Nothing loads this part enough to show: the peak is 0.00200 MPa, under 0.1% of its strength. Raise the load, or hold and load faces farther apart.",
  );
  eq(
    "two cell sizes that disagree past the rough line are not drawn",
    notShown({ nodes: [node(12)], moved: 0.34 }, study, petg),
    "The two cell sizes disagree by 34%, so colours would mislead. Set a smaller cell size under Advanced, and run again.",
  );
  eq("a loaded part that holds still between sizes is drawn", notShown({ nodes: [node(12)], moved: 0.04 }, study, petg), null);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("study: canned beam, probe, clip, undo snap ok");
