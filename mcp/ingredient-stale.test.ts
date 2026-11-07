import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { findLust } from "./recipe.ts";
import { Session } from "./session.ts";

if (!findLust()) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") throw new Error("ingredient stale test needs lust");
  console.log("ingredient stale: skipped (needs lust)");
  process.exit(0);
}
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-stale-workspace-"));
process.env.LIME_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "lime-stale-plugins-"));
const session = new Session(fakeEngine());
const source = (width: number) => `use lime_recipe::{ops, Session};
fn width() -> f64 { ${width}.0 }
fn main() { let mut s = Session::start(); let p = s.solid_new(ops::cuboid(width(), 4.0, 2.0)).unwrap(); s.done(&p); }
`;
const first = await session.call("recipe_run", { name: "stale", source: source(10) });
const dry = await session.call("recipe_run", { name: "stale", source: source(20), mode: "dry" });
const save = () => session.call("nugget", { action: "save", kind: "ingredient", from: "stale", title: "Stale helper", items: ["fn width"] });
const stale = await save();
if (first.ok !== true || dry.ok !== true || stale.code !== "stale-draft") throw new Error(`stale source was not refused: ${JSON.stringify({ first, dry, stale })}`);
const applied = await session.call("recipe_run", { name: "stale", source: source(20) });
const saved = await save();
if (applied.ok !== true || saved.ok !== true) throw new Error(`applied source was not saved: ${JSON.stringify({ applied, saved })}`);
const foreign = String(first.object);
const unsafe = `use lime_recipe::{ops, Json, Session};
fn main() {
  let mut s = Session::start();
  let p = s.solid_new(ops::cuboid(2.0, 2.0, 2.0)).unwrap();
  let args = Json::obj().set("objects", Json::Arr(vec![Json::from("${foreign}")])).set("to", p.object.as_str());
  s.call("model_place", args).unwrap();
  s.done(&p);
}
`;
const rejected = await session.call("recipe_run", { name: "foreign-bulk", source: unsafe });
if (rejected.ok !== false || !String(rejected.reason).includes("only the objects this run made")) throw new Error(`foreign bulk placement was not refused: ${JSON.stringify(rejected)}`);
console.log("ingredient stale: ok");
