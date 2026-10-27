// The shared modelling modules, loaded the way the browser will load them.
// This file is the Node test. The modules beside it must stay free of Node builtins, the MCP session, and the DOM.
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { hasAnchor, resolveAnchors } from "./anchors.ts";
import { evaluate } from "./expr.ts";
import { expandOps } from "./macro.ts";
import { isComposite, MAX_PIECES } from "./compose.ts";
import { splinePoints } from "./sweep.ts";
import { textStrokes } from "./text.ts";
import { thinWalls } from "./thin.ts";
import { levelFrame } from "./frames.ts";

const dir = new URL(".", import.meta.url);
const library = readdirSync(dir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort();
const expected = ["anchors.ts", "compose.ts", "expr.ts", "fit-coupon.ts", "frames.ts", "links.ts", "macro.ts", "params.ts", "partition-export.ts", "partition.ts", "sweep.ts", "text.ts", "thin.ts"];
if (library.join() !== expected.join()) {
  throw new Error(`src/modeling should be ${expected.join(", ")}, found ${library.join(", ")}`);
}

const banned = /(?:^|\s)(?:from\s+)?["'](?:node:|fs|path|url|child_process|module)["']|from\s+["'][^"']*(?:\/mcp\/|\/app\/)/;
for (const name of library) {
  const text = readFileSync(new URL(name, dir), "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("import ") && !trimmed.startsWith("export ") && !trimmed.includes("import(")) continue;
    if (banned.test(trimmed)) throw new Error(`${name} is not browser-safe: ${trimmed}`);
  }
}

// --- D38. The MCP imports these modules from here; the old re-export shims in mcp/ are gone.
for (const name of ["anchors", "compose", "expr", "macro", "sweep", "text", "thin"]) {
  if (existsSync(new URL(`../../mcp/${name}.ts`, import.meta.url))) throw new Error(`mcp/${name}.ts is back: import src/modeling/${name}.ts instead`);
}

if (evaluate("wallH / 2 + 1", { wallH: 10 }) !== 6) throw new Error("evaluate");
if (!isComposite("pocket") || isComposite("boolean")) throw new Error("isComposite");
if (MAX_PIECES !== 400) throw new Error("MAX_PIECES");
const expanded = expandOps([{ kind: "box" }], {}, new Map(), new Set());
if (expanded.length !== 1 || (expanded[0] as { kind: string }).kind !== "box") throw new Error("expandOps");
const point = resolveAnchors(
  { anchor: "base", point: "top", offset: [0, 0, 1] },
  () => ({ min: [0, 0, 0], max: [2, 4, 6] }),
);
if (JSON.stringify(point) !== JSON.stringify([1, 2, 7])) throw new Error("resolveAnchors");
if (hasAnchor([1, 2, 3])) throw new Error("hasAnchor");
const curve = splinePoints(
  [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
  ],
  4,
);
if (curve.length < 2) throw new Error("splinePoints");
const strokes = textStrokes("A", 6, 1, undefined);
if (!Array.isArray(strokes) || strokes.length === 0) throw new Error("textStrokes");
const walls = thinWalls(new Float32Array(0), 1);
if (walls.sampled !== 0 || walls.regions.length !== 0) throw new Error("thinWalls");
const up = levelFrame({ point: [0, 0, 1], normal: [0, 0, 1] });
if (up.source !== "face" || up.origin[2] !== 1) throw new Error("levelFrame");

console.log("src/modeling: ok");
