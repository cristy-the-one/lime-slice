/** Reproduce a recipe rerun followed by a placement of another assembly member. */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { findLust } from "./recipe.ts";
import { Session } from "./session.ts";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
if (!process.env.LIME_OCCT_BRIDGE || !existsSync(process.env.LIME_OCCT_BRIDGE) || !engineCandidates(rootDir).some(existsSync) || !findLust()) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") throw new Error("recipe assembly rerun needs LIME_OCCT_BRIDGE, lime-mcp-engine, and LIME_LUST");
  console.log("recipe assembly rerun: skipped (needs lust and native engine)");
  process.exit(0);
}
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-recipe-assembly-"));
const session = new Session(loadEngineWorker(rootDir));
const source = `
use lime_recipe::{ops, Json, Session};
fn main() {
    let mut s = Session::start();
    let height = s.param_f64("height", 10.0);
    let root = s.solid_new(ops::cuboid(4.0, 4.0, 4.0)).unwrap();
    let cap = s.solid_new(ops::cuboid(2.0, 2.0, 2.0)).unwrap();
    s.call("model_place", Json::obj().set("object", cap.object.as_str()).set("z", height)).unwrap();
    let other = s.solid_new(ops::cuboid(2.0, 2.0, 2.0)).unwrap();
    s.done(&root);
}
`;
const first = await session.call("recipe_run", { source, name: "assembly-rerun" });
if (first.ok !== true || !Array.isArray(first.created) || first.created.length !== 3) throw new Error(`initial recipe failed: ${JSON.stringify(first)}`);
const [root, cap, other] = first.created as string[];
for (const object of [cap!, other!]) {
  const joined = await session.call("model_place", { object, to: root });
  if (joined.ok !== true) throw new Error(`join failed: ${JSON.stringify(joined)}`);
}
const childMade = await session.call("solid_new", { primitive: "box", dx: 1, dy: 1, dz: 1 });
const child = String(childMade.object);
const childJoined = await session.call("model_place", { object: child, to: cap });
if (childJoined.ok !== true) throw new Error(`child join failed: ${JSON.stringify(childJoined)}`);
const rerun = await session.call("recipe_run", { object: root, params: { height: 20 } });
if (rerun.ok !== true || session.find(cap!)?.modelPose.t[2] !== 20) throw new Error(`rerun failed: ${JSON.stringify(rerun)}`);
const moved = await session.call("model_place", { object: other, x: 3 });
if (moved.ok !== true || session.find(cap!)?.modelPose.t[2] !== 20 || session.find(child)?.modelPose.t[2] !== 0) throw new Error(`unrelated member moved after placement: ${JSON.stringify(moved)}; cap z=${session.find(cap!)?.modelPose.t[2]}, child z=${session.find(child)?.modelPose.t[2]}`);
console.log("recipe assembly rerun: ok");
process.exit(0);
