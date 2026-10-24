/**
 * The Stress guide's worked example, solved by the real engine and painted on
 * the part's own surface: a 100 × 10 × 10 mm PLA cantilever on the Lime 220,
 * printed solid, one end held, 20 N down on the other.
 *
 * Beam theory: σ = P L c / I at the held end's top and bottom faces,
 * δ = P L³ / (3 E I) + (3/2) P L / (A G) at the free end.
 *
 * The bridge is sent the part's corners as the desktop sends them. The colours
 * must sit on the part (its box, not the staircase of cells), run hot at the
 * held end and cold at the free end, and the peak the legend reads must match
 * σ within 3%. Deflection is within 5%: the infill's beads cross the beam at
 * ±45°, so the printed part is a little softer than E in plane.
 *
 * The same beam on the IR3 V2's 45° belt is sliced in a skewed frame; its
 * colours must still sit on the part's box, hot at the held end.
 *
 * `LIME_CANTILEVER_FIXTURE=<path>` also writes the reply, painted on 5 mm
 * triangles to stay small, for `e2e/stress-cantilever.spec.ts`.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { surfaceResult } from "../src/sim/bridge-body.ts";
import { provisionalCards } from "../src/sim/cards.ts";
import { paintCorners } from "../src/sim/paint-mesh.ts";
import { emptyStudy, notShown } from "../src/sim/study.ts";

import { loadNativeEngine } from "./engine.ts";
import { Session } from "./session.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const L = 100;
const B = 10;
const H = 10;
const P = 20;
const pla = provisionalCards().find((card) => card.id === "inhouse-pla")!;
const I = (B * H ** 3) / 12;
const sigma = (P * L * (H / 2)) / I;
const G = pla.EInPlaneMPa / (2 * (1 + pla.nu));
const delta = (P * L ** 3) / (3 * pla.EInPlaneMPa * I) + (1.5 * P * L) / (B * H * G);

const root = fileURLToPath(new URL("..", import.meta.url));
const engine = loadNativeEngine(root);
const solve = engine.simStudy.bind(engine);
let reply = "";
let coarse = "";
/** The part's corners in the request's mesh, as the desktop's `paintSurface` sends them. */
function withPaint(body: string, edgeMm: number): string {
  const parsed = JSON.parse(body) as { request: Record<string, unknown> & { objects?: Record<string, unknown>[] }; paint?: string };
  const row = (parsed.request.objects?.[0] ?? parsed.request) as { dataB64: string };
  const stl = Buffer.from(row.dataB64, "base64");
  const count = stl.readUInt32LE(80);
  const positions = new Float32Array(count * 9);
  for (let tri = 0; tri < count; tri += 1) {
    for (let k = 0; k < 9; k += 1) positions[tri * 9 + k] = stl.readFloatLE(84 + tri * 50 + 12 + k * 4);
  }
  const corners = paintCorners(positions, edgeMm);
  parsed.paint = Buffer.from(corners.buffer, corners.byteOffset, corners.byteLength).toString("base64");
  return JSON.stringify(parsed);
}
engine.simStudy = async (body: string) => {
  reply = await Promise.resolve(solve(withPaint(body, 1.5)));
  if (process.env.LIME_CANTILEVER_FIXTURE) coarse = await Promise.resolve(solve(withPaint(body, 5)));
  return reply;
};

const session = new Session(engine);
await session.call("machine_select", { printerId: "lime-220", filamentId: "lime-pla" });
const setup = await session.call("sim_setup", {
  beam: { lengthMm: L, widthMm: B, heightMm: H },
  hMm: 1.5,
  representation: "sliced",
  // Faces of the generated box: 4 is X = 0, 5 is X = L.
  fixtures: [{ kind: "faces", faces: [4] }],
  loads: [{ kind: "force", faces: [5], magnitude: P, direction: [0, 0, -1] }],
  card: "inhouse-pla",
  constraints: [{ kind: "minSafetyFactor", value: 1 }],
});
check("the cantilever is set up", setup.ok === true, String(setup.reason ?? ""));
const solid = await session.call("settings_set", { object: setup.object, values: { infill: 1 } });
check("it is printed solid", solid.ok === true, String(solid.reason ?? ""));
const run = await session.call("sim_run", { object: setup.object, checkResolution: true });
check("it solves as sliced", run.ok === true && run.representation === "sliced", String(run.reason ?? ""));

const parsed = surfaceResult(reply, "vonMises");
if ("error" in parsed) {
  check("the reply has a surface", false, parsed.error);
} else {
  check("the bridge painted the part's corners", parsed.painted === true);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const node of parsed.nodes) {
    for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k]!, node.at[k]!);
      hi[k] = Math.max(hi[k]!, node.at[k]!);
    }
  }
  const box = [...lo, ...hi].map((v) => Number(v.toFixed(4)));
  check("the colours sit on the part's own box, not on the cells", JSON.stringify(box) === JSON.stringify([0, 0, 0, L, B, H]), JSON.stringify(box));
  const near = (x0: number, x1: number) => {
    const rows = parsed.nodes.filter((node) => node.at[0] >= x0 && node.at[0] <= x1).map((node) => node.vonMises);
    return rows.reduce((sum, v) => sum + v, 0) / Math.max(1, rows.length);
  };
  const held = near(0, 10);
  const free = near(90, 100);
  check("hot at the held end, cold at the free end", held > 5 * free, `${held.toFixed(2)} vs ${free.toFixed(2)} MPa`);
  check(`the legend's peak is P L c / I = ${sigma.toFixed(2)} MPa within 3%`, Math.abs(parsed.peak / sigma - 1) <= 0.03, `${parsed.peak.toFixed(3)} MPa`);
  const deflection = run.maxDisplacementMm as number;
  check(`the free end drops ${delta.toFixed(2)} mm within 5%`, Math.abs(deflection / delta - 1) <= 0.05, `${deflection.toFixed(3)} mm`);
  const study = { ...emptyStudy(), holds: [{ kind: "faces" as const, faces: [4] }] };
  check("the two cell sizes agree well enough to draw", notShown(parsed, study, pla) === null, `moved ${parsed.moved}`);
  console.log(`cantilever: peak ${parsed.peak.toFixed(3)} MPa (theory ${sigma.toFixed(3)}), tip ${deflection.toFixed(3)} mm (theory ${delta.toFixed(3)}), moved ${((parsed.moved ?? 0) * 100).toFixed(1)}%`);
}

{
  const belt = new Session(engine);
  await belt.call("machine_select", { printerId: "ideaformer-ir3-v2", filamentId: "lime-pla" });
  const set = await belt.call("sim_setup", {
    beam: { lengthMm: L, widthMm: B, heightMm: H },
    hMm: 1.5,
    representation: "sliced",
    fixtures: [{ kind: "faces", faces: [4] }],
    loads: [{ kind: "force", faces: [5], magnitude: P, direction: [0, 0, -1] }],
    card: "inhouse-pla",
  });
  await belt.call("settings_set", { object: set.object, values: { infill: 1 } });
  const solved = await belt.call("sim_run", { object: set.object, checkResolution: false });
  const painted = surfaceResult(reply, "vonMises");
  if (solved.ok !== true || "error" in painted) {
    check("the belt cantilever solves", false, String(solved.reason ?? ("error" in painted ? painted.error : "")));
  } else {
    const xs = painted.nodes.map((node) => node.at);
    const box = [0, 1, 2].flatMap((k) => [Math.min(...xs.map((at) => at[k]!)), Math.max(...xs.map((at) => at[k]!))]).map((v) => Number(v.toFixed(4)));
    check("on the belt the colours sit on the part's box too", JSON.stringify(box) === JSON.stringify([0, L, 0, B, 0, H]), JSON.stringify(box));
    const mean = (x0: number, x1: number) => {
      const rows = painted.nodes.filter((node) => node.at[0] >= x0 && node.at[0] <= x1).map((node) => node.vonMises);
      return rows.reduce((sum, v) => sum + v, 0) / Math.max(1, rows.length);
    };
    check("on the belt it is hot at the held end, cold at the free end", mean(0, 10) > 5 * mean(90, 100), `${mean(0, 10).toFixed(2)} vs ${mean(90, 100).toFixed(2)} MPa`);
  }
}

if (process.env.LIME_CANTILEVER_FIXTURE && coarse) {
  const out = JSON.parse(coarse) as Record<string, unknown>;
  // The Preview's cell lookup is not part of the Model view's fixture.
  delete out.cells;
  writeFileSync(process.env.LIME_CANTILEVER_FIXTURE, `${JSON.stringify(out)}\n`);
  console.log(`wrote ${process.env.LIME_CANTILEVER_FIXTURE}`);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sim-paint: ok");
