/**
 * The MCP server against real Open CASCADE.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 * Build with CARGO_BUILD_JOBS=2. The rust job runs this after the OCCT install.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { plainDocument } from "../src/project-codec.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-occt-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

function near(value: unknown, expected: number, tol = 0.2): boolean {
  return typeof value === "number" && Math.abs(value - expected) < tol;
}

const session = new Session(loadEngineWorker(root));
const call = (name: string, args: unknown = {}) => session.call(name, args);
const step = fileURLToPath(new URL("../samples/step_cube.step", import.meta.url));
const stl = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));

const info = await call("session_info", {});
check("Open CASCADE is loaded", info.ok === true && info.occt === true, JSON.stringify(info));

const mesh = await call("mesh_import", { path: stl });
const v1 = await call("project_save", { name: "mesh.lime" });
check("a mesh saves without a model tree", mesh.ok === true && v1.ok === true, JSON.stringify(v1));

const imported = await call("mesh_import", { path: step });
const object = String(imported.object);
const described = await call("model_describe", { object, limit: 20 });
check("the step cube is about 1000 mm³", near(described.volumeMm3, 1000, 1), JSON.stringify(described.volumeMm3));

const tiltedOut = await call("model_probe", { object, op: { kind: "split", origin: [20, 20, 20], normal: [1, 1, 1] } });
const tiltedIn = await call("model_probe", { object, op: { kind: "split", origin: [5, 5, 5], normal: [1, 1, 1] } });
check("a corner cube refuses a plane past the part", tiltedOut.ok === false, JSON.stringify(tiltedOut));
check("a corner cube accepts a diagonal through it, from 0 to 17.32 mm", tiltedIn.ok === true && tiltedIn.reason === "From 0 to 17.32 mm. The middle is 8.66.", JSON.stringify(tiltedIn));

const hole = await call("model_probe", { object, op: { kind: "hole", diameterMm: 4, through: true, origin: [5, 5, 10], axis: [0, 0, -1] } });
await call("model_apply", { object, op: { kind: "hole", diameterMm: 4, through: true, origin: [5, 5, 10], axis: [0, 0, -1] } });
const holed = await call("model_describe", { object });
check("a through hole leaves 874.34 mm³", hole.ok === true && near(holed.volumeMm3, 874.34, 0.5), JSON.stringify({ hole, volume: holed.volumeMm3 }));

const boreObject = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
const boreId = String(boreObject.object);
// A new box is centred on X and Y with its base on Z = 0, so the top centre is [0, 0, 10].
// The tool is the ⌀6 counterbore for 2 mm, then the ⌀3 hole for the remaining 6 mm. One fused
// cut, so the overlap is not subtracted twice: 1000 − π·3²·2 − π·1.5²·6.
const boreOp = { kind: "hole", diameterMm: 3, depth: 8, origin: [0, 0, 10], axis: [0, 0, -1], counterboreDiameterMm: 6, counterboreDepth: 2 };
const counterboreMm3 = 1000 - Math.PI * 3 ** 2 * 2 - Math.PI * 1.5 ** 2 * (8 - 2);
const bore = await call("model_probe", { object: boreId, op: boreOp });
await call("model_apply", { object: boreId, op: boreOp });
const bored = await call("model_describe", { object: boreId });
check("a counterbore leaves about 901.04 mm³", bore.ok === true && near(bored.volumeMm3, counterboreMm3, 0.5), JSON.stringify({ volume: bored.volumeMm3, expected: counterboreMm3 }));

const fat = await call("model_probe", { object: boreId, op: { kind: "fillet", edges: [0], size: 50 } });
check("an oversized fillet is refused with a largest size", fat.ok === false && (typeof fat.maxMm === "number" || String(fat.reason).includes("did not finish")), JSON.stringify(fat));

const outside = await call("model_probe", { object, op: { kind: "split", origin: [20, 20, 20], normal: [1, 1, 1] } });
check("a split outside the part is refused", outside.ok === false, JSON.stringify(outside));

const committed = await call("model_commit", { object });
const started = await call("slice_start", {});
const waited = await call("slice_wait", { job: started.job, timeoutS: 90 });
const packed = await call("export_3mf", { name: "holed.3mf" });
const stepFile = await call("model_export_step", { object, name: "holed.step" });
const saved = await call("project_save", { name: "holed.lime" });
const reopened = await call("project_open", { path: String(saved.path) });
const opened = Array.isArray(reopened.objects) ? reopened.objects as { object: string }[] : [];
let reopenedId = "";
let again: Record<string, unknown> = {};
let labels: string[] = [];
for (const row of opened) {
  const described = await call("model_describe", { object: row.object });
  const history = await call("model_history", { object: row.object, limit: 20 });
  const nodes = Array.isArray(history.nodes) ? history.nodes as { label?: string }[] : [];
  const rowLabels = nodes.map((node) => node.label ?? "");
  if (near(described.volumeMm3, 874.34, 0.5) && rowLabels.some((label) => label.startsWith("Hole"))) {
    reopenedId = row.object;
    again = described;
    labels = rowLabels;
  }
}
check("commit, slice, 3MF, STEP, save, and reopen succeed", committed.ok === true && started.ok === true && waited.ok === true && packed.ok === true && stepFile.ok === true && typeof stepFile.bytes === "number" && stepFile.bytes > 100 && saved.ok === true && reopened.ok === true, JSON.stringify({ committed, started, waited, packed, stepFile, saved, reopened }));
check("the reopened solid is still the holed cube", reopenedId !== "" && near(again.volumeMm3, 874.34, 0.5) && labels.some((label) => label.startsWith("Hole")), JSON.stringify({ volume: again.volumeMm3, labels, objects: opened.length }));

// Version 4: the saved solid is the engine's own bytes, compressed. A reopen gets the same bytes back as the seed, so
// the whole tree opens from it at once, with nothing replayed.
{
  const text = readFileSync(String(saved.path), "utf8");
  const raw = JSON.parse(text) as { version?: number; objects?: { brep?: { encoding?: string; byteLength?: number; bytesBase64?: string } }[] };
  const plain = (await plainDocument(text)) as typeof raw;
  const brepIndex = Math.max(0, (raw.objects ?? []).findIndex((row) => row.brep));
  const brep = plain.objects?.[brepIndex]?.brep;
  const bytes = brep?.bytesBase64 ? Buffer.from(brep.bytesBase64, "base64") : Buffer.alloc(0);
  check("the saved file is version 4 and its solid is compressed", raw.version === 4 && raw.objects?.[brepIndex]?.brep?.encoding === "gzip+base64" && raw.objects[brepIndex]!.brep!.bytesBase64 === undefined, JSON.stringify(raw.version));
  check("the solid unpacks to the engine's binary format, of its recorded length", bytes.toString("latin1", 0, 9) === "LIMEBREP " && bytes.length === brep?.byteLength && bytes.length > 100, `${bytes.length}`);
  const packedLength = String((JSON.parse(text) as { objects: { brep: { data: string } }[] }).objects[brepIndex]!.brep.data.length);
  check("the stored solid is shorter than the same solid as base64", Number(packedLength) < Math.ceil(bytes.length / 3) * 4, `${packedLength} vs ${bytes.length}`);
  const t0 = Date.now();
  const timed = new Session(loadEngineWorker(root));
  const quick = await timed.call("project_open", { path: String(saved.path) });
  const quickVolumes: unknown[] = [];
  for (const row of (quick.objects as { object: string }[] | undefined) ?? []) quickVolumes.push((await timed.call("model_describe", { object: row.object })).volumeMm3);
  const quickDescribed = { volumeMm3: quickVolumes.find((volume) => near(volume, 874.34, 0.5)) };
  check("a version 4 file reopens from its solid with no history replayed, and the same volume", quick.ok === true && quick.historyNotes === undefined && near(quickDescribed.volumeMm3, 874.34, 0.5), JSON.stringify({ notes: quick.historyNotes, volume: quickDescribed.volumeMm3 }));
  check("and in good time", Date.now() - t0 < 20000, `${Date.now() - t0} ms`);
}

const corner = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
const cornerId = String(corner.object);
const cornerOp = { kind: "hole", diameterMm: 3, depth: 8, origin: [5, 5, 10], axis: [0, 0, -1], counterboreDiameterMm: 6, counterboreDepth: 2 };
const cornerProbe = await call("model_probe", { object: cornerId, op: cornerOp });
const cornerCut = await call("model_apply", { object: cornerId, op: cornerOp });
const cornerSaved = await call("project_save", { name: "corner.lime" });
const previousBudget = process.env.LIME_MCP_MODEL_TIMEOUT_S;
process.env.LIME_MCP_MODEL_TIMEOUT_S = "8";
const cornerStarted = Date.now();
const cornerOpened = await call("project_open", { path: String(cornerSaved.path) });
const cornerSeconds = (Date.now() - cornerStarted) / 1000;
if (previousBudget === undefined) delete process.env.LIME_MCP_MODEL_TIMEOUT_S;
else process.env.LIME_MCP_MODEL_TIMEOUT_S = previousBudget;
const cornerRows = Array.isArray(cornerOpened.objects) ? cornerOpened.objects as { object: string }[] : [];
const cornerBack = cornerRows.length ? await call("model_describe", { object: cornerRows[cornerRows.length - 1]!.object }) : {};
// The hole sits on a corner of the centred box, so a quarter of it is cut: 975.26 mm³ is left.
// A reopen that runs out of time is a failure. Mesh preview used to loop on this solid's STEP edges.
check(
  "a corner cut reopens within its time budget",
  corner.ok === true && cornerProbe.ok === true && cornerCut.ok === true && cornerSaved.ok === true && cornerOpened.ok === true && cornerSeconds < 8 && near(cornerBack.volumeMm3, 975.26, 0.5),
  JSON.stringify({ cornerProbe, cornerCut, cornerSaved, cornerOpened, cornerSeconds, volume: cornerBack.volumeMm3 }),
);

// The 2.6.1 back cover: a filleted, shelled box with a cut through the floor, then two crossing sets of ribs. The
// second set used to resolve to strips between the first, end edge to edge against it, and one fuse came back as only
// its tool (307 mm³). With equal widths, the crossing was refused as a piece touching at an edge.
async function backCover(equal: boolean, oneBatch: boolean): Promise<{ object: string; volume: number; runs: Record<string, unknown>[] }> {
  const made = await call("solid_new", { primitive: "box", dx: 680, dy: 150, dz: 45 });
  const id = String(made.object);
  await call("model_apply", { object: id, probe: true, op: { kind: "fillet", edges: { select: { direction: [0, 0, 1] } }, size: 18 } });
  await call("model_apply", { object: id, probe: true, op: { kind: "fillet", edges: { select: { onFace: { normal: [0, 0, -1] } } }, size: 8 } });
  await call("model_apply", { object: id, probe: true, op: { kind: "shell", thickness: 2.5, openFaces: [{ normal: [0, 0, 1] }] } });
  await call("model_apply", { object: id, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", centre: [25, -5, 1], dx: 14, dy: 14, dz: 6 } });
  const a = { kind: "ribs", face: { normal: [0, 0, 1], nearPoint: [0, 0, 2.5] }, along: "u", angleDeg: 36.87, width: 1.6, pitch: 24, depth: 8 };
  const b = { ...a, angleDeg: -36.87, width: equal ? 1.6 : 1.62, depth: equal ? 8 : 8.1 };
  const runs = oneBatch
    ? [await call("model_apply_batch", { object: id, ops: [a, b] })]
    : [await call("model_apply_batch", { object: id, ops: [a] }), await call("model_apply_batch", { object: id, ops: [b] })];
  const after = await call("model_describe", { object: id, limit: 1 });
  return { object: id, volume: Number(after.volumeMm3), runs };
}

const cover = await backCover(false, false);
check(
  "a second set of ribs in its own call keeps the part (more than 500,000 mm³) and misses nothing",
  cover.runs.every((run) => run.ok === true && run.skipped === undefined) && cover.volume > 500000 && cover.volume < 530000,
  JSON.stringify({ volume: cover.volume, runs: cover.runs.map(({ checkpoints: _c, ...rest }) => rest) }),
);
const coverChecked = await call("model_check", { object: cover.object });
check("the ribbed cover's mesh closes", JSON.stringify(coverChecked.edges) === JSON.stringify({ open: 0, nonManifold: 0 }), JSON.stringify(coverChecked.edges));
const coverCommit = await call("model_commit", { object: cover.object });
check("the ribbed cover commits", coverCommit.ok === true, JSON.stringify(coverCommit));
const crossing = await backCover(true, true);
check(
  "crossing ribs of equal width in one batch apply",
  crossing.runs[0]!.ok === true && crossing.volume > 500000 && crossing.volume < 530000,
  JSON.stringify({ volume: crossing.volume, run: crossing.runs.map(({ checkpoints: _c, ...rest }) => rest) }),
);
const crossingCommit = await call("model_commit", { object: crossing.object });
check("the equal-width cover commits with a closed mesh", crossingCommit.ok === true, JSON.stringify(crossingCommit));

// --- The 3.1 rebuild findings, against real Open CASCADE.
/** The solid's box, from its faces' boxes. */
async function solidBox(object: string): Promise<{ min: number[]; max: number[] }> {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let cursor: string | undefined;
  do {
    const page = await call("faces_find", { object, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const face of (page.faces ?? []) as { bbox: { min: number[]; max: number[] } }[]) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k]!, face.bbox.min[k]!);
        max[k] = Math.max(max[k]!, face.bbox.max[k]!);
      }
    }
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor);
  return { min, max };
}
{
  const block = String((await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 20 })).object);
  // 13: a cylinder's radius and axis are the kernel's.
  await call("model_apply", { object: block, probe: true, op: { kind: "boolean", op: "cut", primitive: "cylinder", origin: [5, 5, -1], radius: 3, height: 30 } });
  const round = await call("faces_find", { object: block, kind: "cylinder" });
  const bore = ((round.faces ?? []) as { radiusMm?: number; axis?: number[]; axisPoint?: number[] }[])[0];
  check("faces_find reads a bore's radius and axis from the kernel", near(bore?.radiusMm, 3, 1e-6) && Math.abs(Math.abs(bore?.axis?.[2] ?? 0) - 1) < 1e-9 && near(bore?.axisPoint?.[0], 5, 1e-6), JSON.stringify(round));
  // 8: a turned cylinder by origin lies where its axis echo says.
  const lying = await call("model_apply", { object: block, probe: true, op: { kind: "boolean", op: "fuse", primitive: "cylinder", origin: [0, -10, 16], radius: 2, height: 10, turn: [0, 90, 0] } });
  const lyingBox = await solidBox(block);
  check("a turned cylinder's axis echo matches the kernel's solid", lying.ok === true && JSON.stringify(lying.axis) === JSON.stringify({ base: [-5, -10, 21], top: [5, -10, 21] }) && near(lyingBox.max[2], 23, 0.05), JSON.stringify({ lying, lyingBox }));
  // 15: a mirrored extrude lands across the plane, with the same volume as the original.
  const before = Number((await call("model_describe", { object: block, limit: 1 })).volumeMm3);
  const fins = await call("model_apply", { object: block, op: { kind: "mirror", plane: "x", op: { kind: "extrude", op: "fuse", origin: [20, 0, 5], turn: [0, 0, 0], profile: [[0, 0], [6, 0], [0, 4]], depth: 3 } } });
  const after = await call("model_describe", { object: block, limit: 1 });
  const box = await solidBox(block);
  check("a mirror of an extrude adds the fin and its image", fins.ok === true && near(Number(after.volumeMm3) - before, 2 * 36, 0.05) && near(box.min[0], -26, 0.01) && near(box.max[0], 26, 0.01), JSON.stringify({ fins, before, after: after.volumeMm3, box }));
  // 15: a mirrored quarter revolve is the image of the original: the part stays symmetric about X = 0.
  // A quarter revolve on the top face sweeps up, out of the block; a copy turned the wrong way would sweep into it.
  const sweep = { kind: "revolve", op: "fuse", origin: [10, 0, 10], turn: [0, 0, 0], profile: [[0, -2], [4, -2], [4, 2], [0, 2]], angleDeg: 90 };
  const one = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 })).object);
  const oneBefore = Number((await call("model_describe", { object: one, limit: 1 })).volumeMm3);
  await call("model_apply", { object: one, probe: true, op: sweep });
  const single = Number((await call("model_describe", { object: one, limit: 1 })).volumeMm3) - oneBefore;
  const wheel = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 })).object);
  const quarter = await call("model_apply", { object: wheel, op: { kind: "mirror", plane: "x", op: sweep } });
  const both = Number((await call("model_describe", { object: wheel, limit: 1 })).volumeMm3) - oneBefore;
  const wheelBox = await solidBox(wheel);
  check("a mirrored quarter revolve is the original's image", quarter.ok === true && single > 1 && near(both, 2 * single, 0.05) && near(wheelBox.min[0], -wheelBox.max[0], 0.01), JSON.stringify({ quarter, single, both, wheelBox }));
  // 5: a sliver the solid really has is named by render_view.
  await call("model_apply", { object: block, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [19.9, 10, 10], dx: 0.2, dy: 0.25, dz: 0.25 } });
  const drawn = await call("render_view", { object: block, camera: "iso", inline: false, longEdge: 128, name: "slivers.png" });
  check("render_view names faces too small to see", (drawn.slivers as { count?: number } | undefined)?.count! > 0, JSON.stringify(drawn.slivers));
  // 10: a shell too thick for a thin plate says where and the thickest that fits.
  const plate = String((await call("solid_new", { primitive: "box", dx: 30, dy: 30, dz: 3 })).object);
  const shell = await call("model_probe", { object: plate, op: { kind: "shell", thickness: 4, openFaces: [{ normal: [0, 0, 1] }] } });
  check("a refused shell names the thin place and the thickest wall that fits", shell.ok === false && (shell.where as { thinnestMm?: number } | undefined)?.thinnestMm !== undefined && typeof shell.maxMm === "number" && shell.maxMm < 3, JSON.stringify(shell));
}

// --- Split to print (docs/plan-split-connectors.md, milestone 3): plan, probe, apply, commit, and an edit that cuts
// every piece again, against real Open CASCADE.
{
  const bar = String((await call("solid_new", { primitive: "box", dx: 500, dy: 20, dz: 20 })).object);
  const volume = async (object: string) => Number((await call("model_describe", { object, limit: 1 })).volumeMm3);
  const plan = await call("model_probe", { object: bar, op: { kind: "partition" }, plan: true });
  check("plan proposes two cuts for a 500 mm bar on the Lime 220", plan.ok === true && plan.pieces === 3 && (plan.cuts as unknown[]).length === 2, JSON.stringify(plan));
  // Part numbers off, so the thirds are exact; the Form 4 block below cuts them.
  const op = { ...(plan.op as Record<string, unknown>), labels: { on: false } };
  const probe = await call("model_probe", { object: bar, op });
  const parts = (probe.pieces ?? []) as { volumeMm3: number; min: number[]; max: number[] }[];
  const sum = parts.reduce((total, part) => total + part.volumeMm3, 0);
  check(
    "the kernel's probe cuts three thirds in order, summing to the bar",
    probe.ok === true && parts.length === 3 && parts.every((part) => near(part.volumeMm3, 200_000 / 3, 0.05)) && near(sum, 200_000, 0.05) && near(parts[0]!.min[0], -250, 0.01) && near(parts[1]!.min[0], -250 + 500 / 3, 0.01) && near(parts[2]!.max[0], 250, 0.01),
    JSON.stringify(probe),
  );
  const applied = await call("model_apply", { object: bar, op });
  const pieces = (applied.pieces ?? []) as string[];
  const committed = await call("model_commit", { object: bar });
  const listed = ((await call("plate_list", { limit: 100 })).objects as { object: string }[]).map((row) => row.object);
  check("apply and commit leave the bar and two new plate objects", applied.ok === true && committed.ok === true && pieces.length === 2 && [bar, ...pieces].every((id) => listed.includes(id)), JSON.stringify({ applied, committed }));
  const thirds = await Promise.all([bar, ...pieces].map(volume));
  check("each is a third of the bar", thirds.every((v) => near(v, 200_000 / 3, 0.05)), JSON.stringify(thirds));
  const rows = (await call("model_history", { object: bar })).nodes as { label: string }[];
  check("the history row says the parts", rows[1]?.label === "Split to print, 3 parts", JSON.stringify(rows));
  const one = { kind: "partition", cuts: [{ origin: [100, 0, 10], normal: [1, 0, 0] }], labels: { on: false } };
  await call("model_probe", { object: bar, op: one, node: "node_0" });
  const edited = await call("model_edit", { object: bar, node: "node_1", op: one });
  const after = ((await call("plate_list", { limit: 100 })).objects as { object: string }[]).map((row) => row.object);
  check("an edit cuts every piece again: two parts, the third leaves the plate", edited.ok === true && edited.parts === 2 && JSON.stringify(edited.pieces) === JSON.stringify([pieces[0]]) && !after.includes(pieces[1]!), JSON.stringify(edited));
  const halves = await Promise.all([bar, pieces[0]!].map(volume));
  check("the bar keeps X -250 to 100 and piece 2 the rest", near(halves[0]!, 140_000, 0.05) && near(halves[1]!, 60_000, 0.05), JSON.stringify(halves));
}

// --- Split to print, milestone 3b: a 400 mm tall part for the Formlabs Form 4, numbered on its cut faces, kept off the
// plate, and exported as one STEP of three solids, one 3MF, and an STL each, against real Open CASCADE.
{
  const tall = String((await call("solid_new", { primitive: "box", dx: 100, dy: 80, dz: 400 })).object);
  const plan = await call("model_probe", { object: tall, op: { kind: "partition", target: { printer: "formlabs-form-4" } }, plan: true });
  check("the Form 4 plan cuts a 400 mm part in three", plan.ok === true && plan.pieces === 3, JSON.stringify(plan));
  const op = plan.op as Record<string, unknown>;
  const probe = await call("model_probe", { object: tall, op });
  const faces = ((probe.numbers ?? []) as { faces: { face: string; cut?: number }[] }[]).map((row) => row.faces.map((face) => `${face.face}${face.cut ?? ""}`).join(" "));
  check("each number is on its piece's cut faces: both mates of each cut", probe.ok === true && JSON.stringify(faces) === JSON.stringify(["cut1", "cut1 cut2", "cut2"]) && probe.notes === undefined, JSON.stringify(probe));
  const slab = (100 * 80 * 400) / 3;
  const lost = ((probe.pieces ?? []) as { volumeMm3: number }[]).map((piece) => slab - piece.volumeMm3);
  // Each "1", "2" or "3" at 4 mm is under 6 mm² of strokes cut 0.4 mm deep, so a face loses between 0.5 and 2.5 mm³; the
  // planner's cut heights are rounded to 1e-4 mm, worth 0.8 mm³ on a 100 × 80 mm section either way.
  check("each piece loses its numbers' volume and no more", lost.length === 3 && near(lost[0]!, 1.5, 1.8) && near(lost[1]!, 3, 3) && near(lost[2]!, 1.5, 1.8), JSON.stringify(lost));
  const applied = await call("model_apply", { object: tall, op });
  const pieces = (applied.pieces ?? []) as string[];
  const listed = ((await call("plate_list", { limit: 100 })).objects as { object: string }[]).map((row) => row.object);
  check("the pieces stay off the plate", applied.ok === true && pieces.length === 2 && !pieces.some((id) => listed.includes(id)), JSON.stringify(applied));
  const stepFile = await call("model_export_step", { object: tall, name: "tall-form4", pieces: true });
  const threeMf = await call("export_3mf", { object: tall, name: "tall-form4", pieces: true });
  const stls = await call("export_3mf", { object: tall, name: "tall-form4", pieces: true, stl: true });
  check("the STEP holds three solids", stepFile.ok === true && stepFile.solids === 3, JSON.stringify(stepFile));
  check("the 3MF and the STLs are written", threeMf.ok === true && (stls.files as unknown[] | undefined)?.length === 3, JSON.stringify({ threeMf, stls }));
  const products = [...readFileSync(String(stepFile.path)).toString("latin1").matchAll(/PRODUCT\('([^']*)'/g)].map((found) => found[1]);
  check("the STEP names its solids <source>-<n> in assembly order", JSON.stringify(products) === JSON.stringify(["tall-form4-1", "tall-form4-2", "tall-form4-3"]), JSON.stringify(products));
  const back = await call("mesh_import", { path: String(stepFile.path) });
  const total = Number((await call("model_describe", { object: String(back.object), limit: 1 })).volumeMm3);
  const sum = ((stepFile.pieces ?? []) as { volumeMm3: number }[]).reduce((acc, piece) => acc + piece.volumeMm3, 0);
  check("the STEP reads back with the pieces' volume", back.ok === true && near(total, sum, 0.05), JSON.stringify({ total, sum, path: stepFile.path, bytes: stepFile.bytes, threeMf: threeMf.bytes }));
}

// --- Split to print, milestone 5: dowels on the 500 mm bar for the Lime 220, the pins standing on the plate, and the
// same bar for the Form 4 exported with its pins, against real Open CASCADE.
{
  const bar = String((await call("solid_new", { primitive: "box", dx: 500, dy: 20, dz: 20 })).object);
  const volume = async (object: string) => Number((await call("model_describe", { object, limit: 1 })).volumeMm3);
  const plan = await call("model_probe", { object: bar, op: { kind: "partition" }, plan: true });
  const cuts = (plan.cuts as Record<string, unknown>[]).map((cut) => ({ ...cut, connectors: { on: true } }));
  const op = { ...(plan.op as Record<string, unknown>), cuts, labels: { on: false } };
  const planned = await call("model_probe", { object: bar, op, plan: true });
  const placed = ((planned.connectors as { placed?: { id: string }[] } | undefined)?.placed ?? []).map((row) => row.id);
  check("plan: true places one dowel on each 20 mm section", planned.ok === true && JSON.stringify(placed) === JSON.stringify(["c1-1", "c2-1"]), JSON.stringify(planned));
  // Default dowel on PLA at 0.4 mm: radius 3, 4 mm long, 0.15 mm a side, 0.4 mm end gap; each hole 2.4 mm deep, a teardrop.
  const hole = 3.15;
  const side = (0.75 * Math.PI + 1) * hole * hole * 2.4;
  const pin = Math.PI * 9 * 4 - 2 * Math.PI * 0.25 * (3 - 0.5 / 3);
  const probe = await call("model_probe", { object: bar, op });
  const parts = ((probe.pieces ?? []) as { volumeMm3: number }[]).map((part) => part.volumeMm3);
  const third = 200_000 / 3;
  check("the probe takes a teardrop hole from each mate", probe.ok === true && parts.length === 3 && near(parts[0]!, third - side, 0.05) && near(parts[1]!, third - 2 * side, 0.05) && near(parts[2]!, third - side, 0.05), JSON.stringify(parts));
  check("and measures the two pins", (probe.pins as { count?: number; volumeMm3?: number } | undefined)?.count === 2 && near((probe.pins as { volumeMm3: number }).volumeMm3, 2 * pin, 1e-3), JSON.stringify(probe.pins));
  const built = ((probe.connectors as { placed?: { teardrop: boolean }[] } | undefined)?.placed ?? []).map((row) => row.teardrop);
  check("each hole across the layers is a teardrop on FDM", JSON.stringify(built) === JSON.stringify([true, true]), JSON.stringify(probe.connectors));
  const applied = await call("model_apply", { object: bar, op });
  const pins = String(applied.pins);
  check("apply makes two pieces and the pins", applied.ok === true && (applied.pieces as unknown[]).length === 2 && pins.startsWith("obj_"), JSON.stringify(applied));
  const rows = (await call("model_history", { object: bar })).nodes as { label: string }[];
  check("the row says dowels", rows.at(-1)?.label === "Split to print, 3 parts, dowels", JSON.stringify(rows));
  const committed = await call("model_commit", { object: bar });
  const listed = (await call("plate_list", { limit: 100 })).objects as { object: string; bboxMm: { min: number[]; max: number[] } }[];
  const standing = listed.find((row) => row.object === pins);
  const size = standing ? standing.bboxMm.max.map((value, i) => value - standing.bboxMm.min[i]!) : [];
  check("the pins are on the plate, standing upright: 4 mm tall, 6 mm across each", committed.ok === true && !!standing && near(size[2]!, 4, 1e-3) && Math.min(size[0]!, size[1]!) > 6 - 1e-3 - 0.1 && Math.min(size[0]!, size[1]!) < 6 + 0.1, JSON.stringify({ committed, size }));
  const volumes = await Promise.all([bar, ...(applied.pieces as string[]), pins].map(volume));
  check("the pins' object holds both pins", near(volumes[3]!, 2 * pin, 1e-3), JSON.stringify(volumes));
  console.log(`occt: dowelled bar for the Lime 220, pieces ${volumes.slice(0, 3).map((v) => v.toFixed(3)).join(", ")} mm³, pins ${volumes[3]!.toFixed(3)} mm³`);

  // The same bar for the Form 4: the pins export as one more named solid, <name>-pins, after the pieces.
  const resin = String((await call("solid_new", { primitive: "box", dx: 500, dy: 20, dz: 20 })).object);
  const resinPlan = await call("model_probe", { object: resin, op: { kind: "partition", target: { printer: "formlabs-form-4" } }, plan: true });
  const resinOp = { ...(resinPlan.op as Record<string, unknown>), cuts: (resinPlan.cuts as Record<string, unknown>[]).map((cut) => ({ ...cut, connectors: { on: true } })) };
  await call("model_probe", { object: resin, op: resinOp });
  const resinApplied = await call("model_apply", { object: resin, op: resinOp });
  const step = await call("model_export_step", { object: resin, name: "bar-form4", pieces: true });
  const products = [...readFileSync(String(step.path)).toString("latin1").matchAll(/PRODUCT\('([^']*)'/g)].map((found) => found[1]);
  const pieceCount = Number(resinApplied.parts);
  const expected = [...Array.from({ length: pieceCount }, (_, at) => `bar-form4-${at + 1}`), "bar-form4-pins"];
  check("the Form 4's named STEP holds every piece and the pins, last", resinApplied.ok === true && typeof resinApplied.pins === "string" && step.ok === true && JSON.stringify(products) === JSON.stringify(expected), JSON.stringify({ products, step }));
  const resinRound = ((resinApplied.connectors as { placed?: { teardrop: boolean }[] } | undefined)?.placed ?? []).every((row) => row.teardrop === false);
  check("a resin hole stays round", resinRound, JSON.stringify(resinApplied.connectors));
  console.log(`occt: the bar for the Form 4, STEP products ${products.join(", ")}`);
}

// --- Split to print, milestone 6: the fit coupon through solid_new, against real Open CASCADE. The plate and its pin are
// two objects; each hole's radius is the pin's plus its labelled gap, read back from the solid's cylinder faces, and the
// volumes are checked by hand. For the Form 4 they are STEP files in the workspace.
{
  const made = await call("solid_new", { name: "Fit PETG", coupon: { material: "PETG" } });
  const objects = (made.objects ?? []) as string[];
  const holes = (made.holes ?? []) as { label: string; clearanceMm: number; radiusMm: number; teardrop: boolean }[];
  check("a coupon adds the plate and one pin as two objects", made.ok === true && objects.length === 2 && holes.length === 7, JSON.stringify(made).slice(0, 400));
  check("the labels are PETG's Snug 0.20 less 0.10 to plus 0.20", JSON.stringify(holes.map((hole) => hole.label)) === JSON.stringify(["0.10", "0.15", "0.20", "0.25", "0.30", "0.35", "0.40"]), JSON.stringify(holes.map((hole) => hole.label)));
  const plate = await call("model_describe", { object: objects[0]!, limit: 1 });
  const round = await call("faces_find", { object: objects[0]!, kind: "cylinder", limit: 100 });
  const radii = ((round.faces ?? []) as { radiusMm?: number }[]).map((face) => face.radiusMm!).sort((a, b) => a - b);
  // STEP carries the radius as a decimal; read back it is the layout's to 1e-9 mm.
  check("each hole is one cylinder of the pin's radius plus its gap, to 1e-9 mm", radii.length === 7 && radii.every((radius, at) => Math.abs(radius - (3 + holes[at]!.clearanceMm)) < 1e-9), JSON.stringify(radii));
  const size = (made.sizeMm ?? []) as number[];
  const bored = holes.reduce((sum, hole) => sum + (0.75 * Math.PI + 1) * hole.radiusMm * hole.radiusMm * 2.4, 0);
  const expectedPlate = size[0]! * size[1]! * size[2]! - bored - Number(made.engravedMm3);
  check("the plate's volume is the box less seven teardrop holes less the labels", near(plate.volumeMm3, expectedPlate, 1e-3) && Number(made.engravedMm3) > 0, JSON.stringify({ volume: plate.volumeMm3, expectedPlate, engraved: made.engravedMm3 }));
  const pin = await call("model_describe", { object: objects[1]!, limit: 1 });
  const pinVolume = Math.PI * 9 * 4 - 2 * Math.PI * 0.25 * (3 - 0.5 / 3);
  const pinRadii = (((await call("faces_find", { object: objects[1]!, kind: "cylinder", limit: 100 })).faces ?? []) as { radiusMm?: number }[]).map((face) => face.radiusMm);
  check("the pin is a chamfered 3 mm radius, 4 mm long", near(pin.volumeMm3, pinVolume, 1e-3) && pinRadii.length === 1 && Math.abs(pinRadii[0]! - 3) < 1e-9, JSON.stringify({ volume: pin.volumeMm3, pinVolume, pinRadii }));
  const onPlate = ((await call("plate_list", { limit: 100 })).objects as { object: string; name: string }[]).filter((row) => objects.includes(row.object));
  check("both are on the plate under the given name", onPlate.length === 2 && onPlate[0]!.name === "Fit PETG", JSON.stringify(onPlate));

  const resin = await call("solid_new", { coupon: { printer: "formlabs-form-4" } });
  const files = (resin.files ?? []) as string[];
  const stepText = files.map((file) => readFileSync(file).toString("latin1"));
  check("for the Form 4 the plate and the pin are STEP files, off the plate", resin.ok === true && files.length === 2 && files.every((file) => file.endsWith(".step")) && resin.objects === undefined && stepText[0]!.includes("PRODUCT('Fit coupon resin'") && stepText[1]!.includes("PRODUCT('Fit coupon resin-pins'"), JSON.stringify(resin).slice(0, 400));
  check("with the support note and round holes", String(resin.note).includes("supports") && (resin.holes as { teardrop: boolean }[]).every((hole) => !hole.teardrop) && (resin.holes as { label: string }[])[0]!.label === "0.00", JSON.stringify(resin.holes));
  const back = await call("mesh_import", { path: files[0]! });
  const backVolume = Number((await call("model_describe", { object: String(back.object), limit: 1 })).volumeMm3);
  const resinBored = (resin.holes as { radiusMm: number }[]).reduce((sum, hole) => sum + Math.PI * hole.radiusMm * hole.radiusMm * 2.4, 0);
  const resinSize = resin.sizeMm as number[];
  check("and the plate reads back with its volume", near(backVolume, resinSize[0]! * resinSize[1]! * resinSize[2]! - resinBored - Number(resin.engravedMm3), 1e-3), JSON.stringify({ backVolume, resinSize, resinBored }));
  console.log(`occt: fit coupon PETG plate ${Number(plate.volumeMm3).toFixed(3)} mm³ (${size.join(" x ")}), pin ${Number(pin.volumeMm3).toFixed(3)} mm³; resin plate ${backVolume.toFixed(3)} mm³`);
}

// --- Split to print, milestone 7: Joint down on the real kernel. The 500 mm bar for the Lime 220 with parts 2 and 3 set to
// joint: after commit each turned piece's cut face is its lowest plane with its normal along −Z, to 1e-9, the pieces do not
// overlap, an edit that sets part 3 back to keep turns it back, and model_undo takes the part's own orientation back too.
{
  const bar = String((await call("solid_new", { primitive: "box", dx: 500, dy: 20, dz: 20 })).object);
  const plan = await call("model_probe", { object: bar, op: { kind: "partition" }, plan: true });
  const op = { ...(plan.op as Record<string, unknown>), orient: ["keep", "joint", "joint"], labels: { on: false } };
  await call("model_probe", { object: bar, op });
  const applied = await call("model_apply", { object: bar, op });
  const pieces = (applied.pieces ?? []) as string[];
  check("apply reports the joint it chose for each turned piece", applied.ok === true && pieces.length === 2 && JSON.stringify(applied.notes) === JSON.stringify(["Part 2 is joint down on cut 1, its larger cut face, 400 mm².", "Part 3 is joint down on cut 2, its only cut face, 400 mm²."]), JSON.stringify(applied));
  check("and stores orient per piece", JSON.stringify((applied.stored as { orient?: unknown }).orient) === JSON.stringify(["keep", "joint", "joint"]), JSON.stringify(applied.stored));
  const committed = await call("model_commit", { object: bar });
  const listed = (await call("plate_list", { limit: 100 })).objects as { object: string; bboxMm: { min: number[]; max: number[] } }[];
  const mine = listed.filter((row) => [bar, ...pieces].includes(row.object));
  const saved = await call("project_save", { name: "joint-down.lime" });
  const doc = JSON.parse(readFileSync(String(saved.path), "utf8")) as { objects: { placement: { orient: number[] } }[] };
  const orientOf = (object: string) => doc.objects[listed.findIndex((row) => row.object === object)]!.placement.orient;
  const turn = (m: number[], v: number[]) => [0, 1, 2].map((r) => m[3 * r]! * v[0]! + m[3 * r + 1]! * v[1]! + m[3 * r + 2]! * v[2]!);
  check("the part itself keeps its orientation", JSON.stringify(orientOf(bar)) === JSON.stringify([1, 0, 0, 0, 1, 0, 0, 0, 1]), JSON.stringify(orientOf(bar)));
  const cutX = (plan.cuts as { origin: number[] }[]).map((cut) => cut.origin[0]!);
  for (const [at, piece] of pieces.entries()) {
    const m = orientOf(piece);
    const faces = ((await call("faces_find", { object: piece, kind: "plane", normal: [1, 0, 0], withinDeg: 1, limit: 20 })).faces ?? []) as { normal: number[]; centre: number[]; areaMm2: number }[];
    const mirrored = ((await call("faces_find", { object: piece, kind: "plane", normal: [-1, 0, 0], withinDeg: 1, limit: 20 })).faces ?? []) as { normal: number[]; centre: number[]; areaMm2: number }[];
    // The cut face is the one at the cut's X; the piece's other end is the face at its far end.
    const x = cutX[at]!;
    const cut = [...faces, ...mirrored].find((face) => Math.abs(face.centre[0]! - x) < 1e-3)!;
    const far = [...faces, ...mirrored].find((face) => Math.abs(face.centre[0]! - x) > 100)!;
    const down = turn(m, cut.normal);
    check(`part ${at + 2}: the cut face's normal is −Z to 1e-9`, Math.abs(down[0]!) < 1e-9 && Math.abs(down[1]!) < 1e-9 && Math.abs(down[2]! + 1) < 1e-9, JSON.stringify({ down, m }));
    const gap = turn(m, far.centre)[2]! - turn(m, cut.centre)[2]!;
    const length = Math.abs(far.centre[0]! - cut.centre[0]!);
    check(`part ${at + 2}: the cut face is the lowest plane, the far end ${length.toFixed(2)} mm above it`, Math.abs(gap - length) < 1e-6 && Math.abs(length - 500 / 3) < 1e-3, String(gap));
    const row = mine.find((one) => one.object === piece)!;
    check(`part ${at + 2}: it stands on the bed, z from 0 to 166.67`, Math.abs(row.bboxMm.min[2]!) < 1e-4 && Math.abs(row.bboxMm.max[2]! - length) < 1e-3 && Math.abs(row.bboxMm.max[0]! - row.bboxMm.min[0]! - 20) < 1e-3 && Math.abs(row.bboxMm.max[1]! - row.bboxMm.min[1]! - 20) < 1e-3, JSON.stringify(row.bboxMm));
  }
  const apart = mine.every((a, i) => mine.every((b, j) => i >= j || a.bboxMm.max[0]! <= b.bboxMm.min[0]! + 1e-6 || b.bboxMm.max[0]! <= a.bboxMm.min[0]! + 1e-6 || a.bboxMm.max[1]! <= b.bboxMm.min[1]! + 1e-6 || b.bboxMm.max[1]! <= a.bboxMm.min[1]! + 1e-6));
  check("no two pieces overlap on the bed", committed.ok === true && mine.length === 3 && apart, JSON.stringify(mine.map((row) => row.bboxMm)));
  console.log(`occt: joint down, bboxes ${mine.map((row) => `${row.bboxMm.max.map((v, i) => (v - row.bboxMm.min[i]!).toFixed(2)).join("x")}`).join(", ")}`);

  // An edit that sets part 3 back to keep turns it back; part 2 stays turned.
  const keepThree = { ...op, orient: ["keep", "joint", "keep"] };
  const editNode = ((await call("model_history", { object: bar })).nodes as { id: string; label: string }[]).find((row) => row.label.startsWith("Split to print"))!.id;
  await call("model_probe", { object: bar, node: "node_0", op: keepThree });
  const edited = await call("model_edit", { object: bar, node: editNode, op: keepThree });
  const afterEdit = JSON.parse(readFileSync(String((await call("project_save", { name: "joint-down-2.lime" })).path), "utf8")) as { objects: { placement: { orient: number[] } }[] };
  const orients = (await call("plate_list", { limit: 100 })).objects as { object: string }[];
  const at3 = afterEdit.objects[orients.findIndex((row) => row.object === pieces[1])]!.placement.orient;
  const at2 = afterEdit.objects[orients.findIndex((row) => row.object === pieces[0])]!.placement.orient;
  check("an edit to keep turns part 3 back and leaves part 2 turned", edited.ok === true && JSON.stringify(at3) === JSON.stringify([1, 0, 0, 0, 1, 0, 0, 0, 1]) && Math.abs(at2[6]!) > 0.999, JSON.stringify({ at2, at3, edited }));
  // Undo takes the cut, and with it the orientation, away.
  await call("model_undo", { object: bar });
  const left = ((await call("plate_list", { limit: 100 })).objects as { object: string }[]).filter((row) => [bar, ...pieces].includes(row.object));
  check("model_undo takes the pieces off the plate", left.length === 1 && left[0]!.object === bar, JSON.stringify(left));
}

// --- Split to print, milestone 8: a lap and a tongue on the real kernel, with Joint down on the shaped cut. The 500 mm bar
// is centred on X and Y with its base on Z = 0, so a cut at x = 0 has U along Y, V along Z, and a 20 mm section.
{
  const volumeOf = async (object: string) => Number((await call("model_describe", { object, limit: 1 })).volumeMm3);
  const cutOp = (profile: Record<string, unknown>, orient: unknown = "keep") => ({ kind: "partition", cuts: [{ origin: [0, 0, 10], normal: [1, 0, 0], profile }], orient, labels: { on: false } });
  const whole = 500 * 20 * 20;
  // A lap 8 mm deep with its step half way up the section (height 10 of 20 mm): the positive piece carries it.
  const lapBar = String((await call("solid_new", { primitive: "box", dx: 500, dy: 20, dz: 20 })).object);
  const lapOp = cutOp({ kind: "lap", depth: 8, height: 10 }, ["keep", "joint"]);
  const probed = await call("model_probe", { object: lapBar, op: lapOp });
  const volumes = ((probed.pieces ?? []) as { volumeMm3: number }[]).map((piece) => piece.volumeMm3);
  const step = 8 * 20 * 10;
  check("a lap's probe: the pieces are half the bar, one carrying the step, and they sum to the bar", probed.ok === true && volumes.length === 2 && near(volumes[0]!, whole / 2 + step, 1e-3) && near(volumes[1]!, whole / 2 - step, 1e-3) && near(volumes[0]! + volumes[1]!, whole, 1e-3), JSON.stringify(probed).slice(0, 300));
  const applied = await call("model_apply", { object: lapBar, op: lapOp });
  const stored = (applied.stored as { cuts: { profile: Record<string, unknown> }[] }).cuts[0]!.profile;
  check("apply stores the lap with its step resolved on the section: 10 mm up from the low side, at 0 from the cut's origin", applied.ok === true && stored.kind === "lap" && stored.height === 10 && stored.at === 0 && stored.depth === 8, JSON.stringify(stored));
  check("and says which flat is down", JSON.stringify(applied.notes) === JSON.stringify(["Part 2 is joint down on cut 1, its larger cut face, 200 mm²."]), JSON.stringify(applied.notes));
  const lapPieces = (applied.pieces ?? []) as string[];
  const first = await volumeOf(lapBar);
  const second = await volumeOf(lapPieces[0]!);
  check("the part and its piece are the two halves by volume", near(first, whole / 2 + step, 1e-3) && near(second, whole / 2 - step, 1e-3), JSON.stringify({ first, second }));
  await call("model_commit", { object: lapBar });
  const listed = (await call("plate_list", { limit: 100 })).objects as { object: string; bboxMm: { min: number[]; max: number[] } }[];
  const lapSaved = JSON.parse(readFileSync(String((await call("project_save", { name: "lap.lime" })).path), "utf8")) as { objects: { placement: { orient: number[] } }[] };
  const m = lapSaved.objects[listed.findIndex((row) => row.object === lapPieces[0])]!.placement.orient;
  const faces = ((await call("faces_find", { object: lapPieces[0]!, kind: "plane", normal: [-1, 0, 0], withinDeg: 1, limit: 20 })).faces ?? []) as { normal: number[]; centre: number[]; areaMm2: number }[];
  const flat = faces.find((face) => Math.abs(face.centre[0]!) < 1e-6)!;
  const down = [0, 1, 2].map((r) => m[3 * r]! * flat.normal[0]! + m[3 * r + 1]! * flat.normal[1]! + m[3 * r + 2]! * flat.normal[2]!);
  check("Joint down on the lap: the flat on the cut plane has its normal along −Z to 1e-9", !!flat && near(flat.areaMm2, 200, 1e-6) && Math.abs(down[0]!) < 1e-9 && Math.abs(down[1]!) < 1e-9 && Math.abs(down[2]! + 1) < 1e-9, JSON.stringify({ down, flat, m }));
  const piece = listed.find((row) => row.object === lapPieces[0])!;
  check("and the piece stands on the bed", Math.abs(piece.bboxMm.min[2]!) < 1e-4, JSON.stringify(piece.bboxMm));
  console.log(`occt: lap pieces ${volumes.map((v) => v.toFixed(3)).join(", ")} mm³`);

  // A tongue 6 mm wide and 3 mm deep: its groove is grown by the PLA clearance (0.15) and the 0.4 mm end gap.
  const tongueBar = String((await call("solid_new", { primitive: "box", dx: 500, dy: 30, dz: 20 })).object);
  const tongueOp = cutOp({ kind: "tongue", width: 6, depth: 3 });
  const tongueProbe = await call("model_probe", { object: tongueBar, op: tongueOp });
  const tv = ((tongueProbe.pieces ?? []) as { volumeMm3: number }[]).map((p) => p.volumeMm3);
  const base = 500 * 30 * 20;
  // The section is 30 × 20; margin 3.95, so the tongue is 30 − 7.9 = 22.1 mm long.
  const peg = 6 * 3 * 22.1;
  const groove = (6 + 0.3) * (3 + 0.4) * (22.1 + 0.3);
  check("a tongue's probe: one piece grows by the tongue, the other loses the grown groove", tongueProbe.ok === true && tv.length === 2 && near(tv[1]!, base / 2 + peg, 6e-3) && near(tv[0]!, base / 2 - groove, 6e-3), JSON.stringify({ tv, expected: [base / 2 - groove, base / 2 + peg], reason: tongueProbe.reason }));
  // --- Polish after 4.2.0: connectors beside a tongue and a dovetail. The flats beside the 6 mm tongue's 6.3 mm groove are
  // 6.85 mm across V, too narrow for the default 3 mm dowel: the refusal names the radius that fits.
  const withDowels = (op: { cuts: unknown[] }, radius?: number) => ({ ...op, cuts: [{ ...(op.cuts[0] as Record<string, unknown>), connectors: { on: true, types: [{ type: "dowel", ...(radius ? { radius } : {}) }] } }] });
  const refused = await call("model_probe", { object: tongueBar, op: withDowels(tongueOp) });
  check("a 3 mm dowel beside the tongue is refused with the widest circle and the radius that fits", refused.ok === false && refused.reason === "Cut 1: no dowel fits beside the tongue. The flats beside it hold a circle 6.8 mm across at most. A dowel of radius 2.47 mm or less fits.", JSON.stringify(refused));
  // A 2 mm dowel fits: one on each flat, its teardrop hole 2.15 mm and 2.4 mm deep taken from both pieces.
  const tongueDowels = await call("model_probe", { object: tongueBar, op: withDowels(tongueOp, 2) });
  const tonguePlaced = ((tongueDowels.connectors as { placed?: { id: string; at: number[]; teardrop: boolean }[]; dropped?: unknown[] } | undefined)?.placed ?? []);
  const smallSide = (0.75 * Math.PI + 1) * 2.15 * 2.15 * 2.4;
  const td = ((tongueDowels.pieces ?? []) as { volumeMm3: number }[]).map((p) => p.volumeMm3);
  check("2 mm dowels beside a tongue: one on each flat, on the cut plane, either side of the groove", tongueDowels.ok === true && tonguePlaced.length === 2 && tonguePlaced.every((row) => near(row.at[0]!, 0, 1e-6) && row.teardrop) && Math.abs(tonguePlaced[0]!.at[2]! - tonguePlaced[1]!.at[2]!) > 2 * 3.15, JSON.stringify(tongueDowels).slice(0, 500));
  check("and the pieces are the tongue's, each less a teardrop hole per dowel", td.length === 2 && near(td[1]!, base / 2 + peg - 2 * smallSide, 0.05) && near(td[0]!, base / 2 - groove - 2 * smallSide, 0.05), JSON.stringify({ td, expected: [base / 2 - groove - 2 * smallSide, base / 2 + peg - 2 * smallSide] }));
  const tongueApplyBar = String((await call("solid_new", { primitive: "box", dx: 500, dy: 30, dz: 20 })).object);
  const tongueApplied = await call("model_apply", { object: tongueApplyBar, op: withDowels(tongueOp, 2), probe: true });
  const tongueStored = (tongueApplied.stored as { cuts: { connectors: { placed: { flat?: { u: number; w: number; tilt: number } }[] } }[] } | undefined)?.cuts[0]!.connectors.placed ?? [];
  check("apply stores the two dowels on the cut plane's flats, and the pins are one more object", tongueApplied.ok === true && tongueStored.length === 2 && tongueStored.every((row) => row.flat?.w === 0 && row.flat?.tilt === 0) && typeof tongueApplied.pins === "string", JSON.stringify(tongueApplied).slice(0, 500));
  console.log(`occt: tongue with dowels ${td.map((v) => v.toFixed(3)).join(", ")} mm³`);
  // A dovetail 6 mm wide, 20°, 3 mm deep, sliding along U for the whole 30 mm: its groove is 3.31 mm from its middle at its widest.
  const tailBar = String((await call("solid_new", { primitive: "box", dx: 500, dy: 30, dz: 20 })).object);
  const tailOp = cutOp({ kind: "dovetail", width: 6, depth: 3, angle: 20 });
  const tailDowels = await call("model_probe", { object: tailBar, op: withDowels(tailOp, 2) });
  const tailPlaced = ((tailDowels.connectors as { placed?: { id: string; at: number[] }[] } | undefined)?.placed ?? []);
  const tl = Math.tan((20 * Math.PI) / 180);
  const tailRoot = 3 - 3 * tl;
  const tailPeg = 30 * ((2 * tailRoot + 6) / 2) * 3;
  const tailGroove = 30 * (2 * (tailRoot + 0.15 / Math.cos((20 * Math.PI) / 180)) * 3.4 + tl * 3.4 * 3.4);
  const tv2 = ((tailDowels.pieces ?? []) as { volumeMm3: number }[]).map((p) => p.volumeMm3);
  check("2 mm dowels beside a dovetail: one on each flat, on the cut plane", tailDowels.ok === true && tailPlaced.length === 2 && tailPlaced.every((row) => near(row.at[0]!, 0, 1e-6)), JSON.stringify(tailDowels).slice(0, 500));
  check("and the pieces are the dovetail's, each less a teardrop hole per dowel", tv2.length === 2 && near(tv2[1]!, base / 2 + tailPeg - 2 * smallSide, 0.05) && near(tv2[0]!, base / 2 - tailGroove - 2 * smallSide, 0.05), JSON.stringify({ tv2, expected: [base / 2 - tailGroove - 2 * smallSide, base / 2 + tailPeg - 2 * smallSide] }));
  console.log(`occt: dovetail with dowels ${tv2.map((v) => v.toFixed(3)).join(", ")} mm³`);
  // --- Milestone 11: dowels on the flats of a lap. The 20 mm section has room for one dowel on each flat: z = 5 on the plane
  // below the step, z = 15 on the plane 8 mm past it. Each hole is a teardrop (its axis is along X) taken from both pieces.
  const lapDowelOp = { ...lapOp, cuts: [{ ...(lapOp.cuts[0] as Record<string, unknown>), connectors: { on: true, types: [{ type: "dowel" }] } }] };
  const lapJointBar = String((await call("solid_new", { primitive: "box", dx: 500, dy: 20, dz: 20 })).object);
  const lapDowels = await call("model_probe", { object: lapJointBar, op: lapDowelOp });
  const lapPlaced = ((lapDowels.connectors as { placed?: { id: string; at: number[]; teardrop: boolean }[] } | undefined)?.placed ?? []);
  check("dowels on a lap: one on each flat, at x = 0 and x = 8, z = 5 and z = 15", lapDowels.ok === true && lapPlaced.length === 2 && lapPlaced[0]!.id === "c1-1" && near(lapPlaced[0]!.at[0]!, 0, 1e-6) && near(lapPlaced[0]!.at[2]!, 5, 1e-6) && lapPlaced[1]!.id === "c1-2" && near(lapPlaced[1]!.at[0]!, 8, 1e-6) && near(lapPlaced[1]!.at[2]!, 15, 1e-6), JSON.stringify(lapDowels).slice(0, 400));
  const lapSide = (0.75 * Math.PI + 1) * 3.15 * 3.15 * 2.4;
  const lapHoled = ((lapDowels.pieces ?? []) as { volumeMm3: number }[]).map((piece) => piece.volumeMm3);
  check("and each takes a teardrop hole at both flats from both pieces", lapHoled.length === 2 && near(lapHoled[0]! + lapHoled[1]!, whole - 4 * lapSide, 0.05), JSON.stringify({ lapHoled, expected: whole - 4 * lapSide }));
  const zigDowels = await call("model_probe", { object: tongueBar, op: { ...cutOp({ kind: "zigzag", pitch: 30, depth: 3, angle: 0 }), cuts: [{ origin: [0, 0, 10], normal: [1, 0, 0], profile: { kind: "zigzag", pitch: 30, depth: 3, angle: 0 }, connectors: { on: true, types: [{ type: "dowel" }] } }] } });
  const zigPlaced = ((zigDowels.connectors as { placed?: { id: string; at: number[] }[] } | undefined)?.placed ?? []);
  check("dowels on a zig-zag: they sit on both the low flat (x = 0) and the tooth tips (x = 3)", zigDowels.ok === true && zigPlaced.some((row) => near(row.at[0]!, 0, 1e-6)) && zigPlaced.some((row) => near(row.at[0]!, 3, 1e-6)), JSON.stringify(zigDowels).slice(0, 400));
  const tiltedDowels = await call("model_probe", { object: tongueBar, op: { kind: "partition", orient: "keep", labels: { on: false }, cuts: [{ origin: [0, 0, 10], normal: [1, 0, 0], profile: { kind: "sketch", start: [-40, 0], chain: [{ kind: "line", to: [40, 16] }] }, connectors: { on: true, types: [{ type: "dowel" }] } }] } });
  const tiltedPlaced = ((tiltedDowels.connectors as { placed?: { id: string; at: number[] }[] } | undefined)?.placed ?? []);
  check("dowels on a tilted segment of a sketch: each centre is on the line w = 0.2 (u + 40), square to it", tiltedDowels.ok === true && tiltedPlaced.length > 0 && tiltedPlaced.every((row) => near(row.at[0]!, 0.2 * (row.at[1]! + 40), 1e-6)), JSON.stringify(tiltedDowels).slice(0, 400));
  const thin = await call("model_probe", { object: tongueBar, op: cutOp({ kind: "tongue", width: 40, depth: 3 }) });
  check("a tongue wider than the section is refused with a sentence", thin.ok === false && String(thin.reason).includes("too small for a tongue"), JSON.stringify(thin));
  console.log(`occt: tongue pieces ${tv.map((v) => v.toFixed(3)).join(", ")} mm³`);

  // --- Milestone 9: a zig-zag, a dovetail profile, and the key and dovetail connectors, on the same 500 × 30 × 20 mm bar.
  const zig = await call("model_probe", { object: tongueBar, op: cutOp({ kind: "zigzag", pitch: 10, depth: 3, angle: 0 }) });
  const zv = ((zig.pieces ?? []) as { volumeMm3: number }[]).map((p) => p.volumeMm3);
  const teeth = 3 * 5 * 3 * 20;
  check("a zig-zag's probe: three teeth of 5 × 3 × 20 mm go to one piece, and the volumes sum to the bar", zig.ok === true && zv.length === 2 && near(zv[0]!, base / 2 + teeth, 6e-3) && near(zv[1]!, base / 2 - teeth, 6e-3), JSON.stringify({ zv, reason: zig.reason }));
  const lean = Math.tan((20 * Math.PI) / 180);
  const root = 4 - 3 * lean;
  const grow = 0.15 / Math.cos((20 * Math.PI) / 180);
  const peg2 = 30 * ((2 * root + 8) / 2) * 3;
  const groove2 = 30 * (2 * (root + grow) * 3.4 + lean * 3.4 * 3.4);
  const dove = await call("model_probe", { object: tongueBar, op: cutOp({ kind: "dovetail", width: 8, angle: 20, depth: 3 }) });
  const dv = ((dove.pieces ?? []) as { volumeMm3: number }[]).map((p) => p.volumeMm3);
  check("a dovetail profile's probe: the neck and wide end by hand, and its groove grown by the clearance", dove.ok === true && near(dv[1]!, base / 2 + peg2, 6e-3) && near(dv[0]!, base / 2 - groove2, 6e-3), JSON.stringify({ dv, expected: [base / 2 - groove2, base / 2 + peg2], reason: dove.reason }));
  // --- Milestone 10: a sketched profile, applied and edited. U is Y and W is X on this cut, so the section spans U −15 to 15.
  const stepArc = { kind: "sketch", start: [-20, 0], chain: [{ kind: "line", to: [-5, 0] }, { kind: "line", to: [-5, 6] }, { kind: "arc", through: [0, 11], to: [5, 6] }, { kind: "line", to: [20, 6] }] };
  const sketchBar = String((await call("solid_new", { primitive: "box", dx: 500, dy: 30, dz: 20 })).object);
  const sketchOp = cutOp(stepArc, ["keep", "joint"]);
  const sketchProbe = await call("model_probe", { object: sketchBar, op: sketchOp });
  const sv = ((sketchProbe.pieces ?? []) as { volumeMm3: number }[]).map((p) => p.volumeMm3);
  // Below the chain: half the bar, the 20 × 6 mm step over U −5 to 15, and the half circle of radius 5, all 20 mm tall.
  const below = base / 2 + 20 * 6 * 20 + (Math.PI * 25 * 20) / 2;
  check("a sketch's probe: the step and the arc go to the first piece, and the volumes sum to the bar", sketchProbe.ok === true && sv.length === 2 && near(sv[0]!, below, 6e-3) && near(sv[1]!, base - below, 6e-3) && near(sv[0]! + sv[1]!, base, 6e-3), JSON.stringify({ sv, below, reason: sketchProbe.reason }));
  const sketchApplied = await call("model_apply", { object: sketchBar, op: sketchOp });
  const sketchStored = (sketchApplied.stored as { cuts: { profile: Record<string, unknown> }[] }).cuts[0]!.profile;
  check("apply stores the chain as sent", sketchApplied.ok === true && sketchStored.kind === "sketch" && JSON.stringify(sketchStored.start) === JSON.stringify(stepArc.start) && JSON.stringify(sketchStored.chain) === JSON.stringify(stepArc.chain), JSON.stringify(sketchStored));
  check("Joint down lays the plane of the longest straight segment on the bed", JSON.stringify(sketchApplied.notes) === JSON.stringify(["Part 2 is joint down on cut 1, its only cut face, 200 mm²."]), JSON.stringify(sketchApplied.notes));
  const sketchRows = (await call("model_history", { object: sketchBar })).nodes as { id: string; label: string }[];
  check("the row names the sketch", sketchRows[1]?.label === "Split to print, sketch, 2 parts", JSON.stringify(sketchRows));
  const level = { kind: "sketch", start: [-20, 3], chain: [{ kind: "line", to: [20, 3] }] };
  await call("model_probe", { object: sketchBar, node: "node_0", op: cutOp(level) });
  const sketchEdited = await call("model_edit", { object: sketchBar, node: sketchRows[1]!.id, op: cutOp(level) });
  const firstAfter = Number((await call("model_describe", { object: sketchBar, limit: 1 })).volumeMm3);
  check("an edit cuts along the new chain: 3 mm along the normal", sketchEdited.ok === true && near(firstAfter, base / 2 + 30 * 3 * 20, 6e-3), JSON.stringify({ firstAfter, reason: sketchEdited.reason }));
  const crossed = await call("model_probe", { object: sketchBar, node: "node_0", op: cutOp({ kind: "sketch", start: [-20, 0], chain: [{ kind: "line", to: [5, 0] }, { kind: "line", to: [5, 8] }, { kind: "line", to: [-5, 8] }, { kind: "line", to: [-5, -8] }, { kind: "line", to: [20, -8] }] }) });
  check("a chain that crosses itself is refused with the plan's sentence", crossed.ok === false && crossed.reason === "Cut 1: The profile crosses itself.", JSON.stringify(crossed));
  const keyOp = (type: string) => ({ kind: "partition", cuts: [{ origin: [0, 0, 10], normal: [1, 0, 0], connectors: { on: true, types: [{ type }] } }], labels: { on: false } });
  const keyed = await call("model_probe", { object: tongueBar, op: keyOp("key") });
  const placedKeys = ((keyed.connectors as { placed?: unknown[] } | undefined)?.placed ?? []).length;
  const kv = ((keyed.pieces ?? []) as { volumeMm3: number }[]).map((p) => p.volumeMm3);
  check("a key connector: each placed key adds 6 × 6 × 3 mm to one piece and takes its grown groove from the other", keyed.ok === true && placedKeys >= 1 && near(kv[1]!, base / 2 + placedKeys * 108, 6e-3) && near(kv[0]!, base / 2 - placedKeys * 6.3 * 6.3 * 3.4, 6e-3), JSON.stringify({ kv, placedKeys, reason: keyed.reason }));
  const doveJoint = await call("model_probe", { object: tongueBar, op: keyOp("dovetail") });
  const placedDove = ((doveJoint.connectors as { placed?: unknown[] } | undefined)?.placed ?? []).length;
  check("a dovetail connector is placed too, the same sentence for one left out", doveJoint.ok === true && placedDove >= 1, JSON.stringify({ placedDove, reason: doveJoint.reason }));
  console.log(`occt: zig-zag ${zv.map((v) => v.toFixed(3)).join(", ")}, dovetail ${dv.map((v) => v.toFixed(3)).join(", ")}, ${placedKeys} keys ${kv.map((v) => v.toFixed(3)).join(", ")} mm³`);
}

// The convex filter on a box (12 convex edges) and on a stepped part with one concave edge.
{
  const made = await call("solid_new", { primitive: "box", dx: 40, dy: 30, dz: 20 });
  const stepped = String(made.object);
  const count = async (convex?: boolean) => ((await call("edges_find", { object: stepped, ...(convex === undefined ? {} : { convex }), limit: 100 })).edges as unknown[] | undefined)?.length;
  check("a box has 12 edges, all convex", (await count()) === 12 && (await count(true)) === 12 && (await count(false)) === 0, JSON.stringify([await count(), await count(true), await count(false)]));
  const cut = { kind: "boolean", op: "cut", primitive: "box", origin: [0, -20, 5], dx: 30, dy: 40, dz: 20 };
  const probed = await call("model_probe", { object: stepped, op: cut });
  const applied = await call("model_apply", { object: stepped, op: cut });
  check("a step is cut from the box", probed.ok === true && applied.ok === true, JSON.stringify({ probed, applied }).slice(0, 300));
  check("a stepped part has one concave edge and the rest convex", (await count()) === 18 && (await count(true)) === 17 && (await count(false)) === 1, JSON.stringify([await count(), await count(true), await count(false)]));
}

// --- Print transitions (docs/plan-belt-transitions.md, step 2): the step 1 corner coupon, 20° past the limit, on the IR3
// V2. A 2 mm shell side view extruded 20 mm across the belt; the corner is where the 45° slope turns into the roof.
{
  await call("machine_select", { printerId: "ideaformer-ir3-v2", filamentId: "lime-petg" });
  const fall = Math.tan((20 * Math.PI) / 180);
  const yc = (22.828 + 30 - (20 + 2 / Math.cos(Math.atan(fall)) - 30 * fall)) / (1 + fall);
  const side = [[0, 0], [2, 0], [2, 20 - 28 * fall], [30, 20], [50, 0], [52.828, 0], [yc, 22.828 - (yc - 30)], [0, 20 + 2 / Math.cos(Math.atan(fall)) - 30 * fall]];
  const mid = 52.828 / 2;
  const built = await call("model_build", {
    name: "corner coupon",
    base: { primitive: "box", dx: 20, dy: 54.828, dz: 24 },
    ops: [{ kind: "extrude", op: "common", profile: side.map(([y, z]) => [y! - mid, z!]), depth: 20, origin: [-10, 0, 0], turn: [90, 0, 90] }],
  });
  const coupon = String(built.object);
  const edges = ((await call("edges_find", { object: coupon, direction: [1, 0, 0], limit: 100 })).edges ?? []) as { index: number; mid: number[] }[];
  const at = (y: number, z: number) => edges.find((edge) => Math.hypot(edge.mid[1]! - (y - mid), edge.mid[2]! - z) < 1e-3)?.index ?? -1;
  const corner = at(30, 20);
  const probed = await call("model_probe", { object: coupon, op: { kind: "transition", edges: [corner] } });
  const row = ((probed.transition ?? []) as Record<string, number | string>[])[0] ?? {};
  check(
    "the corner takes a 2 mm wedge at 45° to the layers, level on the belt",
    probed.ok === true && row.case === "corner" && row.path === "chamfer" && row.reachMm === 2 && row.angleToLayersDeg === 45 && row.angleToBeltDeg === 0 && row.farDeg === 25,
    JSON.stringify(probed).slice(0, 600),
  );
  check("the probe says it in words", /flatter face at 25° to the layers\. The wedge runs 2 mm along the flatter face, its face at 45° to the layers and 0° to the belt/.test(String(probed.reason)), String(probed.reason));
  // --- Step 5: auto-find lists that corner with its fix probed, and the inner wall's corner, whose wedge would run
  // along a wall exactly at the limit, with its refusal. The ready op holds the corner; nothing is applied.
  const plan = await call("model_probe", { object: coupon, op: { kind: "transition" }, plan: true });
  const found = (plan.rows ?? []) as { edges: number[]; case: string; lengthMm: number; refused?: string; volumeMm3?: number }[];
  const bend = found.find((one) => one.edges[0] === corner);
  const wall = found.find((one) => one.edges[0] === at(2, 20 - 28 * fall));
  check(
    "plan:true lists the bend as a corner whose 2 mm wedge builds, and the wall's corner with its refusal",
    plan.ok === true && bend?.case === "corner" && bend.lengthMm === 20 && !bend.refused && (bend.volumeMm3 ?? 0) > 0 && wall?.case === "corner" && /run along it/.test(String(wall.refused))
      && ((plan.op as { edges?: number[] } | undefined)?.edges ?? []).includes(corner) && !((plan.op as { edges?: number[] }).edges ?? []).includes(wall.edges[0]!),
    JSON.stringify(plan).slice(0, 900),
  );
  const before = Number((await call("model_describe", { object: coupon, limit: 1 })).volumeMm3);
  const applied = await call("model_apply", { object: coupon, op: { kind: "transition", edges: [corner] } });
  const after = Number((await call("model_describe", { object: coupon, limit: 1 })).volumeMm3);
  const drop = 2 * Math.sin((20 * Math.PI) / 180);
  check("it adds the wedge: a triangle 2 mm down the roof to the slope, 20 mm across", applied.ok === true && near(after - before, 0.5 * drop * (2 * Math.cos((20 * Math.PI) / 180) + drop) * 20, 1e-3), JSON.stringify({ before, after, reason: applied.reason }));
  const rows = (await call("model_history", { object: coupon })).nodes as { label: string }[];
  check("the history row names it", rows.some((one) => one.label === "Print transition (1 edge), 45°, 2 mm"), JSON.stringify(rows));
  const outer = await call("model_probe", { object: coupon, node: "node_1", op: { kind: "transition", edges: [at(yc, 22.828 - (yc - 30))] } });
  check("a convex edge is refused with the kernel's sentence", outer.ok === false && /This edge is convex/.test(String(outer.reason)), JSON.stringify(outer));
}

// --- Print transitions, step 4: the step 1 lip coupon on the IR3 V2. A post at Y 20–28 with a lip hanging 6 mm toward
// −Y, its underside in one layer; the lip's first edge runs across the belt at Y, Z = 20 − 6/√2.
{
  await call("machine_select", { printerId: "ideaformer-ir3-v2", filamentId: "lime-petg" });
  const r = 6 / Math.SQRT2;
  const side = [[20, 0], [28, 0], [28, 26], [20 - r, 26], [20 - r, 20 - r], [20, 20]];
  const mid = (20 - r + 28) / 2;
  const built = await call("model_build", {
    name: "lip coupon",
    base: { primitive: "box", dx: 20, dy: 28 - (20 - r) + 2, dz: 27 },
    ops: [{ kind: "extrude", op: "common", profile: side.map(([y, z]) => [y! - mid, z!]), depth: 20, origin: [-10, 0, 0], turn: [90, 0, 90] }],
  });
  const coupon = String(built.object);
  const edges = ((await call("edges_find", { object: coupon, direction: [1, 0, 0], limit: 100 })).edges ?? []) as { index: number; mid: number[] }[];
  const first = edges.find((edge) => Math.hypot(edge.mid[1]! - (20 - r - mid), edge.mid[2]! - (20 - r)) < 1e-3)?.index ?? -1;
  const probed = await call("model_probe", { object: coupon, op: { kind: "transition", edges: [first] } });
  const row = ((probed.transition ?? []) as Record<string, unknown>[])[0] ?? {};
  check(
    "the lip takes a gusset at 45° to the layers, level on the belt, 3 mm down the build, 180 mm³",
    probed.ok === true && row.case === "lip" && row.path === "gusset" && row.angleToLayersDeg === 45 && row.angleToBeltDeg === 0 && row.heightMm === 3 && near(Number(row.volumeMm3), 180, 1e-3) && !("soup" in row),
    JSON.stringify(probed).slice(0, 800),
  );
  check("the probe says the lip in words", /a lip 6 mm deep, its underside at 0° to the layers\. The gusset runs back into the part at 45° to the layers and 0° to the belt, 3 mm down the build/.test(String(probed.reason)), String(probed.reason));
  const ramp = await call("model_probe", { object: coupon, op: { kind: "transition", edges: [first], mode: "cut" } });
  const cut = ((ramp.transition ?? []) as Record<string, unknown>[])[0] ?? {};
  check("cut ramps the underside from the root, leaving 6 mm at the first edge over the 0.8 mm floor", ramp.ok === true && cut.material === "cut" && cut.leftMm === 6 && cut.floorMm === 0.8 && near(Number(cut.volumeMm3), 180, 1e-3), JSON.stringify(ramp).slice(0, 800));
  const thin = await call("model_probe", { object: coupon, op: { kind: "transition", edges: [first], mode: "cut", floorMm: 7 } });
  check("a ramp leaving under the floor is refused with the kernel's sentence", thin.ok === false && /under the 7 mm wall floor/.test(String(thin.reason)), JSON.stringify(thin));
  const before = Number((await call("model_describe", { object: coupon, limit: 1 })).volumeMm3);
  const applied = await call("model_apply", { object: coupon, op: { kind: "transition", edges: [first] } });
  const after = Number((await call("model_describe", { object: coupon, limit: 1 })).volumeMm3);
  check("the gusset is added", applied.ok === true && near(after - before, 180, 1e-3), JSON.stringify({ before, after, reason: applied.reason }));
  const rows = (await call("model_history", { object: coupon })).nodes as { label: string }[];
  check("the history row names the lip", rows.some((one) => one.label === "Print transition (1 lip), 45°"), JSON.stringify(rows));
}

// --- Split to print, profile shift (plan section 32): a thin-walled box 120 × 30.9 × 20 mm, walls 1.2 mm, open along X,
// cut across X at 0 with a 10 mm zig-zag. At shift 0 a flank lies 0.3 mm inside a wall; the planner flattens that tooth.
{
  const tube = String((await call("solid_new", { primitive: "box", dx: 120, dy: 30.9, dz: 20 })).object);
  const hollowed = await call("model_apply", { object: tube, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", origin: [-61, -14.25, 1.2], dx: 122, dy: 28.5, dz: 17.6 } });
  check("the box is hollowed along X", hollowed.ok === true, JSON.stringify(hollowed).slice(0, 400));
  const whole = 120 * 30.9 * 20 - 120 * 28.5 * 17.6;
  const zigOp = (shift?: number | "auto") => ({ kind: "partition", labels: { on: false }, cuts: [{ origin: [0, 0, 10], normal: [1, 0, 0], u: [0, 1, 0], profile: { kind: "zigzag", pitch: 10, depth: 3, angle: 0, ...(shift !== undefined ? { shift } : {}) } }] });
  const volumes = (reply: Record<string, unknown>) => ((reply.pieces ?? []) as { volumeMm3: number }[]).map((p) => p.volumeMm3);
  const plain = await call("model_probe", { object: tube, op: zigOp() });
  check("no shift is shift 0, and the tooth on the wall is flattened, in a sentence", plain.ok === true && (plain.notes as string[] | undefined)?.includes("Cut 1: 1 tooth was flattened onto the cut plane so no wall is under 0.8 mm.") === true && near(volumes(plain).reduce((a, b) => a + b, 0), whole, 1e-3), JSON.stringify(plain).slice(0, 600));
  const auto = await call("model_apply", { object: tube, op: zigOp("auto"), probe: true });
  const stored = (auto.stored as { cuts: { profile: Record<string, unknown> }[] } | undefined)?.cuts[0]!.profile ?? {};
  check("shift auto slides the teeth 9.6 mm, changes none, and the op stores it", auto.ok === true && stored.shiftAuto === true && stored.shift === 9.6 && near(stored.u0, -15.45 + 9.6, 1e-6) && !("chain" in stored) && !(auto.notes as string[] | undefined)?.some((note) => note.includes("flattened")), JSON.stringify(auto).slice(0, 600));
  const autoProbe = await call("model_probe", { object: tube, op: zigOp("auto"), node: "node_1" });
  check("and its pieces sum to the hollow box", autoProbe.ok === true && near(volumes(autoProbe).reduce((a, b) => a + b, 0), whole, 1e-3), JSON.stringify(volumes(autoProbe)));
  const typed = await call("model_probe", { object: tube, op: zigOp(12.5), node: "node_1" });
  const typedU0 = ((typed.stored as { cuts: { profile: { u0?: number } }[] } | undefined)?.cuts[0]?.profile.u0) ?? NaN;
  check("a typed shift is a phase: 12.5 mm on a 10 mm pitch starts the period 2.5 mm in", typed.ok === true && near(typedU0, -15.45 + 2.5, 1e-6), JSON.stringify(typed).slice(0, 400));
  console.log(`occt: profile shift on the thin-walled box, Auto ${volumes(autoProbe).map((v) => v.toFixed(3)).join(", ")} mm³`);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("occt: ok");
process.exit(0);
