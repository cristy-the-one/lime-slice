/**
 * E3 speed and exactness, against the stand-in engine: model_check's summary, a turned plane's U and V,
 * recipe_run's budget, and a text field over its limit. The exact ray and the loft study run in
 * mcp/e3-speed-occt.test.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine, ProtocolError } from "./engine.ts";
import { validateTool } from "./schema.ts";
import { Session } from "./session.ts";
import { budgetOf, timeoutSOf } from "./session/recipe.ts";
import { axesOf } from "../src/workplane.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-e3-"));
process.env.LIME_MCP_BRIDGE = "0";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.error(`FAIL ${name}${text ? ` ${text.slice(0, 500)}` : ""}`);
}

const near = (value: unknown, want: readonly number[]) =>
  Array.isArray(value) && value.length === 3 && want.every((n, i) => Math.abs(Number(value[i]) - n) < 1e-6);

// --- Item 1. A solid asks the kernel. The stand-in has no intersector, so the mesh hit still answers.
{
  const engine = fakeEngine();
  const session = new Session(engine);
  const object = String((await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  engine.calls.length = 0;
  const hit = await session.call("surface_at", { object, point: [0, 0, 40], direction: [0, 0, -1] }) as Record<string, unknown>;
  check("a solid asks the kernel for an exact ray", engine.calls.includes("surfaceAt"), engine.calls.join(","));
  check("without an exact answer the mesh hit still comes back", hit.ok === true && hit.hit === true && hit.exact !== true, hit);
}

// --- Item 2. model_check {surfaces:true} is a summary unless detail:true.
{
  const base = fakeEngine();
  const edges = Array.from({ length: 4 }, (_, edge) => ({ edge, faces: [0, 1], kind: "G1", gapMm: 0, angleDeg: 0.1, curvatureJump: 0, mid: [0, 0, 0] }));
  const sharp = [{ at: [0, 0, 0], faces: [0, 1], angleDeg: 90 }];
  const engine = {
    ...base,
    modelTree(request: string): string | Promise<string> {
      const parsed = JSON.parse(request) as { call?: string };
      if (parsed.call === "surfaceInspect") {
        return JSON.stringify({
          id: 0,
          continuity: { sharedEdges: 4, g2: 1, g1: 2, g0: 1, gaps: 0, maxGapMm: 0, worstSmoothAngleDeg: 0, worstCurvatureJump: 0, edges, sharpVertices: sharp },
          surfaceHealth: { faces: 1, kinds: { plane: 1, cylinder: 0, cone: 0, sphere: 0, torus: 0, bspline: 0, bezier: 0, other: 0 }, maxUDegree: 3, maxVDegree: 3, maxPoles: 4, rationalFaces: 0, highDegreeFaces: 0, heavyFaces: 0 },
        });
      }
      return base.modelTree(request);
    },
  };
  const session = new Session(engine);
  const object = String((await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 })).object);
  const summary = await session.call("model_check", { object, surfaces: true }) as Record<string, unknown>;
  const continuity = summary.continuity as { g0?: number; g1?: number; g2?: number; gaps?: number; edges?: unknown; sharpVertices?: unknown[] } | undefined;
  check(
    "model_check surfaces is a summary: counts, health, sharp vertices, and no edge list",
    summary.ok === true && continuity?.g0 === 1 && continuity.g1 === 2 && continuity.g2 === 1 && continuity.gaps === 0
      && continuity.edges === undefined && Array.isArray(continuity.sharpVertices) && continuity.sharpVertices.length === 1
      && summary.surfaceHealth !== undefined,
    summary,
  );
  const full = await session.call("model_check", { object, surfaces: true, detail: true }) as Record<string, unknown>;
  const listed = (full.continuity as { edges?: unknown[] } | undefined)?.edges;
  check("model_check surfaces detail:true lists every sampled edge", Array.isArray(listed) && listed.length === 4, full.continuity);
}

// --- Item 4. A reply that takes a plane turn names that plane's U and V in model space.
{
  const engine = fakeEngine();
  const session = new Session(engine);
  const object = String((await session.call("solid_new", { primitive: "box", dx: 40, dy: 30, dz: 20 })).object);
  const turn: [number, number, number] = [0, 90, 0];
  const origin: [number, number, number] = [0, 0, 20];
  const [wantU, wantV] = axesOf({ source: "face", origin, turn });
  const plane = await session.call("workplane_set", { object, source: "face", origin, turn }) as Record<string, unknown>;
  check("workplane_set answers with the plane's U and V", plane.ok === true && near(plane.u, wantU) && near(plane.v, wantV), plane);
  const loft = await session.call("model_probe", {
    object,
    op: { kind: "loft", sections: [{ origin: [0, 0, 0], turn, radius: 5 }, { origin: [0, 0, 30], turn: [90, 0, 0], radius: 8 }] },
  }) as Record<string, unknown>;
  const planes = loft.planes as { u?: number[]; v?: number[] }[] | undefined;
  const second = axesOf({ source: "face", origin: [0, 0, 30], turn: [90, 0, 0] });
  check(
    "a loft probe answers U and V for each turned section",
    loft.ok === true && planes?.length === 2 && near(planes[0]?.u, wantU) && near(planes[0]?.v, wantV) && near(planes[1]?.u, second[0]) && near(planes[1]?.v, second[1]),
    loft,
  );
}

// --- Item 5. The default timeout follows //! budget:, and a timeout says how to raise it.
{
  const source = "//! budget: 90s\nfn main() {}\n";
  check("a recipe's //! budget: is the timeout when timeoutS is omitted", timeoutSOf(source, undefined) === 90, String(timeoutSOf(source, undefined)));
  check("an explicit timeoutS wins over //! budget:", timeoutSOf(source, 12) === 12, String(timeoutSOf(source, 12)));
  check("a recipe with no budget keeps 30 s", timeoutSOf("fn main() {}\n", undefined) === 30);
  const bad = budgetOf("//! budget: 9000s\n");
  check("a budget outside 1–600 s is not a timeout", bad !== null && "bad" in bad, bad);
  const { readFileSync } = await import("node:fs");
  const host = readFileSync(new URL("../src/recipe/host.ts", import.meta.url), "utf8");
  check(
    "a timeout names the seconds it had and how to raise it",
    host.includes("Raise it with timeoutS (at most 600) or a //! budget: line in the recipe."),
    "host.ts has no raise sentence",
  );
}

// --- Item 6. Every length-checked text field names the limit and the length. Lessons stay at 200.
{
  const lesson = validateTool("nugget", { action: "save", kind: "lesson", id: "fillet", text: "x".repeat(312) });
  check("a lesson over its limit names 200 and the length", lesson === "input.text is too long: at most 200 characters, got 312.", lesson);
  const title = validateTool("nugget", { action: "save", kind: "plugin", title: "t".repeat(80), description: "ok" });
  check("another text field names its own limit and the length", title === "input.title is too long: at most 60 characters, got 80.", title);
  const engine = fakeEngine();
  const session = new Session(engine);
  let saved: Record<string, unknown> = { ok: true };
  try {
    saved = await session.call("nugget", { action: "save", kind: "lesson", id: "fillet", text: "x".repeat(300) }) as Record<string, unknown>;
  } catch (err) {
    saved = { ok: false, reason: err instanceof ProtocolError ? err.message : String(err) };
  }
  check("saving a lesson past 200 characters is refused, not sliced", saved.ok === false && /at most 200 characters, got 300/.test(String(saved.reason)), saved);
}

if (failed) {
  console.error(`e3-speed: ${failed} failed`);
  process.exit(1);
}
console.log("e3-speed: ok");
