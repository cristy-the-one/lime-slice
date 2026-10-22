/**
 * SR-12. A sliced box is solved by the engine's simStudy, in process.
 * The generated-beam smear stays on the lime-sim binary, covered by mcp/sim.test.ts.
 * SR-21. checkResolution defaults to true. An imported STL with a printer and a
 * turn is sliced without asking for representation, and the hot spot stays in
 * the part frame.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeStl } from "../src/mesh-place.ts";
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
const captured: { defaultResolution: boolean; rotation: number[] | null } = { defaultResolution: false, rotation: null };
engine.simStudy = (body: string) => {
  const parsed = JSON.parse(body) as {
    request?: { pose?: { rotation?: number[] }; objects?: { pose?: { rotation?: number[] } }[] };
    study?: { checkResolution?: boolean };
  };
  const pose = parsed.request?.objects?.[0]?.pose ?? parsed.request?.pose;
  if (pose?.rotation) captured.rotation = pose.rotation;
  if (parsed.study?.checkResolution === true) {
    captured.defaultResolution = true;
    return JSON.stringify({
      ok: true,
      report: {
        trust: "rough",
        notes: [],
        margins: [],
        maxDisplacementMm: 0,
        minSafetyFactor: 1,
        massG: 0,
      },
    });
  }
  return native.simStudy(body);
};

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

const run = await session.call("sim_run", { object: setup.object, checkResolution: false });
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
const scaledRun = await scaledSession.call("sim_run", { object: scaledObject, checkResolution: false });
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
const editRun = await editSession.call("sim_run", { object: editObject, checkResolution: false });
const editSpot = (editRun.margins as { hotSpot?: { at?: number[] } }[] | undefined)?.[0]?.hotSpot?.at;
const editMass = typeof editRun.massG === "number" ? editRun.massG : 0;
const solvedEdited = editRun.ok === true && Array.isArray(editSpot) && inside(editSpot, [-8, -3, 0], [8, 3, 4]) && editMass > 0.35;
const refusedEdited = editRun.ok === false && editRun.reason === STUDY_MESH_REFUSAL;
check(
  solvedEdited ? "an uncommitted size edit solves the edited solid" : "an uncommitted size edit is refused",
  editSetup.ok === true && (solvedEdited || refusedEdited),
  JSON.stringify(editRun.reason ?? { spot: editSpot, mass: editRun.massG, setup: editSetup.reason }),
);

const flagged = await session.call("sim_run", { object: setup.object });
check(
  "checkResolution defaults to true",
  flagged.ok === true && captured.defaultResolution === true && flagged.representation === "sliced",
  JSON.stringify(flagged.reason ?? { defaultResolution: captured.defaultResolution, representation: flagged.representation }),
);

/** A closed box, the same winding the stand-in uses, so a real slice accepts it. */
function boxPositions(min: number[], max: number[]): Float32Array {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [4, 5, 6, 7],
    [0, 3, 2, 1],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
    [3, 7, 6, 2],
    [0, 1, 5, 4],
  ];
  const positions = new Float32Array(quads.length * 18);
  quads.forEach((quad, face) => {
    const corner = (index: number) => c[quad[index]!]!;
    const write = (tri: number, a: number[], b: number[], d: number[]) => {
      positions.set([...a, ...b, ...d], (face * 2 + tri) * 9);
    };
    write(0, corner(0), corner(1), corner(2));
    write(1, corner(0), corner(2), corner(3));
  });
  return positions;
}

const stlMin = [-4, -3, 0];
const stlMax = [4, 3, 4];
const stlPositions = boxPositions(stlMin, stlMax);
const stlDir = mkdtempSync(join(tmpdir(), "lime-sim-stl-"));
const stlPath = join(stlDir, "turned-box.stl");
writeFileSync(stlPath, Buffer.from(encodeStl(stlPositions, "turned-box")));

const stlSession = new Session(engine);
check("the session already has a printer", stlSession.library.printerId.length > 0, stlSession.library.printerId);
const imported = await stlSession.call("mesh_import", { path: stlPath });
const stlObject = String(imported.object ?? "");
check("an STL imports", imported.ok === true && stlObject.length > 0, String(imported.reason ?? ""));
const turned = await stlSession.call("object_place", { object: stlObject, turn: { axis: "z", degrees: 90 } });
const orient = turned.orient as number[] | undefined;
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
check(
  "the STL pose is not identity",
  turned.ok === true && Array.isArray(orient) && orient.length === 9 && orient.some((value, index) => Math.abs(value - identity[index]!) > 1e-6),
  JSON.stringify(turned.reason ?? orient),
);
await stlSession.call("settings_set", { object: stlObject, values: { infill: 1, walls: 2 } });
const stlSetup = await stlSession.call("sim_setup", {
  object: stlObject,
  hMm: 4,
  fixtures: [{ kind: "bed" }],
  loads: [{ kind: "force", faces: [], magnitude: 2, direction: [0, 0, 1] }],
  card: "inhouse-petg",
  constraints: [{ kind: "minSafetyFactor", value: 1 }],
});
check(
  "an STL with a printer defaults to sliced",
  stlSetup.ok === true && (stlSetup.study as { representation?: string } | undefined)?.representation === undefined,
  String(stlSetup.reason ?? ""),
);
const stlRun = await stlSession.call("sim_run", { object: stlObject, checkResolution: false });
const stlSpot = (stlRun.margins as { hotSpot?: { at?: number[] } }[] | undefined)?.[0]?.hotSpot?.at;
const turnedAway = captured.rotation !== null && captured.rotation.some((value, index) => Math.abs(value - identity[index]!) > 1e-6);
check(
  "a turned STL keeps the hot spot in the part frame",
  stlRun.ok === true
    && stlRun.representation === "sliced"
    && Array.isArray(stlSpot)
    && inside(stlSpot, stlMin, stlMax)
    && turnedAway,
  JSON.stringify(stlRun.reason ?? { spot: stlSpot, rotation: captured.rotation, keys: Object.keys(stlRun) }),
);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sim-sliced: ok");
