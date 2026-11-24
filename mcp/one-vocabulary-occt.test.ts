/**
 * E2 items 1 and 4 against real Open CASCADE: a part that opens from an extrude, a revolve, a loft or a sweep
 * (no box under it), and a bending path + profile built as the pipe-shell. Skips without LIME_OCCT_BRIDGE;
 * fails in CI when it is unset. Ends with process.exit(0).
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
    console.error("one-vocabulary-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("one-vocabulary-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-e2-occt-"));
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
interface SolidView { volumeMm3: number }

const engine = loadEngineWorker(root);
const session = new Session(engine);
async function call(name: string, args: unknown): Promise<Reply> {
  try {
    return (await session.call(name, args)) as Reply;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
const solidOf = (object: string): SolidView | undefined => (session as unknown as { find(id: string): { solid?: SolidView; tree?: { root: { kind: string; op?: { kind?: string; spine?: { kind?: string } } } } } | undefined }).find(object)?.solid;
const rootOf = (object: string) => (session as unknown as { find(id: string): { tree?: { root: { kind: string; op?: { kind?: string; spine?: { kind?: string } } } } } | undefined }).find(object)?.tree?.root;
const why = (reply: Reply) => JSON.stringify(reply.reason ?? reply.error ?? reply).slice(0, 400);
const near = (actual: number | undefined, want: number, tol: number) => actual !== undefined && Number.isFinite(actual) && Math.abs(actual - want) <= tol;

try {
  const extrude = await call("solid_new", { feature: { kind: "extrude", profile: [[0, 0], [10, 0], [10, 10], [0, 10]], depth: 10 } });
  check("an extrude root is the 10×10×10 prism", extrude.ok === true && extrude.root === "extrude" && near(solidOf(String(extrude.object))?.volumeMm3, 1000, 1), why(extrude) + ` volume ${solidOf(String(extrude.object))?.volumeMm3}`);

  const revolve = await call("solid_new", { feature: { kind: "revolve", profile: [[4, 0], [8, 0], [8, 6], [4, 6]] } });
  check("a revolve root is the ring's volume", revolve.ok === true && revolve.root === "revolve" && near(solidOf(String(revolve.object))?.volumeMm3, Math.PI * (64 - 16) * 6, 9), why(revolve) + ` volume ${solidOf(String(revolve.object))?.volumeMm3}`);

  const loft = await call("solid_new", { feature: { kind: "loft", sections: [{ origin: [0, 0, 0], profile: [[-10, -10], [10, -10], [10, 10], [-10, 10]] }, { origin: [0, 0, 20], profile: [[-6, -6], [6, -6], [6, 6], [-6, 6]] }] } });
  check("a loft root is the frustum", loft.ok === true && loft.root === "loft" && near(solidOf(String(loft.object))?.volumeMm3, 5226.666, 53), why(loft) + ` volume ${solidOf(String(loft.object))?.volumeMm3}`);

  const sweep = await call("solid_new", { feature: { kind: "sweep", sections: [{ origin: [0, 0, 0], radius: 3 }], spine: { kind: "spline", through: [[0, 0, 0], [0, 0, 20]] } } });
  check("a sweep root is the pipe", sweep.ok === true && sweep.root === "sweep" && near(solidOf(String(sweep.object))?.volumeMm3, Math.PI * 9 * 20, 12), why(sweep) + ` volume ${solidOf(String(sweep.object))?.volumeMm3}`);

  const cut = await call("solid_new", { feature: { kind: "extrude", op: "cut", profile: [[0, 0], [10, 0], [10, 10], [0, 10]], depth: 10 } });
  check("a cut cannot start a part", cut.ok === false && String(cut.reason).includes("Cut and intersect"), why(cut));

  const bend = await call("solid_new", { feature: { kind: "sweep", path: [[0, 0, 0], [30, 0, 0], [30, 30, 0]], profile: [[-2, -2], [2, -2], [2, 2], [-2, 2]], steps: 1 } });
  const root = bend.ok === true ? rootOf(String(bend.object)) : undefined;
  const volume = bend.ok === true ? solidOf(String(bend.object))?.volumeMm3 : undefined;
  check(
    "a bending path and a profile is a pipe, not a loft",
    bend.ok === true && root?.kind === "feature" && root.op?.kind === "sweep" && root.op.spine?.kind === "spline" && volume !== undefined && volume > 700 && volume < 1400 && !String(bend.reason ?? "").includes("could not loft"),
    why(bend) + ` volume ${volume} root ${JSON.stringify(root?.op)}`,
  );
} catch (error) {
  failed += 1;
  console.error(`FAIL one-vocabulary-occt threw ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
if (failed > 0) {
  console.error(`one-vocabulary-occt: ${failed} failed: ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("one-vocabulary-occt: ok");
process.exit(0);
