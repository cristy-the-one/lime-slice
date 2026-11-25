/**
 * A thin sweep fused onto a lofted skin that bends sharply, against real Open CASCADE.
 * Stand-in only, not a customer part. Each row is printed before any check, including a failure.
 *
 * Attempts 1–3 kept the part at every step: an analytic cone, a ruled crease, and a smoothed
 * loft with a kicked tail. The kicked tail did refuse some caps as damaged solids, and the
 * volume still rose. This attempt lays the tube on the inner skin of a smoothed elbow that
 * tightens at the tail.
 *
 * Skips without LIME_OCCT_BRIDGE; fails in CI when it is unset. Ends with process.exit.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("fuse-graze: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("fuse-graze: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-fuse-graze-occt-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "60";

const TUBE_R = 0.45;
const BODY_R = 5;
/** Centerline bend radius, then a tighter tail. */
const BEND_R = 18;
const TAIL_R = 9;
const TAIL_AT = 60;
/** The cap extremity sits this far into the tight tail, degrees. */
const END_PHI = 18;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type Cap = "round" | "flat" | "point";
type Reply = Record<string, unknown>;
const session = new Session(loadEngineWorker(root));

async function call(tool: string, args: Record<string, unknown>): Promise<Reply> {
  try {
    let reply = await session.call(tool, args);
    while (reply.job && reply.status === "running") {
      const waited = await session.call("slice_wait", { job: reply.job, timeoutS: 10 });
      if (waited.status !== "running") reply = (waited.result as Reply | undefined) ?? waited;
    }
    return reply;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

const num = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(6) : "na");
const oneLine = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").slice(0, 180);
/** The session's fuse slack, unchanged: the larger of a ten-thousandth of the part and 0.01 mm³. */
const loses = (before: number, after: number) => after < before - Math.max(before * 1e-4, 0.01);

const deg = (value: number) => (value * Math.PI) / 180;
const tailSin = Math.sin(deg(TAIL_AT));
const tailCos = Math.cos(deg(TAIL_AT));
/** Inward normal and tangent of the main arc where the tight tail begins. */
const inward: [number, number, number] = [-tailSin, 0, -tailCos];
const tangent: [number, number, number] = [tailCos, 0, -tailSin];
const tailJoin = [BEND_R * tailSin, 0, BEND_R * tailCos];
const tailCentre: [number, number, number] = [tailJoin[0] + inward[0] * TAIL_R, 0, tailJoin[2] + inward[2] * TAIL_R];
const outward0: [number, number, number] = [-inward[0], 0, -inward[2]];

function mainPoint(angle: number, radius: number): [number, number, number] {
  return [radius * Math.sin(deg(angle)), 0, radius * Math.cos(deg(angle))];
}

function tailPoint(phi: number, radius: number): [number, number, number] {
  const p = deg(phi);
  const ox = outward0[0] * Math.cos(p) + tangent[0] * Math.sin(p);
  const oz = outward0[2] * Math.cos(p) + tangent[2] * Math.sin(p);
  return [tailCentre[0] + radius * ox, 0, tailCentre[2] + radius * oz];
}

/** Plane turn whose normal follows the arc. At the join this matches the tail tangent. */
function mainTurn(angle: number): [number, number, number] {
  return [0, angle + 90, 0];
}

function tailTurn(phi: number): [number, number, number] {
  const p = deg(phi);
  const tx = -outward0[0] * Math.sin(p) + tangent[0] * Math.cos(p);
  const tz = -outward0[2] * Math.sin(p) + tangent[2] * Math.cos(p);
  return [0, (Math.atan2(tx, tz) * 180) / Math.PI, 0];
}

/** Distance from the bend centre to a tube that bites `inset` mm into the inner skin. */
function mainRadius(inset: number): number {
  return BEND_R - BODY_R - TUBE_R + inset;
}

function tailRadius(inset: number): number {
  return TAIL_R - BODY_R - TUBE_R + inset;
}

function zTip(inset: number): number {
  return tailPoint(END_PHI, tailRadius(inset))[2];
}

function tube(cap: Cap, inset: number): Record<string, unknown> {
  const reach = cap === "flat" ? 0 : (TUBE_R / TAIL_R) * (180 / Math.PI);
  const endPhi = END_PHI - reach;
  const through: [number, number, number][] = [
    mainPoint(16, mainRadius(inset)),
    mainPoint(36, mainRadius(inset)),
    mainPoint(54, mainRadius(inset)),
    tailPoint(6, tailRadius(inset)),
    tailPoint(endPhi, tailRadius(inset)),
  ];
  const op: Record<string, unknown> = {
    kind: "sweep",
    op: "fuse",
    sections: [{ origin: through[0], radius: TUBE_R }],
    spine: { kind: "spline", through },
  };
  if (cap !== "flat") {
    op.capEnd = cap;
    op.capLength = TUBE_R;
  }
  return op;
}

console.log("fuse-graze attempt 4: smoothed elbow, centerline radius 18 to 60°, then radius 9. Tube radius 0.45 on the inner skin, end 18° into the tight tail, inset 0.10 to 0.25 mm.");
console.log("fuse-graze attempt 3, for the record: smoothed loft with a kicked tail. Plain fuse kept the volume at all 48 steps (rose by about 5 mm³). Flat caps and one round cap were refused as damaged solids; the volume guard never tripped.");
console.log("fuse-graze attempts 1 and 2, for the record: analytic cone and ruled crease. Plain fuse kept the part at all 48 steps (volume rose by about 4.8 and 6.2 mm³).");
console.log("fuse-graze retry: when the plain fuse (fuzzy 1e-7) is short of the part by the volume guard's own slack, a new boolean uses fuzzy 1e-5. The guard is unchanged. No mesh fallback.");

let exitCode = 0;
try {
  const made = await call("solid_new", {
    feature: {
      kind: "loft",
      ruled: false,
      smoothing: true,
      sections: [
        ...[0, 20, 40, 60].map((angle) => ({ origin: mainPoint(angle, BEND_R), turn: mainTurn(angle), radius: BODY_R })),
        ...[12, 24, 36].map((phi) => ({ origin: tailPoint(phi, TAIL_R), turn: tailTurn(phi), radius: BODY_R })),
      ],
    },
  });
  const object = String(made.object ?? "");
  const tub = Number((await call("model_describe", { object, limit: 0 })).volumeMm3);
  console.log(`fuse-graze tub object=${object || "na"} volume=${num(tub)} build=${made.ok === true ? "ok" : oneLine(made.reason ?? made.error)}`);
  check("the lofted tub builds", made.ok === true && object.length > 0 && tub > 1000, oneLine(made.reason ?? made.error));

  const caps: Cap[] = ["round", "flat", "point"];
  let rows = 0;
  let tripped = 0;
  let held = 0;
  const trippedBy: Record<Cap, number> = { round: 0, flat: 0, point: 0 };
  const retriedHeld: Record<Cap, number> = { round: 0, flat: 0, point: 0 };

  if (made.ok === true && object) {
    for (const cap of caps) {
      for (let cents = 10; cents <= 25; cents += 1) {
        const inset = cents / 100;
        const label = `cap=${cap} inset=${inset.toFixed(2)}`;
        const part = Number((await call("model_describe", { object, limit: 0 })).volumeMm3);
        const reply = await call("model_apply", { object, probe: true, op: tube(cap, inset) });
        const trace = session.lastFuseTrace;
        const before = typeof trace?.before === "number" ? trace.before : part;
        const plain = trace?.plain;
        const guard = trace?.guard === true ? "yes" : trace?.guard === false ? "no" : "na";
        const retry = trace?.retry;
        let kept = NaN;
        if (reply.ok === true) {
          kept = Number((await call("model_describe", { object, limit: 0 })).volumeMm3);
          const undone = await call("model_undo", { object });
          if (undone.ok !== true) {
            console.log(`fuse-graze ${label} undo failed: ${oneLine(undone.reason ?? undone.error)}`);
          }
        }
        const apply = reply.ok === true ? "ok" : `${String(reply.code ?? "refused")}: ${oneLine(reply.reason ?? reply.error)}`;
        console.log(`fuse-graze ${label} z=${zTip(inset).toFixed(4)} part=${num(part)} plain=${num(plain)} guard=${guard} retry=${num(retry)} kept=${num(kept)} apply=${apply}`);
        rows += 1;
        const plainLost = typeof plain === "number" && Number.isFinite(before) && loses(before, plain);
        if (guard === "yes" || plainLost) {
          tripped += 1;
          trippedBy[cap] += 1;
        }
        const retryHolds = typeof retry === "number" && Number.isFinite(before) && !loses(before, retry);
        const plainHolds = typeof plain === "number" && Number.isFinite(before) && !loses(before, plain);
        const rowHolds = reply.ok === true && Number.isFinite(part) && Number.isFinite(kept) && !loses(part, kept) && (guard === "yes" ? retryHolds : guard === "no" && plainHolds);
        if (rowHolds) held += 1;
        if (guard === "yes" && retryHolds && reply.ok === true) retriedHeld[cap] += 1;
      }
    }
  }

  console.log(`fuse-graze summary: ${rows} rows, plain fuse lost volume at ${tripped} (round ${trippedBy.round}, flat ${trippedBy.flat}, point ${trippedBy.point}); retry kept ${retriedHeld.round + retriedHeld.flat + retriedHeld.point} of those (round ${retriedHeld.round}, flat ${retriedHeld.flat}, point ${retriedHeld.point}); session kept ${held}.`);
  check("every inset and cap was printed", rows === caps.length * 16, String(rows));
  check("the plain fuse loses volume somewhere in the range", tripped > 0, "no row tripped the guard, so this stand-in did not reproduce the failure");
  check("the fuse holds at every inset and cap", held === rows && rows > 0, `${held} of ${rows}`);
  if (failed) exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
process.exit(exitCode);
