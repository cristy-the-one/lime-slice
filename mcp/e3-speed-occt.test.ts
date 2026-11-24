/**
 * E3 items 1 and 3 against real Open CASCADE: a ray on the exact B-rep, and a loft through the
 * Tin Lizzie tub stations (a stand-in circle, not the body recipe). Skips without LIME_OCCT_BRIDGE;
 * fails in CI when it is unset. Ends with process.exit(0).
 *
 * The stand-in stations are -87.6, -86, -83, -76, -40, -5 and 6, with a circle whose radius grows
 * and then eases. The profiles are not the car's; they only keep the spacing that rippled.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("e3-speed-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("e3-speed-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-e3-occt-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "180";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
const engine = loadEngineWorker(root);
const session = new Session(engine);
async function call(name: string, args: unknown): Promise<Reply> {
  try {
    return (await session.call(name, args)) as Reply;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Stand-in tub: the T26 stations, a circle at each. Not the car's sections. */
const STATIONS = [-87.6, -86, -83, -76, -40, -5, 6];
const RADII = [18, 22, 28, 36, 48, 42, 40];

function tub(extra: Record<string, unknown> = {}) {
  return {
    kind: "loft",
    sections: STATIONS.map((z, i) => ({ origin: [0, 0, z], radius: RADII[i] })),
    ...extra,
  };
}

function linearRadius(z: number): number {
  for (let i = 1; i < STATIONS.length; i += 1) {
    const z0 = STATIONS[i - 1]!;
    const z1 = STATIONS[i]!;
    if (z <= z1 || i === STATIONS.length - 1) {
      const t = (z - z0) / (z1 - z0);
      return RADII[i - 1]! + (RADII[i]! - RADII[i - 1]!) * t;
    }
  }
  return RADII[RADII.length - 1]!;
}

async function deviationOf(object: string): Promise<number> {
  // Side rays at the tight cluster and in the long gap. A ripple leaves the circle.
  const zs = [-84.5, -79.5, -58, -22.5];
  let worst = 0;
  for (const z of zs) {
    const hit = await call("surface_at", { object, point: [0, -200, z], direction: [0, 1, 0] });
    const point = hit.point as number[] | undefined;
    if (hit.hit !== true || !point) return Number.POSITIVE_INFINITY;
    const radius = Math.hypot(point[0] ?? 0, point[1] ?? 0);
    worst = Math.max(worst, Math.abs(radius - linearRadius(z)));
  }
  return worst;
}

try {
  const sphere = await call("solid_new", { primitive: "sphere", radius: 25 });
  check("a sphere builds", sphere.ok === true, sphere);
  const ball = String(sphere.object);
  const centre = (((await call("faces_find", { object: ball, kind: "sphere" })).faces as Reply[] | undefined)?.[0]?.axisPoint ?? [0, 0, 25]) as number[];
  const from = [centre[0], centre[1], centre[2]! + 75];
  const hit = await call("surface_at", { object: ball, point: from, direction: [0, 0, -1] });
  const point = hit.point as number[] | undefined;
  const wantZ = centre[2]! + 25;
  check(
    "surface_at on a solid is the exact point, not the mesh chord",
    hit.ok === true && hit.hit === true && hit.exact === true && !!point && Math.abs(point[2]! - wantZ) < 1e-4 && Math.abs(point[0]! - centre[0]!) < 1e-4,
    hit,
  );

  const made = await call("solid_new", { feature: tub() });
  check("the stand-in tub loft builds", made.ok === true, made);
  const tubId = String(made.object);
  const rays = Array.from({ length: 80 }, (_, i) => {
    const z = STATIONS[0]! + ((STATIONS[STATIONS.length - 1]! - STATIONS[0]!) * i) / 79;
    return { point: [0, -200, z], direction: [0, 1, 0] };
  });
  const started = performance.now();
  const many = await call("surface_at", { object: tubId, rays });
  const ms = performance.now() - started;
  const hits = (many.hits as Reply[] | undefined) ?? [];
  const exactHits = hits.filter((row) => row.exact === true && row.hit === true).length;
  console.log(`stand-in surface_at: ${rays.length} rays in ${ms.toFixed(1)} ms, exact hits ${exactHits}`);
  check("the tub's rays are exact hits", many.ok === true && exactHits === rays.length, { ok: many.ok, exactHits, reason: hits.find((row) => row.hit !== true)?.reason });

  const summary = await call("model_check", { object: tubId, surfaces: true });
  const detail = await call("model_check", { object: tubId, surfaces: true, detail: true });
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
  const detailBytes = Buffer.byteLength(JSON.stringify(detail));
  const edges = (detail.continuity as { edges?: unknown[] } | undefined)?.edges;
  console.log(`stand-in model_check: summary ${summaryBytes} bytes, detail ${detailBytes} bytes, edges ${edges?.length ?? 0}`);
  check(
    "model_check surfaces is a summary until detail:true",
    summary.ok === true && (summary.continuity as { edges?: unknown } | undefined)?.edges === undefined
      && typeof (summary.continuity as { g0?: unknown } | undefined)?.g0 === "number"
      && summary.surfaceHealth !== undefined
      && Array.isArray(edges) && edges.length > 0
      && summaryBytes < detailBytes,
    { summaryBytes, detailBytes },
  );

  const fair = await deviationOf(tubId);
  const cubicMade = await call("solid_new", { feature: tub({ maxDegree: 3 }) });
  const cubic = cubicMade.ok === true ? await deviationOf(String(cubicMade.object)) : Number.POSITIVE_INFINITY;
  const described = await call("model_describe", { object: tubId, limit: 1 });
  console.log(`stand-in loft: default deviation ${fair.toFixed(3)} mm, maxDegree 3 deviation ${cubic.toFixed(3)} mm, edges ${described.edgeCount ?? described.edges?.length ?? "?"}`);
  check("uneven sections stay at least as close as a degree-3 loft", Number.isFinite(fair) && fair <= cubic + 0.05, { fair, cubic });

  const refused = await call("solid_new", { feature: tub({ maxDegree: 3, smoothing: true }) });
  check(
    "maxDegree 3 with smoothing is refused and names what to change",
    refused.ok === false && /maxDegree 3/.test(String(refused.reason)) && /smoothing/.test(String(refused.reason)) && /maxDegree 5/.test(String(refused.reason)),
    refused.reason,
  );
} catch (err) {
  console.error(err);
  process.exit(1);
}

if (failed) {
  console.error(`e3-speed-occt: ${failed} failed`);
  process.exit(1);
}
console.log("e3-speed-occt: ok");
process.exit(0);
