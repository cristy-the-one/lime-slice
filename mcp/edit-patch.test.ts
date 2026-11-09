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

if (failed > 0) {
  console.error(`edit-patch: ${failed} failed`);
  process.exit(1);
}
console.log("edit-patch: ok");
