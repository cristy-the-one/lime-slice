/**
 * Organic surfaces S3: MCP, codec, and edit-panel parity for variable / G2 / Conic Fillet v2
 * and controlled Loft v2 (apex caps, boundary conditions, closed periodic lofts, 3D guide rails).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";
import { readSavedTree } from "../src/model-tree-file.ts";
import { editPanel } from "../src/model-edit.ts";
import { IDENTITY_POSE } from "../src/model-space.ts";
import type { ModelOp } from "../src/model-tree.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-s3-"));
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

const sentOps: Record<string, unknown>[] = [];
const baseEngine = fakeEngine();
const engine = {
  ...baseEngine,
  async modelTree(request: string): Promise<string> {
    const parsed = JSON.parse(request) as { call?: string; op?: Record<string, unknown> };
    if (parsed.call === "apply" && parsed.op) {
      sentOps.push(parsed.op);
      if (parsed.op.kind === "loft" || parsed.op.kind === "fillet") {
        const fake = JSON.parse(
          await baseEngine.modelTree(JSON.stringify({ ...parsed, op: { kind: "unify" } })),
        ) as Record<string, unknown>;
        return JSON.stringify({ ...fake, op: parsed.op });
      }
    }
    if (parsed.call === "probe" && (parsed.op?.kind === "loft" || parsed.op?.kind === "fillet")) {
      return JSON.stringify({ ok: true, fits: true, volumeMm3: 3200, faces: 9, edges: 16, solids: 1 });
    }
    return baseEngine.modelTree(request);
  },
};

// 1. Schema accepts Fillet v2 (G2, conic rho, variable stations) and keeps plain G1 unchanged.
const filletG2Var = {
  kind: "fillet",
  edges: [0],
  size: 2,
  continuity: "g2",
  variable: [[0, 1], [0.5, 3], [1, 1.5]],
};
check("schema validates G2 variable fillet", validateTool("model_apply", { op: filletG2Var }) === null, String(validateTool("model_apply", { op: filletG2Var })));

const filletConic = {
  kind: "fillet",
  edges: [0],
  size: 4,
  continuity: "conic",
  rho: 0.72,
};
check("schema validates conic fillet with rho", validateTool("model_apply", { op: filletConic }) === null, String(validateTool("model_apply", { op: filletConic })));

// 2. Schema accepts Loft v2 (apex caps, boundary conditions, closed periodic, 3D NURBS guide rails).
const loftV2 = {
  kind: "loft",
  op: "fuse",
  sections: [
    { origin: [0, 0, 10], radius: 8 },
    { apex: [0, 0, 28] },
  ],
  guides: [{ kind: "nurbs", poles: [[8, 0, 10], [14, 0, 19], [0, 0, 28]], degree: 2 }],
  startCondition: { kind: "normal", tension: 1.4 },
  endCondition: { kind: "curvature", dir: [0, 0, 1], tension: 1.2 },
  smoothing: true,
  maxDegree: 6,
};
check("schema validates Loft v2 with apex, guide, boundaries, smoothing, maxDegree", validateTool("model_apply", { op: loftV2 }) === null, String(validateTool("model_apply", { op: loftV2 })));

const loftClosed = {
  kind: "loft",
  op: "fuse",
  sections: [
    { origin: [20, 0, 0], turn: [90, 0, 0], radius: 4 },
    { origin: [0, 20, 0], turn: [90, 0, 90], radius: 4 },
    { origin: [-20, 0, 0], turn: [90, 0, 180], radius: 4 },
    { origin: [0, -20, 0], turn: [90, 0, -90], radius: 4 },
  ],
  closed: true,
};
check("schema validates closed periodic loft", validateTool("model_apply", { op: loftClosed }) === null, String(validateTool("model_apply", { op: loftClosed })));

// 3. Session.call forwards Fillet v2 & Loft v2 intact to the kernel.
const session = new Session(engine);
const created = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 });
const object = created.object as string;

const r1 = await session.call("model_apply", { object, op: filletG2Var, probe: true });
const sent1 = sentOps.at(-1) as { kind?: string; continuity?: string; variable?: [number, number][] } | undefined;
check(
  "model_apply forwards G2 variable fillet intact",
  r1.ok === true && sent1?.kind === "fillet" && sent1.continuity === "g2" && sent1.variable?.length === 3,
  JSON.stringify({ r1, sent1 }),
);

const r2 = await session.call("model_apply", { object, op: loftV2, probe: true });
const sent2 = sentOps.at(-1) as {
  kind?: string;
  sections?: { apex?: number[] }[];
  guides?: { kind?: string }[];
  startCondition?: { kind?: string; tension?: number };
  endCondition?: { kind?: string };
  smoothing?: boolean;
  maxDegree?: number;
} | undefined;
check(
  "model_apply forwards Loft v2 with apex, NURBS guide, boundaries, smoothing, maxDegree",
  r2.ok === true && sent2?.kind === "loft"
    && sent2.sections?.[1]?.apex?.[2] === 28
    && sent2.guides?.[0]?.kind === "nurbs"
    && sent2.startCondition?.kind === "normal"
    && sent2.startCondition?.tension === 1.4
    && sent2.endCondition?.kind === "curvature"
    && sent2.smoothing === true
    && sent2.maxDegree === 6,
  JSON.stringify({ r2, sent2 }),
);

// 4. .lime saved-tree codec round-trips Fillet v2 and Loft v2 cleanly.
const saved = readSavedTree({
  rootPrimitive: { primitive: "box", origin: [-10, -10, 0], turn: [0, 0, 0], size: [20, 20, 10], radius: 0, height: 0 },
  nodes: [
    { id: 0, parent: null, op: null, fingerprint: null },
    { id: 1, parent: 0, op: filletG2Var, fingerprint: null },
    { id: 2, parent: 1, op: loftV2, fingerprint: null },
  ],
  current: 2,
  committed: 2,
  nextId: 3,
});
check(
  "saved-tree codec round-trips Fillet v2 and Loft v2",
  saved !== null && saved.nodes.length === 3
    && (saved.nodes[1]?.op as { continuity?: string })?.continuity === "g2"
    && (saved.nodes[2]?.op as { maxDegree?: number })?.maxDegree === 6,
  JSON.stringify(saved?.nodes),
);

// 5. History editPanel restores Fillet v2 profile & variable stations.
const panel = editPanel(filletG2Var as unknown as ModelOp, IDENTITY_POSE, [0, 0, 5]);
check(
  "editPanel restores G2 variable fillet fields and profile choice",
  panel.tool === "fillet"
    && panel.fillet?.continuity === "g2"
    && panel.fillet?.variable === true
    && panel.fields.modelFilletStart === 1
    && panel.fields.modelFilletMid === 3
    && panel.fields.modelFilletEnd === 1.5,
  JSON.stringify(panel),
);

if (failed > 0) process.exit(1);
console.log("S3 loft-fillet-v2 MCP, codec, and edit-panel checks passed.");
