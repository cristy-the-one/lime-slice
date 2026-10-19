/**
 * --- A6. The Parameters panel: a table of names, expressions, evaluated values, and how many
 * steps use each name. Add, delete, and reorder. Errors stay on the row. An unknown name is
 * told to add it above this row; the evaluator's own sentence stays for model_params.
 */
import { PARAM_NAME } from "../modeling/expr.ts";
import { evaluateTable, isPlainNumber, type ParamTable } from "../modeling/params.ts";

export interface ParameterHooks {
  table(): ParamTable;
  setTable(table: ParamTable): void;
  /** Steps on the open solid that name this parameter. */
  usedBy(name: string): number;
  /** Steps a rebuild would replay, from the earliest. */
  affected(): number;
  rebuild(): void;
}

let hooks: ParameterHooks | null = null;

/** The panel never names the MCP tool. Other evaluator sentences pass through. */
export function panelParamMessage(message: string): string {
  return message.replace("Set it with model_params first.", "Add it in Parameters above this row, or type a number.");
}

export function mountParameters(next: ParameterHooks) {
  hooks = next;
  document.querySelector("#modelParamsAdd")?.addEventListener("click", () => {
    paint(true);
  });
  document.querySelector("#modelParamsClose")?.addEventListener("click", () => closeParameters());
  document.querySelector("#modelParamsRebuild")?.addEventListener("click", () => hooks?.rebuild());
  document.querySelector("#modelParamsBody")?.addEventListener("input", onInput);
  document.querySelector("#modelParamsBody")?.addEventListener("click", onClick);
}

export function toggleParameters() {
  const panel = document.querySelector<HTMLElement>("#modelParams");
  if (!panel) return;
  if (panel.hidden) openParameters();
  else closeParameters();
}

export function openParameters() {
  const panel = document.querySelector<HTMLElement>("#modelParams");
  if (!panel) return;
  panel.hidden = false;
  paint(false);
  panel.querySelector<HTMLInputElement>("input")?.focus();
}

export function closeParameters() {
  const panel = document.querySelector<HTMLElement>("#modelParams");
  if (panel) panel.hidden = true;
}

export function parametersOpen(): boolean {
  return document.querySelector<HTMLElement>("#modelParams")?.hidden === false;
}

/** The table changed outside the panel, or a rebuild finished. */
export function syncParameters() {
  if (parametersOpen()) paint(false);
  else paintRebuild();
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
  head.innerHTML = "<tr><th>Name</th><th>Value</th><th>Evaluated</th><th>Used by</th><th></th></tr>";
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
  name.dataset.paramName = "";
  const value = document.createElement("input");
  value.type = "text";
  value.value = row.text;
  value.spellcheck = false;
  value.autocomplete = "off";
  value.setAttribute("aria-label", "Value or expression");
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
}

function paintRebuild() {
  const button = document.querySelector<HTMLButtonElement>("#modelParamsRebuild");
  if (!button) return;
  const count = hooks?.affected() ?? 0;
  button.hidden = count === 0;
  button.textContent = count === 1 ? "Rebuild 1 step" : `Rebuild ${count} steps`;
}
