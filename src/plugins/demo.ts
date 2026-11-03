/**
 * --- The Plugins panel's Show me (docs/plan-sketch-for-people.md P2, R5, applied to plugin milestone 7): a demo
 * plugin, ready for its next click. It is the recipes guide's example (`lime://guide/recipes`, built under lust and
 * rustc call for call by `mcp/recipe-geom2d.test.ts`) with its numbers as typed parameters. It makes a new part, so
 * Preview shows it beside the person's work; Apply is greyed with the reason, so a demo never adds anything.
 */
import { readPluginFile, type PluginFileInfo } from "../plugin-file.ts";
import type { PanelPlugin } from "./library.ts";

export const DEMO_BODY = [
  "use lime_recipe::{ops, Json, Session};",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let width = s.number("width", 60.0).range(30.0, 200.0).step(1.0).unit("mm").label("Width").help("How long the bar is.").get();',
  '    let holes = s.count("holes", 4).range(1, 12).label("Holes").get();',
  '    let d = s.number("diameter", 3.2).range(1.0, 8.0).step(0.1).unit("mm").label("Hole diameter").get();',
  "    let part = s.solid_new(ops::cuboid(width, 20.0, 4.0)).unwrap();",
  "    let mut n = 0;",
  "    for i in 0..holes {",
  "        let x = -width / 2.0 + width * (i as f64 + 0.5) / holes as f64;",
  "        if s.apply(&part, ops::hole_through([x, 0.0, 4.0], [0.0, 0.0, -1.0], d)).is_ok() { n += 1; }",
  "    }",
  '    s.done_with(&part, Json::obj().set("holes", n));',
  "}",
  "",
].join("\n");

const PARAMS = [
  { name: "width", kind: "number", default: 60, min: 30, max: 200, step: 1, unit: "mm", label: "Width", help: "How long the bar is." },
  { name: "holes", kind: "count", default: 4, min: 1, max: 12, label: "Holes" },
  { name: "diameter", kind: "number", default: 3.2, min: 1, max: 8, step: 0.1, unit: "mm", label: "Hole diameter" },
];

const TEXT = [
  "//! ---",
  "//! plugin: demo-drilled-bar",
  "//! title: Drilled bar (demo)",
  "//! version: 1",
  "//! description: A flat bar with a row of holes through it. A demo: change a value and watch the preview.",
  "//! author: Lime Slice",
  "//! api: 1.1",
  "//! target: new",
  `//! params: ${JSON.stringify(PARAMS)}`,
  "//! ---",
  DEMO_BODY,
].join("\n");

const FILE: PluginFileInfo = readPluginFile(TEXT)!;

export const DEMO_PLUGIN: PanelPlugin = { key: "demo:drilled-bar", section: "samples", file: FILE, sha256: "", inLibrary: false, badges: ["demo"], usedAt: 0 };

/** The demo's strip: the next click, then the way back (R1). */
export const DEMO_TRY = "Try it: change Holes to 6. With Live on, the preview follows; else press Preview. Nothing is added to your part. Click Back to my plugins when you are done.";
