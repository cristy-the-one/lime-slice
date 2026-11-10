/**
 * recipe_run {query}: lust's answer about one position of a recipe (`lust query type|def`, lust 0.3.0), with real
 * lust. The type of an expression and where a name is defined, at a line and column of the recipe as the caller wrote
 * it; a definition in an ingredient or in lime-recipe is named as such, with its line there; a recipe with a type error
 * in another fn is still answered; a query runs nothing and leaves the slot's built program in place.
 * Skips without lust, or with one that has no `query`; LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// A library of its own, with the bench's two ingredients, and a workspace.
const library = mkdtempSync(join(tmpdir(), "lime-query-lib-"));
mkdirSync(join(library, "ingredients"));
for (const name of ["involute-gears.rs", "op-builders.rs"]) copyFileSync(join(root, "mcp", "fixtures", "bench", "ingredients", name), join(library, "ingredients", name));
process.env.LIME_PLUGINS_DIR = library;
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-query-ws-"));

const { findLust, lustFeatures, RecipeHost } = await import("./recipe.ts");
const { optMode, zigFor } = await import("./recipe-opt.ts");
const { fakeEngine } = await import("./engine.ts");
const { Session } = await import("./session.ts");

const lust = findLust();
if (!lust || !lustFeatures(lust).query) {
  const missing = !lust ? "lust (LIME_LUST)" : "a lust with `lust query` (0.3.0)";
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error(`recipe-query: ${missing} is required here`);
    process.exit(1);
  }
  console.log(`recipe-query: skipped (needs ${missing})`);
  process.exit(0);
}

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

type R = Record<string, unknown>;

// Line and column numbers matter below: keep the recipe's lines as they are. Line 13 is indented with a tab, and
// line 16 has text outside ASCII before the name asked about: a column is a byte column, as in diagnostics.
const RECIPE = `use lime_recipe::{ops, Json, Session};
use ingredients::op_builders::*;

fn doubled(s: &mut Session, width: f64) -> f64 {
    let twice = width * 2.0;
    s.log(&format!("{twice}"));
    twice
}

fn main() {
    let mut s = Session::start();
    let width = s.param_f64("width", 60.0);
\tlet part = s.solid_new(ops::cuboid(width, 20.0, 4.0));
    let w2 = doubled(&mut s, width);
    let tool = box_at("cut", [0.0, 0.0, 0.0], [4.0, 4.0, 20.0]);
    s.log("é 日本"); let meta = Json::obj().set("w", w2);
    s.log(&format!("{meta} {tool} {}", part.is_ok()));
}
`;

const session = new Session(fakeEngine());
const ask = (query: string, extra: R = {}) => session.call("recipe_run", { source: RECIPE, name: "asked", query, ...extra }) as Promise<R>;

// --- The type of an expression.
{
  const part = await ask("type 13:6");
  check("the type of a binding", part.ok === true && part.type === "Result<lime_recipe::Part, lime_recipe::Refusal>" && part.of === "part", part);
  const call = await ask("type 14:9");
  check("the type a call gave its binding, with the text lust took", call.type === "f64" && call.of === "w2", call);
  const meta = await ask("type 16:29");
  check("a byte column after text outside ASCII", meta.type === "lime_recipe::Json" && meta.of === "meta", meta);
  check("a type answer is small", Buffer.byteLength(JSON.stringify(part)) < 160, JSON.stringify(part));
  check("nothing ran and nothing was built", session.objects.length === 0 && part.buildMs === undefined && part.calls === undefined, part);
  // lust 0.3.0's query leaves a program named `main` in the folder it runs in: never the server's own folder.
  check("a query leaves no file in the server's folder", !existsSync(join(process.cwd(), "main.exe")) && !existsSync(join(process.cwd(), "main")), process.cwd());
}

// --- Where a name is defined: in the recipe, in an ingredient, in lime-recipe.
{
  const local = await ask("def 14:30");
  check("a local, by its line in the recipe", local.ok === true && JSON.stringify(local.def) === JSON.stringify({ of: "local", line: 12, col: 9, text: 'let width = s.param_f64("width", 60.0);' }), local);
  const own = await ask("def 14:14");
  check("a fn of the recipe", JSON.stringify(own.def) === JSON.stringify({ of: "fn", line: 4, col: 4, text: "fn doubled(s: &mut Session, width: f64) -> f64 {" }), own);
  const ingredient = (await ask("def 15:16")).def as R | undefined;
  check("a fn of an ingredient, by its line there", ingredient?.of === "fn" && ingredient.ingredient === "op-builders v1" && String(ingredient.text).startsWith("pub fn box_at(op: &str, o: V3, d: V3) -> Json") && Number(ingredient.line) > 0, ingredient);
  const crate = (await ask("def 13:17")).def as R | undefined;
  check("a method of lime-recipe, with its signature", crate?.of === "method" && crate.in === "lime-recipe" && crate.text === "pub fn solid_new(&mut self, primitive: Json) -> Result<Part, Refusal> {" && Number(crate.line) > 1000, crate);
}

// --- What lust cannot answer, and what is not a query, in one sentence each.
{
  const outside = await ask("type 1:5");
  check("a position outside a fn body", outside.ok === false && outside.code === "recipe-query" && String(outside.reason).includes("not inside a fn body"), outside);
  const none = await ask("def 12:39");
  check("no definition at the position", none.ok === false && none.code === "recipe-query", none);
  const past = await ask("type 40:1");
  check("a line past the recipe", past.ok === false && past.code === "recipe-query" && String(past.reason).includes("18 lines"), past);
  const malformed = await ask("typeof 13:6");
  check("a query that is not one", malformed.ok === false && malformed.code === "bad-argument" && String(malformed.reason).includes('"type 12:9"'), malformed);
  const applied = await ask("type 13:6", { mode: "apply" });
  check("a query with a run asked for is refused", applied.ok === false && applied.code === "conflicting-arguments", applied);
}

// --- A recipe with a type error in another fn is still answered, where a build only has the error to give.
{
  const broken = RECIPE.replace("let twice = width * 2.0;", 'let twice: f64 = "two";');
  const built = (await session.call("recipe_run", { source: broken, name: "asked", mode: "check", autofix: false })) as R;
  check("the broken recipe does not build", built.ok === false && built.code === "recipe-compile", built);
  const still = (await session.call("recipe_run", { source: broken, name: "asked", query: "type 13:6" })) as R;
  check("its other fn is still answered", still.ok === true && still.type === "Result<lime_recipe::Part, lime_recipe::Refusal>", still);
}

// --- A query leaves the slot's program as it was: the same text is not built again after one.
{
  const crate = join(root, "crates", "lime-recipe");
  const host = new RecipeHost({ crateDir: crate });
  const plain = RECIPE.replace("use ingredients::op_builders::*;\n", "").replace('let tool = box_at("cut", [0.0, 0.0, 0.0], [4.0, 4.0, 20.0]);', "let tool = 1;");
  const built = await host.build("kept", plain, false);
  check("the recipe builds", built.ok, built.diagnostics);
  const made = statSync(built.exe!).mtimeMs;
  const began = performance.now();
  const answer = await host.query("kept", plain, "type", 12, 6);
  const took = performance.now() - began;
  check("the host answers a type", answer.ok === true && answer.kind === "type" && answer.type === "Result<lime_recipe::Part, lime_recipe::Refusal>", answer);
  const edited = await host.query("kept", plain.replace("width * 2.0", "width * 3.0"), "def", 13, 14);
  check("and a definition in an edited text", edited.ok === true && edited.kind === "def" && edited.line === 3, edited);
  const again = await host.build("kept", plain, false);
  // While lust's background build (`--opt=bg`) may still swap in the optimised program, the host asks lust at every
  // build, with or without a query before it (mcp/recipe.ts): only then is the file written again.
  const asksEachTime = optMode() === "bg" && zigFor(lust) !== null;
  check("the program built before the queries is still the slot's", again.ok && again.exe === built.exe && (asksEachTime || statSync(again.exe!).mtimeMs === made), { made, now: statSync(again.exe!).mtimeMs });
  console.log(`recipe-query: the first query of this host took ${Math.round(took)} ms`);
  const older = new RecipeHost({ crateDir: crate, features: { query: false } });
  const refused = await older.query("kept", plain, "type", 12, 6);
  check("a lust without the command says so", refused.ok === false && refused.reason.includes("0.3.0"), refused);
}

if (failed > 0) {
  console.error(`recipe-query: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-query: all passed");
