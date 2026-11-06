/**
 * Refusal codes. The registry in mcp/refusals.ts is unique, every code is documented in docs/mcp-server.md and used, every
 * `ok: false` in mcp/ goes through refuse() (or carries a code, or is on a reviewed list), and a refusal from a real call
 * carries its code and, where one call is the obvious way on, `next`. Stand-in engine: nothing here needs the kernel.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fakeEngine } from "./engine.ts";
import { REFUSAL_CODES, NEXT, refuse, withCode } from "./refusals.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-refusals-"));

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

const root = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "fixtures" && entry.name !== "node_modules") sources(path, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

// --- The registry.
const registrySource = readFileSync(join(root, "mcp", "refusals.ts"), "utf8");
const block = registrySource.slice(registrySource.indexOf("export const REFUSAL_CODES"), registrySource.indexOf("} as const;"));
const declared = [...block.matchAll(/^ {2}"([^"]+)": /gm)].map((m) => m[1]!);
const codes = Object.keys(REFUSAL_CODES);
check("the registry has codes", codes.length > 50, codes.length);
check("registry codes are unique (no key written twice)", declared.length === codes.length && new Set(declared).size === declared.length, `${declared.length} written, ${codes.length} keys`);
check("registry codes are short kebab-case", codes.every((code) => /^[a-z]+(-[a-z]+)*$/.test(code) && code.length <= 24), codes.filter((code) => !/^[a-z]+(-[a-z]+)*$/.test(code) || code.length > 24));
check("every code has a one-line description", codes.every((code) => { const text = (REFUSAL_CODES as Record<string, string>)[code]!; return text.length > 10 && !text.includes("\n"); }));

// --- Documented, one line each.
const docs = readFileSync(join(root, "docs", "mcp-server.md"), "utf8");
const section = docs.slice(docs.indexOf("### Refusal codes"));
const body = section.slice(0, section.indexOf("\n### ", 5) < 0 ? undefined : section.indexOf("\n### ", 5));
const documented = [...body.matchAll(/^- `([a-z-]+)`: (.+)$/gm)].map((m) => m[1]!);
check("docs/mcp-server.md documents every code", codes.every((code) => documented.includes(code)), codes.filter((code) => !documented.includes(code)));
check("docs/mcp-server.md documents no code the registry lacks", documented.every((code) => codes.includes(code)), documented.filter((code) => !codes.includes(code)));
check("each code is documented once", new Set(documented).size === documented.length);

// --- Used, and only registered codes are written.
const files = sources(join(root, "mcp"));
const text = files.map((file) => ({ file: file.slice(root.length).replace(/\\/g, "/"), text: readFileSync(file, "utf8") }));
const all = text.filter((row) => row.file !== "mcp/refusals.ts").map((row) => row.text).join("\n");
const unused = codes.filter((code) => code !== "refused" && !all.includes(`"${code}"`));
check("every code is used by some refusal", unused.length === 0, unused);
const written = new Set<string>();
for (const row of text) {
  if (row.file === "mcp/refusals.ts") continue;
  for (const m of row.text.matchAll(/\brefuse\("([a-z]+(?:-[a-z]+)*)"/g)) written.add(m[1]!);
  for (const m of row.text.matchAll(/ok: false, code: "([^"]+)"/g)) written.add(m[1]!);
  for (const m of row.text.matchAll(/\{ code: "([^"]+)" \}/g)) written.add(m[1]!);
}
check("every code written in mcp/ is in the registry", [...written].every((code) => codes.includes(code)), [...written].filter((code) => !codes.includes(code)));

// --- Every `ok: false` goes through the helper, carries its code, or is on the reviewed list.
const allowed: { file: RegExp; line: RegExp; why: string }[] = [
  { file: /^mcp\/engine(-worker)?\.ts$/, line: /ok: false/, why: "the engine's own wire protocol and stand-in replies: the session turns them into refusals" },
  { file: /^mcp\/recipe\.ts$/, line: /ok: false/, why: "BuildResult and available(): the session words them as recipe-unavailable and recipe-compile" },
  { file: /^mcp\/session\/recipe\.ts$/, line: /ok: false, error:/, why: "the answers a recipe's own calls get (lust reads error); a refusal of the whole run goes through refuse" },
  { file: /.*/, line: /ok: false;/, why: "a type, not a value" },
  { file: /.*/, line: /\(\) => \(\{ ok: false \}\)/, why: "a swallowed failure whose value is only tested for ok" },
  { file: /^mcp\/session\/recipe\.ts$/, line: /\.catch\(\(err: unknown\) => \(\{ ok: false, reason:/, why: "commitOne's value is read for its reason by the recipe's own refusal" },
  { file: /^mcp\/session\/slice\.ts$/, line: /\.catch\(\(err: unknown\) => \(\{ ok: false, reason:/, why: "lostJob tests the restored project's ok and words the refusal itself" },
  { file: /^mcp\/session\/work\.ts$/, line: /ok: false, code: "plan-step-failed"/, why: "a plan step's row carries its code" },
  { file: /^mcp\/refusals\.ts$/, line: /ok: false/, why: "the helper itself" },
];
const stray: string[] = [];
for (const row of text) {
  const lines = row.text.split("\n");
  lines.forEach((line, index) => {
    if (!line.includes("ok: false")) return;
    if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
    if (/refuse\(/.test(line)) return;
    if (/ok: false,\s*code: "/.test(line)) return;
    if (/ok: false,\s*$/.test(line) && /^\s*code: "/.test(lines[index + 1] ?? "")) return;
    if (allowed.some((rule) => rule.file.test(row.file) && rule.line.test(line))) return;
    stray.push(`${row.file}:${index + 1} ${line.trim().slice(0, 100)}`);
  });
}
check("every ok:false in mcp/ goes through refuse(), carries a code, or is on the reviewed list", stray.length === 0, stray);

// --- The helper.
{
  const bare = refuse("no-object", "That object is not on the plate.");
  check("refuse: ok false, code, reason, and no next when none is given", bare.ok === false && bare.code === "no-object" && bare.reason === "That object is not on the plate." && !("next" in bare), bare);
  const full = refuse("not-sliced", "Slice first.", { job: "j1", code: "x", reason: "y", ok: true }, NEXT.slice);
  check("refuse: extra fields ride along, the four named fields cannot be overridden, next is set", full.job === "j1" && full.code === "not-sliced" && full.reason === "Slice first." && full.ok === false && full.next === NEXT.slice, full);
  check("withCode adds refused to a refusal with no code and leaves the rest alone", JSON.stringify(withCode({ ok: false, reason: "r", job: "j" })) === JSON.stringify({ ok: false, reason: "r", job: "j", code: "refused" }));
  check("withCode keeps a code and leaves ok replies alone", withCode({ ok: false, code: "busy2" }).code === "busy2" && !("code" in withCode({ ok: true })));
}

// --- Replies from real calls (stand-in engine).
const session = new Session(fakeEngine());
const call = (name: string, args: unknown = {}) => session.call(name, args);

{
  const r = await call("object_select", { object: "nope", name: "x" });
  check("an unknown handle: code no-object, reason unchanged, next plate_list", r.ok === false && r.code === "no-object" && String(r.reason).startsWith("That object is not on the plate.") && String(r.next).includes("plate_list"), r);
  const empty = await call("slice_start", {});
  check("slice_start on an empty plate: code no-mesh with a next", empty.ok === false && empty.code === "no-mesh" && typeof empty.next === "string", empty);
  const none = await call("gcode_summary", {});
  check("gcode_summary before a slice: code not-sliced, next slice_start", none.ok === false && none.code === "not-sliced" && String(none.next).includes("slice_start"), none);
  const undo = await call("plate_undo", {});
  check("plate_undo with nothing to undo: code nothing-to-undo, reason unchanged", undo.ok === false && undo.code === "nothing-to-undo" && undo.reason === "Nothing to undo.", undo);
  const guide = await call("guide", { topic: "nope" });
  check("guide of an unknown topic: code unknown-topic", guide.ok === false && guide.code === "unknown-topic", guide);
  const lost = await call("slice_wait", { job: "j99" });
  check("slice_wait of a job this session never had: code slice-lost", lost.ok === false && lost.code === "slice-lost", lost);
  const solid = String((await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 })).object);
  const wrong = await call("model_apply", { object: solid, op: { kind: "hole", diameterMm: 2, through: true, origin: [5, 5, 10], axis: [0, 0, -1] } });
  check("a Model edit never probed: code not-probed, next model_probe", wrong.ok === false && wrong.code === "not-probed" && String(wrong.next).includes("model_probe"), wrong);
  const area = await call("model_probe", { object: solid, op: { kind: "hole", diameterMm: 80, through: true, origin: [5, 5, 10], axis: [0, 0, -1] } });
  check("every refusal this stand-in gives carries a code", area.ok !== false || typeof area.code === "string", area);
  const plan = await call("plan_run", { steps: [{ tool: "object_select", args: { object: "nope", name: "x" } }] });
  check("a plan names the failed step and carries plan-step-failed", plan.ok === false && plan.code === "plan-step-failed" && plan.failedStep === 1, plan);
}

if (failed > 0) {
  console.error(`${failed} refusal check(s) failed`);
  process.exit(1);
}
