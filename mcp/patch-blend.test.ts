/**
 * Organic surfaces S5: a G0 patch in the schema, the bake, and a .lime file.
 * An older tree that has no patch still loads.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine, ProtocolError } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";
import { readSavedTree } from "../src/model-tree-file.ts";
import { bakeOp } from "../src/modeling/bake.ts";
import { IDENTITY_POSE } from "../src/model-space.ts";
import { GLOBAL_WORKPLANE } from "../src/workplane.ts";
import { PATCH_NOT_YET } from "../src/model-surface.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-s5-"));
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

const sent: Record<string, unknown>[] = [];
const base = fakeEngine();
const engine = {
  ...base,
  async modelTree(request: string): Promise<string> {
    const parsed = JSON.parse(request) as { call?: string; op?: Record<string, unknown> };
    if (parsed.call === "apply" && parsed.op && parsed.op.kind === "patch") {
      sent.push(parsed.op);
      const fake = JSON.parse(await base.modelTree(JSON.stringify({ ...parsed, op: { kind: "unify" } }))) as Record<string, unknown>;
      return JSON.stringify({ ...fake, op: parsed.op });
    }
    return base.modelTree(request);
  },
};

const curve = { kind: "polyline", points: [[0, 0, 0], [10, 0, 0]] };
const patch = {
  kind: "patch",
  boundaries: [
    { edges: [0], continuity: "g0" },
    { edges: [1], continuity: "g0" },
    { curve, continuity: "g0" },
  ],
};

check("schema validates a G0 patch", validateTool("model_apply", { op: patch }) === null, String(validateTool("model_apply", { op: patch })));
const g1 = validateTool("model_apply", { op: { kind: "patch", boundaries: [{ edges: [0], continuity: "g1" }, { edges: [1], continuity: "g0" }] } });
check("schema refuses G1", g1 !== null, String(g1));
const blend = validateTool("model_apply", { op: { kind: "blendSurface", a: { edges: [0] }, b: { edges: [1] } } });
check("schema refuses a blend", blend !== null && !String(blend).includes("blendSurface"), String(blend));

const session = new Session(engine);
const created = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 });
const object = created.object as string;
const res = await session.call("model_apply", { object, op: patch, probe: true });
check("model_apply forwards a G0 patch", res.ok === true && sent.at(-1)?.kind === "patch", JSON.stringify({ res, last: sent.at(-1) }));

const older = readSavedTree({
  rootFeature: { kind: "extrude", op: "fuse", origin: [0, 0, 0], profile: [[0, 0], [10, 0], [10, 10]], depth: 4 },
  nodes: [{ id: 0, parent: null, op: null, fingerprint: { volumeMm3: 200, faces: 5, edges: 9 } }],
  current: 0,
  committed: 0,
  nextId: 1,
});
check("an older file with no patch still loads", older !== null && older.nodes.length === 1 && older.nodes[0]?.op === null, JSON.stringify(older));

const saved = readSavedTree({
  rootFeature: { kind: "sheet", mode: "planar", curves: [{ kind: "polyline", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], closed: true }] },
  nodes: [
    { id: 0, parent: null, op: null, fingerprint: { volumeMm3: 0, faces: 1, edges: 3 } },
    { id: 1, parent: 0, op: patch, fingerprint: null },
  ],
  current: 1,
  committed: 1,
  nextId: 2,
});
check("saved-tree codec round-trips a G0 patch", saved !== null && saved.nodes[1]?.op?.kind === "patch", JSON.stringify(saved));

const baked = bakeOp(
  { kind: "patch", boundaries: [{ edges: [0], continuity: "g1" }, { edges: [1], continuity: "g0" }] },
  { pose: IDENTITY_POSE, solid: null, plane: GLOBAL_WORKPLANE, expand: () => ({ faces: [], faceBy: () => ({ reason: "none" }) }) as never, nodeOf: () => null, hasNode: () => false },
);
const wide = bakeOp(
  { kind: "patch", boundaries: [0, 1, 2, 3, 4].map((edge) => ({ edges: [edge], continuity: "g0" })) },
  { pose: IDENTITY_POSE, solid: null, plane: GLOBAL_WORKPLANE, expand: () => ({ faces: [], faceBy: () => ({ reason: "none" }) }) as never, nodeOf: () => null, hasNode: () => false },
);
check("G1 and an opening of more than four sides are refused in one sentence", "reason" in baked && baked.reason === PATCH_NOT_YET && "reason" in wide && wide.reason === PATCH_NOT_YET, JSON.stringify({ baked, wide }));

let protocol = "";
try {
  await session.call("model_apply", { object, op: { kind: "patch", boundaries: [{ edges: [0], continuity: "g1" }, { edges: [1], continuity: "g0" }] }, probe: true });
} catch (err) {
  protocol = err instanceof ProtocolError ? err.message : String(err);
}
check("model_apply refuses G1 before it is built", protocol.length > 0 && !protocol.toLowerCase().includes("geomplate"), protocol);

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("ok");
