/**
 * --- Sharing in the app (docs/plan-recipe-plugins.md D10, D11.6, milestone 8): export a plugin as one file, import one
 * (Import…, a file dropped on the window, a project's copy), and the first-run view before an imported plugin runs.
 *
 * Nothing imported runs before a person has seen its code: import checks the file without running it
 * (`src/plugins/share.ts`), adds it marked "imported" (`imported.json` in the library), and its first Preview, Apply or
 * Rebuild opens the first-run view. A project's plugin the library lacks is approved the same way, once, by its hash.
 */
import { bodySha256, readPluginFile, type PluginFileInfo } from "../plugin-file";
import { RECIPE_API } from "../plugin-step";
import { isTauri } from "../platform";
import { libraryIo, LIBRARY_NEEDS_APP, presetValues, type PluginLibrary } from "../plugins/library";
import { carriedIngredients } from "../recipe/ingredients";
import {
  checkImport,
  clashOf,
  exportName,
  exportText,
  isPluginFileName,
  keptBesideTitle,
  lessonsFor,
  marksText,
  mergeLessons,
  mergePresets,
  readMarks,
  renamed,
  replacedVersion,
  withMark,
  type ImportFile,
  type SharedPreset,
} from "../plugins/share";
import { showTrust } from "./plugin-trust";
import { prefs } from "../prefs.ts";

/** What the import flow needs of the Plugins panel: the library read again, and the panel opened on a plugin. */
export interface ShareHost {
  reload(): Promise<PluginLibrary>;
  library(): PluginLibrary;
  show(id: string): void;
}

let host: ShareHost | null = null;

export function mountPluginShare(next: ShareHost) {
  host = next;
}

const APPROVED_KEY = "lime-slice-plugins-approved";
const APPROVED_MAX = 200;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The project plugins (by hash) a person approved to run here, kept in this browser. */
function approved(): string[] {
  try {
    const rows = prefs.getJson(APPROVED_KEY);
    return Array.isArray(rows) ? rows.filter((row): row is string => typeof row === "string") : [];
  } catch {
    return [];
  }
}

function approve(sha256: string) {
  try {
    prefs.setJson(APPROVED_KEY, [...approved().filter((row) => row !== sha256), sha256].slice(-APPROVED_MAX));
  } catch {
    // It asks again next time.
  }
}

// ---------------------------------------------------------------------------
// Export.
// ---------------------------------------------------------------------------

/**
 * One file to send: the plugin with its presets and the lessons about it. Saved through the desktop's save dialog, or
 * downloaded in the browser. The readout sentence, or null when the dialog was cancelled.
 */
export async function exportPluginFile(file: PluginFileInfo, inLibrary: boolean): Promise<string | null> {
  const library = host?.library();
  const presets: Record<string, SharedPreset> = {};
  let lessons: { about: string; text: string; created: string }[] = [];
  if (inLibrary && library) {
    const io = await libraryIo();
    const listing = io ? await io.list().catch(() => null) : null;
    const raw = listing?.presets.find((row) => row.plugin === file.plugin)?.text;
    try {
      const rows = raw ? (JSON.parse(raw) as Record<string, { params?: unknown; created?: unknown }>) : {};
      for (const preset of library.presets.get(file.plugin) ?? []) presets[preset.name] = { params: preset.params, created: String(rows[preset.name]?.created ?? "").slice(0, 32) };
    } catch {
      for (const preset of library.presets.get(file.plugin) ?? []) presets[preset.name] = { params: preset.params, created: "" };
    }
    lessons = lessonsFor(file.plugin, carriedIngredients(file.body).map((row) => row.id), library.lessons).map(({ about, text, created }) => ({ about, text, created }));
  }
  const text = exportText(file.text, presets, lessons);
  const name = exportName(file.plugin, file.version);
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const saved = await invoke<boolean>("save_text_file", { text, defaultName: name, extension: "rs" });
    if (!saved) return null;
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/x-rust" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const extras = [Object.keys(presets).length ? `${Object.keys(presets).length} preset${Object.keys(presets).length === 1 ? "" : "s"}` : "", lessons.length ? `${lessons.length} lesson${lessons.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
  return `Exported “${file.title}” v${file.version} as ${name}${extras ? `, with ${extras}` : ""}. Whoever gets it imports it in their Plugins panel.`;
}

// ---------------------------------------------------------------------------
// Import.
// ---------------------------------------------------------------------------

/** The file checked, with its code's hash; or the sentence that says why it is not imported. */
export async function readImport(text: string): Promise<ImportFile | { reason: string }> {
  const checked = checkImport(text, RECIPE_API);
  if ("reason" in checked) return checked;
  return { ...checked, sha256: await bodySha256(checked.body) };
}

/**
 * Imports one plugin file: checked, shown (who made it, its hash, what it carries, its code, the clash choice), then
 * added marked imported. The readout sentence.
 */
export async function importPluginText(text: string, from: "file" | "project", fromLabel: string): Promise<string> {
  const io = await libraryIo();
  if (!io || !host) return LIBRARY_NEEDS_APP.replace("Here the panel lists the plugins this project carries.", "Import plugins there.");
  const file = await readImport(text);
  if ("reason" in file) return file.reason;
  const library = await host.reload();
  const clash = clashOf(file.id, file.sha256, file.version, (id) => {
    const row = library.plugins.get(id);
    return row ? { sha256: row.sha256, version: row.file.version } : null;
  });
  if (clash.kind === "same") {
    const extras = await keepExtras(file.id, file);
    await host.reload();
    host.show(file.id);
    return `“${file.title}” v${clash.version} is already in your library with this code.${extras}`;
  }
  const choice = await showTrust({ mode: "import", from: fromLabel, file, ...(clash.kind === "clash" ? { clash } : {}) });
  if (!choice || choice === "run") return `Nothing was imported.`;
  let id = file.id;
  let written = file.libraryText;
  if (choice === "keep-both" && clash.kind === "clash") {
    id = clash.keepBoth;
    written = renamed(written, id, keptBesideTitle(file.title, id));
  } else if (choice === "replace" && clash.kind === "clash") {
    written = replacedVersion(written, clash.version);
  }
  try {
    await io.save(id, written);
    const extras = await keepExtras(id, file);
    const listing = await io.list();
    await io.writeImported(marksText(withMark(readMarks(listing.imported), id, { sha256: file.sha256, from, at: today() })));
    await host.reload();
    host.show(id);
    const kept = readPluginFile(written);
    const as = id !== file.id ? ` as ${id}` : "";
    return `Added “${kept?.title ?? file.title}” v${kept?.version ?? file.version}${as} to your plugins, marked imported until its first run.${extras}`;
  } catch (err) {
    return `The plugin could not be imported: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** The presets and lessons a file brought, kept beside its plugin: " 2 presets and 1 lesson came with it." or "". */
async function keepExtras(id: string, file: ImportFile): Promise<string> {
  const io = await libraryIo();
  if (!io) return "";
  const listing = await io.list();
  const parsed = readPluginFile(file.libraryText);
  let presetNote = "";
  let presetCount = 0;
  if (Object.keys(file.presets).length && parsed) {
    const fitting: Record<string, SharedPreset> = {};
    const skipped: string[] = [];
    for (const [name, preset] of Object.entries(file.presets)) {
      const { skipped: off } = presetValues({ name, params: preset.params }, parsed.params);
      if (off.length) skipped.push(name);
      else fitting[name] = preset;
    }
    const merged = mergePresets(listing.presets.find((row) => row.plugin === id)?.text ?? null, fitting);
    if (merged.added.length) await io.writePresets(id, merged.text);
    presetCount = merged.added.length;
    if (skipped.length) presetNote = ` The preset${skipped.length === 1 ? "" : "s"} ${skipped.join(", ")} did not fit its values and ${skipped.length === 1 ? "was" : "were"} left out.`;
  }
  let lessonCount = 0;
  if (file.lessons.length) {
    const merged = mergeLessons(listing.lessons ?? null, file.lessons);
    if (merged.added) await io.writeLessons(merged.text);
    lessonCount = merged.added;
  }
  const parts = [presetCount ? `${presetCount} preset${presetCount === 1 ? "" : "s"}` : "", lessonCount ? `${lessonCount} lesson${lessonCount === 1 ? "" : "s"}` : ""].filter(Boolean);
  return `${parts.length ? ` ${parts.join(" and ")} came with it.` : ""}${presetNote}`;
}

/** Files picked or dropped: each `.rs` imported in turn. The readout sentences, joined. */
export async function importPluginFiles(files: readonly File[]): Promise<string> {
  const out: string[] = [];
  for (const file of files) {
    if (!isPluginFileName(file.name)) continue;
    if (file.size > 16 * 1024 * 1024) {
      out.push(`${file.name} is larger than 16 MB, so it is not a plugin this app imports.`);
      continue;
    }
    out.push(await importPluginText(await file.text(), "file", `the file ${file.name}`));
  }
  return out.join(" ");
}

/** The panel's Import…: a file picker for `.rs` files. */
export function pickPluginFiles(done: (text: string) => void) {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: ".rs", multiple: true });
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    if (files.length) void importPluginFiles(files).then(done);
  });
  input.click();
}

// ---------------------------------------------------------------------------
// The first run.
// ---------------------------------------------------------------------------

/**
 * Whether this code must be shown before it runs: a library plugin marked imported (with this code), or a project's
 * plugin the library does not hold and nobody approved here. A draft (version 0) and the library's own are not asked.
 */
export function needsFirstRun(file: Pick<PluginFileInfo, "plugin" | "version">, sha256: string, library: PluginLibrary): boolean {
  const mark = library.imported[file.plugin];
  if (mark) return mark.sha256 === sha256 || library.plugins.get(file.plugin)?.sha256 === sha256;
  // Where no library was read (the browser build), nothing tells another's plugin from one's own: plugins run only in
  // the desktop app, which always reads it.
  if (!library.dir || file.version < 1 || library.bySha.has(sha256)) return false;
  return !approved().includes(sha256);
}

/** Shows the first-run view; true when the person pressed Run (the mark is then cleared, or the hash approved). */
export async function approveFirstRun(file: PluginFileInfo, sha256: string, fromLabel?: string, libraryOverride?: PluginLibrary): Promise<boolean> {
  const library = libraryOverride ?? host?.library();
  const mark = library?.imported[file.plugin];
  const from = fromLabel ?? (mark?.from === "project" ? "a project" : mark?.from === "mcp" ? "an MCP call" : mark ? "a file" : "this project");
  const parsed = checkImport(file.text, RECIPE_API);
  const view = "reason" in parsed
    ? { id: file.plugin, title: file.title, version: file.version, description: file.description, author: file.author, madeBy: file.madeBy, api: file.api, sha256, headerSha: file.headerSha, ingredients: [], data: [], presets: {}, lessons: [], body: file.body }
    : { ...parsed, sha256 };
  const choice = await showTrust({ mode: "first-run", from, file: view });
  if (choice !== "run") return false;
  if (mark) {
    const io = await libraryIo();
    if (io) {
      try {
        const listing = await io.list();
        await io.writeImported(marksText(withMark(readMarks(listing.imported), file.plugin, null)));
        await host?.reload();
      } catch {
        approve(sha256);
      }
    }
  } else approve(sha256);
  return true;
}

/**
 * A project just opened carries plugins the library lacks: say so once, never adding them by itself. `review` opens the
 * Plugins panel on them. The sentence, or null when there are none.
 */
export async function projectPluginsOffer(plugins: Readonly<Record<string, string>> | undefined, library: PluginLibrary): Promise<{ text: string; count: number } | null> {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const [sha, text] of Object.entries(plugins ?? {})) {
    const file = readPluginFile(text);
    if (!file || seen.has(file.plugin) || library.bySha.has(sha) || library.plugins.has(file.plugin)) continue;
    if ((await bodySha256(file.body)) !== sha) continue;
    seen.add(file.plugin);
    names.push(file.title);
  }
  if (names.length === 0) return null;
  const list = names.length <= 3 ? names.map((n) => `“${n}”`).join(", ") : `${names.slice(0, 2).map((n) => `“${n}”`).join(", ")} and ${names.length - 2} more`;
  return { count: names.length, text: `This project carries ${names.length === 1 ? "a plugin" : `${names.length} plugins`} your library does not have: ${list}. Review shows ${names.length === 1 ? "it" : "them"}; nothing is added unless you add it.` };
}
