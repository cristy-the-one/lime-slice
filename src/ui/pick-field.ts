/**
 * --- Recipe API 1.2: a `face` or `outline` value in a plugin's form, the same in the Plugins panel and in a plugin
 * step's History card. A face shows what is picked (or the default rule) and **Pick face**, which waits for a click on
 * a flat face in the viewport; an outline offers **Pick a sketch** (the sketch steps on the plate) and **Use a face's
 * outline**. **Use default** drops the pick. The form's owner handles the buttons through their `data-pick-act`.
 */
import { pickText, stepOf } from "../recipe/picks";

/** A sketch a person may pick: an extrude's or a revolve's step with an outline, on a part on the plate. */
export interface SketchChoice {
  object: string;
  step: number;
  label: string;
}

export interface PickFieldSpec {
  name: string;
  label: string;
  kind: "face" | "outline";
  help?: string;
  /** The value now: a pick, or undefined for the declared default. */
  value: unknown;
  fallback: unknown;
  editable: boolean;
  /** This field waits for a face click. */
  picking: boolean;
  /** The value differs from what the step was built with (History) or from the default (the panel). */
  typed: boolean;
  sketches: readonly SketchChoice[];
  /** A greyed button's reason, when the field cannot pick now (no part on screen). */
  blocked?: string;
}

const PURPOSE = {
  face: "Pick a flat face of the part in the view. Esc cancels.",
  facePicking: "Click a flat face of the part in the view. Esc cancels.",
  outlineFace: "Use the outline of a flat face you click in the view.",
  sketch: "Use the outline of a sketch on the plate: an extrude's or a revolve's step.",
  clear: "Drop the pick and use the plugin's default.",
};

/** What a field shows for its value: the pick, else the default with "default", else that one is needed. */
export function pickValueText(kind: "face" | "outline", value: unknown, fallback: unknown): string {
  if (value !== undefined && value !== null) return pickText(value);
  if (fallback !== undefined && fallback !== null) return `${pickText(fallback)} (default)`;
  return kind === "face" ? "No face yet: pick one" : "No outline yet: pick one";
}

export function pickField(spec: PickFieldSpec): HTMLElement {
  const row = document.createElement("div");
  row.className = "mh-plugin-field mh-pick-field";
  row.dataset.pickField = spec.name;
  if (spec.help) row.dataset.tip = spec.help;
  const name = Object.assign(document.createElement("span"), { className: "mh-plugin-name", textContent: spec.label });
  const shown = Object.assign(document.createElement("span"), { className: "mh-pick-value", textContent: pickValueText(spec.kind, spec.value, spec.fallback) });
  shown.dataset.name = spec.name;
  shown.toggleAttribute("data-typed", spec.typed);
  if (spec.value === undefined || spec.value === null) shown.classList.add(spec.fallback === undefined || spec.fallback === null ? "is-missing" : "is-default");
  const actions = document.createElement("div");
  actions.className = "mh-pick-actions";
  const button = (act: string, text: string, tip: string, pressed = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn mh-pick-btn";
    b.dataset.pickAct = act;
    b.dataset.name = spec.name;
    b.textContent = text;
    b.dataset.tip = spec.blocked && act !== "clear" ? `${tip}\n${spec.blocked}` : tip;
    if (pressed) b.setAttribute("aria-pressed", "true");
    if (!spec.editable || (spec.blocked && act !== "clear")) {
      b.disabled = true;
      if (spec.blocked) b.dataset.reason = spec.blocked;
    }
    return b;
  };
  if (spec.kind === "face") {
    actions.append(button("face", spec.picking ? "Click a face…" : "Pick face", spec.picking ? PURPOSE.facePicking : PURPOSE.face, spec.picking));
  } else {
    const select = document.createElement("select");
    select.className = "mh-pick-sketch";
    select.dataset.pickAct = "sketch";
    select.dataset.name = spec.name;
    select.dataset.tip = PURPOSE.sketch;
    select.setAttribute("aria-label", `${spec.label}: pick a sketch`);
    const current = spec.value && typeof spec.value === "object" ? (spec.value as { sketch?: unknown; object?: unknown }) : null;
    const at = current?.sketch !== undefined ? `${String(current.object ?? "")}|${stepOf(current.sketch)}` : "";
    select.append(new Option(spec.sketches.length ? "Pick a sketch…" : "No sketches on the plate", "", false, at === ""));
    for (const s of spec.sketches) select.append(new Option(s.label, `${s.object}|${s.step}`, false, `${s.object}|${s.step}` === at));
    select.disabled = !spec.editable || spec.sketches.length === 0;
    actions.append(select, button("outline-face", spec.picking ? "Click a face…" : "Use a face's outline", spec.picking ? PURPOSE.facePicking : PURPOSE.outlineFace, spec.picking));
  }
  if (spec.value !== undefined && spec.value !== null && (spec.fallback !== undefined && spec.fallback !== null)) actions.append(button("clear", "Use default", PURPOSE.clear));
  row.append(name, shown, actions);
  return row;
}

/** The value a sketch choice stands for. */
export function sketchValue(choice: string): { sketch: number; object: string } | null {
  const bar = choice.lastIndexOf("|");
  if (bar <= 0) return null;
  const step = Number(choice.slice(bar + 1));
  return Number.isInteger(step) ? { sketch: step, object: choice.slice(0, bar) } : null;
}
