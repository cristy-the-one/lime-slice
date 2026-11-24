/**
 * Round and point caps on a pipe-shell, against real Open CASCADE.
 * A profile along a curved path, and sections along a spine with 90° elbows.
 * Skips without LIME_OCCT_BRIDGE; fails in CI when it is unset. Ends with process.exit(0).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { shellCount } from "../src/mesh-shells.ts";
import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("pipe-caps-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("pipe-caps-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-pipe-caps-occt-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "180";

let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  failures.push(name);
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type V3 = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
interface FaceRow { kind: string; centre: V3; normal?: V3 }
interface ContinuityEdge { kind?: string; mid?: V3; angleDeg?: number }
interface SolidView {
  volumeMm3: number;
  positions: ArrayLike<number>;
  faces: FaceRow[];
  bounds: { min: V3; max: V3 };
}

const engine = loadEngineWorker(root);
const session = new Session(engine);
async function call(name: string, args: unknown): Promise<Reply> {
  try {
    return (await session.call(name, args)) as Reply;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
const solidOf = (object: string): SolidView | undefined =>
  (session as unknown as { find(id: string): { solid?: SolidView } | undefined }).find(object)?.solid;
const why = (reply: Reply) => JSON.stringify(reply.failed?.reason ?? reply.reason ?? reply.error ?? reply).slice(0, 500);

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const n = len(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

function shells(solid: SolidView | undefined): number {
  if (!solid || solid.positions.length < 9) return 0;
  const positions = solid.positions instanceof Float32Array ? solid.positions : Float32Array.from(solid.positions);
  return shellCount(positions);
}

/** Outward normals of the two flat end faces, matched to the path's ends. */
function endFrames(solid: SolidView, start: V3, end: V3): { at: V3; out: V3 }[] | undefined {
  const planes = solid.faces.filter((face) => face.kind === "plane" && face.normal && face.normal.length === 3);
  if (planes.length < 2) return undefined;
  const centre = solid.bounds.min.map((value, i) => (value + solid.bounds.max[i]!) / 2) as V3;
  const frames = planes.map((face) => {
    let out = unit(face.normal!);
    if (dot(out, sub(face.centre, centre)) < 0) out = unit([-out[0], -out[1], -out[2]]);
    return { at: face.centre, out };
  });
  const take = (point: V3) => frames.splice(frames.reduce((best, frame, index) => len(sub(frame.at, point)) < len(sub(frames[best]!.at, point)) ? index : best, 0), 1)[0];
  const a = take(start);
  const b = take(end);
  return a && b ? [a, b] : undefined;
}

function reach(solid: SolidView, frame: { at: V3; out: V3 }): number {
  let max = -Infinity;
  const p = solid.positions;
  for (let i = 0; i + 2 < p.length; i += 3) max = Math.max(max, dot([p[i]!, p[i + 1]!, p[i + 2]!], frame.out) - dot(frame.at, frame.out));
  return max;
}

/** The vertices at the far end along `frame`, and how far apart they sit. A tip is one point. */
function tipOf(solid: SolidView, frame: { at: V3; out: V3 }): { count: number; spread: number; reach: number } {
  const p = solid.positions;
  const rows: { point: V3; along: number }[] = [];
  let max = -Infinity;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const point: V3 = [p[i]!, p[i + 1]!, p[i + 2]!];
    const along = dot(point, frame.out) - dot(frame.at, frame.out);
    max = Math.max(max, along);
    rows.push({ point, along });
  }
  const atTip = rows.filter((row) => row.along > max - 0.05);
  let spread = 0;
  for (const a of atTip) for (const b of atTip) spread = Math.max(spread, len(sub(a.point, b.point)));
  return { count: atTip.length, spread, reach: max };
}

function seamEdges(edges: ContinuityEdge[], frame: { at: V3; out: V3 }): ContinuityEdge[] {
  return edges.filter((edge) => {
    const mid = edge.mid;
    if (!mid || mid.length !== 3) return false;
    const along = Math.abs(dot(sub(mid, frame.at), frame.out));
    const radial = len(sub(sub(mid, frame.at), add([0, 0, 0], frame.out, dot(sub(mid, frame.at), frame.out))));
    return along < 1.2 && radial < 6;
  });
}

const profile = [[-2, -2], [2, -2], [2, 2], [-2, 2]];
const path: V3[] = [[0, 0, 0], [15, 1, 0], [30, 4, 1], [45, 6, 1], [60, 4, 0]];

try {
  const flat = await call("solid_new", { feature: { kind: "sweep", path, profile, steps: 1 } });
  const round = await call("solid_new", { feature: { kind: "sweep", path, profile, caps: "round", steps: 1 } });
  const flatSolid = flat.ok === true ? solidOf(String(flat.object)) : undefined;
  const roundSolid = round.ok === true ? solidOf(String(round.object)) : undefined;
  const chordFrames = [
    { at: path[0]!, out: unit(sub(path[0]!, path[1]!)) },
    { at: path[path.length - 1]!, out: unit(sub(path[path.length - 1]!, path[path.length - 2]!)) },
  ];
  const frames = (flatSolid ? endFrames(flatSolid, path[0]!, path[path.length - 1]!) : undefined) ?? chordFrames;
  const checked = round.ok === true ? await call("model_check", { object: round.object, surfaces: true }) : { ok: false };
  const edges = (checked.continuity?.edges ?? []) as ContinuityEdge[];
  const seams = frames ? frames.map((frame) => seamEdges(edges, frame)) : [];
  const g1 = seams.length === 2 && seams.every((rows) => rows.length >= 3 && rows.every((row) => row.kind === "G1" || row.kind === "G2"));
  check(
    "a curved profile with round caps is one closed solid, larger than the flat pipe, G1 at both seams",
    flat.ok === true && round.ok === true && flatSolid !== undefined && roundSolid !== undefined
      && shells(roundSolid) === 1 && roundSolid.volumeMm3 > flatSolid.volumeMm3
      && checked.ok === true && checked.continuity?.gaps === 0 && g1,
    why(round) + ` flat ${flatSolid?.volumeMm3} round ${roundSolid?.volumeMm3} shells ${shells(roundSolid)} gaps ${checked.continuity?.gaps} seams ${seams.map((rows) => rows.map((row) => `${row.kind}@${row.angleDeg}`).join(",")).join(" | ")} ${why(checked)}`,
  );

  const point = await call("solid_new", { feature: { kind: "sweep", path, profile, caps: "point", steps: 1 } });
  const pointSolid = point.ok === true ? solidOf(String(point.object)) : undefined;
  const tips = frames && pointSolid ? frames.map((frame) => tipOf(pointSolid, frame)) : [];
  const flatTips = frames && flatSolid ? frames.map((frame) => tipOf(flatSolid, frame)) : [];
  check(
    "point caps end in a tip past the flat end",
    point.ok === true && pointSolid !== undefined && flatSolid !== undefined && shells(pointSolid) === 1
      && pointSolid.volumeMm3 > flatSolid.volumeMm3
      && tips.length === 2 && flatTips.length === 2
      && tips.every((tip, i) => tip.count >= 1 && tip.spread < 0.15 && tip.reach > flatTips[i]!.reach + 1),
    why(point) + ` volume ${pointSolid?.volumeMm3} tips ${JSON.stringify(tips)} flat ${JSON.stringify(flatTips)}`,
  );

  const startOnly = await call("solid_new", { feature: { kind: "sweep", path, profile, capStart: "round", steps: 1 } });
  const startSolid = startOnly.ok === true ? solidOf(String(startOnly.object)) : undefined;
  const bothReach = frames && roundSolid ? frames.map((frame) => reach(roundSolid, frame)) : [];
  const startReach = frames && startSolid ? frames.map((frame) => reach(startSolid, frame)) : [];
  const flatReach = frames && flatSolid ? frames.map((frame) => reach(flatSolid, frame)) : [];
  check(
    "capStart round changes only the start end",
    startOnly.ok === true && startSolid !== undefined && flatSolid !== undefined && roundSolid !== undefined
      && startSolid.volumeMm3 > flatSolid.volumeMm3 && startSolid.volumeMm3 < roundSolid.volumeMm3
      && startReach.length === 2 && flatReach.length === 2 && bothReach.length === 2
      && startReach[0]! > flatReach[0]! + 1 && Math.abs(startReach[1]! - flatReach[1]!) < 0.4
      && bothReach[1]! > flatReach[1]! + 1,
    why(startOnly) + ` volumes ${flatSolid?.volumeMm3} ${startSolid?.volumeMm3} ${roundSolid?.volumeMm3} reach flat ${flatReach} start ${startReach} both ${bothReach}`,
  );

  const elbowSpine = { kind: "polyline", points: [[0, 0, 0], [40, 0, 0], [40, 40, 0], [40, 40, 40]] };
  const elbowSection = [{ origin: [0, 0, 0], turn: [0, 90, 0], radius: 3 }];
  const elbowFlat = await call("solid_new", { feature: { kind: "sweep", sections: elbowSection, spine: elbowSpine, transition: "round" } });
  const elbowRound = await call("solid_new", { feature: { kind: "sweep", sections: elbowSection, spine: elbowSpine, transition: "round", caps: "round" } });
  const elbowFlatSolid = elbowFlat.ok === true ? solidOf(String(elbowFlat.object)) : undefined;
  const elbowRoundSolid = elbowRound.ok === true ? solidOf(String(elbowRound.object)) : undefined;
  check(
    "a sections and spine sweep with 90 degree elbows takes round caps",
    elbowFlat.ok === true && elbowRound.ok === true && elbowFlatSolid !== undefined && elbowRoundSolid !== undefined
      && shells(elbowRoundSolid) === 1 && elbowRoundSolid.volumeMm3 > elbowFlatSolid.volumeMm3,
    why(elbowRound) + ` flat ${elbowFlatSolid?.volumeMm3} round ${elbowRoundSolid?.volumeMm3} shells ${shells(elbowRoundSolid)} ${why(elbowFlat)}`,
  );
} catch (error) {
  failed += 1;
  console.error(`FAIL pipe-caps-occt threw ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`pipe-caps-occt: ${failed} failed (${failures.join("; ")})`);
  process.exit(1);
}
console.log("pipe-caps-occt: ok");
process.exit(0);
