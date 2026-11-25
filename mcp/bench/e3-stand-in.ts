/**
 * Stand-in for the Tin Lizzie body run (t26_body.rs is not in this repo).
 *
 * A loft through the tub stations -87.6/-86/-83/-76/-40/-5/6, each a circle. The profiles are not
 * the car's. Times surface_at, sizes model_check {surfaces:true} against {detail:true}, and prints
 * how far the loft leaves a straight radius between those stations.
 *
 *   LIME_OCCT_BRIDGE=target/debug/liblime_model_occt.so node --experimental-strip-types mcp/bench/e3-stand-in.ts
 *
 * LIME_LOFT_DEGREE=3 or 5 builds that loft with maxDegree set. The spacing and degree-5
 * study ran against a temporary kernel switch and is recorded in the PR; the switch is not shipped.
 * On the Windows machine the real numbers are a recipe_run of
 * C:\Users\mariu\lime-workspace\tin-lizzie-26\recipes\t26_body.rs with profile:true.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "../engine.ts";
import { Session } from "../session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("../..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
if (!bridge || !existsSync(bridge) || !addon) {
  console.error("e3-stand-in: set LIME_OCCT_BRIDGE and build lime-mcp-engine");
  process.exit(1);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-e3-bench-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = "180";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
const engine = loadEngineWorker(root);
const session = new Session(engine);
const call = (name: string, args: unknown) => session.call(name, args) as Promise<Reply>;

const STATIONS = [-87.6, -86, -83, -76, -40, -5, 6];
const RADII = [18, 22, 28, 36, 48, 42, 40];
const feature: Record<string, unknown> = {
  kind: "loft",
  sections: STATIONS.map((z, i) => ({ origin: [0, 0, z], radius: RADII[i] })),
};
if (process.env.LIME_LOFT_DEGREE) feature.maxDegree = Number(process.env.LIME_LOFT_DEGREE);

function linearRadius(z: number): number {
  for (let i = 1; i < STATIONS.length; i += 1) {
    const z0 = STATIONS[i - 1]!;
    const z1 = STATIONS[i]!;
    if (z <= z1 || i === STATIONS.length - 1) return RADII[i - 1]! + (RADII[i]! - RADII[i - 1]!) * ((z - z0) / (z1 - z0));
  }
  return RADII[RADII.length - 1]!;
}

const builtAt = performance.now();
const made = await call("solid_new", { feature });
const buildMs = performance.now() - builtAt;
if (made.ok !== true) {
  console.error(made.reason ?? made);
  process.exit(1);
}
const object = String(made.object);

const perCall: number[] = [];
for (let i = 0; i < 8; i += 1) {
  const z = STATIONS[0]! + ((STATIONS[STATIONS.length - 1]! - STATIONS[0]!) * i) / 7;
  const startedOne = performance.now();
  await call("surface_at", { object, point: [0, -200, z], direction: [0, 1, 0] });
  perCall.push(performance.now() - startedOne);
}
const rest = perCall.slice(1);
const restMean = rest.reduce((sum, ms) => sum + ms, 0) / rest.length;
console.log(`surface_at perCall ms first=${perCall[0]!.toFixed(1)} restMean=${restMean.toFixed(1)} each=${perCall.map((ms) => ms.toFixed(1)).join(",")}`);

const rays = Array.from({ length: 200 }, (_, i) => {
  const z = STATIONS[0]! + ((STATIONS[STATIONS.length - 1]! - STATIONS[0]!) * i) / 199;
  return { point: [0, -200, z], direction: [0, 1, 0] };
});
const t0 = performance.now();
const hit = await call("surface_at", { object, rays });
const rayMs = performance.now() - t0;
const hits = (hit.hits as Reply[] | undefined) ?? [];
const exact = hits.filter((row) => row.exact === true).length;
const landed = hits.filter((row) => row.hit === true).length;

const zs = [-84.5, -79.5, -58, -22.5];
let worst = 0;
const samples: string[] = [];
for (const z of zs) {
  const row = await call("surface_at", { object, point: [0, -200, z], direction: [0, 1, 0] });
  const point = row.point as number[] | undefined;
  if (row.hit !== true || !point) {
    worst = Number.POSITIVE_INFINITY;
    samples.push(`${z}:miss`);
    break;
  }
  const radius = Math.hypot(point[0] ?? 0, point[1] ?? 0);
  worst = Math.max(worst, Math.abs(radius - linearRadius(z)));
  samples.push(`${z}:${radius.toFixed(3)}`);
}
const described = await call("model_describe", { object, limit: 1 });
const summary = await call("model_check", { object, surfaces: true });
const detail = await call("model_check", { object, surfaces: true, detail: true });
const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
const detailBytes = Buffer.byteLength(JSON.stringify(detail));
const edges = described.edgeCount ?? (described.edges as unknown[] | undefined)?.length ?? "?";

let overshoot = 0;
let overshootAt = 0;
for (let z = STATIONS[0]!; z <= STATIONS[STATIONS.length - 1]!; z += 0.5) {
  const row = await call("surface_at", { object, point: [0, -200, z], direction: [0, 1, 0] });
  const point = row.point as number[] | undefined;
  if (row.hit !== true || !point) continue;
  const radius = Math.hypot(point[0] ?? 0, point[1] ?? 0);
  let i = 1;
  while (i < STATIONS.length - 1 && z > STATIONS[i]!) i += 1;
  const low = Math.min(RADII[i - 1]!, RADII[i]!);
  const high = Math.max(RADII[i - 1]!, RADII[i]!);
  const past = Math.max(0, low - radius, radius - high);
  if (past > overshoot) {
    overshoot = past;
    overshootAt = z;
  }
}
console.log(`study=${process.env.LIME_LOFT_STUDY ?? "default"} degree=${process.env.LIME_LOFT_DEGREE ?? "-"} buildMs=${buildMs.toFixed(1)} edges=${edges} deviationMm=${Number.isFinite(worst) ? worst.toFixed(3) : "miss"} overshootMm=${overshoot.toFixed(3)} at z=${overshootAt.toFixed(1)} samples=${samples.join(",")}`);
console.log(`surface_at rays=${rays.length} landed=${landed} exact=${exact} ms=${rayMs.toFixed(1)}`);
console.log(`model_check summaryBytes=${summaryBytes} detailBytes=${detailBytes}`);
process.exit(0);
