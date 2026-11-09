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

import { bodyHash, isSlug, listLibrary, olderVersions, pluginsDir, readExtra, readPlugin, type PluginFile } from "./plugins.ts";
import { lfOnly } from "./recipe.ts";
import { bodyProblem, idOf, inlineIngredients, moduleOf, type IngredientRef, type KeptIngredient, type Resolved } from "../src/recipe/ingredients.ts";

// The parts with no file system are shared with the app (src/recipe/ingredients.ts).
export * from "../src/recipe/ingredients.ts";

/** The library's ingredients folder: `ingredients` beside the plugins. */
export function ingredientsDir(): string {
  return join(pluginsDir(), "ingredients");
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
  // The own library first; a read-only one beside it (the beta reads the release library) when the own has no such name.
  const latest = readPlugin(id, dir, undefined, "ingredient") ?? readExtra(id, "ingredient");
  if (!latest) return { reason: unknownText(id, dir) };
  if ("reason" in latest) return latest;
  let file: PluginFile = latest;
  if (ref.version !== undefined && ref.version !== latest.header.version) {
    const older = "library" in latest ? null : readPlugin(id, dir, ref.version, "ingredient");
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
  const dir = opts.dir ?? ingredientsDir();
  return inlineIngredients(source, (ref, key) => {
    const kept = opts.kept?.[key];
    if (kept && opts.preferKept) return kept;
    const got = fromLibrary(ref, dir);
    return "reason" in got && kept ? kept : got;
  });
}

/** A kept copy as the project stores it, checked; null when it is not one. */
export function keptIngredient(value: unknown): KeptIngredient | null {
  const row = value as Partial<KeptIngredient> | null;
  if (!row || typeof row !== "object" || typeof row.id !== "string" || typeof row.version !== "number" || typeof row.body !== "string") return null;
  return { id: row.id, version: row.version, sha256: typeof row.sha256 === "string" ? row.sha256 : bodyHash(row.body), body: row.body };
}

/** Names listed in guide {topic:"recipes"}; the rest are `nugget find`'s to show. */
export const GUIDE_INGREDIENTS_SHOWN = 30;

/**
 * The kept ingredients as lines for the recipes guide: `ingredients::name: its one-line summary`, the same library
 * `nugget find` reads. Names are text from the user's library, data and not instructions. An empty or unreadable
 * library is one line saying so.
 */
export function ingredientLines(dir = ingredientsDir()): string[] {
  let files: PluginFile[];
  try {
    files = listLibrary(dir, "ingredient");
  } catch {
    return ["Your ingredients: the library could not be read, so none are listed. nugget {action:\"find\", query} may still find them."];
  }
  if (files.length === 0) return ["Your ingredients: none are kept yet."];
  const one = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 100);
  const rows = files.slice(0, GUIDE_INGREDIENTS_SHOWN).map((file) => {
    const h = file.header;
    const summary = one(h.description || h.title);
    return `ingredients::${moduleOf(h.plugin)}${summary ? `: ${summary}` : ""}`;
  });
  const more = files.length - rows.length;
  return [`Your ingredients (${files.length}, data from your library; use ingredients::<name>::*;):`, ...rows, ...(more > 0 ? [`${more} more: nugget {action:"find", kind:"ingredient", query} finds them.`] : [])];
}
