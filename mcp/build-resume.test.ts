/**
 * model_build resuming after a refusal, onError skip, refusals that say where the trouble is, and loft and sweep, against
 * the stand-in engine. The stand-in refuses a hole wider than 16 mm, which stands in for any refusal here.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pieceReport, separateReason, splitReason } from "../src/modeling/compose.ts";
import { fakeEngine } from "./engine.ts";
import { validateTool } from "./schema.ts";
import { Session } from "./session.ts";
import { sweepSections } from "../src/modeling/sweep.ts";
import { eulerOrient } from "../src/mesh-place.ts";
import { toSolidOp } from "../src/model-space.ts";
import { readSavedTree, savedTree } from "../src/model-tree-file.ts";
import type { LoftSection } from "../src/model-tree.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-resume-"));

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

// Where a refused step's trouble is.
const shifted = (p: [number, number, number]): [number, number, number] => [p[0] + 100, p[1], p[2]];
const loose = pieceReport({ pieces: [{ min: [0, 0, 0], max: [2, 4, 6], volumeMm3: 48, gapMm: 0.35 }] }, shifted);
check("a loose piece is placed in the part's frame", JSON.stringify(loose?.pieces[0]?.centre) === "[101,2,3]" && JSON.stringify(loose?.pieces[0]?.size) === "[2,4,6]", JSON.stringify(loose));
check("a loose piece's refusal says how far to move it", separateReason(loose).includes("0.35 mm from the part") && separateReason(loose).includes("at least 0.55 mm"), separateReason(loose));
const sealed = pieceReport({ voids: [{ min: [1, 1, 1], max: [2, 3, 4] }, { min: [5, 5, 5], max: [6, 6, 6] }] }, (p) => p);
check("a sealed hollow is named with its place and size", separateReason(sealed).includes("(1.5, 2, 2.5)") && separateReason(sealed).includes("1 × 2 × 3 mm") && separateReason(sealed).includes("1 more"), separateReason(sealed));
check("a touching piece is told to overlap", separateReason(pieceReport({ pieces: [{ min: [0, 0, 0], max: [1, 1, 1], volumeMm3: 1, gapMm: 0 }] }, (p) => p)).includes("only touches"));
check("a severed sliver is located", splitReason(loose).includes("2 × 4 × 6 mm piece at (101, 2, 3)"), splitReason(loose));
check("no report keeps the plain sentence", separateReason(pieceReport({}, (p) => p)).startsWith("This would add a separate piece"));

// Sweep sections: square to the path, with no twist, through a smooth curve.
const straight = sweepSections({ path: [[0, 0, 0], [0, 0, 10]], radius: 2 }) as LoftSection[];
const frame = (section: LoftSection) => eulerOrient(section.turn[0], section.turn[1], section.turn[2]);
check("a straight sweep is two circles square to the path", straight.length === 2 && straight.every((s) => s.radius === 2 && near(frame(s)[8]!, 1)), JSON.stringify(straight));
const tapered = sweepSections({ path: [[0, 0, 0], [10, 0, 0], [20, 5, 0]], radius: [3, 2, 1], steps: 2 }) as LoftSection[];
check("a smooth sweep adds sections between points and carries the radius", tapered.length === 5 && tapered[1]!.radius === 2.5 && tapered[4]!.radius === 1, JSON.stringify(tapered.map((s) => s.radius)));
check("each section faces along the path", tapered.every((s, i) => {
  const w = [frame(s)[2]!, frame(s)[5]!, frame(s)[8]!];
  const next = tapered[Math.min(i + 1, tapered.length - 1)]!.origin;
  const prev = tapered[Math.max(i - 1, 0)]!.origin;
  const d = [next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]];
  const len = Math.hypot(d[0]!, d[1]!, d[2]!);
  return w[0]! * d[0]! / len + w[1]! * d[1]! / len + w[2]! * d[2]! / len > 0.999;
}));
const ellipse = sweepSections({ path: [[0, 0, 0], [10, 0, 0]], radius: 3, radiusV: 1.5 }) as LoftSection[];
const v = frame(ellipse[0]!);
check("an ellipse's V points up", ellipse[0]!.radiusV === 1.5 && near(v[7]!, 1), JSON.stringify(v));
const leaf = sweepSections({ path: [[0, 0, 0], [5, 0, 1], [10, 0, 0]], profile: [[-2, 0], [0, 0.5], [2, 0], [0, -0.5]], scale: [0.2, 1, 0.2], smooth: true, steps: 1 }) as LoftSection[];
check("a profile sweep scales its outline along the path", leaf.length === 3 && leaf[0]!.profile![0]![0] === -0.4 && leaf[1]!.profile![0]![0] === -2 && leaf[1]!.smooth === true, JSON.stringify(leaf));
check("a hairpin bend is refused with where it is", "reason" in (sweepSections({ path: [[0, 0, 0], [10, 0, 0], [10, 1, 0], [0, 1, 0]], radius: 2, steps: 1 }) as object));
check("a radius list must match the path", "reason" in (sweepSections({ path: [[0, 0, 0], [1, 0, 0]], radius: [1, 2, 3] }) as object));
check("too many sections are refused", "reason" in (sweepSections({ path: Array.from({ length: 80 }, (_, i) => [i, Math.sin(i), 0] as [number, number, number]), radius: 0.2, steps: 4 }) as object));

// A loft's sections follow the part's pose, and a loft and smooth profiles survive the project file.
const posed = toSolidOp({ kind: "loft", op: "fuse", sections: [{ origin: [10, 0, 0], turn: [0, 0, 0], radius: 1 }, { origin: [10, 0, 5], turn: [0, 0, 0], radius: 2 }] }, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [10, 0, 0] });
check("a loft's sections move with the pose", posed.kind === "loft" && posed.sections[0]!.origin[0] === 0, JSON.stringify(posed));
const tree = {
  key: "t", root: { kind: "primitive", solid: { primitive: "box", origin: [0, 0, 0], size: [10, 10, 10], turn: [0, 0, 0] } }, current: 2, committed: null, nextId: 3,
  nodes: new Map([
    [0, { id: 0, parent: null, op: null, label: "Box", fingerprint: null }],
    [1, { id: 1, parent: 0, op: { kind: "extrude", op: "fuse", origin: [0, 0, 10], turn: [0, 0, 0], profile: [[0, 0], [4, 0], [4, 4], [0, 4]], depth: 2, smooth: true, corners: [0, 1] }, label: "x", fingerprint: null }],
    [2, { id: 2, parent: 1, op: { kind: "loft", op: "fuse", sections: [{ origin: [5, 5, 10], turn: [0, 0, 0], radius: 2, radiusV: 1 }, { origin: [5, 5, 15], turn: [0, 0, 0], profile: [[0, 0], [1, 0], [0, 1]], smooth: true }], ruled: true }, label: "y", fingerprint: null }],
  ]),
};
let roundTrip: unknown = null;
try {
  roundTrip = readSavedTree({ ...JSON.parse(JSON.stringify(savedTree(tree as never, 0, () => undefined))), rootStep: "root.step" });
} catch (err) {
  roundTrip = String(err);
}
const backOps = roundTrip && typeof roundTrip === "object" && "nodes" in roundTrip ? (roundTrip as { nodes: { op: unknown }[] }).nodes.map((node) => node.op) : [];
check("a smooth profile and a loft survive the project file", JSON.stringify(backOps[1]).includes("\"corners\":[0,1]") && JSON.stringify(backOps[2]).includes("\"ruled\":true") && JSON.stringify(backOps[2]).includes("\"radiusV\":1"), JSON.stringify(roundTrip).slice(0, 400));

// The schema takes loft, sweep, smooth, and skip.
check("a sweep op passes the schema", validateTool("model_apply", { op: { kind: "sweep", path: [[0, 0, 0], [0, 0, 5]], radius: [1, 2] } }) === null);
check("a loft section with a stray field is refused", (validateTool("model_apply", { op: { kind: "loft", sections: [{ origin: [0, 0, 0], radius: 1, size: 3 }, { origin: [0, 0, 1], radius: 1 }] } }) ?? "").includes("size"));
check("onError takes skip", validateTool("model_build", { base: { primitive: "box", dx: 1, dy: 1, dz: 1 }, onError: "skip" }) === null);

// The session: resume, skip, rebuild in place, and the bake of loft and sweep.
const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);
const base = { primitive: "box", dx: 20, dy: 20, dz: 20 };
const cut = (x: number) => ({ kind: "boolean", op: "cut", primitive: "box", centre: [x, 0, 19.5], dx: 1, dy: 1, dz: 2 });
const wide = { kind: "hole", origin: [0, 0, 20], diameterMm: 20, depth: 3 };
const narrow = { kind: "hole", origin: [0, 0, 20], diameterMm: 4, depth: 3 };
const applies = () => engine.calls.filter((c) => c === "apply").length;

const first = await call("model_build", { name: "plate", base, ops: [cut(-5), cut(5), wide, cut(0)] });
check("a refused build names the op and rolls back", first.ok === false && (first.failed as { index?: number })?.index === 2 && typeof first.object === "string", JSON.stringify(first));
const before = applies();
const second = await call("model_build", { name: "plate", base, ops: [cut(-5), cut(5), narrow, cut(0)] });
check("the same build again reuses the ops before the fix", second.ok === true && second.object === first.object && (second.resumed as { reusedOps?: number })?.reusedOps === 2 && applies() - before === 2 && second.applied === 4, JSON.stringify({ second, ran: applies() - before }));
const plates = ((await call("plate_list", {})).objects as unknown[]).length;
check("a resumed build leaves one object on the plate", plates === 1, String(plates));
const history = (await call("model_history", { object: second.object })).nodes as { label: string; current: boolean }[];
check("the history holds one path, without the refused run", history.length === 5 && history.filter((row) => row.label.startsWith("Hole")).length === 1, JSON.stringify(history));

const skipped = await call("model_build", { name: "skips", base: { primitive: "box", dx: 20, dy: 20, dz: 21 }, onError: "skip", ops: [cut(-5), wide, cut(5), { ...wide, label: "big hole" }] });
const failures = (skipped.failures ?? []) as { index: number; label?: string }[];
check("skip applies the rest and reports every refusal", skipped.ok === false && skipped.applied === 2 && failures.length === 2 && failures[0]!.index === 1 && failures[1]!.label === "big hole", JSON.stringify(skipped));
const fixed = await call("model_build", { name: "skips", base: { primitive: "box", dx: 20, dy: 20, dz: 21 }, ops: [cut(-5), narrow, cut(5)] });
check("a skipped build resumes from the first refused op", fixed.ok === true && fixed.object === skipped.object && (fixed.resumed as { reusedOps?: number })?.reusedOps === 1, JSON.stringify(fixed));

const fresh = await call("model_build", { name: "plate", base, ops: [cut(-5)], resume: false });
check("resume: false makes a new object", fresh.ok === true && fresh.object !== first.object, JSON.stringify(fresh));
const rebuilt = await call("model_build", { object: second.object, base, ops: [cut(-5), cut(5), narrow, cut(2)] });
check("object rebuilds an earlier build in place, reusing its ops", rebuilt.ok === true && rebuilt.object === second.object && (rebuilt.resumed as { reusedOps?: number })?.reusedOps === 3, JSON.stringify(rebuilt));
const otherBase = await call("model_build", { object: second.object, base: { primitive: "box", dx: 9, dy: 9, dz: 9 }, ops: [] });
check("a rebuild with another base is refused", otherBase.ok === false && String(otherBase.reason).includes("base"), JSON.stringify(otherBase));

const vents = { kind: "pattern", label: "vents", linear: { step: [3, 0, 0], count: 4 }, op: { kind: "boolean", op: "cut", primitive: "box", origin: [-8, -8, 18], dx: 1, dy: 1, dz: 1 } };
const vented = await call("model_build", { name: "vented", base, ops: [vents, wide] });
check("a refused build after a composite keeps the group", vented.ok === false && (vented.failed as { index?: number; failedStep?: number })?.index === 1, JSON.stringify(vented));
const ventedAgain = await call("model_build", { name: "vented", base, ops: [vents, narrow] });
const ventedHistory = ((await call("model_history", { object: ventedAgain.object })).nodes as { label: string }[]).map((row) => row.label);
check(
  "a resumed composite is one checkpoint, not one node per piece",
  ventedAgain.ok === true && ventedAgain.object === vented.object && (ventedAgain.resumed as { reusedOps?: number })?.reusedOps === 1 && ventedHistory.length === 3 && ventedHistory.includes("vents") && ventedHistory.filter((label) => label.startsWith("Hole")).length === 1,
  JSON.stringify({ ventedAgain, ventedHistory }),
);

const loftObj = await call("model_build", { name: "horn", base, ops: [
  { kind: "sweep", path: [[0, 0, 19], [0, 3, 26], [0, 9, 30]], radius: [3, 2, 0.8], label: "horn" },
  { kind: "loft", op: "fuse", sections: [{ origin: [5, 5, 19], radius: 2 }, { origin: [5, 5, 24], turn: [0, 0, 45], profile: [[-1, -1], [1, -1], [1, 1], [-1, 1]], smooth: true, corners: [0, 1] }] },
  { kind: "extrude", op: "fuse", origin: [-8, -8, 20], profile: [[0, 0], [4, 0], [4, 2], [2, 4], [0, 2]], smooth: true, corners: [0, 1], depth: 2 },
] });
const sent = engine.calls.length > 0 ? (engine.lastProbe as { kind?: string; smooth?: boolean; corners?: number[] }) : null;
check("loft, sweep, and smooth profiles bake and apply", loftObj.ok === true && sent?.kind === "extrude" && sent.smooth === true && JSON.stringify(sent.corners) === "[0,1]", JSON.stringify({ loftObj, sent }));
const horn = ((await call("model_history", { object: loftObj.object })).nodes as { label: string }[]).map((row) => row.label);
check("a sweep is stored as a loft with its label", horn.includes("horn") && horn.some((label) => label.startsWith("Loft through 2 sections")), JSON.stringify(horn));
const badCorner = await call("model_apply", { object: loftObj.object, probe: true, op: { kind: "extrude", origin: [0, 0, 20], profile: [[0, 0], [1, 0], [0, 1]], corners: [0], depth: 1 } });
check("corners need smooth", badCorner.ok === false && String(badCorner.reason).includes("smooth"), JSON.stringify(badCorner));
const info = await call("session_info");
check("session_info lists loft and sweep", JSON.stringify(info).includes("\"sweep\""));

if (failed > 0) {
  console.error(`build-resume: ${failed} failed`);
  process.exit(1);
}
console.log("build-resume: ok");
