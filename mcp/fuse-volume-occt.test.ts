/**
 * A thin tube fused along a trimmed lofted body, against real Open CASCADE. Stand-in only, not a customer part.
 *
 * The quick volume measure is a fixed-order Gauss rule with no error bound. On large trimmed B-spline faces it is off
 * by hundreds of mm³ a face, and those errors only partly cancel, so a fuse that adds material can read as one that
 * lost some, and the volume guard refused it. The kernel now measures the part and the result again to 1e-6 relative
 * error before the guard calls a fuse lost. Each row prints before any check, including a failure.
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
    console.error("fuse-volume: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("fuse-volume: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-fuse-volume-occt-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "60";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type Reply = Record<string, unknown>;
const session = new Session(loadEngineWorker(root));
async function call(tool: string, args: Record<string, unknown>): Promise<Reply> {
  try {
    return await session.call(tool, args);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
const num = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "na");
const oneLine = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").slice(0, 160);

/** A tub-like loft along X: squarish sections, wider and taller towards the middle, flat-ish at the bottom. */
const STATIONS = [-88, -86, -83, -76, -40, -5, 6];
const HALF_WIDTH = [14, 20, 25, 29, 30, 27, 22];
const HEIGHT = [30, 36, 40, 44, 46, 44, 38];
function section(x: number, w: number, h: number): Record<string, unknown> {
  const profile: number[][] = [];
  for (let i = 0; i < 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // turn [0, 90, 0]: profile u runs along −Z and v along Y.
    profile.push([-((h / 2) * Math.sign(s) * Math.abs(s) ** 0.6 + h / 2), w * Math.sign(c) * Math.abs(c) ** 0.6]);
  }
  return { origin: [x, 0, 0], turn: [0, 90, 0], profile, smooth: true };
}

/** The tub, trimmed by a cockpit and four side holes so its big side faces are trimmed B-splines. */
async function tub(): Promise<string> {
  const made = await call("solid_new", { feature: { kind: "loft", sections: STATIONS.map((x, i) => section(x, HALF_WIDTH[i]!, HEIGHT[i]!)) } });
  if (made.ok !== true) throw new Error(`the tub loft was refused: ${oneLine(made.reason)}`);
  const object = String(made.object);
  const cuts: Record<string, unknown>[] = [
    { kind: "boolean", op: "cut", primitive: "box", centre: [-30, 0, 46], dx: 50, dy: 40, dz: 20 },
    ...[-60, -50, -20, -10].map((x) => ({ kind: "boolean", op: "cut", primitive: "cylinder", centre: [x, 30, 20], radius: 3, height: 12, turn: [90, 0, 0] })),
  ];
  for (const op of cuts) {
    const cut = await call("model_apply", { object, probe: true, op });
    if (cut.ok !== true) throw new Error(`a tub cut was refused: ${oneLine(cut.reason)}`);
  }
  return object;
}

/** A 0.45 mm tube along the +Y side at height z, its centre `inset` under the skin at each station. */
async function belt(object: string, z: number, inset: number): Promise<number[][]> {
  const path: number[][] = [];
  for (const x of [4, -10, -25, -40, -55, -70, -78, -82]) {
    const hit = await call("surface_at", { object, point: [x, 90, z], direction: [0, -1, 0] });
    if (Array.isArray(hit.point)) path.push([x, Number(hit.point[1]) - inset, z]);
  }
  return path;
}

let exitCode = 0;
try {
  let rows = 0;
  let tripped = 0;
  let accepted = 0;
  let applied = 0;
  let lost = 0;
  for (const inset of [0.1, 0.12, 0.15, 0.18, 0.2, 0.25]) {
    const object = await tub();
    const path = await belt(object, 30, inset);
    const reply = await call("model_apply", { object, probe: true, op: { kind: "sweep", op: "fuse", path, radius: 0.45, up: [0, 0, 1], caps: "round" } });
    const trace = session.lastFuseTrace ?? {};
    console.log(`fuse-volume inset=${inset.toFixed(2)} points=${path.length} quickPart=${num(trace.before)} quickResult=${num(trace.plain)} guard=${String(trace.guard ?? "na")} exactPart=${num(trace.partExact)} exactResult=${num(trace.resultExact)} accepted=${String(trace.accepted ?? "na")} apply=${reply.ok === true ? "ok" : oneLine(reply.reason)}`);
    rows += 1;
    if (trace.guard === true) {
      tripped += 1;
      if (trace.measured === true && trace.accepted === true && Number(trace.resultExact) > Number(trace.partExact)) accepted += 1;
      if (trace.accepted === true && reply.ok === true) applied += 1;
    }
    if (reply.ok !== true && /would be lost/.test(String(reply.reason))) lost += 1;
  }
  console.log(`fuse-volume summary: ${rows} rows; the quick measure called ${tripped} fuses lost; the exact measure found ${accepted} of those adding material.`);
  check("the quick measure calls a fuse that adds material lost somewhere in the range", tripped > 0, "no row tripped the guard, so this stand-in did not reproduce the failure");
  check("every such fuse is measured again and adds material", accepted === tripped, `${accepted} of ${tripped}`);
  // Another guard (pieces meeting along a line) may still refuse a row; that is not the volume guard. One must apply.
  check("a fuse the quick measure called lost is applied", applied > 0, `${applied} of ${tripped}`);
  check("no fuse is refused as losing the part", lost === 0, `${lost} refused`);
  if (failed) exitCode = 1;
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
process.exit(exitCode);
