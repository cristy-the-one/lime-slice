/**
 * Nuggets (docs/plan-recipe-ingredients.md I12–I17): what a run leaves for the next one, kept in the user's library
 * beside the plugins. Ingredients are files (`mcp/ingredients.ts`); this file holds presets (named parameter values
 * for a plugin, I14), lessons (one sentence about an op kind or helper, I15), lifting items out of a recipe into an
 * ingredient (I12), and the harvest scan that suggests them after a run (I13). Nothing here saves on its own (O1):
 * the session saves only on an explicit `nugget {action: "save"}`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { codeOnly } from "./ingredients.ts";
import { oneLine, pluginsDir, type PluginParam } from "./plugins.ts";
import { lfOnly } from "./recipe.ts";
import { pickProblem } from "../src/recipe/picks.ts";

export const LESSON_MAX = 200;
/** Lessons shown per op kind in guide {kind}, newest first. */
export const LESSONS_SHOWN = 5;
const LESSONS_KEPT = 500;
const PRESET_NAME = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const ABOUT = /^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,59}$/;

function writeWhole(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// --- I14. Presets: `<library>/presets/<plugin>.json`, `{ "<name>": {params, created} }`.

export interface Preset {
  plugin: string;
  name: string;
  params: Record<string, unknown>;
  created: string;
}

function presetsDir(): string {
  return join(pluginsDir(), "presets");
}

export function isPresetName(name: string): boolean {
  return PRESET_NAME.test(name);
}

/** `honeycomb-tray/pp-5mm-wall` as its plugin and name, or null. */
export function presetId(id: string): { plugin: string; name: string } | null {
  const m = /^([a-z0-9-]{1,48})\/([a-z0-9-]{1,48})$/.exec(id);
  return m && isPresetName(m[2]!) ? { plugin: m[1]!, name: m[2]! } : null;
}

export function listPresets(plugin?: string): Preset[] {
  const dir = presetsDir();
  if (!existsSync(dir)) return [];
  const files = plugin ? [`${plugin}.json`] : readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  return files.flatMap((file) => {
    const owner = file.slice(0, -5);
    const rows = readJson<Record<string, { params?: unknown; created?: unknown }>>(join(dir, file), {});
    return Object.entries(rows).filter(([, row]) => !!row && typeof row.params === "object" && row.params !== null).map(([name, row]) => ({ plugin: owner, name, params: row.params as Record<string, unknown>, created: String(row.created ?? "") }));
  });
}

export function readPreset(plugin: string, name: string): Preset | null {
  return listPresets(plugin).find((row) => row.name === name) ?? null;
}

export function writePreset(preset: Preset): void {
  const dir = presetsDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${preset.plugin}.json`);
  const rows = readJson<Record<string, unknown>>(path, {});
  rows[preset.name] = { params: preset.params, created: preset.created };
  writeWhole(path, `${JSON.stringify(rows, null, 2)}\n`);
}

export function removePreset(plugin: string, name: string): boolean {
  const path = join(presetsDir(), `${plugin}.json`);
  const rows = readJson<Record<string, unknown>>(path, {});
  if (!(name in rows)) return false;
  delete rows[name];
  if (Object.keys(rows).length === 0) unlinkSync(path);
  else writeWhole(path, `${JSON.stringify(rows, null, 2)}\n`);
  return true;
}

/** The preset's values against the plugin's declared parameters (D4), or the sentence of the first that does not fit. */
export function presetProblem(plugin: string, params: Record<string, unknown>, declared: PluginParam[]): string | null {
  for (const [name, value] of Object.entries(params)) {
    const p = declared.find((row) => row.name === name);
    if (!p) return `${plugin} has no parameter ${name}; it has: ${declared.map((row) => row.name).join(", ") || "none"}.`;
    if (p.kind === "number" || p.kind === "count") {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${name} is a number.`;
      if (p.kind === "count" && !Number.isInteger(value)) return `${name} is a whole number.`;
      if ((p.min !== undefined && value < p.min) || (p.max !== undefined && value > p.max)) return `${name} ${value} is outside ${p.min ?? ""}-${p.max ?? ""}${p.unit ? ` ${p.unit}` : ""}.`;
    } else if (p.kind === "face" || p.kind === "outline") {
      const problem = pickProblem(p.kind, value, name);
      if (problem) return problem;
    } else if (p.kind === "toggle") {
      if (typeof value !== "boolean") return `${name} is true or false.`;
    } else if (p.kind === "choice") {
      if (typeof value !== "string" || !(p.options ?? []).includes(value)) return `${name} is one of ${(p.options ?? []).join(", ")}.`;
    } else if (typeof value !== "string" || (p.maxLen !== undefined && value.length > p.maxLen)) {
      return `${name} is text${p.maxLen !== undefined ? ` of at most ${p.maxLen} characters` : ""}.`;
    }
  }
  return null;
}

// --- I15. Lessons: `<library>/lessons.json`, newest last. User library only (Q3).

export interface Lesson {
  n: number;
  about: string;
  text: string;
  created: string;
}

/**
 * Lessons that ship with the app, in every library: `nugget find` lists them beside a person's own (`shipped: true`),
 * and `get` reads them; they are not removed. Numbered 0 and down, so they never take a library lesson's number.
 * `words` are what a search for them would say, besides the sentence.
 */
export const SHIPPED_LESSONS: readonly (Lesson & { words: string })[] = [
  // --- docs/plan-native-recipes.md 7.1, the queued booleans.
  { n: 0, about: "apply", created: "2026-11-09", words: "slow speed fast many batch queue queued loop booleans", text: "Many applies on one part build fast when nothing reads the part between them. Move faces_find, measure and section out of the loop." },
];

function lessonsPath(): string {
  return join(pluginsDir(), "lessons.json");
}

export function isAbout(about: string): boolean {
  return ABOUT.test(about);
}

export function listLessons(about?: string): Lesson[] {
  const rows = readJson<unknown[]>(lessonsPath(), []);
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const r = row as Partial<Lesson> | null;
    if (!r || typeof r.n !== "number" || typeof r.about !== "string" || typeof r.text !== "string") return [];
    return [{ n: r.n, about: r.about, text: oneLine(r.text, LESSON_MAX), created: String(r.created ?? "") }];
  }).filter((row) => about === undefined || row.about === about);
}

/** Keeps a lesson; the same sentence about the same thing is kept once. */
export function addLesson(about: string, text: string, created: string): Lesson {
  const rows = listLessons();
  const same = rows.find((row) => row.about === about && row.text.toLowerCase() === text.toLowerCase());
  if (same) return same;
  const lesson = { n: rows.reduce((max, row) => Math.max(max, row.n), 0) + 1, about, text, created };
  mkdirSync(pluginsDir(), { recursive: true });
  writeWhole(lessonsPath(), `${JSON.stringify([...rows, lesson].slice(-LESSONS_KEPT), null, 2)}\n`);
  return lesson;
}

export function removeLesson(n: number): boolean {
  const rows = listLessons();
  const left = rows.filter((row) => row.n !== n);
  if (left.length === rows.length) return false;
  writeWhole(lessonsPath(), `${JSON.stringify(left, null, 2)}\n`);
  return true;
}

/** The lessons guide {kind} shows for an op kind or helper: up to five, newest first. */
export function seenInPractice(about: string): string[] {
  return listLessons(about).slice(-LESSONS_SHOWN).reverse().map((row) => row.text);
}

// --- Top-level items of a Rust source, for I12 (lifting) and I13 (harvest).

export interface Item {
  kind: "fn" | "struct" | "enum" | "const" | "static" | "type" | "trait" | "impl" | "use" | "mod" | "other";
  name: string;
  /** The item's text, its attributes and doc comments included. */
  text: string;
  start: number;
  end: number;
  lines: number;
}

const HEAD = /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern\s+"[^"]*")\s+)*(fn|struct|enum|const|static|type|trait|impl|use|mod|macro_rules!)\b\s*(?:<[^{>]*>\s*)?([A-Za-z_][A-Za-z0-9_]*)?/;

/** The items at the top level of `source`, in order. */
export function topItems(source: string): Item[] {
  const text = lfOnly(source);
  const code = codeOnly(text);
  const items: Item[] = [];
  let i = 0;
  let prevEnd = 0;
  while (i < code.length) {
    while (i < code.length && /\s/.test(code[i]!)) i += 1;
    if (i >= code.length) break;
    // Attributes belong to the item after them.
    let head = i;
    while (code.startsWith("#[", head) || code.startsWith("#![", head)) {
      let depth = 0;
      let j = head;
      for (; j < code.length; j += 1) {
        if (code[j] === "[") depth += 1;
        else if (code[j] === "]" && --depth === 0) break;
      }
      head = j + 1;
      while (head < code.length && /\s/.test(code[head]!)) head += 1;
    }
    const m = HEAD.exec(code.slice(head, head + 400));
    let kind = (m?.[1] ?? "other").replace("macro_rules!", "other") as Item["kind"];
    let name = m?.[2] ?? "";
    if (kind === "impl") {
      const target = /^(?:pub\s+)?(?:unsafe\s+)?impl\s*(?:<[^{]*?>)?\s*(?:[A-Za-z_][\w:<>, ]*?\s+for\s+)?([A-Za-z_]\w*)/.exec(code.slice(head, head + 400));
      name = target?.[1] ?? "";
    }
    const byBrace = kind === "fn" || kind === "impl" || kind === "trait" || kind === "enum" || kind === "mod" || kind === "other";
    let depth = 0;
    let end = code.length;
    for (let j = head; j < code.length; j += 1) {
      const c = code[j]!;
      if (c === "{" || c === "(" || c === "[") depth += 1;
      else if (c === "}" || c === ")" || c === "]") {
        depth -= 1;
        if (depth === 0 && c === "}" && (byBrace || kind === "struct")) {
          end = j + 1;
          break;
        }
      } else if (c === ";" && depth === 0 && (!byBrace || kind === "mod")) {
        end = j + 1;
        break;
      }
    }
    if (kind === "mod" && !name) kind = "other";
    // Doc comments (blanked in the code view) above the item are the item's too.
    let from = text.lastIndexOf("\n", i - 1) + 1;
    if (text.slice(from, i).trim() !== "") from = i;
    while (from > prevEnd) {
      const lineStart = text.lastIndexOf("\n", from - 2) + 1;
      if (lineStart < prevEnd || !/^\s*\/\/\//.test(text.slice(lineStart, from - 1))) break;
      from = lineStart;
    }
    const slice = text.slice(from, end);
    items.push({ kind, name, text: slice, start: from, end, lines: slice.split("\n").length });
    i = prevEnd = end;
  }
  return items;
}

const NAMED = new Set<Item["kind"]>(["fn", "struct", "enum", "const", "static", "type", "trait"]);

/** `fn cells`, `struct Cell`: the public items of an ingredient body, at most `max`. */
export function publicItems(body: string, max = 24): string[] {
  return topItems(body).filter((item) => NAMED.has(item.kind) && /^(?:\s*(?:#\[[^\]]*\]|\/\/\/[^\n]*)\s*)*pub\b/.test(item.text.replace(/^\s+/, ""))).slice(0, max).map((item) => `${item.kind} ${item.name}`);
}

function identifiers(text: string): Set<string> {
  return new Set(codeOnly(text).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

/** The item's text made public: the item itself, a struct's named fields, an inherent impl's methods. */
function madePublic(item: Item): string {
  const lines = item.text.split("\n");
  const at = lines.findIndex((line) => !/^\s*(#\[|\/\/\/|$)/.test(line));
  if (at < 0) return item.text;
  if (NAMED.has(item.kind) && !/^\s*pub\b/.test(lines[at]!)) lines[at] = lines[at]!.replace(/^(\s*)/, "$1pub ");
  if (item.kind === "struct") {
    for (let k = at + 1; k < lines.length; k += 1) lines[k] = lines[k]!.replace(/^(\s+)(?!pub\b)([a-z_][a-z0-9_]*\s*:)/, "$1pub $2");
  }
  if (item.kind === "impl" && !/\bfor\b/.test(codeOnly(lines[at]!))) {
    for (let k = at + 1; k < lines.length; k += 1) lines[k] = lines[k]!.replace(/^(\s+)(?!pub\b)((?:const\s+|unsafe\s+)?fn\s)/, "$1pub $2");
  }
  return lines.join("\n");
}

/**
 * --- I12. The named items of a recipe and what they use, as an ingredient body: the recipe's `use` lines (an
 * `ingredients::` one becomes `crate::ingredients::`), then the items in source order, made public. `main` never goes.
 */
export function liftItems(source: string, wanted: string[]): { body: string; items: string[] } | { reason: string } {
  const items = topItems(source).filter((item) => !(item.kind === "fn" && item.name === "main"));
  const named = items.filter((item) => NAMED.has(item.kind));
  const pick = new Set<Item>();
  for (const raw of wanted) {
    const m = /^(?:(fn|struct|enum|const|static|type|trait)\s+)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw.trim());
    const found = m ? named.find((item) => item.name === m[2] && (!m[1] || item.kind === m[1])) : undefined;
    if (!found) return { reason: `There is no item ${raw.trim()} at the top of that recipe; it has: ${named.map((item) => `${item.kind} ${item.name}`).join(", ") || "only main"}.` };
    pick.add(found);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const item of [...pick]) {
      const ids = identifiers(item.text);
      for (const other of named) if (!pick.has(other) && ids.has(other.name)) {
        pick.add(other);
        grew = true;
      }
    }
    for (const impl of items.filter((item) => item.kind === "impl" && !pick.has(item))) {
      if ([...pick].some((item) => item.name === impl.name && item.kind !== "impl")) {
        pick.add(impl);
        grew = true;
      }
    }
  }
  const uses = items.filter((item) => item.kind === "use").map((item) => item.text.trim().replace(/(^|[^:\w])ingredients::/g, "$1crate::ingredients::"));
  const body = [...uses, ...(uses.length ? [""] : []), ...items.filter((item) => pick.has(item)).map((item) => madePublic(item).trim()).flatMap((text, k) => (k ? ["", text] : [text]))].join("\n");
  return { body: `${body}\n`, items: items.filter((item) => pick.has(item) && NAMED.has(item.kind)).map((item) => `${item.kind} ${item.name}`) };
}

// --- I13. Harvest: what a run that reached done could leave behind. Suggestions only.

/** Free functions over 10 lines that make no Session call: offered as an ingredient. */
export function harvestFunctions(source: string): { name: string; lines: number }[] {
  return topItems(source).filter((item) => item.kind === "fn" && item.name !== "main" && item.lines > 10 && !identifiers(item.text).has("Session")).map((item) => ({ name: item.name, lines: item.lines }));
}
