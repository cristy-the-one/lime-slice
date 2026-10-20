/**
 * The shortcomings found while two parts were rebuilt through the 3.1.0 MCP server
 * (~/.lime-slice/polish-3.0/mcp-findings-3.1.md), each checked against the stand-in engine.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-rebuild31-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_FAKE = "1";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const ids = (value: Record<string, unknown>) => ((value.objects ?? []) as { object?: string; id?: string }[]).map((row) => row.object ?? row.id);

{
  // Finding 7: a join takes its tool off the plate, and model_undo of the join puts it back; redo takes it off again.
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  const tool = String((await call("solid_new", { primitive: "cylinder", radius: 3, height: 30 })).object);
  const joined = await call("model_apply", { object: part, probe: true, op: { kind: "join", toolObject: tool, op: "cut" } });
  check("a join without keepTool takes its tool off the plate", joined.ok === true && joined.toolLeftPlate === tool && !ids(await call("plate_list")).includes(tool), JSON.stringify(joined));
  const undone = await call("model_undo", { object: part });
  const afterUndo = ids(await call("plate_list"));
  check("model_undo of the join puts the tool back on the plate", undone.ok === true && afterUndo.includes(tool) && (undone.toolsBack as string[] | undefined)?.[0] === tool, JSON.stringify({ undone, afterUndo }));
  const redone = await call("model_redo", { object: part });
  check("model_redo takes it off again", redone.ok === true && !ids(await call("plate_list")).includes(tool), JSON.stringify(redone));
  await call("model_goto", { object: part, node: "node_0" });
  check("a goto before the join brings it back too", ids(await call("plate_list")).includes(tool));
  const kept = await call("model_apply", { object: part, probe: true, op: { kind: "join", toolObject: tool, op: "fuse", keepTool: true } });
  check("keepTool leaves the tool on the plate", kept.ok === true && ids(await call("plate_list")).includes(tool), JSON.stringify(kept));

  // A saved project keeps the taken tool's history: reopened, undo still brings it back.
  await call("model_goto", { object: part, node: "node_1" });
  await call("model_commit", { object: part });
  const saved = await call("project_save", { name: "joined.lime" });
  const reopened = await call("project_open", { path: "joined.lime" });
  const handles = ids(reopened);
  const back = await call("model_undo", { object: part });
  check("a reopened project's undo of the join brings its saved tool back", saved.ok === true && !handles.includes(tool) && back.ok === true && ids(await call("plate_list")).includes(tool), JSON.stringify({ saved, handles, back }));
}

{
  // Finding 11: one object whose mesh will not close no longer blocks the save of the whole plate.
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const good = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  await call("model_commit", { object: good });
  const rings = String((await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 })).object);
  process.env.LIME_MCP_FAKE_OPEN = "1";
  const opened = await call("model_apply", { object: rings, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [0, 0, 9], dx: 2, dy: 2, dz: 2 } });
  delete process.env.LIME_MCP_FAKE_OPEN;
  const refused = await call("model_commit", { object: rings });
  check("the open object itself still refuses a commit", opened.ok === true && refused.ok === false && String(refused.reason).includes("open edge"), JSON.stringify(refused));
  const saved = await call("project_save", { name: "open-one.lime" });
  const warnings = (saved.warnings ?? []) as string[];
  check("project_save saves the plate and names the object it could not commit", saved.ok === true && warnings.length === 1 && warnings[0]!.includes(rings) && warnings[0]!.includes("open edge") && (saved.uncommitted as string[] | undefined)?.[0] === rings, JSON.stringify(saved));
  const reopened = await call("project_open", { path: "open-one.lime" });
  const history = await call("model_history", { object: rings, limit: 10 });
  check("the saved file reopens with both objects and the open object's step", reopened.ok === true && ids(reopened).length === 2 && (history.nodes as unknown[] | undefined)?.length === 2, JSON.stringify({ reopened, history }));
}

{
  // Finding 2: an autosave of a part never committed reopens on its last edit, not on its first solid.
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  for (const x of [-8, 0, 8]) await call("model_apply", { object: part, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [x, -1, 19], dx: 2, dy: 2, dz: 3 } });
  const before = await call("model_history", { object: part, limit: 10 });
  const last = ((before.nodes ?? []) as { id: string; current: boolean }[]).find((row) => row.current)?.id;
  session.flushAutosave();
  await session.autosaveSettled();
  const fresh = new Session(fakeEngine());
  const opened = await fresh.call("project_open", { path: `autosave-${process.pid}.lime` });
  const handle = ids(opened)[0] ?? "";
  const after = await fresh.call("model_history", { object: handle, limit: 10 });
  const rows = (after.nodes ?? []) as { id: string; current: boolean; committed: boolean }[];
  check("the reopened autosave is on the last applied step", last === "node_3" && rows.find((row) => row.current)?.id === "node_3" && rows.find((row) => row.committed)?.id === "node_0", JSON.stringify({ last, rows }));
  const undo = await fresh.call("model_undo", { object: handle });
  check("undo from there goes one step back", undo.node === "node_2", JSON.stringify(undo));
}

{
  // Finding 1: a composite's pieces, built and checked one by one, fold into its group without the group being built
  // again; an engine that cannot fold still gets the group built the old way.
  for (const fold of [true, false]) {
    if (!fold) process.env.LIME_MCP_FAKE_NO_FOLD = "1";
    const engine = fakeEngine();
    const session = new Session(engine);
    const call = (name: string, args: unknown = {}) => session.call(name, args);
    const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
    engine.calls.length = 0;
    const studs = await call("model_apply", { object: part, op: { kind: "pattern", linear: { step: [4, 0, 0], count: 4 }, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [-8, -1, 19], dx: 2, dy: 2, dz: 3 } } });
    const history = await call("model_history", { object: part, limit: 20 });
    const rows = (history.nodes ?? []) as { id: string; label: string; current: boolean }[];
    const groupProbes = engine.calls.filter((name) => name === "probe").length;
    if (fold) {
      check("a composite folds its applied pieces into one group", studs.ok === true && engine.folds === 1 && rows.length === 2 && rows[1]!.current && groupProbes === 4 && !engine.calls.includes("goto"), JSON.stringify({ studs, rows, calls: engine.calls }));
    } else {
      check("an engine that cannot fold still gets the group built", studs.ok === true && engine.folds === 0 && rows.length === 2 && rows[1]!.current && groupProbes === 5, JSON.stringify({ studs, rows, calls: engine.calls }));
    }
    const undone = await call("model_undo", { object: part });
    check(`the ${fold ? "folded" : "built"} group is one undo step`, undone.node === "node_0", JSON.stringify(undone));
    delete process.env.LIME_MCP_FAKE_NO_FOLD;
  }
}

{
  // Finding 9: a modeler that had to be restarted says what that means for the histories.
  process.env.LIME_MCP_HANG_MODEL = "1";
  process.env.LIME_MCP_MODEL_TIMEOUT_S = "0.3";
  const session = new Session(fakeEngine());
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const part = String((await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
  const hung = await call("model_probe", { object: part, op: { kind: "fillet", edges: [0], size: 1 } });
  check("treeLost comes with a sentence on what it means", hung.treeLost === true && String(hung.treeNote).includes("Nothing applied is lost"), JSON.stringify(hung));
  delete process.env.LIME_MCP_HANG_MODEL;
  delete process.env.LIME_MCP_MODEL_TIMEOUT_S;
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("rebuild-3-1: ok");
