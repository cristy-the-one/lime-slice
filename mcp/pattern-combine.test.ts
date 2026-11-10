/**
 * A pattern in one boolean (`combine: true`), through the MCP server against real Open CASCADE.
 * Every kind of pattern (a row, a grid, round an axis, along a path) and every kind of copy one boolean takes (a plain
 * shape that cuts or adds, an extrude, a pocket of plain cuts) lands as one group, and the solid is the one the same
 * pattern gives built copy by copy: the fingerprint and the same faces and edges. Copies of a plain shape also number
 * every face and edge alike; copies of an extrude or a pocket number them in another order. A copy that misses is
 * counted. What one boolean cannot take is refused in a sentence, and what the one check at the end refuses (a
 * separate piece, a piece cut off, pieces meeting only along an edge, every copy missing) leaves the part and its
 * history as they were. The group undoes and redoes as one step and reopens from a saved project.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { COMBINE_BOTH, COMBINE_KIND } from "../src/modeling/composite-apply.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("pattern-combine: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("pattern-combine: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-pattern-combine-"));
process.env.LIME_MCP_WORKSPACE = workspace;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;
interface Held {
  solid?: { fingerprint: { volumeMm3: number; faces: number; edges: number }; faces: unknown[]; edges: unknown[]; positions: Float32Array };
}
const held = (object: string) => (session as unknown as { find(id: string): Held | undefined }).find(object)?.solid;
/** The faces and edges in their numbering, as text: equal for two solids whose faces and edges are numbered alike. */
const numbered = (object: string) => JSON.stringify([held(object)?.faces, held(object)?.edges]);
/** The faces and edges whatever their numbers: each row without its index, sorted. */
const unnumbered = (object: string) => {
  const rows = (list: unknown[] | undefined) => (list ?? []).map((row) => JSON.stringify({ ...(row as Record<string, unknown>), index: 0 })).sort();
  return JSON.stringify([rows(held(object)?.faces), rows(held(object)?.edges)]);
};

const plate = { primitive: "box", dx: 120, dy: 80, dz: 8 };
const hole = { kind: "boolean", op: "cut", primitive: "cylinder", radius: 2, height: 12, origin: [-50, -30, -2] };
const boss = { kind: "boolean", op: "fuse", primitive: "cylinder", radius: 3, height: 5, origin: [-50, -30, 7] };
const slot = { kind: "extrude", op: "cut", origin: [-52, -30, 8], profile: [[0, 0], [6, 0], [7, 4], [6, 8], [0, 8], [-1, 4]], depth: -3 };
const pocket = { kind: "pocket", face: { normal: [0, 0, 1] }, shape: "rect", from: "centre", at: { u: -45, v: -25 }, width: 10, height: 8, cornerRadius: 2, depth: 3 };

/** The last entry: whether the copies also number every face and edge as the per-copy pattern does. */
const kinds: [string, Record<string, unknown>, Record<string, unknown>, boolean][] = [
  ["a row of holes", plate, { op: hole, linear: { step: [11, 0, 0], count: 10 } }, true],
  ["a grid of holes", plate, { op: hole, linear: { step: [11, 0, 0], count: 10, step2: [0, 15, 0], count2: 5 } }, true],
  ["a grid of bosses", plate, { op: boss, linear: { step: [14, 0, 0], count: 8, step2: [0, 20, 0], count2: 4 } }, true],
  ["holes round an axis", { primitive: "cylinder", radius: 40, height: 8 }, { op: { ...hole, origin: [30, 0, -2] }, polar: { count: 12 } }, true],
  ["bosses along a path", plate, { op: { ...boss, origin: [-50, -30, 7] }, path: { points: [[-50, -30, 7], [0, 20, 7], [50, -30, 7]], count: 9 } }, true],
  ["a grid of extruded slots", plate, { op: slot, linear: { step: [12, 0, 0], count: 9, step2: [0, 30, 0], count2: 2 } }, false],
  ["a grid of rounded pockets", plate, { op: pocket, linear: { step: [18, 0, 0], count: 6, step2: [0, 25, 0], count2: 3 } }, false],
];

for (const [title, base, spec, alike] of kinds) {
  const each = String((await call("solid_new", base)).object);
  const byCopy = await call("model_apply", { object: each, op: { kind: "pattern", ...spec } });
  const one = String((await call("solid_new", base)).object);
  const combined = await call("model_apply", { object: one, op: { kind: "pattern", ...spec, combine: true } });
  check(`${title}: both ways apply`, byCopy.ok === true && combined.ok === true, JSON.stringify([byCopy, combined]).slice(0, 600));
  const a = held(each)?.fingerprint;
  const b = held(one)?.fingerprint;
  check(`${title}: the same faces, edges and volume`, !!a && !!b && a.faces === b.faces && a.edges === b.edges && Math.abs(a.volumeMm3 - b.volumeMm3) < 1e-6 * a.volumeMm3, JSON.stringify([a, b]));
  check(`${title}: the same faces and edges`, unnumbered(each) === unnumbered(one));
  check(`${title}: ${alike ? "every face and edge has the same number" : "numbered in another order"}`, (numbered(each) === numbered(one)) === alike);
  const history = await call("model_history", { object: one });
  const rows = (history.steps ?? history.nodes ?? []) as Reply[];
  check(`${title}: one step in the history`, combined.applied === 1 && rows.filter((row) => row.kind === "group" || row.op?.kind === "group").length <= 1, JSON.stringify(history).slice(0, 400));
  await call("object_remove", { object: each });
  await call("object_remove", { object: one });
}

// A copy that misses the part is counted, and the others land.
{
  const object = String((await call("solid_new", plate)).object);
  const done = await call("model_apply", { object, op: { kind: "pattern", combine: true, op: hole, linear: { step: [30, 0, 0], count: 5 } } });
  check("a copy off the plate is counted as skipped", done.ok === true && done.skipped === 1 && String(done.missedNote).includes("missed"), JSON.stringify(done).slice(0, 500));
  check("and the other four holes are cut", held(object)?.fingerprint.faces === 6 + 4, JSON.stringify(held(object)?.fingerprint));
  await call("object_remove", { object });
}

/** A refusal: the sentence, and the part, its mesh and its history as they were. */
async function refused(title: string, base: Record<string, unknown>, op: Record<string, unknown>, says: (reason: string) => boolean) {
  const object = String((await call("solid_new", base)).object);
  const before = JSON.stringify(held(object)?.fingerprint);
  const mesh = held(object)?.positions.length;
  const was = JSON.stringify(await call("model_history", { object }));
  const done = await call("model_apply", { object, op });
  const reason = String(done.reason ?? done.failed?.reason ?? "");
  check(`${title}: refused in a sentence`, done.ok === false && says(reason), JSON.stringify(done).slice(0, 700));
  check(`${title}: the part is as it was`, JSON.stringify(held(object)?.fingerprint) === before && held(object)?.positions.length === mesh && JSON.stringify(await call("model_history", { object })) === was);
  await call("object_remove", { object });
}

await refused("every copy off the plate", plate, { kind: "pattern", combine: true, op: { ...hole, origin: [500, 0, -2] }, linear: { step: [10, 0, 0], count: 3 } }, (reason) => reason.includes("None of its 3 steps changes the part") || reason.includes("misses"));
await refused("bosses that stand clear of the part", plate, { kind: "pattern", combine: true, op: { ...boss, origin: [-50, -30, 7] }, linear: { step: [0, 0, 20], count: 2 } }, (reason) => reason.includes("separate"));
await refused(
  "slots that cut the plate in two",
  plate,
  { kind: "pattern", combine: true, op: { kind: "boolean", op: "cut", primitive: "box", origin: [-2, -45, -1], dx: 4, dy: 30, dz: 10 }, linear: { step: [0, 30, 0], count: 3 } },
  (reason) => reason.includes("cut off"),
);
await refused(
  "boxes that meet the part only along an edge",
  { primitive: "box", dx: 20, dy: 20, dz: 20 },
  { kind: "pattern", combine: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [-8, -8, 19], dx: 4, dy: 4, dz: 4 }, linear: { step: [4, 4, 0], count: 3 } },
  (reason) => reason.includes("meet only along an edge"),
);
await refused(
  "a pocket with bars cuts and adds",
  plate,
  { kind: "pattern", combine: true, op: { ...pocket, cornerRadius: 0, bars: { vertical: 1 } }, linear: { step: [18, 0, 0], count: 3 } },
  (reason) => reason === COMBINE_BOTH,
);
await refused(
  "copies that keep only the overlap",
  plate,
  { kind: "pattern", combine: true, op: { kind: "boolean", op: "common", primitive: "box", origin: [-55, -35, -1], dx: 100, dy: 60, dz: 10 }, linear: { step: [2, 0, 0], count: 2 } },
  (reason) => reason === COMBINE_KIND,
);

// One undo step, and the same solid after a save and a reopen.
{
  const object = String((await call("solid_new", plate)).object);
  const empty = JSON.stringify(held(object)?.fingerprint);
  await call("model_apply", { object, op: { kind: "pattern", combine: true, label: "vents", op: hole, linear: { step: [11, 0, 0], count: 10, step2: [0, 15, 0], count2: 5 } } });
  const full = JSON.stringify(held(object)?.fingerprint);
  const faces = numbered(object);
  const undone = await call("model_undo", { object });
  check("undo takes the whole pattern back", undone.ok === true && JSON.stringify(held(object)?.fingerprint) === empty, JSON.stringify(undone).slice(0, 300));
  const redone = await call("model_redo", { object });
  check("redo brings it back", redone.ok === true && JSON.stringify(held(object)?.fingerprint) === full && numbered(object) === faces, JSON.stringify(redone).slice(0, 300));
  await call("model_commit", { object });
  const saved = await call("project_save", { name: "combined.lime" });
  check("the project saves", saved.ok === true, JSON.stringify(saved).slice(0, 300));
  const opened = await call("project_open", { path: "combined.lime" });
  const again = String(opened.objects?.[0]?.object);
  const history = await call("model_history", { object: again });
  check("the project reopens with the pattern as one step", opened.ok === true && JSON.stringify(history).includes("vents"), JSON.stringify([opened, history]).slice(0, 600));
  check("and the same solid, face for face", JSON.stringify(held(again)?.fingerprint) === full && numbered(again) === faces, JSON.stringify(held(again)?.fingerprint));
}

rmSync(workspace, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("pattern-combine: ok");
process.exit(0);
