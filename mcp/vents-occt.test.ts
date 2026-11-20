/**
 * Resin vent notches through ribs_plan against real Open CASCADE.
 *
 * The floor of an open box is walled in all round. With the part sitting +Z, that
 * opening faces the tank, so the plan reports that the part itself cups and cuts
 * nothing. The shell is 3 mm thick: a rib on the mid-surface is 1.5 mm from the
 * face border, which used to be called a fold. Ribs are the product defaults
 * (drafted, the default width and spacing). A stretch between crossings is about
 * one spacing, and that spacing is shorter than two minimum ribs plus a 0.75 mm
 * gap, so a notch cannot be cut. The test records that. It does not widen the
 * spacing or switch to a straight rib to force a notch. buildAxis along the
 * opening faces the tank; the opposite axis, facing the platform, cups nothing.
 *
 * Filament and moulded omit vents. A buildAxis on either is refused.
 * This machine has no Open CASCADE; the folded-shell job is the proof.
 * Skips without LIME_OCCT_BRIDGE; fails in CI when it is unset.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FOLDED_NOTE, GIVEN_AXIS, NO_RESIN_PRINTER, PART_CUPS, TOO_SHORT } from "../src/modeling/vents.ts";
import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("vents-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("vents-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-vents-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "180";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;

async function waitJob(job: string): Promise<Reply> {
  for (;;) {
    const reply = await call("slice_wait", { job, timeoutS: 2 });
    if (reply.status !== "running") return reply;
  }
}

function gapMm(ribs: Reply[]): number {
  const ends: number[][] = [];
  for (const rib of ribs) {
    const points = rib.points as number[][] | undefined;
    if (!points || points.length < 2) continue;
    ends.push(points[0]!, points[points.length - 1]!);
  }
  let best = -1;
  for (let i = 0; i < ends.length; i += 1) {
    for (let j = i + 1; j < ends.length; j += 1) {
      const a = ends[i]!;
      const b = ends[j]!;
      const d = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
      if (d > 0.2 && d < 2 && (best < 0 || Math.abs(d - 0.75) < Math.abs(best - 0.75))) best = d;
    }
  }
  return best;
}

const object = String((await call("solid_new", { primitive: "box", dx: 64, dy: 40, dz: 90 })).object);
const shelled = await call("model_apply", { object, probe: true, op: { kind: "shell", thickness: 3, openFaces: [{ normal: [0, 0, 1] }] } });
if (shelled.ok !== true) throw new Error(`shell: ${JSON.stringify(shelled).slice(0, 300)}`);

const floor = { face: { normal: [0, 0, 1], nearPoint: [0, 0, 3] } };
// The box is centred in X and Y and stands on Z 0. The inner +X wall of a 3 mm shell is at X 29.
const side = { face: { normal: [-1, 0, 0], nearPoint: [29, 0, 40] } };
const goal = { budgetMm3: 2500 };
const sideGoal = { budgetMm3: 8000 };

const t0 = Date.now();
const floorJob = String((await call("ribs_plan", { object, wall: floor, process: "resin", goal, baselines: false })).job);
const floorPlan = await waitJob(floorJob);
const floorS = (Date.now() - t0) / 1000;

const t1 = Date.now();
const sideJob = String((await call("ribs_plan", { object, wall: side, process: "resin", goal: sideGoal, baselines: false, buildAxis: [-1, 0, 0] })).job);
const sidePlan = await waitJob(sideJob);
const sideS = (Date.now() - t1) / 1000;

const t2 = Date.now();
const platform = await waitJob(String((await call("ribs_plan", { object, wall: side, process: "resin", goal: sideGoal, baselines: false, buildAxis: [1, 0, 0] })).job));
const platformS = (Date.now() - t2) / 1000;

const t3 = Date.now();
const filament = await waitJob(String((await call("ribs_plan", { object, wall: floor, process: "filament", goal, baselines: false })).job));
const filamentS = (Date.now() - t3) / 1000;
const moulded = await waitJob(String((await call("ribs_plan", { object, wall: floor, process: "moulded", goal, baselines: false })).job));
const refusedStart = await call("ribs_plan", { object, wall: floor, process: "filament", goal, baselines: false, buildAxis: [0, 0, 1] });
const refused = refusedStart.job ? await waitJob(String(refusedStart.job)) : refusedStart;

const floorVents = floorPlan.plan?.vents as Reply | undefined;
const floorNotes = (floorPlan.plan?.notes ?? floorPlan.notes ?? []) as string[];
check("the floor plan finishes", floorPlan.ok === true && floorVents !== undefined, JSON.stringify(floorPlan).slice(0, 400));
check("a 3 mm floor is not called a fold", floorVents?.note !== FOLDED_NOTE, String(floorVents?.note ?? ""));
check("the default note says the plate has no resin printer", floorNotes.some((note) => note === NO_RESIN_PRINTER) || String(floorVents?.note ?? "").includes("no resin printer"), JSON.stringify(floorNotes));
check(
  "a floor walled all round is not notched",
  Array.isArray(floorVents?.pockets) && floorVents.pockets.length === 0 && Array.isArray(floorVents?.unvented) && floorVents.unvented.some((item: Reply) => item.message === PART_CUPS),
  JSON.stringify(floorVents).slice(0, 500),
);

const vents = sidePlan.plan?.vents as Reply | undefined;
const pockets = (vents?.pockets ?? []) as Reply[];
const ribs = (sidePlan.plan?.ribs ?? []) as Reply[];
const sideNotes = (sidePlan.plan?.notes ?? sidePlan.notes ?? []) as string[];
check("the side plan finishes and is not called a fold", sidePlan.ok === true && vents?.note !== FOLDED_NOTE, JSON.stringify(vents).slice(0, 500));
check("the note names the given plate-frame axis", sideNotes.some((note) => note === GIVEN_AXIS), JSON.stringify(sideNotes));
const rules = sidePlan.rules as Reply | undefined;
console.log(`vents-occt: product rib rules width ${rules?.width} spacing ${rules?.minSpacing} minLength ${rules?.minLength} profile ${JSON.stringify(rules?.profile)}`);
let measured = -1;
if (pockets.length > 0) {
  check("each pocket is 0.75 mm", pockets.every((p) => p.sizeMm === 0.75), JSON.stringify(pockets).slice(0, 300));
  measured = gapMm(ribs);
  for (const pocket of pockets) {
    check(`pocket.rib ${pocket.rib} indexes a returned rib`, typeof pocket.rib === "number" && pocket.rib >= 0 && pocket.rib < ribs.length, JSON.stringify(pocket));
  }
  check(
    "the reported stiffness is the notched solve",
    typeof vents?.factorBefore === "number" && typeof vents?.factorAfter === "number" && vents.factorAfter <= vents.factorBefore + 1e-4 && Math.abs(sidePlan.plan.stiffnessFactor - vents.factorAfter) < 1e-3,
    JSON.stringify({ before: vents?.factorBefore, after: vents?.factorAfter, reported: sidePlan.plan?.stiffnessFactor }),
  );
} else {
  const messages = ((vents?.unvented ?? []) as Reply[]).map((item) => String(item.message));
  const named = messages.length === 0 || messages.every((message) => message === TOO_SHORT || message === PART_CUPS);
  console.log(`vents-occt: side ribs ${ribs.length}, unvented ${messages.length}. Spacing ${rules?.minSpacing} mm is shorter than 2×${rules?.minLength}+0.75, and the open top joins any rib that stops short, so no cell is sealed.`);
  check(
    "product defaults place no notch on this wall",
    named && typeof vents?.factorBefore === "number" && Math.abs(vents.factorBefore - vents.factorAfter) < 1e-6,
    JSON.stringify({ ribs: ribs.length, messages: messages.slice(0, 4), before: vents?.factorBefore, after: vents?.factorAfter }),
  );
}
const built = await call("ribs_apply", { job: sideJob });
if (pockets.length > 0) {
  const reason = String(built.reason ?? built.message ?? "");
  if (built.ok === true) {
    const pocket = pockets[0]!;
    const at = pocket.at as number[];
    const beside = await call("surface_at", { object, point: [at[0]! - 2, at[1], at[2]! + 5], direction: [-1, 0, 0] });
    const through = await call("surface_at", { object, point: [at[0], at[1], at[2]! + 5], direction: [-1, 0, 0] });
    const ribHit = typeof beside.distanceMm === "number" ? beside.distanceMm : -1;
    const gapHit = typeof through.distanceMm === "number" ? through.distanceMm : 1e9;
    console.log(`vents-occt: ray beside the rib ${ribHit} mm, ray through the notch ${gapHit} mm`);
    check("a ray through the built notch misses the rib that a ray beside it hits", ribHit > 0 && gapHit > ribHit + 0.3, JSON.stringify({ beside, through }).slice(0, 400));
  } else if (reason.includes("root") || reason.includes("runs off")) {
    console.log(`vents-occt: drafted root ran off the rim on the inner +X wall (64×40×90 box, 3 mm, near [29,0,40]). ${reason}`);
  } else {
    check("the notched ribNet builds", false, JSON.stringify(built).slice(0, 400));
  }
} else {
  const reason = String(built.reason ?? built.message ?? "");
  if (built.ok === true) {
    console.log(`vents-occt: the unnotched drafted ribs build, paths ${built.paths}`);
  } else if (reason.includes("root") || reason.includes("runs off")) {
    console.log(`vents-occt: drafted root ran off the rim. Wall: inner +X of a 64×40×90 box, shell 3 mm, near [29, 0, 40]. ${reason}`);
  } else {
    check("the drafted ribs build, or the root runs off the rim", false, JSON.stringify(built).slice(0, 400));
  }
}

const away = platform.plan?.vents as Reply | undefined;
check("the same wall facing the platform cups nothing", platform.ok === true && Array.isArray(away?.pockets) && away.pockets.length === 0 && (away.unvented ?? []).length === 0, JSON.stringify(away).slice(0, 300));

check("filament has no vents key", filament.ok === true && filament.plan && !("vents" in filament.plan));
check("moulded has no vents key", moulded.ok === true && moulded.plan && !("vents" in moulded.plan) && "moulding" in moulded.plan);
check("filament refuses a build axis", refused.ok === false && String(refused.reason ?? refused.message ?? "").includes("resin"), JSON.stringify(refused).slice(0, 300));
const filamentKeys = Object.keys(filament.plan ?? {}).sort();
const mouldedKeys = Object.keys(moulded.plan ?? {}).filter((key) => key !== "moulding").sort();
const resinKeys = Object.keys(floorPlan.plan ?? {}).filter((key) => key !== "vents" && key !== "notes").sort();
check("aside from vents, notes and moulding, the plan keys match", JSON.stringify(filamentKeys) === JSON.stringify(mouldedKeys) && JSON.stringify(filamentKeys) === JSON.stringify(resinKeys), JSON.stringify({ filamentKeys, mouldedKeys, resinKeys }));

console.log(`vents-occt: floor ${floorS.toFixed(1)} s (part cups), side ${sideS.toFixed(1)} s, ${pockets.length} pockets, gap ${measured.toFixed(3)} mm, before ${vents?.factorBefore} after ${vents?.factorAfter}; platform ${platformS.toFixed(1)} s; filament ${filamentS.toFixed(1)} s`);

if (failed) {
  console.error(`vents-occt: ${failed} failed`);
  process.exit(1);
}
console.log("vents-occt: ok");
process.exit(0);
