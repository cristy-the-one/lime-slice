/**
 * Composite Model edits, batches, labels, parameters, and the op schema's refusals, against the stand-in engine.
 * The real Open CASCADE kernel is not built in this run, so shapes are checked as the ops sent, not as solids.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addsPiece, cleanOp, cutsOffPiece, expand, movedSpec, primitiveFrom, type ExpandContext, type Piece } from "../src/modeling/compose.ts";
import { evaluate, resolveNumbers } from "../src/modeling/expr.ts";
import { fakeEngine } from "./engine.ts";
import { validateTool } from "./schema.ts";
import { Session } from "./session.ts";
import { GLOBAL_WORKPLANE, workplaneOnFace } from "../src/workplane.ts";
import type { PrimitiveSpec } from "../src/model-primitive.ts";
import { eulerOrient } from "../src/mesh-place.ts";
import { historyLayout, presentedRows } from "../src/model-history.ts";
import { loadedTree, readSavedTree, withSavedNames } from "../src/model-tree-file.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-compose-"));
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
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const nearAll = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.length === b.length && a.every((value, i) => near(value, b[i]!, eps));

// Expressions.
check("an expression reads names and functions", near(evaluate("wallH / 2 + sqrt(4) * 3 - -1", { wallH: 10 }), 12));
check("power and brackets bind as written", near(evaluate("2 ^ 3 ^ 2", {}), 512) && near(evaluate("(1 + 2) * 3", {}), 9));
check("cos takes degrees", near(evaluate("cos(60)", {}), 0.5));
let unknown = "";
try {
  evaluate("roofW + 1", {});
} catch (err) {
  unknown = err instanceof Error ? err.message : "";
}
check("an unknown name is a sentence", unknown.includes("roofW") && unknown.includes("model_params"), unknown);
const resolved = resolveNumbers({ kind: "boolean", op: "cut", primitive: "box", dx: "w * 2", origin: [0, "w", 1], label: "left wall" }, { w: 3 }) as Record<string, unknown>;
const worded = resolveNumbers({ kind: "ribs", along: "v", someFutureField: "inside", width: "w" }, { w: 2 }, "op", new Set(["v", "inside"])) as Record<string, unknown>;
check("an enum word stays text in any field", worded.someFutureField === "inside" && worded.width === 2, JSON.stringify(worded));
check("numbers in an op resolve and text fields stay text", resolved.dx === 6 && (resolved.origin as number[])[1] === 3 && resolved.label === "left wall" && resolved.kind === "boolean", JSON.stringify(resolved));

// Primitive placement.
const byCentre = primitiveFrom({ primitive: "box", dx: 10, dy: 4, dz: 2, centre: [1, 2, 3] }) as PrimitiveSpec;
check("centre places a box by its middle", nearAll(byCentre.origin, [-4, 0, 2]), JSON.stringify(byCentre.origin));
const cylCentre = primitiveFrom({ primitive: "cylinder", radius: 5, height: 4, centre: [0, -20, 18], turn: [90, 0, 0] }) as PrimitiveSpec;
check("centre places a cylinder halfway up its axis", nearAll(cylCentre.origin, [0, -20, 16]), JSON.stringify(cylCentre.origin));
check("origin and centre together are refused", "reason" in primitiveFrom({ primitive: "box", origin: [0, 0, 0], centre: [0, 0, 0] }));
check("an echo keeps only the fields a box reads", JSON.stringify(cleanOp({ kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 0], size: [1, 2, 3], radius: 31, height: 3, turn: [0, 0, 0] })) === JSON.stringify({ kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 0], size: [1, 2, 3], turn: [0, 0, 0] }));

// Mirror and pattern geometry.
const tilted = primitiveFrom({ primitive: "box", dx: 60, dy: 1.6, dz: 0.8, centre: [0, 4, 55], turn: [45, 0, 0] }) as PrimitiveSpec;
const mirrored = movedSpec(tilted, { m: [1, 0, 0, 0, -1, 0, 0, 0, 1], t: [0, 0, 0], reflect: true }) as PrimitiveSpec;
const mirroredCentre = [mirrored.origin[0] + 30, mirrored.origin[1] + 0.8, mirrored.origin[2] + 0.4];
check("a mirrored groove sits on the other slope", nearAll(mirroredCentre, [0, -4, 55]), JSON.stringify(mirrored));
const turned = eulerOrient(mirrored.turn[0], mirrored.turn[1], mirrored.turn[2]);
const grooveNormal = [turned[1], turned[4], turned[7]];
check("a mirrored groove faces out of the other slope", nearAll(grooveNormal.map(Math.abs), [0, Math.SQRT1_2, Math.SQRT1_2]) && grooveNormal[1]! * grooveNormal[2]! < 0, JSON.stringify(mirrored.turn));
const wedge = primitiveFrom({ primitive: "wedge", dx: 4, dy: 4, dz: 4 }) as PrimitiveSpec;
check("a wedge mirror is refused", "reason" in movedSpec(wedge, { m: [-1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], reflect: true }));

const globalCtx: ExpandContext = { plane: GLOBAL_WORKPLANE, face: () => ({ reason: "no faces" }), faceBy: () => ({ reason: "no faces" }) };
const toPart = (op: Record<string, unknown>): Piece | { reason: string } => {
  const spec = primitiveFrom(op);
  return "reason" in spec ? spec : { op: op.op === "fuse" ? "fuse" : "cut", spec };
};
const post = { kind: "boolean", op: "fuse", primitive: "cylinder", radius: 1, height: 5, origin: [0, 0, 0] };
const row = expand({ kind: "pattern", op: post, linear: { step: [10, 0, 0], count: 4, step2: [0, 5, 0], count2: 2 } }, globalCtx, toPart) as Piece[];
check("a linear grid makes count times count2 steps", Array.isArray(row) && row.length === 8 && nearAll(row[7]!.spec.origin, [30, 5, 0]), JSON.stringify(row.map((p) => p.spec.origin)));
const ring = expand({ kind: "pattern", op: { ...post, origin: [10, 0, 0] }, polar: { count: 4 } }, globalCtx, toPart) as Piece[];
check("a polar pattern turns copies about Z", ring.length === 4 && nearAll(ring[1]!.spec.origin, [0, 10, 0], 1e-5), JSON.stringify(ring.map((p) => p.spec.origin)));
const pair = expand({ kind: "mirror", op: { ...post, origin: [7, 2, 0] }, plane: "x" }, globalCtx, toPart) as Piece[];
check("a mirror keeps the original and adds its reflection", pair.length === 2 && nearAll(pair[1]!.spec.origin, [-7, 2, 0], 1e-6), JSON.stringify(pair.map((p) => p.spec.origin)));
const nested = expand({ kind: "mirror", plane: "y", op: { kind: "pattern", op: post, linear: { step: [5, 0, 0], count: 3 } } }, globalCtx, toPart) as Piece[];
check("a mirror of a pattern makes both rows", nested.length === 6);

// Pocket, boss, texture on a face: the -Y wall of a 60 x 40 x 35 house body.
const front = workplaneOnFace({ point: [0, -20, 17.5], normal: [0, -1, 0] });
const faceCtx: ExpandContext = {
  plane: GLOBAL_WORKPLANE,
  face: (index) => index === 5 ? { plane: front, extent: { u: [-30, 30], v: [-17.5, 17.5] } } : { reason: "That face is not on this solid." },
  faceBy: (selector) => JSON.stringify(selector.normal) === "[0,-1,0]" ? 5 : { reason: "No flat face matches that selector." },
};
const window = expand({ kind: "pocket", faceIndex: 5, at: { u: 18, v: 2.5 }, width: 10, height: 10, depth: 1.5, bars: { vertical: 1, horizontal: 1, width: 1 } }, faceCtx, toPart) as Piece[];
check("a barred window is one cut and two bars", window.length === 3 && window[0]!.op === "cut" && window[1]!.op === "fuse" && window[2]!.op === "fuse");
const cutBox = window[0]!.spec;
const cutCentre = [cutBox.origin[0] + 5, cutBox.origin[1] + 5, cutBox.origin[2] + 1.25];
check("the window cut is centred on the face point it names", near(cutCentre[2], 17.5 + 2.5, 1e-6) && near(Math.abs(cutCentre[0]), 18, 1e-6), JSON.stringify(cutBox));
const door = expand({ kind: "pocket", faceIndex: 5, shape: "arch", at: { u: 0, v: -8.5 }, width: 10, height: 18, depth: 1.5 }, faceCtx, toPart) as Piece[];
check("an arch is a box and a cylinder", door.length === 2 && door[0]!.spec.primitive === "box" && door[1]!.spec.primitive === "cylinder");
check("a short arch is refused", "reason" in (expand({ kind: "pocket", faceIndex: 5, shape: "arch", width: 10, height: 4, depth: 1 }, faceCtx, toPart) as object));
const sill = expand({ kind: "boss", faceIndex: 5, at: { u: 18, v: -3.25 }, width: 12, height: 1.5, depth: 2 }, faceCtx, toPart) as Piece[];
check("a boss is one fuse", sill.length === 1 && sill[0]!.op === "fuse");
const tiles = expand({ kind: "texture", faceIndex: 5, pattern: "brick", pitch: [10, 7] }, faceCtx, toPart) as Piece[];
const lines = tiles.filter((piece) => Math.max(...piece.spec.size) >= 59);
check("a brick texture has row grooves and staggered joints", lines.length === 4 && tiles.length > lines.length, `${tiles.length} ${lines.length}`);
// D4. A small pitch is refused before any groove is made, and a groove as wide as the pitch is refused.
const fine = expand({ kind: "texture", faceIndex: 5, pattern: "lines", pitch: [0.02, 0.02], grooveWidth: 0.01 }, faceCtx, toPart);
check("a texture of thousands of grooves is refused before it is made", "reason" in fine && /about \d+ grooves, more than 400/.test(fine.reason), JSON.stringify(fine).slice(0, 120));
const wide = expand({ kind: "texture", faceIndex: 5, pattern: "lines", pitch: [5, 1], grooveWidth: 1 }, faceCtx, toPart);
check("a groove as wide as the pitch is refused", "reason" in wide && wide.reason === "A groove must be narrower than the pitch.", JSON.stringify(wide).slice(0, 120));
const crowd = expand({ kind: "pattern", linear: { step: [1, 0, 0], count: 100000 }, op: { kind: "boolean", op: "cut", primitive: "box", dx: 1, dy: 1, dz: 1 } }, globalCtx, toPart);
check("a pattern of 100000 copies is refused before its motions are made", "reason" in crowd && crowd.reason === "A pattern makes at most 400 copies.", JSON.stringify(crowd).slice(0, 120));
check("a texture without a face or region is refused", "reason" in (expand({ kind: "texture", pitch: [5, 5] }, globalCtx, toPart) as object));
const picked = expand({ kind: "pocket", face: { normal: [0, -1, 0] }, at: { u: 18, v: 2.5 }, width: 10, height: 10, depth: 1.5 }, faceCtx, toPart) as Piece[];
check("a face selector picks the face", Array.isArray(picked) && JSON.stringify(picked[0]!.spec) === JSON.stringify(window[0]!.spec));
check("face and faceIndex together are refused", "reason" in (expand({ kind: "pocket", face: { normal: [0, -1, 0] }, faceIndex: 5, width: 1, height: 1, depth: 1 }, faceCtx, toPart) as object));
check("a missing face is refused", "reason" in (expand({ kind: "pocket", faceIndex: 9, width: 1, height: 1, depth: 1 }, faceCtx, toPart) as object));

// Surface arrays and ribs, kept to a face's outline. The gable is a triangle on the -Y plane: base 40 wide at v = 0, apex at v = 24.
const gableTris = [-20, 0, 20, 0, 0, 24];
const gableCtx: ExpandContext = {
  plane: GLOBAL_WORKPLANE,
  face: (index) => index === 7 ? { plane: front, extent: { u: [-20, 20], v: [0, 24], outline: gableTris } } : index === 5 ? { plane: front, extent: { u: [-30, 30], v: [-17.5, 17.5], outline: [-30, -17.5, 30, -17.5, 30, 17.5, -30, -17.5, 30, 17.5, -30, 17.5] } } : { reason: "That face is not on this solid." },
  faceBy: () => ({ reason: "none" }),
};
// Back to face U, V: the -Y frame's U is +X, V is +Z, origin at z = 17.5.
const uvOf = (spec: PrimitiveSpec): [number, number] => {
  const mid = spec.primitive === "box" ? [spec.size[0] / 2, spec.size[1] / 2, spec.size[2] / 2] : [0, 0, spec.height / 2];
  return [spec.origin[0] + mid[0]!, spec.origin[2] + mid[2]! - 17.5];
};
const insideGable = ([u, v]: [number, number], pad = 0) => v >= pad - 1e-6 && v <= 24 && Math.abs(u) <= 20 * (1 - v / 24) - pad * 1.2 + 1e-6;
const studs = expand({ kind: "array", faceIndex: 7, cell: { shape: "rect", width: 4, height: 3 }, pitch: [6, 5], depth: 1 }, gableCtx, toPart) as Piece[];
check("an array on a gable keeps every tile inside the triangle", Array.isArray(studs) && studs.length > 4 && studs.every((piece) => insideGable(uvOf(piece.spec))), JSON.stringify(Array.isArray(studs) ? studs.map((p) => uvOf(p.spec)) : studs));
const fullWall = expand({ kind: "array", faceIndex: 5, cell: { shape: "rect", width: 4, height: 3 }, pitch: [6, 5], depth: 1 }, gableCtx, toPart) as Piece[];
check("a rectangle holds more tiles than a triangle", fullWall.length > studs.length * 2, `${fullWall.length} vs ${studs.length}`);
const tile = studs[0]!.spec;
check("raised tiles fuse and sink 0.2 mm into the face", studs.every((piece) => piece.op === "fuse") && near(tile.origin[1] + tile.size[1] / 2, -20 - (1 - 0.2) / 2, 1e-6), JSON.stringify(tile));
const loose = expand({ kind: "array", faceIndex: 7, cell: { shape: "rect", width: 4, height: 3 }, pitch: [6, 5], depth: 1, fit: "centre" }, gableCtx, toPart) as Piece[];
check("fit centre lets edge tiles in", loose.length > studs.length);
const bricks = expand({ kind: "array", faceIndex: 5, cell: { shape: "rect", width: 9, height: 4 }, pitch: [10, 5], stagger: true, depth: 0.6 }, gableCtx, toPart) as Piece[];
const rowOf = (v: number) => Math.round(v / 5);
const offsets = new Set(bricks.map((piece) => { const [u, v] = uvOf(piece.spec); return `${Math.abs(rowOf(v)) % 2}:${(((u % 10) + 10) % 10).toFixed(3)}`; }));
check("stagger moves every other row half a pitch", offsets.has("0:0.000") && offsets.has("1:5.000"), [...offsets].join(" "));
const hexes = expand({ kind: "array", faceIndex: 5, cell: { shape: "polygon", sides: 6, across: 5 }, pitch: [5, 4.4], stagger: true, depth: 0.5, op: "cut" }, gableCtx, toPart) as Piece[];
check("a hex array cuts polygon cells", hexes.length > 20 && hexes.every((piece) => piece.op === "cut" && piece.spec.primitive === "polygon" && piece.spec.sides === 6));
const turnedGrid = expand({ kind: "array", faceIndex: 5, cell: { shape: "rect", width: 4, height: 4 }, pitch: [8, 8], angleDeg: 45, depth: 1 }, gableCtx, toPart) as Piece[];
check("a turned array turns its cells", turnedGrid.length > 0 && turnedGrid.every((piece) => near(Math.abs(piece.spec.turn[1]), 45, 1e-6) || near(Math.abs(piece.spec.turn[2]), 45, 1e-6) || near(Math.abs(piece.spec.turn[0]), 45, 1e-6)), JSON.stringify(turnedGrid[0]?.spec.turn));
check("a cell too big for the face is a sentence", "reason" in (expand({ kind: "array", faceIndex: 7, cell: { shape: "circle", diameter: 50 }, pitch: [60, 60], depth: 1 }, gableCtx, toPart) as object));

const gableRibs = expand({ kind: "ribs", faceIndex: 7, width: 1.2, pitch: 4, depth: 2, margin: 0.5 }, gableCtx, toPart) as Piece[];
const ribRows = gableRibs.map((piece) => ({ v: uvOf(piece.spec)[1], length: piece.spec.size[0] })).sort((a, b) => a.v - b.v);
check("ribs across a gable get shorter toward the apex", ribRows.length >= 4 && ribRows.every((row, i) => i === 0 || row.length < ribRows[i - 1]!.length), JSON.stringify(ribRows));
check("each rib ends a margin inside the triangle", gableRibs.every((piece) => {
  const [u, v] = uvOf(piece.spec);
  const half = piece.spec.size[0] / 2;
  return insideGable([u - half, v + 0.6], 0) && insideGable([u + half, v + 0.6], 0);
}), JSON.stringify(ribRows));
const uprights = expand({ kind: "ribs", faceIndex: 5, along: "v", width: 2, count: 5, depth: 3, margin: 2 }, gableCtx, toPart) as Piece[];
check("count spreads ribs evenly along V", uprights.length === 5 && uprights.every((piece) => near(piece.spec.size[0], 35 - 4, 1e-6)), JSON.stringify(uprights.map((p) => [uvOf(p.spec), p.spec.size])));
const grooves = expand({ kind: "ribs", faceIndex: 5, width: 0.8, pitch: 5, depth: 0.6, op: "cut", angleDeg: 30 }, gableCtx, toPart) as Piece[];
check("ribs with op cut are grooves at an angle", grooves.length > 5 && grooves.every((piece) => piece.op === "cut"));
check("ribs without a pitch or count are refused", "reason" in (expand({ kind: "ribs", faceIndex: 5, width: 1, depth: 1 }, gableCtx, toPart) as object));
const mirroredRibs = expand({ kind: "mirror", plane: "y", op: { kind: "ribs", faceIndex: 5, width: 1, count: 3, depth: 2 } }, gableCtx, toPart) as Piece[];
check("ribs mirror onto the opposite wall", mirroredRibs.length === 6 && mirroredRibs.slice(3).every((piece) => piece.spec.origin[1] > 0), JSON.stringify(mirroredRibs.slice(3).map((p) => p.spec.origin)));

// from: top and bottom measure from the face's edges, which do not move when a roof below hides the wall's foot.
const underEave = expand({ kind: "pocket", faceIndex: 5, from: "top", at: { u: 0, v: -5 }, width: 6, height: 4, depth: 1 }, gableCtx, toPart) as Piece[];
check("a pocket from the top edge sits that far below it", near(uvOf(underEave[0]!.spec)[1], 17.5 - 5, 1e-6), JSON.stringify(uvOf(underEave[0]!.spec)));
const band = expand({ kind: "array", faceIndex: 5, from: "top", region: { u: [-20, 20], v: [-4, -1] }, cell: { width: 1.5, height: 2 }, pitch: [4, 50], depth: 2 }, gableCtx, toPart) as Piece[];
check("an array band from the top edge stays in that band", band.length >= 9 && band.every((piece) => { const v = uvOf(piece.spec)[1]; return v >= 17.5 - 4 && v <= 17.5 - 1; }), JSON.stringify(band.map((p) => uvOf(p.spec))));
const footing = expand({ kind: "pocket", faceIndex: 5, from: "bottom", at: { u: 0, v: 6 }, width: 6, height: 12, depth: 1 }, gableCtx, toPart) as Piece[];
check("a door from the bottom edge stands on it", near(uvOf(footing[0]!.spec)[1], -17.5 + 6, 1e-6));
check("an unknown from is a sentence", "reason" in (expand({ kind: "pocket", faceIndex: 5, from: "middle", width: 1, height: 1, depth: 1 }, gableCtx, toPart) as object));

const ringMeasure = { shells: 3, before: { shells: 2 } };
check("a fuse that adds a closed shell is a separate piece", addsPiece({ kind: "boolean", op: "fuse" }, ringMeasure) && addsPiece({ kind: "join", op: "fuse" }, ringMeasure));
check("a cut, a shell, or a fuse with no new shell is not", !addsPiece({ kind: "boolean", op: "cut" }, ringMeasure) && !addsPiece({ kind: "shell" }, ringMeasure) && !addsPiece({ kind: "boolean", op: "fuse" }, { shells: 2, before: { shells: 2 } }) && !addsPiece({ kind: "boolean", op: "fuse" }, undefined));

const sliver = { solids: 2, shells: 2, before: { solids: 1, shells: 1 } };
check("a composite cut that splits off a piece is caught", cutsOffPiece({ kind: "boolean", op: "cut" }, sliver) && cutsOffPiece({ kind: "boolean", op: "cut" }, { solids: 1, shells: 2, before: { solids: 1, shells: 1 } }));
check("a fuse, or a cut that keeps one piece, is not", !cutsOffPiece({ kind: "boolean", op: "fuse" }, sliver) && !cutsOffPiece({ kind: "boolean", op: "cut" }, { solids: 1, shells: 1, before: { solids: 1, shells: 1 } }) && !cutsOffPiece({ kind: "boolean", op: "cut" }, undefined));

// Schema refusals name the right field.
check("size on a boolean names dx, dy, dz", (validateTool("model_apply", { op: { kind: "boolean", op: "fuse", primitive: "box", size: [1, 2, 3] } }) ?? "").includes("Use dx, dy, dz"));
check("a nested unknown field is refused", (validateTool("model_apply", { op: { kind: "pattern", op: { kind: "boolean", op: "cut", primitive: "box", center: [0, 0, 0] }, linear: { step: [1, 0, 0], count: 2 } } }) ?? "").includes("Use centre"));
check("model_probe refuses a composite", (validateTool("model_probe", { op: { kind: "pocket", depth: 1 } }) ?? "").includes("several steps"));
check("a batch op is checked by index", (validateTool("model_apply_batch", { ops: [{ kind: "hole", diameterMm: 3, through: true }, { kind: "hole", diam: 3 }] }) ?? "").startsWith("ops[1].diam"));

// The session, end to end.
const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);

const info = await call("session_info");
const model = info.model as { composite?: string[]; guides?: string[] };
check("session_info lists composite ops and guides", !!model?.composite?.includes("texture") && !!model?.guides?.includes("ops"), JSON.stringify(info.model));
const topics = await call("guide");
check("guide lists its topics", JSON.stringify(topics).includes("compose"));
const opsGuide = await call("guide", { topic: "ops" });
check("guide returns the op reference", typeof opsGuide.text === "string" && (opsGuide.text as string).includes("pocket"));
check("an unknown guide names the topics", (await call("guide", { topic: "nope" })).ok === false);

const made = await call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 35 });
const object = String(made.object);
const bounds = made.bounds as { min: number[]; max: number[] };
check("solid_new returns bounds", nearAll(bounds.min, [-30, -20, 0]) && nearAll(bounds.max, [30, 20, 35]), JSON.stringify(made));

const roof = { kind: "boolean", op: "fuse", primitive: "box", centre: [0, 0, 35], dx: 60, dy: 33.94, dz: 33.94, turn: [45, 0, 0], label: "roof" };
const unprobed = await call("model_apply", { object, op: roof });
check("a plain apply without a probe is refused", unprobed.ok === false && String(unprobed.reason).includes("probe: true"));
const roofed = await call("model_apply", { object, op: roof, probe: true });
check("probe: true checks and applies in one call", roofed.ok === true && roofed.label === "roof", JSON.stringify(roofed));
const stored = roofed.stored as Record<string, unknown>;
check("the echo leaves out fields a box does not read", stored.radius === undefined && stored.height === undefined && Array.isArray(stored.size));

const historyBefore = ((await call("model_history", { object })).nodes as unknown[]).length;
const windows = await call("model_apply", {
  object,
  op: { kind: "mirror", plane: "x", label: "front windows", op: { kind: "pocket", faceIndex: 5, at: { u: 18, v: 2.5 }, width: 10, height: 10, depth: 1.5, bars: { vertical: 1, horizontal: 1 } } },
});
check("a mirrored barred window is one group", windows.ok === true && windows.applied === 1 && windows.label === "front windows", JSON.stringify(windows));
const historyAfter = (await call("model_history", { object })).nodes as { id: string; label: string }[];
check("the composite is one labelled row", historyAfter.length === historyBefore + 1 && historyAfter.some((node) => node.label === "front windows"), JSON.stringify(historyAfter.map((n) => n.label)));
const windowFile = await call("project_save", { name: "windows.lime" });
const windowDoc = windowFile.ok === true ? JSON.parse(readFileSync(join(workspace, "windows.lime"), "utf8")) as { objects?: { modelTree?: { nodes?: { op?: { kind?: string; steps?: unknown[]; source?: { kind?: string } } | null }[] } }[] } : {};
const windowGroup = windowDoc.objects?.[0]?.modelTree?.nodes?.map((node) => node.op).find((op) => op?.kind === "group");
check("the window group keeps the six pieces and the mirror that was typed", windowGroup?.steps?.length === 6 && windowGroup.source?.kind === "mirror", JSON.stringify(windowGroup?.source));
const undone = await call("model_undo", { object });
check("one undo takes the whole composite back", undone.ok === true && undone.node === roofed.node && undone.group === "front windows", JSON.stringify(undone));
const redone = await call("model_redo", { object });
check("one redo brings it all again", redone.ok === true && redone.node === windows.node, JSON.stringify(redone));
const back = await call("model_goto", { object, node: "roof" });
check("model_goto takes a step label", back.ok === true && back.node === roofed.node, JSON.stringify(back));
const forward = await call("model_goto", { object, node: "front windows" });
check("model_goto takes a composite label", forward.ok === true && forward.node === windows.node, JSON.stringify(forward));

const rolled = await call("model_apply_batch", {
  object,
  label: "doomed",
  ops: [
    { kind: "pocket", faceIndex: 5, at: { u: 0, v: -8 }, width: 10, height: 18, depth: 1.5 },
    { kind: "boolean", op: "cut", primitive: "box", origin: [500, 500, 500], dx: 1, dy: 1, dz: 1 },
  ],
});
check("a refusal rolls the batch back", rolled.ok === false && rolled.rolledBack === true && (rolled.failed as { index: number }).index === 1 && rolled.node === windows.node, JSON.stringify(rolled));
const kept = await call("model_apply_batch", {
  object,
  onError: "stop",
  ops: [
    { kind: "pocket", faceIndex: 5, at: { u: 0, v: -8 }, width: 10, height: 18, depth: 1.5 },
    { kind: "boolean", op: "cut", primitive: "box", origin: [500, 500, 500], dx: 1, dy: 1, dz: 1 },
  ],
});
check("onError stop keeps what applied", kept.ok === false && kept.applied === 1 && kept.rolledBack === undefined, JSON.stringify(kept));

const bySelector = await call("model_apply", { object, op: { kind: "pocket", face: { normal: [0, -1, 0] }, at: { u: 0, v: 0 }, width: 8, height: 8, depth: 1 } });
check("the session resolves a face selector", bySelector.ok === true && bySelector.applied === 1, JSON.stringify(bySelector));
const noFace = await call("model_apply", { object, op: { kind: "pocket", face: { normal: [0, -1, 0], nearby: [0, 0, 0] }, width: 8, height: 8, depth: 1 } });
check("an unknown selector field is refused", noFace.ok === false && JSON.stringify(noFace).includes("nearby"), JSON.stringify(noFace));
// Kernel ops through the MCP: a sketch on a face from its corner, a revolve, a shell by selector, and step edges.
const gable = await call("model_apply", { object, probe: true, op: { kind: "extrude", op: "fuse", face: { normal: [0, -1, 0] }, from: "corner", profile: [[0, 0], [20, 0], [10, 8]], depth: 2, label: "gable" } });
const gableOp = gable.stored as { kind?: string; origin?: number[]; profile?: number[][]; depth?: number };
check("an extrude on a face from its corner applies", gable.ok === true && gableOp.kind === "extrude" && gableOp.profile?.length === 3 && gableOp.depth === 2, JSON.stringify(gable));
check("from: corner puts the profile origin at the face's min corner", nearAll(gableOp.origin ?? [], [-30, -20, 0], 1e-6), JSON.stringify(gableOp.origin));
const knob = await call("model_apply", { object, probe: true, op: { kind: "revolve", op: "fuse", profile: [[0, 0], [2, 0], [2, 3], [0, 3]], angleDeg: 360 } });
check("a revolve applies", knob.ok === true && (knob.stored as { kind?: string }).kind === "revolve", JSON.stringify(knob));
const hollow = await call("model_apply", { object, probe: true, op: { kind: "shell", thickness: 2, openFaces: [{ normal: [0, 0, -1] }] } });
check("a shell takes a face selector for its open face", hollow.ok === true && JSON.stringify((hollow.stored as { openFaces?: number[] }).openFaces) === "[1]", JSON.stringify(hollow));
const rounded = await call("model_apply", { object, probe: true, op: { kind: "fillet", edges: { fromNode: "gable", filter: "convex" }, size: 0.5 } });
const roundedEdges = (rounded.stored as { edges?: { fromNode?: number; filter?: string }[] }).edges ?? [];
check("a fillet takes the edges a labelled step made", rounded.ok === true && roundedEdges[0]?.fromNode === Number(String(gable.node).slice(5)) && roundedEdges[0]?.filter === "convex", JSON.stringify(rounded));
const shortProfile = await call("model_apply", { object, probe: true, op: { kind: "extrude", profile: [[0, 0], [1, 0], [1, 1]], depth: 0 } });
check("an extrude with no depth is a sentence", shortProfile.ok === false && String(shortProfile.reason).includes("depth"), JSON.stringify(shortProfile));
const studded = await call("model_apply", { object, op: { kind: "array", face: { normal: [0, 0, 1] }, cell: { shape: "circle", diameter: 3 }, pitch: [5, 5], fit: "inside", depth: 1.5, margin: 1, label: "studs" } });
check("an array through the session is one group and one undo step", studded.ok === true && studded.applied === 1 && studded.label === "studs", JSON.stringify(studded));
const ribbed = await call("model_apply", { object, op: { kind: "ribs", face: { normal: [0, -1, 0] }, along: "v", width: 1.5, pitch: 6, depth: 2, label: "ribs" } });
check("ribs through the session are one group", ribbed.ok === true && ribbed.applied === 1 && ribbed.label === "ribs", JSON.stringify(ribbed));
const undoRibs = await call("model_undo", { object });
check("one undo takes all the ribs back", undoRibs.ok === true && undoRibs.group === "ribs", JSON.stringify(undoRibs));
const params = await call("model_params", { set: { wallW: 60, half: "wallW / 2" } });
check("model_params evaluates in order", (params.params as Record<string, number>).half === 30, JSON.stringify(params));
const badParam = await call("model_params", { set: { "2bad": 1 } });
check("a bad parameter name is refused", badParam.ok === false);
// model_goto restores the step's solid. This cut is typed with parameters; the check is the numbers, not the mesh.
const exprApply = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", origin: ["half - 25", 1, 1], dx: "wallW / 10", dy: 2, dz: 1 } });
check("op numbers may be expressions", exprApply.ok === true && JSON.stringify(exprApply.typed).includes("[5,1,1]") && JSON.stringify(exprApply.typed).includes("[6,2,1]"), JSON.stringify(exprApply));
const badExpr = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", dx: "nope * 2" } });
check("an unknown name in an op is a refusal", badExpr.ok === false && String(badExpr.reason).includes("nope"), JSON.stringify(badExpr));

const built = await call("model_build", {
  name: "shed",
  params: { w: 30, d: 20, h: 15 },
  base: { primitive: "box", dx: "w", dy: "d", dz: "h" },
  ops: [
    { kind: "boolean", op: "fuse", primitive: "box", centre: [0, 0, "h"], dx: "w", dy: "d / sqrt(2)", dz: "d / sqrt(2)", turn: [45, 0, 0], label: "roof" },
    { kind: "texture", faceIndex: 4, pattern: "lines", pitch: [5, 5], label: "siding" },
  ],
});
check("model_build makes, edits, and commits in one call", built.ok === true && built.committed === true && typeof built.object === "string" && built.applied === 2, JSON.stringify(built));

// A fountain-sized build: many composites, about 325 pieces, opening in the app as about 25 rows.
const fountainOps = Array.from({ length: 24 }, (_, i) => ({
  kind: "pattern",
  label: `band ${i + 1}`,
  linear: { step: [0.4, 0, 0], count: i < 13 ? 14 : 13 },
  op: { kind: "boolean", op: "cut", primitive: "box", origin: [-8, -8, 18], dx: 0.3, dy: 0.3, dz: 0.3 },
}));
const fountain = await call("model_build", { name: "fountain", base: { primitive: "box", dx: 40, dy: 40, dz: 20 }, ops: fountainOps });
const fountainHistory = ((await call("model_history", { object: fountain.object, limit: 100 })).nodes as { label: string }[]) ?? [];
const fountainSave = await call("project_save", { name: "fountain.lime" });
const fountainDoc = fountainSave.ok === true ? JSON.parse(readFileSync(join(workspace, "fountain.lime"), "utf8")) as { objects?: { name?: string; modelTree?: unknown }[] } : {};
const fountainRaw = fountainDoc.objects?.find((row) => row.name === "fountain")?.modelTree;
const fountainSaved = readSavedTree(fountainRaw);
const fountainRoot = fountainSaved?.rootPrimitive ? { kind: "primitive" as const, solid: fountainSaved.rootPrimitive } : null;
const fountainTree = fountainSaved && fountainRoot ? withSavedNames(loadedTree(fountainSaved, "fountain", fountainRoot, "fountain", null, () => undefined)) : null;
const fountainRows = fountainTree ? presentedRows(historyLayout(fountainTree).rows, new Set()) : [];
const fountainPieces = fountainTree ? [...fountainTree.nodes.values()].reduce((sum, node) => sum + (node.op?.kind === "group" ? node.op.steps.length : 0), 0) : 0;
check(
  "a fountain of composites opens as about 25 rows, not one per piece",
  fountain.ok === true && fountain.applied === 24 && fountainHistory.length === 25 && fountainRows.length >= 20 && fountainRows.length <= 35 && fountainPieces === 325 && fountainRows.every((row) => !/ \d+\/\d+$/.test(row.label)),
  JSON.stringify({ applied: fountain.applied, history: fountainHistory.length, rows: fountainRows.length, pieces: fountainPieces, labels: fountainRows.map((row) => row.label) }),
);

// A join without keepTool takes the tool off the plate, as the desktop does, and the save keeps its tree.
const host = await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
const roofTool = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
const keptTool = await call("solid_new", { primitive: "box", dx: 6, dy: 6, dz: 6 });
const joinedRoof = await call("model_apply", { object: host.object, probe: true, op: { kind: "join", op: "fuse", toolObject: roofTool.object } });
const listed = ((await call("plate_list", {})).objects as { object?: string; id?: string }[]).map((row) => row.object ?? row.id);
check("a join takes its tool off the plate", joinedRoof.ok === true && joinedRoof.toolLeftPlate === roofTool.object && !listed.includes(String(roofTool.object)) && listed.includes(String(host.object)), JSON.stringify({ joinedRoof, listed }));
const keepJoin = await call("model_apply", { object: host.object, probe: true, op: { kind: "join", op: "fuse", toolObject: keptTool.object, keepTool: true } });
const listedAfter = ((await call("plate_list", {})).objects as { object?: string; id?: string }[]).map((row) => row.object ?? row.id);
check("keepTool leaves the tool on the plate", keepJoin.ok === true && keepJoin.toolLeftPlate === undefined && listedAfter.includes(String(keptTool.object)), JSON.stringify(keepJoin));
const joinSave = await call("project_save", { name: "joined.lime" });
const joinedDoc = joinSave.ok === true ? JSON.parse(readFileSync(join(workspace, "joined.lime"), "utf8")) as { modelTools?: { id: string }[]; objects?: { id: string }[] } : {};
check("the save keeps the tool's tree as a model tool, not a plate object", (joinedDoc.modelTools ?? []).some((tool) => tool.id === roofTool.object) && !(joinedDoc.objects ?? []).some((row) => row.id === roofTool.object), JSON.stringify({ tools: joinedDoc.modelTools?.map((t) => t.id), objects: joinedDoc.objects?.map((o) => o.id) }));

writeFileSync(join(workspace, "taken.lime"), "{}");
const refusedSave = await call("project_save", { name: "taken.lime", ifExists: "refuse" });
check("project_save can refuse to replace a file", refusedSave.ok === false && String(refusedSave.reason).includes("already"), JSON.stringify(refusedSave));
const saved = await call("project_save", { name: "fresh.lime", ifExists: "refuse" });
check("project_save writes a new name", saved.ok === true, JSON.stringify(saved));

// --- D24. A composite on a part moved in model space lands where it does on the unmoved part: the face is read in
// model space, as the app reads it, and the steps go to the solid's frame once.
async function pocketSteps(place: Record<string, unknown> | null, name: string): Promise<number[][]> {
  const own = new Session(fakeEngine());
  const made = await own.call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 35 });
  if (place) await own.call("model_place", { object: made.object, ...place });
  const pocket = await own.call("model_apply", { object: made.object, op: { kind: "pocket", faceIndex: 5, at: { u: 6, v: 3 }, width: 10, height: 8, depth: 2 } });
  check(`the pocket applies (${name})`, pocket.ok === true, JSON.stringify(pocket));
  await own.call("project_save", { name });
  const doc = JSON.parse(readFileSync(join(workspace, name), "utf8")) as { objects?: { modelTree?: { nodes?: { op?: { kind?: string; steps?: { origin?: number[]; turn?: number[] }[] } | null }[] } }[] };
  const group = doc.objects?.[0]?.modelTree?.nodes?.map((node) => node.op).find((op) => op?.kind === "group");
  return (group?.steps ?? []).map((step) => [...(step.origin ?? []), ...(step.turn ?? [])]);
}
const still = await pocketSteps(null, "pocket-still.lime");
const moved = await pocketSteps({ x: 40, y: -15, z: 5, turnZ: 90 }, "pocket-moved.lime");
check("a pocket on a moved part is stored as on the part where it was", still.length > 0 && still.length === moved.length && still.every((row, i) => nearAll(row, moved[i]!, 1e-3)), JSON.stringify({ still, moved }));

async function faceBox(place: Record<string, unknown> | null, name: string, placeAfter = false): Promise<unknown> {
  const own = new Session(fakeEngine());
  const made = await own.call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 35 });
  if (place && !placeAfter) await own.call("model_place", { object: made.object, ...place });
  await own.call("workplane_set", { object: made.object, faceIndex: 5 });
  if (place && placeAfter) await own.call("model_place", { object: made.object, ...place });
  const hole = await own.call("model_apply", { object: made.object, op: { kind: "boolean", op: "cut", primitive: "box", dx: 4, dy: 4, dz: 2 }, probe: true });
  check(`the box applies (${name})`, hole.ok === true, JSON.stringify(hole));
  await own.call("project_save", { name });
  const doc = JSON.parse(readFileSync(join(workspace, name), "utf8")) as { objects?: { modelTree?: { nodes?: { op?: { kind?: string; origin?: number[]; turn?: number[] } | null }[] } }[] };
  const op = doc.objects?.[0]?.modelTree?.nodes?.map((node) => node.op).find((row) => row?.kind === "boolean");
  return op ? [...(op.origin ?? []), ...(op.turn ?? [])] : null;
}
const boxStill = (await faceBox(null, "box-still.lime")) as number[] | null;
const boxMoved = (await faceBox({ x: 40, y: -15, z: 5, turnZ: 90 }, "box-moved.lime")) as number[] | null;
const boxMovedAfter = (await faceBox({ x: 40, y: -15, z: 5, turnZ: 90 }, "box-moved-after.lime", true)) as number[] | null;
check("a face workplane moves with its part when the part is moved after it", !!boxStill && !!boxMovedAfter && nearAll(boxStill, boxMovedAfter, 1e-3), JSON.stringify({ boxStill, boxMovedAfter }));
{
  const doc = (name: string) => JSON.parse(readFileSync(join(workspace, name), "utf8")) as { objects?: { workplane?: unknown }[] };
  check("the file keeps the face workplane in the part's own frame, moved or not", JSON.stringify(doc("box-still.lime").objects?.[0]?.workplane) === JSON.stringify(doc("box-moved.lime").objects?.[0]?.workplane), JSON.stringify([doc("box-still.lime").objects?.[0]?.workplane, doc("box-moved.lime").objects?.[0]?.workplane]));
}
check("a box on a moved part's face workplane is stored as on the part where it was", !!boxStill && !!boxMoved && nearAll(boxStill, boxMoved, 1e-3), JSON.stringify({ boxStill, boxMoved }));

// --- D20. A composite whose every step misses the part is refused, not applied as nothing.
{
  const own = new Session(fakeEngine());
  const made = await own.call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 35 });
  const away = await own.call("model_apply", { object: made.object, op: { kind: "pattern", op: { kind: "boolean", op: "cut", primitive: "box", origin: [500, 0, 0], dx: 2, dy: 2, dz: 2 }, linear: { step: [10, 0, 0], count: 3 } } });
  check("a pattern that misses everywhere is refused", away.ok === false && JSON.stringify(away).includes("None of its 3 steps changes the part."), JSON.stringify(away));
}

// --- D28. A feature typed with a face selector is stored with the face it found, so the app can edit it.
{
  const own = new Session(fakeEngine());
  const made = await own.call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 35 });
  const pocket = await own.call("model_apply", { object: made.object, op: { kind: "pocket", face: { normal: [0, -1, 0] }, at: { u: 0, v: 0 }, width: 8, height: 8, depth: 1 } });
  check("the selector pocket applies", pocket.ok === true, JSON.stringify(pocket));
  await own.call("project_save", { name: "selector.lime" });
  const doc = JSON.parse(readFileSync(join(workspace, "selector.lime"), "utf8")) as { objects?: { modelTree?: { nodes?: { op?: { kind?: string; source?: Record<string, unknown> } | null }[] } }[] };
  const source = doc.objects?.[0]?.modelTree?.nodes?.map((node) => node.op).find((op) => op?.kind === "group")?.source;
  check("the stored pocket names its face by index", typeof source?.faceIndex === "number" && source.face === undefined, JSON.stringify(source));
}

// --- D39. An MCP pattern or mirror row reads as the app's does.
{
  const own = new Session(fakeEngine());
  const made = await own.call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 35 });
  const cut = { kind: "boolean", op: "cut", primitive: "box", origin: [-25, -15, 30], dx: 2, dy: 2, dz: 6 };
  const row = await own.call("model_apply", { object: made.object, op: { kind: "pattern", op: cut, linear: { step: [5, 0, 0], count: 3 } } });
  const mirrored = await own.call("model_apply", { object: made.object, op: { kind: "mirror", plane: "x", op: cut } });
  const labels = ((await own.call("model_history", { object: made.object })).nodes as { label: string }[]).map((node) => node.label);
  check("pattern and mirror rows read as the app's", row.ok === true && mirrored.ok === true && labels.includes("Pattern × 3") && labels.includes("Mirror across X"), JSON.stringify(labels));
}

if (failed > 0) {
  console.error(`compose: ${failed} failed`);
  process.exit(1);
}
console.log("compose: ok");
