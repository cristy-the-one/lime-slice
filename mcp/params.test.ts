/**
 * --- A6. The MCP session reads and writes top-level parameters, and still opens an older file's mcpModel.params.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fakeEngine } from "./engine.ts";
import { stepOutOfDate } from "../src/modeling/params.ts";
import type { ModelOp } from "../src/model-tree.ts";
import { Session, typedExprs as typedExprsOf } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-params-"));
process.env.LIME_MCP_WORKSPACE = workspace;

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);
const numbers = (result: Record<string, unknown>): Record<string, number> | undefined => {
  const params = result.params;
  return params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, number>) : undefined;
};

const step = new URL("../samples/step_cube.step", import.meta.url);
const imported = await call("mesh_import", { path: fileURLToPath(step) });
check("the part opens", imported.ok === true, JSON.stringify(imported));

const set = await call("model_params", { set: { wallW: 60, half: "wallW / 2" } });
check("model_params returns the evaluated numbers", set.ok === true && numbers(set)?.half === 30 && numbers(set)?.wallW === 60, JSON.stringify(set));

const saved = await call("project_save", { name: "params.lime" });
check("the project saves", saved.ok === true && typeof saved.path === "string", JSON.stringify(saved));
const wire = JSON.parse(readFileSync(String(saved.path), "utf8")) as { parameters?: Record<string, unknown>; mcpModel?: { params?: unknown } };
check("parameters are top level", wire.parameters?.wallW === 60 && wire.parameters?.half === "wallW / 2");
check("mcpModel no longer stores params", wire.mcpModel?.params == null);

const again = new Session(engine);
const reopened = await again.call("project_open", { path: String(saved.path) });
check("the project reopens", reopened.ok === true, JSON.stringify(reopened));
const changed = await again.call("model_params", { set: { wallW: 40 } });
check("a later name follows the new value", changed.ok === true && numbers(changed)?.half === 20 && numbers(changed)?.wallW === 40, JSON.stringify(changed));

const legacyPath = join(workspace, "legacy.lime");
const legacy = JSON.parse(readFileSync(String(saved.path), "utf8")) as { parameters?: unknown; mcpModel?: Record<string, unknown> };
legacy.mcpModel = { ...(legacy.mcpModel ?? {}), params: { wallH: 30 } };
delete legacy.parameters;
writeFileSync(legacyPath, JSON.stringify(legacy));
const old = new Session(engine);
const opened = await old.call("project_open", { path: legacyPath });
const listed = await old.call("model_params", {});
check("an older file's mcpModel.params still opens", opened.ok === true && listed.ok === true && numbers(listed)?.wallH === 30, JSON.stringify(listed));

// --- D22. One bad row, as the app's panel keeps it, does not refuse the rest of the table.
const badPath = join(workspace, "bad-row.lime");
const bad = JSON.parse(readFileSync(String(saved.path), "utf8")) as { parameters?: Record<string, unknown> };
bad.parameters = { wallW: 60, oops: "nope * 2", half: "wallW / 2" };
writeFileSync(badPath, JSON.stringify(bad));
const badSession = new Session(engine);
await badSession.call("project_open", { path: badPath });
const kept = await badSession.call("model_params", {});
check("a file with one bad row keeps the good ones", kept.ok === true && numbers(kept)?.wallW === 60 && numbers(kept)?.half === 30 && numbers(kept)?.oops === undefined, JSON.stringify(kept));
check("the bad row is named", JSON.stringify(kept.errors) === JSON.stringify({ oops: '"nope" is not a parameter. Set it with model_params first.' }), JSON.stringify(kept));
const other = await badSession.call("model_params", { set: { depth: "half + 1" } });
check("a row set beside a bad one still sets", other.ok === true && numbers(other)?.depth === 31, JSON.stringify(other));
const refused = await badSession.call("model_params", { set: { more: "nope + 1" } });
check("a bad row this call sets is refused", refused.ok === false && refused.reason === 'more: "nope" is not a parameter. Set it with model_params first.', JSON.stringify(refused));
const after = await badSession.call("model_params", {});
check("a refused set changes nothing", numbers(after)?.more === undefined && numbers(after)?.depth === 31, JSON.stringify(after));

// --- D23. A new project starts with an empty table and no defined parts.
const peg = await badSession.call("model_define", { name: "peg", params: { r: 2 }, ops: [{ kind: "boolean", op: "fuse", primitive: "cylinder", radius: "r", height: 3, centre: [0, 0, 0], label: "peg" }] });
check("a part is defined", peg.ok === true, JSON.stringify(peg));
const created = await badSession.call("project_create", {});
const fresh = await badSession.call("model_params", {});
check("project_create clears the parameters", created.ok === true && JSON.stringify(fresh.params) === "{}" && fresh.errors === undefined, JSON.stringify(fresh));
const parts = await badSession.call("model_define", {});
check("project_create clears the defined parts", JSON.stringify(parts.parts) === "[]", JSON.stringify(parts));

// --- D25. An op typed with expressions keeps them, as an app step does, so the app's Rebuild follows the table.
{
  const own = new Session(engine);
  await own.call("model_params", { set: { w: 12 } });
  const made = await own.call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 30 });
  const first = await own.call("model_apply", { object: made.object, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 25], dx: "w", dy: 10, dz: "w / 2" } });
  const second = await own.call("model_apply", { object: made.object, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", origin: [-20, -10, 25], dx: "w", dy: 6, dz: 10 } });
  check("both expression ops apply", first.ok === true && second.ok === true, JSON.stringify([first, second]));
  const wider = { kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 25], dx: "w + 1", dy: 10, dz: 6 };
  await own.call("model_probe", { object: made.object, op: wider });
  const edited = await own.call("model_edit", { object: made.object, node: first.node, op: wider });
  check("the first op is edited", edited.ok === true, JSON.stringify(edited));
  const file = await own.call("project_save", { name: "exprs.lime" });
  const doc = JSON.parse(readFileSync(String(file.path), "utf8")) as { objects?: { modelTree?: { nodes?: { op?: ModelOp | null }[] } }[] };
  const ops = (doc.objects?.at(-1)?.modelTree?.nodes ?? []).map((node) => node.op).filter((op): op is ModelOp => op?.kind === "boolean");
  const exprs = ops.map((op) => op.exprs ?? null);
  check("the edited step keeps the expression this edit typed, and the replayed step its own", JSON.stringify(exprs.slice(-2)) === JSON.stringify([{ modelDx: "w + 1" }, { modelDx: "w" }]), JSON.stringify(exprs));
  check("a stored step is out of date when its parameter changes", ops.length >= 2 && !stepOutOfDate(ops.at(-1)!, { w: 12 }) && stepOutOfDate(ops.at(-1)!, { w: 14 }));

  const derived = typedExprsOf({ kind: "boolean", op: "cut", primitive: "cylinder", dx: "d", height: 4 });
  check("a cylinder typed by dx keeps its radius expression", JSON.stringify(derived) === JSON.stringify({ modelDx: "d", modelDy: "d", modelRadius: "(d) / 2" }), JSON.stringify(derived));
  check("a primitive placed by its centre keeps no size expression", typedExprsOf({ kind: "boolean", op: "cut", primitive: "box", dx: "d", centre: [0, 0, 0] }) === undefined);

  // A root the app saved with expressions keeps them through the MCP.
  const rooted = JSON.parse(readFileSync(String(file.path), "utf8")) as { objects?: { modelTree?: Record<string, unknown> }[] };
  const tree = rooted.objects!.at(-1)!.modelTree!;
  tree.rootExprs = { modelDx: "w * 5" };
  const rootedPath = join(workspace, "root-exprs.lime");
  writeFileSync(rootedPath, JSON.stringify(rooted));
  const again = new Session(engine);
  await again.call("project_open", { path: rootedPath });
  const resaved = await again.call("project_save", { name: "root-exprs-2.lime" });
  const back = JSON.parse(readFileSync(String(resaved.path), "utf8")) as { objects?: { modelTree?: { rootExprs?: unknown } }[] };
  check("the root's expressions survive an MCP open and save", JSON.stringify(back.objects?.at(-1)?.modelTree?.rootExprs) === JSON.stringify({ modelDx: "w * 5" }), JSON.stringify(back.objects?.at(-1)?.modelTree?.rootExprs));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("mcp params: ok");
