/**
 * --- The Plugins panel (docs/plan-recipe-plugins.md D13, D15, milestone 7). A card in the Model dock, opened from the
 * Features menu ("Plugins…") or Ctrl+Alt+L, the way Split to print opens: no rail button of its own.
 *
 * The list: a search field, then "In this project" (plugins the project carries that the library lacks) and "Your
 * plugins" (the library, read from the folder the MCP server writes), each row its title, one line of description,
 * version, author and badges, sorted by last used. A plugin opens its form (D5): each declared value with its range,
 * unit and help, its presets, the line that says what it builds on, **Preview** (with **Live**) and **Apply** in the
 * card's foot. Its menu has View source, Reveal in folder, and Add to library or Remove from library.
 *
 * The card follows the sketch card's style (`docs/plan-sketch-for-people.md` P1–P3): every button has a purpose tip, a
 * greyed one adds its reason on a second line, every reason names the next action, and the How (?) opens with Show me,
 * which opens a demo plugin ready for its next click.
 *
 * The panel decides nothing about the solid: `app/model.ts` runs the plugin (`PluginsHost.run`), shows a preview and
 * takes it back, and applies it as one History row.
 */
import { closeModelCard, modelCardOpen, openModelCard } from "./model-chrome";
import { pushToast } from "./toasts";
import { askSheet, confirmSheet } from "./ask-sheet";
import { blockedTip } from "../sketch/reasons";
import type { PluginFileInfo, PluginParamInfo } from "../plugin-file";
import { dataSize, elideData } from "../recipe/plugin-data";
import {
  EMPTY_LIBRARY,
  KIND_TITLE,
  LIBRARY_NEEDS_APP,
  SECTION_TITLE,
  ingredientUse,
  ingredientUsers,
  lessonsWithout,
  pluginData,
  pluginIngredients,
  presetParams,
  presetNameProblem,
  presetProblem,
  presetsText,
  presetsWithout,
  searchedIngredients,
  searchedLessons,
  searchedPresets,
  formNumber,
  formParams,
  formProblem,
  libraryIo,
  panelPlugins,
  paramLabel,
  presetValues,
  rangeText,
  readLibrary,
  searched,
  settingsText,
  type FormValue,
  type LibraryIngredient,
  type LibraryListing,
  type NuggetKind,
  type PanelPlugin,
  type PanelSection,
  type PluginLibrary,
} from "../plugins/library";
import { DEMO_PLUGIN, DEMO_TRY } from "../plugins/demo";
import { RECIPE_API } from "../plugin-step";
import { KIND_PURPOSE, PURPOSE, REASON } from "./plugins-panel-text";
import { setLessons } from "./lessons-note";
import { pickField, sketchValue, type SketchChoice } from "./pick-field";
import type { PickedFaceValue } from "../recipe/picks";
import { approveFirstRun, exportPluginFile, importPluginText, mountPluginShare, needsFirstRun, pickPluginFiles } from "./plugin-import";
import { prefs } from "../prefs.ts";

const CARD_ID = "plugins";
const KIND_NOUN: Readonly<Record<Exclude<NuggetKind, "all">, string>> = { plugin: "plugin", ingredient: "ingredient", preset: "preset", lesson: "lesson" };
/** What an empty kind says, with where its nuggets come from. */
const EMPTY_KIND: Readonly<Record<Exclude<NuggetKind, "all">, string>> = {
  plugin: "No plugins yet. Keep a recipe from a chat with keep {title, description}, or use Save as plugin… on a recipe's step in History.",
  ingredient: "No ingredients yet. An agent keeps a recipe's helpers as one with nugget {action: \"save\", kind: \"ingredient\", from, items}; the recipe_run reply offers the call.",
  preset: "No presets yet. Open a plugin, set its values, and press Save as preset….",
  lesson: "No lessons yet. An agent keeps one when a run got past a refusal; the recipe_run reply offers the call.",
};
export const PLUGINS_TITLE = "Plugins";
const USED_KEY = "lime-slice-plugins-used";
const LIVE_KEY = "lime-slice-plugins-live";
/** A field change previews again this long after the last one, while the last run took under LIVE_MAX_MS (D13). */
const LIVE_WAIT_MS = 300;
const LIVE_MAX_MS = 1000;

export interface PluginsHost {
  /** The plugins this project carries, by body hash. */
  project(): ReadonlyMap<string, PluginFileInfo>;
  /** The name of the part on screen that a plugin would change, or null when none is open. */
  partName(): string | null;
  /** Null when plugins run here, else the sentence that says why not (macOS, no lust, the browser build). */
  runner(): Promise<string | null>;
  /**
   * Run `plugin` with `params` (the values that differ from its defaults). A preview shows the result and takes it
   * back; an apply keeps it as one History row. `demo` runs never reach the part.
   */
  run(plugin: PanelPlugin, params: Record<string, FormValue>, mode: "preview" | "apply"): Promise<PluginRunResult>;
  /** Take a shown preview off the screen. */
  clearPreview(): void;
  readout(text: string): void;
  /** The library was read again: History's rows follow (Use vN, a copy found in the library). */
  libraryChanged(library: PluginLibrary): void;
  /** --- API 1.2. The sketches on the plate a person may pick as an outline. */
  sketches?(): SketchChoice[];
  /**
   * Wait for a click on a flat face of the part on screen, highlighted as it is picked; `done` gets it with its part, or
   * null when the pick is cancelled. The sentence that says why it cannot start, or null.
   */
  pickFace?(done: (picked: { object: string; face: PickedFaceValue } | null) => void): string | null;
  cancelPick?(): void;
}

export type PluginRunResult = { ok: true; ms: number; text: string } | { ok: false; reason: string; line?: number };

let host: PluginsHost | null = null;
let library: PluginLibrary = EMPTY_LIBRARY;
/** Null once the library was read; else why it could not be (the browser build) or "loading". */
let libraryNote: string | null = "loading";
let runnerNote: string | null | undefined;
let query = "";
/** Which nuggets the list shows (I16): every kind, or one. */
let kind: NuggetKind = "all";
const KIND_KEY = "lime-slice-plugins-kind";
let selected: string | null = null;
let demo = false;
const values = new Map<string, FormValue>();
let preset = "";
let busy = false;
/** How long the last run took; 0 before the first, so Live tries once and then follows the measure. */
let lastMs = 0;
let liveTimer: ReturnType<typeof setTimeout> | null = null;
let status: { text: string; problem: boolean } | null = null;
let howOpen = false;
let menuOpen = false;
/** The values the preview on screen was built from, so Apply says whether it matches. */
let previewed: string | null = null;
/** --- API 1.2. The face or outline field that waits for a face click in the view. */
let picking: string | null = null;

function stopPicking() {
  if (picking === null) return;
  picking = null;
  host?.cancelPick?.();
}

const root = () => document.querySelector<HTMLElement>("#modelPlugins");
const $ = <T extends HTMLElement>(selector: string) => root()?.querySelector<T>(selector) ?? null;

export function mountPluginsPanel(next: PluginsHost) {
  host = next;
  try {
    const saved = prefs.get(KIND_KEY);
    if (saved === "all" || saved === "plugin" || saved === "ingredient" || saved === "preset" || saved === "lesson") kind = saved;
  } catch {
    // Every kind is shown.
  }
  document.addEventListener("click", (ev) => {
    if (ev.target instanceof Element && ev.target.closest("#modelMenuPlugins")) openPluginsPanel();
  });
  const body = root();
  if (!body) return;
  body.addEventListener("click", onClick);
  body.addEventListener("input", onInput);
  body.addEventListener("change", onChange);
  body.addEventListener("keydown", onKeyDown);
  mountPluginShare({ reload: loadLibrary, library: () => library, show: showImported });
  void loadLibrary();
}

/** An import landed: the panel opens on it (in Model), so its imported badge and code are one look away. */
function showImported(id: string) {
  if (!pluginsPanelOpen()) return;
  kind = kind === "all" || kind === "plugin" ? kind : "all";
  select(`library:${id}`);
}

/** The result of an import or export, said in the card's readout and as a toast (a drop may land outside Model). */
function said(text: string | null) {
  if (!text) return;
  host?.readout(text);
  pushToast(text, /not imported|could not|is not a plugin|not a plugin file|is an ingredient|larger than/.test(text) ? "error" : "info");
}

/** The library as last read, for History and the project's save. */
export function pluginLibrary(): PluginLibrary {
  return library;
}

/** Read the folder again; the panel and History follow. */
export async function loadLibrary(): Promise<PluginLibrary> {
  const io = await libraryIo();
  if (!io) {
    libraryNote = LIBRARY_NEEDS_APP;
    library = EMPTY_LIBRARY;
  } else {
    try {
      library = await readLibrary(await io.list());
      libraryNote = null;
    } catch (err) {
      library = EMPTY_LIBRARY;
      libraryNote = `Your plugin library could not be read: ${err instanceof Error ? err.message : String(err)} Open the panel again to retry.`;
    }
  }
  syncAuthorField();
  setLessons(library.lessons);
  host?.libraryChanged(library);
  if (pluginsPanelOpen()) paint();
  return library;
}

export function pluginsPanelOpen(): boolean {
  return modelCardOpen() === CARD_ID;
}

/** Features menu → Plugins…, or Ctrl+Alt+L: the card opens on the list, or closes when it is open. */
export function togglePluginsPanel() {
  if (pluginsPanelOpen()) closeModelCard();
  else openPluginsPanel();
}

export function openPluginsPanel() {
  if (!host) return;
  if (!pluginsPanelOpen()) {
    root()?.toggleAttribute("hidden", false);
    openModelCard({ id: CARD_ID, title: PLUGINS_TITLE, ghost: () => null, handles: () => [], drag: () => undefined, closed });
  }
  status = null;
  if (runnerNote === undefined) {
    void host.runner().then((why) => {
      runnerNote = why;
      paint();
    });
  }
  void loadLibrary();
  paint();
  $<HTMLInputElement>("#modelPluginsSearch")?.focus({ preventScroll: true });
}

function closed() {
  stopPicking();
  stopLive();
  host?.clearPreview();
  previewed = null;
  root()?.toggleAttribute("hidden", true);
  const apply = document.querySelector<HTMLButtonElement>("#modelApply");
  if (apply) {
    apply.textContent = "Apply";
    delete apply.dataset.tipIdle;
    delete apply.dataset.reason;
  }
  selected = null;
  demo = false;
  values.clear();
  preset = "";
  menuOpen = false;
  howOpen = false;
}

// ---------------------------------------------------------------------------
// What the card shows.
// ---------------------------------------------------------------------------

function rows(): PanelPlugin[] {
  return host ? panelPlugins(library, host.project(), usedAt()) : [];
}

function current(): PanelPlugin | null {
  if (demo) return DEMO_PLUGIN;
  return rows().find((row) => row.key === selected) ?? null;
}

/** The ingredient open in the card, when one is. */
function currentIngredient(): LibraryIngredient | null {
  return selected?.startsWith("ingredient:") ? library.ingredients.get(selected.slice("ingredient:".length)) ?? null : null;
}

function paint() {
  const body = root();
  if (!body || !pluginsPanelOpen()) return;
  const ingredient = currentIngredient();
  const plugin = ingredient ? null : current();
  if (selected && !plugin && !ingredient) selected = null;
  body.replaceChildren(ingredient ? ingredientDetail(ingredient) : plugin ? detail(plugin) : list());
  paintFoot();
}

function shownKind(): NuggetKind {
  return kind;
}

function setKind(next: NuggetKind) {
  kind = next;
  try {
    prefs.set(KIND_KEY, next);
  } catch {
    // The filter still holds for this visit.
  }
}

/** All · Plugins · Ingredients · Presets · Lessons, each with its count. */
function kindChips(counts: Record<Exclude<NuggetKind, "all">, number>): HTMLElement {
  const bar = el("div", "pp-kinds");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Show");
  const chip = (k: NuggetKind, label: string, n?: number) => {
    const b = button("pp-kind", n === undefined ? label : `${label} ${n}`, KIND_PURPOSE[k]);
    b.dataset.kind = k;
    b.setAttribute("aria-pressed", kind === k ? "true" : "false");
    bar.append(b);
  };
  chip("all", "All");
  for (const k of ["plugin", "ingredient", "preset", "lesson"] as const) chip(k, KIND_TITLE[k], counts[k]);
  return bar;
}

function section(title: string, label: string): { group: HTMLElement; ul: HTMLElement } {
  const group = el("section", "pp-section");
  group.setAttribute("aria-label", label);
  group.append(Object.assign(el("h4", "pp-section-title"), { textContent: title }));
  const ul = el("ul", "pp-rows");
  ul.setAttribute("role", "list");
  group.append(ul);
  return { group, ul };
}

function ingredientRow(row: LibraryIngredient): HTMLElement {
  const li = el("li", "pp-row");
  const pick = el("button", "pp-pick-ingredient pp-nugget-pick") as HTMLButtonElement;
  pick.type = "button";
  pick.dataset.ingredient = row.id;
  pick.dataset.tip = row.description || row.title;
  const top = el("span", "pp-row-top");
  top.append(Object.assign(el("span", "pp-title"), { textContent: row.title }), Object.assign(el("span", "pp-version"), { textContent: `v${row.version}` }), Object.assign(el("span", "pp-badge"), { textContent: "ingredient" }));
  const desc = Object.assign(el("span", "pp-desc"), { textContent: row.description || "No description." });
  const gives = Object.assign(el("span", "pp-by"), { textContent: row.items.length ? `Gives ${row.items.slice(0, 4).map((i) => i.name).join(", ")}${row.items.length > 4 ? `, and ${row.items.length - 4} more` : ""}` : "Gives nothing public yet" });
  pick.append(top, desc, gives);
  li.append(pick);
  return li;
}

function presetRow(item: { plugin: string; title: string; preset: { name: string; params: Record<string, unknown> } }): HTMLElement {
  const li = el("li", "pp-row");
  const pick = el("button", "pp-pick-preset pp-nugget-pick") as HTMLButtonElement;
  pick.type = "button";
  pick.dataset.key = `library:${item.plugin}`;
  pick.dataset.preset = item.preset.name;
  pick.dataset.tip = PURPOSE.openPreset;
  const top = el("span", "pp-row-top");
  top.append(Object.assign(el("span", "pp-title"), { textContent: item.preset.name }), Object.assign(el("span", "pp-badge"), { textContent: "preset" }));
  const values = Object.entries(item.preset.params).slice(0, 4).map(([k, v]) => `${k} ${String(v)}`).join(" · ");
  const desc = Object.assign(el("span", "pp-desc"), { textContent: `For ${item.title}${values ? `: ${values}` : ""}` });
  pick.append(top, desc);
  li.append(pick);
  return li;
}

function lessonRow(lesson: { n: number; about: string; text: string }): HTMLElement {
  const li = el("li", "pp-row pp-lesson");
  const about = Object.assign(el("span", "pp-badge pp-about"), { textContent: lesson.about });
  const text = Object.assign(el("span", "pp-lesson-text"), { textContent: lesson.text });
  const remove = button("pp-lesson-remove", "×", PURPOSE.removeLesson);
  remove.dataset.lesson = String(lesson.n);
  remove.setAttribute("aria-label", `Remove the lesson about ${lesson.about}`);
  const noLibrary = libraryNote && libraryNote !== "loading" ? "Lessons are kept by the desktop app. Open this project there." : "";
  if (noLibrary) {
    remove.setAttribute("aria-disabled", "true");
    remove.dataset.reason = noLibrary;
    remove.dataset.tip = blockedTip(PURPOSE.removeLesson, noLibrary);
  }
  li.append(about, text, remove);
  return li;
}

function list(): HTMLElement {
  const wrap = el("div", "pp-list-view");
  const head = el("div", "pp-head");
  const search = Object.assign(document.createElement("input"), { type: "search", id: "modelPluginsSearch", className: "pp-search", value: query, placeholder: "Search plugins, ingredients, presets, lessons", spellcheck: false });
  search.setAttribute("aria-label", "Search plugins, ingredients, presets and lessons");
  search.dataset.tip = PURPOSE.search;
  search.dataset.ownEnter = "";
  const importButton = button("pp-import", "Import…", PURPOSE.importFile);
  importButton.id = "modelPluginsImport";
  head.append(search, importButton, howButton());
  wrap.append(head);
  if (howOpen) wrap.append(howPop());
  if (libraryNote && libraryNote !== "loading") wrap.append(note(libraryNote, "pp-library-note"));
  const all = rows();
  const shown = searched(all, query);
  const ingredients = searchedIngredients(library, query);
  const presets = searchedPresets(library, query);
  const lessons = searchedLessons(library, query);
  wrap.append(kindChips({ plugin: shown.length, ingredient: ingredients.length, preset: presets.length, lesson: lessons.length }));
  const k = shownKind();
  let any = false;
  if (k === "all" || k === "plugin") {
    const sections: PanelSection[] = ["project", "library", "samples"];
    for (const sec of sections) {
      const items = shown.filter((row) => row.section === sec);
      if (items.length === 0) continue;
      any = true;
      const { group, ul } = section(SECTION_TITLE[sec], SECTION_TITLE[sec]);
      for (const row of items) ul.append(listRow(row));
      wrap.append(group);
    }
  }
  const more: [NuggetKind, number, () => HTMLElement][] = [
    ["ingredient", ingredients.length, () => {
      const { group, ul } = section(KIND_TITLE.ingredient, KIND_TITLE.ingredient);
      for (const row of ingredients) ul.append(ingredientRow(row));
      return group;
    }],
    ["preset", presets.length, () => {
      const { group, ul } = section(KIND_TITLE.preset, KIND_TITLE.preset);
      for (const item of presets) ul.append(presetRow(item));
      return group;
    }],
    ["lesson", lessons.length, () => {
      const { group, ul } = section(KIND_TITLE.lesson, KIND_TITLE.lesson);
      for (const lesson of lessons) ul.append(lessonRow(lesson));
      return group;
    }],
  ];
  for (const [kk, n, make] of more) {
    if ((k === "all" || k === kk) && n > 0) {
      any = true;
      wrap.append(make());
    }
  }
  if (!any) {
    const total = all.length + library.ingredients.size + [...library.presets.values()].reduce((sum, p) => sum + p.length, 0) + library.lessons.length;
    if (libraryNote === "loading") wrap.append(note("Reading your plugin library…", "pp-empty"));
    else if (query.trim()) wrap.append(note(k === "all" ? `Nothing matches “${query.trim()}”. Try another word, or clear the search.` : `No ${KIND_NOUN[k]} matches “${query.trim()}”. Try another word, show All, or clear the search.`, "pp-empty"));
    else if (k !== "all" && total > 0) wrap.append(note(EMPTY_KIND[k], "pp-empty"));
    else wrap.append(note("No plugins yet. Keep a recipe from a chat with keep {title, description}, or use Save as plugin… on a recipe's step in History. Press ? and Show me to try a demo.", "pp-empty"));
  }
  return wrap;
}

function listRow(row: PanelPlugin): HTMLElement {
  const li = el("li", "pp-row");
  const button = el("button", "pp-pick") as HTMLButtonElement;
  button.type = "button";
  button.dataset.key = row.key;
  button.dataset.tip = row.file.description || row.file.title;
  const title = el("span", "pp-title");
  title.textContent = row.file.title;
  const version = el("span", "pp-version");
  version.textContent = `v${row.file.version}`;
  const top = el("span", "pp-row-top");
  top.append(title, version);
  for (const badge of row.badges) {
    const tag = Object.assign(el("span", "pp-badge"), { textContent: badge });
    tag.dataset.badge = badge;
    if (badge === "imported") tag.dataset.tip = "Added from a file or a project. Its first run shows its code first.";
    top.append(tag);
  }
  const desc = el("span", "pp-desc");
  desc.textContent = row.file.description || "No description.";
  const by = el("span", "pp-by");
  by.textContent = row.file.author && row.file.author !== "unknown" ? `By ${row.file.author}` : "Author unknown";
  button.append(top, desc, by);
  li.append(button);
  return li;
}

function detail(plugin: PanelPlugin): HTMLElement {
  const wrap = el("div", "pp-detail");
  const head = el("div", "pp-head");
  const back = button("pp-back", demo ? "Back to my plugins" : "All plugins", demo ? "Back to the plugins you have." : PURPOSE.back);
  back.id = "modelPluginsBack";
  head.append(back);
  if (!demo) {
    const more = button("pp-more", "⋯", "Source, folder and library");
    more.id = "modelPluginsMore";
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", menuOpen ? "true" : "false");
    more.setAttribute("aria-label", "More for this plugin");
    head.append(more);
  }
  wrap.append(head);
  if (menuOpen && !demo) wrap.append(menu(plugin));
  const title = el("h4", "pp-detail-title");
  title.id = "modelPluginsTitle";
  title.textContent = plugin.file.title;
  const version = Object.assign(el("span", "pp-version"), { textContent: demo ? "demo" : `v${plugin.file.version}` });
  title.append(" ", version);
  wrap.append(title);
  if (demo) wrap.append(Object.assign(note(DEMO_TRY, "pp-demo-strip"), { id: "modelPluginsDemo" }));
  const meta = [plugin.file.description, plugin.file.author && plugin.file.author !== "unknown" ? `By ${plugin.file.author}` : "", plugin.file.madeBy ? `made with ${plugin.file.madeBy}` : ""].filter(Boolean).join(" · ");
  if (meta) wrap.append(note(meta, "pp-meta"));
  wrap.append(Object.assign(note(targetLine(plugin), "pp-target"), { id: "modelPluginsTarget" }));
  const rest = readOnlyNote(plugin);
  if (rest) wrap.append(Object.assign(note(rest, "pp-readonly"), { id: "modelPluginsReadOnly" }));
  if (!demo) {
    const trust = trustBox(plugin);
    if (trust) wrap.append(trust);
  }
  const carried = demo ? [] : pluginIngredients(plugin.file);
  if (carried.length) {
    const line = note(`Carries ${carried.length === 1 ? "the ingredient" : "the ingredients"} ${carried.map((c) => `${c.id} v${c.version}`).join(", ")}: it builds the same even where your library has other versions.`, "pp-carried");
    line.id = "modelPluginsCarried";
    wrap.append(line);
  }
  const data = demo ? [] : pluginData(plugin.file);
  if (data.length) {
    const line = note(`Carries the recipe data ${data.map((d) => `${d.name} (${dataSize(d.bytes)})`).join(", ")}: it runs the same without the files it was made from.`, "pp-carried");
    line.id = "modelPluginsData";
    wrap.append(line);
  }
  const presets = library.presets.get(plugin.file.plugin) ?? [];
  if (!demo) {
    const row = el("div", "pp-preset");
    if (presets.length > 0) {
      const label = el("label", "pp-preset-pick");
      label.append(Object.assign(el("span", "pp-name"), { textContent: "Preset" }));
      const select = document.createElement("select");
      select.id = "modelPluginsPreset";
      select.dataset.tip = PURPOSE.presets;
      select.append(new Option("Defaults", "", false, preset === ""));
      for (const p of presets) select.append(new Option(p.name, p.name, false, p.name === preset));
      select.disabled = busy;
      label.append(select);
      row.append(label);
    }
    const save = button("pp-preset-save", "Save as preset…", PURPOSE.savePreset);
    save.id = "modelPluginsSavePreset";
    row.append(save);
    if (preset) {
      const remove = button("pp-preset-remove", "Remove preset", PURPOSE.removePreset);
      remove.id = "modelPluginsRemovePreset";
      row.append(remove);
    }
    wrap.append(row);
  }
  const fields = el("div", "pp-fields mh-plugin-fields");
  fields.id = "modelPluginsFields";
  const editable = !busy;
  for (const param of plugin.file.params) fields.append(field(param, editable));
  if (plugin.file.params.length === 0) fields.append(Object.assign(el("p", "mh-plugin-empty"), { textContent: "This plugin takes no values." }));
  wrap.append(fields);
  const actions = el("div", "pp-actions");
  const preview = button("btn", "Preview", PURPOSE.preview);
  preview.id = "modelPluginsPreview";
  const live = el("label", "pp-live");
  const box = Object.assign(document.createElement("input"), { type: "checkbox", id: "modelPluginsLive", checked: liveOn() });
  live.dataset.tip = PURPOSE.live;
  live.append(box, " Live");
  actions.append(preview, live);
  wrap.append(actions);
  const line = Object.assign(el("p", "pp-status"), { id: "modelPluginsStatus" });
  line.setAttribute("role", "status");
  wrap.append(line);
  paintRun(wrap, plugin);
  return wrap;
}

function menu(plugin: PanelPlugin): HTMLElement {
  const box = el("div", "pp-menu");
  box.setAttribute("role", "menu");
  box.id = "modelPluginsMenu";
  const item = (act: string, label: string, tip: string, disabled = "") => {
    const b = el("button", "pp-menu-item") as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.dataset.act = act;
    b.textContent = label;
    b.dataset.tipIdle = tip;
    b.dataset.tip = blockedTip(tip, disabled);
    if (disabled) {
      b.setAttribute("aria-disabled", "true");
      b.dataset.reason = disabled;
    }
    box.append(b);
  };
  item("source", "View source", PURPOSE.source);
  item("export", "Export…", PURPOSE.exportFile);
  const noLibrary = libraryNote && libraryNote !== "loading" ? "Your library is read by the desktop app. Open this project there." : "";
  if (plugin.section === "library") {
    item("reveal", "Reveal in folder", PURPOSE.reveal, noLibrary);
    item("remove", "Remove from library…", PURPOSE.remove, noLibrary);
  } else {
    item("add", "Add to library", PURPOSE.add, noLibrary);
  }
  return box;
}

/**
 * D11.6: the trust shown on an imported plugin's page (marked imported, or a project's plugin not yet run here): where
 * it came from, its hash, and its code one click away. Null for the library's own plugins.
 */
function trustBox(plugin: PanelPlugin): HTMLElement | null {
  if (!needsFirstRun(plugin.file, plugin.sha256, library)) return null;
  const mark = library.imported[plugin.file.plugin];
  const box = el("div", "pp-trust");
  box.id = "modelPluginsTrust";
  const head = el("p", "model-note pp-trust-head");
  head.append(Object.assign(el("span", "pp-badge pp-badge-imported"), { textContent: mark ? "imported" : "from this project" }), " ", mark
    ? `Added from ${mark.from === "project" ? "a project" : mark.from === "mcp" ? "an MCP call" : "a file"}${mark.at ? ` on ${mark.at}` : ""}. Its first Preview or Apply shows its code, with Run and Cancel.`
    : "Not in your library and not run here yet. Its first Preview or Apply shows its code, with Run and Cancel.");
  const hash = Object.assign(el("code", "pp-trust-hash"), { textContent: plugin.sha256 });
  hash.title = "SHA-256 of its code";
  const view = button("pp-trust-source", "Read its code", PURPOSE.trustSource);
  view.id = "modelPluginsTrustSource";
  box.append(head, hash, view);
  return box;
}

/** "Builds a new part", "Changes Part 1", or what to do when it needs a part and none is open. */
function targetLine(plugin: PanelPlugin): string {
  const part = host?.partName() ?? null;
  if (plugin.file.target === "new") return "Builds a new part.";
  if (plugin.file.target === "object") return part ? `Changes ${part}.` : REASON.needsPart;
  return part ? `Changes ${part}.` : "Builds a new part, or changes the part you open.";
}

/** D15: why the form is read-only here, or null when plugins run. */
function readOnlyNote(plugin: PanelPlugin): string | null {
  if (runnerNote === undefined) return "Checking whether plugins run here…";
  if (runnerNote) return `${runnerNote} Projects open, and parts built with plugins are kept as built.`;
  if (plugin.file.api && apiNewer(plugin.file.api)) return `This plugin needs recipe API ${plugin.file.api}, from a newer Lime Slice; this app has ${RECIPE_API.join(".")}. Update Lime Slice to run it.`;
  return null;
}

function apiNewer(api: string): boolean {
  const m = /^(\d+)\.(\d+)$/.exec(api.trim());
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > RECIPE_API[0] || (major === RECIPE_API[0] && minor > RECIPE_API[1]);
}

function runnable(plugin: PanelPlugin): string | null {
  if (busy) return REASON.busy;
  const ro = readOnlyNote(plugin);
  if (ro) return ro;
  if (plugin.file.target === "object" && !host?.partName()) return REASON.needsPart;
  const problem = formProblem(plugin.file.params, Object.fromEntries(values));
  if (problem) return problem;
  return null;
}

function field(param: PluginParamInfo, editable: boolean): HTMLElement {
  if (param.kind === "face" || param.kind === "outline") {
    const ro = !editable || readOnlyNote(current()!) !== null;
    return pickField({
      name: param.name,
      label: paramLabel(param),
      kind: param.kind,
      ...(param.help ? { help: param.help } : {}),
      value: values.get(param.name),
      fallback: param.default,
      editable: !ro,
      picking: picking === param.name,
      typed: values.has(param.name),
      sketches: host?.sketches?.() ?? [],
      ...(host?.partName() ? {} : { blocked: REASON.noPartToPick }),
    });
  }
  const row = el("label", "mh-plugin-field");
  if (param.help) row.dataset.tip = param.help;
  const name = Object.assign(el("span", "mh-plugin-name"), { textContent: paramLabel(param) });
  const value = values.has(param.name) ? values.get(param.name)! : param.default;
  const tail = el("span", "mh-plugin-unit");
  let control: HTMLInputElement | HTMLSelectElement;
  const ro = !editable || readOnlyNote(current()!) !== null;
  if (param.kind === "toggle") {
    control = Object.assign(document.createElement("input"), { type: "checkbox", checked: value === true, disabled: ro });
  } else if (param.kind === "choice") {
    const select = document.createElement("select");
    select.disabled = ro;
    for (const option of param.options?.length ? param.options : [String(value)]) select.append(new Option(option, option, false, option === String(value)));
    control = select;
  } else {
    const input = Object.assign(document.createElement("input"), { type: "text", readOnly: ro, value: String(value) });
    input.inputMode = param.kind === "number" ? "decimal" : param.kind === "count" ? "numeric" : "text";
    input.spellcheck = false;
    control = input;
  }
  control.classList.add("mh-plugin-control");
  control.dataset.name = param.name;
  control.setAttribute("aria-label", paramLabel(param));
  const range = param.kind === "number" || param.kind === "count" ? rangeText(param) : "";
  const changed = values.has(param.name) && String(values.get(param.name)) !== String(param.default);
  control.toggleAttribute("data-typed", changed);
  tail.textContent = [param.unit ?? "", range ? `${range}` : ""].filter(Boolean).join(" · ");
  if (range) tail.title = `${paramLabel(param)} is ${range}${param.unit ? ` ${param.unit}` : ""}.`;
  row.append(name, control, tail);
  return row;
}

/** The status line and the Preview button, without rebuilding the form (the caret stays in its field). */
function paintRun(scope: ParentNode | null = root(), plugin = current()) {
  if (!scope || !plugin) return;
  const why = runnable(plugin);
  const preview = scope.querySelector<HTMLButtonElement>("#modelPluginsPreview");
  if (preview) {
    preview.disabled = !!why;
    preview.textContent = busy ? "Running…" : "Preview";
    preview.dataset.tipIdle = PURPOSE.preview;
    preview.dataset.tip = blockedTip(PURPOSE.preview, why ?? "");
    if (why) preview.dataset.reason = why;
    else delete preview.dataset.reason;
  }
  const save = scope.querySelector<HTMLButtonElement>("#modelPluginsSavePreset");
  if (save) {
    const whyNot = presetBlocked(plugin);
    save.setAttribute("aria-disabled", whyNot ? "true" : "false");
    save.dataset.tip = blockedTip(PURPOSE.savePreset, whyNot ?? "");
    if (whyNot) save.dataset.reason = whyNot;
    else delete save.dataset.reason;
  }
  const line = scope.querySelector<HTMLElement>("#modelPluginsStatus");
  if (line) {
    const problem = formProblem(plugin.file.params, Object.fromEntries(values));
    const text = busy ? "Running the plugin…" : problem ?? status?.text ?? "";
    line.textContent = text;
    line.hidden = !text;
    line.classList.toggle("is-problem", !busy && (!!problem || !!status?.problem));
  }
  paintFoot();
}

/** Apply in the card's foot: ready when the plugin can run, else greyed with the reason (R1). */
function paintFoot() {
  const apply = document.querySelector<HTMLButtonElement>("#modelApply");
  if (!apply || !pluginsPanelOpen()) return;
  const plugin = current();
  const why = !plugin ? REASON.pick : demo ? REASON.demoApply : runnable(plugin);
  apply.textContent = "Apply";
  apply.disabled = !!why;
  apply.dataset.tipIdle = PURPOSE.apply;
  apply.dataset.tip = blockedTip(PURPOSE.apply, why ?? "");
  if (why) apply.dataset.reason = why;
  else delete apply.dataset.reason;
}

function howButton(): HTMLElement {
  const b = button("btn sketch-how-open", "?", PURPOSE.how);
  b.id = "modelPluginsHowOpen";
  b.setAttribute("aria-label", "How");
  b.setAttribute("aria-expanded", howOpen ? "true" : "false");
  b.setAttribute("aria-controls", "modelPluginsHow");
  return b;
}

const HOW_STEPS = [
  "Pick a plugin. Its values are a form, with their ranges and units.",
  "Change a value and press Preview to see what it builds. With Live on, it previews by itself.",
  "Apply keeps it as one History step. Undo takes it back; the step's pencil changes its values later.",
  "A recipe's step in History has Save as plugin…, which keeps it here for other parts.",
];

function howPop(): HTMLElement {
  const pop = el("div", "sketch-how-pop pp-how-pop");
  pop.id = "modelPluginsHow";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "How");
  const show = button("btn sketch-show-me", "Show me", "Open a demo plugin ready to preview. Nothing is added to your part.");
  show.id = "modelPluginsShowMe";
  const ol = el("ol", "");
  for (const step of HOW_STEPS) ol.append(Object.assign(el("li", ""), { textContent: step }));
  pop.append(show, ol);
  return pop;
}

// ---------------------------------------------------------------------------
// Input.
// ---------------------------------------------------------------------------

function onClick(ev: MouseEvent) {
  const target = ev.target instanceof Element ? ev.target : null;
  if (!target || !host) return;
  const chip = target.closest<HTMLElement>(".pp-kind");
  if (chip?.dataset.kind) {
    setKind(chip.dataset.kind as NuggetKind);
    paint();
    $<HTMLElement>(`.pp-kind[data-kind="${kind}"]`)?.focus({ preventScroll: true });
    return;
  }
  const ing = target.closest<HTMLElement>(".pp-pick-ingredient");
  if (ing?.dataset.ingredient) {
    selectIngredient(ing.dataset.ingredient);
    return;
  }
  const presetPick = target.closest<HTMLElement>(".pp-pick-preset");
  if (presetPick?.dataset.key && presetPick.dataset.preset) {
    select(presetPick.dataset.key);
    usePreset(presetPick.dataset.preset);
    return;
  }
  const pick = target.closest<HTMLElement>(".pp-pick");
  if (pick?.dataset.key) {
    select(pick.dataset.key);
    return;
  }
  const lessonButton = target.closest<HTMLElement>(".pp-lesson-remove");
  if (lessonButton?.dataset.lesson) {
    if (lessonButton.getAttribute("aria-disabled") === "true") {
      host.readout(lessonButton.dataset.reason ?? "");
      return;
    }
    void removeLessonNow(Number(lessonButton.dataset.lesson));
    return;
  }
  if (target.closest("#modelPluginsSavePreset")) {
    const b = target.closest<HTMLElement>("#modelPluginsSavePreset")!;
    if (b.getAttribute("aria-disabled") === "true") {
      host.readout(b.dataset.reason ?? "");
      return;
    }
    void savePresetNow();
    return;
  }
  if (target.closest("#modelPluginsRemovePreset")) {
    void removePresetNow();
    return;
  }
  if (target.closest("#modelPluginsImport")) {
    if (libraryNote && libraryNote !== "loading") {
      host.readout(libraryNote);
      return;
    }
    pickPluginFiles((text) => said(text));
    return;
  }
  if (target.closest("#modelPluginsTrustSource")) {
    const plugin = current();
    if (plugin) showSource(plugin);
    return;
  }
  if (target.closest("#modelPluginsHowOpen")) {
    howOpen = !howOpen;
    paint();
    return;
  }
  if (target.closest("#modelPluginsShowMe")) {
    howOpen = false;
    startDemo();
    return;
  }
  const pickButton = target.closest<HTMLButtonElement>("button[data-pick-act]");
  if (pickButton?.dataset.name) {
    if (pickButton.disabled) {
      if (pickButton.dataset.reason) host.readout(pickButton.dataset.reason);
      return;
    }
    pickAct(pickButton.dataset.pickAct ?? "", pickButton.dataset.name);
    return;
  }
  if (target.closest("#modelPluginsBack")) {
    stopPicking();
    host.clearPreview();
    previewed = null;
    stopLive();
    selected = null;
    demo = false;
    values.clear();
    preset = "";
    menuOpen = false;
    status = null;
    paint();
    $<HTMLInputElement>("#modelPluginsSearch")?.focus({ preventScroll: true });
    return;
  }
  if (target.closest("#modelPluginsMore")) {
    menuOpen = !menuOpen;
    paint();
    $<HTMLElement>("#modelPluginsMenu [role=menuitem]")?.focus();
    return;
  }
  const item = target.closest<HTMLElement>("#modelPluginsMenu [role=menuitem]");
  if (item) {
    if (item.getAttribute("aria-disabled") === "true") {
      host.readout(item.dataset.reason ?? "");
      return;
    }
    menuOpen = false;
    if (currentIngredient()) void ingredientAction(item.dataset.act ?? "");
    else void menuAction(item.dataset.act ?? "");
    return;
  }
  if (target.closest("#modelPluginsPreview")) {
    const b = target.closest<HTMLButtonElement>("#modelPluginsPreview")!;
    if (b.disabled) {
      if (b.dataset.reason) host.readout(b.dataset.reason);
      return;
    }
    void runNow("preview");
  }
}

function onInput(ev: Event) {
  const target = ev.target;
  if (target instanceof HTMLInputElement && target.id === "modelPluginsSearch") {
    query = target.value;
    const caret = target.selectionStart;
    paint();
    const again = $<HTMLInputElement>("#modelPluginsSearch");
    again?.focus({ preventScroll: true });
    if (again && caret !== null) again.setSelectionRange(caret, caret);
    return;
  }
  if (target instanceof HTMLInputElement && target.type === "text" && target.dataset.name) {
    values.set(target.dataset.name, target.value);
    unsetPreset();
    status = null;
    const plugin = current();
    const param = plugin?.file.params.find((p) => p.name === target.dataset.name);
    if (param) target.toggleAttribute("data-typed", String(formNumber(param, target.value) ?? target.value) !== String(param.default));
    paintRun();
    queueLive();
  }
}

function onChange(ev: Event) {
  const target = ev.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target.id === "modelPluginsLive") {
    try {
      prefs.setBool(LIVE_KEY, (target as HTMLInputElement).checked);
    } catch {
      // The choice still holds for this visit.
    }
    liveChoice = (target as HTMLInputElement).checked;
    if (liveChoice) queueLive(0);
    return;
  }
  if (target.id === "modelPluginsPreset") {
    usePreset(target.value);
    return;
  }
  if (target instanceof HTMLSelectElement && target.dataset.pickAct === "sketch" && target.dataset.name) {
    const chosen = sketchValue(target.value);
    if (chosen) setPicked(target.dataset.name, chosen);
    return;
  }
  if (target.dataset.name && !(target instanceof HTMLInputElement && target.type === "text")) {
    values.set(target.dataset.name, target instanceof HTMLInputElement && target.type === "checkbox" ? target.checked : target.value);
    unsetPreset();
    status = null;
    paintRun();
    queueLive();
  }
}

function onKeyDown(ev: KeyboardEvent) {
  const target = ev.target;
  if (ev.key === "Enter" && target instanceof HTMLInputElement && target.id === "modelPluginsSearch") {
    ev.preventDefault();
    ev.stopPropagation();
    if (kind === "all" || kind === "plugin") {
      const first = searched(rows(), query)[0];
      if (first) {
        select(first.key);
        return;
      }
    }
    if (kind === "all" || kind === "ingredient") {
      const first = searchedIngredients(library, query)[0];
      if (first) {
        selectIngredient(first.id);
        return;
      }
    }
    if (kind === "all" || kind === "preset") {
      const first = searchedPresets(library, query)[0];
      if (first) {
        select(`library:${first.plugin}`);
        usePreset(first.preset.name);
      }
    }
    return;
  }
  if (ev.key === "Escape" && menuOpen) {
    ev.preventDefault();
    ev.stopPropagation();
    menuOpen = false;
    paint();
    $<HTMLElement>("#modelPluginsMore")?.focus();
  }
}

/** --- API 1.2. A pick button: wait for a face click (a face, or a face's outline), or drop the pick. */
function pickAct(act: string, name: string) {
  if (!host) return;
  if (act === "clear") {
    stopPicking();
    values.delete(name);
    unsetPreset();
    status = null;
    paint();
    queueLive();
    return;
  }
  if (act !== "face" && act !== "outline-face") return;
  if (picking === name) {
    stopPicking();
    paint();
    return;
  }
  stopPicking();
  const why = host.pickFace ? host.pickFace((got) => {
    if (picking !== name) return;
    picking = null;
    if (got) setPicked(name, (act === "face" ? { ...got.face } : { face: { ...got.face }, object: got.object }) as FormValue);
    else paint();
  }) ?? null : "Picking a face needs the Model view.";
  if (why) {
    host.readout(why);
    return;
  }
  picking = name;
  paint();
}

function setPicked(name: string, value: FormValue) {
  values.set(name, value);
  unsetPreset();
  status = null;
  paint();
  queueLive();
}

/** A value typed by hand: the form no longer holds the preset's values. */
function unsetPreset() {
  preset = "";
  const box = $<HTMLSelectElement>("#modelPluginsPreset");
  if (box) box.value = "";
}

function select(key: string) {
  stopPicking();
  host?.clearPreview();
  previewed = null;
  stopLive();
  selected = key;
  demo = false;
  values.clear();
  preset = "";
  menuOpen = false;
  status = null;
  lastMs = 0;
  paint();
  $<HTMLElement>("#modelPluginsFields .mh-plugin-control")?.focus({ preventScroll: true });
}

function selectIngredient(id: string) {
  host?.clearPreview();
  previewed = null;
  stopLive();
  selected = `ingredient:${id}`;
  demo = false;
  values.clear();
  preset = "";
  menuOpen = false;
  status = null;
  paint();
  $<HTMLElement>("#modelPluginsBack")?.focus({ preventScroll: true });
}

/** An ingredient's card: what it gives, the line that imports it, which plugins carry it, and its menu. */
function ingredientDetail(row: LibraryIngredient): HTMLElement {
  const wrap = el("div", "pp-detail pp-ingredient");
  const head = el("div", "pp-head");
  const back = button("pp-back", "All nuggets", PURPOSE.back);
  back.id = "modelPluginsBack";
  const more = button("pp-more", "⋯", "Source, folder and library");
  more.id = "modelPluginsMore";
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", menuOpen ? "true" : "false");
  more.setAttribute("aria-label", "More for this ingredient");
  head.append(back, more);
  wrap.append(head);
  if (menuOpen) {
    const box = el("div", "pp-menu");
    box.setAttribute("role", "menu");
    box.id = "modelPluginsMenu";
    const noLibrary = libraryNote && libraryNote !== "loading" ? "Your library is read by the desktop app. Open this project there." : "";
    for (const [act, label, tip, off] of [["source", "View source", PURPOSE.ingredientSource, ""], ["reveal", "Reveal in folder", PURPOSE.reveal, noLibrary], ["remove", "Remove from library…", PURPOSE.removeIngredient, noLibrary]] as const) {
      const b = el("button", "pp-menu-item") as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.dataset.act = act;
      b.textContent = label;
      b.dataset.tipIdle = tip;
      b.dataset.tip = blockedTip(tip, off);
      if (off) {
        b.setAttribute("aria-disabled", "true");
        b.dataset.reason = off;
      }
      box.append(b);
    }
    wrap.append(box);
  }
  const title = el("h4", "pp-detail-title");
  title.id = "modelPluginsTitle";
  title.textContent = row.title;
  title.append(" ", Object.assign(el("span", "pp-version"), { textContent: `v${row.version}` }));
  wrap.append(title);
  const meta = [row.description, row.author && row.author !== "unknown" ? `By ${row.author}` : "", row.older.length ? `older versions kept: ${row.older.map((v) => `v${v}`).join(", ")}` : ""].filter(Boolean).join(" · ");
  if (meta) wrap.append(note(meta, "pp-meta"));
  const use = el("p", "model-note pp-use");
  use.id = "modelIngredientUse";
  use.append("A recipe imports it with ", Object.assign(el("code", ""), { textContent: ingredientUse(row.id) }), row.older.length ? `, or a kept version with ingredients::${row.id.replace(/-/g, "_")}::v${row.older.at(-1)}.` : ".");
  wrap.append(use);
  const gives = el("ul", "pp-items");
  gives.id = "modelIngredientItems";
  gives.setAttribute("aria-label", "What it gives");
  for (const item of row.items) gives.append(Object.assign(el("li", ""), { textContent: `${item.kind} ${item.name}` }));
  if (row.items.length === 0) gives.append(Object.assign(el("li", ""), { textContent: "Nothing public yet: a recipe sees only its pub items." }));
  wrap.append(gives);
  const users = ingredientUsers(library, row.id);
  const usedBy = note(users.length ? `Carried by ${users.map((u) => `${u.title} (v${u.version})`).join(", ")}.` : "No plugin in your library carries it yet. A recipe that imports it and is kept as a plugin carries its own copy.", "pp-used-by");
  usedBy.id = "modelIngredientUsers";
  wrap.append(usedBy);
  wrap.append(note(PURPOSE.ingredientHow, "pp-ingredient-how"));
  return wrap;
}

async function ingredientAction(act: string) {
  const row = currentIngredient();
  if (!row || !host) return;
  if (act === "source") {
    void import("./model-history").then(({ showPluginSource }) => showPluginSource(`${row.title} · v${row.version}`, "Read-only. Reveal in folder opens the file, to edit it elsewhere.", row.text));
    paint();
    return;
  }
  const io = await libraryIo();
  if (!io) {
    host.readout(LIBRARY_NEEDS_APP);
    paint();
    return;
  }
  try {
    if (act === "reveal") {
      await io.reveal(row.id, "ingredient");
      host.readout(`Showing ingredients/${row.id}.rs in ${library.dir || "your plugin folder"}.`);
    } else if (act === "remove") {
      const users = ingredientUsers(library, row.id);
      const carried = users.length ? ` ${users.length === 1 ? "One plugin carries" : `${users.length} plugins carry`} a copy and keep building.` : "";
      const sure = await confirmSheet({
        title: `Remove the ingredient “${row.title}”?`,
        body: `It and its older versions leave your library. Recipes that import it stop building until it is kept again.${carried}`,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!sure) {
        paint();
        return;
      }
      const n = await io.remove(row.id, "ingredient");
      host.readout(`Removed the ingredient “${row.title}” (${n} ${n === 1 ? "file" : "files"}).`);
      selected = null;
      await loadLibrary();
    }
  } catch (err) {
    host.readout(err instanceof Error ? err.message : String(err));
  }
  paint();
}

/** Why the form's values cannot be kept as a preset now, ending with what to do, or null. */
function presetBlocked(plugin: PanelPlugin): string | null {
  if (demo) return REASON.demoPreset;
  if (libraryNote && libraryNote !== "loading") return "Presets are kept by the desktop app. Open this project there.";
  if (plugin.section !== "library") return REASON.presetNeedsLibrary;
  if (busy) return REASON.busy;
  return formProblem(plugin.file.params, Object.fromEntries(values));
}

async function savePresetNow() {
  const plugin = current();
  if (!plugin || !host || presetBlocked(plugin)) return;
  const name = await askSheet({
    title: "Save as preset",
    body: `A name for these values of “${plugin.file.title}”. Agents find the preset by this name.`,
    confirmLabel: "Save",
    input: { label: "Preset name", value: preset || "", placeholder: "pp-5mm-wall", maxLength: 48, problem: presetNameProblem },
  });
  if (name === null) return;
  const trimmed = name.trim();
  const problem = presetProblem(trimmed, plugin.file.params, Object.fromEntries(values));
  if (problem) {
    status = { text: problem, problem: true };
    paintRun();
    return;
  }
  const existing = library.presets.get(plugin.file.plugin)?.some((p) => p.name === trimmed);
  if (existing && !(await confirmSheet({ title: `Replace the preset “${trimmed}”?`, body: `“${trimmed}” is already a preset of ${plugin.file.title}. Its values become these.`, confirmLabel: "Replace" }))) return;
  const io = await libraryIo();
  if (!io) {
    host.readout(LIBRARY_NEEDS_APP);
    return;
  }
  try {
    const listing = await io.list();
    const text = listing.presets.find((p) => p.plugin === plugin.file.plugin)?.text ?? null;
    await io.writePresets(plugin.file.plugin, presetsText(text, { name: trimmed, params: presetParams(plugin.file.params, Object.fromEntries(values)) }, new Date().toISOString()));
    const keep = new Map(values);
    await loadLibrary();
    values.clear();
    for (const [k, v] of keep) values.set(k, v);
    preset = trimmed;
    status = { text: `Kept these values as the preset “${trimmed}”. An agent finds it with nugget {action: "find", query: "${trimmed}"}.`, problem: false };
  } catch (err) {
    status = { text: `The preset could not be kept: ${err instanceof Error ? err.message : String(err)}`, problem: true };
  }
  paint();
}

async function removePresetNow() {
  const plugin = current();
  if (!plugin || !host || !preset) return;
  const name = preset;
  if (!(await confirmSheet({ title: `Remove the preset “${name}”?`, body: `It leaves ${plugin.file.title}'s presets. Parts built with it keep their values.`, confirmLabel: "Remove", danger: true }))) return;
  const io = await libraryIo();
  if (!io) {
    host.readout(LIBRARY_NEEDS_APP);
    return;
  }
  try {
    const listing = await io.list();
    const text = listing.presets.find((p) => p.plugin === plugin.file.plugin)?.text ?? null;
    await io.writePresets(plugin.file.plugin, presetsWithout(text, name));
    preset = "";
    await loadLibrary();
    status = { text: `Removed the preset “${name}”. The form keeps its values.`, problem: false };
  } catch (err) {
    status = { text: `The preset could not be removed: ${err instanceof Error ? err.message : String(err)}`, problem: true };
  }
  paint();
}

async function removeLessonNow(n: number) {
  const lesson = library.lessons.find((row) => row.n === n);
  const io = await libraryIo();
  if (!lesson || !io || !host) return;
  try {
    const listing = await io.list();
    await io.writeLessons(lessonsWithout(listing.lessons ?? null, n));
    host.readout(`Removed the lesson about ${lesson.about}. Agents and the ${lesson.about} card no longer show it.`);
    await loadLibrary();
  } catch (err) {
    host.readout(`The lesson could not be removed: ${err instanceof Error ? err.message : String(err)}`);
  }
  paint();
}

function startDemo() {
  host?.clearPreview();
  previewed = null;
  selected = null;
  demo = true;
  values.clear();
  preset = "";
  status = null;
  lastMs = 0;
  paint();
  host?.readout(DEMO_TRY);
  $<HTMLElement>("#modelPluginsFields .mh-plugin-control")?.focus({ preventScroll: true });
}

function usePreset(name: string) {
  const plugin = current();
  if (!plugin) return;
  preset = name;
  values.clear();
  status = null;
  if (name) {
    const found = (library.presets.get(plugin.file.plugin) ?? []).find((p) => p.name === name);
    if (found) {
      const { values: filled, skipped } = presetValues(found, plugin.file.params);
      for (const [key, value] of Object.entries(filled)) values.set(key, value);
      if (skipped.length) status = { text: `The preset's ${skipped.join(", ")} ${skipped.length === 1 ? "does" : "do"} not fit this version, so ${skipped.length === 1 ? "it was" : "they were"} left at the default.`, problem: false };
    }
  }
  paint();
  queueLive();
}

async function menuAction(act: string) {
  const plugin = current();
  if (!plugin || !host) return;
  const io = await libraryIo();
  if (act === "source") {
    showSource(plugin);
    paint();
    return;
  }
  if (act === "export") {
    try {
      said(await exportPluginFile(plugin.file, plugin.section === "library"));
    } catch (err) {
      said(`The plugin could not be exported: ${err instanceof Error ? err.message : String(err)}`);
    }
    paint();
    return;
  }
  if (!io) {
    host.readout(LIBRARY_NEEDS_APP);
    paint();
    return;
  }
  try {
    if (act === "reveal") {
      await io.reveal(plugin.file.plugin);
      host.readout(`Showing ${plugin.file.plugin}.rs in ${library.dir || "your plugin folder"}.`);
    } else if (act === "add") {
      // D10: a project's plugin joins the library as an import: its author, hash and code shown first.
      said(await importPluginText(plugin.file.text, "project", "this project"));
    } else if (act === "remove") {
      const sure = await confirmSheet({
        title: `Remove “${plugin.file.title}”?`,
        body: "It and its older versions leave your library. Parts built with it keep their code in their project.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!sure) {
        paint();
        return;
      }
      const n = await io.remove(plugin.file.plugin);
      host.readout(`Removed “${plugin.file.title}” from your library (${n} ${n === 1 ? "file" : "files"}). Parts built with it keep their code in their project.`);
      selected = null;
      await loadLibrary();
    }
  } catch (err) {
    host.readout(`${err instanceof Error ? err.message : String(err)}`);
  }
  paint();
}

/** The plugin's code, read-only, in History's source sheet. */
function showSource(plugin: PanelPlugin) {
  void import("./model-history").then(({ showPluginSource }) => showPluginSource(`${plugin.file.title} · v${plugin.file.version}`, "Read-only. Reveal in folder opens the file, to edit it elsewhere.", elideData(plugin.file.text)));
}

// ---------------------------------------------------------------------------
// Running.
// ---------------------------------------------------------------------------

let liveChoice: boolean | null = null;

function liveOn(): boolean {
  if (liveChoice !== null) return liveChoice;
  try {
    liveChoice = prefs.getBool(LIVE_KEY);
  } catch {
    liveChoice = true;
  }
  return liveChoice;
}

function stopLive() {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = null;
}

/** Live: preview again a moment after the last change, while the last run was quick (D13). */
function queueLive(wait = LIVE_WAIT_MS) {
  stopLive();
  const plugin = current();
  if (!plugin || !liveOn() || lastMs >= LIVE_MAX_MS || runnable(plugin)) return;
  // An imported plugin's first run is a person's choice (D11.6): Live never opens the first-run view by itself.
  if (!demo && needsFirstRun(plugin.file, plugin.sha256, library)) return;
  liveTimer = setTimeout(() => {
    liveTimer = null;
    void runNow("preview");
  }, wait);
}

function signature(plugin: PanelPlugin): string {
  return JSON.stringify([plugin.key, formParams(plugin.file.params, Object.fromEntries(values))]);
}

/** Enter or Apply in the card's foot. */
export async function applyPluginsPanel(): Promise<void> {
  const plugin = current();
  if (!plugin || demo || runnable(plugin)) return;
  await runNow("apply");
}

async function runNow(mode: "preview" | "apply") {
  const plugin = current();
  if (!plugin || !host || runnable(plugin)) return;
  stopLive();
  if (!demo && needsFirstRun(plugin.file, plugin.sha256, library)) {
    const yes = await approveFirstRun(plugin.file, plugin.sha256, plugin.section === "project" ? "this project" : undefined);
    if (!pluginsPanelOpen()) return;
    if (!yes) {
      status = { text: "Not run. It stays marked until you run it once; Read its code shows what it does.", problem: false };
      paintRun();
      return;
    }
    paint();
  }
  const params = formParams(plugin.file.params, Object.fromEntries(values));
  const sig = signature(plugin);
  busy = true;
  status = null;
  paintRun();
  let out: PluginRunResult;
  try {
    out = await host.run(plugin, params, mode);
  } catch (err) {
    out = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    busy = false;
  }
  if (!pluginsPanelOpen()) return;
  if (out.ok) {
    lastMs = out.ms;
    previewed = mode === "preview" ? sig : null;
    status = { text: out.text, problem: false };
    if (mode === "apply" && !demo) noteUsed(plugin.file.plugin);
  } else {
    previewed = null;
    const where = out.line !== undefined && !/line \d+/.test(out.reason) ? ` (line ${out.line})` : "";
    status = { text: `${out.reason}${where}`, problem: true };
  }
  if (current() === plugin || current()?.key === plugin.key) paintRun();
  else paint();
  // Values typed while it ran preview again.
  if (mode === "preview" && out.ok && signature(plugin) !== sig) queueLive(0);
}

/** The part on screen changed (another object, a step, Undo): the target line and the buttons follow, the form stays. */
export function refreshPluginsPanel() {
  const plugin = current();
  if (!pluginsPanelOpen() || !plugin) return;
  const line = $<HTMLElement>("#modelPluginsTarget");
  if (line) line.textContent = targetLine(plugin);
  paintRun();
}

/** Whether the preview on screen shows the card's values now. */
export function pluginsPreviewFresh(): boolean {
  const plugin = current();
  return !!plugin && previewed === signature(plugin);
}

// ---------------------------------------------------------------------------
// Last used, and the "Plugin author" setting.
// ---------------------------------------------------------------------------

function usedAt(): Record<string, number> {
  try {
    const parsed = prefs.getJson(USED_KEY);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** A plugin was applied: it moves to the top of its section. */
export function noteUsed(id: string) {
  try {
    prefs.setJson(USED_KEY, { ...usedAt(), [id]: Date.now() });
  } catch {
    // The order still follows titles.
  }
}

const AUTHOR_LOCAL = "lime-slice-plugin-author";

/** The "Plugin author" setting: the library's `settings.json` where the app reads the library, else this browser's. */
export function pluginAuthor(): string {
  if (library.author) return library.author;
  try {
    return prefs.get(AUTHOR_LOCAL) ?? "";
  } catch {
    return "";
  }
}

export async function setPluginAuthor(name: string): Promise<string | null> {
  const io = await libraryIo();
  try {
    prefs.set(AUTHOR_LOCAL, name);
  } catch {
    // The library's file is the setting where there is one.
  }
  if (!io) return null;
  try {
    const listing: LibraryListing = await io.list();
    await io.writeSettings(settingsText(listing.settings, name));
    await loadLibrary();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function syncAuthorField() {
  const input = document.querySelector<HTMLInputElement>("#pluginAuthor");
  if (input && document.activeElement !== input) input.value = pluginAuthor();
}

/** The gear menu's "Plugin author" field. */
export function mountPluginAuthor() {
  const input = document.querySelector<HTMLInputElement>("#pluginAuthor");
  if (!input) return;
  input.value = pluginAuthor();
  input.addEventListener("change", () => {
    void setPluginAuthor(input.value).then((err) => {
      if (err) pushToast(`The plugin author could not be saved: ${err}`, "error");
    });
  });
}

// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function note(text: string, className: string): HTMLElement {
  const p = el("p", `model-note ${className}`);
  p.textContent = text;
  return p;
}

function button(className: string, text: string, tip: string): HTMLButtonElement {
  const b = el("button", className.startsWith("btn") ? className : `btn ${className}`);
  b.type = "button";
  b.textContent = text;
  b.dataset.tipIdle = tip;
  b.dataset.tip = tip;
  return b;
}
