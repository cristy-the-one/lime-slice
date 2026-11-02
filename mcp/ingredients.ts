/**
 * Ingredients (docs/plan-recipe-ingredients.md I9–I11): a named, versioned Rust module recipes import. An ingredient is
 * one `.rs` file in the library's `ingredients` folder, with the plugin's `//!` front matter (`ingredient: <id>`, no
 * target or params) and a body of public functions, types and constants, with no `main`.
 *
 * A recipe imports one as `use ingredients::honeycomb::*;` (the latest version) or `use ingredients::honeycomb::v2::*;`
 * (that version). Before the build, the host appends the bodies it names as inline modules under `mod ingredients`, so
 * lust and rustc build the same text: a plain Rust module tree, no language feature. The recipe's own lines keep
 * their numbers. A source that already has `mod ingredients { ... }` carries its own (a kept plugin, I11) and is built
 * as it stands.
 */
import { join } from "node:path";

import { bodyHash, isSlug, listLibrary, olderVersions, pluginsDir, readPlugin, type PluginFile } from "./plugins.ts";
import { lfOnly } from "./recipe.ts";

/** The library's ingredients folder: `ingredients` beside the plugins. */
export function ingredientsDir(): string {
  return join(pluginsDir(), "ingredients");
}

/** An ingredient's body as a run used it, kept with the run so a rerun or a plugin builds the same later. */
export interface KeptIngredient {
  id: string;
  version: number;
  sha256: string;
  body: string;
}

/** One `ingredients::<module>` a source names: the latest version, or the version after `::v<N>`. */
export interface IngredientRef {
  module: string;
  version?: number;
}

const KEYWORDS = new Set([
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
  "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "static", "struct", "super", "trait", "true", "type",
  "unsafe", "use", "where", "while", "abstract", "become", "box", "do", "final", "gen", "macro", "override", "priv", "try", "typeof",
  "unsized", "virtual", "yield",
]);

/** An ingredient id is a library slug that is also a Rust module name once its dashes are underscores. */
export function isIngredientId(id: string): boolean {
  return isSlug(id) && /^[a-z]/.test(id) && !/^v\d+$/.test(id) && !KEYWORDS.has(moduleOf(id));
}

/** The module a recipe names an ingredient by: `moulded-tray` is `moulded_tray`. */
export function moduleOf(id: string): string {
  return id.replace(/-/g, "_");
}

/** The id a module name stands for: `moulded_tray` is `moulded-tray`. */
export function idOf(module: string): string {
  return module.replace(/_/g, "-");
}

/** The key a kept copy is stored under: `honeycomb` for the latest, `honeycomb@2` for a pinned version. */
export function refKey(ref: IngredientRef): string {
  return ref.version === undefined ? ref.module : `${ref.module}@${ref.version}`;
}

/** The source with comments, strings and character literals blanked (newlines kept), so a scan sees code only. */
export function codeOnly(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|b?r(#*)"[\s\S]*?"\1|b?"(?:\\[\s\S]|[^"\\])*"|b?'(?:\\.|[^\\'\n])'/g, blank);
}

/** Whether the source defines its own `mod ingredients` (a kept plugin carries its ingredients, I11). */
export function hasOwnIngredients(source: string): boolean {
  return /(^|\n)\s*(?:#\[[^\]\n]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+ingredients\s*\{/.test(codeOnly(source));
}

/** The items of a `{ ... }` group at `open`, split at its top-level commas, and the index after its `}`. */
function groupItems(code: string, open: number): { items: string[]; end: number } {
  let depth = 0;
  let start = open + 1;
  const items: string[] = [];
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        items.push(code.slice(start, i));
        return { items: items.map((s) => s.trim()).filter(Boolean), end: i + 1 };
      }
    } else if (c === "," && depth === 1) {
      items.push(code.slice(start, i));
      start = i + 1;
    }
  }
  return { items: [], end: code.length };
}

/** `honeycomb`, `honeycomb::v2::*`, `honeycomb::{cells, Cell}`: the module and the version, if one is named. */
function refOf(path: string): IngredientRef | null {
  const m = /^([a-z][a-z0-9_]*)(?:\s*::\s*v(\d+)\b)?/.exec(path);
  if (!m || m[1] === "self") return null;
  return { module: m[1]!, ...(m[2] !== undefined ? { version: Number(m[2]) } : {}) };
}

/**
 * Every ingredient a source names, once each: `ingredients::x` and `crate::ingredients::x` paths, in `use` lines or
 * inline, with `{a, b::v2}` groups.
 */
export function ingredientRefs(source: string): IngredientRef[] {
  const code = codeOnly(source);
  const seen = new Map<string, IngredientRef>();
  const re = /(?<![A-Za-z0-9_])ingredients\s*::\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const before = code.slice(Math.max(0, m.index - 16), m.index);
    if (/(?:self|super)\s*::\s*$/.test(before)) continue;
    const at = m.index + m[0].length;
    const paths = code[at] === "{" ? groupItems(code, at).items : [code.slice(at, at + 200)];
    for (const path of paths) {
      const ref = refOf(path);
      if (ref) seen.set(refKey(ref), ref);
    }
  }
  return [...seen.values()];
}

/** The lines of an ingredient body that a module cannot hold: a main, another file, another crate. */
export function bodyProblem(body: string): string | null {
  const lines = codeOnly(lfOnly(body)).split("\n");
  const at = (re: RegExp) => lines.findIndex((line) => re.test(line));
  const main = at(/^\s*(pub\s+)?fn\s+main\s*\(/);
  if (main >= 0) return `line ${main + 1} is a main; an ingredient holds functions, types and constants for a recipe to call.`;
  const outside = at(/^\s*(mod\s+\w+\s*;|#\s*\[\s*path\b|extern\s+crate\b|#!\s*\[)/);
  if (outside >= 0) return `line ${outside + 1} brings in another file or crate, or sets a crate attribute; an ingredient is one module against lime_recipe.`;
  return null;
}

/** Where a line of the built text is: the recipe's own line, or a line of an ingredient's body. */
export interface LineMap {
  /** Lines 1..recipeLines are the recipe's. */
  recipeLines: number;
  bodies: { id: string; version: number; from: number; to: number }[];
}

/** The text the host builds: the recipe, ending in a newline, then the ingredients block. */
export function builtText(source: string, suffix: string): string {
  const text = lfOnly(source);
  if (!suffix) return text;
  return `${text.endsWith("\n") ? text : `${text}\n`}${suffix}`;
}

/** The line map of `builtText(source, resolved.suffix)`: the recipe's line count, then each body's lines. */
export function lineMap(source: string, resolved: Resolved): LineMap | null {
  if (!resolved.suffix) return null;
  const text = lfOnly(source);
  const recipeLines = (text.endsWith("\n") ? text : `${text}\n`).split("\n").length - 1;
  return { recipeLines, bodies: resolved.bodies.map((b) => ({ ...b, from: recipeLines + b.from, to: recipeLines + b.to })) };
}

/** A line of the built text as the agent can find it: the recipe's line, or `ingredient` and the line in its body. */
export function locate(map: LineMap | null, line: number): { line: number; ingredient?: string } {
  if (!map || line <= map.recipeLines) return { line };
  const body = map.bodies.find((b) => line >= b.from && line <= b.to);
  return body ? { line: line - body.from + 1, ingredient: `${body.id} v${body.version}` } : { line };
}

/** `line 12`, or `ingredient honeycomb v2, line 5`. */
export function lineText(map: LineMap | null, line: number): string {
  const at = locate(map, line);
  return at.ingredient ? `ingredient ${at.ingredient}, line ${at.line}` : `line ${at.line}`;
}

const STAMP = /^\/\/ ingredient: ([a-z][a-z0-9-]*) v(\d+) sha256:([0-9a-f]{64})$/;

/** The ingredients a source carries in its own `mod ingredients`, from their stamps (I11). */
export function carriedIngredients(source: string): { id: string; version: number; sha256: string }[] {
  return lfOnly(source).split("\n").map((line) => STAMP.exec(line.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => ({ id: m[1]!, version: Number(m[2]), sha256: m[3]! }));
}

/** What the host adds after a recipe: the block of inline modules, which ingredients it holds, and its line map. */
export interface Resolved {
  /** Text to append to the recipe; empty when it names no ingredient or carries its own. */
  suffix: string;
  /** Each ingredient used, by `refKey`. */
  used: Record<string, KeptIngredient>;
  /** Each body's first and last line, counted from the suffix's first line as 1. */
  bodies: LineMap["bodies"];
}

/** The latest version and the older ones of an ingredient in the library: `honeycomb has 1, 2 and 3`. */
function versionsText(id: string, dir: string): string {
  const latest = readPlugin(id, dir, undefined, "ingredient");
  const versions = [...olderVersions(id, dir), ...(latest && !("reason" in latest) ? [latest.header.version] : [])];
  return versions.length ? `${id} has version${versions.length === 1 ? "" : "s"} ${versions.join(", ")}` : `${id} has none`;
}

/** The names closest to `id`: those sharing a prefix of 3 or containing it, then the rest by edit distance. */
function closest(id: string, names: string[]): string[] {
  const distance = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const here = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = here;
      }
    }
    return row[b.length]!;
  };
  return names.map((name) => ({ name, d: name.includes(id) || id.includes(name) || name.slice(0, 3) === id.slice(0, 3) ? 0 : distance(id, name) })).filter((r) => r.d <= Math.max(2, Math.floor(id.length / 3))).sort((a, b) => a.d - b.d).slice(0, 3).map((r) => r.name);
}

/** The refusal for an ingredient the library does not have: the names it has, closest first. */
function unknownText(id: string, dir: string): string {
  const names = listLibrary(dir, "ingredient").map((file) => file.header.plugin);
  const near = closest(id, names);
  const has = names.length ? ` The library has: ${names.slice(0, 20).join(", ")}.` : " The library has no ingredients yet.";
  return `No ingredient is named ${id}.${near.length ? ` Did you mean ${near.join(" or ")}?` : ""}${has}`;
}

/** One ingredient file read from the library, as a kept copy, or a sentence. */
function fromLibrary(ref: IngredientRef, dir: string): KeptIngredient | { reason: string } {
  const id = idOf(ref.module);
  if (!isIngredientId(id)) return { reason: `ingredients::${ref.module} is not an ingredient name: lower-case letters, digits and underscores, starting with a letter.` };
  const latest = readPlugin(id, dir, undefined, "ingredient");
  if (!latest) return { reason: unknownText(id, dir) };
  if ("reason" in latest) return latest;
  let file: PluginFile = latest;
  if (ref.version !== undefined && ref.version !== latest.header.version) {
    const older = readPlugin(id, dir, ref.version, "ingredient");
    if (!older) return { reason: `No version ${ref.version} of the ingredient ${id} is kept: ${versionsText(id, dir)}.` };
    if ("reason" in older) return older;
    file = older;
  }
  const problem = bodyProblem(file.body);
  if (problem) return { reason: `The ingredient ${id} cannot be imported: ${problem}` };
  return { id, version: file.header.version, sha256: file.sha256, body: lfOnly(file.body) };
}

/**
 * The block to append after `source` for every ingredient it names, and those they name in turn. A kept copy (`kept`,
 * from the run's last apply) is used when `preferKept` is set (a rerun builds what it built) or when the library no
 * longer has that name or version. A source with its own `mod ingredients` is built as it stands.
 */
export function resolveIngredients(source: string, opts: { kept?: Record<string, KeptIngredient>; preferKept?: boolean; dir?: string } = {}): Resolved | { reason: string } {
  const text = lfOnly(source);
  if (hasOwnIngredients(text)) return { suffix: "", used: {}, bodies: [] };
  const dir = opts.dir ?? ingredientsDir();
  const used: Record<string, KeptIngredient> = {};
  const queue = ingredientRefs(text);
  for (let i = 0; i < queue.length; i += 1) {
    const ref = queue[i]!;
    const key = refKey(ref);
    if (used[key]) continue;
    const kept = opts.kept?.[key];
    let got: KeptIngredient | { reason: string };
    if (kept && opts.preferKept) got = kept;
    else {
      got = fromLibrary(ref, dir);
      if ("reason" in got && kept) got = kept;
    }
    if ("reason" in got) return got;
    used[key] = got;
    for (const next of ingredientRefs(got.body)) if (!queue.some((q) => refKey(q) === refKey(next))) queue.push(next);
    if (queue.length > 64) return { reason: "A recipe imports at most 64 ingredients, counting those they import." };
  }
  const keys = Object.keys(used);
  if (keys.length === 0) return { suffix: "", used, bodies: [] };
  const lines: string[] = [];
  const bodies: LineMap["bodies"] = [];
  const add = (row: KeptIngredient) => {
    lines.push(`// ingredient: ${row.id} v${row.version} sha256:${row.sha256}`);
    const body = (row.body.endsWith("\n") ? row.body.slice(0, -1) : row.body).split("\n");
    const from = lines.length + 1;
    bodies.push({ id: row.id, version: row.version, from, to: from + body.length - 1 });
    lines.push(...body);
  };
  lines.push("", "// --- Ingredients from the library, added by recipe_run before the build; not part of the recipe. ---", "#[allow(dead_code, unused_imports)]", "mod ingredients {");
  const modules = [...new Set(keys.map((key) => key.split("@")[0]!))].sort();
  for (const module of modules) {
    lines.push(`pub mod ${module} {`);
    if (used[module]) add(used[module]);
    const pinned = keys.filter((key) => key.startsWith(`${module}@`)).sort((a, b) => Number(a.split("@")[1]) - Number(b.split("@")[1]));
    for (const key of pinned) {
      lines.push(`pub mod v${key.split("@")[1]} {`);
      add(used[key]!);
      lines.push("}");
    }
    lines.push("}");
  }
  lines.push("}", "");
  return { suffix: lines.join("\n"), used, bodies };
}

/** A kept copy as the project stores it, checked; null when it is not one. */
export function keptIngredient(value: unknown): KeptIngredient | null {
  const row = value as Partial<KeptIngredient> | null;
  if (!row || typeof row !== "object" || typeof row.id !== "string" || typeof row.version !== "number" || typeof row.body !== "string") return null;
  return { id: row.id, version: row.version, sha256: typeof row.sha256 === "string" ? row.sha256 : bodyHash(row.body), body: row.body };
}
