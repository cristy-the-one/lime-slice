/**
 * Plugin steps (docs/plan-recipe-plugins.md D8): run marks and stamps on ordinary nodes, found again on a tree; saved
 * and read back in a `.lime` tree, a damaged one left out; and the project's own plugin copies.
 */
import { jumped, newTree, withChild, type ModelOp, type ModelTree, type PluginStamp } from "./model-tree.ts";
import { loadedTree, readSavedTree, savedTree } from "./model-tree-file.ts";
import { markedRun, runEndingAt, runRedoFrom, runsOnPath, sameFingerprint, sameValues, stampedRunOf } from "./plugin-step.ts";
import { readPlugins } from "./project.ts";
import { RECIPE_API } from "./plugin-step.ts";
import { checkedCopies, readPluginFile } from "./plugin-file.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

let failed = 0;
function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const fuse = (x: number): ModelOp => ({ kind: "split", origin: [x, 0, 4], normal: [0, 0, 1] });
const box = { primitive: "box" as const, origin: [0, 0, 0] as [number, number, number], size: [40, 20, 10] as [number, number, number], radius: 0, height: 0, turn: [0, 0, 0] as [number, number, number] };
const fp = { volumeMm3: 8000, faces: 6, edges: 12 };
const stamp: PluginStamp = {
  plugin: "stud-row",
  version: 2,
  sha256: "a".repeat(64),
  api: "1.1",
  params: { studs: 3, edge: "fillet", bore: true },
  context: { bedMm: [250, 210, 220], nozzleMm: 0.4 },
  fingerprint: { volumeMm3: 8100.5, faces: 15, edges: 30 },
};

// A box, a fillet of the person's, a three-step run, then one more step.
let tree: ModelTree = newTree("t", { kind: "primitive", solid: box }, "box", fp);
tree = withChild(tree, 0, { id: 1, op: fuse(-15), label: "own", fingerprint: fp });
for (const id of [2, 3, 4]) tree = withChild(tree, id - 1, { id, op: fuse(id * 4), label: `stud ${id}`, fingerprint: fp });
tree = markedRun(tree, [2, 3, 4], "r1", stamp);
tree = withChild(tree, 4, { id: 5, op: fuse(18), label: "after", fingerprint: fp });

eq("the run's first node is stamped, every node marked", [...tree.nodes.values()].map((n) => [n.id, n.plugin?.plugin ?? null, n.run ? `${n.run.k}/${n.run.n}` : null]), [[0, null, null], [1, null, null], [2, "stud-row", "1/3"], [3, null, "2/3"], [4, null, "3/3"], [5, null, null]]);
eq("the run ending at its last node", runEndingAt(tree, 4), { id: "r1", first: 2, last: 4, ids: [2, 3, 4], before: 1, stamp });
eq("no run ends inside it", runEndingAt(tree, 3), null);
eq("the runs on the way to the shown step", runsOnPath(tree).map((r) => r.id), ["r1"]);
eq("the newest run of a plugin", stampedRunOf(tree, "stud-row")?.last, 4);
eq("another plugin has none", stampedRunOf(tree, "other"), null);
eq("redo from before the run walks it whole", runRedoFrom(jumped(tree, 1))?.last, 4);
eq("redo from inside it does not", runRedoFrom(jumped(tree, 2)), null);
const broken = withChild(jumped(tree, 2), 2, { id: 6, op: fuse(30), label: "side", fingerprint: fp });
eq("a run whose chain was cut is no run", runEndingAt({ ...broken, nodes: new Map([...broken.nodes].filter(([id]) => id !== 3)) }, 4), null);
eq("a run on the root (a part the plugin made) has no step before it", runEndingAt(markedRun(tree, [0, 1], "r0", stamp), 1)?.before, null);

// Saved and read back: the stamp and the marks ride on the nodes; the engine's request never carries them.
const body = savedTree(tree, 5, () => undefined);
eq("the saved nodes keep stamp and run", body.nodes.filter((n) => n.plugin || n.run).map((n) => [n.id, n.plugin?.sha256.slice(0, 4) ?? null, n.run?.id]), [[2, "aaaa", "r1"], [3, null, "r1"], [4, null, "r1"]]);
const json = JSON.parse(JSON.stringify({ ...body, rootPrimitive: box }));
const read = readSavedTree(json);
const back = read ? loadedTree(read, "t2", tree.root, "box", null, () => undefined) : null;
eq("read back, the run is found again", back ? runEndingAt(back, 4) : null, { id: "r1", first: 2, last: 4, ids: [2, 3, 4], before: 1, stamp });
const damaged = JSON.parse(JSON.stringify(json));
damaged.nodes[2].plugin.sha256 = "not a hash";
damaged.nodes[3].run = { id: "r1", k: 4, n: 3 };
const readDamaged = readSavedTree(damaged);
eq("a damaged stamp or mark is left out and the tree still opens", readDamaged ? [readDamaged.nodes[2]!.plugin ?? null, readDamaged.nodes[3]!.run ?? null, readDamaged.nodes.length] : null, [null, null, 6]);

eq("same fingerprint within a millionth", sameFingerprint({ volumeMm3: 1000.0000001, faces: 6, edges: 12 }, { volumeMm3: 1000, faces: 6, edges: 12 }), true);
eq("another face count is another solid", sameFingerprint({ volumeMm3: 1000, faces: 7, edges: 12 }, { volumeMm3: 1000, faces: 6, edges: 12 }), false);
eq("same values by name", sameValues({ a: 1, b: true }, { b: true, a: 1 }), true);
eq("a value left out is not the same", sameValues({ a: 1 }, { a: 1, b: 2 }), false);

// The project's plugin copies: hash to file text; anything else is left out.
eq("plugin copies are read by hash", readPlugins({ ["b".repeat(64)]: "//! ---\n", short: "x", ["c".repeat(64)]: 5 }), { ["b".repeat(64)]: "//! ---\n" });
eq("no copies is none", readPlugins({}), undefined);

// The app reads the project's copies as the MCP server writes them: the body hashed the same way, an edit seen.
const tinyBody = "use lime_recipe::Session;\r\nfn main() {\r\n    let _s = Session::start();\r\n}\r\n";
const sha = createHash("sha256").update(tinyBody.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
const text = `//! ---\n//! plugin: tiny\n//! title: Tiny\n//! version: 2\n//! api: 1.1\n//! params: [{"name":"w","kind":"number","default":3}]\n//! ---\n${tinyBody}`;
const copies = await checkedCopies({ [sha]: text, ["d".repeat(64)]: text.replace("Session::start", "Session::start ") });
eq("a copy whose body hashes to its key is intact; an edited one is not", [copies.get(sha)?.intact, copies.get("d".repeat(64))?.intact], [true, false]);
eq("the header is read", [readPluginFile(text)?.title, readPluginFile(text)?.version, readPluginFile(text)?.params[0]?.name], ["Tiny", 2, "w"]);
eq("a file with no front matter is no plugin file", readPluginFile("fn main() {}"), null);
const crate = readFileSync(new URL("../crates/lime-recipe/src/lib.rs", import.meta.url), "utf8");
const api = /pub const API: \(u32, u32\) = \((\d+), (\d+)\);/.exec(crate);
eq("the app's recipe API level is the crate's", api ? [Number(api[1]), Number(api[2])] : null, [...RECIPE_API]);

if (failed) {
  console.error(`plugin-step: ${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("plugin-step: marks, stamps, saved trees and copies ok");
