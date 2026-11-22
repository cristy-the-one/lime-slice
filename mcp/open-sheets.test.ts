/**
 * Organic surfaces S4: MCP, codec, reply, and history parity for open surfaces ("Sheets")
 * and surface-to-solid ops (`sheet`, `sew`, `thicken`, `trimSplit`, `replaceFace`, `splitFace`).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";
import { readSavedTree } from "../src/model-tree-file.ts";
import { decodeSolid, encodeSolid } from "../src/model-reply.ts";
import { historyLayout } from "../src/model-history.ts";
import { newTree, withChild, type SheetOp } from "../src/model-tree.ts";

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

if (failed > 0) process.exit(1);
console.log("S4 open-sheets MCP, codec, reply, and history checks passed.");
