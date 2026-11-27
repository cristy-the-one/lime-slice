/**
 * Resin vent notches through ribs_plan against real Open CASCADE.
 *
 * A 120 × 70 × 25 box, shelled to 3 mm, open on top, with the +X short wall removed.
 * The inner floor then has rising borders on three sides and an open edge on the
 * fourth. Rib width, spacing and profile stay the product defaults. The goal is
 * set in the request (stiffer ×2, then ×3, then a budget) until a cell closes.
 * Cells that can reach the open edge are vented; cells that cannot are reported
 * unvented. The gap of each vented cell is measured by rays through the built solid.
 *
 * Filament and moulded omit vents. A buildAxis on either is refused.
 * This machine has no Open CASCADE; the Auto ribs job is the proof.
 * Skips without LIME_OCCT_BRIDGE; fails in CI when it is unset.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CUT_REFUSED, FOLDED_NOTE, GIVEN_AXIS, NO_RESIN_PRINTER, PART_CUPS, TOO_SHORT } from "../src/modeling/vents.ts";
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

function pieceLengths(ribs: Reply[]): string {
  return ribs
    .map((rib, i) => {
      const points = rib.points as number[][] | undefined;
      if (!points || points.length < 2) return `${i}:0`;
      let n = 0;
      for (let k = 1; k < points.length; k += 1) {
        const a = points[k - 1]!;
        const b = points[k]!;
        n += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
      }
      const ends = Array.isArray(rib.ends) ? rib.ends.join("/") : "";
      return `${i}:${n.toFixed(2)}${ends ? `(${ends})` : ""}`;
    })
    .join(" ");
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

function crossingsOf(ribs: Reply[]): number {
  let n = 0;
  for (let i = 0; i < ribs.length; i += 1) {
    const a = (ribs[i]!.points ?? []) as number[][];
    for (let j = i + 1; j < ribs.length; j += 1) {
      const b = (ribs[j]!.points ?? []) as number[][];
      const hit = a.some((p) => b.some((q) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!) < 0.5));
      if (hit) n += 1;
    }
  }
  return n;
}

// Centred in X and Y, standing on Z 0. The +X face is the short wall (70 mm). Removing it, and the top, leaves the inner floor open on that one side.
const object = String((await call("solid_new", { primitive: "box", dx: 120, dy: 70, dz: 25 })).object);
const shelled = await call("model_apply", {
  object,
  probe: true,
  op: { kind: "shell", thickness: 3, openFaces: [{ normal: [0, 0, 1], nearPoint: [0, 0, 25] }, { normal: [1, 0, 0], nearPoint: [60, 0, 12] }] },
});
if (shelled.ok !== true) throw new Error(`shell: ${JSON.stringify(shelled).slice(0, 300)}`);

const floor = { face: { normal: [0, 0, 1], nearPoint: [0, 0, 3] } };
const goals: { name: string; goal: Reply }[] = [
  { name: "stiffer x2", goal: { stiffer: 2 } },
  { name: "stiffer x3", goal: { stiffer: 3 } },
  { name: "budget 8000", goal: { budgetMm3: 8000 } },
];

const named = new Set([PART_CUPS, TOO_SHORT, CUT_REFUSED]);
let chosen: { name: string; job: string; plan: Reply; seconds: number } | null = null;
const tried: string[] = [];
for (const attempt of goals) {
  const t = Date.now();
  const started = await call("ribs_plan", { object, wall: floor, process: "resin", goal: attempt.goal, baselines: false });
  const plan = started.job ? await waitJob(String(started.job)) : started;
  const seconds = (Date.now() - t) / 1000;
  const ribs = (plan.plan?.ribs ?? []) as Reply[];
  const vents = plan.plan?.vents as Reply | undefined;
  const pockets = (vents?.pockets ?? []) as Reply[];
  const unvented = (vents?.unvented ?? []) as Reply[];
  const rules = plan.rules as Reply | undefined;
  const line = `${attempt.name}: ${seconds.toFixed(1)} s, ribs ${ribs.length}, crossings ${crossingsOf(ribs)}, closed ${pockets.length + unvented.length}, pockets ${pockets.length}, unvented ${unvented.length}, width ${rules?.width}, spacing ${rules?.minSpacing}, minLength ${rules?.minLength}, profile ${JSON.stringify(rules?.profile)}, pieces ${pieceLengths(ribs)}`;
  console.log(`vents-occt: ${line}`);
  tried.push(line);
  if (plan.ok === true && pockets.length > 0) {
    chosen = { name: attempt.name, job: String(started.job), plan, seconds };
    break;
  }
}
const floorPlan = chosen?.plan;
const vents = floorPlan?.plan?.vents as Reply | undefined;
const pockets = (vents?.pockets ?? []) as Reply[];
const ribs = (floorPlan?.plan?.ribs ?? []) as Reply[];
const unvented = (vents?.unvented ?? []) as Reply[];
const notes = (floorPlan?.plan?.notes ?? floorPlan?.notes ?? []) as string[];
check("a goal closes a cell on the tray floor", chosen !== null && floorPlan?.ok === true, tried.join(" | "));
check("a 3 mm floor is not called a fold", vents?.note !== FOLDED_NOTE, String(vents?.note ?? ""));
check("the default note says the plate has no resin printer", notes.some((note) => note === NO_RESIN_PRINTER) || String(vents?.note ?? "").includes("no resin printer"), JSON.stringify(notes));
check(
  "cells that cannot reach the open edge are reported",
  unvented.every((item) => named.has(String(item.message))),
  JSON.stringify(unvented).slice(0, 400),
);
const gaps: number[] = [];
if (chosen && pockets.length > 0) {
  check("each pocket is 0.75 mm", pockets.every((p) => p.sizeMm === 0.75), JSON.stringify(pockets).slice(0, 300));
  for (const pocket of pockets) {
    check(`pocket.rib ${pocket.rib} indexes a returned rib`, typeof pocket.rib === "number" && pocket.rib >= 0 && pocket.rib < ribs.length, JSON.stringify(pocket));
  }
  check(
    "the reported stiffness is the notched solve",
    typeof vents?.factorBefore === "number" && typeof vents?.factorAfter === "number" && vents.factorAfter <= vents.factorBefore + 1e-4 && Math.abs(floorPlan!.plan.stiffnessFactor - vents.factorAfter) < 1e-3,
    JSON.stringify({ before: vents?.factorBefore, after: vents?.factorAfter, reported: floorPlan?.plan?.stiffnessFactor }),
  );
  const built = await call("ribs_apply", { job: chosen.job });
  const reason = String(built.reason ?? built.message ?? "");
  if (built.ok !== true && (reason.includes("root") || reason.includes("runs off"))) {
    console.log(`vents-occt: drafted root ran off the rim on the tray floor (120×70×25, shell 3 mm, inner floor near [0,0,3], +X wall removed). ${reason}`);
    check("the notched ribs build", false, reason);
  } else if (built.ok !== true) {
    check("the notched ribs build", false, JSON.stringify(built).slice(0, 400));
  } else {
    console.log(`vents-occt: ribNet ${JSON.stringify(built.ribNet ?? {}).slice(0, 500)}`);
    for (const pocket of pockets) {
      const at = pocket.at as number[];
      const rib = ribs[pocket.rib as number]!;
      const points = (rib.points ?? []) as number[][];
      const a = points[0]!;
      const b = points[points.length - 1]!;
      const da = Math.hypot(a[0]! - at[0]!, a[1]! - at[1]!, a[2]! - at[2]!);
      const db = Math.hypot(b[0]! - at[0]!, b[1]! - at[1]!, b[2]! - at[2]!);
      const end = da <= db ? a : b;
      const prev = da <= db ? (points[1] ?? b) : (points[points.length - 2] ?? a);
      const td = Math.hypot(prev[0]! - end[0]!, prev[1]! - end[1]!, prev[2]! - end[2]!) || 1;
      const tangent = [(prev[0]! - end[0]!) / td, (prev[1]! - end[1]!) / td, (prev[2]! - end[2]!) / td];
      const step = 0.1;
      const rays: { point: number[]; direction: number[] }[] = [];
      for (let s = -2; s <= 2 + 1e-9; s += step) {
        rays.push({
          point: [at[0]! + tangent[0]! * s, at[1]! + tangent[1]! * s, at[2]! + tangent[2]! * s + 15],
          direction: [0, 0, -1],
        });
      }
      const gapEnds = ribs.flatMap((row) => {
        const pts = (row.points ?? []) as number[][];
        const kind = (row.ends ?? []) as string[];
        if (pts.length < 2) return [];
        return [kind[0] === "gap" ? pts[0]! : null, kind[1] === "gap" ? pts[pts.length - 1]! : null].filter((p): p is number[] => p !== null);
      });
      const nearGap = gapEnds
        .map((p) => ({ p, d: Math.hypot(p[0]! - at[0]!, p[1]! - at[1]!, p[2]! - at[2]!) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 2)
        .map((row) => row.p);
      const fmt = (p: number[]) => `[${p.map((n) => n.toFixed(2)).join(", ")}]`;
      const rayAt = (s: number) => fmt([at[0]! + tangent[0]! * s, at[1]! + tangent[1]! * s, at[2]! + tangent[2]! * s + 15]);
      console.log(`vents-occt: notch ends ${nearGap.map(fmt).join(" ")} pocket ${fmt(at)} rays ${rayAt(-2)} ${rayAt(0)} ${rayAt(2)} direction [0, 0, -1]`);
      const reply = await call("surface_at", { object, rays });
      const hits = ((reply.hits ?? []) as Reply[]).map((hit) => (hit.hit === false || typeof hit.distanceMm !== "number" ? null : hit.distanceMm));
      const finite = hits.filter((d): d is number => d !== null);
      const short = finite.length ? Math.min(...finite) : -1;
      const open = hits.map((d) => d === null || d > short + 0.3);
      const mid = Math.round((0 - -2) / step);
      let lo = mid;
      let hi = mid;
      let measured = -1;
      if (open[mid]) {
        while (lo > 0 && open[lo - 1]) lo -= 1;
        while (hi < open.length - 1 && open[hi + 1]) hi += 1;
        measured = (hi - lo) * step + step;
      }
      const beside = hits[Math.min(hits.length - 1, mid + Math.round(1.5 / step))];
      const through = hits[mid];
      gaps.push(measured);
      console.log(`vents-occt: pocket ${pocket.rib} at [${at.map((n) => n.toFixed(2)).join(", ")}] built gap ${measured.toFixed(3)} mm (through ${through} beside ${beside})`);
      check(
        `a ray through the built solid measures pocket ${pocket.rib}`,
        measured > 0.4 && measured < 1.3 && typeof through === "number" && typeof beside === "number" && through > beside + 0.3,
        JSON.stringify({ measured, through, beside, short, at }).slice(0, 400),
      );
    }
  }
}

const small = { budgetMm3: 2500 };
const platformStart = await call("ribs_plan", { object, wall: floor, process: "resin", goal: chosen?.plan ? goals.find((g) => g.name === chosen!.name)!.goal : goals[0]!.goal, baselines: false, buildAxis: [0, 0, -1] });
const platform = platformStart.job ? await waitJob(String(platformStart.job)) : platformStart;
const away = platform.plan?.vents as Reply | undefined;
const awayNotes = (platform.plan?.notes ?? platform.notes ?? []) as string[];
console.log(`vents-occt: platform-facing ok=${platform.ok} status=${platform.status ?? ""} plan=${platform.plan ? Object.keys(platform.plan as Reply).join(",") : "none"} vents=${JSON.stringify(away ?? null).slice(0, 400)} reason=${JSON.stringify(platform.reason ?? platform.message ?? platform.error ?? null).slice(0, 300)}`);
check("the same floor facing the platform cups nothing", platform.ok === true && Array.isArray(away?.pockets) && away.pockets.length === 0 && (away.unvented ?? []).length === 0, JSON.stringify(away ?? null).slice(0, 300));
check("the note names the given plate-frame axis", awayNotes.some((note) => note === GIVEN_AXIS), JSON.stringify(awayNotes));

const tFilament = Date.now();
const filament = await waitJob(String((await call("ribs_plan", { object, wall: floor, process: "filament", goal: small, baselines: false })).job));
const filamentS = (Date.now() - tFilament) / 1000;
const moulded = await waitJob(String((await call("ribs_plan", { object, wall: floor, process: "moulded", goal: small, baselines: false })).job));
const refusedStart = await call("ribs_plan", { object, wall: floor, process: "filament", goal: small, baselines: false, buildAxis: [0, 0, 1] });
const refused = refusedStart.job ? await waitJob(String(refusedStart.job)) : refusedStart;
check("filament has no vents key", filament.ok === true && filament.plan && !("vents" in filament.plan));
check("moulded has no vents key", moulded.ok === true && moulded.plan && !("vents" in moulded.plan) && "moulding" in moulded.plan);
check("filament refuses a build axis", refused.ok === false && String(refused.reason ?? refused.message ?? "").includes("resin"), JSON.stringify(refused).slice(0, 300));
const filamentKeys = Object.keys(filament.plan ?? {}).sort();
const mouldedKeys = Object.keys(moulded.plan ?? {}).filter((key) => key !== "moulding").sort();
const resinKeys = Object.keys(floorPlan?.plan ?? {}).filter((key) => key !== "vents" && key !== "notes").sort();
check("aside from vents, notes and moulding, the plan keys match", chosen !== null && JSON.stringify(filamentKeys) === JSON.stringify(mouldedKeys) && JSON.stringify(filamentKeys) === JSON.stringify(resinKeys), JSON.stringify({ filamentKeys, mouldedKeys, resinKeys }));

console.log(`vents-occt: ${chosen?.name ?? "none"} ${chosen?.seconds.toFixed(1) ?? "-"} s, ${pockets.length} pockets, gaps ${gaps.map((g) => g.toFixed(3)).join(" ") || "-"} mm, unvented ${unvented.length}, before ${vents?.factorBefore} after ${vents?.factorAfter}; filament ${filamentS.toFixed(1)} s; plan ends ${gapMm(ribs).toFixed(3)} mm`);

if (failed) {
  console.error(`vents-occt: ${failed} failed`);
  process.exit(1);
}
console.log("vents-occt: ok");
process.exit(0);
