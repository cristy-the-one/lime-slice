/**
 * A thin sweep fused onto a lofted skin that bends sharply, against real Open CASCADE.
 * Stand-in only: a ruled tub, not a customer part. The tube's end steps along the flare
 * where the barrel's side turns. Each row is printed before any check, including a failure.
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
const FLARE_Z0 = 28;
const FLARE_Z1 = 30.2;
const FLARE_R1 = 12;
const TUBE_R = 0.45;
/** How far the tube's inner side sits inside the barrel. The end then walks up the flare. */
const GRAZE = 0.05;
const CENTER_X = BARREL_R + TUBE_R - GRAZE;
const PATH_Z0 = 20;

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
 * Where the cap extremity sits. `inset` is how far the tube's inner generator is under the skin
 * there: 0.05 mm on the barrel, then more as the flare opens. 0.10 lands 0.0275 mm past the crease.
 */
function zTip(inset: number): number {
  return FLARE_Z0 + ((inset - GRAZE) * (FLARE_Z1 - FLARE_Z0)) / (FLARE_R1 - BARREL_R);
}

function tube(cap: Cap, inset: number): Record<string, unknown> {
  const reach = cap === "flat" ? 0 : TUBE_R;
  const zEnd = zTip(inset) - reach;
  const op: Record<string, unknown> = {
    kind: "sweep",
    op: "fuse",
    sections: [{ origin: [CENTER_X, 0, PATH_Z0], radius: TUBE_R }],
    spine: { kind: "polyline", points: [[CENTER_X, 0, PATH_Z0], [CENTER_X, 0, zEnd]] },
  };
  if (cap !== "flat") {
    op.capEnd = cap;
    op.capLength = TUBE_R;
  }
  return op;
}

console.log("fuse-graze stand-in: ruled loft, circles r=8 from z=0 to z=28, flare to r=12 at z=30.2, then r=12 to z=40.");
console.log(`fuse-graze tube: radius ${TUBE_R}, centerline x=${CENTER_X.toFixed(2)} (${GRAZE.toFixed(2)} mm into the barrel). inset is the inner generator under the skin at the cap extremity, 0.10 to 0.25 mm by 0.01.`);
console.log("fuse-graze retry: when the plain fuse (fuzzy 1e-7) is short of the part by the volume guard's own slack, a new boolean uses fuzzy 1e-5. The guard is unchanged. No mesh fallback.");

let exitCode = 0;
try {
  const made = await call("solid_new", {
    feature: {
      kind: "loft",
      ruled: true,
      sections: [
        { origin: [0, 0, 0], radius: BARREL_R },
        { origin: [0, 0, FLARE_Z0], radius: BARREL_R },
        { origin: [0, 0, FLARE_Z1], radius: FLARE_R1 },
        { origin: [0, 0, 40], radius: FLARE_R1 },
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
        console.log(`fuse-graze ${label} part=${num(part)} plain=${num(plain)} guard=${guard} retry=${num(retry)} kept=${num(kept)} apply=${apply}`);
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
