/**
 * --- A6. The MCP session reads and writes top-level parameters, and still opens an older file's mcpModel.params.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

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

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("mcp params: ok");
