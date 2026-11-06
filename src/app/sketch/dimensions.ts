/** Dimension labels and constraint marks on the canvas. */
import { S } from "./state";
import { placeFixed } from "./chooser";
import { drawingFrame, publish } from "./view";
import { type SketchData } from "../../sketch/model";
import { toWorld } from "../../sketch/frame";
import { activeSketch, inferenceMarks, selectConstraint, acknowledgeDimensionFocus, editDimension, commitDimensionText, blurDimensionText } from "../../sketch/session";
import { type ConstraintGlyph, dimensionLabels, placedStatus, constraintGlyphs } from "../../sketch/constrain";

export function installDimensionLayers(): void {
  S.labels = document.createElement("div");
  S.labels.className = "sketch-dims";
  S.labels.hidden = true;
  document.body.append(S.labels);
  // --- A16. Each geometric constraint's mark beside its geometry. A click selects it; Delete removes it. ---
  S.glyphs = document.createElement("div");
  S.glyphs.className = "sketch-dims sketch-glyphs";
  S.glyphs.hidden = true;
  document.body.append(S.glyphs);
  // --- K1. What the next click would keep, beside the pointer. Never takes the pointer: a click goes through. ---
  S.infer = document.createElement("div");
  S.infer.className = "sketch-dims sketch-infer";
  S.infer.hidden = true;
  S.infer.setAttribute("aria-hidden", "true");
  document.body.append(S.infer);
}

/**
 * K1: the rules the next click keeps, drawn at the pointer's snapped point the way Onshape and Fusion place their
 * inference glyphs: small, up and to the right of it, one beside the other. They are not buttons; the status line
 * says the same in words. A dashed edge tells them from the kept marks (`paintGlyphs`), which are solid.
 */
export function paintInference() {
  const frame = drawingFrame();
  const marks = S.editor.phase === "editing" && frame && !(S.gesture || S.revolve || S.loft || S.sweep) ? inferenceMarks(S.editor) : [];
  const at = S.editor.cursor;
  const screen = marks.length > 0 && at && frame ? S.host.view.projectPoint(toWorld(frame, at)) : null;
  S.host.canvas.dataset.sketchInfer = screen ? marks.map((mark) => mark.kind).join(",") : "";
  if (!screen) {
    if (!S.infer.hidden) {
      S.infer.hidden = true;
      S.infer.replaceChildren();
      delete S.infer.dataset.key;
    }
    return;
  }
  S.infer.hidden = false;
  const key = marks.map((mark) => `${mark.kind}:${mark.text}`).join(" ");
  if (key !== S.infer.dataset.key) {
    S.infer.dataset.key = key;
    S.infer.replaceChildren(
      ...marks.map((mark) => {
        const node = document.createElement("span");
        node.className = "sketch-dim sketch-infer-mark";
        node.dataset.infer = mark.kind;
        node.textContent = mark.text;
        node.title = mark.title;
        return node;
      }),
    );
  }
  marks.forEach((_, index) => {
    const node = S.infer.children[index] as HTMLElement | undefined;
    if (!node) return;
    node.style.left = `${screen.x + 16 + index * 20}px`;
    node.style.top = `${screen.y - 16}px`;
  });
}

const glyphsOf = new WeakMap<SketchData, ConstraintGlyph[]>();

export function paintLabels() {
  const sketch = activeSketch(S.editor);
  const frame = drawingFrame();
  if (!sketch || !frame || S.editor.phase !== "editing") {
    S.labels.hidden = true;
    S.labels.replaceChildren();
    return;
  }
  const items = dimensionLabels(sketch);
  if (items.length === 0) {
    S.labels.hidden = true;
    S.labels.replaceChildren();
    return;
  }
  S.labels.hidden = false;
  const status = placedStatus(sketch);
  S.labels.dataset.defined = status?.fullyDefined ? "1" : "0";
  const keep = new Set(items.map((item) => String(item.id)));
  for (const child of [...S.labels.children]) {
    if (!(child instanceof HTMLElement) || !keep.has(child.dataset.dimId ?? "")) child.remove();
  }
  for (const item of items) {
    const wantInput = S.editor.constrain.focus === item.id || S.editor.constrain.hud === item.id;
    let node = S.labels.querySelector<HTMLElement>(`[data-dim-id="${item.id}"]`);
    const isInput = node instanceof HTMLInputElement;
    if (!node || wantInput !== isInput) {
      node?.remove();
      node = wantInput ? dimensionInput(item.id, item.expr ?? item.text) : dimensionButton(item.id, item.text, item.title, item.expr);
      S.labels.append(node);
    } else if (node instanceof HTMLButtonElement) paintDimensionButton(node, item.text, item.expr);
    if (node instanceof HTMLButtonElement) node.setAttribute("aria-label", `${item.spoken}${item.expr ? `, from ${item.expr}` : ""}. Click to type a new one.`);
    const screen = S.host.view.projectPoint(toWorld(frame, item.at));
    node.hidden = !screen;
    if (screen) placeFixed(node, screen.x, screen.y);
    node.dataset.defined = status?.fullyDefined ? "1" : "0";
    node.dataset.conflict = status?.conflicting.includes(item.id) ? "1" : "0";
    node.title = item.title;
  }
}

export function paintGlyphs() {
  const sketch = activeSketch(S.editor);
  const frame = drawingFrame();
  if (!sketch || !frame || S.editor.phase !== "editing") {
    S.glyphs.hidden = true;
    return;
  }
  let marks = glyphsOf.get(sketch);
  if (!marks) {
    marks = constraintGlyphs(sketch);
    glyphsOf.set(sketch, marks);
  }
  if (marks.length === 0) {
    S.glyphs.hidden = true;
    return;
  }
  S.glyphs.hidden = false;
  const status = placedStatus(sketch);
  const key = marks.map((mark) => `${mark.id}:${mark.text}:${mark.slot}`).join(" ") + `|${S.editor.constrain.selected ?? ""}|${status?.conflicting.join(",") ?? ""}`;
  if (key !== S.glyphsKey) {
    S.glyphsKey = key;
    S.glyphs.replaceChildren(
      ...marks.map((mark) => {
        const node = document.createElement("button");
        node.type = "button";
        node.className = "sketch-dim sketch-glyph";
        node.dataset.glyphId = String(mark.id);
        node.textContent = mark.text;
        node.title = mark.title;
        node.setAttribute("aria-label", mark.title);
        const selected = S.editor.constrain.selected === mark.id;
        node.setAttribute("aria-pressed", selected ? "true" : "false");
        node.dataset.conflict = status?.conflicting.includes(mark.id) ? "1" : "0";
        node.style.fontSize = "10px";
        node.style.padding = "0 3px";
        if (selected) node.style.outline = "2px solid var(--accent)";
        node.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          S.editor = selectConstraint(S.editor, mark.id);
          publish("open");
        });
        return node;
      }),
    );
  }
  marks.forEach((mark, index) => {
    const node = S.glyphs.children[index] as HTMLElement | undefined;
    if (!node) return;
    const screen = S.host.view.projectPoint(toWorld(frame, mark.at));
    node.hidden = !screen;
    if (screen) {
      node.style.left = `${screen.x + 12 + mark.slot * 16}px`;
      node.style.top = `${screen.y - 12}px`;
    }
  });
}

/** The heads-up box focuses itself on open. Put the caret back in the dimension label. */
export function focusDimensionLabel() {
  if (S.editor.constrain.focus == null) return;
  const input = S.labels.querySelector<HTMLInputElement>("input.sketch-dim-input");
  input?.focus();
  input?.select();
  S.editor = acknowledgeDimensionFocus(S.editor);
}

function paintDimensionButton(node: HTMLButtonElement, text: string, expr?: string) {
  node.replaceChildren(document.createTextNode(text));
  if (!expr) return;
  const mark = document.createElement("span");
  mark.className = "expr-mark";
  mark.textContent = "ƒ";
  mark.setAttribute("aria-hidden", "true");
  node.append(mark);
}

function dimensionButton(id: number, text: string, title: string, expr?: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "sketch-dim";
  node.dataset.dimId = String(id);
  paintDimensionButton(node, text, expr);
  node.title = title;
  node.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    S.editor = editDimension(S.editor, id);
    publish("open");
  });
  return node;
}

function dimensionInput(id: number, text: string): HTMLInputElement {
  const node = document.createElement("input");
  node.type = "text";
  node.className = "sketch-dim-input";
  node.dataset.dimId = String(id);
  node.dataset.sketchDimInput = "";
  node.value = text;
  node.setAttribute("aria-label", "Driving dimension");
  node.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") node.dataset.cancelled = "1";
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    node.dataset.done = "1";
    S.editor = commitDimensionText(S.editor, id, node.value);
    publish("open");
  });
  node.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  // Leaving the label sets what was typed, as Enter does, unless Esc cancelled it. Typed values are not lost on a
  // click elsewhere (the class of bug #183 and #186 fixed for the settings fields).
  node.addEventListener("blur", () => commitOpenLabel(node));
  return node;
}

/** Set the label's typed value if it is still open, not cancelled, and not already set by Enter. */
export function commitOpenLabel(node: HTMLInputElement) {
  if (node.dataset.cancelled || node.dataset.done || S.editor.phase !== "editing") return;
  node.dataset.done = "1";
  const id = Number(node.dataset.dimId);
  const next = blurDimensionText(S.editor, id, node.value);
  if (next === S.editor) return;
  S.editor = next;
  publish("open");
}
