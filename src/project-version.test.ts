/**
 * Organic fix round, item 17: a project is written as version 5 only when it holds something 7.1.2 (version 4) would
 * lose or misread; any other project is version 4, byte for byte what 7.1.2's writer makes, so it still opens there.
 * 7.1.2 refuses a version 5 file with its own message instead of opening it with History dropped.
 */
import { createHash } from "node:crypto";

import { meshRecord, parseProject, serializeProject, PLAIN_PROJECT_VERSION, PROJECT_VERSION, type LimeProject } from "./project.ts";
import { projectNeedsLatest, projectWire } from "./project-envelope.ts";
import { DEFAULT_PRESET } from "./presets.ts";
import { defaultProfile } from "./profiles.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

/** A small plate with one object whose history is `steps` (stored ops) on a primitive root. Every value is explicit. */
function plate(steps: unknown[], rootFeature?: unknown, full = false): LimeProject {
  const bytes = new Uint8Array(84);
  const placement = { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.05 };
  const nodes = [{ id: 0, parent: null, op: null, fingerprint: null }, ...steps.map((op, i) => ({ id: i + 1, parent: i, op, fingerprint: null }))];
  const root = rootFeature ? { rootFeature } : { rootPrimitive: { primitive: "box", origin: [0, 0, 0], size: [20, 20, 20] } };
  return {
    version: 2,
    mesh: meshRecord("part.stl", bytes),
    placement,
    settings: full ? { ...DEFAULT_PRESET } : { layerHeight: 0.2 },
    preset: null,
    profile: full ? defaultProfile() : { name: "Test printer" },
    level: "simple",
    supportEdits: [],
    objects: [{ id: "part", name: "part.stl", mesh: meshRecord("part.stl", bytes), placement, supportEdits: [], modelTree: { nodes, current: steps.length, committed: steps.length, nextId: steps.length + 1, ...root } }],
  } as unknown as LimeProject;
}

// --- A project 7.1.2 could make: version 4, the same bytes its writer makes.
const box = { kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 5], size: [8, 10, 10], radius: 0, height: 0, turn: [0, 0, 0] };
const fillet = { kind: "fillet", edges: [1, 2], size: 1 };
const loft = { kind: "loft", op: "fuse", sections: [{ origin: [0, 0, 0], turn: [0, 0, 0], radius: 5 }, { origin: [0, 0, 10], turn: [0, 0, 0], radius: 3 }] };
const sketched = {
  kind: "extrude", op: "fuse", origin: [0, 0, 20], turn: [0, 0, 0], depth: 5,
  loops: [{ start: [0, 0], segments: [{ kind: "spline", through: [[5, 5]], to: [10, 0] }, { kind: "line", to: [0, 0] }] }],
  sketch: { v: 1, plane: { origin: [0, 0, 0], turn: [0, 0, 0] }, points: [{ id: 1, at: [0, 0] }, { id: 2, at: [5, 5] }, { id: 3, at: [10, 0] }], entities: [{ id: 1, kind: "spline", through: [1, 2, 3] }, { id: 2, kind: "line", a: 3, b: 1 }] },
};
const plainProject = plate([box, fillet, loft, sketched]);
const plainText = serializeProject(plainProject);
const plainHash = createHash("sha256").update(plainText).digest("hex");
console.log(`plain project: version ${JSON.parse(plainText).version}, sha256 ${plainHash}`);
check("a project with only 7.1.2 steps is written as version 4", JSON.parse(plainText).version === PLAIN_PROJECT_VERSION && PLAIN_PROJECT_VERSION === 4);
// The same fixture serialized by origin/main's writer (v7.1.2's src/project-envelope.ts, run on 2026-11-23).
const MAIN_WRITER_SHA256 = "f04d787921d4d3f2812232ae16665a36e0e206b97334fa92fa08118cfe13d278";
check("its bytes are exactly what 7.1.2's writer makes", plainHash === MAIN_WRITER_SHA256, `${plainHash} vs ${MAIN_WRITER_SHA256}`);

// --- Each newer step kind, field or shape makes it version 5.
const curve = { kind: "polyline", points: [[0, 0, 0], [0, 0, 10]] };
const sheetSpec = { mode: "extrude", curves: [curve], dir: [1, 0, 0], distance: 5 };
const newer: [string, unknown[], unknown?][] = [
  ["a sweep along a spine", [{ kind: "sweep", op: "fuse", sections: [{ origin: [0, 0, 0], turn: [0, 0, 0], radius: 1 }], spine: curve }]],
  ["a sheet", [{ kind: "sheet", ...sheetSpec }]],
  ["a sheet as the root", [], { kind: "sheet", ...sheetSpec }],
  ["sew", [{ kind: "sew" }]],
  ["thicken", [{ kind: "thicken", thickness: 2 }]],
  ["trim/split", [{ kind: "trimSplit", sheet: sheetSpec }]],
  ["replace face", [{ kind: "replaceFace", face: 0, sheet: sheetSpec }]],
  ["split face", [{ kind: "splitFace", faces: [0], curve }]],
  ["patch", [{ kind: "patch", boundaries: [{ edges: [1] }, { edges: [2] }] }]],
  ["blend surface", [{ kind: "blendSurface", a: { edges: [1] }, b: { edges: [2] } }]],
  ["a NURBS surface (S6), or any later kind", [{ kind: "nurbsSurface", poles: [] }]],
  ["a fillet's continuity", [{ ...fillet, continuity: "g2" }]],
  ["a fillet's rho", [{ ...fillet, continuity: "conic", rho: 0.5 }]],
  ["a variable fillet", [{ ...fillet, variable: [[0, 1], [1, 3]] }]],
  ["loft guides", [{ ...loft, guides: [curve] }]],
  ["a loft start condition", [{ ...loft, startCondition: { kind: "normal" } }]],
  ["a closed loft", [{ ...loft, closed: true }]],
  ["loft smoothing", [{ ...loft, smoothing: true }]],
  ["a loft max degree", [{ ...loft, maxDegree: 5 }]],
  ["a loft apex", [{ ...loft, sections: [loft.sections[0], { apex: [0, 0, 10] }] }]],
  ["a nurbs profile segment", [{ ...sketched, loops: [{ start: [0, 0], segments: [{ kind: "nurbs", poles: [[5, 5]], to: [10, 0] }, { kind: "line", to: [0, 0] }] }] }]],
  ["a control-point sketch spline", [{ ...sketched, sketch: { ...sketched.sketch, entities: [{ id: 1, kind: "spline", through: [1, 2, 3], mode: "cv" }, sketched.sketch.entities[1]] } }]],
  ["a sketch spline's weights", [{ ...sketched, sketch: { ...sketched.sketch, entities: [{ id: 1, kind: "spline", through: [1, 2, 3], mode: "cv", weights: [1, 2, 1] }, sketched.sketch.entities[1]] } }]],
  ["a newer step inside a group", [{ kind: "group", steps: [box, { kind: "thicken", thickness: 1 }] }]],
];
for (const [name, steps, root] of newer) {
  const wire = projectWire(plate(steps, root));
  check(`${name}: written as version 5`, wire.version === PROJECT_VERSION && PROJECT_VERSION === 5 && projectNeedsLatest(wire), `version=${String(wire.version)}`);
}
// A kept tool's or a held piece's history counts too.
{
  const project = plate([box]);
  const tool = plate([{ kind: "sew" }]).objects![0]!.modelTree;
  const withTool = { ...project, modelTools: [{ id: "tool-1", name: "tool", modelTree: tool }] } as unknown as LimeProject;
  check("a kept tool's newer step makes the project version 5", projectWire(withTool).version === 5);
}

// --- A version 5 file reads back, steps and all.
{
  // A whole project (the app's default settings and printer), so the reader takes every section.
  const text = serializeProject(plate([{ kind: "thicken", thickness: 2 }], undefined, true));
  const plainWhole = serializeProject(plate([box, fillet], undefined, true));
  const back = parseProject(text);
  const steps = back.ok ? (back.project.objects?.[0]?.modelTree as { nodes?: { op?: { kind?: string } | null }[] } | undefined)?.nodes : undefined;
  check("a version 5 file opens in this app with its newer step", back.ok && steps?.some((node) => node.op?.kind === "thicken") === true, back.ok ? JSON.stringify(steps) : back.message);
  check("a version 4 file still opens", JSON.parse(plainWhole).version === 4 && parseProject(plainWhole).ok);

  // --- 7.1.2's reader refuses it, with its own words. This is v7.1.2's applyMigrations (origin/main, src/project-envelope.ts),
  // copied: target 4, migrations up to 3 -> 4.
  const mainSteps: ((doc: Record<string, unknown>) => Record<string, unknown>)[] = [];
  mainSteps[2] = (doc) => ({ ...doc, version: 3 });
  mainSteps[3] = (doc) => ({ ...doc, version: 4 });
  function mainApplyMigrations(doc: Record<string, unknown>, target = 4): { ok: true; doc: Record<string, unknown> } | { ok: false; message: string } {
    if (typeof doc.version !== "number" || !Number.isInteger(doc.version)) return { ok: false, message: "This project file has no version, so it cannot be opened." };
    let current = doc;
    let version = doc.version;
    if (version > target) return { ok: false, message: `This project is version ${version}. This app opens up to version ${target}.` };
    while (version < target) {
      const step = mainSteps[version];
      if (!step) return { ok: false, message: `This project is version ${version}, which this app cannot update.` };
      current = step({ ...current });
      version = current.version as number;
    }
    return { ok: true, doc: current };
  }
  const old = mainApplyMigrations(JSON.parse(text) as Record<string, unknown>);
  console.log(`7.1.2 opening the version 5 file: ${old.ok ? "opened" : old.message}`);
  check("7.1.2 refuses the version 5 file: \"This project is version 5. This app opens up to version 4.\"", !old.ok && old.message === "This project is version 5. This app opens up to version 4.");
  check("7.1.2 still opens the plain version 4 file", mainApplyMigrations(JSON.parse(plainWhole) as Record<string, unknown>).ok);
}

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("project version guard: ok");
