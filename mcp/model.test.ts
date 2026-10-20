/**
 * Model edits against the stand-in engine: the plate mesh, the split check, face holes,
 * and history replay. The real Open CASCADE kernel is not built in this run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-model-"));
process.env.LIME_MCP_WORKSPACE = workspace;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

function near(value: unknown, expected: number): boolean {
  return typeof value === "number" && Math.abs(value - expected) < 1e-6;
}

const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);

const stl = new URL("../samples/calibration_cube_20mm.stl", import.meta.url);
const step = new URL("../samples/step_cube.step", import.meta.url);
const mesh = await call("mesh_import", { path: fileURLToPath(stl) });
const beforeCalls = engine.calls.length;
const refused = await call("model_probe", { object: mesh.object, op: { kind: "hole", diameterMm: 4, through: true } });
check("a mesh probe is a sentence", refused.ok === false && refused.reason === "Model edits need a STEP file or a new solid. This part is a mesh.", JSON.stringify(refused));
check("a mesh probe does not call the modeler", engine.calls.length === beforeCalls, engine.calls.join(","));

const imported = await call("mesh_import", { path: fileURLToPath(step) });
const object = String(imported.object);
const described = await call("model_describe", { object, limit: 5 });
const faces = described.faces as { index: number; normal?: number[] }[];
const edges = described.edges as { index: number }[];
check("the first page has five faces and five edges", faces.length === 5 && edges.length === 5 && edges[0]?.index === 0 && edges[4]?.index === 4);
check("faces and edges each have a cursor", described.facesNextCursor === "5" && described.edgesNextCursor === "5", JSON.stringify(described));
const second = await call("model_describe", { object, limit: 5, facesCursor: "5", edgesCursor: "5" });
const moreEdges = second.edges as { index: number }[];
check("the second page continues the edges", moreEdges[0]?.index === 5 && moreEdges[moreEdges.length - 1]?.index === 9 && second.edgesNextCursor === "10");
const last = await call("model_describe", { object, limit: 5, edgesCursor: "10" });
const tail = last.edges as { index: number }[];
check("paging reaches the last edge", tail.some((edge) => edge.index === 11) && last.edgesNextCursor === undefined, JSON.stringify(tail));

const plusX = faces.find((face) => face.normal?.[0] === 1)?.index ?? -1;
const faceIndex = (await call("model_describe", { object, limit: 20 })).faces as { index: number; normal?: number[] }[];
const xFace = faceIndex.find((face) => face.normal?.[0] === 1)?.index ?? plusX;
const frame = await call("workplane_set", { object, faceIndex: xFace });
check("the workplane sits on the +X face", frame.ok === true && near((frame.origin as number[])?.[0], 20) && near((frame.origin as number[])?.[1], 10) && near((frame.origin as number[])?.[2], 10), JSON.stringify(frame));
const hole = await call("model_probe", { object, op: { kind: "hole", diameterMm: 4, through: true, at: { u: 0, v: 0 } } });
const stored = hole.stored as { axis?: number[]; origin?: number[] };
check("a hole on that face drills inward", hole.ok === true && near(stored?.axis?.[0], -1) && near(stored?.axis?.[1], 0) && near(stored?.axis?.[2], 0) && near(stored?.origin?.[0], 20) && near(stored?.origin?.[1], 10) && near(stored?.origin?.[2], 10), JSON.stringify(hole));

const bore = await call("model_probe", { object, op: { kind: "hole", diameterMm: 4, through: true, counterboreDiameterMm: 8, counterboreDepth: 3 } });
const boreOp = engine.lastProbe as { counterboreRadius?: number; counterboreDepth?: number };
check("a counterbore reaches the modeler", bore.ok === true && boreOp?.counterboreRadius === 4 && boreOp?.counterboreDepth === 3, JSON.stringify(engine.lastProbe));

const circle = { start: [3, 0], segments: [{ kind: "arc", through: [0, 3], to: [-3, 0] }, { kind: "arc", through: [0, -3], to: [3, 0] }] };
const drafted = await call("model_probe", { object, op: { kind: "extrude", loops: [circle], depth: 5, depth2: 2, draftDeg: 3 } });
const draftedOp = engine.lastProbe as { loops?: unknown[]; depth2?: number; draftDeg?: number; profile?: unknown };
check(
  "loops with a second depth and a draft reach the modeler",
  drafted.ok === true && draftedOp?.loops?.length === 1 && draftedOp?.depth2 === 2 && draftedOp?.draftDeg === 3 && draftedOp?.profile === undefined,
  JSON.stringify({ drafted, probe: engine.lastProbe }),
);

const cut = await call("model_probe", { object, op: { kind: "boolean", primitive: "cylinder", dx: 3, dz: 40, op: "cut" } });
const tool = cut.stored as { radius?: number; height?: number };
check("a boolean cylinder keeps its size", cut.ok === true && tool?.radius === 1.5 && tool?.height === 40, JSON.stringify(cut.stored));

const made = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
const box = String(made.object);
const far = await call("model_probe", { object: box, op: { kind: "split", origin: [0, 0, 500], normal: [0, 0, 1] } });
const appliesBefore = engine.calls.filter((name) => name === "apply").length;
const farApply = await call("model_apply", { object: box, op: { kind: "split", origin: [0, 0, 500], normal: [0, 0, 1] } });
check("a split outside the part is refused", far.ok === false && far.reason === "Move the plane into the part, between 0 and 10 mm.", JSON.stringify(far));
check("a refused split is not applied", farApply.ok === false && engine.calls.filter((name) => name === "apply").length === appliesBefore);
const mid = await call("model_probe", { object: box, op: { kind: "split", origin: [0, 0, 5], normal: [0, 0, 1] } });
check("a split through the middle fits", mid.ok === true && mid.reason === "From 0 to 10 mm. The middle is 5.", JSON.stringify(mid));

const grown = await call("model_probe", { object: box, op: { kind: "scale", factor: 2 } });
check("a scale of 2 fits", grown.ok === true, JSON.stringify(grown));
const scaled = await call("model_apply", { object: box, op: { kind: "scale", factor: 2 } });
check("the scale is applied", scaled.ok === true, JSON.stringify(scaled));
const committed = await call("model_commit", { object: box });
const stats = await call("mesh_stats", { object: box });
const size = stats.sizeMm as number[];
check("a scale of 2 doubles the part and the plate scale stays at 100", committed.ok === true && committed.scalePercent === 100 && near(size?.[0], 20) && near(size?.[2], 20), JSON.stringify({ committed, size }));

const part = await call("mesh_import", { path: fileURLToPath(step) });
const solid = String(part.object);
const plain = await call("model_describe", { object: solid });
const beforeTris = (await call("mesh_stats", { object: solid })).triangles;
const drilled = await call("model_probe", { object: solid, op: { kind: "hole", diameterMm: 4, through: true, at: { u: 10, v: 10 } } });
check("the hole fits the cube", drilled.ok === true, JSON.stringify(drilled));
await call("model_apply", { object: solid, op: { kind: "hole", diameterMm: 4, through: true, at: { u: 10, v: 10 } } });
const holed = await call("model_describe", { object: solid });
check("the hole changes the volume", holed.volumeMm3 !== plain.volumeMm3, JSON.stringify({ before: plain.volumeMm3, after: holed.volumeMm3 }));
const fillet = { kind: "fillet", edges: [0], size: 1 };
await call("model_probe", { object: solid, op: fillet });
await call("model_apply", { object: solid, op: fillet });
const history = await call("model_history", { object: solid });
const nodes = history.nodes as { id: string; label: string; parent: string | null }[];
const holeNode = nodes.find((node) => node.label.startsWith("Hole"));
const wider = await call("model_probe", { object: solid, op: { kind: "hole", diameterMm: 6, through: true, at: { u: 10, v: 10 } } });
check("the wider hole is probed on the step on screen", wider.ok === true, JSON.stringify(wider));
const edited = await call("model_edit", { object: solid, node: holeNode?.id, op: { kind: "hole", diameterMm: 6, through: true, at: { u: 10, v: 10 } } });
check("the edit rebuilds in one call", edited.ok === true && edited.built === true, JSON.stringify(edited));
const after = await call("model_history", { object: solid, limit: 20 });
const rows = after.nodes as { id: string; label: string; parent: string | null; current: boolean }[];
const current = rows.find((row) => row.current);
const widerHole = rows.find((row) => row.label.startsWith("Hole ⌀6"));
const replayed = rows.find((row) => row.label.startsWith("Fillet") && row.parent === widerHole?.id);
check("the replayed fillet is the step on screen", current?.id === replayed?.id && widerHole != null, JSON.stringify(rows));
const editedSolid = await call("model_describe", { object: solid });
check("the edited solid's volume changed", editedSolid.volumeMm3 !== holed.volumeMm3);

const plate = await call("model_commit", { object: solid });
const afterTris = (await call("mesh_stats", { object: solid })).triangles;
check("commit replaces the plate mesh", plate.ok === true && afterTris !== beforeTris, JSON.stringify({ beforeTris, afterTris }));
await call("machine_select", { printerId: "lime-220", filamentId: "lime-pla" });
const started = await call("slice_start", {});
check("the slice starts from the committed solid", started.ok === true, JSON.stringify(started));
const wire = JSON.parse(engine.lastSlice) as { dataB64?: string; objects?: { id?: string; dataB64?: string }[] };
const row = wire.objects?.find((item) => item.id === solid) ?? { dataB64: wire.dataB64 };
const stlBytes = Buffer.from(String(row.dataB64 ?? ""), "base64");
const slicedTris = stlBytes.length >= 84 ? stlBytes.readUInt32LE(80) : 0;
check("the slice mesh is the committed solid", slicedTris === afterTris && (wire.objects?.some((item) => item.id === solid) ?? wire.dataB64 != null), String(slicedTris));
const pack = await call("export_3mf", { name: "holed.3mf" });
check("the 3MF is written", pack.ok === true && typeof pack.bytes === "number" && pack.bytes > 0, JSON.stringify(pack));
const saved = await call("project_save", { name: "holed.lime" });
check("the holed solid saves", saved.ok === true, JSON.stringify(saved));
const again = new Session(engine);
const reopened = await again.call("project_open", { path: String(saved.path) });
const reopenedRows = (reopened.objects as { object: string }[]) ?? [];
let keptMesh = false;
for (const row of reopenedRows) {
  const stats = await again.call("mesh_stats", { object: row.object });
  if (stats.triangles === afterTris) keptMesh = true;
}
check("reopening keeps the committed mesh", reopened.ok === true && keptMesh, JSON.stringify(reopened));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("model: ok");
