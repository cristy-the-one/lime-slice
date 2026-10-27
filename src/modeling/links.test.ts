/**
 * Gaps A3. Which stored numbers follow which typed expressions (`linkedExprs`), the text a link is written as, the
 * twin a typed op's expressions are read from, and the app patching a number named by its place.
 */
import type { ModelOp } from "../model-tree.ts";
import { resolveNumbers, resolveTexts, substituteNames } from "./expr.ts";
import { exprLeaves, linearText, linkedExprs, withLeaf, type ExprLeaf } from "./links.ts";
import { expandOpsWithTexts, type PartDef } from "./macro.ts";
import { patchOpNumbers, stepOutOfDate, usedByCount } from "./params.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const json = (value: unknown) => JSON.stringify(value);

// The text a link is written as.
check("a plain link is the typed text", linearText(0, [{ a: 1, text: "w" }]) === "w");
check("a halved link reads as a division", linearText(0, [{ a: 0.5, text: "d" }]) === "(d) / 2");
check("a shifted link keeps the shift first", linearText(-3, [{ a: 1, text: "px" }]) === "-3 + (px)");
check("a mirrored link is negated", linearText(0, [{ a: -1, text: "u" }]) === "-(u)");
check("two terms add up", linearText(2, [{ a: 0.5, text: "w" }, { a: -1, text: "h" }]) === "2 + 0.5 * (w) - (h)");

// Names stand for what they were given: a part's parameter, a `with` value, a loop value.
check("a name in scope is replaced, bracketed", substituteNames("pr * 2", { pr: "d/2", d: "d" }) === "(d/2) * 2");
check("a whole-text name is replaced bare", substituteNames("pr", { pr: "d/2" }) === "d/2");
check("a function name and an exponent stay", substituteNames("sqrt(e) + 1e3", { e: "w", sqrt: "x" }) === "sqrt((w)) + 1e3");
const twin = resolveTexts({ kind: "boolean", op: "cut", dx: "w + 1", dy: 5, origin: ["px", 0, "t"] }, { w: "w", px: "px", t: "t" });
check("a twin keeps text fields and numbers, and each expression as text", json(twin) === json({ kind: "boolean", op: "cut", dx: "w + 1", dy: 5, origin: ["px", 0, "t"] }), json(twin));

const parts = new Map<string, PartDef>([["peg", { params: { pr: 2, hh: "pr * 2" }, ops: [{ kind: "boolean", op: "fuse", primitive: "cylinder", radius: "pr", height: "hh", origin: ["x0", 0, "t"] }] }]]);
const expanded = expandOpsWithTexts(
  [{ kind: "each", var: "x0", values: [-5, 5], ops: [{ kind: "use", part: "peg", with: { pr: "d / 2" } }] }],
  { d: 4, t: 3 },
  { d: "d", t: "t" },
  parts,
  new Set(),
);
check("each and use expand to one op per copy", expanded.length === 2, json(expanded));
const first = expanded[0]!;
check("the part's numbers resolve", json((first.op as { radius: number; height: number; origin: number[] })) === json({ kind: "boolean", op: "fuse", primitive: "cylinder", radius: 2, height: 4, origin: [-5, 0, 3] }), json(first.op));
// A part's default reads the defaults before it, not the `with` value, as its numbers do: hh is 2 * 2.
check("the twin writes the part's names in the project's", json(first.text) === json({ kind: "boolean", op: "fuse", primitive: "cylinder", radius: "d / 2", height: "(2) * 2", origin: ["-5", 0, "t"] }), json(first.text));

// Leaves: expressions that name a project parameter. A loop's value alone, or a number, is not one.
const names = (text: string) => /\b(d|t|w|h|u|px)\b/.test(text);
const leaves = exprLeaves(first.op, first.text, names);
check("leaves are the radius and the Z", json(leaves.map((leaf) => [leaf.path.join("."), leaf.text, leaf.value])) === json([["radius", "d / 2", 2], ["origin.2", "t", 3]]), json(leaves));
check("withLeaf sets one number in a copy", json(withLeaf({ a: [1, 2] }, ["a", 1], 9)) === json({ a: [1, 9] }));

// A box typed in a plane moved by (10, 0, 0): the stored origin is the typed one shifted.
const leaf = (path: (string | number)[], text: string, value: number): ExprLeaf => ({ path, text, value });
const shifted = (values: number[]): ModelOp[] => [{ kind: "boolean", op: "cut", primitive: "box", origin: [values[0]! + 10, 0, 0], size: [values[1]!, 5, 5], radius: 0, height: 5, turn: [0, 0, 0] }];
const one = linkedExprs([leaf(["origin", 0], "px", 2), leaf(["dx"], "w", 6)], shifted, shifted([2, 6]));
check("a shifted origin links by its place, a size by the panel's field", json(one.exprs) === json([{ "@origin.0": "10 + (px)", modelDx: "w" }]) && one.unlinked.length === 0, json(one));
const plain = linkedExprs([leaf(["origin", 0], "px", 2)], (values) => [{ kind: "boolean", op: "cut", primitive: "box", origin: [values[0]!, 0, 0], size: [1, 1, 1], radius: 0, height: 1, turn: [0, 0, 0] }], [null]);
check("a step left out keeps nothing", json(plain.exprs) === "[null]");

// A mirror: one leaf feeds two stored copies, the image negated.
const mirrored = (values: number[]): ModelOp[] => [1, -1].map((s) => ({ kind: "boolean", op: "fuse", primitive: "cylinder", origin: [s * values[0]!, 0, 3], size: [6, 6, 5], radius: 3, height: 5, turn: [0, s < 0 ? 180 : 0, 0] }) as ModelOp);
const pair = linkedExprs([leaf(["op", "origin", 0], "u", 20)], mirrored, mirrored([20]));
check("a mirror links each copy", json(pair.exprs) === json([{ modelX: "u" }, { "@origin.0": "-(u)" }]), json(pair.exprs));

// A turn that does not move as a sum (a section square to a path) is not followed, nor is anything it feeds.
const curved = (values: number[]): ModelOp[] => [{ kind: "loft", op: "fuse", sections: [{ origin: [values[0]!, 0, 0], turn: [Math.atan2(values[0]!, 10) * 57.3, 0, 0], radius: 2 }, { origin: [0, 0, 10], turn: [0, 0, 0], radius: values[1]! }] } as ModelOp];
const bent = linkedExprs([leaf(["path", 0, 0], "a", 3), leaf(["radius"], "r", 2)], curved, curved([3, 2]));
check("a path point that turns a section is unlinked, with what it feeds", json(bent.exprs) === json([{ "@sections.1.radius": "r" }]) && json(bent.unlinked.map((row) => row.text)) === '["a"]', json(bent));

// A count changes how many steps there are: it is unlinked, and the spacing of the copies there are still follows.
const counted = (values: number[]): ModelOp[] => Array.from({ length: Math.round(values[0]!) }, (_, i) => ({ kind: "boolean", op: "fuse", primitive: "box", origin: [i * values[1]!, 0, 0], size: [2, 2, 2], radius: 1, height: 2, turn: [0, 0, 0] }) as ModelOp);
const many = linkedExprs([leaf(["count"], "n", 3), leaf(["spacing"], "s", 5)], counted, counted([3, 5]));
check("a pattern's count is unlinked, its spacing linked", json(many.exprs) === json([null, { modelX: "s" }, { "@origin.0": "2 * (s)" }]) && json(many.unlinked.map((row) => row.text)) === '["n"]', json(many));
// A number that refuses any move at all (a face picked by an expression) leaves nothing known: the op keeps no links.
const picky = (values: number[]): ModelOp[] | null => (Number.isInteger(values[0]) && values[0] === 3 ? [{ kind: "shell", thickness: values[1]!, openFaces: [3] } as ModelOp] : null);
const blind = linkedExprs([leaf(["openFaces", 0], "f", 3), leaf(["thickness"], "t", 2)], picky, picky([3, 2]) ?? []);
check("an op with a number that cannot move keeps no links", blind.exprs.every((row) => row === undefined) && blind.unlinked.length === 2, json(blind));
const sides = (values: number[]): ModelOp[] => [{ kind: "boolean", op: "fuse", primitive: "polygon", origin: [0, 0, 0], size: [values[1]!, values[1]!, 3], radius: 0, height: 3, sides: Math.round(values[0]!), across: values[1]!, turn: [0, 0, 0] } as ModelOp];
const rounded = linkedExprs([leaf(["sides"], "n", 6), leaf(["across"], "a", 10)], sides, sides([6, 10]));
check("a rounded count is unlinked, a size beside it is not", json(rounded.exprs) === json([{ modelAcross: "a" }]) && json(rounded.unlinked.map((row) => row.text)) === '["n"]', json(rounded));

// The app follows a link by place: an extrude's profile point and a face move's distance.
const extrude = { kind: "extrude", op: "fuse", origin: [0, 0, 0], turn: [0, 0, 0], profile: [[0, 0], [30, 0], [30, 20]], depth: 3, exprs: { "@profile.1.0": "w / 2", "@profile.2.0": "w / 2", "@origin.2": "t" } } as unknown as ModelOp;
check("an extrude linked by place is in date", !stepOutOfDate(extrude, { w: 60, t: 0 }));
check("and out of date when w moves", stepOutOfDate(extrude, { w: 70, t: 0 }));
const patched = patchOpNumbers(extrude, { w: 70, t: 2 }).op as unknown as { profile: number[][]; origin: number[] };
check("patching moves each linked point and the plane", json(patched.profile) === "[[0,0],[35,0],[35,20]]" && json(patched.origin) === "[0,0,2]", json(patched));
check("a place-linked step counts as using its parameter", usedByCount("w", [extrude]) === 1 && usedByCount("h", [extrude]) === 0);
const moves = { kind: "moveFaces", faces: [{ face: 3, distance: 2 }, { face: 4, distance: 5 }], exprs: { "@faces.1.distance": "t + 2" } } as unknown as ModelOp;
const pulled = patchOpNumbers(moves, { t: 4 }).op as unknown as { faces: { distance: number }[] };
check("a face move's own distance follows, the other stays", json(pulled.faces.map((row) => row.distance)) === "[2,6]", json(pulled));
const group = { kind: "group", label: "mirror", source: { kind: "mirror", op: {} }, steps: [{ ...mirrored([20])[1]!, exprs: { "@origin.0": "-(u)" } }] } as unknown as ModelOp;
const moved = patchOpNumbers(group, { u: 15 }).op as unknown as { steps: { origin: number[] }[] };
check("a group's step follows its own link", moved.steps[0]!.origin[0] === -15, json(moved));
const spread = patchOpNumbers({ kind: "group", label: "g", steps: [{ kind: "boolean", op: "fuse", primitive: "box", origin: [1, 0, 0], size: [1, 1, 1], radius: 0, height: 1, turn: [0, 0, 0] }], exprs: { "@origin.0": "u" } } as unknown as ModelOp, { u: 9 }).op as unknown as { steps: { origin: number[] }[] };
check("a link by place on a group is not spread to its steps", spread.steps[0]!.origin[0] === 1, json(spread));
check("resolveNumbers and the twin agree on a part number", resolveNumbers("2 * 3", {}) === 6);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("modeling links: ok");
