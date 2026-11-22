/**
 * Organic surfaces S1: MCP `model_check { surfaces: true }` continuity/health/warnings
 * and exact barycentric analytic normals in `surface_at`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { surfaceAt } from "./inspect.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-surface-s1-"));
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

// 1. Direct barycentric analytic normal interpolation in `surface_at`:
// A flat triangle lying in z=0 whose analytic normals tilt at the corners must interpolate smoothly,
// rather than snapping to the flat triangle's [0, 0, 1] geometric normal.
const triPositions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
const n0 = [0, 0, 1];
const n1 = [Math.SQRT1_2, 0, Math.SQRT1_2];
const n2 = [0, Math.SQRT1_2, Math.SQRT1_2];
const triNormals = new Float32Array([...n0, ...n1, ...n2]);
const hit = surfaceAt(
  {
    positions: triPositions,
    normals: triNormals,
    triangles: new Uint32Array([0]),
    bounds: { min: [0, 0, 0], max: [10, 10, 0] },
  },
  { x: 2.5, y: 2.5 },
);
const hitNormal = hit.normal as [number, number, number] | undefined;
check(
  "surface_at interpolates analytic vertex normals via barycentric coordinates",
  hit.hit === true && !!hitNormal && hitNormal[0] > 0.15 && hitNormal[1] > 0.15 && hitNormal[2] < 0.98,
  JSON.stringify(hit),
);

// 2. MCP `model_check { surfaces: true }` returns continuity, surfaceHealth, and tight-radius warning.
const baseEngine = fakeEngine();
let inspectCalls = 0;
const engine = {
  ...baseEngine,
  modelTree(request: string): string | Promise<string> {
    const parsed = JSON.parse(request) as { call?: string; node?: number };
    if (parsed.call === "surfaceInspect") {
      inspectCalls += 1;
      return JSON.stringify({
        id: parsed.node ?? 0,
        continuity: {
          sharedEdges: 10,
          g2: 0,
          g1: 2,
          g0: 8,
          gaps: 0,
          maxGapMm: 0,
          worstSmoothAngleDeg: 0.04,
          worstCurvatureJump: 1.667,
          notable: [
            { edge: 4, faces: [0, 6], kind: "G1", gapMm: 0, angleDeg: 0.04, curvatureJump: 1.667, mid: [5, 0, 5] },
          ],
        },
        surfaceHealth: {
          faces: 7,
          kinds: { plane: 6, cylinder: 1, cone: 0, sphere: 0, torus: 0, bspline: 0, bezier: 0, other: 0 },
          maxUDegree: 0,
          maxVDegree: 0,
          maxPoles: 0,
          rationalFaces: 0,
          highDegreeFaces: 0,
          heavyFaces: 0,
          minRadiusMm: 0.6,
          tightestFace: 6,
          tightestAt: [5, 0, 5],
        },
      });
    }
    return baseEngine.modelTree(request);
  },
};

const session = new Session(engine);
const created = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 });
const object = created.object as string;

const plain = await session.call("model_check", { object });
check("plain model_check skips surfaceInspect (0 overhead)", plain.ok === true && inspectCalls === 0 && plain.continuity === undefined);

const withSurfaces = await session.call("model_check", { object, surfaces: true, minWallMm: 1.2 });
check(
  "model_check { surfaces: true } returns continuity & surfaceHealth",
  withSurfaces.ok === true
    && inspectCalls === 1
    && (withSurfaces.continuity as { g1?: number })?.g1 === 2
    && (withSurfaces.surfaceHealth as { minRadiusMm?: number })?.minRadiusMm === 0.6,
  JSON.stringify(withSurfaces),
);
check(
  "model_check { surfaces: true } warns when tightest bend radius is under minWallMm",
  Array.isArray(withSurfaces.warnings)
    && (withSurfaces.warnings as string[]).some((w) => w.includes("0.60 mm") && w.includes("Shell")),
  JSON.stringify(withSurfaces.warnings),
);

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("mcp surface-inspect: ok");
