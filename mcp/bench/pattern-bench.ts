/**
 * The pattern bench: `model_apply` of a pattern op on the real engine, with where each run's time went.
 *
 *   node --experimental-strip-types --no-warnings mcp/bench/pattern-bench.ts [--runs 3] [--only holes50,polar36] [--json out.json]
 *
 * A pattern is not one kernel op: the server expands it to its copies, probes and applies each copy as a step (two tree
 * calls a copy, each Apply answering with the whole part, meshed), then folds the steps into one group. Each case makes
 * a plate or a disc with `solid_new`, applies one pattern `--runs` times (default 3) on a fresh part each time, and
 * prints the medians: the wall time with its range, the server's own share, the hop to the engine, and the kernel's
 * split of the rest (the bridge's `timing` marker, as `recipe_run {profile: true}` uses it): booleans, volume, meshing,
 * reading the mesh and the edge lines out, measuring faces and edges, and what is left (building the tools, merging
 * faces on one surface, the store and the reply's text). Then the solid each case leaves: its fingerprint (volume,
 * faces, edges) and three hashes, of the mesh in its read-out order, of the mesh's triangles whatever their order, and
 * of the faces and edges in their numbering, so two builds can be compared on what a pattern leaves behind.
 *
 * The cases: holes in a row and in grids of 50 and 100 (the cost of a copy grows with the copies before it, because
 * each copy trims the plate's two large faces again and they are meshed again), pockets round a disc, bosses, a pattern
 * of an extrude and of a pocket (features, not primitives), holes and cones on a plate that already carries some, and
 * 8 holes on a plate with 1,000 (3,000 edges): the case a reply's edge lines and a large face's mesh are measured on.
 *
 * To compare two builds, run it once with each (LIME_MCP_ENGINE and LIME_OCCT_BRIDGE), alternately when the machine
 * is busy, and compare the tables and the solids' lines.
 *
 * It needs the real engine and the Open CASCADE bridge: LIME_MCP_ENGINE (the library, else target/release),
 * LIME_OCCT_BRIDGE (else beside the engine), with the Open CASCADE DLLs beside the bridge (Windows) or on
 * LD_LIBRARY_PATH. It exits 2 saying what is missing otherwise. It reads and writes nothing outside the repository but
 * a temporary workspace, which it removes. It is not a CI job: it is for the machine of whoever changes how a pattern
 * is built.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

function arg(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const runs = Math.max(1, Number(arg("runs", "3")));
const only = arg("only")?.split(",");
const jsonOut = arg("json");

const workspace = mkdtempSync(join(tmpdir(), "lime-pattern-bench-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = "600";
// A call past 45 s answers with a job; the bench waits for the call itself.
process.env.LIME_MCP_REPLY_S = "3600";

const { loadEngineWorker } = await import("../engine.ts");
const { Session } = await import("../session.ts");
const { kernelRow, newTap } = await import("../session/mesh-end.ts");

function missing(what: string): never {
  console.error(`The pattern bench needs ${what}.`);
  rmSync(workspace, { recursive: true, force: true });
  process.exit(2);
}
let engine;
try {
  engine = loadEngineWorker(root);
} catch (err) {
  missing(`the real engine (${err instanceof Error ? err.message : String(err)})`);
}
if ((await engine.occt()) !== true) missing("the Open CASCADE bridge (LIME_OCCT_BRIDGE, with its DLLs beside it)");
const session = new Session(engine);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
const call = (name: string, args: unknown = {}) => session.call(name, args) as Promise<Reply>;

interface Case {
  id: string;
  title: string;
  base: Record<string, unknown>;
  /** Further ops applied before the pattern, outside the timing. */
  before?: Record<string, unknown>[];
  /** Cuts made before the pattern in one boolean (model_apply_batch with combine), outside the timing. */
  drilled?: Record<string, unknown>[];
  op: Record<string, unknown>;
}

/** A 200 x 120 x 8 plate stands centred on Z = 0: x -100..100, y -60..60, z 0..8. */
const plate = { primitive: "box", dx: 200, dy: 120, dz: 8 };
const hole = { kind: "boolean", op: "cut", primitive: "cylinder", radius: 2, height: 12, origin: [-90, -50, -2] };
/** A cone standing point up, 10 mm tall, its foot 1 mm inside the plate it is fused on. */
const cone = { kind: "boolean", op: "fuse", primitive: "cone", radius: 1, topRadius: 0.3, height: 10 };

const cases: Case[] = [
  {
    id: "holes20",
    title: "20 through holes in a row (linear 20)",
    base: plate,
    op: { kind: "pattern", op: hole, linear: { step: [9, 0, 0], count: 20 } },
  },
  {
    id: "holes50",
    title: "50 through holes in a grid (linear 10 x 5)",
    base: plate,
    op: { kind: "pattern", op: hole, linear: { step: [20, 0, 0], count: 10, step2: [0, 25, 0], count2: 5 } },
  },
  {
    id: "holes100",
    title: "100 through holes in a grid (linear 10 x 10)",
    base: plate,
    op: { kind: "pattern", op: hole, linear: { step: [20, 0, 0], count: 10, step2: [0, 11, 0], count2: 10 } },
  },
  {
    id: "polar36",
    title: "36 box pockets round a disc (polar 36)",
    base: { primitive: "cylinder", radius: 60, height: 8 },
    op: { kind: "pattern", op: { kind: "boolean", op: "cut", primitive: "box", dx: 6, dy: 3, dz: 4, origin: [48, -1.5, 5] }, polar: { count: 36 } },
  },
  {
    id: "bosses40",
    title: "40 round bosses on a plate (linear 8 x 5, fuse)",
    base: plate,
    op: { kind: "pattern", op: { kind: "boolean", op: "fuse", primitive: "cylinder", radius: 3, height: 6, origin: [-88, -48, 7] }, linear: { step: [25, 0, 0], count: 8, step2: [0, 24, 0], count2: 5 } },
  },
  {
    id: "slots24",
    title: "24 extruded slots (pattern of an extrude, linear 12 x 2)",
    base: plate,
    op: {
      kind: "pattern",
      op: { kind: "extrude", op: "cut", origin: [-92, -40, 8], profile: [[0, 0], [8, 0], [10, 6], [8, 12], [0, 12], [-2, 6]], depth: -3 },
      linear: { step: [16, 0, 0], count: 12, step2: [0, 50, 0], count2: 2 },
    },
  },
  {
    id: "pockets24",
    title: "24 rounded pockets (pattern of a pocket, a feature of several steps, linear 8 x 3)",
    base: plate,
    op: {
      kind: "pattern",
      op: { kind: "pocket", face: { normal: [0, 0, 1] }, shape: "rect", from: "centre", at: { u: -84, v: -40 }, width: 14, height: 10, cornerRadius: 3, depth: 3 },
      linear: { step: [24, 0, 0], count: 8, step2: [0, 40, 0], count2: 3 },
    },
  },
  {
    id: "holes46after",
    title: "46 holes on a plate that already has 60 (linear 23 x 2)",
    base: plate,
    before: [{ kind: "pattern", op: { ...hole, radius: 1.5, origin: [-95, -55, -2] }, linear: { step: [9.5, 0, 0], count: 20, step2: [0, 6, 0], count2: 3 } }],
    op: { kind: "pattern", op: { ...hole, origin: [-92, 20, -2] }, linear: { step: [8, 0, 0], count: 23, step2: [0, 20, 0], count2: 2 } },
  },
  {
    id: "cones60",
    title: "60 cones fused on a plate that already carries 120 (linear 12 x 5)",
    base: { primitive: "box", dx: 300, dy: 130, dz: 10 },
    before: [
      { kind: "pattern", op: { ...cone, centre: [-140, -60, 14] }, linear: { step: [4, 0, 0], count: 12, step2: [0, 4, 0], count2: 5 } },
      { kind: "pattern", op: { ...cone, centre: [-140, -30, 14] }, linear: { step: [4, 0, 0], count: 12, step2: [0, 4, 0], count2: 5 } },
    ],
    op: { kind: "pattern", op: { ...cone, centre: [-140, 0, 14] }, linear: { step: [4, 0, 0], count: 12, step2: [0, 4, 0], count2: 5 } },
  },
  {
    id: "holes8on1000",
    title: "8 holes on a plate that already has 1,000 (3,000 edges; linear 8)",
    base: { primitive: "box", dx: 300, dy: 150, dz: 8 },
    drilled: Array.from({ length: 1000 }, (_, i) => ({ ...hole, radius: 1, origin: [-140 + 7 * (i % 40), -70 + 5 * Math.floor(i / 40), -2] })),
    op: { kind: "pattern", op: { ...hole, radius: 1, origin: [-140, 65, -2] }, linear: { step: [35, 0, 0], count: 8 } },
  },
];

interface Result {
  wallMs: number;
  row: Record<string, number>;
  solid: string;
  applied: number;
}

const short = (hash: ReturnType<typeof createHash>) => hash.digest("hex").slice(0, 12);

/** The solid as a pattern leaves it: the fingerprint, and the three hashes the header describes. */
function solidOf(object: string): string {
  const solid = (session as unknown as { find(id: string): { solid?: { positions: Float32Array; triangles: Uint32Array; faces: unknown[]; edges: unknown[]; fingerprint: unknown } } | undefined }).find(object)?.solid;
  if (!solid) return "none";
  const bytes = Buffer.from(solid.positions.buffer, solid.positions.byteOffset, solid.positions.byteLength);
  const ordered = short(createHash("sha256").update(bytes).update(Buffer.from(solid.triangles.buffer, solid.triangles.byteOffset, solid.triangles.byteLength)));
  const rows: string[] = [];
  for (let at = 0; at + 36 <= bytes.length; at += 36) rows.push(`${solid.triangles[at / 36]}:${bytes.subarray(at, at + 36).toString("hex")}`);
  rows.sort();
  const soup = short(createHash("sha256").update(rows.join("\n")));
  const faces = short(createHash("sha256").update(JSON.stringify(solid.faces)).update(JSON.stringify(solid.edges)));
  return `${JSON.stringify(solid.fingerprint)} tris ${solid.triangles.length} mesh ${ordered} soup ${soup} faces ${faces}`;
}

async function once(c: Case): Promise<Result> {
  const made = await call("solid_new", c.base);
  const object = String(made.object);
  for (const op of c.before ?? []) {
    const done = await call("model_apply", { object, op });
    if (done.ok !== true) throw new Error(`${c.id}: the setup failed: ${JSON.stringify(done).slice(0, 600)}`);
  }
  if (c.drilled) {
    const done = await call("model_apply_batch", { object, ops: c.drilled, combine: "cut" });
    if (done.ok !== true) throw new Error(`${c.id}: the setup failed: ${JSON.stringify(done).slice(0, 600)}`);
  }
  const tap = newTap();
  const held = session as unknown as { kernelTap: unknown };
  held.kernelTap = tap;
  const started = performance.now();
  let reply: Reply;
  try {
    reply = await call("model_apply", { object, op: c.op });
  } finally {
    held.kernelTap = null;
  }
  const wallMs = performance.now() - started;
  if (reply.ok !== true) throw new Error(`${c.id} failed: ${JSON.stringify(reply).slice(0, 800)}`);
  const result: Result = { wallMs, row: kernelRow(tap.all) ?? {}, solid: solidOf(object), applied: Number(reply.applied ?? 0) };
  await call("object_remove", { object });
  return result;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const seconds = (ms: number) => (ms / 1000).toFixed(2);
const keys = ["booleanMs", "volumeMs", "meshMs", "readoutMs", "describeMs", "otherMs"];

const report: Record<string, unknown> = {};
let failed = false;
console.log(`| case | calls | wall s (range) | server | hop | kernel | ${keys.map((key) => key.replace("Ms", "")).join(" | ")} | booleans | meshes |`);
console.log(`|---|---:|---:|---:|---:|---:|${keys.map(() => "---:").join("|")}|---:|---:|`);
const solids: string[] = [];
for (const c of cases.filter((row) => !only || only.includes(row.id))) {
  const rows: Result[] = [];
  try {
    for (let i = 0; i < runs; i += 1) rows.push(await once(c));
  } catch (err) {
    failed = true;
    console.error(err instanceof Error ? err.message : String(err));
    continue;
  }
  const of = (pick: (row: Result) => number) => median(rows.map(pick));
  const walls = rows.map((row) => row.wallMs);
  const engineMs = of((row) => row.row.engineMs ?? 0);
  const kernelMs = of((row) => row.row.kernelMs ?? 0);
  const wall = of((row) => row.wallMs);
  console.log(
    `| ${c.id} | ${rows[0]!.row.requests ?? 0} | ${seconds(wall)} (${seconds(Math.min(...walls))} to ${seconds(Math.max(...walls))}) | ${seconds(wall - engineMs)} | ${seconds(engineMs - kernelMs)} | ${seconds(kernelMs)} | ${keys.map((key) => seconds(of((row) => row.row[key] ?? 0))).join(" | ")} | ${rows[0]!.row.booleans ?? 0} | ${rows[0]!.row.meshes ?? 0} |`,
  );
  const same = new Set(rows.map((row) => row.solid)).size === 1;
  solids.push(`${c.id}: ${c.title}\n  ${rows[0]!.solid}${same ? "" : `\n  NOT THE SAME EVERY RUN: ${[...new Set(rows.map((row) => row.solid))].join(" | ")}`}`);
  report[c.id] = { title: c.title, rows };
}
console.log(`\nThe solid each case leaves (fingerprint, triangles, mesh in order, triangles in any order, faces and edges in their numbering):\n${solids.join("\n")}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
rmSync(workspace, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
