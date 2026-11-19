/**
 * mesh_close_holes: a box with one triangle missing is imported, its hole is closed, and the object keeps its id and
 * its place. A second call has nothing to do, and an unknown object is refused. Stand-in engine.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { edgeReport } from "../src/mesh-check.ts";
import { fakeEngine } from "./engine.ts";
import { stlBytes } from "./request.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-close-holes-"));
process.env.LIME_MCP_WORKSPACE = workspace;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type V = [number, number, number];

/** A box of the given size as twelve outward triangles. */
function box(size: V): number[] {
  const [x, y, z] = size;
  const c: V[] = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  return quads.flatMap(([a, b, d, e]) => [c[a!]!, c[b!]!, c[d!]!, c[a!]!, c[d!]!, c[e!]!].flat());
}

const holey = Float32Array.from(box([10, 20, 30]).slice(9));
check("the test mesh is open", edgeReport(holey).open === 3, String(edgeReport(holey).open));
writeFileSync(join(workspace, "holey.stl"), stlBytes(holey, "holey.stl"));

const session = new Session(fakeEngine());
const call = (name: string, args: unknown = {}) => session.call(name, args);

const imported = await call("mesh_import", { path: "holey.stl" });
const id = String(imported.object);
await call("object_place", { object: id, centreX: 120, centreY: 90 });
const before = ((await call("plate_list")).objects as { object: string; name: string; centre?: unknown; bboxMm?: unknown }[]).find((row) => row.object === id);
const trianglesBefore = session.find(id)!.triangles;

const closed = await call("mesh_close_holes", { object: id });
check("one hole is closed", closed.ok === true && closed.holes === 1 && closed.added === 1 && closed.openBefore === 3 && closed.openAfter === 0 && closed.removed === 0, JSON.stringify(closed));
check("the reply names the object and says what happened", closed.object === id && typeof closed.name === "string" && closed.changed === true && String(closed.summary) === "Closed 1 hole with 1 triangle. No edges are open.", JSON.stringify(closed));

const obj = session.find(id)!;
check("the object has the mended mesh", obj.triangles === trianglesBefore + 1 && edgeReport(obj.source).open === 0, `${obj.triangles} triangles`);
check("the mesh is an STL the engine reads by its name", obj.fileName.endsWith(".stl") && obj.bytes.length === 84 + obj.triangles * 50, obj.fileName);
const after = ((await call("plate_list")).objects as { object: string; name: string; centre?: unknown; bboxMm?: unknown }[]).find((row) => row.object === id);
check("the object keeps its id, name and place", !!before && !!after && after.name === before.name && JSON.stringify(after.centre) === JSON.stringify(before.centre) && JSON.stringify(after.bboxMm) === JSON.stringify(before.bboxMm), JSON.stringify({ before, after }));

const again = await call("mesh_close_holes", { object: id });
check("a second call has nothing to do", again.ok === true && again.changed === false && again.holes === 0 && String(again.summary).includes("Nothing was changed") && session.find(id)!.triangles === obj.triangles, JSON.stringify(again));

const selected = await call("mesh_close_holes", {});
check("without an object it takes the selected one", selected.ok === true && selected.object === id, JSON.stringify(selected));

const unknown = await call("mesh_close_holes", { object: "obj_99" });
check("an unknown object is refused as the sibling tools refuse it", unknown.ok === false && unknown.code === "no-object", JSON.stringify(unknown));
const split = await call("object_split_shells", { object: "obj_99" });
check("object_split_shells refuses it the same way", split.code === unknown.code && split.reason === unknown.reason, JSON.stringify({ split, unknown }));

let refused = "";
try {
  await call("mesh_close_holes", { object: id, maxLoopMm: -1 });
} catch (err) {
  refused = String(err);
}
check("a loop length at or below zero is refused", refused.includes("maxLoopMm must be greater than 0"), refused);

// A loop longer than maxLoopMm stays open, and nothing changes.
const second = await call("mesh_import", { path: "holey.stl" });
const kept = String(second.object);
const skipped = await call("mesh_close_holes", { object: kept, maxLoopMm: 1 });
check("a loop longer than maxLoopMm is left open", skipped.ok === true && skipped.changed === false && skipped.skipped === 1 && session.find(kept)!.triangles === trianglesBefore, JSON.stringify(skipped));

// plate_undo puts the old mesh back.
const third = await call("mesh_import", { path: "holey.stl" });
const undoId = String(third.object);
await call("mesh_close_holes", { object: undoId });
await call("plate_undo");
check("plate_undo puts the old mesh back", session.find(undoId)!.triangles === trianglesBefore);

if (failed > 0) process.exit(1);
