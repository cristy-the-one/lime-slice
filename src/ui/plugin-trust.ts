/**
 * --- The import and first-run view (docs/plan-recipe-plugins.md D10, D11.5, D11.6, milestone 8). One sheet, two uses:
 *
 * - **Import**: a plugin file picked, dropped, or carried by a project, before it joins the library. It shows who made
 *   it, its hash, what it carries and its code, and on a name clash offers Keep both, Replace (or Update) and Cancel.
 * - **First run**: an imported plugin's first Preview, Apply or Rebuild. The same facts and code, with what it may do
 *   in one sentence, then Run or Cancel. After Run it runs like any other.
 *
 * Plugin text (title, description, author, made-by, lessons) is set as text, never markup: it is data (D11.5).
 */
import { MAY_DO, type ImportFile } from "../plugins/share";
import { dataSize, elideData } from "../recipe/plugin-data";
import { carriesText } from "../plugins/share";

export type TrustChoice = "add" | "keep-both" | "replace" | "run" | null;

export interface TrustView {
  mode: "import" | "first-run";
  /** Where it came from, said in the sub line: "a file", "this project", "an MCP call". */
  from: string;
  file: Pick<ImportFile, "id" | "kind" | "title" | "version" | "description" | "author" | "madeBy" | "api" | "sha256" | "headerSha" | "ingredients" | "data" | "presets" | "lessons" | "body">;
  /** A name clash at import: the id it would be kept beside, and whether the file is a newer version. */
  clash?: { keepBoth: string; version: number; newer: boolean };
}

let sheet: HTMLElement | null = null;
let settle: ((choice: TrustChoice) => void) | null = null;
let returnFocus: HTMLElement | null = null;

function build(): HTMLElement {
  const node = document.createElement("div");
  node.id = "pluginTrust";
  node.className = "sheet";
  node.hidden = true;
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-modal", "true");
  node.setAttribute("aria-labelledby", "pluginTrustTitle");
  node.innerHTML = `
    <div class="sheet-card pt-card">
      <div class="sheet-head"><h2 id="pluginTrustTitle"></h2></div>
      <p class="pt-sub" id="pluginTrustSub"></p>
      <dl class="pt-facts" id="pluginTrustFacts"></dl>
      <p class="pt-desc" id="pluginTrustDesc"></p>
      <p class="pt-warn" id="pluginTrustWarn" hidden></p>
      <p class="pt-may" id="pluginTrustMay"></p>
      <pre class="mh-source pt-source" tabindex="0" aria-label="The plugin's code, read-only"><code id="pluginTrustCode"></code></pre>
      <p class="pt-clash" id="pluginTrustClash" hidden></p>
      <div class="pt-actions" id="pluginTrustActions"></div>
    </div>`;
  node.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-choice]") : null;
    if (target) {
      finish((target.dataset.choice || null) as TrustChoice);
      return;
    }
    const copy = ev.target instanceof Element ? ev.target.closest<HTMLElement>("#pluginTrustCopy") : null;
    if (copy) void copyHash(copy);
  });
  node.addEventListener("pointerdown", (ev) => {
    if (ev.target === node) finish(null);
  });
  node.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(null);
  });
  document.body.append(node);
  return node;
}

async function copyHash(button: HTMLElement) {
  const hash = sheet?.querySelector<HTMLElement>("#pluginTrustHash")?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(hash);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Select it to copy";
  }
}

function finish(choice: TrustChoice) {
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  const done = settle;
  settle = null;
  returnFocus?.focus({ preventScroll: true });
  returnFocus = null;
  done?.(choice);
}

function fact(list: HTMLElement, term: string, value: string | HTMLElement) {
  const dt = Object.assign(document.createElement("dt"), { textContent: term });
  const dd = document.createElement("dd");
  if (typeof value === "string") dd.textContent = value;
  else dd.append(value);
  list.append(dt, dd);
}

function action(label: string, choice: TrustChoice, tip: string, primary = false): HTMLButtonElement {
  const b = Object.assign(document.createElement("button"), { type: "button", className: primary ? "btn primary" : "btn", textContent: label });
  b.dataset.choice = choice ?? "";
  b.dataset.tip = tip;
  b.dataset.tipIdle = tip;
  return b;
}

/** Whether the sheet is showing. */
export function trustOpen(): boolean {
  return !!sheet && !sheet.hidden;
}

/** Shows the view and resolves with the person's choice; null is Cancel (also Esc and a click outside). */
export function showTrust(view: TrustView): Promise<TrustChoice> {
  sheet ??= build();
  if (settle) finish(null);
  const f = view.file;
  const $ = <T extends HTMLElement>(id: string) => sheet!.querySelector<T>(`#${id}`)!;
  $("pluginTrustTitle").textContent = view.mode === "import" ? `Import “${f.title}”` : `Run “${f.title}” for the first time`;
  $("pluginTrustSub").textContent = view.mode === "import"
    ? `From ${view.from}. Read what it is and its code; nothing runs until you run it.`
    : `It came from ${view.from}. Read its code before its first run; after that, it runs like your own plugins.`;
  const facts = $("pluginTrustFacts");
  facts.replaceChildren();
  fact(facts, "Author", f.author && f.author !== "unknown" ? f.author : "Not named");
  fact(facts, "Made with", f.madeBy || "Not named");
  fact(facts, "Version", `v${f.version} · recipe API ${f.api}`);
  const hash = document.createElement("span");
  hash.className = "pt-hash-row";
  const code = Object.assign(document.createElement("code"), { id: "pluginTrustHash", className: "pt-hash", textContent: f.sha256 });
  const copy = Object.assign(document.createElement("button"), { type: "button", id: "pluginTrustCopy", className: "btn pt-copy", textContent: "Copy" });
  copy.dataset.tip = "Copy the hash, to compare it with the one its author sees.";
  hash.append(code, copy);
  fact(facts, "Hash (SHA-256)", hash);
  fact(facts, "Carries", carriesText(f, dataSize) || "Only its code");
  $("pluginTrustDesc").textContent = f.description ? `Its description: “${f.description}”` : "It has no description.";
  const warn = $("pluginTrustWarn");
  const changed = !!f.headerSha && f.headerSha !== f.sha256;
  warn.hidden = !changed;
  warn.textContent = changed ? "Its code was changed after it was kept: the hash in its header does not match the code. The hash above is the code's." : "";
  $("pluginTrustMay").textContent = f.kind === "animation" ? "It can pose only the assembly you choose. It cannot change geometry, read files, use the network or start programs." : MAY_DO;
  $("pluginTrustCode").textContent = elideData(f.body.replace(/^\n+/, ""));
  const clash = $("pluginTrustClash");
  clash.hidden = !view.clash;
  clash.textContent = view.clash
    ? `Your library already has a plugin named ${f.id} (v${view.clash.version}) with other code. ${view.clash.newer ? `This file is v${f.version}, a newer version of it.` : "Keep both, or replace yours with this one."}`
    : "";
  const actions = $("pluginTrustActions");
  actions.replaceChildren();
  if (view.mode === "first-run") {
    actions.append(action("Cancel", null, "Nothing runs. It stays marked imported."), action("Run", "run", "Run it now. From now on it runs without asking.", true));
  } else if (view.clash) {
    actions.append(
      action("Cancel", null, "Nothing is added."),
      // The safe choice leads; an update of the same plugin leads when the file is newer (D10).
      action(`Keep both (as ${view.clash.keepBoth})`, "keep-both", `Add it beside yours as ${view.clash.keepBoth}. Yours stays as it is.`, !view.clash.newer),
      action(view.clash.newer ? `Update to v${f.version}` : "Replace yours", "replace", `Yours is kept as an older version (v${view.clash.version}); this one becomes current.`, view.clash.newer),
    );
  } else {
    actions.append(action("Cancel", null, "Nothing is added."), action("Add to library", "add", "Add it to your plugins, marked imported until its first run.", true));
  }
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  sheet.hidden = false;
  sheet.querySelector<HTMLElement>(".pt-source")!.scrollTop = 0;
  sheet.querySelector<HTMLElement>(".pt-actions .primary")?.focus({ preventScroll: true });
  return new Promise((resolve) => {
    settle = resolve;
  });
}
