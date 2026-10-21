/**
 * --- A6. Parameter order, expression errors, used-by counts, and the fields a file keeps.
 */
import { defaultProfile } from "../profiles.ts";
import { DEFAULT_PRESET } from "../presets.ts";
import { meshRecord, parseProject, serializeProject, type LimeProject } from "../project.ts";
import { newTree, withChild, type ModelOp } from "../model-tree.ts";
import { readSavedTree, savedTree } from "../model-tree-file.ts";
import { withoutSketch } from "../model-request.ts";
import { evaluateTable, expressionMentions, patchOpNumbers, stepOutOfDate, usedByCount, withExprs } from "./params.ts";
import { panelParamMessage, parametersFoldCount, parametersFoldId, parametersHiddenWhileSketching, readParametersFold, writeParametersFold } from "../ui/parameters.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function box(dz: number, expr?: string): ModelOp {
  return {
    kind: "boolean",
    op: "fuse",
    primitive: "box",
    origin: [0, 0, 0],
    size: [10, 10, dz],
    radius: 0,
    height: dz,
    turn: [0, 0, 0],
    ...(expr ? { exprs: { modelDz: expr } } : {}),
  };
}

const ordered = evaluateTable({ wallW: 60, half: "wallW / 2" });
check("parameters evaluate in order", ordered.rows[1]?.value === 30 && ordered.rows[1]?.error == null && ordered.values.half === 30);
const reversed = evaluateTable({ half: "wallW / 2", wallW: 60 });
check("a later name is not visible yet", reversed.rows[0]?.error === `"wallW" is not a parameter. Set it with model_params first.` && reversed.values.wallW === 60);
check(
  "the panel rewrites that sentence for app users",
  panelParamMessage(reversed.rows[0]?.error ?? "") === `"wallW" is not a parameter. Add it in Parameters above this row, or type a number.`,
);
const bad = evaluateTable({ "1wall": 4, wallH: "nope +" });
check("a bad name is the evaluator's sentence", bad.rows[0]?.error === `"1wall" is not a parameter name. Use letters, digits, and underscores.`);
check("a bad expression keeps the evaluator's sentence", typeof bad.rows[1]?.error === "string" && bad.rows[1]?.error.length > 0 && bad.values.wallH == null);

check("wall is not a prefix of wallH", !expressionMentions("wallH / 2", "wall") && expressionMentions("wallH / 2", "wallH"));
check("a function call is not a parameter", !expressionMentions("sin(30)", "sin") && expressionMentions("sin(wallH)", "wallH"));

const grown = patchOpNumbers(box(30, "wallH"), { wallH: 40 });
check("wallH 30 to 40 makes the box 40 tall", grown.op.kind === "boolean" && grown.op.size[2] === 40 && grown.error == null);
const shifted = patchOpNumbers(box(35, "wallH"), { wallH: 40 });
check("a size that drifted from its expression takes the expression's value, as a CAD parameter does", shifted.op.kind === "boolean" && shifted.op.size[2] === 40);
const inDate = box(40, "wallH");
check("a step already in date is the same object", patchOpNumbers(inDate, { wallH: 40 }).op === inDate);
check("the expression stays on the op", grown.op.exprs?.modelDz === "wallH");
check("the box is out of date at the new table", stepOutOfDate(box(30, "wallH"), { wallH: 40 }));
check("the box is in date at the old table", !stepOutOfDate(box(30, "wallH"), { wallH: 30 }));

const plain = box(10);
check("an op with no expression is the same object", withoutSketch(plain) === plain);
const stripped = withoutSketch(box(30, "wallH"));
check("exprs is stripped before an engine call", stripped.exprs == null && stripped !== box(30, "wallH"));
check("a plain number does not become an expression", withExprs(plain, { modelDz: "30" }) === plain);
check("an expression is kept", withExprs(plain, { modelDz: "wallH" }).exprs?.modelDz === "wallH");

const users = usedByCount("wallH", [box(30, "wallH"), box(10), null], { modelDx: "wallH / 2" });
check("used-by counts the root and each step, once", users === 2);
check("a group is one step", usedByCount("wallH", [{ kind: "group", label: "Holes", steps: [box(30, "wallH"), box(20, "wallH")] }], null) === 1);

const bytes = new Uint8Array([1, 2, 3, 4]);
const project: LimeProject = {
  version: 1,
  mesh: meshRecord("bracket.stl", bytes),
  placement: { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.05 },
  settings: { ...DEFAULT_PRESET },
  preset: "bench",
  profile: { ...defaultProfile(), name: "Shop" },
  level: "simple",
  supportEdits: [],
  parameters: { wallH: 30, half: "wallH / 2" },
};
const wire = JSON.parse(serializeProject(project)) as { parameters?: Record<string, unknown> };
check("parameters are a top-level field", wire.parameters?.wallH === 30 && wire.parameters?.half === "wallH / 2");
const opened = parseProject(serializeProject(project));
check("save and reopen keeps the parameter and the expression", opened.ok && opened.project.parameters?.wallH === 30 && opened.project.parameters?.half === "wallH / 2");
const older = JSON.parse(serializeProject(project)) as Record<string, unknown>;
delete older.parameters;
const olderOpened = parseProject(JSON.stringify(older));
check("a file with no parameters opens unchanged", olderOpened.ok && olderOpened.project.parameters == null);
const damaged = { ...older, parameters: ["wallH"] };
check("a damaged parameters field does not refuse the file", parseProject(JSON.stringify(damaged)).ok);

const fp = { volumeMm3: 3000, faces: 6, edges: 12 };
const tree = withChild(newTree("box#1", { kind: "primitive", solid: { primitive: "box", origin: [0, 0, 0], size: [10, 10, 30], radius: 0, height: 30, turn: [0, 0, 0] }, exprs: { modelDz: "wallH" } }, "Box", fp), 0, {
  id: 1,
  op: box(30, "wallH"),
  label: "Box",
  fingerprint: fp,
});
const saved = savedTree(tree, 1, () => undefined);
const read = readSavedTree({ ...saved, rootPrimitive: tree.root.kind === "primitive" ? tree.root.solid : undefined, rootExprs: tree.root.kind === "primitive" ? tree.root.exprs : undefined });
check("a saved op keeps its expression", read?.nodes[1]?.op?.exprs?.modelDz === "wallH");
check("a new solid keeps its expression", read?.rootExprs?.modelDz === "wallH");
const bare = readSavedTree({ ...saved, rootPrimitive: tree.root.kind === "primitive" ? tree.root.solid : undefined });
check("a tree with no rootExprs still opens", bare != null && bare.rootExprs == null);
check("a sketch that names nothing hides Parameters", parametersHiddenWhileSketching(true, false, ["wallH"], "10"));
check("a sketch that names a parameter shows Parameters", !parametersHiddenWhileSketching(true, false, ["wallH"], "wallH / 2"));
check("an empty table hides Parameters while sketching", parametersHiddenWhileSketching(true, false, [], ""));
check("closing the sketch shows Parameters", !parametersHiddenWhileSketching(false, false, ["wallH"], ""));
check("Ctrl+Alt+P shows Parameters while sketching", !parametersHiddenWhileSketching(true, true, ["wallH"], ""));

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear() { data.clear(); },
    getItem(key: string) { return data.has(key) ? data.get(key)! : null; },
    key(index: number) { return [...data.keys()][index] ?? null; },
    removeItem(key: string) { data.delete(key); },
    setItem(key: string, value: string) { data.set(key, value); },
  };
}

const folds = memoryStorage();
check("an unsaved project shares one key", parametersFoldId("") === "unsaved" && parametersFoldId("  ") === "unsaved");
check("a saved path is its own key", parametersFoldId("/jobs/plate.lime") === "/jobs/plate.lime");
writeParametersFold(folds, "/jobs/plate.lime", false);
check("the open state survives adding a part", readParametersFold(folds, "/jobs/plate.lime") === false && parametersFoldId("/jobs/plate.lime") === parametersFoldId("/jobs/plate.lime"));
writeParametersFold(folds, "/jobs/other.lime", true);
check("two saved paths remember different folds", readParametersFold(folds, "/jobs/plate.lime") === false && readParametersFold(folds, "/jobs/other.lime") === true);
for (let i = 0; i < 60; i += 1) writeParametersFold(folds, `/jobs/p${i}.lime`, i % 2 === 0);
check("sixty projects keep at most 50 fold keys", parametersFoldCount(folds) <= 50);
check("the oldest fold is dropped", readParametersFold(folds, "/jobs/p0.lime") === null);
check("a recent fold is kept", readParametersFold(folds, "/jobs/p59.lime") === false);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("params: ok");
