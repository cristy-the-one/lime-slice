/**
 * Organic surfaces S4: MCP, codec, reply, and history parity for open surfaces ("Sheets")
 * and surface-to-solid ops (`sheet`, `sew`, `thicken`, `trimSplit`, `replaceFace`, `splitFace`).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";
import { readSavedTree } from "../src/model-tree-file.ts";
import { decodeSolid, encodeSolid } from "../src/model-reply.ts";
import { historyLayout } from "../src/model-history.ts";
import { newTree, withChild, type SheetOp } from "../src/model-tree.ts";
import { assemblePlate } from "../src/plate.ts";
import { decodeProject, encodeProject } from "../src/project-codec.ts";
import { sheetPartNote } from "../src/model-sheet.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-s4-"));
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

const S4_KINDS = new Set(["sheet", "sew", "thicken", "trimSplit", "replaceFace", "splitFace"]);
const sentOps: Record<string, unknown>[] = [];
const baseEngine = fakeEngine();
const engine = {
  ...baseEngine,
  async modelTree(request: string): Promise<string> {
    const parsed = JSON.parse(request) as { call?: string; op?: Record<string, unknown> };
    if (parsed.call === "apply" && parsed.op) {
      sentOps.push(parsed.op);
      if (typeof parsed.op.kind === "string" && S4_KINDS.has(parsed.op.kind)) {
        const fake = JSON.parse(
          await baseEngine.modelTree(JSON.stringify({ ...parsed, op: { kind: "unify" } })),
        ) as Record<string, unknown>;
        return JSON.stringify({ ...fake, op: parsed.op });
      }
    }
    if (parsed.call === "probe" && typeof parsed.op?.kind === "string" && S4_KINDS.has(parsed.op.kind)) {
      return JSON.stringify({ ok: true, fits: true, volumeMm3: 1800, faces: 6, edges: 12, solids: 1 });
    }
    return baseEngine.modelTree(request);
  },
};

const archCurve = {
  kind: "nurbs" as const,
  poles: [[-15, -15, 10], [0, -15, 18], [15, -15, 10]],
  degree: 2,
};
const archSheetSpec = {
  mode: "extrude" as const,
  curves: [archCurve],
  dir: [0, 1, 0],
  distance: 30,
};

const opSheet = { kind: "sheet", ...archSheetSpec };
const opSew = { kind: "sew", tolerance: 0.01, capPlanar: true, makeSolid: true };
const opThicken = { kind: "thicken", thickness: 2.5, direction: "both", tolerance: 0.01 };
const opTrimSplit = { kind: "trimSplit", sheet: archSheetSpec, keep: "below" };
const opReplaceFace = { kind: "replaceFace", face: 0, sheet: archSheetSpec };
const opSplitFace = {
  kind: "splitFace",
  faces: [0],
  curve: { kind: "polyline", points: [[-10, 0, 20], [10, 0, 20]] },
  direction: [0, 0, -1],
};

// 1. Schema validation for all 6 S4 ops.
for (const [label, op] of [
  ["sheet", opSheet],
  ["sew", opSew],
  ["thicken", opThicken],
  ["trimSplit", opTrimSplit],
  ["replaceFace", opReplaceFace],
  ["splitFace", opSplitFace],
] as const) {
  const err = validateTool("model_apply", { op });
  check(`schema validates ${label}`, err === null, String(err));
}

// 2. Session.call forwards all 6 S4 ops intact through bakeOp to the kernel.
const session = new Session(engine);
const created = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 });
const object = created.object as string;

for (const [label, op] of [
  ["sheet", opSheet],
  ["sew", opSew],
  ["thicken", opThicken],
  ["trimSplit", opTrimSplit],
  ["replaceFace", opReplaceFace],
  ["splitFace", opSplitFace],
] as const) {
  const res = await session.call("model_apply", { object, op, probe: true });
  const sent = sentOps.at(-1);
  check(
    `model_apply forwards ${label} intact`,
    res.ok === true && sent?.kind === label,
    JSON.stringify({ res, sent }),
  );
}

// 3. .lime saved-tree codec round-trips rootFeature: sheet and all 6 S4 ops.
const saved = readSavedTree({
  rootFeature: opSheet,
  nodes: [
    { id: 0, parent: null, op: null, fingerprint: { volumeMm3: 0, faces: 1, edges: 4 } },
    { id: 1, parent: 0, op: opSew, fingerprint: null },
    { id: 2, parent: 1, op: opThicken, fingerprint: null },
    { id: 3, parent: 2, op: opTrimSplit, fingerprint: null },
    { id: 4, parent: 3, op: opReplaceFace, fingerprint: null },
    { id: 5, parent: 4, op: opSplitFace, fingerprint: null },
  ],
  current: 5,
  committed: 5,
  nextId: 6,
});
check(
  "saved-tree codec round-trips rootFeature sheet and all 6 S4 ops",
  saved !== null
    && saved.rootFeature?.kind === "sheet"
    && saved.nodes.length === 6
    && saved.nodes[1]?.op?.kind === "sew"
    && saved.nodes[2]?.op?.kind === "thicken"
    && saved.nodes[3]?.op?.kind === "trimSplit"
    && saved.nodes[4]?.op?.kind === "replaceFace"
    && saved.nodes[5]?.op?.kind === "splitFace",
  JSON.stringify(saved),
);

// 4. decodeSolid/encodeSolid preserve nakedEdges and editable: false for open sheets.
const wire = encodeSolid({
  volumeMm3: 0,
  solid: false,
  positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
  triangles: [0],
  faces: [{ areaMm2: 50, normal: [0, 0, 1] }],
  edges: [
    { lengthMm: 10, points: [0, 0, 0, 10, 0, 0] },
    { lengthMm: 14.14, points: [10, 0, 0, 0, 10, 0] },
    { lengthMm: 10, points: [0, 10, 0, 0, 0, 0] },
  ],
  nakedEdges: [0, 1, 2],
});
const decoded = decodeSolid(wire as unknown as Record<string, unknown>);
check(
  "decodeSolid decodes open sheet with editable: false and nakedEdges",
  typeof decoded !== "string" && decoded.editable === false && JSON.stringify(decoded.nakedEdges) === "[0,1,2]",
  typeof decoded === "string" ? decoded : JSON.stringify({ editable: decoded.editable, nakedEdges: decoded.nakedEdges }),
);

// 5. History layout marks open sheet nodes with sheet: true and solidified nodes without it.
const sheetRoot: SheetOp = {
  kind: "sheet",
  mode: "extrude",
  curves: [{ kind: "polyline", points: [[0, 0, 0], [10, 0, 0]] }],
  dir: [0, 1, 0],
  distance: 10,
};
let tree = newTree("sheet-test", { kind: "feature", op: sheetRoot }, "Sheet", { volumeMm3: 0, faces: 1, edges: 4 });
tree = withChild(tree, 0, {
  id: 1,
  op: { kind: "thicken", thickness: 2 },
  label: "Thicken 2 mm",
  fingerprint: { volumeMm3: 200, faces: 6, edges: 12 },
});
const layout = historyLayout(tree);
check(
  "historyLayout badges open sheet row and clears badge after thicken",
  layout.rows[0]?.sheet === true && layout.rows[1]?.sheet !== true,
  JSON.stringify(layout.rows.map((r) => ({ id: r.id, label: r.label, sheet: r.sheet }))),
);

// 6. An open sheet on the plate: committed and marked, Slice and the exports refuse it, thicken clears the mark.
{
  const plain = fakeEngine();
  let openSheet = false;
  const sheetEngine = {
    ...plain,
    async modelTree(request: string): Promise<string> {
      const parsed = JSON.parse(request) as { call?: string; op?: { kind?: string } };
      if (parsed.call === "apply" && parsed.op?.kind && S4_KINDS.has(parsed.op.kind)) {
        // The kernel answers a sheet as not a solid with open borders, and a thickened one as a solid with none.
        openSheet = parsed.op.kind === "sheet";
        const fake = JSON.parse(await plain.modelTree(JSON.stringify({ ...parsed, op: { kind: "unify" } }))) as Record<string, unknown>;
        return JSON.stringify(openSheet ? { ...fake, op: parsed.op, solid: false, nakedEdges: [0, 1, 2, 3] } : { ...fake, op: parsed.op });
      }
      if (parsed.call === "probe" && parsed.op?.kind && S4_KINDS.has(parsed.op.kind)) {
        return JSON.stringify({ ok: true, fits: true, volumeMm3: 1800, faces: 6, edges: 12, solids: 1 });
      }
      return plain.modelTree(request);
    },
  };
  const s = new Session(sheetEngine);
  const part = (await s.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 })).object as string;
  const before = await s.call("slice_start", { wait: true });
  check("a solid slices before it becomes a sheet", before.ok === true && before.status === "done", JSON.stringify(before).slice(0, 300));
  const sheeted = await s.call("model_apply", { object: part, op: opSheet, probe: true });
  const committed = await s.call("model_commit", { object: part });
  const list = await s.call("plate_list", {});
  const row = (list.objects as { object: string; sheet?: boolean }[] | undefined)?.find((one) => one.object === part);
  check("an open sheet commits to the plate and is marked in plate_list", sheeted.ok === true && committed.ok === true && row?.sheet === true, JSON.stringify({ sheeted, committed, row }).slice(0, 600));
  const info = await s.call("session_info", {});
  check("session_info names the open sheets", JSON.stringify(info.openSheets) === JSON.stringify([part]), JSON.stringify(info.openSheets));
  const nodeMark = () => {
    const tree = (s as unknown as { find(id: string): { tree?: { committed: number; nodes: Map<number, { sheet?: true }> } } | undefined }).find(part)?.tree;
    return tree?.nodes.get(tree.committed)?.sheet === true;
  };
  check("the mark rides on the committed history node too", nodeMark());
  const sliced = await s.call("slice_start", { wait: true });
  check(
    "slice_start refuses an open sheet with code open-sheet, naming it",
    sliced.ok === false && sliced.code === "open-sheet" && sliced.object === part
      && sliced.reason === `box (${part}) is an open sheet, not a solid, so it cannot be sliced. Thicken it ({kind:"thicken", thickness}) or sew it shut ({kind:"sew", capPlanar:true}) and commit, then try again.`,
    JSON.stringify(sliced),
  );
  const gcode = await s.call("gcode_export", { name: "sheet.gcode" });
  check("gcode_export refuses a slice of an object that is now an open sheet", gcode.ok === false && gcode.code === "open-sheet" && String(gcode.reason).includes("cannot be exported as G-code"), JSON.stringify(gcode));
  const threeMf = await s.call("export_3mf", { name: "sheet.3mf" });
  check("export_3mf refuses an open sheet", threeMf.ok === false && threeMf.code === "open-sheet" && String(threeMf.reason).includes("cannot be exported to 3MF"), JSON.stringify(threeMf));

  // One field on both sides: the MCP save writes the app's row mark (`sheet: true`, version 5), the app's reader opens
  // it marked, and a file shaped as the app writes it opens over MCP marked, so Slice refuses it.
  const savedName = "open-sheet-roundtrip.lime";
  const saved = await s.call("project_save", { name: savedName });
  const text = readFileSync(join(workspace, savedName), "utf8");
  const raw = JSON.parse(text) as { version?: number; objects?: { id?: string; sheet?: unknown }[] };
  check(
    "project_save writes the mark on the object row as the app does, in a version 5 file",
    saved.ok === true && raw.version === 5 && raw.objects?.find((one) => one.id === part)?.sheet === true,
    JSON.stringify({ saved: saved.ok, version: raw.version, rows: raw.objects?.map((one) => ({ id: one.id, sheet: one.sheet })) }),
  );
  const decoded = await decodeProject(text);
  const appPlate = decoded.ok && decoded.project.objects
    ? assemblePlate(decoded.project.objects.map((row) => ({ ...row, bytes: new ArrayBuffer(0), sourcePos: new Float32Array(0) })))
    : null;
  const appRow = appPlate?.objects.find((one) => one.id === part);
  check(
    "the app's reader (assemblePlate) opens the MCP-saved sheet marked, and its Slice gate stops on it",
    appRow?.sheet === true && sheetPartNote(appPlate!.objects) === `${appRow.name} is an open sheet, not a solid. Thicken or Cap & Sew it in Model before slicing or exporting.`,
    JSON.stringify({ ok: decoded.ok, sheet: appRow?.sheet }),
  );
  if (decoded.ok && decoded.project.objects) {
    // The app writes a plate object's mark on its row (src/app/project-io.ts `if (obj.sheet) row.sheet = true`). With no
    // history and no solid beside it, the mark is all that says it is a sheet, and alone it makes the file version 5.
    const appDoc = structuredClone(decoded.project);
    appDoc.objects = decoded.project.objects.map((row) => {
      const { modelTree: _tree, brep: _brep, meshSeatMm: _seat, sheet: _sheet, ...rest } = row;
      const appRowOut: typeof row = { ...rest };
      if (row.sheet) appRowOut.sheet = true;
      return appRowOut;
    });
    delete appDoc.mcpModel;
    const appText = await encodeProject(appDoc);
    check("a file whose only new thing is the sheet mark is written as version 5", (JSON.parse(appText) as { version?: number }).version === 5);
    writeFileSync(join(workspace, "app-sheet.lime"), appText);
    const fresh = new Session(fakeEngine());
    const opened = await fresh.call("project_open", { path: join(workspace, "app-sheet.lime") });
    const reopened = ((await fresh.call("plate_list", {})).objects as { object: string; sheet?: boolean }[]).find((one) => one.object === part);
    const refused = await fresh.call("slice_start", { wait: true });
    check(
      "an app-shaped file opens over MCP with the object marked, and slice_start refuses it with open-sheet",
      opened.ok === true && reopened?.sheet === true && refused.ok === false && refused.code === "open-sheet" && refused.object === part,
      JSON.stringify({ opened: opened.ok, reopened, refused: { ok: refused.ok, code: refused.code } }),
    );
  }
  // The app also stops an open sheet in the pose export's mesh formats and in Stress: so does MCP, with the same code.
  const setup = await s.call("sim_setup", { object: part, hMm: 2, representation: "smear", fixtures: [{ kind: "faces", faces: [4] }], loads: [{ kind: "force", faces: [5], magnitude: 20, direction: [0, 0, -1] }], card: "inhouse-petg" });
  check("sim_setup refuses an open sheet with open-sheet", setup.ok === false && setup.code === "open-sheet" && String(setup.reason).includes("cannot be set up for a stress study"), JSON.stringify(setup).slice(0, 300));
  const run = await s.call("sim_run", { object: part });
  check("sim_run refuses an open sheet with open-sheet", run.ok === false && run.code === "open-sheet" && String(run.reason).includes("cannot be solved for stress"), JSON.stringify(run).slice(0, 300));
  const base = (await s.call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 })).object as string;
  await s.call("model_place", { object: part, to: base, x: 30, assembly: "Lid" });
  const posed = await s.call("pose_export", { assembly: "Lid", format: "stl" });
  check("pose_export to STL refuses an assembly holding an open sheet", posed.ok === false && posed.code === "open-sheet" && posed.object === part && String(posed.reason).includes("cannot be exported as STL"), JSON.stringify(posed).slice(0, 300));
  await s.call("object_remove", { object: base });
  const copy = await s.call("object_duplicate", { object: part });
  const copyId = (copy.objects as string[] | undefined)?.[0];
  const listed = (await s.call("plate_list", {})).objects as { object: string; sheet?: boolean }[];
  check("a duplicate of an open sheet carries the mark", copy.ok === true && listed.find((one) => one.object === copyId)?.sheet === true, JSON.stringify({ copy, listed }).slice(0, 400));
  if (copyId) await s.call("object_remove", { object: copyId });
  const thick = await s.call("model_apply", { object: part, op: opThicken, probe: true });
  const recommitted = await s.call("model_commit", { object: part });
  const after = (await s.call("plate_list", {})).objects as { object: string; sheet?: boolean }[];
  const sliceAfter = await s.call("slice_start", { wait: true });
  check(
    "thicken clears the mark and the part slices again",
    thick.ok === true && recommitted.ok === true && after.find((one) => one.object === part)?.sheet === undefined && sliceAfter.ok === true && sliceAfter.status === "done",
    JSON.stringify({ thick: thick.ok, recommitted, sliceAfter: { ok: sliceAfter.ok, code: sliceAfter.code, reason: sliceAfter.reason } }).slice(0, 500),
  );
  check("session_info lists no open sheet once it is thickened", (await s.call("session_info", {})).openSheets === undefined);
  check("thicken clears the node's mark", !nodeMark());
}

// 7. The other half of a sheet's trimSplit (keep both) is a sheet too: marked from the kernel's verdict on that half,
// as the app marks a piece, so it commits as a sheet and Slice refuses it with open-sheet, not a commit failure.
{
  const plain = fakeEngine();
  const halfEngine = {
    ...plain,
    async modelTree(request: string): Promise<string> {
      const parsed = JSON.parse(request) as { call?: string; op?: { kind?: string } };
      if (parsed.call === "apply" && parsed.op?.kind && S4_KINDS.has(parsed.op.kind)) {
        const fake = JSON.parse(await plain.modelTree(JSON.stringify({ ...parsed, op: { kind: "unify" } }))) as Record<string, unknown>;
        const sheet = { ...fake, op: parsed.op, solid: false, nakedEdges: [0, 1, 2, 3] };
        return JSON.stringify(parsed.op.kind === "trimSplit" ? { ...sheet, other: { ...sheet } } : sheet);
      }
      if (parsed.call === "probe" && parsed.op?.kind && S4_KINDS.has(parsed.op.kind)) {
        return JSON.stringify({ ok: true, fits: true, volumeMm3: 1800, faces: 6, edges: 12, solids: 1 });
      }
      return plain.modelTree(request);
    },
  };
  const s = new Session(halfEngine);
  const part = (await s.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 })).object as string;
  await s.call("model_apply", { object: part, op: opSheet, probe: true });
  await s.call("model_commit", { object: part });
  const cut = await s.call("model_apply", { object: part, op: { kind: "trimSplit", sheet: archSheetSpec, keep: "both" }, probe: true });
  const listed = ((await s.call("plate_list", {})).objects as { object: string; sheet?: boolean }[]);
  const half = listed.find((one) => one.object !== part);
  check("a sheet's trimSplit keeps both halves, the other half marked a sheet", cut.ok === true && half?.sheet === true, JSON.stringify({ cut: cut.ok, reason: cut.reason, listed }).slice(0, 600));
  if (half) await s.call("object_select", { object: half.object });
  const sliced = half ? await s.call("slice_start", { scope: "object", wait: true }) : {};
  check("slice_start on the other half refuses it with open-sheet, not a commit failure", sliced.ok === false && sliced.code === "open-sheet" && sliced.object === half?.object, JSON.stringify(sliced).slice(0, 400));
}

if (failed > 0) process.exit(1);
console.log("S4 open-sheets MCP, codec, reply, and history checks passed.");
