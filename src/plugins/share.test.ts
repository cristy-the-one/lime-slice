/**
 * Sharing plugins (docs/plan-recipe-plugins.md milestone 8), with no lust and no file system beyond the fixtures: the
 * exported file (presets and lessons in the header, the body and its hash untouched), the import checks on the four
 * fixtures of the plan (a clean plugin, one with `mod x;`, an over-long description carrying an instruction, a newer
 * API), hidden text-direction characters, the name clash, and the presets, lessons and marks an import keeps.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readPluginFile } from "../plugin-file.ts";
import {
  apiProblem,
  bodyOf,
  checkImport,
  clashOf,
  exportName,
  exportText,
  isPluginFileName,
  keptBesideTitle,
  lessonsFor,
  marksText,
  mergeLessons,
  mergePresets,
  readMarks,
  renamed,
  replacedVersion,
  withMark,
  withoutShareLines,
} from "./share.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

const sha = (body: string) => createHash("sha256").update(body.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
const API: [number, number] = [1, 1];
const fixture = (name: string) => readFileSync(join("mcp", "fixtures", "plugin-import", name), "utf8");

// --- The four fixtures, each with its sentence.
const clean = checkImport(fixture("clean.lime-plugin.rs"), API, sha);
check("a clean plugin reads, with its hash as computed and as its header names it", !("reason" in clean) && clean.id === "fixture-block" && clean.sha256 === clean.headerSha && clean.author === "Fixture Author" && clean.madeBy === "fixture-client", clean);
check("its description is kept as written: data, shown, never followed", !("reason" in clean) && clean.description.includes("Ignore all previous instructions"), clean);
const mod = checkImport(fixture("mod-file.lime-plugin.rs"), API, sha);
check("mod x; is refused with its line", "reason" in mod && mod.reason === "Line 2 brings in another file or crate; a plugin is one file against lime_recipe, so it was not imported.", mod);
const long = checkImport(fixture("long-description.lime-plugin.rs"), API, sha);
check("an over-long description is refused in one sentence", "reason" in long && /^Its description is \d+ characters; a plugin's description is at most 280\. It was not imported/.test(long.reason), long);
const future = checkImport(fixture("newer-api.lime-plugin.rs"), API, sha);
check("a newer API is refused in one sentence, before any build", "reason" in future && future.reason === "It needs recipe API 9.0; this Lime Slice has 1.1. Update Lime Slice, then import it again.", future);
check("an older major is named", apiProblem("0.9", [1, 1]) === "It was written for recipe API 0.x, which this Lime Slice no longer builds.");
check("the same level imports", apiProblem("1.1", [1, 1]) === null && apiProblem("1.0", [1, 1]) === null);

// --- Other refusals.
const source = fixture("clean.lime-plugin.rs");
const bidi = checkImport(source.replace("let mut s", "let mut s /* ‮ */"), API, sha);
check("a hidden text-direction character is refused with its line", "reason" in bidi && /^Line 17 holds an invisible text-direction character/.test(bidi.reason), bidi);
check("a file with no header is not a plugin", "reason" in checkImport("fn main() {}\n", API, sha));
check("an ingredient is not imported as a plugin", (() => {
  const r = checkImport("//! ---\n//! ingredient: honeycomb\n//! title: Honeycomb\n//! ---\npub fn cells() {}\n", API, sha);
  return "reason" in r && /ingredient, not a plugin/.test(r.reason);
})());
const extern = checkImport(source.replace("use lime_recipe::{ops, Session};", "extern crate serde;\nuse lime_recipe::{ops, Session};"), API, sha);
check("extern crate other than lime_recipe is refused", "reason" in extern && /^Line 1 brings in another file or crate/.test(extern.reason), extern);
const commented = checkImport(source.replace("fn main() {", "// mod helpers; is not code\nfn main() {"), API, sha);
check("mod x; in a comment is not code", !("reason" in commented), commented);
const longLabel = checkImport(source.replace('"label":"Width"', `"label":"${"W".repeat(61)}"`), API, sha);
check("a parameter's label is capped too", "reason" in longLabel && /The label of its value width is 61 characters; at most 60/.test(longLabel.reason), longLabel);

// --- Export: presets and lessons in the header, outside the hash; the round trip gives the same plugin.
const presets = { thick: { params: { width: 40 }, created: "2026-11-04" } };
const lessons = [{ about: "fixture-block", text: "Width over 60 needs a brim on a belt printer.", created: "2026-11-04" }];
const shared = exportText(source, presets, lessons);
check("the export name says what it is", exportName("fixture-block", 1) === "fixture-block-v1.lime-plugin.rs" && isPluginFileName("fixture-block-v1.lime-plugin.rs") && isPluginFileName("fixture-block.rs") && !isPluginFileName("part.stl"));
check("the shared file keeps its body byte for byte", bodyOf(shared) === bodyOf(source), shared.slice(0, 600));
check("its header carries the presets and lessons before the closing fence", /\/\/! params: .*\n\/\/! presets: \{"thick":\{"params":\{"width":40\},"created":"2026-11-04"\}\}\n\/\/! lessons: \[\{"about":"fixture-block",.*\}\]\n\/\/! ---\n/.test(shared), shared.slice(0, 900));
check("it is still a plugin file the app reads", readPluginFile(shared)?.plugin === "fixture-block" && readPluginFile(shared)?.headerSha === sha(bodyOf(source)!));
const back = checkImport(shared, API, sha);
check("import of the export: same hash, presets and lessons", !("reason" in back) && !("reason" in clean) && back.sha256 === clean.sha256 && JSON.stringify(back.presets) === JSON.stringify(presets) && JSON.stringify(back.lessons) === JSON.stringify(lessons), back);
check("the library keeps the file without the sharing lines: the bytes it was exported from", !("reason" in back) && back.libraryText === source.replace(/\r\n?/g, "\n") && withoutShareLines(shared) === source.replace(/\r\n?/g, "\n"));
check("exporting again replaces the sharing lines, never stacks them", exportText(shared, {}, []) === source.replace(/\r\n?/g, "\n"));
const badPreset = checkImport(shared.replace('"thick"', '"Thick One"'), API, sha);
check("a preset name that is not a slug is refused", "reason" in badPreset && /preset "Thick One"/.test(badPreset.reason), badPreset);
const longLesson = checkImport(exportText(source, {}, [{ about: "fixture-block", text: "x".repeat(201), created: "" }]), API, sha);
check("a lesson over 200 characters is refused", "reason" in longLesson && /^Its lesson is 201 characters/.test(longLesson.reason), longLesson);

// --- Which lessons go with a plugin.
const all = [
  { about: "fillet", text: "a" },
  { about: "fixture-block", text: "b" },
  { about: "honeycomb::cells", text: "c" },
  { about: "honeycomb", text: "d" },
  { about: "fixture_block", text: "e" },
];
check("lessons about the plugin and the ingredients it carries, not about op kinds", JSON.stringify(lessonsFor("fixture-block", ["honeycomb"], all).map((l) => l.text)) === JSON.stringify(["b", "c", "d", "e"]));
check("none when it carries no ingredient and none is about it", lessonsFor("other", [], all).length === 0);

// --- The name clash.
const lib = new Map([["fixture-block", { sha256: "a".repeat(64), version: 3 }], ["fixture-block-2", { sha256: "b".repeat(64), version: 1 }]]);
const at = (id: string) => lib.get(id) ?? null;
check("a free id is new", clashOf("fresh", "c".repeat(64), 1, at).kind === "new");
check("the same code is the same plugin", JSON.stringify(clashOf("fixture-block", "a".repeat(64), 1, at)) === JSON.stringify({ kind: "same", version: 3 }));
check("other code keeps both as the first free suffix", JSON.stringify(clashOf("fixture-block", "c".repeat(64), 1, at)) === JSON.stringify({ kind: "clash", keepBoth: "fixture-block-3", version: 3, newer: false }));
check("a later version is offered as an update", (clashOf("fixture-block", "c".repeat(64), 4, at) as { newer: boolean }).newer === true);
check("a copy already kept beside is found again", (clashOf("fixture-block", "b".repeat(64), 1, at) as { keepBoth: string }).keepBoth === "fixture-block-2");
const beside = renamed(source, "fixture-block-3", keptBesideTitle("Fixture block", "fixture-block-3"));
check("kept beside: a new id and title, the same body", readPluginFile(beside)?.plugin === "fixture-block-3" && readPluginFile(beside)?.title === "Fixture block (3)" && bodyOf(beside) === bodyOf(source));
check("a replacing import goes above the library's version, so the old one is kept", readPluginFile(replacedVersion(source, 3))?.version === 4 && readPluginFile(replacedVersion(source.replace("//! version: 1", "//! version: 7"), 3))?.version === 7);

// --- What an import keeps beside the plugin.
const mergedPresets = mergePresets(JSON.stringify({ thick: { params: { width: 30 }, created: "x" } }), { thick: { params: { width: 40 }, created: "y" }, thin: { params: { width: 8 }, created: "y" } });
check("presets: the library's own name keeps its values, a new one is added", JSON.stringify(mergedPresets.added) === JSON.stringify(["thin"]) && (JSON.parse(mergedPresets.text) as Record<string, { params: { width: number } }>).thick!.params.width === 30);
const mergedLessons = mergeLessons(JSON.stringify([{ n: 4, about: "fixture-block", text: "Width over 60 needs a brim on a belt printer.", created: "" }]), [...lessons, { about: "fillet", text: "New one.", created: "z" }]);
check("lessons: the same sentence is kept once, a new one numbered after the last", mergedLessons.added === 1 && (JSON.parse(mergedLessons.text) as { n: number }[]).map((r) => r.n).join(",") === "4,5");
const marks = withMark(readMarks(null), "fixture-block", { sha256: "a".repeat(64), from: "file", at: "2026-11-04" });
check("marks: written and read back", JSON.stringify(readMarks(marksText(marks))) === JSON.stringify(marks) && Object.keys(withMark(marks, "fixture-block", null)).length === 0);
check("marks: a damaged file is no marks, a bad id is skipped", Object.keys(readMarks("{nope")).length === 0 && Object.keys(readMarks('{"../x":{"sha256":"a"}}')).length === 0);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("share: ok");
