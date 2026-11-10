/**
 * Lean replies (mcp/lean.ts) against the stand-in engine: a call from the chat reads rounded rows without the fields
 * it rarely needs, full: true gives the reply as it was, and a step of a recipe or a plan reads the reply whole.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { leanReply } from "./lean.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-lean-"));
process.env.LIME_MCP_BRIDGE = "0";
delete process.env.LIME_MCP_LEAN;

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}` : ""}`);
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const session = new Session(fakeEngine());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
const call = (name: string, args: unknown = {}) => session.call(name, args) as Promise<Reply>;
/** The reply a recipe's step reads: the same call as a step, whole. */
const asStep = (name: string, args: unknown = {}) => session.runCall(name, args, {}, true) as Promise<Reply>;

const object = (await call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 35 })).object as string;

// Faces.
const faces = await call("faces_find", { object });
const facesFull = await call("faces_find", { object, full: true });
const facesStep = await asStep("faces_find", { object });
console.log(`faces_find: ${bytes(faces)} bytes lean, ${bytes(facesFull)} as before`);
check("a recipe's step reads faces_find whole, and full: true is that reply", same(facesFull, facesStep) && facesStep.faces.every((row: Reply) => row.frame && row.bbox));
check("past three rows a face has no frame and no box", faces.total === 6 && faces.faces.length === 6 && faces.faces.every((row: Reply) => row.frame === undefined && row.bbox === undefined && row.centre && row.kind === "plane" && typeof row.areaMm2 === "number"), faces.faces[0]);
check("the lean faces are under half the bytes", bytes(faces) * 2 < bytes(facesFull));
const top = await call("faces_find", { object, normal: [0, 0, 1] });
check("three rows or fewer keep the frame", top.faces.length === 1 && same(top.faces[0].frame.w, [0, 0, 1]) && top.faces[0].bbox === undefined, top.faces[0]);
const framed = await call("faces_find", { object, frames: true, bbox: true });
check("frames: true and bbox: true put both on every row", framed.faces.every((row: Reply, i: number) => same(row.frame.origin, facesStep.faces[i].frame.origin) && same(row.bbox, facesStep.faces[i].bbox)));
const limited = await call("faces_find", { object, limit: 3 });
check("a page of three has frames", limited.faces.length === 3 && limited.faces.every((row: Reply) => row.frame) && limited.nextCursor === "3");

// Edges.
const edges = await call("edges_find", { object });
const edgesFull = await call("edges_find", { object, full: true });
console.log(`edges_find: ${bytes(edges)} bytes lean, ${bytes(edgesFull)} as before`);
check("full: true is the edges reply a step reads", same(edgesFull, await asStep("edges_find", { object })) && edgesFull.edges.every((row: Reply) => row.mid && row.dir));
check("a straight edge is its index, length, start and end", edges.edges.every((row: Reply) => same(Object.keys(row).sort(), ["end", "index", "lengthMm", "start"])), edges.edges[0]);

// Describe.
const described = await call("model_describe", { object });
const describedFull = await call("model_describe", { object, full: true });
console.log(`model_describe: ${bytes(described)} bytes lean, ${bytes(describedFull)} as before`);
check("model_describe full: true is the reply a step reads", same(describedFull, await asStep("model_describe", { object })));
check("model_describe rows are lean, the cursors stay", described.faces.every((row: Reply) => row.bbox === undefined) && described.edges.every((row: Reply) => row.mid === undefined) && same(described.fingerprint, describedFull.fingerprint) && described.edgesNextCursor === describedFull.edgesNextCursor);
check("bbox: true gives each face's box", (await call("model_describe", { object, bbox: true })).faces.every((row: Reply) => row.bbox?.min));
const counts = await call("model_describe", { object, limit: 0 });
check("limit: 0 is counts only", counts.ok === true && counts.faceCount === 6 && counts.edgeCount === 12 && counts.faces.length === 0 && counts.edges.length === 0 && counts.nextCursor === undefined && counts.bounds?.max, counts);
check("limit: 0 is refused on faces_find, which has total", await (async () => session.call("faces_find", { object, limit: 0 }))().then(() => false, () => true));

// Rounding, on rows as a kernel sends them.
const noisy = { ok: true, bounds: { min: [-30, -20, 1.1368683772161603e-15], max: [30, 20.000000000000004, 35] }, faces: [{ index: 0, areaMm2: 10.000000000000007, normal: [0, -0, 1], centre: [1.23456789, 0, 2], bbox: { min: [0, 0, 0], max: [1, 1, 1] }, kind: "plane", frame: { origin: [0, 0, 10.000000000000007], turn: [0.000001, 0, 90] } }], edges: [{ index: 3, lengthMm: 9.999999999999998, start: [0, 0, 0], end: [0, 0, 9.999999999999998], mid: [0, 0, 5], dir: [0, 0, 1] }, { index: 4, lengthMm: 31.41592653589793, start: [5, 0, 0], end: [5, 0, 0], mid: [-5, 6.123233995736766e-16, 0] }] };
const tidy = leanReply("model_describe", {}, noisy) as Reply;
check("numbers round to 1e-4 with no negative zero", same(tidy.bounds.min, [-30, -20, 0]) && same(tidy.bounds.max, [30, 20, 35]) && tidy.faces[0].areaMm2 === 10 && same(tidy.faces[0].normal, [0, 0, 1]) && same(tidy.faces[0].centre, [1.2346, 0, 2]) && !JSON.stringify(tidy).includes("e-"), tidy);
check("a frame's turn keeps its own rounding", same(tidy.faces[0].frame, { origin: [0, 0, 10], turn: [0.000001, 0, 90] }));
check("a curved edge keeps its mid; a straight one is start and end", same(tidy.edges[0], { index: 3, lengthMm: 10, start: [0, 0, 0], end: [0, 0, 10] }) && same(tidy.edges[1].mid, [-5, 0, 0]) && tidy.edges[1].dir === undefined);
check("full: true, a refusal, and another tool pass through untouched", leanReply("model_describe", { full: true }, noisy) === noisy && leanReply("plate_list", {}, noisy) === noisy && leanReply("faces_find", {}, { ok: false, reason: "No." }).reason === "No.");
process.env.LIME_MCP_LEAN = "0";
check("LIME_MCP_LEAN=0 turns the lean form off for the server", same(await call("faces_find", { object }), facesFull));
delete process.env.LIME_MCP_LEAN;

// A blend's picked edges are said once.
const many = Array.from({ length: 100 }, (_, i) => i * 2);
const refs = many.map((index) => ({ index, sig: { a: [0, 0, 1], b: [1, 0, 0] } }));
const probed = { ok: true, reason: "This fillet fits.", edges: many, stored: { kind: "fillet", edges: many, size: 1 }, typed: { kind: "fillet", edges: many, size: 1 }, metrics: { delta: { volumeMm3: 118.46 } } };
const echo = leanReply("model_probe", {}, probed) as Reply;
console.log(`a probe of a fillet on 100 edges: ${bytes(echo)} bytes lean, ${bytes(probed)} as before`);
check("past 32 edges a probe counts them and lists the first 16 once", same(echo.edges, { count: 100, first: many.slice(0, 16) }) && echo.stored.edges === "100 edges" && echo.typed.edges === "100 edges" && echo.stored.size === 1 && same(echo.metrics, probed.metrics) && echo.reason === probed.reason, echo);
const refusedEcho = leanReply("model_probe", {}, { ok: false, code: "does-not-fit", reason: "Too large.", edges: many, stored: { kind: "fillet", edges: many, size: 30 }, typed: { kind: "fillet", edges: many, size: 30 } }) as Reply;
check("a refusal's echo is counted too, and keeps its reason and code", refusedEcho.ok === false && refusedEcho.code === "does-not-fit" && refusedEcho.reason === "Too large." && refusedEcho.edges.count === 100 && refusedEcho.typed.edges === "100 edges");
const appliedEcho = leanReply("model_apply", {}, { ok: true, node: "node_4", stored: { kind: "fillet", edges: refs, size: 1 }, typed: { kind: "fillet", edges: many, size: 1 } }) as Reply;
check("an applied blend's stored references and typed indexes are counted", appliedEcho.node === "node_4" && appliedEcho.stored.edges === "100 edges" && appliedEcho.typed.edges === "100 edges" && appliedEcho.edges === undefined);
const few = { ok: true, edges: [1, 2, 3], stored: { kind: "fillet", edges: [1, 2, 3], size: 1 }, typed: { kind: "fillet", edges: [1, 2, 3], size: 1 } };
check("32 edges or fewer, full: true, and another tool are untouched", leanReply("model_probe", {}, few) === few && leanReply("model_probe", { full: true }, probed) === probed && leanReply("model_history", {}, probed) === probed && leanReply("model_apply", {}, { ok: true, node: "node_2", stored: { kind: "hole" }, typed: { kind: "hole" } }).edges === undefined);
// Through the session: a fillet of four edges echoes them as before, and a step reads the same reply whole.
const blendOp = { kind: "fillet", edges: { select: { direction: [0, 0, 1] } }, size: 1 };
const blend = await call("model_probe", { object, op: blendOp });
check("a small pick is echoed as it was", blend.ok === true && Array.isArray(blend.edges) && blend.edges.length === 4 && same(blend.stored.edges, blend.edges) && same(blend, await asStep("model_probe", { object, op: blendOp })), blend);

// A plan reads each step whole, so a reference into a field the lean form leaves out still resolves.
const plan = await call("plan_run", { steps: [{ tool: "faces_find", args: { object } }, { tool: "faces_find", args: { object, nearPoint: "$1.faces.5.frame.origin", limit: 1 } }] });
check("a plan's reference reaches a frame the lean reply leaves out", plan.ok === true && plan.steps.length === 2, plan);
check("the plan's reply carries the lean rows", plan.steps[0].result.faces.every((row: Reply) => row.frame === undefined));

// session_info says what never changes once.
{
  const fresh = new Session(fakeEngine());
  const first = (await fresh.call("session_info", {})) as Reply;
  const second = (await fresh.call("session_info", {})) as Reply;
  const verbose = (await fresh.call("session_info", { verbose: true })) as Reply;
  console.log(`session_info: ${bytes(first)} bytes the first time, ${bytes(second)} after`);
  check("the first session_info has the model block and the bridge sentences", first.model?.ops?.includes("boolean") && first.model.guides.includes("ops") && typeof first.tandem.note === "string" && typeof first.tandem.why === "string", first);
  check("a later one leaves them out and keeps what can change", second.model === undefined && second.tandem.note === undefined && second.tandem.why === undefined && second.tandem.bridge === "absent" && second.serverVersion === first.serverVersion && second.printer === first.printer && second.workspace === first.workspace && second.plugins === first.plugins && second.printerSend === false, second);
  check("verbose: true is the first reply again", same(verbose, first));
  check("a later reply is under half the first", bytes(second) * 2 < bytes(first));
}

// gcode_summary: rounded, no G-code lines unless asked.
{
  await call("model_commit", { object });
  const started = await call("slice_start", {});
  const waited = await call("slice_wait", { job: started.job });
  const summary = await call("gcode_summary", { job: started.job });
  const withLines = await call("gcode_summary", { job: started.job, lines: true });
  console.log(`gcode_summary: ${bytes(summary)} bytes, ${bytes(withLines)} with lines`);
  check("the slice finished", waited.status === "done", waited);
  check("gcode_summary has no head or tail, and whole seconds", summary.ok === true && summary.head === undefined && summary.tail === undefined && Number.isInteger(summary.seconds) && Array.isArray(summary.review) && Array.isArray(summary.warnings) && summary.features.every((row: Reply) => Number.isInteger(row.seconds) && Math.abs(row.grams * 100 - Math.round(row.grams * 100)) < 1e-9), summary);
  check("lines: true gives the lines and the raw numbers, as before", Array.isArray(withLines.head) && withLines.head.length > 0 && Array.isArray(withLines.tail) && withLines.features.length === summary.features.length && withLines.features[0].grams !== summary.features[0].grams && same(withLines.review, summary.review) && Math.round(withLines.seconds) === summary.seconds, withLines.features);
}

if (failed > 0) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("lean replies: all checks passed");
