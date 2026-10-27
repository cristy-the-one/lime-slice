/**
 * Gaps batch A against real Open CASCADE: a part built with model_build from expressions follows its parameters. A
 * small LED-cover-like part (a rounded-rectangle plate driven by w, h, r and t, a mirrored boss at ±u, a pocket at px,
 * and a peg placed with `use`) is rebuilt through model_params {rebuild: true}, the app's own Rebuild path, after each
 * parameter changes, and its box and volume must match the numbers. Then the recipe is rerun after a change.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { usedByCount } from "../src/modeling/params.ts";
import type { ModelOp } from "../src/model-tree.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("vars-drive: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("vars-drive: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-vars-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "60";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const session = new Session(loadEngineWorker(root));
const call = (name: string, args: unknown = {}) => session.call(name, args) as Promise<Record<string, any>>;

type Values = { w: number; h: number; r: number; t: number; u: number; px: number; d: number };
const start: Values = { w: 60, h: 40, r: 5, t: 3, u: 20, px: -10, d: 4 };

/** The plate's area with rounded corners, times its thickness; two Ø6 × 5 bosses; a 6 × 6 × 2 pocket; a peg Ø d × 4. */
function volume(v: Values): number {
  return (v.w * v.h - (4 - Math.PI) * v.r ** 2) * v.t + 2 * Math.PI * 9 * 5 - 72 + Math.PI * (v.d / 2) ** 2 * 4;
}

function box(v: Values): { min: number[]; max: number[] } {
  const x = Math.max(v.w / 2, v.u + 3);
  return { min: [-x, -v.h / 2, 0], max: [x, v.h / 2, v.t + 5] };
}

const k = 0.70710678;
const loop = {
  start: ["-w/2 + r", "-h/2"],
  segments: [
    { kind: "line", to: ["w/2 - r", "-h/2"] },
    { kind: "arc", through: [`w/2 - r + r*${k}`, `-h/2 + r - r*${k}`], to: ["w/2", "-h/2 + r"] },
    { kind: "line", to: ["w/2", "h/2 - r"] },
    { kind: "arc", through: [`w/2 - r + r*${k}`, `h/2 - r + r*${k}`], to: ["w/2 - r", "h/2"] },
    { kind: "line", to: ["-w/2 + r", "h/2"] },
    { kind: "arc", through: [`-w/2 + r - r*${k}`, `h/2 - r + r*${k}`], to: ["-w/2", "h/2 - r"] },
    { kind: "line", to: ["-w/2", "-h/2 + r"] },
    { kind: "arc", through: [`-w/2 + r - r*${k}`, `-h/2 + r - r*${k}`], to: ["-w/2 + r", "-h/2"] },
  ],
};
const recipe = {
  base: { primitive: "box", dx: "w - 2*r", dy: "h - 2*r", dz: "t" },
  ops: [
    { kind: "extrude", op: "fuse", loops: [loop], depth: "t", origin: [0, 0, 0], turn: [0, 0, 0], label: "plate" },
    { kind: "mirror", plane: "x", op: { kind: "boolean", op: "fuse", primitive: "cylinder", radius: 3, height: 5, origin: ["u", 0, "t"] }, label: "bosses" },
    { kind: "boolean", op: "cut", primitive: "box", dx: 6, dy: 6, dz: 2, centre: ["px", -8, "t - 1"], label: "pocket" },
    { kind: "use", part: "peg", with: { pr: "d/2" }, label: "peg" },
  ],
};

const near = (a: unknown, b: number, tol = 0.05) => typeof a === "number" && Math.abs(a - b) <= tol;
const sameBox = (got: { min?: number[]; max?: number[] } | null | undefined, want: { min: number[]; max: number[] }) =>
  !!got?.min && !!got.max && want.min.every((n, i) => near(got.min![i], n)) && want.max.every((n, i) => near(got.max![i], n));

await call("model_params", { set: { ...start } });
const peg = await call("model_define", { name: "peg", params: { pr: 2 }, ops: [{ kind: "boolean", op: "fuse", primitive: "cylinder", radius: "pr", height: 4, origin: [0, "h/2 - 6", "t"] }] });
check("the peg part is defined", peg.ok === true, JSON.stringify(peg));
const built = await call("model_build", { ...recipe, name: "cover" });
const object = String(built.object);
check("model_build builds the cover", built.ok === true && sameBox(built.bounds, box(start)), JSON.stringify(built));
const described = await call("model_describe", { object });
check("its volume is the numbers'", near(described.volumeMm3, volume(start), 0.5), `${described.volumeMm3} vs ${volume(start)}`);

// Items 1–3: every parameter is used by a step, as the app's Parameters panel counts them.
const saved = await call("project_save", { name: "cover.lime" });
const doc = JSON.parse(readFileSync(String(saved.path), "utf8")) as { objects: { modelTree?: { rootExprs?: Record<string, string>; nodes?: { op?: ModelOp | null }[] } }[] };
const tree = doc.objects.find((row) => row.modelTree?.nodes?.some((node) => node.op?.kind === "extrude"))!.modelTree!;
const ops = (tree.nodes ?? []).map((node) => node.op ?? null);
for (const name of Object.keys(start)) {
  const count = usedByCount(name, ops, tree.rootExprs);
  check(`${name} is used by ${count} step(s)`, count > 0);
}

// Item 5: each parameter changed through model_params {rebuild}, one at a time.
let now = { ...start };
const changes: Partial<Values>[] = [{ w: 70 }, { h: 50 }, { r: 8 }, { u: 15 }, { px: -5 }, { d: 6 }, { t: 4 }];
for (const change of changes) {
  now = { ...now, ...change };
  const [name, value] = Object.entries(change)[0]!;
  const done = await call("model_params", { set: change, rebuild: true });
  const row = (done.rebuilt as Record<string, any>[] | undefined)?.find((entry) => entry.object === object);
  check(`${name} = ${value}: the cover rebuilds and commits`, done.ok === true && row?.ok === true && row.committed === true, JSON.stringify(done).slice(0, 600));
  check(`${name} = ${value}: its box follows`, sameBox(row?.bounds, box(now)), JSON.stringify(row?.bounds));
  check(`${name} = ${value}: its volume follows`, near(row?.volumeMm3, volume(now), 0.5), `${row?.volumeMm3} vs ${volume(now)}`);
  check(`${name} = ${value}: the check comes back`, row?.check?.ok === true, JSON.stringify(row?.check).slice(0, 200));
}
const again = await call("model_params", { rebuild: true });
check("a rebuild with nothing out of date changes nothing", again.ok === true && Array.isArray(again.rebuilt) && again.rebuilt.length === 0, JSON.stringify(again));

// Item 4: a rerun after a change is not refused and not stale.
now = { ...now, w: 80 };
await call("model_params", { set: { w: 80 } });
const rerun = await call("model_build", { object });
check("a rerun after w changed is not refused", rerun.ok === true, JSON.stringify(rerun));
check("the rerun's base follows w", rerun.resumed?.newBase === true, JSON.stringify(rerun.resumed));
check("the rerun's box follows", sameBox(rerun.bounds, box(now)), JSON.stringify(rerun.bounds));
const rerunVolume = await call("model_describe", { object });
check("the rerun's volume follows", near(rerunVolume.volumeMm3, volume(now), 0.5), `${rerunVolume.volumeMm3} vs ${volume(now)}`);
now = { ...now, u: 18 };
await call("model_params", { set: { u: 18 } });
const second = await call("model_build", { object });
check("a rerun after u changed reuses the ops before the boss, and runs the rest", second.ok === true && second.resumed?.reusedOps === 1 && second.resumed?.ranOps === 3, JSON.stringify(second.resumed));
check("and the box follows u", sameBox(second.bounds, box(now)), JSON.stringify(second.bounds));
const fresh = await call("model_build", { object, resume: false });
check("resume: false on an object runs every op again", fresh.ok === true && fresh.resumed?.reusedOps === 0 && fresh.resumed?.ranOps === 4, JSON.stringify(fresh.resumed));
// The rerun keeps its links: a set-and-rebuild still follows.
now = { ...now, h: 44 };
const after = await call("model_params", { set: { h: 44 }, rebuild: true });
const afterRow = (after.rebuilt as Record<string, any>[] | undefined)?.find((entry) => entry.object === object);
check("after a rerun, a rebuild still follows", afterRow?.ok === true && sameBox(afterRow.bounds, box(now)) && near(afterRow.volumeMm3, volume(now), 0.5), JSON.stringify(afterRow).slice(0, 400));

// Item 4: a call-level value for a project parameter is for that call only.
const once = await call("model_build", { base: { primitive: "box", dx: "w", dy: 10, dz: 4 }, params: { w: 30 }, name: "strip" });
check("a call-level w builds at 30", once.ok === true && sameBox(once.bounds, { min: [-15, -5, 0], max: [15, 5, 4] }), JSON.stringify(once));
check("and says it was for this call only", JSON.stringify(once.oneOff) === '["w"]', JSON.stringify(once));
const followed = await call("model_build", { object: once.object });
check("a rerun uses the project's w", followed.ok === true && sameBox(followed.bounds, { min: [-40, -5, 0], max: [40, 5, 4] }), JSON.stringify(followed));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("mcp vars-drive: ok");
process.exit(0);
