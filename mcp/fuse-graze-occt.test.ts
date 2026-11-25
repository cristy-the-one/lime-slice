/**
 * A thin sweep fused onto a lofted skin that bends sharply, against real Open CASCADE.
 * Stand-in only, not a customer part. Each row is printed before any check, including a failure.
 *
 * Attempt 1, an analytic cone, and attempt 2, a ruled loft of smooth sections with the end
 * 0.003–0.010 mm past a near-right-angle crease, both kept the part at all 48 steps. This attempt
 * is a smoothed loft whose tail kicks sideways, and a spline tube that crosses that bend.
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

const BARREL_R = 8;
const KICK_Z0 = 24;
/** The outer skin leaves the barrel and runs to x=10 over 0.8 mm, about 68° off the axis. */
const KICK_Z1 = 24.8;
const KICK_X1 = 10;
const TUBE_R = 0.45;
/** How far the tube's inner side sits inside the barrel, before the kick. */
const GRAZE = 0.04;
const CENTER_X = BARREL_R + TUBE_R - GRAZE;
const PATH_Z0 = 16;

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

/**
 * Where the cap extremity sits on the kick. `inset` is how far the inner generator is under the
 * straight generator from the barrel's +X point to the kicked section's +X point.
 */
function zTip(inset: number): number {
  return KICK_Z0 + ((inset - GRAZE) * (KICK_Z1 - KICK_Z0)) / (KICK_X1 - BARREL_R);
}

function tube(cap: Cap, inset: number): Record<string, unknown> {
  const reach = cap === "flat" ? 0 : TUBE_R;
  const zEnd = zTip(inset) - reach;
  const start: [number, number, number] = [CENTER_X, -0.3, PATH_Z0];
  const mid: [number, number, number] = [CENTER_X, 0, (PATH_Z0 + zEnd) / 2];
  const end: [number, number, number] = [CENTER_X, 0.25, zEnd];
  const op: Record<string, unknown> = {
    kind: "sweep",
    op: "fuse",
    sections: [{ origin: start, radius: TUBE_R }],
    spine: { kind: "spline", through: [start, mid, end] },
  };
  if (cap !== "flat") {
    op.capEnd = cap;
    op.capLength = TUBE_R;
  }
  return op;
}

console.log("fuse-graze attempt 3: smooth loft. Barrel r=8 to z=24, then the +X skin runs to x=10 at z=24.8 (center [6,0,24.8], r=4) and on to center [8,0,32], r=4. A spline tube crosses that kick.");
console.log("fuse-graze attempt 2, for the record: ruled smooth 12-point sections, flare r=8 to r=16 over 0.35 mm, end 0.003–0.010 mm past the crease. Plain fuse kept the part at all 48 steps (volume rose by about 6.2 mm³, guard never tripped).");
console.log("fuse-graze attempt 1, for the record: analytic circles, flare r=8 to r=12 over 2.2 mm. Plain fuse kept the part at all 48 steps (volume rose by about 4.8 mm³).");
console.log(`fuse-graze tube: radius ${TUBE_R}, centerline x=${CENTER_X.toFixed(2)} (${GRAZE.toFixed(2)} mm into the barrel), bowed across Y so it crosses the seam at the kick. inset 0.10 to 0.25 mm by 0.01.`);
console.log("fuse-graze retry: when the plain fuse (fuzzy 1e-7) is short of the part by the volume guard's own slack, a new boolean uses fuzzy 1e-5. The guard is unchanged. No mesh fallback.");

let exitCode = 0;
try {
  const made = await call("solid_new", {
    feature: {
      kind: "loft",
      ruled: false,
      sections: [
        { origin: [0, 0, 0], radius: BARREL_R },
        { origin: [0, 0, KICK_Z0], radius: BARREL_R },
        { origin: [6, 0, KICK_Z1], radius: 4 },
        { origin: [8, 0, 32], radius: 4 },
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
