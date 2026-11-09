/**
 * Read-only extra libraries (LIME_PLUGINS_EXTRA): a plugin and an ingredient that live in another folder are found by
 * nugget find and plugin list, shown by plugin get and nugget get, and run by recipe_run {plugin} without being copied.
 * The own library wins a clash. Listing, finding and showing need no lust; the run part skips without it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { bodyHash, pluginText, type PluginHeader } from "./plugins.ts";
import { findLust } from "./recipe.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-extra-ws-"));
const own = mkdtempSync(join(tmpdir(), "lime-extra-own-"));
const shared = mkdtempSync(join(tmpdir(), "lime-extra-shared-"));
const empty = mkdtempSync(join(tmpdir(), "lime-extra-empty-"));
process.env.LIME_PLUGINS_DIR = own;
process.env.LIME_PLUGINS_EXTRA = [shared, join(empty, "missing")].join(delimiter);

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

const body = (size: number) => [
  "use lime_recipe::{ops, Json, Session};",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  `    let p = s.solid_new(ops::cuboid(${size}.0, 10.0, 4.0)).unwrap();`,
  '    s.done_with(&p, Json::obj());',
  "}",
  "",
].join("\n");
const framed = (id: string, title: string, text: string, kind?: "ingredient") => {
  const header: PluginHeader = { plugin: id, ...(kind ? { kind } : {}), title, version: 1, description: `${title} for the extra-library test`, author: "tester", api: "1.0", "source-sha256": bodyHash(text), created: "", target: "new", params: [] };
  return pluginText(header, text);
};

// A shared workspace folder: a plain library file, a shared `.lime-plugin.rs` file, and an ingredient.
writeFileSync(join(shared, "gear-wheel.rs"), framed("gear-wheel", "Involute gear wheel", body(30)));
writeFileSync(join(shared, "tray-v2.lime-plugin.rs"), framed("tray", "Shared tray", body(40)));
writeFileSync(join(shared, "clash.rs"), framed("clash", "Clash from shared", body(50)));
mkdirSync(join(shared, "ingredients"));
writeFileSync(join(shared, "ingredients", "grid-bits.rs"), framed("grid-bits", "Grid bits", "pub fn pitch() -> f64 {\n    4.0\n}\n", "ingredient"));
writeFileSync(join(own, "clash.rs"), framed("clash", "Clash in own", body(20)));

const { fakeEngine } = await import("./engine.ts");
const { Session } = await import("./session.ts");
const session = new Session(fakeEngine());
session.clientName = "plugin-extra-test";
const call = (name: string, args: unknown = {}) => session.call(name, args);

const listed = await call("plugin", { action: "list" });
const rows = (listed.plugins ?? []) as { id: string; library?: string; imported?: boolean; data: { title: string } }[];
const ids = rows.map((row) => row.id).sort();
check("plugin list shows the own and the shared plugins", JSON.stringify(ids) === JSON.stringify(["clash", "gear-wheel", "tray"]), ids);
check("a shared row names its library and is imported", rows.find((row) => row.id === "gear-wheel")?.library === shared && rows.find((row) => row.id === "gear-wheel")?.imported === true, rows);
check("an own row has no library", rows.find((row) => row.id === "clash")?.library === undefined && rows.find((row) => row.id === "clash")?.data.title === "Clash in own", rows);
check("the list says which libraries it also reads", JSON.stringify(listed.alsoReads) === JSON.stringify([shared]), listed);

const found = await call("nugget", { action: "find", query: "gear" });
const hit = ((found.nuggets ?? []) as { id: string; kind: string; library?: string }[]).find((row) => row.id === "gear-wheel");
check("nugget find sees a plugin of a shared folder", hit?.kind === "plugin" && hit.library === shared, found);
const ingredient = await call("nugget", { action: "find", kind: "ingredient", query: "grid" });
check("nugget find sees a shared ingredient", ((ingredient.nuggets ?? []) as { id: string; library?: string }[]).some((row) => row.id === "grid-bits" && row.library === shared), ingredient);

const got = await call("plugin", { action: "get", id: "gear-wheel" });
check("plugin get shows a shared plugin with its library", got.ok === true && got.library === shared && got.imported === true, got);
const gotIngredient = await call("nugget", { action: "get", kind: "ingredient", id: "grid-bits" });
check("nugget get shows a shared ingredient", gotIngredient.ok === true && gotIngredient.library === shared, gotIngredient);
const gotClash = await call("plugin", { action: "get", id: "clash" });
check("the own library wins a clash", gotClash.ok === true && (gotClash.data as { title: string }).title === "Clash in own" && gotClash.library === undefined, gotClash);
const gone = await call("plugin", { action: "get", id: "nothing-here" });
check("an unknown name lists the names of both libraries", gone.ok === false && String(gone.reason).includes("gear-wheel") && String(gone.reason).includes("clash"), gone);

const before = readdirSync(own).sort();
if (findLust()) {
  const ran = await call("recipe_run", { plugin: "gear-wheel" });
  check("recipe_run runs a shared plugin", ran.ok === true, ran);
  check("running it copies nothing into the own library", JSON.stringify(readdirSync(own).sort()) === JSON.stringify(before) && !existsSync(join(own, "gear-wheel.rs")), readdirSync(own));
  const note = JSON.stringify(ran);
  check("the run says it came from the shared library", note.includes("read-only"), note.slice(0, 600));
} else {
  console.log("plugin-extra: the run part is skipped (set LIME_LUST to a lust build)");
}

if (failed > 0) {
  console.error(`plugin-extra: ${failed} failed`);
  process.exit(1);
}
console.log("plugin-extra: ok");
