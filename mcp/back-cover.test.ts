/**
 * Findings from the 2.6.1 back-cover session, against the stand-in engine. The same repros against real Open CASCADE
 * are in occt.test.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { closeCracks, edgeReport } from "../src/mesh-check.ts";
import { standRegion } from "./plane-region.ts";
import { advertisedTools } from "./schema.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-back-cover-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Finding 5: the schema a client sees matches the guide.
{
  const build = advertisedTools().find((tool) => tool.name === "model_build")!;
  const base = (build.inputSchema.properties as Record<string, { properties: Record<string, unknown> }>).base.properties;
  check("model_build.base.dx takes text as well as a number", same(base.dx, { exclusiveMinimum: 0, maximum: 1000, description: "Box X." }), JSON.stringify(base.dx));
  check("model_build.base takes a cone's top radius", same(base.topRadius, { minimum: 0, maximum: 500, description: "Cone top." }), JSON.stringify(base.topRadius));
  const apply = advertisedTools().find((tool) => tool.name === "model_apply")!;
  const ops = ((apply.inputSchema.properties as Record<string, { oneOf: { properties: Record<string, Record<string, unknown>> }[] }>).op.oneOf);
  const ribs = ops.find((row) => (row.properties.kind as { const?: string }).const === "ribs")!;
  check("ribs width takes text", ribs.properties.width!.type === undefined && ribs.properties.width!.maximum === 100);
  const hole = ops.find((row) => (row.properties.kind as { const?: string }).const === "hole")!;
  check("a hole's origin takes an anchor object", hole.properties.origin!.type === undefined && hole.properties.origin!.maxItems === 3);
  const fillet = ops.find((row) => (row.properties.kind as { const?: string }).const === "fillet")!;
  check("a fillet's edge select names onFace selectors", JSON.stringify(fillet.properties.edges).includes("onFace (index or {normal, nearPoint})"));
  const solidNew = advertisedTools().find((tool) => tool.name === "solid_new")!;
  check("solid_new lists radius and height", "radius" in (solidNew.inputSchema.properties as object) && "height" in (solidNew.inputSchema.properties as object));

  const session = new Session(fakeEngine());
  await session.call("model_params", { set: { L: 40 } });
  const built = await session.call("model_build", { base: { primitive: "box", dx: "L", dy: 20, dz: 10 }, ops: [] });
  check("model_build reads base.dx from a parameter", built.ok === true && same(built.bounds, { min: [-20, -10, 0], max: [20, 10, 10] }), JSON.stringify(built));
  const cylinder = await session.call("solid_new", { primitive: "cylinder", radius: 5, height: 10 });
  check("solid_new takes a cylinder's radius and height", cylinder.ok === true, JSON.stringify(cylinder));
  const box = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const bottom = await session.call("edges_find", { object: box.object, onFace: { normal: [0, 0, -1] } });
  check("edges_find takes onFace as a face selector", bottom.ok === true && bottom.total === 4 && same((bottom.edges as { index: number }[]).map((edge) => edge.index), [0, 1, 2, 3]), JSON.stringify(bottom));
  const fillet2 = await session.call("model_probe", { object: box.object, op: { kind: "fillet", edges: { select: { onFace: { normal: [0, 0, 1], nearPoint: [0, 0, 20] } } }, size: 1 } });
  check("a fillet picks edges on a face selector", fillet2.ok === true && same(fillet2.edges, [4, 5, 6, 7]), JSON.stringify(fillet2));
  const wrong = await session.call("model_probe", { object: box.object, op: { kind: "fillet", edges: { select: { onFace: { normal: [1, 1, 1], withinDeg: 1 } } }, size: 1 } });
  check("a face selector that matches nothing says so", wrong.ok === false && wrong.reason === "onFace: No flat face matches that selector.", JSON.stringify(wrong));
}

// Finding 3a and 4: a second set of ribs stands on the whole floor plane, through the first set, and runs into walls.
{
  // A floor along X with a wall at y 48..50 (20 tall) and an earlier rib at y 20..22 (8 tall), as side faces only: a
  // line across X never meets the ends.
  const profile: [number, number][] = [[0, 0], [50, 0], [50, 20], [48, 20], [48, 2.5], [22, 2.5], [22, 10.5], [20, 10.5], [20, 2.5], [0, 2.5]];
  const soup: number[] = [];
  profile.forEach((p, i) => {
    const q = profile[(i + 1) % profile.length]!;
    soup.push(0, p[0], p[1], 100, p[0], p[1], 100, q[0], q[1], 0, p[0], p[1], 100, q[0], q[1], 0, q[0], q[1]);
  });
  const floor = { source: "face" as const, origin: [0, 0, 2.5] as [number, number, number], turn: [0, 0, 0] as [number, number, number] };
  const stand = standRegion(Float32Array.from(soup), floor, 8, 0.5);
  const across = stand.spans(-50, 90)!.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
  check("a rib across the floor runs through the earlier rib and 0.5 mm into the wall", same(across, [[0, 48.5], [49.5, 50]]), JSON.stringify(across));
  const taller = standRegion(Float32Array.from(soup), floor, 6, 0.5).spans(-50, 90)!.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
  check("a rib lower than the earlier one stops 0.5 mm into it", same(taller, [[0, 20.5], [21.5, 48.5], [49.5, 50]]), JSON.stringify(taller));
  // One wall alone: a line meets it once, its crossings do not pair, and it reads as null so the face outline decides.
  const wall = standRegion(Float32Array.from([0, 10, -5, 100, 10, -5, 0, 10, 20, 100, 10, -5, 100, 10, 20, 0, 10, 20]), floor, 8, 0.5);
  check("a line whose crossings do not pair reads as null", wall.spans(-50, 90) === null);
}

// Finding 3b: a step the kernel says is done but that loses the part is taken back and refused.
{
  const session = new Session(fakeEngine());
  const box = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  process.env.LIME_MCP_FAKE_LOSE_FUSE = "1";
  const lost = await session.call("model_apply", { object: box.object, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [5, -2, 18], dx: 4, dy: 4, dz: 4 } });
  delete process.env.LIME_MCP_FAKE_LOSE_FUSE;
  check(
    "a fuse that returns only its tool is refused",
    lost.ok === false && lost.reason === "Open CASCADE returned 307 mm³ for a fuse on a 8000 mm³ part, so the part would be lost. The step was taken back. Move or resize it so it overlaps the part more clearly, or split the edit into smaller steps.",
    JSON.stringify(lost),
  );
  const described = await session.call("model_describe", { object: box.object, limit: 1 });
  const history = await session.call("model_history", { object: box.object });
  check("the part and its history are as before", described.volumeMm3 === 8000 && (history.nodes as unknown[]).length === 1, JSON.stringify({ volume: described.volumeMm3, history }));

  // A fresh part: the stand-in rebuilds a 20 mm cube at 0..20 when it goes back a step.
  const fresh = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const second = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  process.env.LIME_MCP_FAKE_TOUCH = "1";
  const touching = await session.call("model_apply", { object: fresh.object, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [8, 8, 18], dx: 4, dy: 4, dz: 4 } });
  const boss = await session.call("model_apply", { object: second.object, op: { kind: "boss", faceIndex: 0, at: { u: -8, v: -8 }, width: 4, height: 4, depth: 2 } });
  delete process.env.LIME_MCP_FAKE_TOUCH;
  check(
    "a fuse that leaves pieces meeting along an edge is refused with where",
    touching.ok === false && touching.reason === "This step would leave pieces that meet only along an edge at (10, 10, 10), which is not a closed solid to print. The step was taken back. Move it so it overlaps the part, or clears it.",
    JSON.stringify(touching),
  );
  check("a composite step that touches along an edge is left out and reported", boss.leftOut === 1 && String(boss.leftOutNote).startsWith("1 step would have left pieces meeting only along an edge, even 0.3 mm shorter at each end, and was left out."), JSON.stringify(boss));
}

// Finding 2b: a step that runs past the kernel's budget restarts the modeler, but every history stays and builds again.
{
  const engine = fakeEngine();
  const session = new Session(engine);
  const box = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const other = await session.call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
  const tool = await session.call("solid_new", { primitive: "box", dx: 4, dy: 4, dz: 4 });
  await session.call("model_apply", { object: box.object, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [-2, -2, 19], dx: 4, dy: 4, dz: 3 } });
  await session.call("model_apply", { object: tool.object, probe: true, op: { kind: "scale", factor: 2 } });
  const joined = await session.call("model_apply", { object: other.object, probe: true, op: { kind: "join", op: "fuse", toolObject: tool.object, keepTool: true } });
  process.env.LIME_MCP_HANG_MODEL = "1";
  process.env.LIME_MCP_MODEL_TIMEOUT_S = "0.3";
  const hung = await session.call("model_apply", { object: box.object, probe: true, op: { kind: "fillet", edges: [0], size: 1 } });
  delete process.env.LIME_MCP_HANG_MODEL;
  delete process.env.LIME_MCP_MODEL_TIMEOUT_S;
  const mine = await session.call("model_history", { object: box.object });
  const theirs = await session.call("model_history", { object: other.object });
  check("a runaway step is refused and the modeler restarted", joined.ok === true && hung.ok === false && engine.resets === 1, JSON.stringify({ joined, hung }));
  check("every object keeps its history", (mine.nodes as unknown[]).length === 2 && (theirs.nodes as unknown[]).length === 2, JSON.stringify({ mine, theirs }));
  const opens = engine.opens.length;
  const again = await session.call("model_apply", { object: box.object, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [-2, -2, 19], dx: 2, dy: 2, dz: 3 } });
  const after = await session.call("model_history", { object: box.object });
  const rebuilt = engine.opens.slice(opens);
  check("the next edit rebuilds that history whole, then lands after its steps", again.ok === true && (after.nodes as unknown[]).length === 3 && rebuilt.length === 1 && Array.isArray(rebuilt[0]!.nodes) && (rebuilt[0]!.nodes as unknown[]).length === 1, JSON.stringify({ again, after, rebuilt: rebuilt.map((row) => ({ key: row.key, nodes: row.nodes })) }));
  const committed = await session.call("model_commit", { object: other.object });
  const keys = engine.opens.slice(opens + 1).map((row) => row.key);
  check("a commit after the restart rebuilds the join's tool first, then the part, and commits", committed.ok === true && JSON.stringify(keys) === JSON.stringify([`mcp-${tool.object}`, `mcp-${other.object}`]), JSON.stringify({ committed, keys }));
}

// Finding 6: cracks where two faces sample a shared edge apart are mended; edges are counted.
{
  // A unit cube whose top has an extra point mid-way along its front edge, which the front face does not have.
  const c = (x: number, y: number, z: number) => [x, y, z];
  const quad = (a: number[], b: number[], d: number[], e: number[]) => [...a, ...b, ...d, ...a, ...d, ...e];
  const m = c(0.5, 0, 1);
  const soup = [
    ...quad(c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)),
    ...quad(c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)),
    ...quad(c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)),
    ...quad(c(1, 1, 0), c(0, 1, 0), c(0, 1, 1), c(1, 1, 1)),
    ...quad(c(0, 1, 0), c(0, 0, 0), c(0, 0, 1), c(0, 1, 1)),
    ...c(0, 0, 1), ...m, ...c(0, 1, 1),
    ...m, ...c(1, 0, 1), ...c(1, 1, 1),
    ...m, ...c(1, 1, 1), ...c(0, 1, 1),
  ];
  const before = edgeReport(soup);
  const mended = closeCracks(soup);
  const after = edgeReport(mended);
  check("the crack shows as three open edges", before.open === 3 && before.nonManifold === 0, JSON.stringify(before));
  check("mending splits the front face at the extra point and closes it", after.open === 0 && after.nonManifold === 0 && after.triangles === 14, JSON.stringify(after));

  // Two copies of one corner a hair apart, on either side of a 1 µm grid line, are one point.
  const e = 1e-7;
  const tetra = (d: number[]) => [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, ...d, 0, 1, 0, 1, 0, 0, ...d, 1, 0, 0, 0, 0, 0, ...d];
  const split = tetra([0.001 - e, 0.001 - e, 1]).slice(0, 18).concat(tetra([0.001 + e, 0.001 + e, 1]).slice(18));
  const welded = edgeReport(split);
  check("corners either side of a grid line weld together", welded.open === 0 && welded.nonManifold === 0, JSON.stringify(welded));

  const session = new Session(fakeEngine());
  const box = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const checked = await session.call("model_check", { object: box.object });
  check("model_check reports a closed box", same(checked.edges, { open: 0, nonManifold: 0 }), JSON.stringify(checked.edges));
  process.env.LIME_MCP_FAKE_OPEN = "1";
  await session.call("model_apply", { object: box.object, probe: true, op: { kind: "scale", factor: 1.5 } });
  delete process.env.LIME_MCP_FAKE_OPEN;
  const refused = await session.call("model_commit", { object: box.object });
  check(
    "a commit whose edits opened the mesh is refused, with where",
    refused.ok === false && String(refused.reason).startsWith("The solid's mesh does not close: 3 open edges, the first at ("),
    JSON.stringify(refused),
  );
  const openCheck = await session.call("model_check", { object: box.object });
  check("model_check lists the same open edges", (openCheck.edges as { open?: number }).open === 3, JSON.stringify(openCheck.edges));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("back-cover: ok");
process.exit(0);
