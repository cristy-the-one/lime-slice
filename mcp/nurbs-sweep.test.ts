/**
 * Organic surfaces S2: MCP parity for exact NURBS profile segments (`ProfileSegment::Nurbs`)
 * and real kernel `Op::Sweep` (`BRepOffsetAPI_MakePipeShell`: sharp elbows, 3D NURBS spines,
 * Law_Interpol scale, twist, and solid edges) alongside legacy MCP `sweep { path }`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-nurbs-s2-"));
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
  modelTree(request: string): string {
    const parsed = JSON.parse(request) as { call?: string; op?: Record<string, unknown> };
    if (parsed.call === "apply" && parsed.op) {
      sentOps.push(parsed.op);
      // Fake engine handles unknown op kinds by returning a valid box-like solid reply if we fall back to probe/apply.
      if (parsed.op.kind === "sweep") {
        const fake = JSON.parse(
          baseEngine.modelTree(JSON.stringify({ ...parsed, op: { kind: "unify" } })),
        ) as Record<string, unknown>;
        return JSON.stringify({ ...fake, op: parsed.op });
      }
    }
    if (parsed.call === "probe" && parsed.op?.kind === "sweep") {
      return JSON.stringify({ ok: true, fits: true, volumeMm3: 4200, faces: 8, edges: 14, solids: 1 });
    }
    return baseEngine.modelTree(request);
  },
};

// 1. Schema accepts exact NURBS loop segments and real kernel sweep ops.
const nurbsExtrudeOp = {
  kind: "extrude",
  op: "fuse",
  depth: 10,
  loops: [{
    start: [0, 0],
    segments: [
      { kind: "line", to: [10, 0] },
      { kind: "nurbs", poles: [[10, 10]], weights: [1, Math.SQRT1_2, 1], degree: 2, to: [0, 10] },
      { kind: "line", to: [0, 0] },
    ],
  }],
};
check(
  "schema validates exact NURBS loop segment in extrude",
  validateTool("model_apply", { op: nurbsExtrudeOp }) === null,
  String(validateTool("model_apply", { op: nurbsExtrudeOp })),
);

const kernelSweepOp = {
  kind: "sweep",
  op: "fuse",
  sections: [{ origin: [0, 0, 10], turn: [0, 0, 0], radius: 3 }],
  spine: {
    kind: "nurbs",
    poles: [[0, 0, 10], [0, 0, 25], [15, 0, 30], [30, 0, 30]],
    degree: 3,
  },
  transition: "right",
  scale: [[0, 1], [1, 1.5]],
  twistDeg: 45,
};
check(
  "schema validates real kernel sweep with 3D NURBS spine, transition, scale, twistDeg",
  validateTool("model_apply", { op: kernelSweepOp }) === null,
  String(validateTool("model_apply", { op: kernelSweepOp })),
);

const legacySweepOp = {
  kind: "sweep",
  op: "fuse",
  path: [[0, 0, 10], [0, 0, 25], [10, 0, 35]],
  radius: 3,
};
check(
  "schema keeps legacy MCP sweep { path, radius } valid",
  validateTool("model_apply", { op: legacySweepOp }) === null,
  String(validateTool("model_apply", { op: legacySweepOp })),
);

// 2. End-to-end Session.call forwards exact NURBS segments and real kernel SweepOp intact.
const session = new Session(engine);
const created = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 });
const object = created.object as string;

const r1 = await session.call("model_apply", { object, op: nurbsExtrudeOp, probe: true });
const last1 = sentOps.at(-1) as { kind?: string; loops?: { segments?: { kind?: string; degree?: number; weights?: number[] }[] }[] } | undefined;
check(
  "model_apply forwards exact NURBS profile segment with poles, weights, and degree to kernel",
  r1.ok === true && last1?.kind === "extrude" && last1.loops?.[0]?.segments?.[1]?.kind === "nurbs"
    && last1.loops?.[0]?.segments?.[1]?.degree === 2
    && last1.loops?.[0]?.segments?.[1]?.weights?.length === 3,
  JSON.stringify({ r1, last1 }),
);

const r2 = await session.call("model_apply", { object, op: kernelSweepOp, probe: true });
const last2 = sentOps.at(-1) as { kind?: string; spine?: { kind?: string; poles?: unknown[] }; transition?: string; twistDeg?: number } | undefined;
check(
  "model_apply forwards real kernel SweepOp with 3D NURBS spine, transition, and twistDeg",
  r2.ok === true && last2?.kind === "sweep" && last2.spine?.kind === "nurbs"
    && last2.spine.poles?.length === 4 && last2.transition === "right" && last2.twistDeg === 45,
  JSON.stringify({ r2, last2 }),
);

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("mcp nurbs & kernel sweep: ok");
