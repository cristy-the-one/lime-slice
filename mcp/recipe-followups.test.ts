/**
 * Recipe follow-ups from the review: a long auto fix comes back as a unified diff (fixedDiff) that applies to the
 * submitted source, and guide {topic:"recipes"} lists the kept ingredients by name. The diff and the listing run
 * with no lust; the session case runs with it (skips without LIME_LUST). The library is a temp dir, never the owner's.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-followups-ws-"));
const library = mkdtempSync(join(tmpdir(), "lime-followups-lib-"));
process.env.LIME_PLUGINS_DIR = library;

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 3000)}`);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const { applyUnifiedDiff, fixedReply, FIXED_DIFF_BYTES, FIXED_DIFF_LINES, unifiedDiff } = await import("./line-diff.ts");
const { GUIDE_INGREDIENTS_SHOWN, ingredientLines, ingredientsDir } = await import("./ingredients.ts");
const { bodyHash, writePlugin } = await import("./plugins.ts");
const { fakeEngine } = await import("./engine.ts");
const { findLust } = await import("./recipe.ts");
const { Session } = await import("./session.ts");

// --- The diff: standard hunks with line numbers that reproduce the fixed text.
const base = Array.from({ length: 100 }, (_, i) => `let line${i} = ${i};`);
const fix = (edit: (rows: string[]) => string[]) => `${edit([...base]).join("\n")}\n`;
const before = `${base.join("\n")}\n`;
{
  const after = fix((r) => { r[10] = "let line10: f64 = 10.0;"; r[70] = "let line70: f64 = 70.0;"; return r; });
  const diff = unifiedDiff(before, after)!;
  check("two far fixes are two hunks", (diff.match(/^@@ /gm) ?? []).length === 2, diff);
  check("a hunk header names old and new line numbers", diff.startsWith("@@ -8,7 +8,7 @@\n"), diff);
  check("the diff applies and reproduces the fixed text", applyUnifiedDiff(before, diff) === after);
  check("the diff is far shorter than the text", diff.length < after.length / 4);
}
{
  const after = fix((r) => { r.splice(30, 0, "let added = 1;", "let more = 2;"); r.splice(60, 3); return r; });
  const diff = unifiedDiff(before, after)!;
  check("inserted and removed lines apply", applyUnifiedDiff(before, diff) === after, diff);
  const atEnds = fix((r) => { r.unshift("// top"); r.push("// bottom"); return r; });
  check("a change at either end applies", applyUnifiedDiff(before, unifiedDiff(before, atEnds)!) === atEnds);
  check("equal texts have an empty diff", unifiedDiff(before, before) === "");
  check("a diff that does not match is not applied", applyUnifiedDiff(`${base.slice(1).join("\n")}\n`, unifiedDiff(before, after)!) === null);
}

// --- The threshold: short fixes keep fixedSource exactly; long ones are a diff, full:true is the text.
{
  const shortBefore = `${base.slice(0, FIXED_DIFF_LINES - 5).join("\n")}\n`;
  const shortAfter = shortBefore.replace("line3 = 3", "line3: f64 = 3.0");
  const r = fixedReply(shortBefore, shortAfter, 1, false);
  check("a fix under the threshold is fixedSource, as before", r.fixedSource === shortAfter && r.fixedDiff === undefined && r.fixRounds === 1, r);
  const edge = `${base.slice(0, FIXED_DIFF_LINES).join("\n")}\n`;
  check("exactly the line threshold stays whole", fixedReply(edge, edge.replace("line3 = 3", "line3: f64 = 3.0"), 1, false).fixedSource !== undefined);
  const over = `${base.slice(0, FIXED_DIFF_LINES + 1).join("\n")}\n`;
  check("one line over the threshold is a diff", fixedReply(over, over.replace("line3 = 3", "line3: f64 = 3.0"), 1, false).fixedDiff !== undefined);
  const wide = `// ${"x".repeat(FIXED_DIFF_BYTES)}\nlet a = 1;\n`;
  check("a long text in few lines is a diff by bytes", fixedReply(wide, wide.replace("a = 1", "a: f64 = 1.0"), 1, false).fixedDiff !== undefined);
  const long = fixedReply(before, before.replace("line3 = 3", "line3: f64 = 3.0"), 2, false);
  check("a long fix is fixedDiff and fixRounds, no fixedSource", typeof long.fixedDiff === "string" && long.fixedSource === undefined && long.fixRounds === 2, long);
  check("full:true gives the whole text", fixedReply(before, before.replace("line3 = 3", "line3: f64 = 3.0"), 2, true).fixedSource !== undefined);
}

// --- The guide's ingredient list: empty, a few, over the cap, unreadable.
const emptyLines = ingredientLines();
check("an empty library says so in one line", emptyLines.length === 1 && emptyLines[0]!.includes("none are kept"), emptyLines);
check("an unreadable library says so in one line", ingredientLines(join(library, "ingredients", "no\0such")).length === 1);
const dir = ingredientsDir();
const keep = (id: string, description: string) => writePlugin({ plugin: id, kind: "ingredient", title: id, version: 1, description, author: "unknown", api: "1.1", "source-sha256": bodyHash("pub fn a() {}\n"), created: "2026-11-06", target: "new", params: [] }, "pub fn a() {}\n", dir);
keep("honeycomb", "Hex cell centres for a floor.");
keep("tray-lip", "A lip around a tray.");
const some = ingredientLines();
check("a few are named with their summary", some[0]!.includes("(2") && some.includes("ingredients::honeycomb: Hex cell centres for a floor.") && some.includes("ingredients::tray_lip: A lip around a tray."), some);
check("no 'more' line under the cap", !some.some((l) => l.includes(" more:")));
const session = new Session(fakeEngine());
const g = await session.call("guide", { topic: "recipes", full: true });
check("guide recipes lists them after the unchanged text", g.ok === true && String(g.text).includes("ingredients::honeycomb: Hex cell") && String(g.text).startsWith("Before writing a recipe"), g);
const viaKind = await session.call("guide", { kind: "recipes" });
check("guide kind recipes answers the recipes index", viaKind.ok === true && Array.isArray(viaKind.sections) && JSON.stringify(viaKind) === JSON.stringify(await session.call("guide", { topic: "recipes" })));
for (let i = 0; i < GUIDE_INGREDIENTS_SHOWN + 5; i += 1) keep(`bulk-${String(i).padStart(2, "0")}`, `Bulk ${i}.`);
const many = ingredientLines();
check("over the cap: the cap many names, then the rest counted", many.filter((l) => l.startsWith("ingredients::")).length === GUIDE_INGREDIENTS_SHOWN && many[many.length - 1]!.startsWith(`${2 + GUIDE_INGREDIENTS_SHOWN + 5 - GUIDE_INGREDIENTS_SHOWN} more`), many);

// --- Through recipe_run with real lust: a long recipe with one fix comes back as a diff that applies.
if (!findLust()) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") { console.error("recipe-followups: lust is required here (LIME_LUST)"); process.exit(1); }
  console.log("recipe-followups: lust cases skipped (set LIME_LUST to a lust build)");
} else {
  const example = readFileSync(join(root, "crates", "lime-recipe", "examples", "mounting_bar.rs"), "utf8");
  const pad = Array.from({ length: 80 }, (_, i) => `// note ${i}`).join("\n");
  const broken = `${pad}\n${example.replace('let width = s.param_f64("width", 60.0);', "let width: f64 = 60;")}`;
  const r = await session.call("recipe_run", { source: broken, name: "longbar", mode: "check" });
  check("a long check builds after the fix", r.ok === true && r.built === true, r);
  check("the long fix is a diff, not the text", typeof r.fixedDiff === "string" && r.fixedSource === undefined, r);
  const applied = typeof r.fixedDiff === "string" ? applyUnifiedDiff(broken.replace(/\r\n/g, "\n"), r.fixedDiff) : null;
  check("the diff applies to the submitted source", applied !== null && applied.includes("let width: f64 = 60.0;"), applied ?? "");
  const full = await session.call("recipe_run", { source: broken, name: "longbar2", mode: "check", full: true });
  check("full:true returns the text, the same the diff makes", full.fixedSource === applied && full.fixedDiff === undefined, full);
  const small = await session.call("recipe_run", { source: example.replace('let width = s.param_f64("width", 60.0);', "let width: f64 = 60;"), name: "shortbar", mode: "check" });
  check("a short fix is still fixedSource", typeof small.fixedSource === "string" && small.fixedDiff === undefined, small);
}

if (failed > 0) {
  console.error(`recipe-followups: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-followups: all passed");
