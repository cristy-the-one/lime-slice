/**
 * Split to print through the MCP server against the stand-in engine (docs/plan-split-connectors.md, milestone 3):
 * model_probe's plan, probe, apply and commit into plate objects, the history row, undo, model_edit's rebuild of every
 * piece, this milestone's refusals, and guide {kind}. The real kernel's run is in occt.test.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { CONNECTORS_LATER, fitPrinter, PROFILE_LATER, RESIN_LATER } from "../src/modeling/partition.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-partition-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const near = (a: unknown, b: number, tol = 1e-6) => typeof a === "number" && Math.abs(a - b) <= tol;

const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);
const plate = async () => ((await call("plate_list", {})).objects as { object: string; name: string; bboxMm: { min: number[]; max: number[] } }[]);

const info = await call("session_info", {});
check("the plate's printer is the Lime 220", info.printer === "Lime 220", JSON.stringify(info.printer));
check("session_info lists partition among the ops", ((info.model as { ops: string[] }).ops ?? []).includes("partition"), JSON.stringify(info.model));

// A 500 mm bar: solid_new stands it centred on X and Y, from Z 0.
const bar = await call("solid_new", { primitive: "box", dx: 500, dy: 20, dz: 20 });
const object = String(bar.object);

// --- Plan: the planner's own proposal for the bar on the Lime 220, with no kernel call.
const calls = engine.calls.length;
const plan = await call("model_probe", { object, op: { kind: "partition" }, plan: true });
const box = { min: [-250, -10, 0] as [number, number, number], max: [250, 10, 20] as [number, number, number] };
const expected = fitPrinter({ box, target: { printer: "lime-220", process: "fdm", volumeMm: [220, 220, 250] }, marginMm: 5, maxPieces: 12, printerName: "Lime 220" });
const cuts = plan.cuts as { origin: number[]; normal: number[]; u: number[] }[];
check("a plan makes no kernel call", engine.calls.length === calls, engine.calls.slice(calls).join(","));
check("the plan is three pieces, as the planner says", plan.ok === true && plan.plan === true && plan.pieces === 3 && expected.pieces === 3, JSON.stringify(plan));
check(
  "its cuts are the planner's, across X at a third and two thirds",
  cuts.length === 2 && cuts.every((cut, i) => near(cut.origin[0], expected.cuts[i]!.origin[0], 1e-4) && cut.normal[0] === 1) && near(cuts[0]!.origin[0], -250 + 500 / 3, 1e-4) && near(cuts[1]!.origin[0], -250 + 1000 / 3, 1e-4),
  JSON.stringify(cuts),
);
check("with the planner's sentence", JSON.stringify(plan.notes) === JSON.stringify(expected.notes) && plan.reason === "This part is 500 mm along X. The Lime 220 bed fits 210 mm. Two cuts are proposed.", JSON.stringify(plan.notes));
check("the target is the plate's printer, with its margin and Max pieces", JSON.stringify(plan.target) === JSON.stringify({ printer: "lime-220", process: "fdm", volumeMm: [220, 220, 250] }) && plan.bedMarginMm === 5 && plan.maxPieces === 12, JSON.stringify(plan));
const few = await call("model_probe", { object, op: { kind: "partition", maxPieces: 2 }, plan: true });
check("a plan past Max pieces proposes nothing and says why", few.pieces === 1 && (few.cuts as unknown[]).length === 0 && few.reason === "This part would take 3 pieces. Max pieces is 2. No cuts are proposed.", JSON.stringify(few));
const notPartition = await call("model_probe", { object, op: { kind: "scale", factor: 2 }, plan: true });
check("plan is for a partition", notPartition.ok === false && notPartition.reason === "plan: true plans a partition. Other kinds are probed without it.", JSON.stringify(notPartition));

// --- Refusals: the kernel does not build these yet. The solid is unchanged and nothing is cut.
const op = plan.op as Record<string, unknown>;
const refusals: [string, Record<string, unknown>, string][] = [
  ["a lap profile", { ...op, cuts: [{ ...cuts[0]!, profile: { kind: "lap" } }] }, PROFILE_LATER],
  ["connectors on", { ...op, cuts: [{ ...cuts[0]!, connectors: { on: true } }] }, CONNECTORS_LATER],
  ["a resin target", { ...op, target: { printer: "formlabs-form-4", process: "resin", volumeMm: [200, 125, 210] } }, RESIN_LATER],
  ["no cuts", { kind: "partition", cuts: [] }, "A partition needs at least one cut. model_probe with plan: true proposes them."],
];
for (const [what, typed, sentence] of refusals) {
  const before = engine.calls.length;
  const probed = await call("model_probe", { object, op: typed });
  const applied = await call("model_apply", { object, op: typed, probe: true });
  check(`${what} is refused with a sentence`, probed.ok === false && probed.reason === sentence && applied.ok === false && applied.reason === sentence, JSON.stringify(applied));
  check(`${what} calls no kernel`, engine.calls.length === before, engine.calls.slice(before).join(","));
}
const tooMany = await call("model_probe", { object, op: { ...op, maxPieces: 2 } });
check("more pieces than Max pieces is the kernel's sentence", tooMany.ok === false && tooMany.reason === "This cut makes 3 pieces. Max pieces is 2.", JSON.stringify(tooMany));
check("the bar is still one object", (await plate()).length === 1);

// --- Probe, apply, commit: three plate objects.
const probe = await call("model_probe", { object, op });
const parts = probe.pieces as { part: number; volumeMm3: number; min: number[]; max: number[] }[];
check("the probe cuts three pieces in order", probe.ok === true && probe.parts === 3 && parts.map((part) => part.part).join() === "1,2,3", JSON.stringify(probe));
check("each a third of the bar", parts.every((part) => near(part.volumeMm3, 200_000 / 3, 0.05)) && near(parts[0]!.min[0], -250, 1e-3) && near(parts[2]!.max[0], 250, 1e-3), JSON.stringify(parts));
check("the probe changes nothing", (await plate()).length === 1);
const parent = session.objects.find((row) => row.id === object)!;
parent.supportPaint.push({ p: [0, 0, 20], n: [0, 0, 1], r: 3, kind: "enforce" } as never);
parent.orient = [0, -1, 0, 1, 0, 0, 0, 0, 1];
const applied = await call("model_apply", { object, op });
const pieces = applied.pieces as string[];
check("apply makes two more plate objects", applied.ok === true && applied.parts === 3 && pieces.length === 2, JSON.stringify(applied));
check("the part keeps its plate id and the first piece", near(parent.solid?.volumeMm3, 200_000 / 3, 0.05) && parent.supportPaint.length === 1, JSON.stringify(parent.solid?.volumeMm3));
for (const [at, id] of pieces.entries()) {
  const piece = session.objects.find((row) => row.id === id)!;
  check(`piece ${at + 2} is named for its part number`, piece.name === `box part ${at + 2}`, piece.name);
  check(`piece ${at + 2} keeps the part's plate orientation and model pose`, JSON.stringify(piece.orient) === JSON.stringify(parent.orient) && JSON.stringify(piece.modelPose) === JSON.stringify(parent.modelPose));
  check(`piece ${at + 2} starts with no paint, seam, reinforcement or support edit`, piece.supportPaint.length + piece.seamPaint.length + piece.reinforcement.length + piece.supportEdits.length === 0 && piece.sim === undefined);
  check(`piece ${at + 2} roots its own tree at the cut`, piece.tree?.root.kind === "piece" && piece.tree.root.node === 1 && (piece.tree.root as { index?: number }).index === at + 2, JSON.stringify(piece.tree?.root));
}
const history = await call("model_history", { object });
const rows = history.nodes as { id: string; label: string }[];
check("the history row says the parts", rows.map((row) => row.label).join(" | ") === "box | Split to print, 3 parts", JSON.stringify(rows));
const committed = await call("model_commit", { object });
check("commit puts every piece on the plate and lays them out", committed.ok === true && JSON.stringify(committed.pieces) === JSON.stringify(pieces) && committed.arranged === true, JSON.stringify(committed));
const onPlate = await plate();
check("probe, apply, commit gives three plate objects", onPlate.length === 3 && onPlate.every((row) => row.bboxMm.max[0] > row.bboxMm.min[0]), JSON.stringify(onPlate.map((row) => row.object)));
const apart = onPlate.every((a, i) => onPlate.every((b, j) => i >= j || a.bboxMm.max[0] <= b.bboxMm.min[0] + 1e-6 || b.bboxMm.max[0] <= a.bboxMm.min[0] + 1e-6 || a.bboxMm.max[1] <= b.bboxMm.min[1] + 1e-6 || b.bboxMm.max[1] <= a.bboxMm.min[1] + 1e-6));
check("laid out, no two overlap", apart, JSON.stringify(onPlate.map((row) => row.bboxMm)));

// --- Undo takes the pieces off; redo brings them back.
const undone = await call("model_undo", { object });
check("undo returns the parent and takes the pieces off the plate", undone.ok === true && JSON.stringify(undone.piecesLeftPlate) === JSON.stringify(pieces) && (await plate()).length === 1, JSON.stringify(undone));
const redone = await call("model_redo", { object });
check("redo brings them back", redone.ok === true && JSON.stringify(redone.piecesBack) === JSON.stringify(pieces) && (await plate()).length === 3, JSON.stringify(redone));

// --- A later step on piece 2, then an edit of the cut (D9): two pieces now, piece 2 keeps its plate id and its step.
const drilled = await call("model_apply", { object: pieces[0], op: { kind: "hole", diameterMm: 2, through: true, origin: [-50, 0, 20], axis: [0, 0, -1] }, probe: true });
check("piece 2 takes a step of its own", drilled.ok === true, JSON.stringify(drilled));
const one = { kind: "partition", cuts: [{ origin: [0, 0, 10], normal: [1, 0, 0] }] };
const notProbed = await call("model_edit", { object, node: "node_1", op: one });
check("an edit is probed first", notProbed.ok === false && String(notProbed.reason).startsWith("Probe this edit first"), JSON.stringify(notProbed));
await call("model_probe", { object, op: one, node: "node_0" });
const edited = await call("model_edit", { object, node: "node_1", op: one });
check("the edit rebuilds the cut in two", edited.ok === true && edited.parts === 2 && JSON.stringify(edited.pieces) === JSON.stringify([pieces[0]]), JSON.stringify(edited));
const afterEdit = await plate();
check("the old third piece leaves the plate", afterEdit.length === 2 && !afterEdit.some((row) => row.object === pieces[1]), JSON.stringify(afterEdit.map((row) => row.object)));
check("its tree is closed in the engine", engine.calls.includes("close"));
const second = session.objects.find((row) => row.id === pieces[0])!;
const secondRoot = second.tree?.root as { kind: string; node?: number; index?: number } | undefined;
check("piece 2 is the new cut's piece", secondRoot?.kind === "piece" && `node_${secondRoot.node}` === edited.node && secondRoot.index === 2, JSON.stringify(secondRoot));
const secondRows = (await call("model_history", { object: pieces[0] })).nodes as { label: string; broken: string | false; current: boolean }[];
check("its hole, now off the piece, stays in its tree, broken, and its row says why", secondRows.length === 2 && secondRows[1]!.label.startsWith("Hole") && String(secondRows[1]!.broken).includes("missed") && secondRows[0]!.current, JSON.stringify(secondRows));
check("and the edit says so", ((edited.notes as string[] | undefined) ?? []).some((line) => line.includes("step 1 did not build on the new cut")), JSON.stringify(edited.notes));
const editedRows = ((await call("model_history", { object })).nodes as { label: string; current: boolean }[]);
check("the part's history has the new row, current, beside the old one", editedRows.map((row) => row.label).join(" | ") === "box | Split to print, 3 parts | Split to print, 2 parts" && editedRows[2]!.current, JSON.stringify(editedRows));
await call("model_probe", { object, op, node: "node_0" });
const back = await call("model_edit", { object, node: String(edited.node), op });
const backPieces = back.pieces as string[];
check("an edit back to three cuts gives three parts again, piece 2 still the same object", back.ok === true && back.parts === 3 && backPieces[0] === pieces[0] && backPieces.length === 2 && backPieces[1] !== pieces[1], JSON.stringify(back));
check("a new third piece joins the plate", (await plate()).length === 3);
const keptRows = (await call("model_history", { object: pieces[0] })).nodes as { label: string; broken: string | false }[];
check("the kept hole is tried again on the rebuilt piece, and builds", keptRows.length === 2 && keptRows[1]!.label.startsWith("Hole") && keptRows[1]!.broken === false, JSON.stringify(keptRows));

// --- Lay out places only the new pieces: an object already on the plate, where a whole-plate Arrange would start, stays.
const other = String((await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 })).object);
await call("object_place", { object: other, centreX: 15, centreY: 15 });
const otherBefore = (await plate()).find((row) => row.object === other)!.bboxMm;
const committedAgain = await call("model_commit", { object });
check("commit puts the rebuilt pieces on the plate", committedAgain.ok === true && (committedAgain.pieces as string[]).length === 2 && committedAgain.arranged === true, JSON.stringify(committedAgain));
const laidOut = await plate();
const otherAfter = laidOut.find((row) => row.object === other)!.bboxMm;
check("model_commit does not move an unrelated object", JSON.stringify(otherAfter) === JSON.stringify(otherBefore), `${JSON.stringify(otherBefore)} -> ${JSON.stringify(otherAfter)}`);
const clear = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) => a.max[0]! <= b.min[0]! + 1e-6 || b.max[0]! <= a.min[0]! + 1e-6 || a.max[1]! <= b.min[1]! + 1e-6 || b.max[1]! <= a.min[1]! + 1e-6;
check("and the new pieces clear it", (committedAgain.pieces as string[]).every((id) => clear(laidOut.find((row) => row.object === id)!.bboxMm, otherAfter)), JSON.stringify(laidOut.map((row) => [row.object, row.bboxMm])));
await call("object_remove", { object: other });

// --- Saved and opened again: the row and its pieces' plate objects come back.
const saved = await call("project_save", { name: "bar.lime" });
check("the project saves", saved.ok === true, JSON.stringify(saved));
const again = new Session(engine);
const opened = await again.call("project_open", { path: String(saved.path) });
const reopened = opened.objects as { object: string }[];
check("three objects open again", opened.ok === true && reopened.length === 3, JSON.stringify(opened));
const reopenedRows = (await again.call("model_history", { object: reopened[0]!.object })).nodes as { label: string }[];
check("the part's history keeps its rows", reopenedRows.slice(1).map((row) => row.label).join(" | ") === "Split to print, 3 parts | Split to print, 2 parts | Split to print, 3 parts", JSON.stringify(reopenedRows));

// --- guide {kind}: the op's full schema, on demand.
const guide = await call("guide", { kind: "partition" });
const schema = guide.schema as { required?: string[]; properties?: Record<string, unknown> };
check("guide {kind: partition} returns its schema", guide.ok === true && JSON.stringify(schema.required) === JSON.stringify(["kind"]) && ["cuts", "target", "orient", "arrange", "labels", "bedMarginMm", "maxPieces"].every((field) => field in (schema.properties ?? {})), JSON.stringify(guide));
check("with the guide's line for it", (guide.examples as string[]).some((line) => line.startsWith("partition (split to print):")), JSON.stringify(guide.examples));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("partition: ok");
