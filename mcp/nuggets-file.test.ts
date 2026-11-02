/**
 * Nugget storage and source scans (docs/plan-recipe-ingredients.md I12–I15), without lust: a recipe's top-level items,
 * lifting items with what they use, the harvest scan, preset checks against declared parameters, and lessons.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LIME_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "lime-nuggets-lib-"));
const { addLesson, harvestFunctions, liftItems, listLessons, listPresets, presetId, presetProblem, publicItems, readPreset, removeLesson, removePreset, seenInPractice, topItems, writePreset } = await import("./nuggets.ts");

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const source = [
  "use lime_recipe::{ops, Json, Session};",
  "use ingredients::tray::*;",
  "",
  "type P = [f64; 2];",
  "const PITCH: f64 = 2.0; // a } in a comment",
  "",
  "/// A cell.",
  "#[derive(Clone)]",
  "struct Cell {",
  "    centre: P,",
  "    pub r: f64,",
  "}",
  "",
  "impl Cell {",
  "    fn area(&self) -> f64 {",
  "        self.r * self.r",
  "    }",
  "}",
  "",
  "fn place(i: u32) -> Cell {",
  '    let label = "fn main() { }";',
  "    Cell { centre: [i as f64 * PITCH, 0.0], r: 1.0 }",
  "}",
  "",
  "fn unused() -> f64 { 1.0 }",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  "    let p = s.solid_new(ops::cuboid(10.0, 10.0, 1.0)).unwrap();",
  "    s.done_with(&p, Json::obj().set(\"a\", place(1).area()));",
  "}",
  "",
].join("\n");
const items = topItems(source);
check("top-level items, with comments and strings ignored", items.map((i) => `${i.kind} ${i.name}`).join(", ") === "use lime_recipe, use ingredients, type P, const PITCH, struct Cell, impl Cell, fn place, fn unused, fn main", items.map((i) => `${i.kind} ${i.name}`));
check("doc comments and attributes belong to the item", items.find((i) => i.name === "Cell" && i.kind === "struct")!.text.startsWith("/// A cell.\n#[derive(Clone)]\nstruct Cell"), items.find((i) => i.kind === "struct")?.text);

const lifted = liftItems(source, ["place"]);
check("lifting takes what the item uses, its impls, and the use lines", !("reason" in lifted) && JSON.stringify(lifted.items) === JSON.stringify(["type P", "const PITCH", "struct Cell", "fn place"]), lifted);
if (!("reason" in lifted)) {
  check("everything lifted is public, a struct's fields and an inherent impl's methods too", lifted.body.includes("pub type P") && lifted.body.includes("pub const PITCH") && lifted.body.includes("pub struct Cell") && lifted.body.includes("    pub centre: P,") && lifted.body.includes("    pub r: f64,") && !lifted.body.includes("pub pub") && lifted.body.includes("    pub fn area(&self)") && lifted.body.includes("pub fn place(i: u32)"), lifted.body);
  check("an ingredients:: import becomes crate::ingredients::, and main and the unused fn stay out", lifted.body.includes("use crate::ingredients::tray::*;") && !lifted.body.includes("fn main()\n") && !lifted.body.includes("unused"), lifted.body);
  check("its public items read back", JSON.stringify(publicItems(lifted.body)) === JSON.stringify(["type P", "const PITCH", "struct Cell", "fn place"]), publicItems(lifted.body));
}
const nope = liftItems(source, ["struct Grid"]);
check("an item that is not there is refused with the ones there are", "reason" in nope && nope.reason.endsWith("it has: type P, const PITCH, struct Cell, fn place, fn unused."), nope);

const long = `fn big(x: f64) -> f64 {\n${"    let x = x + 1.0;\n".repeat(10)}    x\n}\nfn talks(s: &mut Session) -> f64 {\n${"    let _ = 1;\n".repeat(12)}    0.0\n}\nfn main() {}\n`;
check("harvest offers long functions that make no session call", JSON.stringify(harvestFunctions(long)) === JSON.stringify([{ name: "big", lines: 13 }]), harvestFunctions(long));

// --- Presets.
const declared = [
  { name: "cells", kind: "count" as const, default: 6, min: 1, max: 40 },
  { name: "side", kind: "number" as const, default: 4, min: 2, max: 10, unit: "mm" },
  { name: "edge", kind: "choice" as const, default: "fillet", options: ["fillet", "sharp"] },
  { name: "bore", kind: "toggle" as const, default: true },
];
check("a preset inside the ranges fits", presetProblem("p", { cells: 20, side: 3, edge: "sharp", bore: false }, declared) === null, "");
check("out of range", presetProblem("p", { side: 12 }, declared) === "side 12 is outside 2-10 mm.", presetProblem("p", { side: 12 }, declared));
check("a count is whole", presetProblem("p", { cells: 2.5 }, declared) === "cells is a whole number.", "");
check("a choice is one of its options", presetProblem("p", { edge: "round" }, declared) === "edge is one of fillet, sharp.", "");
check("an unknown name", presetProblem("p", { walls: 2 }, declared) === "p has no parameter walls; it has: cells, side, edge, bore.", "");
check("preset ids", JSON.stringify(presetId("honeycomb-tray/pp-5mm-wall")) === JSON.stringify({ plugin: "honeycomb-tray", name: "pp-5mm-wall" }) && presetId("tray") === null && presetId("a/B") === null, "");
writePreset({ plugin: "tray", name: "dense", params: { cells: 20 }, created: "2026-11-02" });
writePreset({ plugin: "tray", name: "loose", params: { cells: 4 }, created: "2026-11-02" });
check("presets are kept per plugin", listPresets().length === 2 && readPreset("tray", "dense")?.params.cells === 20, listPresets());
check("remove takes one", removePreset("tray", "dense") && !removePreset("tray", "dense") && listPresets("tray").length === 1, "");

// --- Lessons.
const one = addLesson("fillet", "Aim nearPoint at material.", "2026-11-02");
addLesson("extrude", "Loops nest: a loop inside another is its hole.", "2026-11-02");
const two = addLesson("fillet", "A fillet larger than the rib refuses.", "2026-11-02");
check("the same lesson twice is kept once", addLesson("fillet", "aim nearpoint at material.", "2026-11-02").n === one.n && listLessons().length === 3, listLessons());
check("seen in practice is newest first, for that kind only", JSON.stringify(seenInPractice("fillet")) === JSON.stringify(["A fillet larger than the rib refuses.", "Aim nearPoint at material."]), seenInPractice("fillet"));
for (let k = 0; k < 6; k += 1) addLesson("fillet", `lesson ${k}`, "2026-11-02");
check("at most five are shown", seenInPractice("fillet").length === 5 && seenInPractice("fillet")[0] === "lesson 5", seenInPractice("fillet"));
check("remove takes a lesson by number", removeLesson(two.n) && !listLessons().some((l) => l.n === two.n), "");

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nnuggets-file: all checks passed");
