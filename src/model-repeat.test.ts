import { actionsFor } from "./context-bar.ts";
import { eulerOrient } from "./mesh-place.ts";
import { editPanel } from "./model-edit.ts";
import { IDENTITY_POSE } from "./model-space.ts";
import { renumberedSteps, type ModelOp } from "./model-tree.ts";
import {
  HOLES_NOT_YET,
  MIRROR_KEEPS,
  REPEAT_NOTHING,
  REPEAT_DELETED,
  REPEAT_ONLY,
  REPEAT_PICK,
  expandRepeat,
  followRepeatSources,
  piecesOfStep,
  readRepeatSpec,
  repeatLabel,
  repeatPanel,
  repeatSource,
  repeatTargets,
  type RepeatChoices,
} from "./model-repeat.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}
function near(a: number, b: number, tol = 1e-4) {
  return Math.abs(a - b) < tol;
}

const choices = (over: Partial<RepeatChoices> = {}): RepeatChoices => ({
  mode: "linear",
  axis: "z",
  axisVec: null,
  align: true,
  plane: "z",
  normal: null,
  points: [],
  of: [1],
  ...over,
});

const read = (values: Record<string, number>) => (id: string) => values[id] ?? 0;

const cylinder: ModelOp = {
  kind: "boolean",
  op: "cut",
  primitive: "cylinder",
  origin: [10, 14, 0],
  size: [0, 0, 0],
  radius: 1.5,
  height: 10,
  turn: [0, 0, 0],
};

const polar = readRepeatSpec("pattern", read({
  modelPatCount: 6,
  modelPatCx: 10,
  modelPatCy: 10,
  modelPatCz: 5,
  modelPatAngle: 360,
}), choices({ mode: "polar", axis: "z" }));
check("a polar pattern is a spec", !("reason" in polar));
const spun = "reason" in polar ? null : expandRepeat(polar, [{ id: 1, op: cylinder }], IDENTITY_POSE);
eq("a count of 6 adds five copies; the original stays its own step", spun?.pieces?.length, 5);
check("no copy sits on the original", !!spun?.pieces && spun.pieces.every((piece) => JSON.stringify(piece.spec.origin) !== JSON.stringify([10, 14, 0])));
const origins = [[10, 14, 0], ...(spun?.pieces?.map((piece) => piece.spec.origin) ?? [])];
check("every copy is 4 mm from the axis", origins.every((origin) => near(Math.hypot(origin[0] - 10, origin[1] - 10), 4) && near(origin[2], 0)));
let separated = true;
for (let i = 0; i < origins.length; i += 1) {
  for (let j = i + 1; j < origins.length; j += 1) {
    const gap = Math.hypot(origins[i]![0] - origins[j]![0], origins[i]![1] - origins[j]![1], origins[i]![2] - origins[j]![2]);
    if (!(gap > 3)) separated = false;
  }
}
check("the six holes do not meet", separated);
const removed = (spun?.pieces ?? []).reduce((sum, piece) => sum + Math.PI * piece.spec.radius * piece.spec.radius * piece.spec.height, 0);
eq("with the original, the volume matches six single cuts", removed + Math.PI * 1.5 * 1.5 * 10, 6 * Math.PI * 1.5 * 1.5 * 10);
eq("one history row", spun?.group?.kind, "group");
eq("the row names the turn", repeatLabel(polar as Record<string, unknown>), "Pattern × 6 around Z");
check("the group remembers the steps", Array.isArray((spun?.group?.source as { of?: unknown })?.of) && ((spun?.group?.source as { of: number[] }).of).length === 1);

const box: ModelOp = {
  kind: "boolean",
  op: "cut",
  primitive: "box",
  origin: [6, 8, 8],
  size: [4, 4, 2],
  radius: 0,
  height: 0,
  turn: [0, 0, 0],
};
const mirror = readRepeatSpec("mirror", read({ modelMirX: 10, modelMirY: 10, modelMirZ: 5 }), choices({ plane: "x" }));
const mirrored = "reason" in mirror ? null : expandRepeat(mirror, [{ id: 2, op: box }], IDENTITY_POSE);
eq("a mirror's group holds only the reflection; the original stays its own step", mirrored?.pieces?.map((piece) => [piece.op, piece.spec.origin]), [["cut", [10, 8, 8]]]);
eq("a spec never turns Keep the original off", "keepOriginal" in (mirror as Record<string, unknown>), false);
const dropped = { ...(mirror as Record<string, unknown>), keepOriginal: false };
eq("an old spec without the original is refused, not undone with the opposite Boolean", expandRepeat(dropped, [{ id: 2, op: box }], IDENTITY_POSE).note, MIRROR_KEEPS);
const single = readRepeatSpec("pattern", read({ modelPatSx: 10, modelPatCount: 1, modelPatCount2: 1 }), choices());
eq("a count of 1 adds nothing", "reason" in single ? null : expandRepeat(single, [{ id: 1, op: cylinder }], IDENTITY_POSE).note, REPEAT_NOTHING);

const wedge: ModelOp = { ...box, primitive: "wedge", topX: 2 };
const wedgeMirror = readRepeatSpec("mirror", read({ modelMirX: 0, modelMirY: 0, modelMirZ: 0 }), choices({ plane: "z" }));
check("a wedge cannot be mirrored", !("reason" in wedgeMirror) && !!expandRepeat(wedgeMirror, [{ id: 3, op: wedge }], IDENTITY_POSE).note?.includes("cannot be mirrored"));

const hole: ModelOp = { kind: "hole", origin: [10, 14, 0], axis: [0, 0, -1], radius: 1.5, depth: 10 };
const blind = piecesOfStep(hole);
check("a blind hole is the cylinder it cuts", Array.isArray(blind) && blind.length === 1 && blind[0]!.spec.primitive === "cylinder" && blind[0]!.op === "cut");
/** Where a cylinder piece's axis starts and ends, after its turn about the middle of its axis. */
function axisEnds(spec: { origin: number[]; height: number; turn: number[] }): number[][] {
  const r = eulerOrient(spec.turn[0]!, spec.turn[1]!, spec.turn[2]!);
  const mid = [spec.origin[0]!, spec.origin[1]!, spec.origin[2]! + spec.height / 2];
  const half = [r[2] * spec.height / 2, r[5] * spec.height / 2, r[8] * spec.height / 2];
  const round = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
  return [[0, 1, 2].map((i) => round(mid[i]! - half[i]!)), [0, 1, 2].map((i) => round(mid[i]! + half[i]!))];
}
eq("a blind hole's cylinder runs from the entry point into the part", Array.isArray(blind) ? axisEnds(blind[0]!.spec) : null, [[10, 14, 0], [10, 14, -10]]);
const sideways = piecesOfStep({ kind: "hole", origin: [0, 5, 3], axis: [1, 0, 0], radius: 1, depth: 4 });
eq("a hole along +X runs 4 mm from its entry", Array.isArray(sideways) ? axisEnds(sideways[0]!.spec) : null, [[0, 5, 3], [4, 5, 3]]);
const bored: ModelOp = { ...hole, counterboreRadius: 2.5, counterboreDepth: 3 };
const boreEnds = piecesOfStep(bored);
eq("a counterbore runs 3 mm down from the entry", Array.isArray(boreEnds) ? axisEnds(boreEnds[1]!.spec) : null, [[10, 14, 0], [10, 14, -3]]);
const bore = piecesOfStep(bored);
check("a counterbore is a second cylinder", Array.isArray(bore) && bore.length === 2 && bore[1]!.spec.radius === 2.5);
eq("a through hole is not a fixed cylinder", piecesOfStep({ ...hole, through: true }), { reason: HOLES_NOT_YET });
eq("a fillet is not repeated", piecesOfStep({ kind: "fillet", edges: [1], size: 1 }), { reason: REPEAT_ONLY });

const pair: ModelOp = { kind: "group", label: "Two", steps: [cylinder, box] };
const linear = readRepeatSpec("pattern", read({ modelPatSx: 10, modelPatSy: 0, modelPatSz: 0, modelPatCount: 2, modelPatCount2: 1 }), choices());
const doubled = "reason" in linear ? null : expandRepeat(linear, [{ id: 4, op: pair }], IDENTITY_POSE);
eq("a group contributes each of its booleans, once per new copy", doubled?.pieces?.length, 2);

eq("no step yet asks for a Ctrl-click", repeatTargets([], () => true), REPEAT_PICK);
eq("a deleted step says so", repeatTargets([1, 9], (id) => id === 1), REPEAT_DELETED);

if (spun?.group) {
  const panel = editPanel(spun.group, IDENTITY_POSE, [10, 10, 5]);
  eq("edit reopens Pattern", panel.tool, "pattern");
  eq("on the polar count", panel.fields.modelPatCount, 6);
  eq("around Z", panel.repeat?.axis, "z");
  eq("of the same step", panel.repeat?.of, [1]);
}

const round = "reason" in polar ? null : repeatPanel(polar as Record<string, unknown>);
eq("the panel round-trips the centre", round && [round.fields.modelPatCx, round.fields.modelPatCy, round.fields.modelPatCz], [10, 10, 5]);

const faces = actionsFor("faces").map((action) => action.id);
check("several faces offer Pattern", faces.includes("pattern"));
check("several faces offer Mirror", faces.includes("mirror"));
eq("one face does not offer Pattern", actionsFor("flat-face").some((action) => action.id === "pattern"), false);

// --- D3. A pattern follows its source step when that step is edited, and names the source's new id. ---
const seedPattern = readRepeatSpec("pattern", read({ modelPatSx: 10, modelPatCount: 3, modelPatCount2: 1 }), choices({ of: [1] }));
const seedGroup = "reason" in seedPattern ? null : expandRepeat(seedPattern, [{ id: 1, op: cylinder }], IDENTITY_POSE).group;
const moved: ModelOp = { ...cylinder, origin: [20, 14, 0] } as ModelOp;
const stored = new Map<number, ModelOp>([[1, cylinder], [2, seedGroup!]]);
const followed = followRepeatSources([{ id: 1, op: moved }, { id: 2, op: seedGroup! }], (id) => stored.get(id) ?? null, IDENTITY_POSE);
eq(
  "the copies follow the moved source",
  "ops" in followed ? (followed.ops[1] as { steps: { origin: number[] }[] }).steps.map((step) => step.origin) : followed,
  [[30, 14, 0], [40, 14, 0]],
);
const same = followRepeatSources([{ id: 1, op: cylinder }, { id: 2, op: seedGroup! }], (id) => stored.get(id) ?? null, IDENTITY_POSE);
check("an unchanged source leaves the group as stored", "ops" in same && same.ops[1] === seedGroup);
const asFillet = followRepeatSources([{ id: 1, op: { kind: "fillet", edges: [1], size: 1 } }, { id: 2, op: seedGroup! }], (id) => stored.get(id) ?? null, IDENTITY_POSE);
eq("a source that can no longer be repeated names the pattern", asFillet, { error: REPEAT_ONLY, at: 1 });
const renamed = renumberedSteps(seedGroup!, new Map([[1, 7]]));
eq("a replayed source step's new id is the one the pattern names", (renamed as { source: { of: number[] } }).source.of, [7]);
check("a pattern whose sources are not replayed is unchanged", renumberedSteps(seedGroup!, new Map([[5, 9]])) === seedGroup);

// --- D28. The MCP's pattern repeats an op of its own, not steps of the history: the app has no panel for it.
const mcpPattern: ModelOp = { kind: "group", label: "Pattern", source: { kind: "pattern", op: { kind: "boolean", op: "cut", primitive: "box", dx: 2 }, linear: { step: [5, 0, 0], count: 3 } }, steps: [] };
eq("an MCP pattern is not an app repeat", repeatSource(mcpPattern), null);
const appPattern: ModelOp = { kind: "group", label: "Pattern × 3", source: { kind: "pattern", of: [1], linear: { step: [5, 0, 0], count: 3 } }, steps: [] };
check("an app pattern still is", repeatSource(appPattern) !== null);

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("model-repeat ok");
