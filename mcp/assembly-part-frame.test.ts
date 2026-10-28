/**
 * Assemblies M10 (docs/plan-assemblies.md, D12), through the MCP server against real Open CASCADE: a hook that
 * model_place turned 90° about Z and moved takes a hole at the part-frame X = 10, Y = 5, the numbers
 * e2e/assembly-part-frame.spec.ts types in the app. The step stores those numbers, the hole is cut at the hook's own
 * (10, 5), and in the assembly it stands where the turn puts that point: a pin there sits in it, and a pin where the
 * numbers would land unturned crosses the hook. Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
    console.error("assembly-part-frame: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("assembly-part-frame: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-part-frame-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const near = (value: unknown, expected: number, tol = 1e-3) => typeof value === "number" && Math.abs(value - expected) < tol;

type Pair = { a: string; b: string; verdict: string; volumeMm3?: number };
type Face = { kind: string; radiusMm?: number; centre: number[] };
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, any>;

await call("project_create", {});
// The body is the root, at the origin of model space. The hook is 40 × 40 × 10, centred on its own X and Y.
const body = String((await call("solid_new", { primitive: "box", dx: 40, dy: 30, dz: 20 })).object);
const hook = String((await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 10 })).object);
const placed = await call("model_place", { object: hook, to: body, x: 80, y: 0, z: 20, turnZ: 90 });
check("the hook sits on the body, turned 90° and moved, in its own frame", placed.ok === true && placed.frame === "part", JSON.stringify(placed));
const box = placed.assembledMm as { min: number[]; max: number[] };
check("its assembled box is (60..100, -20..20, 20..30)", [...box.min, ...box.max].every((value, i) => near(value, [60, -20, 20, 100, 20, 30][i]!)), JSON.stringify(box));

// The hole at the part frame's (10, 5), down from the hook's top: the numbers the app's Hole tool sends.
const hole = { kind: "hole", diameterMm: 4, depth: 5, origin: [10, 5, 10], axis: [0, 0, -1] };
const probed = await call("model_probe", { object: hook, op: hole });
check("the hole probes in the part frame", probed.ok === true, JSON.stringify(probed));
const applied = await call("model_apply", { object: hook, op: hole });
check("and applies", applied.ok === true, JSON.stringify(applied));
await call("model_commit", { object: hook });
check("the project saves", (await call("project_save", { name: "frame.lime" })).ok === true);
/** Every hole op in a saved file, wherever its tree keeps it. */
const holesIn = (value: unknown): { origin?: number[] }[] => {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  return [...(row.kind === "hole" ? [row as { origin?: number[] }] : []), ...Object.values(row).flatMap(holesIn)];
};
const stored = holesIn(JSON.parse(readFileSync(join(workspace, "frame.lime"), "utf8"))).map((op) => op.origin);
check("the step stores the numbers as typed", JSON.stringify(stored) === "[[10,5,10]]", JSON.stringify(stored));
const described = await call("model_describe", { object: hook, limit: 50 });
const bore = (described.faces as Face[]).find((face) => face.kind === "cylinder" && near(face.radiusMm, 2, 1e-3));
check("the kernel cut it at the hook's own (10, 5)", !!bore && near(bore.centre[0], 10, 1e-3) && near(bore.centre[1], 5, 1e-3), JSON.stringify(bore));

/** A 3 mm pin standing in the hook's top at model (x, y), in the assembly, and the exact check's pair for it and the hook. */
async function pinAt(x: number, y: number): Promise<Pair | undefined> {
  const pin = String((await call("solid_new", { primitive: "cylinder", radius: 1.5, height: 4 })).object);
  const seated = await call("model_place", { object: pin, to: body, x, y, z: 26 });
  if (seated.ok !== true) throw new Error(JSON.stringify(seated));
  const reply = await call("model_check", { object: pin, interference: true, exact: true });
  await call("object_remove", { object: pin });
  return (reply.pairs as Pair[] | undefined)?.find((row) => [row.a, row.b].includes(pin) && [row.a, row.b].includes(hook));
}

// Turned 90° about Z then moved by (80, 0, 20), the hook's (10, 5) stands at model (75, 10).
const inHole = await pinAt(75, 10);
check("a pin at model (75, 10) sits in the hole: it shares no volume with the hook", !inHole || (inHole.verdict === "touch" && inHole.volumeMm3 === 0), JSON.stringify(inHole));
const unturned = await pinAt(90, 5);
check("a pin where the numbers land unturned, (90, 5), crosses the hook", unturned?.verdict === "crossing" && (unturned.volumeMm3 ?? 0) > 20, JSON.stringify(unturned));

if (failed > 0) {
  console.error(`assembly-part-frame: ${failed} failed`);
  process.exit(1);
}
console.log("assembly-part-frame: ok");
process.exit(0);
