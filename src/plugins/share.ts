/**
 * --- Sharing plugins (docs/plan-recipe-plugins.md D10, D11.4–D11.6, milestone 8). One file a person sends: the plugin
 * as the library keeps it (its code, the ingredients it carries inline, I11, and the recipe data it carries after its
 * code), with its presets and the lessons about it as two more front matter lines. The front matter is outside the
 * body's hash, so an exported file has the library file's `source-sha256`, and an import of it gives the same plugin.
 *
 *     //! ---
 *     //! plugin: bolt-circle-flange
 *     //! ...
 *     //! params: [...]
 *     //! presets: {"m6-thin":{"params":{"holes":6},"created":"2026-11-04"}}
 *     //! lessons: [{"about":"bolt-circle-flange","text":"...","created":"2026-11-04"}]
 *     //! ---
 *
 * The name is `<id>-v<N>.lime-plugin.rs`: still `.rs`, so it builds, highlights and reads in a chat as it stands, and
 * `.lime-plugin` says what it is to a person, a file picker and a drop. A plain library `<id>.rs` imports the same way.
 *
 * Import checks the file without running it (D11.6: nothing runs before a person has seen the source): its header,
 * the text caps of D11.5, the API level (D12), one file against lime_recipe (D11.4), no hidden text-direction
 * characters. Browser-safe and shared: the MCP server (`mcp/session.ts`) and the Plugins panel run the same checks.
 */
import { codeOnly, carriedIngredients, moduleOf } from "../recipe/ingredients.ts";
import { carriedData } from "../recipe/plugin-data.ts";
import { isPickValue } from "../recipe/picks.ts";
import type { PluginValue } from "../model-tree.ts";

export const SHARE_SUFFIX = ".lime-plugin.rs";

export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 280;
export const AUTHOR_MAX = 60;
/** A parameter's label, and each of a choice's options. */
export const LABEL_MAX = 60;
/** A parameter's help line: as long as a description. */
export const HELP_MAX = 280;
export const UNIT_MAX = 12;
export const LESSON_MAX = 200;
/** What one shared file may bring besides the plugin. */
export const PRESETS_MAX = 50;
export const LESSONS_MAX = 50;
export const PARAMS_MAX = 64;

const FENCE = "//! ---";
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const ABOUT = /^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,59}$/;
/** Characters that make text read in another order than it runs ("Trojan source"); rustc denies them too. */
const BIDI = /[‪-‮⁦-⁩]/;

/** A preset as a shared file carries it: the values, and when it was kept. */
export interface SharedPreset {
  params: Record<string, PluginValue>;
  created: string;
}

/** A lesson as a shared file carries it; it takes a new number in the library it joins. */
export interface SharedLesson {
  about: string;
  text: string;
  created: string;
}

/** `bolt-circle-flange-v3.lime-plugin.rs`. */
export function exportName(id: string, version: number): string {
  return `${id}-v${version}${SHARE_SUFFIX}`;
}

/** Whether a dropped or picked file's name is a plugin file to import (`.lime-plugin.rs`, or a library `.rs`). */
export function isPluginFileName(name: string): boolean {
  return /\.rs$/i.test(name);
}

function lf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The header's line range: the index of the closing fence, or -1. */
function closingFence(lines: readonly string[]): number {
  if (lines[0]?.trim() !== FENCE) return -1;
  return lines.findIndex((line, i) => i > 0 && line.trim() === FENCE);
}

/** The raw `key: value` lines of the header, uncut, as they are in the file. */
export function rawHeader(text: string): Map<string, string> | null {
  const lines = lf(text).split("\n");
  const end = closingFence(lines);
  if (end < 0) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const m = /^\/\/!\s?([a-z0-9-]+):\s?(.*)$/.exec(line);
    if (m) fields.set(m[1]!, m[2]!.trim());
  }
  return fields;
}

/** The file with the sharing lines (`presets`, `lessons`) taken out of its header: the library's file. */
export function withoutShareLines(text: string): string {
  const lines = lf(text).split("\n");
  const end = closingFence(lines);
  if (end < 0) return lf(text);
  const head = lines.slice(0, end).filter((line, i) => i === 0 || !/^\/\/!\s?(presets|lessons):/.test(line));
  return [...head, ...lines.slice(end)].join("\n");
}

/**
 * The file to send: the library file with its presets and lessons as header lines (none when there are none). The body
 * is untouched, so the hash in the header still names it.
 */
export function exportText(fileText: string, presets: Readonly<Record<string, SharedPreset>>, lessons: readonly SharedLesson[]): string {
  const lines = lf(withoutShareLines(fileText)).split("\n");
  const end = closingFence(lines);
  if (end < 0) return lines.join("\n");
  const extra: string[] = [];
  const names = Object.keys(presets).sort();
  if (names.length) extra.push(`//! presets: ${JSON.stringify(Object.fromEntries(names.map((name) => [name, { params: presets[name]!.params, created: presets[name]!.created }])))}`);
  if (lessons.length) extra.push(`//! lessons: ${JSON.stringify(lessons.map((l) => ({ about: l.about, text: l.text, created: l.created })))}`);
  return [...lines.slice(0, end), ...extra, ...lines.slice(end)].join("\n");
}

/**
 * The lessons about a plugin (I15's `about` names an op kind or helper): those about its id, or about an ingredient it
 * carries (by id or module, or a helper inside it: `honeycomb::cells`). Oldest first, as the library keeps them.
 */
export function lessonsFor<L extends { about: string }>(id: string, ingredients: readonly string[], lessons: readonly L[]): L[] {
  const names = new Set([id, moduleOf(id), ...ingredients.flatMap((ing) => [ing, moduleOf(ing)])]);
  return lessons.filter((row) => {
    const about = row.about;
    if (names.has(about)) return true;
    const head = /^([A-Za-z0-9_-]+)(?:::|\.)/.exec(about)?.[1];
    return !!head && names.has(head);
  });
}

/** What an import would bring: everything the panel's first-run view and the MCP reply show. */
export interface ImportFile {
  id: string;
  title: string;
  version: number;
  description: string;
  author: string;
  madeBy: string;
  api: string;
  created: string;
  /** The code's hash, as computed here. */
  sha256: string;
  /** The hash the header names; differs from `sha256` when the code was changed after it was kept. */
  headerSha: string;
  /** The ingredients it carries inline, the recipe data it carries, by name. */
  ingredients: { id: string; version: number }[];
  data: { name: string; bytes: number }[];
  presets: Record<string, SharedPreset>;
  lessons: SharedLesson[];
  /** The file as the library keeps it: the sharing lines taken out. */
  libraryText: string;
  body: string;
}

/** The body after the header, as the hash covers it. */
export function bodyOf(text: string): string | null {
  const lines = lf(text).split("\n");
  const end = closingFence(lines);
  return end < 0 ? null : lines.slice(end + 1).join("\n");
}

function tooLong(what: string, text: string, max: number): string | null {
  if ([...text].length <= max) return null;
  return `Its ${what} is ${[...text].length} characters; a plugin's ${what} is at most ${max}. It was not imported: plugin text is shown as data, and text that long is not a ${what}.`;
}

/** `major.minor` or null. */
function level(text: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The one sentence for a plugin this app cannot build (D12), or null. */
export function apiProblem(api: string, have: readonly [number, number]): string | null {
  const wanted = level(api);
  if (!wanted) return `It names recipe API "${api}", which is not a level like 1.1, so it was not imported.`;
  if (wanted[0] > have[0] || (wanted[0] === have[0] && wanted[1] > have[1])) {
    return `It needs recipe API ${wanted[0]}.${wanted[1]}; this Lime Slice has ${have[0]}.${have[1]}. Update Lime Slice, then import it again.`;
  }
  if (wanted[0] < have[0]) return `It was written for recipe API ${wanted[0]}.x, which this Lime Slice no longer builds.`;
  return null;
}

/** D11.4: the first line that brings in another file or crate, with its number, or null. */
export function oneFileProblem(body: string): string | null {
  const lines = codeOnly(lf(body)).split("\n");
  const bad = lines.findIndex((line) => /^\s*(mod\s+\w+\s*;|#\s*\[\s*path\b|extern\s+crate\s+(?!lime_recipe\b))/.test(line));
  if (bad < 0) return null;
  return `Line ${bad + 1} brings in another file or crate; a plugin is one file against lime_recipe, so it was not imported.`;
}

/**
 * The file read and checked for import, or the one sentence that says why it is not imported. Nothing here runs the
 * code. `have` is this app's recipe API; `sha256` hashes the body (Node's; the app hashes with Web Crypto after).
 */
export function checkImport(raw: string, have: readonly [number, number], sha256: (body: string) => string = () => ""): ImportFile | { reason: string } {
  const text = lf(raw);
  if (BIDI.test(text)) {
    const line = text.split("\n").findIndex((row) => BIDI.test(row)) + 1;
    return { reason: `Line ${line} holds an invisible text-direction character, which can make code read differently than it runs. It was not imported.` };
  }
  const fields = rawHeader(text);
  if (!fields) return { reason: "This is not a plugin file: a plugin starts with a //! --- header that names it. Export one from the Plugins panel, or keep a recipe as a plugin first." };
  if (fields.has("ingredient") && !fields.has("plugin")) return { reason: "This file is an ingredient, not a plugin. A plugin that imports it carries its own copy; import that plugin instead." };
  const id = fields.get("plugin") ?? "";
  if (!SLUG.test(id)) return { reason: `Its id "${id.slice(0, 60)}" is not lower-case letters, digits and dashes (at most 48), so it was not imported.` };
  for (const [what, key, max] of [["title", "title", TITLE_MAX], ["description", "description", DESCRIPTION_MAX], ["author", "author", AUTHOR_MAX], ["made-by line", "made-by", AUTHOR_MAX]] as const) {
    const problem = tooLong(what, fields.get(key) ?? "", max);
    if (problem) return { reason: problem };
  }
  let params: unknown[] = [];
  try {
    const parsed = JSON.parse(fields.get("params") ?? "[]") as unknown;
    if (!Array.isArray(parsed)) throw new Error("not a list");
    params = parsed;
  } catch {
    return { reason: "Its params line is not a list of parameters, so it was not imported. Ask its author for the file as exported." };
  }
  if (params.length > PARAMS_MAX) return { reason: `It declares ${params.length} values; a plugin declares at most ${PARAMS_MAX}. It was not imported.` };
  for (const p of params) {
    const row = (p ?? {}) as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name : "";
    for (const [what, value, max] of [["label", row.label, LABEL_MAX], ["help", row.help, HELP_MAX], ["unit", row.unit, UNIT_MAX]] as const) {
      if (typeof value === "string" && [...value].length > max) return { reason: `The ${what} of its value ${name.slice(0, 40)} is ${[...value].length} characters; at most ${max}. It was not imported.` };
    }
    if (Array.isArray(row.options) && row.options.some((o) => typeof o !== "string" || [...o].length > LABEL_MAX)) return { reason: `An option of its value ${name.slice(0, 40)} is longer than ${LABEL_MAX} characters. It was not imported.` };
  }
  const api = fields.get("api") ?? "1.0";
  const apiWhy = apiProblem(api, have);
  if (apiWhy) return { reason: apiWhy };
  const body = bodyOf(text) ?? "";
  const outside = oneFileProblem(body);
  if (outside) return { reason: outside };
  const presets: Record<string, SharedPreset> = {};
  if (fields.has("presets")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fields.get("presets")!);
    } catch {
      return { reason: "Its presets line does not read, so it was not imported. Ask its author for the file as exported." };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { reason: "Its presets line does not read, so it was not imported." };
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length > PRESETS_MAX) return { reason: `It brings ${entries.length} presets; a shared plugin brings at most ${PRESETS_MAX}. It was not imported.` };
    for (const [name, row] of entries) {
      if (!SLUG.test(name)) return { reason: `Its preset "${name.slice(0, 40)}" is not named in lower-case letters, digits and dashes. It was not imported.` };
      const values = (row as { params?: unknown } | null)?.params;
      if (!values || typeof values !== "object" || Array.isArray(values)) return { reason: `Its preset ${name} has no values. It was not imported.` };
      const kept = Object.entries(values as Record<string, unknown>).filter(([, v]) => typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && [...v].length <= HELP_MAX) || (isPickValue(v) && JSON.stringify(v).length <= 20_000));
      presets[name] = { params: Object.fromEntries(kept) as SharedPreset["params"], created: String((row as { created?: unknown }).created ?? "").slice(0, 32) };
    }
  }
  const lessons: SharedLesson[] = [];
  if (fields.has("lessons")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fields.get("lessons")!);
    } catch {
      return { reason: "Its lessons line does not read, so it was not imported. Ask its author for the file as exported." };
    }
    if (!Array.isArray(parsed)) return { reason: "Its lessons line does not read, so it was not imported." };
    if (parsed.length > LESSONS_MAX) return { reason: `It brings ${parsed.length} lessons; a shared plugin brings at most ${LESSONS_MAX}. It was not imported.` };
    for (const row of parsed) {
      const r = (row ?? {}) as Record<string, unknown>;
      if (typeof r.about !== "string" || !ABOUT.test(r.about) || typeof r.text !== "string") return { reason: "A lesson it brings names no op kind or helper, so it was not imported." };
      const problem = tooLong("lesson", r.text, LESSON_MAX);
      if (problem) return { reason: problem };
      lessons.push({ about: r.about, text: r.text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim(), created: String(r.created ?? "").slice(0, 32) });
    }
  }
  return {
    id,
    title: (fields.get("title") || id).trim(),
    version: Math.max(1, Math.floor(Number(fields.get("version")) || 1)),
    description: fields.get("description") ?? "",
    author: fields.get("author") || "unknown",
    madeBy: fields.get("made-by") ?? "",
    api,
    created: fields.get("created") ?? "",
    sha256: sha256(body),
    headerSha: fields.get("source-sha256") ?? "",
    ingredients: carriedIngredients(body).map(({ id: ing, version }) => ({ id: ing, version })),
    data: carriedData(body).map(({ name, bytes }) => ({ name, bytes })),
    presets,
    lessons,
    libraryText: withoutShareLines(text),
    body,
  };
}

/** What a library already holds under the import's id: nothing, the same code, or another plugin. */
export type Clash =
  | { kind: "new" }
  | { kind: "same"; version: number }
  /** Another body under the same id. `newer` when the file is a later version of it, offered as an update. */
  | { kind: "clash"; keepBoth: string; version: number; newer: boolean };

/**
 * D10's name clash: the id is free (new), holds this code (same), or holds other code (clash), when the import can be
 * kept beside it as `<id>-2` (the first free or same-code suffix) or replace it.
 */
export function clashOf(id: string, sha256: string, version: number, library: (id: string) => { sha256: string; version: number } | null): Clash {
  const there = library(id);
  if (!there) return { kind: "new" };
  if (there.sha256 === sha256) return { kind: "same", version: there.version };
  for (let n = 2; ; n += 1) {
    const candidate = `${id.slice(0, 45).replace(/-+$/, "")}-${n}`;
    const other = library(candidate);
    if (!other || other.sha256 === sha256) return { kind: "clash", keepBoth: candidate, version: there.version, newer: version > there.version };
  }
}

/** The header with another id and title: a plugin kept beside a clash as `<id>-2`, titled "<title> (2)". */
export function renamed(text: string, id: string, title: string): string {
  return lf(text).replace(/^\/\/!\s?plugin:.*$/m, `//! plugin: ${id}`).replace(/^\/\/!\s?title:.*$/m, `//! title: ${title.slice(0, TITLE_MAX)}`);
}

/** The title a plugin kept beside a clash takes: `Flange (2)` for `flange-2`. */
export function keptBesideTitle(title: string, id: string): string {
  const n = /-(\d+)$/.exec(id)?.[1] ?? "2";
  return `${title.slice(0, TITLE_MAX - n.length - 3).trimEnd()} (${n})`;
}

/**
 * The presets file with the shared presets added (`{ "<name>": {params, created} }`, as `mcp/nuggets.ts` writes it). A
 * name the library already has keeps the library's values.
 */
export function mergePresets(existing: string | null, presets: Readonly<Record<string, SharedPreset>>): { text: string; added: string[] } {
  let rows: Record<string, unknown> = {};
  try {
    const parsed = existing ? (JSON.parse(existing) as unknown) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows = parsed as Record<string, unknown>;
  } catch {
    rows = {};
  }
  const added: string[] = [];
  for (const [name, preset] of Object.entries(presets)) {
    if (name in rows) continue;
    rows[name] = { params: preset.params, created: preset.created };
    added.push(name);
  }
  return { text: `${JSON.stringify(rows, null, 2)}\n`, added };
}

/** `lessons.json` with the shared lessons added, numbered after the last; the same sentence about the same thing once. */
export function mergeLessons(existing: string | null, lessons: readonly SharedLesson[]): { text: string; added: number } {
  let rows: { n: number; about: string; text: string; created: string }[] = [];
  try {
    const parsed = existing ? (JSON.parse(existing) as unknown) : [];
    if (Array.isArray(parsed)) rows = parsed.filter((r): r is { n: number; about: string; text: string; created: string } => !!r && typeof r.n === "number" && typeof r.about === "string" && typeof r.text === "string");
  } catch {
    rows = [];
  }
  let added = 0;
  let n = rows.reduce((max, row) => Math.max(max, row.n), 0);
  for (const lesson of lessons) {
    if (rows.some((row) => row.about === lesson.about && row.text.toLowerCase() === lesson.text.toLowerCase())) continue;
    n += 1;
    rows.push({ n, about: lesson.about, text: lesson.text, created: lesson.created });
    added += 1;
  }
  return { text: `${JSON.stringify(rows.slice(-500), null, 2)}\n`, added };
}

/** The version a replacing import takes: the file's own, or above what the library had, so the old one is kept as vN. */
export function replacedVersion(text: string, above: number): string {
  const fields = rawHeader(text);
  const own = Math.max(1, Math.floor(Number(fields?.get("version")) || 1));
  if (own > above) return lf(text);
  return lf(text).replace(/^\/\/!\s?version:.*$/m, `//! version: ${above + 1}`);
}

// ---------------------------------------------------------------------------
// The "imported" mark (D11.6): `imported.json` in the library, `{ "<id>": {sha256, from, at} }`, until a person
// approves its first run in the app. The MCP server and the app write it; the app clears it.
// ---------------------------------------------------------------------------

export interface ImportMark {
  sha256: string;
  /** Where it came from: a file, a project, or an MCP call. */
  from: "file" | "project" | "mcp";
  at: string;
}

export function readMarks(text: string | null | undefined): Record<string, ImportMark> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ImportMark> = {};
    for (const [id, row] of Object.entries(parsed as Record<string, unknown>)) {
      const r = row as Partial<ImportMark> | null;
      if (SLUG.test(id) && r && typeof r.sha256 === "string") out[id] = { sha256: r.sha256, from: r.from === "project" || r.from === "mcp" ? r.from : "file", at: String(r.at ?? "") };
    }
    return out;
  } catch {
    return {};
  }
}

export function marksText(marks: Readonly<Record<string, ImportMark>>): string {
  return `${JSON.stringify(marks, null, 2)}\n`;
}

/** The marks with `id` marked (or unmarked when `mark` is null). */
export function withMark(marks: Readonly<Record<string, ImportMark>>, id: string, mark: ImportMark | null): Record<string, ImportMark> {
  const out = { ...marks };
  if (mark) out[id] = mark;
  else delete out[id];
  return out;
}

/** The sentence the first-run view says about what a plugin may do (D11.6). */
export const MAY_DO = "It can build and change only the part you run it on. It cannot read files, use the network or start programs.";

/** "carries the ingredients honeycomb v2; the recipe data skull/outline (12 KB); 2 presets; 1 lesson", or "". */
export function carriesText(file: Pick<ImportFile, "ingredients" | "data" | "presets" | "lessons">, size: (bytes: number) => string): string {
  const parts: string[] = [];
  if (file.ingredients.length) parts.push(`the ingredient${file.ingredients.length === 1 ? "" : "s"} ${file.ingredients.map((i) => `${i.id} v${i.version}`).join(", ")}`);
  if (file.data.length) parts.push(`the recipe data ${file.data.map((d) => `${d.name} (${size(d.bytes)})`).join(", ")}`);
  const presets = Object.keys(file.presets).length;
  if (presets) parts.push(`${presets} preset${presets === 1 ? "" : "s"}`);
  if (file.lessons.length) parts.push(`${file.lessons.length} lesson${file.lessons.length === 1 ? "" : "s"}`);
  return parts.join("; ");
}
