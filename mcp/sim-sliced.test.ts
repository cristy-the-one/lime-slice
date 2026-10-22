/**
 * SR-12. A sliced box is solved by the engine's simStudy, in process.
 * The generated-beam smear stays on the lime-sim binary, covered by mcp/sim.test.ts.
 */
import { fileURLToPath } from "node:url";

import { LABEL } from "../src/sim/label.ts";
import { STUDY_MESH_REFUSAL } from "../src/sim/study-mesh.ts";

import { fakeEngine, loadNativeEngine } from "./engine.ts";
import { Session } from "./session.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const native = loadNativeEngine(root);
const engine = fakeEngine();
engine.simStudy = (body: string) => native.simStudy(body);

const session = new Session(engine);
const setup = await session.call("sim_setup", {
  beam: { lengthMm: 8, widthMm: 6, heightMm: 4 },
  hMm: 2,
  representation: "sliced",
  fixtures: [{ kind: "bed" }],
  loads: [{ kind: "force", faces: [1], magnitude: 2, direction: [0, 0, 1] }],
  card: "inhouse-petg",
  constraints: [{ kind: "minSafetyFactor", value: 1 }],
});
check("a sliced box is set up", setup.ok === true && (setup.study as { representation?: string } | undefined)?.representation === "sliced", String(setup.reason ?? ""));

const printed = await session.call("settings_set", { object: setup.object, values: { infill: 1, walls: 2 } });
check("the box is printed solid", printed.ok === true, String(printed.reason ?? ""));

const run = await session.call("sim_run", { object: setup.object });
const margins = run.margins as { kind?: string; hotSpot?: { at?: number[]; role?: string; governs?: string } }[] | undefined;
const spot = margins?.[0]?.hotSpot;
check(
  "sim_run reads margins and a hot spot",
  run.ok === true
    && run.label === LABEL
    && run.representation === "sliced"
    && Array.isArray(margins)
    && margins.length > 0
    && margins[0]?.kind === "minSafetyFactor"
    && Array.isArray(spot?.at)
    && spot.at.length === 3
    && spot.at.every((value) => typeof value === "number" && Number.isFinite(value))
    && !("surface" in run)
    && !("triangles" in run)
    && !("nodes" in run)
    && !("stiffness" in run),
  JSON.stringify(run.reason ?? { keys: Object.keys(run), margins }),
);

function inside(at: number[], min: number[], max: number[]): boolean {
  return at.length === 3 && at.every((value, axis) => value >= min[axis]! - 1e-2 && value <= max[axis]! + 1e-2);
}

const scaledSession = new Session(engine);
const made = await scaledSession.call("solid_new", { primitive: "box", dx: 8, dy: 6, dz: 4 });
check("a box solid opens", made.ok === true, String(made.reason ?? ""));
const scaledObject = String(made.object ?? "");
const placed = await scaledSession.call("object_place", { object: scaledObject, scalePercent: 200 });
check("the box is at scale 2", placed.ok === true, String(placed.reason ?? ""));
const scaledPrint = await scaledSession.call("settings_set", { object: scaledObject, values: { infill: 1, walls: 2 } });
check("the scaled box is printed solid", scaledPrint.ok === true, String(scaledPrint.reason ?? ""));
const scaledSetup = await scaledSession.call("sim_setup", {
  object: scaledObject,
  hMm: 4,
  representation: "sliced",
  fixtures: [{ kind: "bed" }],
  loads: [{ kind: "force", faces: [0], magnitude: 2, direction: [0, 0, 1] }],
  card: "inhouse-petg",
  constraints: [{ kind: "minSafetyFactor", value: 1 }],
});
check("a scaled box is set up", scaledSetup.ok === true, String(scaledSetup.reason ?? ""));
const scaledRun = await scaledSession.call("sim_run", { object: scaledObject });
const scaledSpot = (scaledRun.margins as { hotSpot?: { at?: number[] } }[] | undefined)?.[0]?.hotSpot?.at;
const scaledMass = typeof scaledRun.massG === "number" ? scaledRun.massG : 0;
check(
  "scale 2 with a face hold solves inside the scaled bounds",
  scaledRun.ok === true && Array.isArray(scaledSpot) && inside(scaledSpot, [-8, -6, -2], [8, 6, 6]) && scaledMass > 1,
  JSON.stringify(scaledRun.reason ?? { spot: scaledSpot, mass: scaledRun.massG, keys: Object.keys(scaledRun) }),
);

const editSession = new Session(engine);
const fresh = await editSession.call("solid_new", { primitive: "box", dx: 8, dy: 6, dz: 4 });
const editObject = String(fresh.object ?? "");
const committed = await editSession.call("model_commit", { object: editObject });
check("the box commits", committed.ok === true, String(committed.reason ?? ""));
const probed = await editSession.call("model_probe", { object: editObject, op: { kind: "root", primitive: "box", dx: 16, dy: 6, dz: 4 } });
const resized = await editSession.call("model_edit", { object: editObject, node: "node_0", op: { kind: "root", primitive: "box", dx: 16, dy: 6, dz: 4 } });
const described = await editSession.call("model_describe", { object: editObject, limit: 1 });
check(
  "a box parameter keeps the face count and changes the solid",
  probed.ok === true && resized.ok === true && described.volumeMm3 === 384,
  JSON.stringify({ probe: probed.reason, edit: resized.reason, volume: described.volumeMm3 }),
);
await editSession.call("settings_set", { object: editObject, values: { infill: 1, walls: 2 } });
const editSetup = await editSession.call("sim_setup", {
  object: editObject,
  hMm: 2,
  representation: "sliced",
  fixtures: [{ kind: "bed" }],
  loads: [{ kind: "force", faces: [0], magnitude: 2, direction: [0, 0, 1] }],
  card: "inhouse-petg",
  constraints: [{ kind: "minSafetyFactor", value: 1 }],
});
const editRun = await editSession.call("sim_run", { object: editObject });
const editSpot = (editRun.margins as { hotSpot?: { at?: number[] } }[] | undefined)?.[0]?.hotSpot?.at;
const editMass = typeof editRun.massG === "number" ? editRun.massG : 0;
const solvedEdited = editRun.ok === true && Array.isArray(editSpot) && inside(editSpot, [-8, -3, 0], [8, 3, 4]) && editMass > 0.35;
const refusedEdited = editRun.ok === false && editRun.reason === STUDY_MESH_REFUSAL;
check(
  solvedEdited ? "an uncommitted size edit solves the edited solid" : "an uncommitted size edit is refused",
  editSetup.ok === true && (solvedEdited || refusedEdited),
  JSON.stringify(editRun.reason ?? { spot: editSpot, mass: editRun.massG, setup: editSetup.reason }),
);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sim-sliced: ok");
