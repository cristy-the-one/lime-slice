/**
 * The shortcomings found while two parts were rebuilt through the 3.1.0 MCP server
 * (~/.lime-slice/polish-3.0/mcp-findings-3.1.md), each checked against the stand-in engine.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-rebuild31-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_FAKE = "1";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const ids = (value: Record<string, unknown>) => ((value.objects ?? []) as { object?: string; id?: string }[]).map((row) => row.object ?? row.id);

{
  // Finding 7: a join takes its tool off the plate, and model_undo of the join puts it back; redo takes it off again.
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  const tool = String((await call("solid_new", { primitive: "cylinder", radius: 3, height: 30 })).object);
  const joined = await call("model_apply", { object: part, probe: true, op: { kind: "join", toolObject: tool, op: "cut" } });
  check("a join without keepTool takes its tool off the plate", joined.ok === true && joined.toolLeftPlate === tool && !ids(await call("plate_list")).includes(tool), JSON.stringify(joined));
  const undone = await call("model_undo", { object: part });
  const afterUndo = ids(await call("plate_list"));
  check("model_undo of the join puts the tool back on the plate", undone.ok === true && afterUndo.includes(tool) && (undone.toolsBack as string[] | undefined)?.[0] === tool, JSON.stringify({ undone, afterUndo }));
  const redone = await call("model_redo", { object: part });
  check("model_redo takes it off again", redone.ok === true && !ids(await call("plate_list")).includes(tool), JSON.stringify(redone));
  await call("model_goto", { object: part, node: "node_0" });
  check("a goto before the join brings it back too", ids(await call("plate_list")).includes(tool));
  const kept = await call("model_apply", { object: part, probe: true, op: { kind: "join", toolObject: tool, op: "fuse", keepTool: true } });
  check("keepTool leaves the tool on the plate", kept.ok === true && ids(await call("plate_list")).includes(tool), JSON.stringify(kept));

  // A saved project keeps the taken tool's history: reopened, undo still brings it back.
  await call("model_goto", { object: part, node: "node_1" });
  await call("model_commit", { object: part });
  const saved = await call("project_save", { name: "joined.lime" });
  const reopened = await call("project_open", { path: "joined.lime" });
  const handles = ids(reopened);
  const back = await call("model_undo", { object: part });
  check("a reopened project's undo of the join brings its saved tool back", saved.ok === true && !handles.includes(tool) && back.ok === true && ids(await call("plate_list")).includes(tool), JSON.stringify({ saved, handles, back }));
}

{
  // Finding 11: one object whose mesh will not close no longer blocks the save of the whole plate.
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const good = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  await call("model_commit", { object: good });
  const rings = String((await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 })).object);
  process.env.LIME_MCP_FAKE_OPEN = "1";
  const opened = await call("model_apply", { object: rings, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [0, 0, 9], dx: 2, dy: 2, dz: 2 } });
  delete process.env.LIME_MCP_FAKE_OPEN;
  const refused = await call("model_commit", { object: rings });
  check("the open object itself still refuses a commit", opened.ok === true && refused.ok === false && String(refused.reason).includes("open edge"), JSON.stringify(refused));
  const saved = await call("project_save", { name: "open-one.lime" });
  const warnings = (saved.warnings ?? []) as string[];
  check("project_save saves the plate and names the object it could not commit", saved.ok === true && warnings.length === 1 && warnings[0]!.includes(rings) && warnings[0]!.includes("open edge") && (saved.uncommitted as string[] | undefined)?.[0] === rings, JSON.stringify(saved));
  const reopened = await call("project_open", { path: "open-one.lime" });
  const history = await call("model_history", { object: rings, limit: 10 });
  check("the saved file reopens with both objects and the open object's step", reopened.ok === true && ids(reopened).length === 2 && (history.nodes as unknown[] | undefined)?.length === 2, JSON.stringify({ reopened, history }));
}

{
  // Finding 2: an autosave of a part never committed reopens on its last edit, not on its first solid.
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  for (const x of [-8, 0, 8]) await call("model_apply", { object: part, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [x, -1, 19], dx: 2, dy: 2, dz: 3 } });
  const before = await call("model_history", { object: part, limit: 10 });
  const last = ((before.nodes ?? []) as { id: string; current: boolean }[]).find((row) => row.current)?.id;
  session.flushAutosave();
  await session.autosaveSettled();
  const fresh = new Session(fakeEngine());
  const opened = await fresh.call("project_open", { path: `autosave-${process.pid}.lime` });
  const handle = ids(opened)[0] ?? "";
  const after = await fresh.call("model_history", { object: handle, limit: 10 });
  const rows = (after.nodes ?? []) as { id: string; current: boolean; committed: boolean }[];
  check("the reopened autosave is on the last applied step", last === "node_3" && rows.find((row) => row.current)?.id === "node_3" && rows.find((row) => row.committed)?.id === "node_0", JSON.stringify({ last, rows }));
  const undo = await fresh.call("model_undo", { object: handle });
  check("undo from there goes one step back", undo.node === "node_2", JSON.stringify(undo));
}

{
  // Finding 1: a composite's pieces, built and checked one by one, fold into its group without the group being built
  // again; an engine that cannot fold still gets the group built the old way.
  for (const fold of [true, false]) {
    if (!fold) process.env.LIME_MCP_FAKE_NO_FOLD = "1";
    const engine = fakeEngine();
    const session = new Session(engine);
    const call = (name: string, args: unknown = {}) => session.call(name, args);
    const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
    engine.calls.length = 0;
    const studs = await call("model_apply", { object: part, op: { kind: "pattern", linear: { step: [4, 0, 0], count: 4 }, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [-8, -1, 19], dx: 2, dy: 2, dz: 3 } } });
    const history = await call("model_history", { object: part, limit: 20 });
    const rows = (history.nodes ?? []) as { id: string; label: string; current: boolean }[];
    const groupProbes = engine.calls.filter((name) => name === "probe").length;
    if (fold) {
      check("a composite folds its applied pieces into one group", studs.ok === true && engine.folds === 1 && rows.length === 2 && rows[1]!.current && groupProbes === 4 && !engine.calls.includes("goto"), JSON.stringify({ studs, rows, calls: engine.calls }));
    } else {
      check("an engine that cannot fold still gets the group built", studs.ok === true && engine.folds === 0 && rows.length === 2 && rows[1]!.current && groupProbes === 5, JSON.stringify({ studs, rows, calls: engine.calls }));
    }
    const undone = await call("model_undo", { object: part });
    check(`the ${fold ? "folded" : "built"} group is one undo step`, undone.node === "node_0", JSON.stringify(undone));
    delete process.env.LIME_MCP_FAKE_NO_FOLD;
  }
}

{
  // Finding 9: a modeler that had to be restarted says what that means for the histories.
  process.env.LIME_MCP_HANG_MODEL = "1";
  process.env.LIME_MCP_MODEL_TIMEOUT_S = "0.3";
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  const hung = await call("model_probe", { object: part, op: { kind: "fillet", edges: [0], size: 1 } });
  check("treeLost comes with a sentence on what it means", hung.treeLost === true && String(hung.treeNote).includes("Nothing applied is lost"), JSON.stringify(hung));
  delete process.env.LIME_MCP_HANG_MODEL;
  delete process.env.LIME_MCP_MODEL_TIMEOUT_S;
}

{
  // Finding 8: origin is a round tool's base centre before the turn, which is about the middle of its axis. The reply
  // says where the axis went, with literal coordinates, and says so in a sentence when the base left origin.
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 20 })).object);
  const lying = { kind: "boolean", op: "cut", primitive: "cylinder", radius: 2, height: 10, turn: [0, 90, 0] };
  const byOrigin = await call("model_probe", { object: part, op: { ...lying, origin: [0, 0, 0] } });
  const axis = byOrigin.axis as { base?: number[]; top?: number[] } | undefined;
  check("a turned cylinder by origin echoes its axis from [-5, 0, 5] to [5, 0, 5]", JSON.stringify(axis) === JSON.stringify({ base: [-5, 0, 5], top: [5, 0, 5] }), JSON.stringify(byOrigin));
  check("and says its base is not at origin", String(byOrigin.turnNote).includes("base centre is at [-5, 0, 5]"), JSON.stringify(byOrigin.turnNote));
  const byCentre = await call("model_probe", { object: part, op: { ...lying, centre: [0, 0, 5] } });
  check("the same tool placed by centre has the same axis and no note", JSON.stringify(byCentre.axis) === JSON.stringify(axis) && byCentre.turnNote === undefined && !("centre" in (byCentre.typed as Record<string, unknown>)), JSON.stringify(byCentre));
  const upright = await call("model_probe", { object: part, op: { ...lying, turn: [0, 0, 0], origin: [0, 0, 0] } });
  check("an unturned tool has no axis echo", upright.axis === undefined && upright.turnNote === undefined, JSON.stringify(upright));
}

{
  // Finding 13: a curved face's radius and axis are the engine's, and nearPoint ranks faces by distance to the face.
  // An R95 quarter cylinder about an axis 500 mm from the origin, along Y, as the engine describes it.
  const positions: number[] = [];
  const triangles: number[] = [];
  const at = (angle: number, y: number) => [500 + 95 * Math.cos(angle), y, 95 * Math.sin(angle)];
  for (let k = 0; k < 16; k += 1) {
    const a0 = (k / 16) * (Math.PI / 2);
    const a1 = ((k + 1) / 16) * (Math.PI / 2);
    positions.push(...at(a0, 0), ...at(a1, 0), ...at(a1, 40), ...at(a0, 0), ...at(a1, 40), ...at(a0, 40));
    triangles.push(0, 0);
  }
  const { faceRows } = await import("./solid-geometry.ts");
  const engineSaid = faceRows(positions, triangles, [{ areaMm2: 5969, normal: [0.7071, 0, 0.7071], surface: "cylinder", radiusMm: 95, axisPoint: [500, 0, 0], axis: [0, 1, 0] }]);
  check("a curved face takes the engine's radius and axis", engineSaid[0]!.kind === "cylinder" && engineSaid[0]!.radiusMm === 95 && JSON.stringify(engineSaid[0]!.axis) === "[0,1,0]" && JSON.stringify(engineSaid[0]!.axisPoint) === "[500,0,0]", JSON.stringify(engineSaid[0]));
  const guessed = faceRows(positions, triangles, [{ areaMm2: 5969, normal: [0.7071, 0, 0.7071] }]);
  check("a curved face the engine names no surface for is other, not a guessed cylinder", guessed[0]!.kind === "other" && guessed[0]!.radiusMm === undefined, JSON.stringify(guessed[0]));

  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  const near = await call("faces_find", { object: part, nearPoint: [0, 0, 25] });
  const rows = (near.faces ?? []) as { normal?: number[]; distanceMm?: number }[];
  check("nearPoint ranks every face, nearest first, with its distance", near.total === 6 && JSON.stringify(rows[0]?.normal) === "[0,0,1]" && rows[0]?.distanceMm === 5 && rows.every((row, i) => i === 0 || row.distanceMm! >= rows[i - 1]!.distanceMm!), JSON.stringify(near));
}

{
  // Finding 14: model_probe at an earlier node reads that node's solid for its selectors and sizes, and the history
  // stays where it was.
  const engine = fakeEngine();
  const session = new Session(engine);
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  await call("model_apply", { object: part, probe: true, op: { kind: "scale", factor: 2 } });
  const hole = { kind: "hole", diameterMm: 3, through: true, at: { u: 0, v: 0 } };
  const atRoot = await call("model_probe", { object: part, node: "node_0", op: hole });
  const stored = atRoot.stored as { origin?: number[] } | undefined;
  check("a hole probed at node_0 starts on node_0's top, not the scaled one", atRoot.ok === true && stored?.origin?.[2] === 20, JSON.stringify(atRoot));
  const here = await call("model_probe", { object: part, op: hole });
  const history = await call("model_history", { object: part });
  check("the history and the current solid stay on the scaled step", (here.stored as { origin?: number[] } | undefined)?.origin?.[2] === 40 && ((history.nodes ?? []) as { id: string; current: boolean }[]).find((row) => row.current)?.id === "node_1", JSON.stringify({ here, history }));
}

{
  // Finding 5: a crease hidden a millimetre behind a face draws no specks through it, at any image size.
  const { renderMesh } = await import("./render.ts");
  const front = [0, 0, 0, 100, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0, 100, 100, 0, 100];
  // A ridge along X at Z = 50, one millimetre behind the face, its slopes running back to Y = 11 at a right angle.
  const ridge = [10, 1, 50, 90, 11, 40, 90, 1, 50, 10, 1, 50, 10, 11, 40, 90, 11, 40, 10, 1, 50, 90, 11, 60, 10, 11, 60, 10, 1, 50, 90, 1, 50, 90, 11, 60];
  for (const edge of [96, 256]) {
    // As render_view draws a solid: each triangle's face known (the front face 0, the ridge's slopes 1 and 2).
    const alone = renderMesh(Float32Array.from(front), "front", edge, undefined, { faces: [0, 0] }).png;
    const hidden = renderMesh(Float32Array.from([...front, ...ridge]), "front", edge, undefined, { faces: [0, 0, 1, 1, 2, 2] }).png;
    check(`a crease hidden behind a face leaves the ${edge}px image as it was`, Buffer.from(alone).equals(Buffer.from(hidden)));
  }
  // The same ridge on its own still draws its crease: the middle column is darker on the ridge line than on either slope.
  const { inflateSync } = await import("node:zlib");
  const drawn = renderMesh(Float32Array.from(ridge), "front", 96);
  const png = Buffer.from(drawn.png);
  const parts: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = drawn.width * 3 + 1;
  const column = Array.from({ length: drawn.height }, (_, y) => raw[y * stride + 1 + Math.floor(drawn.width / 2) * 3]!);
  const mid = drawn.height / 2;
  const line = Math.min(...column.slice(mid - 2, mid + 3));
  check("the same crease on its own still draws, on the ridge line", line < 0.95 * Math.min(column[mid - 4]!, column[mid + 4]!), JSON.stringify(column));
}

{
  // Finding 12: a section of a STEP import draws at once, with no model_describe first; a mesh says what it lacks.
  const { fileURLToPath } = await import("node:url");
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const step = String((await call("mesh_import", { path: fileURLToPath(new URL("../samples/step_cube.step", import.meta.url)) })).object);
  const cut = await call("render_view", { object: step, section: { normal: [0, -1, 0] }, inline: false, longEdge: 64 });
  check("render_view sections a fresh STEP import", cut.ok === true && typeof cut.path === "string", JSON.stringify(cut));
  const stl = String((await call("mesh_import", { path: fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url)) })).object);
  const mesh = await call("render_view", { object: stl, section: { normal: [0, -1, 0] }, inline: false, longEdge: 64 });
  check("a mesh is refused with what to do instead", mesh.ok === false && String(mesh.reason).includes("Import its STEP file") && !String(mesh.reason).includes("Open the Model history"), JSON.stringify(mesh));
}

{
  // Finding 16: the step limit is per call, and session_info says so; the op that passes it is refused.
  const engine = fakeEngine();
  const session = new Session(engine);
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const info = await call("session_info");
  const model = info.model as { maxStepsPerCall?: number; stepLimit?: string; maxSteps?: number };
  check("session_info names the limit per call, in a sentence", model.maxStepsPerCall === 400 && String(model.stepLimit).includes("A history has no limit") && model.maxSteps === undefined, JSON.stringify(model));
  const part = String((await call("solid_new", { primitive: "box", dx: 200, dy: 200, dz: 10 })).object);
  const dot = (y: number) => ({ kind: "pattern", linear: { step: [1, 0, 0], count: 200, step2: [0, 1, 0], count2: 1 }, op: { kind: "boolean", op: "cut", primitive: "box", origin: [-100, y, 9], dx: 0.5, dy: 0.5, dz: 2 } });
  engine.calls.length = 0;
  const over = await call("model_apply_batch", { object: part, ops: [dot(0), dot(5), dot(10)] });
  check("a batch past 400 steps is refused at the op that passes it", over.ok === false && String((over.failed as { reason?: string } | undefined)?.reason).includes("more than 400 steps") && (over.failed as { index?: number }).index === 2, JSON.stringify(over).slice(0, 300));
}

{
  // Finding 10: a shell that is too thick says where the part is too thin for it, and the thickest wall that fits.
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 4 })).object);
  const thick = await call("model_probe", { object: part, op: { kind: "shell", thickness: 5 } });
  const where = thick.where as { thinnestMm?: number; at?: number[] } | undefined;
  check("a refused shell names the thinnest place and its thickness", thick.ok === false && where?.thinnestMm === 4 && Array.isArray(where.at) && String(thick.reason).includes("The part is 4 mm thick at (") && String(thick.reason).includes("a 5 mm wall needs 10 mm there"), JSON.stringify(thick));
  check("and the thickest wall that fits", typeof thick.maxMm === "number" && thick.maxMm > 2.8 && thick.maxMm <= 3 && String(thick.reason).includes(`A ${thick.maxMm} mm wall fits.`), JSON.stringify(thick));
}

{
  // Finding 4: a fillet's step pick written inside a list is that pick; several are refused with the shapes taken.
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  await call("model_apply", { object: part, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [-2, -2, 19], dx: 4, dy: 4, dz: 3, label: "boss" } });
  const listed = await call("model_apply_batch", { object: part, ops: [{ kind: "fillet", size: 0.5, edges: [{ fromNode: "boss", filter: "convex" }] }] });
  check("edges: [{fromNode, filter}] is taken as the pick", listed.ok === true && listed.applied === 1, JSON.stringify(listed));
  const several = await call("model_probe", { object: part, op: { kind: "fillet", size: 0.5, edges: [{ fromNode: "boss" }, { fromNode: "node_0" }] } });
  check("several picks in a list are refused with the shapes that are taken", several.ok === false && String(several.reason).includes("{fromNode: \"node_4\", filter: \"convex\"}"), JSON.stringify(several));
}

{
  // Finding 15: mirror and pattern repeat an extrude as whole steps, the mirrored one with its outline mirrored.
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 20 })).object);
  const fin = { kind: "extrude", op: "fuse", origin: [5, 0, 20], turn: [0, 0, 0], profile: [[0, 0], [6, 0], [0, 4]], depth: 3 };
  const mirrored = await call("model_apply", { object: part, op: { kind: "mirror", plane: "x", op: fin, label: "fins" } });
  const obj = session.objects.find((row) => row.id === part)!;
  const group = obj.tree?.nodes.get(obj.tree.current)?.op as { kind?: string; steps?: { kind: string; plane?: { origin?: number[] }; profile?: number[][] }[] } | undefined;
  const second = group?.steps?.[1] as Record<string, unknown> | undefined;
  check("a mirror of an extrude applies as one group of two extrudes", mirrored.ok === true && group?.kind === "group" && group.steps?.length === 2 && group.steps.every((step) => step.kind === "extrude"), JSON.stringify({ mirrored, group }));
  check("the mirrored extrude sits across the plane with its outline mirrored", JSON.stringify(second?.origin ?? (second?.plane as { origin?: unknown } | undefined)?.origin) === "[-5,0,20]" && JSON.stringify(second?.profile) === "[[0,0],[-6,0],[0,4]]", JSON.stringify(second));
  const patterned = await call("model_apply", { object: part, op: { kind: "pattern", linear: { step: [0, 10, 0], count: 3 }, op: { ...fin, origin: [-15, -12, 20] } } });
  const rows = (await call("model_history", { object: part, limit: 10 })).nodes as unknown[];
  check("a pattern of an extrude applies too, as one more group", patterned.ok === true && rows.length === 3, JSON.stringify({ patterned, rows }));
  // A reflection turns a revolve the other way: the mirrored copy walks the same axis line the other way round.
  const swept = await call("model_apply", { object: part, op: { kind: "mirror", plane: "x", op: { kind: "revolve", op: "fuse", origin: [15, 0, 20], turn: [0, 0, 0], profile: [[1, 0], [3, 0], [3, 2], [1, 2]], angleDeg: 90 } } });
  const revolves = (obj.tree?.nodes.get(obj.tree.current)?.op as { steps?: Record<string, unknown>[] } | undefined)?.steps ?? [];
  check("a mirrored revolve keeps its angle and walks its axis the other way", swept.ok === true && revolves.length === 2 && JSON.stringify(revolves[1]?.axisDir ?? (revolves[1]?.axis as { dir?: unknown } | undefined)?.dir) === "[0,-1]", JSON.stringify(revolves[1]));
  let refused: unknown;
  try {
    refused = await call("model_apply", { object: part, op: { kind: "mirror", plane: "x", op: { kind: "fillet", edges: [0], size: 1 } } });
  } catch (err) {
    refused = String(err);
  }
  check("a mirror of a fillet is refused with the ops it repeats", String(refused).includes("repeats one of boolean, extrude, revolve") && String(refused).includes("a fillet is applied once per copy"), String(refused));
}

{
  // Finding 3: the ops guide says what mirror does now, documents join, and names model space; and what it says holds.
  const { guideByUri } = await import("./guides.ts");
  const ops = guideByUri("lime://guide/ops")?.text ?? "";
  check("the ops guide no longer says mirror keeps the original unless keepOriginal is false", !ops.includes("It keeps the original unless keepOriginal is false") && ops.includes("keepOriginal:false applies only the image"));
  check("the ops guide documents join and keepTool", ops.includes('join: {kind:"join"') && ops.includes("keepTool"));
  check("the ops guide reads numbers in model space and names leftOut and jobs", ops.includes("in model space") && ops.includes("leftOut") && ops.includes("slice_wait {job}"));
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  const image = await call("model_apply", { object: part, op: { kind: "mirror", plane: "x", keepOriginal: false, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [6, -1, 19], dx: 2, dy: 2, dz: 3 } } });
  const obj = session.objects.find((row) => row.id === part)!;
  const steps = (obj.tree?.nodes.get(obj.tree.current)?.op as { steps?: { origin?: number[] }[] } | undefined)?.steps ?? [];
  check("keepOriginal:false applies only the mirror image", image.ok === true && steps.length === 1 && steps[0]?.origin?.[0] === -8, JSON.stringify(steps));
}

{
  // Finding 6: a project whose histories replay from the start says so while it opens, and answers with a job
  // instead of outrunning the client.
  const first = new Session(fakeEngine());
  const part = String((await first.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  for (const x of [-8, 0, 8]) await first.call("model_apply", { object: part, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [x, -1, 19], dx: 2, dy: 2, dz: 3 } });
  await first.call("model_commit", { object: part });
  const saved = await first.call("project_save", { name: "replays.lime" });
  // As a project saved before version 3: no solid in the engine's own format to start from.
  const { readFileSync, writeFileSync } = await import("node:fs");
  const doc = JSON.parse(readFileSync(String(saved.path), "utf8")) as { objects: { brep?: unknown }[] };
  for (const row of doc.objects) delete row.brep;
  writeFileSync(String(saved.path), JSON.stringify(doc));
  process.env.LIME_MCP_FAKE_OPEN_MS = "1500";
  process.env.LIME_MCP_REPLY_S = "0.5";
  const session = new Session(fakeEngine());
  const stages: string[] = [];
  session.onProgress = (_job, _fraction, stage) => stages.push(stage);
  const early = await session.call("project_open", { path: "replays.lime" });
  check("an open that replays answers with a job, naming what it does", early.status === "running" && String(early.stage).includes("replaying its 3 steps"), JSON.stringify(early));
  const stop = await session.call("slice_cancel", { job: early.job });
  check("an open cannot be stopped part way, and says so", stop.ok === false && String(stop.reason).includes("cannot stop part way"), JSON.stringify(stop));
  let done = await session.call("slice_wait", { job: early.job, timeoutS: 10 });
  for (let round = 0; done.status === "running" && round < 5; round += 1) done = await session.call("slice_wait", { job: early.job, timeoutS: 10 });
  check("its wait returns the opened project", done.status === "done" && done.ok === true && ids(done).length === 1 && stages.some((stage) => stage.includes("replaying its 3 steps")), JSON.stringify(done));
  delete process.env.LIME_MCP_FAKE_OPEN_MS;

  // A slice_start that became a job hands on its own slice handle, so the same wait loop goes on to the slice.
  const part2 = String((await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  process.env.LIME_MCP_REPLY_S = "0.001";
  await session.call("object_select", { object: part2 });
  let sliced = await session.call("slice_start", {});
  delete process.env.LIME_MCP_REPLY_S;
  for (let round = 0; sliced.status === "running" && round < 10; round += 1) sliced = await session.call("slice_wait", { job: sliced.job, timeoutS: 10 });
  check("a slice_start job leads its wait on to the slice itself", sliced.status === "done" && typeof sliced.seconds === "number", JSON.stringify(sliced));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("rebuild-3-1: ok");
