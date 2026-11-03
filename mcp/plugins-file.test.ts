/**
 * The plugin file (docs/plan-recipe-plugins.md D6–D7): front matter, the body's hash, the library folder, older
 * versions kept, removal, the API check, and the one-line parameter summary. No lust needed.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pluginFileText } from "../src/plugin-file.ts";
import { apiRefusal, bodyHash, listLibrary, oneLine, paramSummary, parsePlugin, pluginAuthor, pluginText, queryScore, readPlugin, removePlugin, slugOf, writePlugin, type PluginHeader } from "./plugins.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const body = "use lime_recipe::{ops, Session};\n\nfn main() {\n    let mut s = Session::start();\n    let p = s.solid_new(ops::cuboid(10.0, 10.0, 10.0)).unwrap();\n    s.done(&p);\n}\n";
const header = (version: number, text = body): PluginHeader => ({
  plugin: "bolt-circle-flange",
  title: "Bolt-circle flange",
  version,
  description: "A round flange with bolt holes on a circle.",
  author: "unknown",
  "made-by": "claude-code",
  api: "1.1",
  "source-sha256": bodyHash(text),
  created: "2026-11-02",
  target: "new",
  params: [{ name: "diameter", kind: "number", default: 80, min: 20, max: 250, unit: "mm" }, { name: "holes", kind: "count", default: 6, min: 3, max: 24 }, { name: "bore", kind: "toggle", default: true }],
});

check("a title becomes an id", slugOf("Bolt-circle Flange (M6)!") === "bolt-circle-flange-m6" && slugOf("   ") === "");
check("plugin text is one line, capped", oneLine("a\nb\u0007  c", 4) === "a b ");

const text = pluginText(header(1), body);
check("the file starts with the front matter and is the recipe after it", text.startsWith("//! ---\n//! plugin: bolt-circle-flange\n") && text.endsWith(body), text.slice(0, 200));
const parsed = parsePlugin(text.replace(/\n/g, "\r\n"));
check("a CRLF copy reads back with the same hash", !("reason" in parsed) && parsed.matches && parsed.header.version === 1 && parsed.header.params.length === 3 && parsed.body === body, parsed);
const edited = parsePlugin(text.replace("10.0, 10.0, 10.0", "12.0, 10.0, 10.0"));
check("an edited body no longer matches its hash", !("reason" in edited) && !edited.matches);
const described = parsePlugin(text.replace("A round flange", "A flange"));
check("an edited description keeps the hash", !("reason" in described) && described.matches);
check("a file without front matter is refused", "reason" in parsePlugin(body));
check("an id that is not a slug is refused", "reason" in parsePlugin(text.replace("plugin: bolt-circle-flange", "plugin: Bolt Flange")));

check("the parameters on one line", paramSummary(header(1).params) === "diameter mm 80 [20-250], holes 6 [3-24], bore true", paramSummary(header(1).params));
check("a newer API is refused without a build", /needs recipe API 1\.2; this Lime Slice has 1\.1/.test(apiRefusal("1.2", [1, 1]) ?? "") && /needs recipe API 9\.0/.test(apiRefusal("9.0", [1, 1]) ?? ""));
check("the same or an older minor builds", apiRefusal("1.0", [1, 1]) === null && apiRefusal("1.1", [1, 1]) === null);
check("a query matches words of the title", queryScore({ plugin: "bolt-circle-flange", title: "Bolt-circle flange", description: "holes" }, "flange bolt") === 2 && queryScore({ plugin: "x", title: "y", description: "z" }, "flange") === 0);

const dir = mkdtempSync(join(tmpdir(), "lime-plugins-"));
writePlugin(header(1), body, dir);
check("the library holds <plugin>.rs", existsSync(join(dir, "bolt-circle-flange.rs")) && listLibrary(dir).length === 1);
const v2 = body.replace("10.0, 10.0, 10.0", "11.0, 10.0, 10.0");
writePlugin(header(2, v2), v2, dir);
check("a new version keeps the old one as .v1.rs", existsSync(join(dir, "bolt-circle-flange.v1.rs")) && (readPlugin("bolt-circle-flange", dir) as { header: PluginHeader }).header.version === 2);
check("an older version reads back by number", (readPlugin("bolt-circle-flange", dir, 1) as { body: string }).body === body);
check("the list shows current versions only", listLibrary(dir).length === 1);
for (let v = 3; v <= 9; v += 1) {
  const b = body.replace("10.0, 10.0, 10.0", `${v}.0, 10.0, 10.0`);
  writePlugin(header(v, b), b, dir);
}
const kept = readdirSync(dir).filter((n) => /\.v\d+\.rs$/.test(n)).sort();
check("at most five older versions stay", kept.length === 5 && kept.includes("bolt-circle-flange.v8.rs") && !kept.includes("bolt-circle-flange.v1.rs"), kept);
check("no temporary file is left", readdirSync(dir).every((n) => !n.endsWith(".tmp")));
writeFileSync(join(dir, "notes.txt"), "not a plugin");
writeFileSync(join(dir, "broken.rs"), "fn main() {}\n");
check("other files and broken plugins are not listed", listLibrary(dir).map((p) => p.header.plugin).join() === "bolt-circle-flange");
check("remove takes the plugin and its older versions", removePlugin("bolt-circle-flange", dir) === 6 && !readdirSync(dir).some((n) => n.startsWith("bolt-circle-flange")) && readFileSync(join(dir, "notes.txt"), "utf8") === "not a plugin");

// The app's Save as plugin… writes the same bytes as the MCP server (src/plugin-file.ts `pluginFileText`).
const h = header(3);
const appText = pluginFileText({ plugin: h.plugin, title: h.title, version: h.version, description: h.description, author: h.author, madeBy: h["made-by"], api: h.api, sha256: h["source-sha256"], created: h.created, target: h.target, params: h.params }, `\n\n${body}`);
check("the app writes a plugin file byte for byte as the server does", appText === pluginText(h, `\n\n${body}`));

// The "Plugin author" setting: the app writes settings.json in the library; LIME_PLUGIN_AUTHOR still wins when set.
const named = process.env.LIME_PLUGIN_AUTHOR;
delete process.env.LIME_PLUGIN_AUTHOR;
check("no setting is unknown", pluginAuthor(dir) === "unknown");
writeFileSync(join(dir, "settings.json"), JSON.stringify({ author: "  Marius\tC.  " }));
check("the app's setting is the author, on one line", pluginAuthor(dir) === "Marius C.", pluginAuthor(dir));
process.env.LIME_PLUGIN_AUTHOR = "CI";
check("LIME_PLUGIN_AUTHOR overrides the setting", pluginAuthor(dir) === "CI");
writeFileSync(join(dir, "settings.json"), "not json");
delete process.env.LIME_PLUGIN_AUTHOR;
check("a damaged settings file is unknown", pluginAuthor(dir) === "unknown");
if (named !== undefined) process.env.LIME_PLUGIN_AUTHOR = named;

if (failed > 0) {
  console.error(`plugins-file: ${failed} failed`);
  process.exit(1);
}
console.log("plugins-file: all passed");
