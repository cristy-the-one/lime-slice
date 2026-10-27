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
import { readFileSync } from "node:fs";
import { fitPrinter, KEYS_LATER, PROFILE_LATER } from "../src/modeling/partition.ts";
import { SUPPORT_NOTE } from "../src/modeling/partition-export.ts";
import { exportOnlyRefusal, FORMLABS_FORM_4 } from "../src/ui/machine-library.ts";
import { exportedCommit, exportedNote } from "./partition.ts";

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
  ["a key", { ...op, cuts: [{ ...cuts[0]!, connectors: { on: true, types: [{ type: "key" }] } }] }, KEYS_LATER],
  ["a dovetail", { ...op, cuts: [{ ...cuts[0]!, connectors: { on: true, types: [{ type: "dovetail" }] } }] }, KEYS_LATER],
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

// --- Milestone 3b: a 400 mm tall part cut for the Formlabs Form 4, kept in Model, and exported.
const refusedPrinter = await call("machine_select", { printerId: "formlabs-form-4", filamentId: "lime-pla" });
check("machine_select refuses the Form 4", refusedPrinter.ok === false && refusedPrinter.reason === exportOnlyRefusal("formlabs-form-4"), JSON.stringify(refusedPrinter));
check("the plate's printer is still the Lime 220", (await call("session_info", {})).printer === "Lime 220");
const listed = (await call("machine_list", {})).printers as { id: string }[];
check("machine_list does not list it", !listed.some((row) => row.id === "formlabs-form-4"), JSON.stringify(listed));
const tall = String((await call("solid_new", { primitive: "box", dx: 100, dy: 80, dz: 400 })).object);
const plateBefore = (await plate()).length;
const resinPlan = await call("model_probe", { object: tall, op: { kind: "partition", target: { printer: "formlabs-form-4" } }, plan: true });
const resinCuts = resinPlan.cuts as { origin: number[]; normal: number[] }[];
check("the Form 4 plan is three pieces across the height", resinPlan.ok === true && resinPlan.pieces === 3 && resinCuts.length === 2 && resinCuts.every((one) => one.normal[2] === 1) && near(resinCuts[0]!.origin[2], 400 / 3, 1e-4) && near(resinCuts[1]!.origin[2], 800 / 3, 1e-4), JSON.stringify(resinPlan));
check("it reads the Form 4's volume, not the plate's", resinPlan.reason === "This part is 400 mm along Z. The Formlabs Form 4 volume fits 190 mm. Two cuts are proposed." && JSON.stringify(resinPlan.target) === JSON.stringify({ printer: "formlabs-form-4", process: "resin", volumeMm: [200, 125, 210] }) && resinPlan.bedMarginMm === 10, JSON.stringify(resinPlan));
const resinOp = resinPlan.op as Record<string, unknown>;
check("the planner's op writes part numbers on", JSON.stringify(resinOp.labels) === JSON.stringify({ on: true, face: "cut", height: 4, depth: 0.4 }), JSON.stringify(resinOp.labels));
const resinProbe = await call("model_probe", { object: tall, op: resinOp });
check("the probe cuts three slabs", resinProbe.ok === true && resinProbe.parts === 3 && (resinProbe.pieces as { volumeMm3: number }[]).every((piece) => near(piece.volumeMm3, (100 * 80 * 400) / 3, 1)), JSON.stringify(resinProbe));
const engraved = engine.calls.length;
const resinApplied = await call("model_apply", { object: tall, op: resinOp });
const resinPieces = resinApplied.pieces as string[];
check("apply cuts the part in three", resinApplied.ok === true && resinApplied.parts === 3 && resinPieces.length === 2, JSON.stringify(resinApplied));
check("and says where the pieces are", resinApplied.note === exportedNote("Formlabs Form 4"), String(resinApplied.note));
const storedOp = resinApplied.stored as { target?: unknown; arrange?: unknown; labels?: unknown; bedMarginMm?: unknown; orient?: unknown };
check("the stored op names the Form 4, keeps the pieces as cut, and does not lay them out", JSON.stringify(storedOp.target) === JSON.stringify({ printer: "formlabs-form-4", process: "resin", volumeMm: [FORMLABS_FORM_4.bedX, FORMLABS_FORM_4.bedY, FORMLABS_FORM_4.bedZ] }) && storedOp.arrange === false && storedOp.orient === "keep" && storedOp.bedMarginMm === 10, JSON.stringify(storedOp));
check("with its part numbers on", JSON.stringify(storedOp.labels) === JSON.stringify({ on: true, face: "cut", height: 4, depth: 0.4 }), JSON.stringify(storedOp.labels));
check("the apply sent the numbers' strokes to the engine", engine.calls.length > engraved);
const onPlateNow = await plate();
check("the pieces stay in Model: the plate does not gain them", onPlateNow.length === plateBefore && !onPlateNow.some((row) => resinPieces.includes(row.object)), JSON.stringify(onPlateNow.map((row) => row.object)));
const resinHistory = ((await call("model_history", { object: resinPieces[0] })).nodes ?? []) as { label: string }[];
check("a piece is still a part to model", resinHistory[0]?.label === "Part 2", JSON.stringify(resinHistory));
const committedResin = await call("model_commit", { object: tall });
check("model_commit refuses a part cut for the Form 4", committedResin.ok === false && committedResin.reason === exportedCommit("box", "Formlabs Form 4"), JSON.stringify(committedResin));
await call("object_select", { object: tall });
const sliceResin = await call("slice_start", {});
check("so does a slice of it: the Form 4's pieces never reach the slicer", sliceResin.ok === false && sliceResin.reason === exportedCommit("box", "Formlabs Form 4"), JSON.stringify(sliceResin));
const undoneResin = await call("model_undo", { object: tall });
const redoneResin = await call("model_redo", { object: tall });
check("undo and redo leave the pieces off the plate", undoneResin.ok === true && redoneResin.ok === true && redoneResin.piecesBack === undefined && (await plate()).length === plateBefore, JSON.stringify(redoneResin));

const names = ["tall-1", "tall-2", "tall-3"];
const threeMf = await call("export_3mf", { object: tall, name: "tall", pieces: true });
const threeMfText = Buffer.from(readFileSync(String(threeMf.path))).toString("latin1");
check("export_3mf of the pieces writes one 3MF", threeMf.ok === true && threeMf.parts === 3 && String(threeMf.path).endsWith("tall.3mf"), JSON.stringify(threeMf));
check("every piece named <source>-<n> in assembly order", names.every((name) => threeMfText.includes(`name="${name}"`)) && threeMfText.indexOf('name="tall-1"') < threeMfText.indexOf('name="tall-2"') && (threeMfText.match(/<object /g) ?? []).length === 3, threeMfText.slice(0, 200));
check("the reply lists the pieces in order with their objects", JSON.stringify((threeMf.pieces as { name: string; object: string }[]).map((row) => [row.name, row.object])) === JSON.stringify([["tall-1", tall], ["tall-2", resinPieces[0]], ["tall-3", resinPieces[1]]]), JSON.stringify(threeMf.pieces));
check("and carries the support note", threeMf.note === SUPPORT_NOTE);
const stls = await call("export_3mf", { object: tall, name: "tall", pieces: true, stl: true });
const files = (stls.files ?? []) as { path: string; bytes: number }[];
check("stl: true writes one STL per piece, named in assembly order", stls.ok === true && files.length === 3 && files.every((file, at) => file.path.endsWith(`${names[at]}.stl`) && readFileSync(file.path).byteLength === file.bytes), JSON.stringify(stls));
check("each STL holds its piece", files.every((file) => readFileSync(file.path).readUInt32LE(80) > 0));
check("with the support note", stls.note === SUPPORT_NOTE);
const step = await call("model_export_step", { object: tall, name: "tall", pieces: true });
check("model_export_step of the pieces writes one STEP of three solids", step.ok === true && step.parts === 3 && step.solids === 3 && String(step.path).endsWith("tall.step"), JSON.stringify(step));
const stepText = Buffer.from(readFileSync(String(step.path))).toString("latin1");
const productAt = (name: string) => stepText.indexOf(`PRODUCT('${name}'`);
check("the STEP's solids are named <source>-<n> in assembly order", names.every((name) => productAt(name) >= 0) && productAt("tall-1") < productAt("tall-2") && productAt("tall-2") < productAt("tall-3"), stepText.slice(0, 300));
check("with the support note", step.note === SUPPORT_NOTE);
const noCut = await call("model_export_step", { object, name: "bar-pieces", pieces: true });
check("pieces: true on a part with a split to print on its way exports those pieces", noCut.ok === true && noCut.parts === 3, JSON.stringify(noCut));
const plainSolid = String((await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 })).object);
const none = await call("export_3mf", { object: plainSolid, name: "plain", pieces: true });
check("a part with no split to print says so", none.ok === false && String(none.reason).startsWith("This part has no split to print"), JSON.stringify(none));

// Saved and opened again: an export target's pieces are not saved, and the export cuts them again from the op.
const savedResin = await call("project_save", { name: "tall.lime" });
const reopenedSession = new Session(engine);
const reopenedResin = await reopenedSession.call("project_open", { path: String(savedResin.path) });
const reopenedTall = (reopenedResin.objects as { object: string; name: string }[]).find((row) => row.object === tall)?.object;
const resinRows = (await reopenedSession.call("model_history", { object: reopenedTall })).nodes as { label: string }[];
check("the reopened part keeps its row", savedResin.ok === true && reopenedResin.ok === true && resinRows.at(-1)?.label === "Split to print for Formlabs Form 4, 3 parts", JSON.stringify(resinRows));
const again3mf = await reopenedSession.call("export_3mf", { object: reopenedTall, name: "tall-again", pieces: true });
check("its export cuts the pieces again: three, named in order", again3mf.ok === true && again3mf.parts === 3 && JSON.stringify((again3mf.pieces as { name: string }[]).map((row) => row.name)) === JSON.stringify(["tall-again-1", "tall-again-2", "tall-again-3"]), JSON.stringify(again3mf));
const againStep = await reopenedSession.call("model_export_step", { object: reopenedTall, name: "tall-again", pieces: true });
check("and the STEP export reuses the pieces it cut", againStep.ok === true && againStep.solids === 3, JSON.stringify(againStep));
check("the reopened plate does not gain them either", ((await reopenedSession.call("plate_list", {})).objects as unknown[]).length === (reopenedResin.objects as unknown[]).length);

// --- Milestone 5: dowels. The planner places them on each cut's section; the pins are one more object.
const wide = String((await call("solid_new", { primitive: "box", dx: 500, dy: 60, dz: 20 })).object);
const dowelCuts = [{ origin: [0, 0, 10], normal: [1, 0, 0], connectors: { on: true, types: [{ type: "dowel", count: 4 }] } }];
const dowelCalls = engine.calls.length;
const dowelPlan = await call("model_probe", { object: wide, op: { kind: "partition", cuts: dowelCuts }, plan: true });
const planned = dowelPlan.connectors as { placed: { id: string }[]; dropped: { id: string; sentence: string }[] } | undefined;
check("plan: true places the dowels, with no kernel call", dowelPlan.ok === true && engine.calls.length === dowelCalls && JSON.stringify(planned?.placed.map((row) => row.id)) === JSON.stringify(["c1-2", "c1-3"]), JSON.stringify(dowelPlan));
check("and names the ones that do not fit", JSON.stringify(planned?.dropped.map((row) => row.id)) === JSON.stringify(["c1-1", "c1-4"]) && (dowelPlan.notes as string[]).includes("Cut 1: 2 of 4 dowels fit."), JSON.stringify(dowelPlan.notes));
const dowelOp = { kind: "partition", cuts: dowelCuts, labels: { on: false } };
const dowelProbe = await call("model_probe", { object: wide, op: dowelOp });
check("the probe says how many fit, and counts the pins", dowelProbe.ok === true && (dowelProbe.notes as string[]).includes("Cut 1: 2 of 4 dowels fit.") && (dowelProbe.pins as { count: number }).count === 2, JSON.stringify(dowelProbe));
const dowelApplied = await call("model_apply", { object: wide, op: dowelOp });
const pinsId = String(dowelApplied.pins);
const pinsObject = session.objects.find((row) => row.id === pinsId);
const wideObject = session.objects.find((row) => row.id === wide)!;
check("apply makes the pins one more object", dowelApplied.ok === true && dowelApplied.parts === 2 && !!pinsObject && pinsObject.name === "box pins", JSON.stringify(dowelApplied));
check("in the part's plate orientation, rooted as this cut's pins", JSON.stringify(pinsObject?.orient) === JSON.stringify(wideObject.orient) && (pinsObject?.tree?.root as { pins?: boolean } | undefined)?.pins === true, JSON.stringify(pinsObject?.tree?.root));
const dowelStored = dowelApplied.stored as { cuts: { connectors: { placed: { id: string }[] } }[]; up?: number[] };
check("the stored op keeps the dowels the kernel built, and the print's up", dowelStored.cuts[0]!.connectors.placed.length === 2 && JSON.stringify(dowelStored.up) === JSON.stringify([0, 0, 1]), JSON.stringify(dowelStored));
const dowelRows = (await call("model_history", { object: wide })).nodes as { label: string }[];
check("the row says dowels", dowelRows.at(-1)?.label === "Split to print, 2 parts, dowels", JSON.stringify(dowelRows));
const dowelCommit = await call("model_commit", { object: wide });
check("commit puts the pins on the plate with the pieces", dowelCommit.ok === true && (dowelCommit.pieces as string[]).includes(pinsId) && (await plate()).some((row) => row.object === pinsId), JSON.stringify(dowelCommit));
const dowelUndo = await call("model_undo", { object: wide });
check("undo takes the pins off with the pieces", dowelUndo.ok === true && (dowelUndo.piecesLeftPlate as string[]).includes(pinsId), JSON.stringify(dowelUndo));
await call("model_redo", { object: wide });
await call("model_probe", { object: wide, op: { ...dowelOp, cuts: [{ ...dowelCuts[0]!, connectors: { on: false } }] }, node: "node_0" });
const plainAgain = await call("model_edit", { object: wide, node: "node_1", op: { ...dowelOp, cuts: [{ ...dowelCuts[0]!, connectors: { on: false } }] } });
check("an edit to a plain cut takes the pins away", plainAgain.ok === true && plainAgain.pins === undefined && !(await plate()).some((row) => row.object === pinsId), JSON.stringify(plainAgain));

// The Form 4 with dowels: the pins export as <source>-pins, after the pieces, in the 3MF and the named STEP.
const column = String((await call("solid_new", { primitive: "box", dx: 100, dy: 80, dz: 400 })).object);
const columnOp = { ...resinOp, cuts: resinCuts.map((one) => ({ ...one, connectors: { on: true } })) };
await call("model_probe", { object: column, op: columnOp });
const columnApplied = await call("model_apply", { object: column, op: columnOp });
check("the Form 4's pins are held off the plate with its pieces", columnApplied.ok === true && typeof columnApplied.pins === "string" && !(await plate()).some((row) => row.object === columnApplied.pins), JSON.stringify(columnApplied));
const pinned3mf = await call("export_3mf", { object: column, name: "column", pieces: true });
check("the 3MF names the pins last", pinned3mf.ok === true && JSON.stringify((pinned3mf.pieces as { name: string }[]).map((row) => row.name)) === JSON.stringify(["column-1", "column-2", "column-3", "column-pins"]), JSON.stringify(pinned3mf.pieces));
const pinnedStep = await call("model_export_step", { object: column, name: "column", pieces: true });
const pinnedText = Buffer.from(readFileSync(String(pinnedStep.path))).toString("latin1");
check("and the named STEP has a column-pins product", pinnedStep.ok === true && pinnedText.includes("PRODUCT('column-pins'") && pinnedText.indexOf("PRODUCT('column-3'") < pinnedText.indexOf("PRODUCT('column-pins'"), JSON.stringify(pinnedStep));

// --- guide {kind}: the op's full schema, on demand.
const guide = await call("guide", { kind: "partition" });
const schema = guide.schema as { required?: string[]; properties?: Record<string, unknown> };
check("guide {kind: partition} returns its schema", guide.ok === true && JSON.stringify(schema.required) === JSON.stringify(["kind"]) && ["cuts", "target", "orient", "arrange", "labels", "bedMarginMm", "maxPieces"].every((field) => field in (schema.properties ?? {})), JSON.stringify(guide));
check("with the guide's line for it", (guide.examples as string[]).some((line) => line.startsWith("partition (split to print):")), JSON.stringify(guide.examples));
check("and the resin export sequence: plan with the Form 4, probe, apply, export", (guide.examples as string[]).some((line) => line.includes("formlabs-form-4") && line.includes("model_export_step") && line.includes("pieces:true")), JSON.stringify(guide.examples));
const modelGuide = await session.resource("lime://guide/model");
const modelGuideText = typeof modelGuide === "string" ? modelGuide : JSON.stringify(modelGuide);
check("lime://guide/model has the same sequence", modelGuideText.includes("formlabs-form-4") && modelGuideText.includes("export_3mf"), modelGuideText.slice(0, 200));

// --- Split to print turns the part for an export target (the Telo's 7 pieces became 4).
const teloBar = String((await call("solid_new", { primitive: "box", dx: 97, dy: 680, dz: 150 })).object);
const teloPlan = await call("model_probe", { object: teloBar, op: { kind: "partition", target: { printer: "formlabs-form-4" } }, plan: true });
const teloCuts = teloPlan.cuts as { origin: number[]; normal: number[] }[];
check("a 680 mm bar lying along Y is four pieces for the Form 4, turned to its height", teloPlan.ok === true && teloPlan.pieces === 4 && teloCuts.length === 3 && teloCuts.every((one) => one.normal[1] === 1), JSON.stringify(teloPlan));
check("with the sentence that names the matched axis", teloPlan.reason === "Cut for the Formlabs Form 4 with the part's 680 mm along the volume's 210 mm height: 4 parts.", String(teloPlan.reason));
const teloLime = await call("model_probe", { object: teloBar, op: { kind: "partition" }, plan: true });
check("the same bar for the plate's printer is cut as before", teloLime.pieces === 4 && !String(teloLime.reason).startsWith("Cut for"), JSON.stringify(teloLime));

// --- Milestone 6: solid_new with a coupon refuses what the planner refuses, before the engine is asked.
const asked = engine.calls.length;
const noRow = await call("solid_new", { coupon: { material: "Nylon" } });
check("a material with no row, and no startMm, is refused with the sentence", noRow.ok === false && noRow.reason === "No starting fit for this material. Give startMm, the clearance each side to centre the coupon on.", JSON.stringify(noRow));
const both = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10, coupon: {} });
check("a coupon and a primitive together are refused", both.ok === false && String(both.reason).includes("not both"), JSON.stringify(both));
const unknownPrinter = await call("solid_new", { coupon: { printer: "nope-3000" } });
check("an unknown printer is refused and the ids are named", unknownPrinter.ok === false && String(unknownPrinter.reason).includes("formlabs-form-4"), JSON.stringify(unknownPrinter));
let badHole = "";
try {
  await call("solid_new", { coupon: { hole: "square" } });
} catch (err) {
  badHole = err instanceof Error ? err.message : String(err);
}
check("a hole shape outside round and teardrop is refused by the schema", badHole === "coupon.hole must be one of round, teardrop.", JSON.stringify(badHole));
const thin = await call("solid_new", { coupon: { radius: 1 } });
check("a pin under the radius floor is refused with the floor", thin.ok === false && String(thin.reason).includes("floor"), JSON.stringify(thin));
check("none of them reached the engine", engine.calls.length === asked, engine.calls.slice(asked).join(","));
check("the ops guide tells the coupon call", ((await session.resource("lime://guide/ops")) as string | object).toString().length > 0 && JSON.stringify(await session.resource("lime://guide/ops")).includes("solid_new {coupon:{}}"));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("partition: ok");
