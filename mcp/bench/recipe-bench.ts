/**
 * The recipe bench: three real plugins, run on the real engine, with where each run's time went.
 *
 *   node --experimental-strip-types --no-warnings mcp/bench/recipe-bench.ts [--runs 3] [--only gears,web,moon] [--json out.json]
 *
 * Each case runs `recipe_run {profile: true}` the usual way and again with `meshAtEnd: true`, `--runs` times each
 * (default 3, run alternately so a busy machine moves both alike), and prints the profile's split (docs/plan-native-recipes.md
 * milestone 2) as a table with the range of the run time, and says whether the two ways ended with the same solid (the
 * kernel's fingerprint, and a hash of the mesh).
 *
 * tcc against lust's optimised build (mcp/recipe-opt.ts): run it once with LIME_LUST_OPT=0 and once with
 * LIME_LUST_OPT=now and LIME_ZIG set (every build `--opt`; the first build of each case is the optimised compile).
 *
 * It needs what the recipe tests need, and exits 2 saying what is missing otherwise:
 *   - lust (LIME_LUST, or on PATH): the pinned build, `tools/lust/LUST_REV`.
 *   - the real engine and the Open CASCADE bridge: LIME_MCP_ENGINE (the library, else target/release), LIME_OCCT_BRIDGE
 *     (else beside the engine), with the Open CASCADE DLLs on PATH (Windows) or LD_LIBRARY_PATH.
 *
 * The plugins are copies of the owner's: `gears-on-sphere.rs` (with its two ingredients in `ingredients/`),
 * `spiderweb-cut-on-a-part.rs` and `moon-crater-field.rs` (saved plugins that carry their ingredients). They hold no
 * personal data and no part of anyone's. The bench copies them into a temporary library, so nothing outside the
 * repository is read or written. It is not a CI job: it is for the machine of whoever changes how recipes run.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = join(root, "mcp", "fixtures", "bench");

function arg(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const runs = Math.max(1, Number(arg("runs", "3")));
const only = (arg("only") ?? "gears,web,moon").split(",");
const jsonOut = arg("json");

// A library of its own: the plugins and ingredients the cases name, and a workspace for the session.
const library = mkdtempSync(join(tmpdir(), "lime-bench-lib-"));
mkdirSync(join(library, "ingredients"));
for (const name of ["moon-crater-field.rs", "spiderweb-cut-on-a-part.rs"]) copyFileSync(join(here, name), join(library, name));
for (const name of ["involute-gears.rs", "op-builders.rs"]) copyFileSync(join(here, "ingredients", name), join(library, "ingredients", name));
process.env.LIME_PLUGINS_DIR = library;
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-bench-ws-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = "300";

const { findLust } = await import("../recipe.ts");
const { loadEngineWorker } = await import("../engine.ts");
const { Session } = await import("../session.ts");

function missing(what: string): never {
  console.error(`The recipe bench needs ${what}.`);
  process.exit(2);
}
if (!findLust()) missing("lust (set LIME_LUST to the pinned build, tools/lust/LUST_REV)");
let engine;
try {
  engine = loadEngineWorker(root);
} catch (err) {
  missing(`the real engine (${err instanceof Error ? err.message : String(err)})`);
}
if ((await engine.occt()) !== true) missing("the Open CASCADE bridge (LIME_OCCT_BRIDGE, and its DLLs on PATH)");
const session = new Session(engine);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
const call = (name: string, args: unknown = {}) => session.call(name, args) as Promise<Reply>;

interface Case {
  id: string;
  title: string;
  /** Makes the part the recipe works on and returns the recipe_run input beside it. */
  setup(): Promise<{ object: string; input: Record<string, unknown> }>;
}

const cases: Case[] = [
  {
    id: "gears",
    title: "Gears on a sphere (9 gears, 27 applies)",
    async setup() {
      const made = await call("solid_new", { primitive: "sphere", radius: 60 });
      const object = String(made.object);
      const face = (await call("faces_find", { object, kind: "sphere" })).faces?.[0];
      return { object, input: { source: readFileSync(join(here, "gears-on-sphere.rs"), "utf8"), name: "bench-gears", object, params: { centreZ: face?.axisPoint?.[2] ?? 60 } } };
    },
  },
  {
    id: "web",
    title: "Spiderweb cut on a 100 x 80 x 10 plate",
    async setup() {
      const made = await call("solid_new", { primitive: "box", dx: 100, dy: 80, dz: 10 });
      const object = String(made.object);
      return { object, input: { plugin: "spiderweb-cut-on-a-part", object } };
    },
  },
  {
    id: "moon",
    title: "Moon crater field (10 craters on a sphere)",
    async setup() {
      const made = await call("solid_new", { primitive: "sphere", radius: 60 });
      const object = String(made.object);
      return { object, input: { plugin: "moon-crater-field", object } };
    },
  },
];

interface Result {
  runMs: number;
  buildMs: number;
  calls: number;
  split: Record<string, number>;
  meshAtEndMs: number;
  solid: string;
}

async function once(c: Case, meshAtEnd: boolean): Promise<Result> {
  const { object, input } = await c.setup();
  const reply = await call("recipe_run", { ...input, profile: true, timeoutS: 300, ...(meshAtEnd ? { meshAtEnd: true } : {}) });
  if (reply.ok === false) {
    console.error(`${c.id}${meshAtEnd ? " (meshAtEnd)" : ""} failed: ${JSON.stringify(reply).slice(0, 800)}`);
    process.exit(1);
  }
  const solid = (session as unknown as { find(id: string): { solid?: { positions: Float32Array; fingerprint: unknown } } | undefined }).find(object)?.solid;
  const mesh = solid ? createHash("sha256").update(Buffer.from(solid.positions.buffer, solid.positions.byteOffset, solid.positions.byteLength)).digest("hex").slice(0, 12) : "none";
  const result: Result = {
    runMs: Number(reply.runMs),
    buildMs: Number(reply.buildMs),
    calls: Number(reply.calls),
    split: reply.profile?.split ?? {},
    meshAtEndMs: Number(reply.profile?.meshAtEnd?.ms ?? 0),
    solid: `${JSON.stringify(solid?.fingerprint ?? null)} mesh ${mesh}`,
  };
  for (const id of new Set([object, ...(Array.isArray(reply.created) ? reply.created : [])])) await call("object_remove", { object: id });
  return result;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const range = (values: number[]) => (values.length > 1 ? `${(Math.min(...values) / 1000).toFixed(2)} to ${(Math.max(...values) / 1000).toFixed(2)} s` : `${(values[0]! / 1000).toFixed(2)} s`);
const seconds = (ms: number) => (ms / 1000).toFixed(2);

const report: Record<string, unknown> = {};
for (const c of cases.filter((row) => only.includes(row.id))) {
  console.log(`\n${c.title}`);
  const off: Result[] = [];
  const on: Result[] = [];
  for (let i = 0; i < runs; i += 1) {
    off.push(await once(c, false));
    on.push(await once(c, true));
  }
  const first = off[0]!;
  const keys = ["recipeMs", "hostMs", "engineHopMs", "kernelBooleanMs", "kernelMeshMs", "kernelOtherMs"];
  const cells = (rows: Result[]) => keys.map((key) => seconds(median(rows.map((row) => row.split[key] ?? 0))));
  console.log(`| mesh | calls | run (range) | ${keys.join(" | ")} |`);
  console.log(`|---|---:|---:|${keys.map(() => "---:").join("|")}|`);
  console.log(`| every step | ${first.calls} | ${range(off.map((row) => row.runMs))} | ${cells(off).join(" | ")} |`);
  console.log(`| at the end | ${on[0]!.calls} | ${range(on.map((row) => row.runMs))} | ${cells(on).join(" | ")} |`);
  const gain = 1 - median(on.map((row) => row.runMs + row.meshAtEndMs)) / median(off.map((row) => row.runMs));
  const same = new Set([...off, ...on].map((row) => row.solid)).size === 1;
  console.log(`run plus the final mesh, at the end against every step: ${(gain * 100).toFixed(1)} % ${gain >= 0 ? "faster" : "slower"}; final mesh ${seconds(median(on.map((row) => row.meshAtEndMs)))} s; build ${seconds(median(off.map((row) => row.buildMs)))} s; same solid and mesh both ways: ${same ? "yes" : `NO (${[...new Set([...off, ...on].map((row) => row.solid))].join(" | ")})`}`);
  report[c.id] = { off, on, gain, same };
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
process.exit(0);
