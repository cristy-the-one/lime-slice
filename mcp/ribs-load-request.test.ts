/**
 * The panel and ribs_plan build load cases through one function. The same two cases give the same wall request
 * and the same plan body. ribs_plan refuses a weight that is not above zero, and more than 8 cases, before that.
 * One load stays `loads` alone.
 */
import { loadRequest } from "../src/auto-ribs.ts";
import { planOptions } from "../src/auto-ribs-plan.ts";
import { ribWall, type RibWall, type RibWallSolid } from "../src/modeling/rib-wall.ts";
import type { StudyLoad } from "../src/sim/study.ts";

import { ribsLoadRequest } from "./session/ribs.ts";
import { stressMethods } from "./session/stress.ts";

let failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}\n  got ${JSON.stringify(actual)}\n  want ${JSON.stringify(expected)}`);
}

const read = (value: unknown) => stressMethods.readLoads.call(null as never, value);
const one = (raw: unknown): StudyLoad => {
  const got = read([raw]);
  if ("reason" in got || got.length !== 1) throw new Error(JSON.stringify(got));
  return got[0]!;
};

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A small open box, faces as rib-wall.test.ts: 6 is the inner floor. */
function openBox(): RibWallSolid {
  const pos: number[] = [];
  const face: number[] = [];
  const quad = (f: number, a: V3, b: V3, c: V3, d: V3, want: V3) => {
    const tri = (p: V3, q: V3, r: V3) => {
      const n = cross(sub(q, p), sub(r, p));
      if (dot(n, want) < 0) [q, r] = [r, q];
      pos.push(...p, ...q, ...r);
      face.push(f);
    };
    tri(a, b, c);
    tri(a, c, d);
  };
  const X = 40;
  const Y = 24;
  const Z = 12;
  const t = 2;
  quad(0, [0, 0, 0], [X, 0, 0], [X, Y, 0], [0, Y, 0], [0, 0, -1]);
  quad(6, [t, t, t], [X - t, t, t], [X - t, Y - t, t], [t, Y - t, t], [0, 0, 1]);
  quad(2, [0, 0, 0], [0, Y, 0], [0, Y, Z], [0, 0, Z], [-1, 0, 0]);
  quad(3, [X, 0, 0], [X, Y, 0], [X, Y, Z], [X, 0, Z], [1, 0, 0]);
  quad(4, [0, 0, 0], [X, 0, 0], [X, 0, Z], [0, 0, Z], [0, -1, 0]);
  quad(5, [0, Y, 0], [X, Y, 0], [X, Y, Z], [0, Y, Z], [0, 1, 0]);
  quad(8, [t, t, t], [t, Y - t, t], [t, Y - t, Z], [t, t, Z], [1, 0, 0]);
  quad(9, [X - t, t, t], [X - t, Y - t, t], [X - t, Y - t, Z], [X - t, t, Z], [-1, 0, 0]);
  quad(10, [t, t, t], [X - t, t, t], [X - t, t, Z], [t, t, Z], [0, 1, 0]);
  quad(11, [t, Y - t, t], [X - t, Y - t, t], [X - t, Y - t, Z], [t, Y - t, Z], [0, -1, 0]);
  const up: V3 = [0, 0, 1];
  quad(1, [0, 0, Z], [X, 0, Z], [X - t, t, Z], [t, t, Z], up);
  quad(1, [X, 0, Z], [X, Y, Z], [X - t, Y - t, Z], [X - t, t, Z], up);
  quad(1, [X, Y, Z], [0, Y, Z], [t, Y - t, Z], [X - t, Y - t, Z], up);
  quad(1, [0, Y, Z], [0, 0, Z], [t, t, Z], [t, Y - t, Z], up);
  return { positions: Float32Array.from(pos), faceOf: Uint32Array.from(face) };
}

/** The plan body both paths attach: the wall's request, and the case weights when there are cases. */
function planBody(wall: RibWall, weights: number[] | undefined) {
  const request = wall.request.holds.holds.length === 0 ? { ...wall.request, holds: { kind: "allBoundary" as const } } : wall.request;
  return { request, material: { e: 2000, nu: 0.4 }, rules: { width: 1.2 }, goal: { budgetMm3: 1000 }, options: { baselines: true }, holeRimMarginMm: 3, ...(weights ? { caseWeights: weights } : {}) };
}

const solid = openBox();
const rawPressure = { kind: "pressure", faces: [6], magnitude: 0.01, direction: [0, 0, -1] };
const rawForce = { kind: "force", faces: [6], magnitude: 20, direction: [0, 0, -1] };
const pressure = one(rawPressure);
const force = one(rawForce);

const panelCases = [
  { name: "spread", weight: 1, loads: [pressure] },
  { name: "  ", weight: 4, loads: [force] },
];
const toolCases = [
  { name: "spread", weight: 1, loads: [rawPressure] },
  { name: "  ", weight: 4, loads: [rawForce] },
];
const panel = loadRequest([], panelCases);
const tool = ribsLoadRequest(read, { loadCases: toolCases });
if ("code" in tool) {
  console.error(`FAIL ribs_plan reads the two cases: ${tool.reason}`);
  process.exit(1);
}
eq("two cases: the panel and ribs_plan ask for the same loads", tool, panel);
eq("a blank name is Case 2", panel, { loads: [], loadCases: [{ name: "spread", loads: [pressure] }, { name: "Case 2", loads: [force] }], caseWeights: [1, 4] });

const panelWall = ribWall(solid, { picked: [6], ...(panel.loadCases ? { loadCases: panel.loadCases } : { loads: panel.loads }) });
const toolWall = ribWall(solid, { picked: [6], ...(tool.loadCases ? { loadCases: tool.loadCases } : { loads: tool.loads }) });
if ("reason" in panelWall || "reason" in toolWall) {
  console.error(`FAIL the wall takes the two cases: ${"reason" in panelWall ? panelWall.reason : ""} ${"reason" in toolWall ? toolWall.reason : ""}`);
  process.exit(1);
}
eq("two cases: the same wall request", toolWall.request, panelWall.request);
eq("two cases: the same plan body", planBody(toolWall, tool.caseWeights), planBody(panelWall, panel.caseWeights));

const onePanel = loadRequest([force], undefined);
const oneTool = ribsLoadRequest(read, { loads: [rawForce] });
if ("code" in oneTool) {
  console.error(`FAIL one load: ${oneTool.reason}`);
  process.exit(1);
}
eq("one load: ribs_plan sends loads alone, as the panel does", oneTool, onePanel);
eq("one load has no cases and no weights", oneTool, { loads: [force] });
const onePanelWall = ribWall(solid, { picked: [6], loads: onePanel.loads });
const oneToolWall = ribWall(solid, { picked: [6], loads: oneTool.loads });
if ("reason" in onePanelWall || "reason" in oneToolWall) {
  console.error(`FAIL one load on the wall: ${"reason" in onePanelWall ? onePanelWall.reason : ""} ${"reason" in oneToolWall ? oneToolWall.reason : ""}`);
  process.exit(1);
}
eq("one load: the same wall request", oneToolWall.request, onePanelWall.request);
eq("one load: the same plan body, with no case weights", planBody(oneToolWall, oneTool.caseWeights), planBody(onePanelWall, onePanel.caseWeights));

function refusal(name: string, got: unknown, code: string, reason: string) {
  const row = got as { code?: string; reason?: string };
  eq(name, "code" in (got as object) ? { code: row.code, reason: row.reason } : got, { code, reason });
}
const badWeight = ribsLoadRequest(read, { loadCases: [{ name: "spread", loads: [rawPressure] }, { name: "point", weight: 0, loads: [rawForce] }] });
refusal("a weight that is not above zero is refused, naming the case", badWeight, "bad-argument", "Load case 2: weight is a number above zero.");
const tooMany = ribsLoadRequest(read, { loadCases: Array.from({ length: 9 }, () => ({ name: "c", loads: [rawPressure] })) });
refusal("more than 8 cases is refused, saying 8 is the most", tooMany, "bad-argument", "loadCases takes up to 8 cases; this has 9.");
eq("the panel still turns a weight of 0 into 1", loadRequest([], [{ name: "a", weight: 0, loads: [force] }, { name: "b", weight: 2, loads: [pressure] }]).caseWeights, [1, 2]);

// Creases go to the planner only for a wall read with folded; any other wall plans as v6.12 did.
eq("a plain wall's plan options carry no creases", planOptions(oneToolWall, true), { baselines: true });
eq("baselines off stays off", planOptions(oneToolWall, false), { baselines: false });
const foldedWall = ribWall(solid, { picked: [6], loads: oneTool.loads, folded: true });
if ("reason" in foldedWall) {
  console.error(`FAIL the folded wall: ${foldedWall.reason}`);
  process.exit(1);
}
eq("a folded wall's plan options ask for creases", planOptions(foldedWall, true), { baselines: true, creases: true });

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("ribs-load-request: ok");
