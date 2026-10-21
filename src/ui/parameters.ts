/**
 * --- A6. The Parameters panel: a table of names, expressions, evaluated values, and how many
 * steps use each name. Add, delete, and reorder. Errors stay on the row. An unknown name is
 * told to add it above this row; the evaluator's own sentence stays for model_params.
 */
import { PARAM_NAME } from "../modeling/expr.ts";
import { appParamMessage, evaluateTable, expressionMentions, isPlainNumber, type ParamTable } from "../modeling/params.ts";
import { openDock } from "./dock-reveal.ts";

export interface ParameterHooks {
  table(): ParamTable;
  setTable(table: ParamTable): void;
  /** Steps on the open solid that name this parameter. */
  usedBy(name: string): number;
  /** Steps a rebuild would replay, from the earliest. */
  affected(): number;
  rebuild(): void;
  /** Remembers the open state for this project. Empty uses one shared key. */
  projectId?(): string;
}

let hooks: ParameterHooks | null = null;

/**
 * Hide Parameters while a sketch is open and none of its dimension expressions name a table entry.
 * A sketch that is closed, or that the user opened with Ctrl+Alt+P, stays visible.
 */
export function parametersHiddenWhileSketching(sketching: boolean, revealed: boolean, names: readonly string[], exprs: string): boolean {
  if (!sketching || revealed) return false;
  return !names.some((name) => expressionMentions(exprs, name));
}

/** The panel never names the MCP tool. Other evaluator sentences pass through. */
export function panelParamMessage(message: string): string {
  return appParamMessage(message, "Add it in Parameters above this row, or type a number.");
}

/** E3. Parameters sit in the Model dock under History, folded or open as the user left them. */
const FOLD_PREFIX = "lime-slice-model-params-folded:";
const FOLD_ORDER = "lime-slice-model-params-folded-order";
const FOLD_LIMIT = 50;

type FoldStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A saved path, or one shared key when the project has not been saved. */
export function parametersFoldId(projectPath: string): string {
  return projectPath.trim() || "unsaved";
}

function foldOrder(storage: FoldStorage): string[] {
  return (storage.getItem(FOLD_ORDER) ?? "").split("\n").filter(Boolean);
}

/** How many projects remember a fold. At most 50. */
export function parametersFoldCount(storage: FoldStorage): number {
  return foldOrder(storage).length;
}

/** `true` is folded. Null when this project has no stored choice. */
export function readParametersFold(storage: FoldStorage, projectPath: string): boolean | null {
  const stored = storage.getItem(FOLD_PREFIX + parametersFoldId(projectPath));
  if (stored === "1") return true;
  if (stored === "0") return false;
  return null;
}

/** Remember the fold for this path. The 51st project drops the oldest. */
export function writeParametersFold(storage: FoldStorage, projectPath: string, folded: boolean): void {
  const id = parametersFoldId(projectPath);
  storage.setItem(FOLD_PREFIX + id, folded ? "1" : "0");
  const order = foldOrder(storage).filter((item) => item !== id);
  order.push(id);
  while (order.length > FOLD_LIMIT) {
    const oldest = order.shift();
    if (oldest) storage.removeItem(FOLD_PREFIX + oldest);
  }
  storage.setItem(FOLD_ORDER, order.join("\n"));
}

/** A stored choice wins. With none, an empty table starts collapsed. */
function readFolded(count: number): boolean {
  try {
    const stored = readParametersFold(localStorage, hooks?.projectId?.() ?? "");
    if (stored != null) return stored;
  } catch {
    return count === 0;
  }
  return count === 0;
}

function writeFolded(on: boolean) {
  try {
    writeParametersFold(localStorage, hooks?.projectId?.() ?? "", on);
  } catch {
    /* blocked storage: the section follows the empty-table default next time */
  }
}

export function mountParameters(next: ParameterHooks) {
  hooks = next;
  document.querySelector("#modelParamsAdd")?.addEventListener("click", () => {
    paint(true);
    // --- D33. The new row is where typing goes.
    [...document.querySelectorAll<HTMLInputElement>("#modelParamsBody [data-param-name]")].at(-1)?.focus();
  });
  // --- D33. Escape folds the section, as it closes a tool, and focus goes to its header.
  document.querySelector("#modelParamsMain")?.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    closeParameters();
    document.querySelector<HTMLButtonElement>("#modelParamsToggle")?.focus();
  });
  document.querySelector("#modelParamsToggle")?.addEventListener("click", () => {
    if (parametersOpen()) closeParameters();
    else openParameters(false);
  });
  document.querySelector("#modelParamsRebuild")?.addEventListener("click", () => hooks?.rebuild());
  document.querySelector("#modelParamsBody")?.addEventListener("input", onInput);
  document.querySelector("#modelParamsBody")?.addEventListener("click", onClick);
  setFolded(readFolded(Object.keys(next.table()).length));
  paint(false);
  const canvas = document.querySelector("#model");
  if (canvas) new MutationObserver(() => syncSketchVisibility()).observe(canvas, { attributes: true, attributeFilter: ["data-sketch", "data-sketch-exprs"] });
}

function setFolded(on: boolean) {
  const main = document.querySelector<HTMLElement>("#modelParamsMain");
  if (main) main.hidden = on;
  document.querySelector("#modelParamsToggle")?.setAttribute("aria-expanded", on ? "false" : "true");
  const section = document.querySelector<HTMLElement>("#modelParams");
  section?.setAttribute("data-collapsed", on ? "1" : "0");
  // On the phone the section is a sheet that shows only while open.
  if (on) section?.setAttribute("data-sheet", "closed");
}

/** Ctrl+Alt+P: open the section and go to its first field, or fold it. */
export function toggleParameters() {
  // Folded only from inside: from anywhere else the key goes to the parameters, opening them if need be.
  if (parametersOpen() && document.querySelector("#modelParams")?.contains(document.activeElement)) closeParameters();
  else revealParameters();
}

/** The Features menu's Parameters and Ctrl+Alt+P: the Model dock shows, the section opens, and typing goes to it. */
/** The user asked for the section, so a sketch does not hide it again until the sketch ends. */
let revealed = false;

export function revealParameters() {
  revealed = true;
  const section = document.querySelector<HTMLElement>("#modelParams");
  if (section) section.hidden = false;
  // Asked for by the user, so the dock opens as their own choice.
  openDock("left");
  section?.setAttribute("data-sheet", "open");
  openParameters(true);
  section?.scrollIntoView({ block: "nearest" });
}

/** While sketching, Parameters stays out of the way unless a dimension names one of them. */
function syncSketchVisibility() {
  const section = document.querySelector<HTMLElement>("#modelParams");
  if (!section) return;
  const canvas = document.querySelector("#model");
  const sketching = canvas?.getAttribute("data-sketch") === "editing";
  if (!sketching) revealed = false;
  const names = Object.keys(hooks?.table() ?? {});
  const exprs = canvas?.getAttribute("data-sketch-exprs") ?? "";
  section.hidden = parametersHiddenWhileSketching(sketching, revealed, names, exprs);
}

function openParameters(focus: boolean) {
  setFolded(false);
  writeFolded(false);
  paint(false);
  if (focus) document.querySelector<HTMLInputElement>("#modelParamsBody input")?.focus();
}

export function closeParameters() {
  setFolded(true);
  writeFolded(true);
}

export function parametersOpen(): boolean {
  return document.querySelector<HTMLElement>("#modelParamsMain")?.hidden === false;
}

/** The shown branch changed (another object, a new solid, a step added or dropped): only the Rebuild count follows. */
export function syncRebuildCount() {
  paintRebuild();
}

/** The table changed outside the panel, or a rebuild finished. */
export function syncParameters() {
  if (parametersOpen()) paint(false);
  else paintRebuild();
  syncSketchVisibility();
}

function onInput(ev: Event) {
  const target = ev.target;
  if (!(target instanceof HTMLInputElement)) return;
  writeFromDom();
  refreshRows();
  paintRebuild();
}

function onClick(ev: Event) {
  const target = ev.target instanceof Element ? ev.target : null;
  const row = target?.closest<HTMLElement>("[data-param-row]");
  if (!row) return;
  if (target?.closest("[data-param-delete]")) {
    row.remove();
    writeFromDom();
    paint(false);
    return;
  }
  const body = row.parentElement;
  if (!body) return;
  if (target?.closest("[data-param-up]") && row.previousElementSibling) {
    body.insertBefore(row, row.previousElementSibling);
    writeFromDom();
    paint(false);
  }
  if (target?.closest("[data-param-down]") && row.nextElementSibling) {
    body.insertBefore(row.nextElementSibling, row);
    writeFromDom();
    paint(false);
  }
}

function rowsFromTable(): { name: string; text: string }[] {
  return Object.entries(hooks?.table() ?? {}).map(([name, value]) => ({ name, text: typeof value === "number" ? String(value) : value }));
}

function paint(addBlank: boolean) {
  const body = document.querySelector<HTMLElement>("#modelParamsBody");
  if (!body || !hooks) return;
  const rows = rowsFromTable();
  if (addBlank) rows.push({ name: "", text: "" });
  body.replaceChildren();
  if (rows.length === 0) rows.push({ name: "", text: "" });
  const table = document.createElement("table");
  table.className = "model-params-table";
  const head = document.createElement("thead");
  head.innerHTML = '<tr><th>Name</th><th>Value</th><th>Evaluated</th><th>Used by</th><th><span class="sr-only">Order and delete</span></th></tr>';
  table.append(head);
  const list = document.createElement("tbody");
  rows.forEach((row, index) => list.append(rowView(row, index, rows.length)));
  table.append(list);
  body.append(table);
  refreshRows();
  paintRebuild();
}

function rowView(row: { name: string; text: string }, index: number, count: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.dataset.paramRow = String(index);
  const name = document.createElement("input");
  name.type = "text";
  name.value = row.name;
  name.spellcheck = false;
  name.autocomplete = "off";
  name.setAttribute("aria-label", "Parameter name");
  name.placeholder = "Name";
  name.dataset.paramName = "";
  const value = document.createElement("input");
  value.type = "text";
  value.value = row.text;
  value.spellcheck = false;
  value.autocomplete = "off";
  value.setAttribute("aria-label", "Value or expression");
  value.placeholder = "Value";
  value.dataset.paramValue = "";
  const evaluated = document.createElement("td");
  evaluated.dataset.paramEval = "";
  const used = document.createElement("td");
  used.dataset.paramUsed = "";
  const actions = document.createElement("td");
  actions.className = "model-params-actions";
  actions.append(iconButton("data-param-up", "Move up", index === 0), iconButton("data-param-down", "Move down", index === count - 1), iconButton("data-param-delete", "Delete", false));
  const nameCell = document.createElement("td");
  nameCell.append(name);
  const valueCell = document.createElement("td");
  valueCell.append(value);
  const error = document.createElement("p");
  error.className = "model-param-error";
  error.dataset.paramError = "";
  error.hidden = true;
  valueCell.append(error);
  tr.append(nameCell, valueCell, evaluated, used, actions);
  return tr;
}

function iconButton(attr: string, label: string, disabled: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = label === "Move up" ? "Up" : label === "Move down" ? "Down" : "Delete";
  button.setAttribute("aria-label", label);
  button.setAttribute(attr, "");
  button.disabled = disabled;
  return button;
}

/**
 * Every row's evaluated value, error, and use count, from one `evaluateTable` of the rows in the DOM. A row that
 * names an edited parameter changes with it, so the whole table is filled again after any edit.
 */
function refreshRows() {
  const rows = [...document.querySelectorAll<HTMLElement>("#modelParamsBody [data-param-row]")];
  const names = rows.map((row) => row.querySelector<HTMLInputElement>("[data-param-name]")?.value.trim() ?? "");
  const evaluated = evaluateTable(readDom());
  rows.forEach((row, index) => fillRow(row, names, index, evaluated));
}

function fillRow(row: HTMLElement, names: readonly string[], index: number, evaluated: ReturnType<typeof evaluateTable>) {
  const valueCell = row.querySelector<HTMLElement>("[data-param-eval]");
  const usedCell = row.querySelector<HTMLElement>("[data-param-used]");
  const error = row.querySelector<HTMLElement>("[data-param-error]");
  const trimmed = names[index] ?? "";
  const text = row.querySelector<HTMLInputElement>("[data-param-value]")?.value ?? "";
  let message: string | null = null;
  let value: number | null = null;
  if (!trimmed && !text.trim()) {
    if (valueCell) valueCell.textContent = "";
    if (usedCell) usedCell.textContent = "";
    if (error) error.hidden = true;
    return;
  }
  if (!trimmed) message = "Type a name.";
  else if (!PARAM_NAME.test(trimmed)) message = `"${trimmed}" is not a parameter name. Use letters, digits, and underscores.`;
  else if (names.indexOf(trimmed) !== index) message = `"${trimmed}" is already a parameter.`;
  else {
    const rowResult = evaluated.rows.find((item) => item.name === trimmed);
    message = rowResult?.error ?? null;
    value = rowResult?.value ?? null;
  }
  if (message) message = panelParamMessage(message);
  if (valueCell) valueCell.textContent = value != null && Number.isFinite(value) ? String(value) : "";
  if (usedCell) usedCell.textContent = !message && PARAM_NAME.test(trimmed) ? String(hooks?.usedBy(trimmed) ?? 0) : "";
  if (error) {
    error.hidden = !message;
    error.textContent = message ?? "";
  }
}

function readDom(): ParamTable {
  const out: ParamTable = {};
  const seen = new Set<string>();
  document.querySelectorAll<HTMLElement>("#modelParamsBody [data-param-row]").forEach((row) => {
    const name = row.querySelector<HTMLInputElement>("[data-param-name]")?.value.trim() ?? "";
    const text = row.querySelector<HTMLInputElement>("[data-param-value]")?.value ?? "";
    if (!name || !PARAM_NAME.test(name) || seen.has(name)) return;
    seen.add(name);
    const trimmed = text.trim();
    out[name] = isPlainNumber(trimmed) ? Number(trimmed) : trimmed;
  });
  return out;
}

function writeFromDom() {
  hooks?.setTable(readDom());
  syncSketchVisibility();
}

function paintRebuild() {
  const counter = document.querySelector("#modelParamsCount");
  const named = `· ${Object.keys(hooks?.table() ?? {}).length}`;
  if (counter && counter.textContent !== named) counter.textContent = named;
  const button = document.querySelector<HTMLButtonElement>("#modelParamsRebuild");
  if (!button) return;
  const count = hooks?.affected() ?? 0;
  button.hidden = count === 0;
  button.textContent = count === 1 ? "Rebuild 1 step" : `Rebuild ${count} steps`;
}
