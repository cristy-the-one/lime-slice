/** model_edit {node: label, patch}: change one field of one model_build step and rebuild from it. Stand-in engine. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { validateTool } from "./schema.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-patch-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);
const applies = () => engine.calls.filter((c) => c === "apply").length;
const base = { primitive: "box", dx: 20, dy: 20, dz: 20 };
const cut = (x: number, label: string) => ({ kind: "boolean", op: "cut", primitive: "box", centre: [x, 0, 19.5], dx: 1, dy: 1, dz: 2, label });
const ops = [cut(-5, "left"), cut(5, "right"), cut(0, "mid"), { ...cut(2, "mid"), dx: 2 }];

check("patch passes the schema without op", validateTool("model_edit", { node: "left", patch: { dx: 2 } }) === null);
check("op or patch is needed", (validateTool("model_edit", { node: "left" }) ?? "").includes("patch"));
check("both is refused", (validateTool("model_edit", { node: "left", op: { kind: "hole" }, patch: { dx: 2 } }) ?? "").includes("not both"));

const built = await call("model_build", { name: "slots", base, ops });
check("the build ran", built.ok === true && typeof built.object === "string", JSON.stringify(built));
const object = built.object as string;

const ambiguous = await call("model_edit", { object, node: "mid", patch: { dx: 3 } });
check("an ambiguous label is refused with the step numbers", ambiguous.ok === false && String(ambiguous.reason).includes("steps 3, 4"), JSON.stringify(ambiguous));
const missing = await call("model_edit", { object, node: "nope", patch: { dx: 3 } });
check("an unknown label lists the labels", missing.ok === false && missing.code === "step-not-found" && String(missing.reason).includes("left"), JSON.stringify(missing));
const stray = await call("model_edit", { object, node: "left", patch: { size: 3 } });
check("a field the kind does not take is refused by name", stray.ok === false && String(stray.reason).includes("size") && String(stray.reason).includes("Nothing changed"), JSON.stringify(stray));
const kind = await call("model_edit", { object, node: "left", patch: { kind: "hole" } });
check("a patch cannot change the kind", kind.ok === false && String(kind.reason).includes("kind"), JSON.stringify(kind));
const handle = await call("model_edit", { object, node: "node_2", patch: { dx: 3 } });
check("a node handle is told to use the label", handle.ok === false && String(handle.reason).includes("label"), JSON.stringify(handle));

const before = applies();
const edited = await call("model_edit", { object, node: "right", patch: { dx: 3 } });
check("one field of one step rebuilds in place", edited.ok === true && edited.object === object, JSON.stringify(edited));
check("the steps before it are reused", (edited.resumed as { reusedOps?: number } | undefined)?.reusedOps === 1 && applies() - before === 3, JSON.stringify({ edited, ran: applies() - before }));
const again = await call("model_edit", { object, node: "RIGHT", patch: { "dx": 4, centre: [6, 0, 19.5] } });
check("the label matches without case, and a patch keeps what the last one set", again.ok === true && again.object === object, JSON.stringify(again));
const plates = ((await call("plate_list", {})).objects as unknown[]).length;
check("the plate still holds one object", plates === 1, String(plates));

const plain = await call("solid_new", { primitive: "box", dx: 5, dy: 5, dz: 5 });
const notBuilt = await call("model_edit", { object: plain.object, node: "x", patch: { dx: 2 } });
check("an object model_build did not make is refused", notBuilt.ok === false && String(notBuilt.reason).includes("model_build"), JSON.stringify(notBuilt));

// unify: the step that makes flush faces one (the kernel proves the faces; here the op passes the schema and a build).
check("unify passes the schema", validateTool("model_apply", { op: { kind: "unify" } }) === null);
check("unify takes no other field", (validateTool("model_apply", { op: { kind: "unify", size: 1 } }) ?? "").includes("size"));
const unified = await call("model_build", { name: "merged", base, ops: [cut(0, "slot"), { kind: "unify", label: "flush" }] });
check("a build with a unify step runs", unified.ok === true, JSON.stringify(unified));

// patches: several steps changed, removed and inserted in one call and one rebuild.
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const five = [cut(-8, "a"), cut(-4, "b"), cut(0, "c"), cut(4, "d"), cut(8, "e")];
const rack = await call("model_build", { name: "rack", base, ops: five });
const rackId = rack.object as string;
check("a build of several ops names the patch form in one line", rack.ok === true && String(rack.edit).includes("patches") && String(rack.edit).includes(rackId), JSON.stringify(rack));
check("patches passes the schema without node", validateTool("model_edit", { patches: [{ node: "a", patch: { dx: 2 } }] }) === null);
check("patch and patches together are refused", (validateTool("model_edit", { node: "a", patch: { dx: 2 }, patches: [{ node: "a", remove: true }] }) ?? "").includes("one of"));
check("op without node is still refused", validateTool("model_edit", { op: { kind: "scale", factor: 2 } }) === "node is required.");
const ran0 = applies();
const patches = [{ node: "d", patch: { dx: 2 } }, { node: "c", remove: true }, { insert: cut(6, "f"), after: "d" }, { insert: cut(9, "g") }];
const many = await call("model_edit", { object: rackId, patches });
const rebuilt = { name: "rack", base, object: rackId, ops: [five[0], five[1], { ...five[3], dx: 2 }, cut(6, "f"), five[4], cut(9, "g")] };
console.log(`an iteration of a five-op build: model_edit {patches} ${bytes({ object: rackId, patches })} bytes sent, model_build again ${bytes(rebuilt)} bytes`);
check("patches change, remove and insert in one rebuild", many.ok === true && many.object === rackId && many.edit === undefined, JSON.stringify(many));
check("the ops before the first change are reused, the rest run once", (many.resumed as { reusedOps?: number } | undefined)?.reusedOps === 2 && applies() - ran0 === 4, JSON.stringify({ resumed: many.resumed, ran: applies() - ran0 }));
const same = await call("model_build", rebuilt);
check("the object's ops are what the patches made: the same build sent whole reuses all six", same.ok === true && (same.resumed as { reusedOps?: number; ranOps?: number } | undefined)?.reusedOps === 6 && (same.resumed as { ranOps?: number }).ranOps === 0, JSON.stringify(same.resumed));
const byNumber = await call("model_edit", { object: rackId, patches: [{ node: 1, patch: { dx: 3 } }, { insert: cut(-6, "h"), before: 2 }] });
check("a step is found by its number too", byNumber.ok === true && (byNumber.resumed as { reusedOps?: number } | undefined)?.reusedOps === 0, JSON.stringify(byNumber));
const ranBad = applies();
const badSecond = await call("model_edit", { object: rackId, patches: [{ node: "b", patch: { dx: 2 } }, { node: "nope", remove: true }] });
check("a bad entry names itself and nothing changes", badSecond.ok === false && badSecond.code === "step-not-found" && String(badSecond.reason).startsWith("patches[1]:") && String(badSecond.reason).includes("Nothing changed") && applies() === ranBad, JSON.stringify(badSecond));
const badInsert = await call("model_edit", { object: rackId, patches: [{ insert: { kind: "boolean", op: "cut", primitive: "box", size: 3 } }] });
check("an inserted op is checked against its kind", badInsert.ok === false && badInsert.code === "bad-op" && String(badInsert.reason).includes("size"), JSON.stringify(badInsert));
const twoForms = await call("model_edit", { object: rackId, patches: [{ node: "b", patch: { dx: 2 }, remove: true }] });
check("an entry takes one form", twoForms.ok === false && String(twoForms.reason).includes("one of"), JSON.stringify(twoForms));
for (const label of ["mid"]) {
  const twice = await call("model_edit", { object, patches: [{ node: label, patch: { dx: 3 } }] });
  check("two steps of one label: the refusal says to pass a number", twice.ok === false && String(twice.reason).includes("number"), JSON.stringify(twice));
}
const third = await call("model_edit", { object, patches: [{ node: 3, patch: { dx: 3 } }] });
check("and the number patches one of them", third.ok === true, JSON.stringify(third));

// probe: true on model_edit {op}: the check and the edit in one call.
const part = (await call("solid_new", { primitive: "box", dx: 30, dy: 30, dz: 10 })).object as string;
const holeOp = (d: number) => ({ kind: "boolean", op: "cut", primitive: "cylinder", radius: d / 2, height: 12, origin: [0, 0, -1] });
const holed = await call("model_apply", { object: part, op: holeOp(4), probe: true });
const unprobed = await call("model_edit", { object: part, node: holed.node, op: holeOp(6) });
check("an edit that was not probed says probe: true", unprobed.ok === false && unprobed.code === "not-probed" && String(unprobed.reason).includes("probe: true"), JSON.stringify(unprobed));
const editedOp = await call("model_edit", { object: part, node: holed.node, op: holeOp(6), probe: true });
check("probe: true checks and edits in one call", editedOp.ok === true && typeof editedOp.node === "string", JSON.stringify(editedOp));
const missed = await call("model_edit", { object: part, node: editedOp.node, op: { ...holeOp(6), origin: [200, 0, -1] }, probe: true });
check("a probe that fails is the refusal, and nothing is edited", missed.ok === false && missed.applied === false && missed.code !== "not-probed", JSON.stringify(missed));

if (failed > 0) {
  console.error(`edit-patch: ${failed} failed`);
  process.exit(1);
}
console.log("edit-patch: ok");
