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
import { blockedTip } from "../sketch/reasons";
import type { PluginFileInfo, PluginParamInfo } from "../plugin-file";
import {
  EMPTY_LIBRARY,
  LIBRARY_NEEDS_APP,
  SECTION_TITLE,
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
  type LibraryListing,
  type PanelPlugin,
  type PanelSection,
  type PluginLibrary,
} from "../plugins/library";
import { DEMO_PLUGIN, DEMO_TRY } from "../plugins/demo";
import { RECIPE_API } from "../plugin-step";
import { PURPOSE, REASON } from "./plugins-panel-text";

const CARD_ID = "plugins";
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
}

export type PluginRunResult = { ok: true; ms: number; text: string } | { ok: false; reason: string; line?: number };

let host: PluginsHost | null = null;
let library: PluginLibrary = EMPTY_LIBRARY;
/** Null once the library was read; else why it could not be (the browser build) or "loading". */
let libraryNote: string | null = "loading";
let runnerNote: string | null | undefined;
let query = "";
let selected: string | null = null;
let demo = false;
const values = new Map<string, FormValue>();
let preset = "";
let busy = false;
let lastMs = Infinity;
let liveTimer: ReturnType<typeof setTimeout> | null = null;
let status: { text: string; problem: boolean } | null = null;
let howOpen = false;
let menuOpen = false;
/** The values the preview on screen was built from, so Apply says whether it matches. */
let previewed: string | null = null;

const root = () => document.querySelector<HTMLElement>("#modelPlugins");
const $ = <T extends HTMLElement>(selector: string) => root()?.querySelector<T>(selector) ?? null;

export function mountPluginsPanel(next: PluginsHost) {
  host = next;
  document.addEventListener("click", (ev) => {
    if (ev.target instanceof Element && ev.target.closest("#modelMenuPlugins")) openPluginsPanel();
  });
  const body = root();
  if (!body) return;
  body.addEventListener("click", onClick);
  body.addEventListener("input", onInput);
  body.addEventListener("change", onChange);
  body.addEventListener("keydown", onKeyDown);
  void loadLibrary();
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

function paint() {
  const body = root();
  if (!body || !pluginsPanelOpen()) return;
  const plugin = current();
  if (selected && !plugin) selected = null;
  body.replaceChildren(plugin ? detail(plugin) : list());
  paintFoot();
}

function list(): HTMLElement {
  const wrap = el("div", "pp-list-view");
  const head = el("div", "pp-head");
  const search = Object.assign(document.createElement("input"), { type: "search", id: "modelPluginsSearch", className: "pp-search", value: query, placeholder: "Search plugins", spellcheck: false });
  search.setAttribute("aria-label", "Search plugins");
  search.dataset.tip = PURPOSE.search;
  search.dataset.ownEnter = "";
  head.append(search, howButton());
  wrap.append(head);
  if (howOpen) wrap.append(howPop());
  if (libraryNote && libraryNote !== "loading") wrap.append(note(libraryNote, "pp-library-note"));
  const all = rows();
  const shown = searched(all, query);
  const sections: PanelSection[] = ["project", "library", "samples"];
  let any = false;
  for (const section of sections) {
    const items = shown.filter((row) => row.section === section);
    if (items.length === 0) continue;
    any = true;
    const group = el("section", "pp-section");
    group.setAttribute("aria-label", SECTION_TITLE[section]);
    group.append(Object.assign(el("h4", "pp-section-title"), { textContent: SECTION_TITLE[section] }));
    const ul = el("ul", "pp-rows");
    ul.setAttribute("role", "list");
    for (const row of items) ul.append(listRow(row));
    group.append(ul);
    wrap.append(group);
  }
  if (!any) {
    if (all.length === 0) {
      wrap.append(note(libraryNote === "loading" ? "Reading your plugin library…" : "No plugins yet. Keep a recipe from a chat with keep {title, description}, or use Save as plugin… on a recipe's step in History. Press ? and Show me to try a demo.", "pp-empty"));
    } else {
      wrap.append(note(`No plugin matches “${query.trim()}”. Try another word, or clear the search.`, "pp-empty"));
    }
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
  for (const badge of row.badges) top.append(Object.assign(el("span", "pp-badge"), { textContent: badge }));
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
  const presets = library.presets.get(plugin.file.plugin) ?? [];
  if (presets.length > 0 && !demo) {
    const row = el("label", "pp-preset");
    row.append(Object.assign(el("span", "pp-name"), { textContent: "Preset" }));
    const select = document.createElement("select");
    select.id = "modelPluginsPreset";
    select.dataset.tip = PURPOSE.presets;
    select.append(new Option("Defaults", "", false, preset === ""));
    for (const p of presets) select.append(new Option(p.name, p.name, false, p.name === preset));
    select.disabled = busy;
    row.append(select);
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
  const noLibrary = libraryNote && libraryNote !== "loading" ? "Your library is read by the desktop app. Open this project there." : "";
  if (plugin.section === "library") {
    item("reveal", "Reveal in folder", PURPOSE.reveal, noLibrary);
    item("remove", "Remove from library…", PURPOSE.remove, noLibrary);
  } else {
    item("add", "Add to library", PURPOSE.add, noLibrary);
  }
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
  const pick = target.closest<HTMLElement>(".pp-pick");
  if (pick?.dataset.key) {
    select(pick.dataset.key);
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
  if (target.closest("#modelPluginsBack")) {
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
    void menuAction(item.dataset.act ?? "");
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
      localStorage.setItem(LIVE_KEY, (target as HTMLInputElement).checked ? "1" : "0");
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
    const first = searched(rows(), query)[0];
    if (first) select(first.key);
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

/** A value typed by hand: the form no longer holds the preset's values. */
function unsetPreset() {
  preset = "";
  const box = $<HTMLSelectElement>("#modelPluginsPreset");
  if (box) box.value = "";
}

function select(key: string) {
  host?.clearPreview();
  previewed = null;
  stopLive();
  selected = key;
  demo = false;
  values.clear();
  preset = "";
  menuOpen = false;
  status = null;
  lastMs = Infinity;
  paint();
  $<HTMLElement>("#modelPluginsFields .mh-plugin-control")?.focus({ preventScroll: true });
}

function startDemo() {
  host?.clearPreview();
  previewed = null;
  selected = null;
  demo = true;
  values.clear();
  preset = "";
  status = null;
  lastMs = Infinity;
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
      const path = await io.save(plugin.file.plugin, plugin.file.text);
      host.readout(`Added “${plugin.file.title}” v${plugin.file.version} to your library: ${path}.`);
      await loadLibrary();
      selected = `library:${plugin.file.plugin}`;
    } else if (act === "remove") {
      if (!window.confirm(`Remove “${plugin.file.title}” and its older versions from your library? Parts built with it keep their code in their project.`)) {
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
  void import("./model-history").then(({ showPluginSource }) => showPluginSource(`${plugin.file.title} · v${plugin.file.version}`, "Read-only. Reveal in folder opens the file, to edit it elsewhere.", plugin.file.text));
}

// ---------------------------------------------------------------------------
// Running.
// ---------------------------------------------------------------------------

let liveChoice: boolean | null = null;

function liveOn(): boolean {
  if (liveChoice !== null) return liveChoice;
  try {
    liveChoice = localStorage.getItem(LIVE_KEY) !== "0";
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
    const parsed = JSON.parse(localStorage.getItem(USED_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** A plugin was applied: it moves to the top of its section. */
export function noteUsed(id: string) {
  try {
    localStorage.setItem(USED_KEY, JSON.stringify({ ...usedAt(), [id]: Date.now() }));
  } catch {
    // The order still follows titles.
  }
}

const AUTHOR_LOCAL = "lime-slice-plugin-author";

/** The "Plugin author" setting: the library's `settings.json` where the app reads the library, else this browser's. */
export function pluginAuthor(): string {
  if (library.author) return library.author;
  try {
    return localStorage.getItem(AUTHOR_LOCAL) ?? "";
  } catch {
    return "";
  }
}

export async function setPluginAuthor(name: string): Promise<string | null> {
  const io = await libraryIo();
  try {
    localStorage.setItem(AUTHOR_LOCAL, name);
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
