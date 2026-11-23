/**
 * Organic surfaces S5: schema, bake, and .lime round-trip for patch and blendSurface.
 * An older tree that has neither still loads.
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
    if (parsed.call === "apply" && parsed.op && (parsed.op.kind === "patch" || parsed.op.kind === "blendSurface")) {
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
    { edges: [0], continuity: "g1" },
    { edges: [1], continuity: "g1" },
    { curve, continuity: "g0" },
  ],
  points: [[5, 0, 1]],
};
const blend = {
  kind: "blendSurface",
  a: { edges: [0], continuity: "g1" },
  b: { edges: [1], continuity: "g2" },
  continuity: "g1",
  tensionA: 1,
  tensionB: 1.5,
};

for (const [label, op] of [["patch", patch], ["blendSurface", blend]] as const) {
  const err = validateTool("model_apply", { op });
  check(`schema validates ${label}`, err === null, String(err));
}

const session = new Session(engine);
const created = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 });
const object = created.object as string;
for (const [label, op] of [["patch", patch], ["blendSurface", blend]] as const) {
  const res = await session.call("model_apply", { object, op, probe: true });
  const last = sent.at(-1);
  check(`model_apply forwards ${label}`, res.ok === true && last?.kind === label, JSON.stringify({ res, last }));
}

const older = readSavedTree({
  rootFeature: { kind: "extrude", op: "fuse", origin: [0, 0, 0], profile: [[0, 0], [10, 0], [10, 10]], depth: 4 },
  nodes: [{ id: 0, parent: null, op: null, fingerprint: { volumeMm3: 200, faces: 5, edges: 9 } }],
  current: 0,
  committed: 0,
  nextId: 1,
});
check("an older file with no patch still loads", older !== null && older.nodes.length === 1, JSON.stringify(older));

const saved = readSavedTree({
  rootFeature: { kind: "sheet", mode: "planar", curves: [{ kind: "polyline", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], closed: true }] },
  nodes: [
    { id: 0, parent: null, op: null, fingerprint: { volumeMm3: 0, faces: 1, edges: 3 } },
    { id: 1, parent: 0, op: patch, fingerprint: null },
    { id: 2, parent: 1, op: blend, fingerprint: null },
  ],
  current: 2,
  committed: 2,
  nextId: 3,
});
check(
  "saved-tree codec round-trips patch and blendSurface",
  saved !== null && saved.nodes[1]?.op?.kind === "patch" && saved.nodes[2]?.op?.kind === "blendSurface",
  JSON.stringify(saved),
);

let protocol = "";
try {
  await session.call("model_apply", { object, op: { kind: "blendSurface", a: { edges: [0] }, b: { edges: [1] }, continuity: "g0" }, probe: true });
} catch (err) {
  protocol = err instanceof ProtocolError ? err.message : String(err);
}
const baked = bakeOp(
  { kind: "blendSurface", a: { edges: [0] }, b: { edges: [1] }, continuity: "g0" },
  { pose: IDENTITY_POSE, solid: null, plane: GLOBAL_WORKPLANE, expand: () => ({ faces: [], faceBy: () => ({ reason: "none" }) }) as never, nodeOf: () => null, hasNode: () => false },
);
check(
  "a G0 blend is refused in a sentence",
  protocol.includes("g1") && protocol.includes("g2") && "reason" in baked && baked.reason.includes("G1 or G2"),
  JSON.stringify({ protocol, baked }),
);

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("ok");
