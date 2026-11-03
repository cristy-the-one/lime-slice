/**
 * --- The plugin library in the app (docs/plan-recipe-plugins.md D7, D13, milestone 7). The app reads the same folder
 * the MCP server writes (`%APPDATA%\com.limeslice.slicer\plugins`, or `LIME_PLUGINS_DIR`) through the desktop shell
 * (`src-tauri/src/plugins.rs`), and keeps everything it decides here, browser-safe: which files are plugins, their
 * presets (`presets/<plugin>.json`), the "Plugin author" setting (`settings.json`), the panel's sections and search,
 * the version a save gets, and which library version a stamped step could move to.
 *
 * A page under test sets `__limePluginLibrary` (or the recipe runner's `__limeRecipeRunner`) to answer the shell's
 * commands, as the recipe runner's own specs do; the browser build has no library and says so.
 */
import { isTauri } from "../platform.ts";
import { bodySha256, readPluginFile, type PluginFileInfo, type PluginParamInfo } from "../plugin-file.ts";
import type { PluginStamp } from "../model-tree.ts";

/** What the shell lists: every `.rs` file of the folder (current and older versions), the presets, the settings. */
export interface LibraryListing {
  dir: string;
  files: { name: string; text: string }[];
  presets: { plugin: string; text: string }[];
  settings: string | null;
}

/** One plugin of the library, its current version, read and checked against its own header's hash. */
export interface LibraryPlugin {
  file: PluginFileInfo;
  /** The body's hash as it is now. */
  sha256: string;
  /** False when the body was edited after the header was written. */
  intact: boolean;
  /** Older versions kept beside it (`<id>.vN.rs`), lowest first. */
  older: number[];
}

export interface Preset {
  name: string;
  params: Record<string, number | boolean | string>;
}

/** The library as the app last read it. */
export interface PluginLibrary {
  dir: string;
  /** Current versions by id. */
  plugins: ReadonlyMap<string, LibraryPlugin>;
  /** Every version the folder holds, current and older, by its body's hash. */
  bySha: ReadonlyMap<string, PluginFileInfo>;
  presets: ReadonlyMap<string, Preset[]>;
  /** The "Plugin author" setting; empty when none is set. */
  author: string;
}

export const EMPTY_LIBRARY: PluginLibrary = { dir: "", plugins: new Map(), bySha: new Map(), presets: new Map(), author: "" };

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export const AUTHOR_MAX = 60;
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 280;

export function isSlug(id: string): boolean {
  return SLUG.test(id);
}

/** `[a-z0-9-]`, at most 48 characters, from a title (`slugOf` in `mcp/plugins.ts`). */
export function slugOf(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
}

/** Plugin text is data (D11.5): one line, no control characters, at most `max` characters. */
export function oneLine(text: unknown, max: number): string {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The listing read: plugins by id with their older versions, every version by hash, presets, the author. */
export async function readLibrary(listing: LibraryListing): Promise<PluginLibrary> {
  const plugins = new Map<string, LibraryPlugin>();
  const bySha = new Map<string, PluginFileInfo>();
  const older = new Map<string, number[]>();
  for (const { name, text } of listing.files) {
    const m = /^([a-z0-9-]+?)(?:\.v(\d+))?\.rs$/.exec(name);
    if (!m || !isSlug(m[1]!)) continue;
    const file = readPluginFile(text);
    if (!file || file.plugin !== m[1]) continue;
    const sha = await bodySha256(file.body);
    if (m[2]) {
      older.set(m[1]!, [...(older.get(m[1]!) ?? []), Number(m[2])]);
      if (!bySha.has(sha)) bySha.set(sha, file);
      continue;
    }
    plugins.set(file.plugin, { file, sha256: sha, intact: sha === file.headerSha, older: [] });
    bySha.set(sha, file);
  }
  for (const [id, versions] of older) {
    const row = plugins.get(id);
    if (row) plugins.set(id, { ...row, older: versions.sort((a, b) => a - b) });
  }
  const presets = new Map<string, Preset[]>();
  for (const { plugin, text } of listing.presets) presets.set(plugin, readPresets(text));
  return { dir: listing.dir, plugins, bySha, presets, author: readAuthor(listing.settings) };
}

/** `{ "<name>": {params, created} }`, as `mcp/nuggets.ts` writes it; a damaged file is no presets. */
export function readPresets(text: string): Preset[] {
  try {
    const rows = JSON.parse(text) as Record<string, { params?: unknown }>;
    if (!rows || typeof rows !== "object") return [];
    return Object.entries(rows).flatMap(([name, row]) => {
      if (!row || typeof row.params !== "object" || row.params === null) return [];
      const params = Object.fromEntries(Object.entries(row.params as Record<string, unknown>).filter(([, v]) => typeof v === "number" || typeof v === "boolean" || typeof v === "string")) as Preset["params"];
      return [{ name, params }];
    });
  } catch {
    return [];
  }
}

/** The presets file with `preset` in it, replacing one of the same name. */
export function presetsText(existing: string | null, preset: Preset, created: string): string {
  let rows: Record<string, unknown> = {};
  try {
    const parsed = existing ? (JSON.parse(existing) as unknown) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows = parsed as Record<string, unknown>;
  } catch {
    rows = {};
  }
  rows[preset.name] = { params: preset.params, created };
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/** The library's `settings.json`: `{ "author": "…" }`. The MCP server reads the same file for a plugin's author. */
export function readAuthor(settings: string | null): string {
  if (!settings) return "";
  try {
    const parsed = JSON.parse(settings) as { author?: unknown };
    return oneLine(parsed?.author, AUTHOR_MAX);
  } catch {
    return "";
  }
}

export function settingsText(existing: string | null, author: string): string {
  let rows: Record<string, unknown> = {};
  try {
    const parsed = existing ? (JSON.parse(existing) as unknown) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows = parsed as Record<string, unknown>;
  } catch {
    rows = {};
  }
  const name = oneLine(author, AUTHOR_MAX);
  if (name) rows.author = name;
  else delete rows.author;
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/**
 * The id and version a save takes (the MCP's rule, `pluginSave`): the title's slug; the same body keeps its version;
 * another body is the next version when the run was of that plugin (`ranAs` is its id), else the clash is kept beside
 * it as `<id>-2`, `<id>-3`, …
 */
export function savePlan(library: PluginLibrary, title: string, sha256: string, ranAs?: string): { id: string; version: number; same: boolean } {
  let id = slugOf(title) || slugOf(ranAs ?? "") || "plugin";
  const existing = library.plugins.get(id);
  if (!existing) return { id, version: 1, same: false };
  if (existing.sha256 === sha256) return { id, version: existing.file.version, same: true };
  if (ranAs !== undefined && ranAs === id) return { id, version: existing.file.version + 1, same: false };
  for (let n = 2; ; n += 1) {
    const candidate = `${id.slice(0, 45).replace(/-+$/, "")}-${n}`;
    const there = library.plugins.get(candidate);
    if (!there) return { id: (id = candidate), version: 1, same: false };
    if (there.sha256 === sha256) return { id: candidate, version: there.file.version, same: true };
  }
}

/** D9: a newer version of the stamp's plugin in the library, or null. Drafts (version 0) have none. */
export function newerInLibrary(stamp: PluginStamp, library: PluginLibrary): LibraryPlugin | null {
  if (stamp.version < 1) return null;
  const row = library.plugins.get(stamp.plugin);
  return row && row.file.version > stamp.version && row.sha256 !== stamp.sha256 ? row : null;
}

/**
 * D9's Use vN: the stamped values carried by name into the new version's parameters. A new parameter takes its
 * default (left out); a removed one is named.
 */
export function carriedValues(values: Record<string, number | boolean | string>, declared: readonly PluginParamInfo[]): { params: Record<string, number | boolean | string>; dropped: string[]; added: string[] } {
  const params: Record<string, number | boolean | string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (declared.some((p) => p.name === name)) params[name] = value;
    else dropped.push(name);
  }
  const added = declared.filter((p) => !(p.name in values)).map((p) => p.name);
  return { params, dropped, added };
}

/** "Studs and Edge are no longer in v4; they were dropped." for the readout, or "". */
export function droppedSentence(dropped: readonly string[], version: number): string {
  if (dropped.length === 0) return "";
  const names = dropped.length === 1 ? dropped[0]! : `${dropped.slice(0, -1).join(", ")} and ${dropped.at(-1)!}`;
  return `${names} ${dropped.length === 1 ? "is" : "are"} no longer in v${version}, so ${dropped.length === 1 ? "it was" : "they were"} dropped.`;
}

/**
 * D9: a project's plugin copies as saved. A stamp whose code the project lacks but the library holds (the current file
 * or an older `<id>.vN.rs`) gets the library's file, so the project rebuilds where the library is missing.
 */
export function projectCopies(plugins: Readonly<Record<string, string>> | undefined, stamps: Iterable<string>, library: PluginLibrary): Record<string, string> | undefined {
  let out = plugins ? { ...plugins } : undefined;
  for (const sha of stamps) {
    if (out?.[sha]) continue;
    const file = library.bySha.get(sha);
    if (file) out = { ...(out ?? {}), [sha]: file.text };
  }
  return out;
}

/** The body hashes of every plugin stamp in a project's saved objects. */
export function stampedShas(objects: unknown): string[] {
  const out = new Set<string>();
  if (!Array.isArray(objects)) return [];
  for (const obj of objects) {
    const nodes = (obj as { modelTree?: { nodes?: unknown } } | null)?.modelTree?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      const sha = (node as { plugin?: { sha256?: unknown; version?: unknown } } | null)?.plugin;
      if (sha && typeof sha.sha256 === "string" && typeof sha.version === "number" && sha.version > 0) out.add(sha.sha256);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// The panel's list.
// ---------------------------------------------------------------------------

export type PanelSection = "project" | "library" | "samples";

/** One plugin the panel lists. */
export interface PanelPlugin {
  /** `library:<id>` or `project:<sha>`: what the panel selects by. */
  key: string;
  section: PanelSection;
  file: PluginFileInfo;
  /** The body's hash: the code a run is stamped with. */
  sha256: string;
  /** Whether the row is the library's (a project copy of a plugin the library holds is listed once, there). */
  inLibrary: boolean;
  badges: string[];
  /** When it was last applied here, for the order; 0 when never. */
  usedAt: number;
}

/** The panel's rows: the project's plugins the library lacks, then the library, each sorted by last used, then title. */
export function panelPlugins(library: PluginLibrary, project: ReadonlyMap<string, PluginFileInfo>, usedAt: Readonly<Record<string, number>>): PanelPlugin[] {
  const rows: PanelPlugin[] = [];
  for (const [sha, file] of project) {
    // The library's own plugin, at any version, is listed once there: History's Use vN moves a step between versions.
    if (library.bySha.has(sha) || library.plugins.has(file.plugin)) continue;
    rows.push({ key: `project:${sha}`, section: "project", file, sha256: sha, inLibrary: false, badges: badgesOf(file), usedAt: usedAt[file.plugin] ?? 0 });
  }
  for (const [id, row] of library.plugins) {
    rows.push({ key: `library:${id}`, section: "library", file: row.file, sha256: row.sha256, inLibrary: true, badges: [...badgesOf(row.file), ...(row.intact ? [] : ["edited"])], usedAt: usedAt[id] ?? 0 });
  }
  const order: PanelSection[] = ["project", "library", "samples"];
  return rows.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || b.usedAt - a.usedAt || a.file.title.localeCompare(b.file.title));
}

function badgesOf(file: PluginFileInfo): string[] {
  return file.target === "object" ? ["needs a part"] : [];
}

/** How many words of `query` the plugin's id, title or description holds (`queryScore` in `mcp/plugins.ts`). */
export function searchScore(file: Pick<PluginFileInfo, "plugin" | "title" | "description">, query: string): number {
  const hay = `${file.plugin} ${file.title} ${file.description}`.toLowerCase();
  return query.toLowerCase().split(/[\s,]+/).filter((word) => word.length > 1).filter((word) => hay.includes(word)).length;
}

/** The rows a search keeps, best match first within each section; every row when the query has no word. */
export function searched(rows: readonly PanelPlugin[], query: string): PanelPlugin[] {
  const words = query.toLowerCase().split(/[\s,]+/).filter((word) => word.length > 1);
  if (words.length === 0) return [...rows];
  return rows.map((row, i) => ({ row, i, score: searchScore(row.file, query) })).filter((item) => item.score > 0).sort((a, b) => (a.row.section === b.row.section ? b.score - a.score || a.i - b.i : a.i - b.i)).map((item) => item.row);
}

export const SECTION_TITLE: Readonly<Record<PanelSection, string>> = { project: "In this project", library: "Your plugins", samples: "Samples" };

// ---------------------------------------------------------------------------
// The form's values.
// ---------------------------------------------------------------------------

export type FormValue = number | boolean | string;

/** A typed value read for the plugin: a number for number and count (null when it is not one), else as is. */
export function formNumber(param: PluginParamInfo, raw: FormValue): number | null {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim().replace(",", "."));
  if (String(raw).trim() === "" || !Number.isFinite(n)) return null;
  return param.kind === "count" && !Number.isInteger(n) ? null : n;
}

/** "1 to 10", "at least 2", or "". */
export function rangeText(param: Pick<PluginParamInfo, "min" | "max">): string {
  if (param.min !== undefined && param.max !== undefined) return `${param.min} to ${param.max}`;
  if (param.min !== undefined) return `at least ${param.min}`;
  if (param.max !== undefined) return `at most ${param.max}`;
  return "";
}

export function paramLabel(param: PluginParamInfo): string {
  return param.label?.trim() || param.name;
}

/** The first value that cannot be built, said in one sentence that names the fix; null when they all can. */
export function formProblem(params: readonly PluginParamInfo[], values: Readonly<Record<string, FormValue>>): string | null {
  for (const param of params) {
    if (!(param.name in values) || (param.kind !== "number" && param.kind !== "count")) continue;
    const n = formNumber(param, values[param.name]!);
    const label = paramLabel(param);
    if (n === null) return param.kind === "count" ? `${label} is a whole number. Type one, for example ${param.default}.` : `${label} is a number. Type one, for example ${param.default}.`;
    const range = rangeText(param);
    if ((param.min !== undefined && n < param.min) || (param.max !== undefined && n > param.max)) return `${label} is ${range}${param.unit ? ` ${param.unit}` : ""}. Type a value in that range.`;
  }
  return null;
}

/** The values a run is given: those that differ from the declared defaults, as the plugin takes them. */
export function formParams(params: readonly PluginParamInfo[], values: Readonly<Record<string, FormValue>>): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const param of params) {
    if (!(param.name in values)) continue;
    const raw = values[param.name]!;
    const value = param.kind === "number" || param.kind === "count" ? formNumber(param, raw) : raw;
    if (value === null || value === param.default) continue;
    out[param.name] = value;
  }
  return out;
}

/** A preset's values that this version still declares and allows, and the names it had to leave out. */
export function presetValues(preset: Preset, params: readonly PluginParamInfo[]): { values: Record<string, FormValue>; skipped: string[] } {
  const values: Record<string, FormValue> = {};
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(preset.params)) {
    const param = params.find((p) => p.name === name);
    const fits = !!param && (param.kind === "number" || param.kind === "count"
      ? typeof value === "number" && formProblem([param], { [name]: value }) === null
      : param.kind === "toggle" ? typeof value === "boolean" : param.kind === "choice" ? typeof value === "string" && (param.options ?? []).includes(value) : typeof value === "string");
    if (fits) values[name] = value;
    else skipped.push(name);
  }
  return { values, skipped };
}

// ---------------------------------------------------------------------------
// The shell's commands.
// ---------------------------------------------------------------------------

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** What the panel asks of the folder. Writes name files the shell allows: `<id>.rs`, `presets/<id>.json`, `settings.json`. */
export interface LibraryIo {
  list(): Promise<LibraryListing>;
  /** Writes `<id>.rs`, keeping a different version there as `<id>.v<N>.rs` (at most five). The path written. */
  save(id: string, text: string): Promise<string>;
  writePresets(id: string, text: string): Promise<void>;
  writeSettings(text: string): Promise<void>;
  /** Removes `<id>.rs` and its older versions; the number of files removed. */
  remove(id: string): Promise<number>;
  /** Shows the plugin's file, or the folder, in the system's file manager. */
  reveal(id: string | null): Promise<void>;
}

let tauriInvoke: Promise<Invoke | null> | null = null;

function hookInvoke(): Invoke | null {
  const g = globalThis as { __limePluginLibrary?: { invoke: Invoke }; __limeRecipeRunner?: { invoke: Invoke } };
  return g.__limePluginLibrary?.invoke ?? g.__limeRecipeRunner?.invoke ?? null;
}

async function invoker(): Promise<Invoke | null> {
  const hook = hookInvoke();
  if (hook) return hook;
  if (typeof window === "undefined" || !isTauri()) return null;
  tauriInvoke ??= import("@tauri-apps/api/core").then((m) => m.invoke as Invoke).catch(() => null);
  return tauriInvoke;
}

/** The library's commands, or null where there is no desktop shell (the browser build). */
export async function libraryIo(): Promise<LibraryIo | null> {
  const invoke = await invoker();
  if (!invoke) return null;
  return {
    list: () => invoke<LibraryListing>("plugin_library_list"),
    save: (id, text) => invoke<string>("plugin_library_save", { id, text }),
    writePresets: (id, text) => invoke<void>("plugin_library_write", { name: `presets/${id}.json`, text }),
    writeSettings: (text) => invoke<void>("plugin_library_write", { name: "settings.json", text }),
    remove: (id) => invoke<number>("plugin_library_remove", { id }),
    reveal: (id) => invoke<void>("plugin_library_reveal", { id }),
  };
}

export const LIBRARY_NEEDS_APP = "Your plugin library is read by the desktop app. Here the panel lists the plugins this project carries.";
