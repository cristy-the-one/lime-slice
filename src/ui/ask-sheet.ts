/**
 * The app's own question sheet, in place of `window.confirm` and `window.prompt`: a title, a sentence, an optional
 * text field, Cancel and one action. It is built like the Save as plugin… sheet (`.sheet` > `.sheet-card`) so it
 * follows the theme. Enter confirms, Esc and a click outside cancel, Tab stays inside, and the focus goes back to where
 * it was. A field is checked as the person types: while its `problem` answers a sentence, the sentence shows under the
 * field and the action is disabled, so an invalid value is never handed back.
 */

import { html, setHtml } from "./html.ts";

export interface AskInput {
  /** The field's visible label. */
  label: string;
  /** The text the field starts with, selected. */
  value?: string;
  placeholder?: string;
  maxLength?: number;
  /** Why this value cannot be used, ending with what to type, or null when it can. Called on every keystroke. */
  problem?: (value: string) => string | null;
}

export interface AskOptions {
  title: string;
  /** One or two sentences under the title, as text. */
  body?: string;
  /** The action's label, a verb: "Remove", "Save", "Discard". */
  confirmLabel: string;
  cancelLabel?: string;
  /** The action removes or drops something: the button is drawn as a warning. */
  danger?: boolean;
  input?: AskInput;
}

const ID = "askSheet";

let sheet: HTMLElement | null = null;
let settle: ((answer: string | null) => void) | null = null;
let returnFocus: HTMLElement | null = null;
let overlayBefore: string | undefined;
let problemOf: ((value: string) => string | null) | null = null;

function parts(node: HTMLElement) {
  return {
    form: node.querySelector<HTMLFormElement>("form")!,
    title: node.querySelector<HTMLElement>(`#${ID}Title`)!,
    body: node.querySelector<HTMLElement>(`#${ID}Body`)!,
    field: node.querySelector<HTMLElement>(`#${ID}Field`)!,
    label: node.querySelector<HTMLElement>(`#${ID}Label`)!,
    input: node.querySelector<HTMLInputElement>(`#${ID}Input`)!,
    problem: node.querySelector<HTMLElement>(`#${ID}Problem`)!,
    cancel: node.querySelector<HTMLButtonElement>('[data-ask="cancel"]')!,
    confirm: node.querySelector<HTMLButtonElement>('[data-ask="confirm"]')!,
  };
}

function build(): HTMLElement {
  const node = document.createElement("div");
  node.id = ID;
  node.className = "sheet ask-sheet";
  node.hidden = true;
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-modal", "true");
  node.setAttribute("aria-labelledby", `${ID}Title`);
  node.setAttribute("aria-describedby", `${ID}Body`);
  // Constant markup: every word of a question goes in through textContent below.
  setHtml(node, html`
    <form class="sheet-card ask-card" novalidate>
      <div class="sheet-head"><h2 id="${ID}Title"></h2></div>
      <p class="ask-body" id="${ID}Body"></p>
      <label class="mh-save-field ask-field" id="${ID}Field" hidden><span id="${ID}Label"></span><input id="${ID}Input" type="text" spellcheck="false" autocomplete="off" aria-describedby="${ID}Problem"></label>
      <p class="mh-save-status is-problem ask-problem" id="${ID}Problem" role="status" aria-live="polite" hidden></p>
      <div class="mh-save-actions ask-actions"><button class="btn" type="button" data-ask="cancel">Cancel</button><button class="btn primary" type="submit" data-ask="confirm">OK</button></div>
    </form>`);
  const p = parts(node);
  p.cancel.addEventListener("click", () => finish(null));
  node.addEventListener("pointerdown", (ev) => {
    if (ev.target === node) finish(null);
  });
  node.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
      return;
    }
    if (ev.key === "Tab") trapTab(node, ev);
    // Enter on the field submits the form; Enter on a button presses it. Nothing else under the sheet hears keys.
    ev.stopPropagation();
  });
  p.input.addEventListener("input", () => check(true));
  p.form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!check(true)) return;
    finish(p.field.hidden ? "" : p.input.value.trim());
  });
  document.body.append(node);
  return node;
}

function trapTab(node: HTMLElement, ev: KeyboardEvent) {
  const focusable = [...node.querySelectorAll<HTMLElement>("input, button")].filter((el) => !el.closest("[hidden]") && !(el as HTMLButtonElement).disabled);
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const at = document.activeElement;
  if (ev.shiftKey && (at === first || !node.contains(at))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (at === last || !node.contains(at))) {
    ev.preventDefault();
    first.focus();
  }
}

/** Paint the field's problem and the action's state; true when the answer can be used. */
function check(typed: boolean): boolean {
  if (!sheet) return false;
  const p = parts(sheet);
  if (p.field.hidden || !problemOf) {
    p.confirm.disabled = false;
    return true;
  }
  const value = p.input.value.trim();
  const problem = problemOf(value);
  // An empty field the person has not typed in yet only disables the action; the sentence waits for a keystroke.
  const say = problem && (typed || value !== "") ? problem : null;
  p.problem.textContent = say ?? "";
  p.problem.hidden = !say;
  p.input.setAttribute("aria-invalid", problem ? "true" : "false");
  p.confirm.disabled = !!problem;
  return !problem;
}

function finish(answer: string | null) {
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  if (document.documentElement.dataset.overlay === "ask") {
    if (overlayBefore) document.documentElement.dataset.overlay = overlayBefore;
    else delete document.documentElement.dataset.overlay;
  }
  const done = settle;
  settle = null;
  problemOf = null;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
  done?.(answer);
}

/**
 * Ask a question in the app's sheet. With `input`, resolves to the trimmed value the person confirmed, which passed
 * `problem`; without, to "" on the action. Cancel, Esc and a click outside resolve to null.
 */
export function askSheet(options: AskOptions): Promise<string | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  sheet ??= build();
  // A second question replaces an open one, which counts as cancelled.
  if (!sheet.hidden) finish(null);
  const p = parts(sheet);
  p.title.textContent = options.title;
  p.body.textContent = options.body ?? "";
  p.body.hidden = !options.body;
  p.cancel.textContent = options.cancelLabel ?? "Cancel";
  p.confirm.textContent = options.confirmLabel;
  p.confirm.classList.toggle("primary", !options.danger);
  p.confirm.classList.toggle("ask-danger", !!options.danger);
  const input = options.input;
  p.field.hidden = !input;
  problemOf = input?.problem ?? null;
  if (input) {
    p.label.textContent = input.label;
    p.input.value = input.value ?? "";
    p.input.placeholder = input.placeholder ?? "";
    if (input.maxLength) p.input.maxLength = input.maxLength;
    else p.input.removeAttribute("maxlength");
  } else p.input.value = "";
  p.problem.hidden = true;
  p.problem.textContent = "";
  check(false);
  returnFocus = document.activeElement instanceof HTMLElement && !sheet.contains(document.activeElement) ? document.activeElement : null;
  overlayBefore = document.documentElement.dataset.overlay;
  document.documentElement.dataset.overlay = "ask";
  sheet.hidden = false;
  if (input) {
    p.input.focus();
    p.input.select();
  } else p.confirm.focus();
  return new Promise((resolve) => {
    settle = resolve;
  });
}

/** A yes-or-no question: true when the person took the action. */
export async function confirmSheet(options: Omit<AskOptions, "input">): Promise<boolean> {
  return (await askSheet(options)) !== null;
}
