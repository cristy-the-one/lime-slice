/**
 * Rule zero through the real engine: a plugin sends the same calls, byte for byte, with the engine's native geometry
 * helper on and off. With it on, each geom2d boolean goes to the engine as `{call: "nativeGeometry", args}` and the
 * engine reads that request with serde_json. Before serde_json's `float_roundtrip` was on, about one number in eight
 * was read one unit off in the last place (11.005321081608713 as …711), and the plugin's cut loops changed
 * (docs/plan-native-recipes.md, section 2.6). recipe-geom2d.test.ts compares lust with rustc and calls the crate
 * directly; this one goes through the release engine's modelTree as the MCP session does. Skips without lust or a
 * built engine; LIME_RECIPE_REQUIRED=1 (the CI jobs that build both) makes that a failure.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadNativeEngine } from "./engine.ts";
import { findLust, RecipeHost, type RecipeCallSite, type RecipeReply } from "./recipe.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const required = process.env.LIME_RECIPE_REQUIRED === "1";
const lust = findLust();
// Only a checkout's own build: an installed engine is another release.
const built = engineCandidates(root).filter((path) => existsSync(path) && !path.startsWith(fileURLToPath(new URL(".", import.meta.url))));
if (!lust || built.length === 0) {
  const missing = !lust ? "lust (LIME_LUST)" : "a built engine (cargo build --release -p lime-mcp-engine)";
  if (required) {
    console.error(`recipe-native-bytes: ${missing} is required here`);
    process.exit(1);
  }
  console.log(`recipe-native-bytes: skipped (needs ${missing})`);
  process.exit(0);
}
if (!process.env.LIME_MCP_ENGINE) process.env.LIME_MCP_ENGINE = built[0];
const engine = loadNativeEngine(root);

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

// A web of rings and spokes, unioned and cut from a disc, then each piece cut from the part: the plugin's cut loops
// are the native booleans' answers, so a number the engine reads wrongly shows in the calls.
const SOURCE = `use lime_recipe::{Session, Json, ops};
use lime_recipe::geom2d::{circle, rect, Region};
fn main() {
    let mut s = Session::start();
    let part = s.solid_new(ops::cuboid(120.0, 120.0, 4.0)).unwrap();
    let disc = Region::from_poly(&circle(52.0, 96));
    let mut web = Region::from_poly(&circle(6.5, 40));
    for k in 0..9 {
        let a = k as f64 * 40.0 + 7.3;
        web = web.union(&Region::from_poly(&rect(1.7, 48.0).translate(0.0, 24.0).rotate(a, [0.0, 0.0])));
    }
    for r in [17.3, 29.1, 41.7] {
        let ring = Region::from_poly(&circle(r + 0.85, 72)).difference(&Region::from_poly(&circle(r - 0.85, 72)));
        web = web.union(&ring);
    }
    let cells = disc.difference(&web);
    let mut n = 0;
    for piece in cells.to_loops() {
        let op = Json::obj().set("kind", "extrude").set("op", "cut").set("origin", [0.0, 0.0, 2.0]).set("turn", [0.0, 0.0, 0.0]).set("depth", -1.2).set("loops", piece);
        s.apply(&part, op).unwrap();
        n += 1;
    }
    s.done_with(&part, Json::obj().set("cells", n).set("area", cells.area()));
}
`;

function kernel(log: RecipeCallSite[]) {
  return async (site: RecipeCallSite): Promise<RecipeReply> => {
    log.push(site);
    if (site.tool === "solid_new") return { ok: true, result: { ok: true, object: "obj_1" } };
    return { ok: true, result: { ok: true, volumeMm3: 1000 } };
  };
}

const dir = mkdtempSync(join(tmpdir(), "lime-recipe-native-bytes-"));
const host = new RecipeHost({ crateDir: join(root, "crates", "lime-recipe"), root: join(dir, "host"), lust });
const build = await host.build("native_bytes", SOURCE, false);
check("lust builds the plugin", build.ok, build.diagnostics.length ? build.diagnostics : build.reason);
if (build.ok) {
  const off: RecipeCallSite[] = [];
  const offRun = await host.run(build.exe!, { params: {}, context: { units: "mm" } }, kernel(off));
  const on: RecipeCallSite[] = [];
  const answered: string[] = [];
  const rest = kernel(on);
  const onRun = await host.run(build.exe!, { params: {}, context: { units: "mm", nativeGeometry: true } }, async (site) => {
    if (site.tool !== "native_geometry") return rest(site);
    // As mcp/session/recipe.ts answers it.
    const result = JSON.parse(await engine.modelTree(JSON.stringify({ call: "nativeGeometry", args: site.args }))) as unknown;
    if (!Array.isArray(result)) return { ok: false, error: "Native geometry is unavailable." };
    answered.push(String(site.args.op));
    return { ok: true, result };
  });
  check("both runs reach done", offRun.ok && onRun.ok, { off: offRun.reason ?? offRun.stderr, on: onRun.reason ?? onRun.stderr });
  check("the engine answered the booleans", answered.filter((op) => op === "resolve").length >= 5, answered);
  const a = off.map((c) => JSON.stringify([c.tool, c.args, c.line]));
  const b = on.map((c) => JSON.stringify([c.tool, c.args, c.line]));
  const first = a.findIndex((t, i) => t !== b[i]);
  const bytes = a.join("\n").length;
  /** The first number that differs between two call texts, with its neighbour. */
  const firstNumber = (x: string, y: string) => {
    const nx = x.match(/-?\d+(\.\d+)?(e[-+]?\d+)?/g) ?? [];
    const ny = y.match(/-?\d+(\.\d+)?(e[-+]?\d+)?/g) ?? [];
    const at = nx.findIndex((n, i) => n !== ny[i]);
    return at < 0 ? null : { off: nx[at], on: ny[at] };
  };
  check(`${a.length} calls (${bytes} bytes), the same with native geometry on and off`, a.length === b.length && first < 0 && a.length > 20, first >= 0 ? { call: first + 1, tool: off[first]?.tool, number: firstNumber(a[first] ?? "", b[first] ?? "") } : a.length);
  check("the same metrics", JSON.stringify(offRun.done?.metrics) === JSON.stringify(onRun.done?.metrics), { off: offRun.done?.metrics, on: onRun.done?.metrics });
  console.log(`     engine ${engine.path}: ${answered.length} native answers, off ${offRun.ms} ms, on ${onRun.ms} ms`);
}

if (failed > 0) {
  console.error(`recipe-native-bytes: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-native-bytes: ok");
