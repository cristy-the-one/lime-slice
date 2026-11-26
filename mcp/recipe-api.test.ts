/**
 * E6 (docs/plan-agent-ergonomics.md): guide {topic:"recipes", section:"api"} lists every public item of the
 * lime_recipe crate, generated from its source. guide {kind} shows the technique lessons under seenInPractice.
 * The scan here is independent of the generator: a pub item it finds that the section omits fails this file.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fakeEngine } from "./engine.ts";
import { LESSON_MAX, SHIPPED_LESSONS } from "./nuggets.ts";
import { DISCOVERY_INSTRUCTIONS } from "./protocol.ts";
import { annotationsFor, listedTools } from "./schema.ts";
import { Session } from "./session.ts";

process.env.LIME_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "lime-recipe-api-"));

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.error(`FAIL ${name}${text ? ` ${text.slice(0, 500)}` : ""}`);
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");
const codeOnly = (source: string) => source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|b?r(#*)"[\s\S]*?"\1|b?"(?:\\[\s\S]|[^"\\])*"|b?'(?:\\.|[^\\'\n])'/g, blank);

/** Spans of `mod name { ... }` that are not `pub`, including nested test modules. */
function privateModSpans(code: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = /(?:^|\n)[ \t]*mod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/g;
  for (const m of code.matchAll(re)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let end = code.length;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    spans.push([m.index ?? 0, end]);
  }
  return spans;
}

/** Every `pub fn/struct/enum/trait/type/const/static` name outside a private module. `pub(crate)` is not public. */
function publicItemNames(source: string): string[] {
  const code = codeOnly(source);
  const hidden = privateModSpans(code);
  const names: string[] = [];
  const re = /(?:^|[^\w])pub\s+(?:fn|struct|enum|trait|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const m of code.matchAll(re)) {
    const at = m.index ?? 0;
    if (hidden.some(([a, b]) => at >= a && at < b)) continue;
    names.push(m[1]!);
  }
  return names;
}

const source = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "crates/lime-recipe/src/lib.rs"), "utf8");
const names = publicItemNames(source);
check("the crate has public items to list", names.length > 50, String(names.length));

const session = new Session(fakeEngine());
const api = await session.call("guide", { topic: "recipes", section: "api" }) as { ok?: boolean; text?: string; section?: string };
check("guide {topic:recipes, section:api} answers", api.ok === true && api.section === "api" && typeof api.text === "string", api);
const text = api.text ?? "";
const missing = names.filter((name) => !new RegExp(`\\b(?:fn|struct|enum|trait|type|const|static)\\s+(?:[A-Za-z_][A-Za-z0-9_]*::)?${name}\\b`).test(text));
check(`the api section lists every pub item (${names.length - missing.length}/${names.length})`, missing.length === 0, missing.slice(0, 12).join(", "));
const listed = text.split("\n").filter((line) => /^(?:fn|struct|enum|trait|type|const|static) /.test(line)).length;
check(`the section's item lines cover the pub items (${listed}/${names.length})`, listed >= names.length, `${listed} lines, ${names.length} pub items`);

const TECHNIQUE_IDS = ["T11", "T12", "T15", "T17", "T18", "T21", "T22", "T23", "T24", "T26", "T27", "T29", "L5", "L8", "L9", "B1", "B4", "B6", "B10", "B11", "B14", "B15", "B18", "B21", "B23"];
const technique = TECHNIQUE_IDS.map((id) => SHIPPED_LESSONS.find((lesson) => lesson.text.startsWith(`${id} `)));
const missingIds = TECHNIQUE_IDS.filter((_, i) => !technique[i]);
check(`every technique lesson is shipped (${TECHNIQUE_IDS.length - missingIds.length}/${TECHNIQUE_IDS.length})`, missingIds.length === 0, missingIds.join(", "));
const tooLong = technique.filter((lesson) => lesson && (lesson.text.length > LESSON_MAX || /\bpocket\b/i.test(`${lesson.text} ${lesson.words}`)));
check("each technique lesson is at most 200 characters and does not say pocket", tooLong.length === 0, tooLong.map((lesson) => `${lesson?.text.slice(0, 12)} ${lesson?.text.length}`));
const byKind = new Map<string, string[]>();
for (const lesson of technique) {
  if (!lesson) continue;
  const rows = byKind.get(lesson.about) ?? [];
  rows.push(lesson.text);
  byKind.set(lesson.about, rows);
}
for (const [kind, rows] of byKind) {
  const answer = await session.call("guide", { kind }) as { ok?: boolean; data?: { seenInPractice?: string[] } };
  const seen = answer.data?.seenInPractice ?? [];
  const absent = rows.filter((line) => !seen.includes(line));
  check(`guide {kind:${kind}} shows its technique lessons under seenInPractice`, answer.ok === true && absent.length === 0 && seen.length <= 5, absent.length ? absent : seen);
}

const tokens = (value: string) => Math.ceil(Buffer.byteLength(value) / 4);
const firstList = JSON.stringify({ tools: listedTools(new Set()).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: annotationsFor(tool.name) })) });
const firstContact = tokens(DISCOVERY_INSTRUCTIONS) + tokens(firstList);
console.log(`first contact ~${firstContact} tokens`);
check("first contact stays within 1500 tokens", firstContact <= 1500, String(firstContact));
check("the api section is not in the instructions or the tool list", !DISCOVERY_INSTRUCTIONS.includes("lime_recipe::geom2d") && !firstList.includes("fn Json::obj"));

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("recipe api: all checks passed");
