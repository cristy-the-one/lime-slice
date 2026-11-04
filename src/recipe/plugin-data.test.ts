/**
 * The recipe data a plugin carries (src/recipe/plugin-data.ts): the block after the code round-trips, a body with no
 * data keeps its text (and so its hash), the listing reads names and sizes without the values, too-large data is one
 * sentence, a hand-broken line is a sentence, the source view hides the values, and the window answers a kept
 * plugin's `data {name}` from what it carries, after the step's own. Synthetic data only.
 */
import { CARRIED_DATA_MAX_BYTES, DATA_FENCE, carriedData, carriedDataProblem, carriedEnv, dataMissingInApp, elideData, splitPluginData, withPluginData, type CarriedData } from "./plugin-data.ts";
import { builtText } from "./ingredients.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

const code = 'use lime_recipe::Session;\nfn main() {\n    let mut s = Session::start();\n    let d = s.data("shapes/outline").unwrap();\n}\n';
const outline: CarriedData = { sha256: "a".repeat(64), bytes: 41, value: { points: [[0, 0], [10, 0], [10, 5.5], [0, 5.5]], note: "line\nbreak \"quoted\"" } };
const table: CarriedData = { sha256: "b".repeat(64), bytes: 12, value: [[1, 2], [3, 4]] };

// --- A body with no data is all code, and keeps its text.
check("no data: the body is the code", splitPluginData(code).code === code && Object.keys(splitPluginData(code).data).length === 0);
check("no data: withPluginData leaves the code as it is (its hash too)", withPluginData(code, {}) === code);

// --- Round trip.
const body = withPluginData(code, { "shapes/outline": outline, "b/table": table });
const back = splitPluginData(body);
check("the code comes back as it was", back.code === code, back.code);
check("both names come back with hash, size and value", JSON.stringify(back.data["shapes/outline"]) === JSON.stringify(outline) && JSON.stringify(back.data["b/table"]) === JSON.stringify(table), back.data);
check("one fence line, then one line per name in name order", body.split("\n").filter((l) => l === DATA_FENCE).length === 1 && body.indexOf("// data: b/table ") < body.indexOf("// data: shapes/outline "), body);
check("every data line is a plain // comment (the file stays a main.rs)", body.slice(body.indexOf(DATA_FENCE)).split("\n").every((l) => l === "" || l.startsWith("// ")));
check("a value's newlines stay inside its one line", body.split("\n").filter((l) => l.startsWith("// data: ")).length === 2);
check("no problem on a clean block", back.problem === undefined);
check("the listing reads names and sizes", JSON.stringify(carriedData(body)) === JSON.stringify([{ name: "b/table", sha256: "b".repeat(64), bytes: 12 }, { name: "shapes/outline", sha256: "a".repeat(64), bytes: 41 }]), carriedData(body));
check("the same data gives the same text", withPluginData(code, { "b/table": table, "shapes/outline": outline }) === body);
check("new data replaces the old block, not adds to it", splitPluginData(withPluginData(body, { "b/table": table })).data["shapes/outline"] === undefined && carriedData(withPluginData(body, { "b/table": table })).length === 1);
check("CRLF line ends read the same", JSON.stringify(splitPluginData(body.replace(/\n/g, "\r\n")).data) === JSON.stringify(back.data));

// --- After the ingredients block, as a kept plugin is written.
const withIngredients = builtText(code, "mod ingredients {\n// ingredient: spacing v1 sha256:" + "c".repeat(64) + "\npub mod spacing {}\n}\n");
const both = withPluginData(withIngredients, { "b/table": table });
check("data sits after the ingredients and splits off whole", splitPluginData(both).code === withIngredients && both.indexOf("mod ingredients") < both.indexOf(DATA_FENCE), both);

// --- A hand-broken line.
const broken = body.replace(/(\/\/ data: b\/table sha256:b{64} bytes:12 ).*/, "$1[1, 2");
const read = splitPluginData(broken);
check("a line that does not read is a sentence, and the others still read", !!read.problem && /does not read/.test(read.problem) && !!read.data["shapes/outline"] && !read.data["b/table"], read);

// --- Limits.
check("small data fits", carriedDataProblem({ "b/table": table }) === null);
const big: CarriedData = { sha256: "d".repeat(64), bytes: 10, value: "x".repeat(CARRIED_DATA_MAX_BYTES) };
const tooBig = carriedDataProblem({ huge: big });
check("data over 4 MB a name is one sentence naming it", !!tooBig && /^The recipe data huge is 4\.0 MB as kept, over the 4 MB/.test(tooBig) && tooBig.split(". ").length <= 2, tooBig);
const third: CarriedData = { sha256: "e".repeat(64), bytes: 10, value: "y".repeat(CARRIED_DATA_MAX_BYTES - 1000) };
const total = carriedDataProblem({ a: third, b: third, c: third, d: third });
check("data over 12 MB together is one sentence", !!total && /together, over the 12 MB/.test(total), total);
check("a name with a space is refused", !!carriedDataProblem({ "a b": table }));

// --- The source view.
const shown = elideData(body);
check("the source view keeps the code, names, hashes and sizes, and hides the values", shown.startsWith(code) && shown.includes(`// data: shapes/outline sha256:${"a".repeat(64)} bytes:41 (value not shown)`) && !shown.includes("points"), shown);
check("a source with no data shows as it is", elideData(code) === code);

// --- The window's lookup order.
const env = { chordMm: 0.05 };
check("a draft (version 0) carries nothing: its own refusal stays", carriedEnv(env, 0, { x: table }) === env);
const kept = carriedEnv({ ...env, data: { x: { value: "step" } } }, 2, { x: table, y: outline });
check("a kept plugin carries its data beside the step's own", kept.carried?.y === outline && kept.data?.x?.value === "step");
check("the window's refusal names the data and how to carry it", /reads recipe data skull\/outline, which was not kept with it/.test(dataMissingInApp("skull/outline")) && /nugget \{action:"save", kind:"plugin", id, data:\["skull\/outline"\]\}/.test(dataMissingInApp("skull/outline")) && /run it once with keep/.test(dataMissingInApp("skull/outline")));

if (failed) {
  console.error(`plugin-data: ${failed} failed`);
  process.exit(1);
}
console.log("plugin-data: ok");
