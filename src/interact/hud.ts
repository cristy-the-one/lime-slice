/**
 * Heads-up dimensions: a small box at the pointer with one to three live sizes ("12.5 mm · 30°").
 * Typing edits the active one, including an expression. Tab moves on, Enter sets them, Esc cancels.
 * The box is an aria-live region. Nothing here is drawn until a tool calls `mountHud`.
 */

import { evaluate, ExprError, type Params } from "../../mcp/expr.ts";

export type { Params };

/** How many sizes the box will show. A fourth is dropped. */
export const HUD_MAX_FIELDS = 3;

export interface HudField {
  id: string;
  /** Spoken name, such as "Distance". */
  label: string;
  /** "mm", "°", or "" when the number stands alone. */
  unit: string;
  value: number;
  /** Decimal places while the value is live. Default 1, and trailing zeros are dropped. */
  places?: number;
}

export interface HudModel {
  fields: HudField[];
  active: number;
  /** Null while the live value is showing. A string is what the user has typed so far. */
  draft: string | null;
  error: string | null;
  /** Text committed into each field, or null when that field was never typed. */
  texts: (string | null)[];
}

export interface HudCommit {
  values: number[];
  texts: (string | null)[];
}

export type HudResult =
  | { type: "change"; model: HudModel }
  | { type: "commit"; model: HudModel; values: number[]; texts: (string | null)[] }
  | { type: "cancel"; model: HudModel }
  | { type: "error"; model: HudModel };

/** The line a tool can put in the readout while the box is open. */
export const HUD_HINT = "Type a number. Tab moves between dimensions, Enter sets them, Esc cancels.";

export function emptyHud(fields: readonly HudField[] = []): HudModel {
  const kept = fields.slice(0, HUD_MAX_FIELDS).map(copyField);
  return { fields: kept, active: 0, draft: null, error: null, texts: kept.map(() => null) };
}

/** "12.5 mm · 30°". The active field shows the typed text while there is a draft. */
export function hudText(model: HudModel): string {
  return model.fields
    .map((field, index) => {
      if (index === model.active && model.draft != null) return model.draft;
      return formatDimension(field.value, field.unit, field.places);
    })
    .join(" · ");
}

export function formatDimension(value: number, unit: string, places = 1): string {
  const text = formatNumber(value, places);
  if (!unit) return text;
  if (unit === "°") return `${text}°`;
  return `${text} ${unit}`;
}

export function formatNumber(value: number, places = 1): string {
  if (!Number.isFinite(value)) return "";
  const scale = 10 ** Math.max(0, places);
  const rounded = Math.round(value * scale) / scale;
  if (Object.is(rounded, -0)) return "0";
  let text = rounded.toFixed(Math.max(0, places));
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

/**
 * One key. Digits, a sign, a dot and the rest of an expression edit the active size.
 * Tab and Shift+Tab move, after evaluating what was typed. Enter sets every size. Esc cancels.
 * A bad expression stays put and keeps a sentence in `error`.
 */
export function hudKey(model: HudModel, key: string, params: Params = {}, shift = false): HudResult {
  const name = keyName(key);
  if (name === "Escape") return { type: "cancel", model };
  if (name === "Tab") {
    const settled = settle(model, params);
    if (settled.error) return { type: "error", model: settled.model };
    const count = settled.model.fields.length;
    const step = shift ? -1 : 1;
    const active = count === 0 ? 0 : (settled.model.active + step + count) % count;
    return { type: "change", model: { ...settled.model, active, draft: null, error: null } };
  }
  if (name === "Enter") {
    const settled = settle(model, params);
    if (settled.error) return { type: "error", model: settled.model };
    return {
      type: "commit",
      model: { ...settled.model, draft: null, error: null },
      values: settled.model.fields.map((field) => field.value),
      texts: settled.model.texts,
    };
  }
  if (name === "Backspace") {
    const current = model.draft ?? shown(model);
    return { type: "change", model: { ...model, draft: current.slice(0, -1), error: null } };
  }
  if (name === "Delete") return { type: "change", model: { ...model, draft: "", error: null } };
  if (name.length !== 1 || !EDITABLE.test(name)) return { type: "change", model };
  const draft = model.draft == null ? name : model.draft + name;
  return { type: "change", model: { ...model, draft, error: null } };
}

/** Replace live values from a drag. A field being typed is left alone. */
export function hudSetValues(model: HudModel, values: readonly number[]): HudModel {
  const fields = model.fields.map((field, index) => {
    if (index === model.active && model.draft != null) return field;
    const value = values[index];
    return value == null || !Number.isFinite(value) ? field : { ...field, value };
  });
  return { ...model, fields };
}

export interface HudBox {
  left: number;
  top: number;
}

/**
 * Where the box sits, in the same coordinates as the pointer. It prefers just below and to the
 * right, flips toward the pointer when that would leave the frame, and does not cover the pointer
 * when the frame has room.
 */
export function placeHud(
  pointer: { x: number; y: number },
  box: { width: number; height: number },
  frame: { width: number; height: number },
  gap = 14,
  margin = 4,
): HudBox {
  const width = Math.max(0, box.width);
  const height = Math.max(0, box.height);
  let left = pointer.x + gap;
  let top = pointer.y + gap;
  if (left + width > frame.width - margin) left = pointer.x - gap - width;
  if (top + height > frame.height - margin) top = pointer.y - gap - height;
  const maxLeft = Math.max(margin, frame.width - width - margin);
  const maxTop = Math.max(margin, frame.height - height - margin);
  left = Math.min(Math.max(left, margin), maxLeft);
  top = Math.min(Math.max(top, margin), maxTop);
  if (covers(left, top, width, height, pointer) && pointer.y - gap - height >= margin) {
    top = pointer.y - gap - height;
  }
  return { left, top };
}

export interface HudMount {
  element: HTMLElement;
  readonly shown: boolean;
  open(fields: readonly HudField[], at: { x: number; y: number }, params?: Params): void;
  move(at: { x: number; y: number }): void;
  setValues(values: readonly number[]): void;
  setParams(params: Params): void;
  close(): void;
  destroy(): void;
  onCommit(cb: (commit: HudCommit) => void): void;
  onCancel(cb: () => void): void;
  /** A typed expression evaluated cleanly, before Enter. */
  onEdit(cb: (values: readonly number[]) => void): void;
}

/**
 * The floating box. `at` is in the parent's coordinates, the same way the drag tip is placed.
 * Keys are taken while it is open: on the box itself, and from anywhere else, so a drag that
 * still owns the canvas can be typed into. Ctrl, Cmd and Alt are left for the app.
 */
export function mountHud(parent: HTMLElement): HudMount {
  const element = document.createElement("div");
  element.className = "interact-hud";
  element.role = "group";
  element.setAttribute("aria-label", "Dimensions");
  element.hidden = true;
  const live = document.createElement("p");
  live.className = "interact-hud-live";
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  const fields = document.createElement("div");
  fields.className = "interact-hud-fields";
  const error = document.createElement("p");
  error.className = "interact-hud-error";
  error.setAttribute("aria-hidden", "true");
  element.append(live, fields, error);
  parent.append(element);

  let model = emptyHud();
  let params: Params = {};
  let shown = false;
  let at = { x: 0, y: 0 };
  const inputs: HTMLInputElement[] = [];
  let commitCb: (commit: HudCommit) => void = () => {};
  let cancelCb: () => void = () => {};
  let editCb: (values: readonly number[]) => void = () => {};

  const place = () => {
    const rect = element.getBoundingClientRect();
    const frame = parent.getBoundingClientRect();
    const spot = placeHud(at, { width: rect.width, height: rect.height }, { width: frame.width, height: frame.height });
    element.style.left = `${spot.left}px`;
    element.style.top = `${spot.top}px`;
  };

  const paint = () => {
    live.textContent = model.error ? `${hudText(model)}. ${model.error}` : hudText(model);
    error.textContent = model.error ?? "";
    element.dataset.hud = hudText(model);
    element.dataset.hudActive = String(model.active);
    inputs.forEach((input, index) => {
      const field = model.fields[index];
      if (!field) return;
      const text = index === model.active && model.draft != null ? model.draft : formatNumber(field.value, field.places ?? 1);
      if (input.value !== text) input.value = text;
      input.style.width = `${Math.min(24, Math.max(4, text.length + 1))}ch`;
      input.classList.toggle("is-active", index === model.active);
      input.setAttribute("aria-invalid", model.error && index === model.active ? "true" : "false");
    });
    if (shown) place();
  };

  const apply = (result: HudResult) => {
    model = result.model;
    paint();
    if (result.type === "commit") commitCb({ values: result.values, texts: result.texts });
    if (result.type === "cancel") cancelCb();
    if (result.type === "change" && model.draft != null) {
      const values = preview(model, params);
      if (values) editCb(values);
    }
    const input = inputs[model.active];
    if (shown && input && document.activeElement !== input) input.focus({ preventScroll: true });
  };

  const onKey = (ev: KeyboardEvent) => {
    if (!shown) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const key = keyName(ev.key);
    const command = key === "Tab" || key === "Enter" || key === "Escape";
    const inside = element.contains(ev.target as Node);
    if (inside && !command) return;
    if (!command && (key.length !== 1 || !EDITABLE.test(key)) && key !== "Backspace" && key !== "Delete") return;
    ev.preventDefault();
    apply(hudKey(model, key, params, ev.shiftKey));
  };

  const onInput = (ev: Event) => {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement)) return;
    const index = inputs.indexOf(input);
    if (index < 0) return;
    model = { ...model, active: index, draft: input.value, error: null };
    paint();
    const values = preview(model, params);
    if (values) editCb(values);
  };

  const rebuild = () => {
    fields.replaceChildren();
    inputs.length = 0;
    model.fields.forEach((field, index) => {
      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "interact-hud-sep";
        sep.textContent = "·";
        sep.setAttribute("aria-hidden", "true");
        fields.append(sep);
      }
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", field.label);
      input.addEventListener("input", onInput);
      input.addEventListener("focus", () => {
        if (model.active !== index) model = { ...model, active: index, draft: null, error: null };
        paint();
      });
      const unit = document.createElement("span");
      unit.className = "interact-hud-unit";
      unit.textContent = field.unit;
      label.append(input, unit);
      fields.append(label);
      inputs.push(input);
    });
  };

  // Capture, so Esc, Tab and Enter are taken before the app's own key handler, which looks at
  // defaultPrevented. A tool that is only listening in the bubble phase then leaves this box alone.
  window.addEventListener("keydown", onKey, true);

  return {
    element,
    get shown() {
      return shown;
    },
    open(next, spot, nextParams) {
      params = nextParams ?? params;
      model = emptyHud(next);
      at = spot;
      shown = true;
      element.hidden = false;
      rebuild();
      paint();
      inputs[0]?.focus({ preventScroll: true });
    },
    move(spot) {
      at = spot;
      if (shown) place();
    },
    setValues(values) {
      model = hudSetValues(model, values);
      if (shown) paint();
    },
    setParams(next) {
      params = next;
    },
    close() {
      shown = false;
      element.hidden = true;
      model = { ...model, draft: null, error: null };
    },
    destroy() {
      shown = false;
      window.removeEventListener("keydown", onKey, true);
      element.remove();
    },
    onCommit(cb) {
      commitCb = cb;
    },
    onCancel(cb) {
      cancelCb = cb;
    },
    onEdit(cb) {
      editCb = cb;
    },
  };
}

const EDITABLE = /^[0-9A-Za-z_+\-*/^(). ]$/;

function keyName(key: string): string {
  if (key === "NumpadEnter") return "Enter";
  if (key === "Decimal") return ".";
  if (key === "Subtract" || key === "NumpadSubtract") return "-";
  if (key === "Add" || key === "NumpadAdd") return "+";
  if (key === "Multiply" || key === "NumpadMultiply") return "*";
  if (key === "Divide" || key === "NumpadDivide") return "/";
  return key;
}

function shown(model: HudModel): string {
  const field = model.fields[model.active];
  return field ? formatNumber(field.value, field.places ?? 1) : "";
}

/** Evaluate the draft into the active field. `error` is set when the text is not a number. */
function settle(model: HudModel, params: Params): { model: HudModel; error: boolean } {
  if (model.draft == null) return { model, error: false };
  const field = model.fields[model.active];
  if (!field) return { model: { ...model, draft: null }, error: false };
  const text = model.draft.trim();
  if (text === "") return { model: { ...model, draft: null, error: null }, error: false };
  try {
    const value = evaluate(text, params);
    const fields = model.fields.map((item, index) => (index === model.active ? { ...item, value } : item));
    const texts = model.texts.map((item, index) => (index === model.active ? text : item));
    return { model: { ...model, fields, texts, draft: null, error: null }, error: false };
  } catch (err) {
    return { model: { ...model, error: refusal(err) }, error: true };
  }
}

function preview(model: HudModel, params: Params): number[] | null {
  if (model.draft == null || model.draft.trim() === "") return null;
  try {
    const value = evaluate(model.draft.trim(), params);
    return model.fields.map((field, index) => (index === model.active ? value : field.value));
  } catch {
    return null;
  }
}

function refusal(err: unknown): string {
  const message = err instanceof ExprError ? err.message : "Type a number or an expression.";
  return message.replace("Set it with model_params first.", "Add it in Parameters, or type a number.");
}

function copyField(field: HudField): HudField {
  return { id: field.id, label: field.label, unit: field.unit, value: field.value, places: field.places };
}

function covers(left: number, top: number, width: number, height: number, pointer: { x: number; y: number }): boolean {
  return pointer.x >= left && pointer.x <= left + width && pointer.y >= top && pointer.y <= top + height;
}
