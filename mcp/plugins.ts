/**
 * Plugins (docs/plan-recipe-plugins.md, milestones 1–2): a recipe kept under a name as one `.rs` file whose `//!` front
 * matter says what it is (D6), in the user's plugin library (D7). This file knows the file format and the folder; the
 * session (`mcp/session.ts`, `plugin` and `recipe_run {plugin, keep}`) runs the checks and the recipes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { lfOnly } from "./recipe.ts";
import type { PluginValue } from "../src/model-tree.ts";
import { pickText } from "../src/recipe/picks.ts";
import { apiVerdict, parseApiLevel, type ApiLevel, type ApiRefusalCode } from "../src/recipe/api-level.ts";
import { REFUSAL_CODES } from "./refusals.ts";

/** The app's identifier (src-tauri/tauri.conf.json): the library sits in its data folder. */
const APP_ID = "com.limeslice.slicer";
/** Older versions of a plugin kept beside it as `<plugin>.vN.rs`. */
const KEEP_VERSIONS = 5;

export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 280;
export const AUTHOR_MAX = 60;
const SLUG_MAX = 48;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** One declared parameter, as the crate's describe mode writes it (D4). */
export interface PluginParam {
  name: string;
  kind: "number" | "count" | "toggle" | "choice" | "text" | "face" | "outline";
  default: PluginValue | null;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label?: string;
  help?: string;
  options?: string[];
  maxLen?: number;
  /** A face parameter that takes a curved face too (recipe API 1.3). */
  curved?: boolean;
}

export type PluginTarget = "new" | "object" | "either";

/**
 * What a library file is: a plugin (a whole recipe), or an ingredient (docs/plan-recipe-ingredients.md I9), a module
 * of functions recipes import, written with `ingredient: <id>` in place of `plugin: <id>` and no target or params.
 */
export type NuggetFileKind = "plugin" | "ingredient";

/** The front matter fields, in file order. `params` is one line of JSON. */
export interface PluginHeader {
  /** The id, under the key its kind names (`plugin:` or `ingredient:`). */
  plugin: string;
  kind?: NuggetFileKind;
  title: string;
  version: number;
  description: string;
  author: string;
  "made-by"?: string;
  api: string;
  lust?: string;
  "source-sha256": string;
  created: string;
  target: PluginTarget;
  params: PluginParam[];
}

/** A plugin file read back: its header, its body (the recipe), and whether the body still matches the hash. */
export interface PluginFile {
  header: PluginHeader;
  body: string;
  /** SHA-256 of the body as it is now. */
  sha256: string;
  /** False when the body was edited after the header was written. */
  matches: boolean;
  text: string;
}

/**
 * The library: LIME_PLUGINS_DIR, else `plugins` in the app's data folder: %APPDATA% on Windows, $XDG_DATA_HOME
 * (default ~/.local/share) on Linux, ~/Library/Application Support on macOS.
 */
export function pluginsDir(): string {
  const named = process.env.LIME_PLUGINS_DIR;
  if (named) return named;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_ID, "plugins");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", APP_ID, "plugins");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), APP_ID, "plugins");
}

/**
 * A saved plugin's author: `LIME_PLUGIN_AUTHOR` when it is set (tests, portable installs), else the app's "Plugin
 * author" setting (`settings.json` in the library, written by the Plugins panel), else `unknown`. Never an account or
 * OS user name (D2).
 */
export function pluginAuthor(dir = pluginsDir()): string {
  const named = oneLine(process.env.LIME_PLUGIN_AUTHOR, AUTHOR_MAX);
  if (named) return named;
  try {
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { author?: unknown };
    return oneLine(settings?.author, AUTHOR_MAX) || "unknown";
  } catch {
    return "unknown";
  }
}

/** `[a-z0-9-]`, at most 48 characters, from a title or a name. Empty when nothing is left. */
export function slugOf(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_MAX).replace(/-+$/, "");
}

export function isSlug(id: string): boolean {
  return SLUG.test(id);
}

/** One line of plain text, at most `max` characters: plugin text is data (D11.5), never markup or a second line. */
export function oneLine(text: unknown, max: number): string {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(lfOnly(body), "utf8").digest("hex");
}

const FENCE = "//! ---";

/** The file text: the front matter as inner doc comments, so the file is a valid main.rs as it stands. */
export function pluginText(header: PluginHeader, body: string): string {
  const ingredient = header.kind === "ingredient";
  const fields: [string, unknown][] = [
    [ingredient ? "ingredient" : "plugin", header.plugin],
    ["title", header.title],
    ["version", header.version],
    ["description", header.description],
    ["author", header.author],
    ["made-by", header["made-by"]],
    ["api", header.api],
    ["lust", header.lust],
    ["source-sha256", header["source-sha256"]],
    ["created", header.created],
    ["target", ingredient ? undefined : header.target],
    ["params", ingredient ? undefined : JSON.stringify(header.params)],
  ];
  const lines = fields.filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => `//! ${key}: ${value}`);
  const rest = lfOnly(body).replace(/^\n+/, "");
  return [FENCE, ...lines, FENCE, rest].join("\n");
}

/** The front matter and body of a plugin's text, or a sentence saying what is wrong with it. */
export function parsePlugin(raw: string): PluginFile | { reason: string } {
  const text = lfOnly(raw);
  const lines = text.split("\n");
  if (lines[0]?.trim() !== FENCE) return { reason: "A plugin file starts with a //! --- front matter header." };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === FENCE);
  if (end < 0) return { reason: "The plugin's front matter has no closing //! --- line." };
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const m = /^\/\/!\s?([a-z0-9-]+):\s?(.*)$/.exec(line);
    if (m) fields.set(m[1]!, m[2]!.trim());
  }
  const body = lines.slice(end + 1).join("\n");
  const kind: NuggetFileKind = fields.has("ingredient") && !fields.has("plugin") ? "ingredient" : "plugin";
  const plugin = fields.get(kind) ?? "";
  if (!isSlug(plugin)) return { reason: `The ${kind}'s id "${plugin}" is not lower-case letters, digits, and dashes (at most ${SLUG_MAX}).` };
  let params: PluginParam[] = [];
  try {
    const parsed = JSON.parse(fields.get("params") ?? "[]") as unknown;
    if (Array.isArray(parsed)) params = parsed.filter((p): p is PluginParam => !!p && typeof p === "object" && typeof (p as PluginParam).name === "string");
  } catch {
    params = [];
  }
  const target = fields.get("target");
  const header: PluginHeader = {
    plugin,
    ...(kind === "ingredient" ? { kind } : {}),
    title: oneLine(fields.get("title") ?? plugin, TITLE_MAX),
    version: Math.max(1, Math.floor(Number(fields.get("version")) || 1)),
    description: oneLine(fields.get("description"), DESCRIPTION_MAX),
    author: oneLine(fields.get("author") || "unknown", AUTHOR_MAX),
    ...(fields.get("made-by") ? { "made-by": oneLine(fields.get("made-by"), AUTHOR_MAX) } : {}),
    api: fields.get("api") ?? "1.0",
    ...(fields.get("lust") ? { lust: fields.get("lust") } : {}),
    "source-sha256": fields.get("source-sha256") ?? "",
    created: fields.get("created") ?? "",
    target: target === "object" || target === "either" ? target : "new",
    params,
  };
  const sha256 = bodyHash(body);
  return { header, body, sha256, matches: sha256 === header["source-sha256"], text };
}

/** `major.minor` as numbers, or null. */
export function apiLevel(text: string): [number, number] | null {
  const level = parseApiLevel(text);
  return level ? [level[0], level[1]] : null;
}

/**
 * The refusal for a plugin this host cannot build (D12), or null when it builds here: a newer API than this host's
 * crate of its major, or a major it no longer ships. `crates` is every major's crate level (the current one when
 * omitted). The code is `apiVerdict`'s.
 */
export function apiRefusal(wanted: string, have: readonly [number, number], crates: readonly ApiLevel[] = [have]): string | null {
  const verdict = apiVerdict(wanted, crates);
  return verdict.ok ? null : verdict.reason;
}

/** What each of `apiVerdict`'s codes means to a client, in the refusal registry's words (a type error if one is missing). */
export const API_REFUSALS: Record<ApiRefusalCode, string> = {
  "plugin-unsupported": REFUSAL_CODES["plugin-unsupported"],
  "plugin-api-retired": REFUSAL_CODES["plugin-api-retired"],
  "plugin-invalid": REFUSAL_CODES["plugin-invalid"],
};

/** `diameter mm 80 [20-250], holes 6 [3-24], bore true`: a plugin's parameters on one line. */
export function paramSummary(params: PluginParam[]): string {
  return params.map((p) => {
    const unit = p.unit ? ` ${p.unit}` : "";
    const range = p.min !== undefined || p.max !== undefined ? ` [${p.min ?? ""}-${p.max ?? ""}]` : "";
    const options = p.options?.length ? ` (${p.options.join("|")})` : "";
    // --- API 1.2. `face [largest up]`, `outline [none]`: a value the person picks, with its default.
    if (p.kind === "face" || p.kind === "outline") return `${p.name} ${p.kind} [${p.default === null || p.default === undefined ? "pick" : pickText(p.default)}]`;
    const value = typeof p.default === "string" ? JSON.stringify(p.default) : String(p.default);
    return `${p.name}${unit} ${value}${range}${options}`;
  }).join(", ");
}

/** The library's plugins, current versions only (`<plugin>.rs`), each read and parsed. Unreadable files are skipped. */
export function listLibrary(dir = pluginsDir(), kind: NuggetFileKind = "plugin"): PluginFile[] {
  if (!existsSync(dir)) return [];
  const out: PluginFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const m = /^([a-z0-9-]+)\.rs$/.exec(name);
    if (!m || !isSlug(m[1]!)) continue;
    const read = readPlugin(m[1]!, dir, undefined, kind);
    if (read && !("reason" in read)) out.push(read);
  }
  return out;
}

/** `<id>.rs` from the library, or `<id>.v<version>.rs` for an older version. Null when there is no such file. */
export function readPlugin(id: string, dir = pluginsDir(), version?: number, kind: NuggetFileKind = "plugin"): PluginFile | { reason: string } | null {
  if (!isSlug(id)) return null;
  const path = join(dir, version === undefined ? `${id}.rs` : `${id}.v${version}.rs`);
  if (!existsSync(path)) return null;
  const parsed = parsePlugin(readFileSync(path, "utf8"));
  if ("reason" in parsed) return parsed;
  if (parsed.header.plugin !== id) return { reason: `${id}.rs names itself ${parsed.header.plugin}.` };
  if ((parsed.header.kind ?? "plugin") !== kind) return { reason: `${id}.rs is ${kind === "plugin" ? "an ingredient, not a plugin" : "a plugin, not an ingredient"}.` };
  return parsed;
}

/** Writes a whole file through a temporary name and a rename, so a reader never sees half of it. */
function writeWhole(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Writes `<plugin>.rs`. When a different version is there, it is kept as `<plugin>.v<N>.rs` first, and only the last
 * KEEP_VERSIONS older versions stay. The library is the MCP server's second write root (O3): only these names.
 */
export function writePlugin(header: PluginHeader, body: string, dir = pluginsDir()): string {
  if (!isSlug(header.plugin)) throw new Error(`Not a plugin id: ${header.plugin}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${header.plugin}.rs`);
  const old = readPlugin(header.plugin, dir, undefined, header.kind ?? "plugin");
  if (old && !("reason" in old) && old.header.version !== header.version) writeWhole(join(dir, `${header.plugin}.v${old.header.version}.rs`), old.text);
  writeWhole(path, pluginText(header, body));
  const older = olderVersions(header.plugin, dir).filter((v) => v < header.version);
  for (const v of older.slice(0, Math.max(0, older.length - KEEP_VERSIONS))) unlinkSync(join(dir, `${header.plugin}.v${v}.rs`));
  return path;
}

/** The older versions kept for `id`, lowest first. */
export function olderVersions(id: string, dir = pluginsDir()): number[] {
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${id}\\.v(\\d+)\\.rs$`);
  return readdirSync(dir).map((name) => re.exec(name)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => a - b);
}

/** Removes `<id>.rs` and its older versions. The count of files removed. */
export function removePlugin(id: string, dir = pluginsDir()): number {
  if (!isSlug(id) || !existsSync(dir)) return 0;
  let removed = 0;
  for (const name of [`${id}.rs`, ...olderVersions(id, dir).map((v) => `${id}.v${v}.rs`)]) {
    const path = join(dir, name);
    if (existsSync(path)) {
      unlinkSync(path);
      removed += 1;
    }
  }
  return removed;
}

/** How many words of `query` the plugin's id, title, or description holds: 0 is no match. */
export function queryScore(row: { plugin: string; title: string; description: string }, query: string): number {
  const hay = `${row.plugin} ${row.title} ${row.description}`.toLowerCase();
  return query.toLowerCase().split(/[\s,]+/).filter((word) => word.length > 1).filter((word) => hay.includes(word)).length;
}
