/** The sketch cards and the buttons they are made of. */
import { S } from "./state";
import { aboveBlocked, aboveOpen, canAddAbove, gapToClose } from "./above";
import { chooserRow } from "./chooser";
import { resolvedMode } from "./extrude";
import { axisKey } from "./helpers";
import { askOpen } from "./holes";
import { resolvedLoftMode, scaleOf } from "./loft";
import { profileNote } from "./profile";
import { resolvedRevolveMode } from "./revolve";
import { editingRow, offsetHasEnds } from "./rows";
import { featureBlocked, markBlocked, paintStarts, pickPrompt } from "./starts";
import { resolvedSweepMode } from "./sweep";
import { showMarks } from "./view";
import { type OriginPlane } from "../../sketch/draw";
import { activeSketch, type SketchTool } from "../../sketch/session";
import { namesOpenEnds } from "../../sketch/reasons";
import { settleAbove } from "../../sketch/loft-above";
import { revealDock } from "../../ui/dock-reveal.ts";

// R2: a greyed button whose reason is about the drawing marks the place while its tip is read.
export const markFromButton = (ev: Event) => {
  const target = ev.target instanceof Element ? ev.target.closest("button") : null;
  if (target instanceof HTMLButtonElement && (namesOpenEnds(target.dataset.reason) || target.dataset.sketchCloseGap != null)) showMarks("open");
};

/** Everything the cards show. They are rebuilt only when this changes. */
function cardsState(pinned: readonly { id: number; name: string }[]): string {
  const parts: string[] = [S.editor.phase, String(S.editor.active), S.editor.tool, S.menuOpen ?? "", S.editor.lookAround ? "look" : ""];
  parts.push(pinned.map((item) => `${item.id}=${item.name}`).join("/"));
  if (S.editor.phase === "editing") {
    parts.push(activeSketch(S.editor)?.on?.kind ?? "");
    // E1 and L1: Close the gap, Add a shape above and the shape above's strip come and go with the drawing.
    parts.push(gapToClose() ? "gap" : "", canAddAbove() ? "above" : "", aboveOpen() ? "above-open" : "");
    // H1: Start on a face shows while a part has faces; the question replaces Make while it is asked.
    parts.push(S.host.solid() ? "solid" : "", askOpen() ? `ask:${S.drillAsk?.count}` : "");
    // S3 and V1: Round corners and its radius, and which listed axis is pressed.
    if (S.sweep?.round) parts.push(`round:${S.sweep.round.on}`);
    if (S.revolve) parts.push(S.revolve.follow ? "follow" : axisKey(S.revolve.axis), String(S.revolve.regions.length));
    if (S.profile) parts.push(`profile:${profileNote()}`);
    // P2: the demo's strip and footer, and the Make row's How.
    parts.push(S.demo ? `demo:${S.demo.kind}:${S.demo.made}` : "", S.makeHowOpen ? "make-how" : "", S.editHowOpen ? "edit-how" : "");
    // O1: the wall options show while Offset is on, and Close the ends only for a line with ends.
    if (S.editor.tool === "offset") {
      const offsetting = S.editor.draw.gesture?.kind === "offset" ? S.editor.draw.gesture.distance : null;
      parts.push(`wall:${JSON.stringify(S.editor.draw.wall)}:${offsetHasEnds()}:${offsetting}`);
    }
    if (S.gesture || S.revolve || S.loft || S.sweep) {
      const mode = S.sweep ? resolvedSweepMode() : S.loft ? resolvedLoftMode() : S.revolve ? resolvedRevolveMode() : resolvedMode();
      const choice = S.sweep ? S.sweep.choice : S.loft ? S.loft.choice : S.revolve ? S.revolve.choice : S.gesture?.choice ?? "auto";
      parts.push(mode, choice, S.loft ? (S.loft.ruled ? "ruled" : "smooth") : "", S.sweep?.oneSketch?.stance ?? "", S.sweep?.pipe ? "pipe" : "");
    }
  }
  return parts.join("|");
}

export function paintCards() {
  if (!S.cards) return;
  // E3. The sketch card is in the Model dock: a sketch being chosen or drawn shows the dock, and gives it back after.
  const live = S.editor.phase === "choosing" || S.editor.phase === "editing";
  if (live) S.releaseCardDock ??= revealDock("left");
  else if (S.releaseCardDock) {
    S.releaseCardDock();
    S.releaseCardDock = null;
  }
  const pinned = S.editor.pinned.filter((item) => item.id !== S.editor.active && item.name !== "Sketch");
  if (!(S.gesture || S.revolve || S.loft || S.sweep || S.profile)) S.howFeature = null;
  const key = cardsState(pinned);
  if (key === S.cardsKey) {
    takeCardFocus();
    refreshBlocked();
    return;
  }
  S.cardsKey = key;
  // The rebuilt card keeps the keyboard where it was: the button with the same data is focused again.
  const focused = document.activeElement instanceof HTMLElement && S.cards.contains(document.activeElement) ? sameButton(document.activeElement) : null;
  if (focused && S.cardFocus.length === 0) S.cardFocus = [focused];
  S.cards.replaceChildren();
  if (S.editor.phase === "off" && pinned.length === 0) {
    S.cards.hidden = true;
    return;
  }
  S.cards.hidden = false;
  if (S.editor.phase === "choosing") S.cards.append(card(chooserRow()));
  if (S.editor.phase === "editing") S.cards.append(card(editingRow()));
  for (const item of pinned) S.cards.append(card(pinnedRow(item.id, item.name)));
  if (S.cards.childElementCount === 0) S.cards.hidden = true;
  takeCardFocus();
  refreshBlocked();
}

/** Apply and Holes follow the selection without rebuilding the card, so a typed field keeps its focus. */
function refreshBlocked() {
  const apply = S.cards?.querySelector<HTMLButtonElement>("[data-sketch-apply]");
  if (apply) {
    apply.dataset.tipIdle ??= "Keep this feature";
    markBlocked(apply, featureBlocked());
  }
  paintStarts();
  const done = S.cards?.querySelector<HTMLButtonElement>("[data-sketch-above-done]");
  const drawn = activeSketch(S.editor);
  if (done && S.above && drawn) markBlocked(done, aboveBlocked(settleAbove(S.above.copy, drawn).sketch));
  const sentence = pickPrompt();
  const text = S.cards?.querySelector<HTMLElement>(".sketch-prompt-text");
  if (text) {
    text.textContent = sentence;
    text.toggleAttribute("hidden", sentence === "");
  }
  const value = S.cards?.querySelector<HTMLInputElement>("[data-sketch-value]");
  if (value && document.activeElement !== value) {
    const shown = S.gesture ? String(S.gesture.distance) : S.revolve ? String(S.revolve.angle) : S.sweep?.pipe ? String(S.sweep.pipe.diameter) : S.sweep ? String(scaleOf(S.sweep.scale)) : "";
    if (shown && value.value !== shown) value.value = shown;
  }
  // S3: a radius worked out again (a wider pipe, another profile) shows in the field unless it is being typed.
  const radius = S.cards?.querySelector<HTMLInputElement>("[data-sketch-round-radius]");
  if (radius && S.sweep?.round && document.activeElement !== radius && radius.value !== String(S.sweep.round.radius)) radius.value = String(S.sweep.round.radius);
}

function takeCardFocus() {
  if (S.cardFocus.length === 0 || !S.cards) return;
  const host = S.cards;
  const node = S.cardFocus.map((selector) => host.querySelector<HTMLElement>(selector)).find((found) => found != null);
  S.cardFocus = [];
  node?.focus();
}

/** A selector for the button with the same data attributes as `node`, or null when it has none. */
function sameButton(node: HTMLElement): string | null {
  // The tip text changes with a button's blocked state, so it cannot name the button.
  const data = Object.entries(node.dataset).filter(([name]) => name !== "tip" && name !== "tipIdle" && name !== "reason").map(([name, value]) => `[data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${CSS.escape(value ?? "")}"]`);
  return data.length > 0 ? `button${data.join("")}` : null;
}

function pinnedRow(id: number, name: string): Node[] {
  return [
    textButton(name, { sketchOpen: String(id) }),
    textButton("Discard", { sketchDiscard: String(id) }),
  ];
}

function card(children: Node[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "sketch-card";
  row.append(...children);
  return row;
}

export function paragraph(text: string): HTMLElement {
  const node = document.createElement("p");
  node.textContent = text;
  return node;
}

export function planeButton(name: OriginPlane["name"], label: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "btn";
  node.dataset.sketchPlane = name;
  node.textContent = label;
  return node;
}

export function toolButton(tool: SketchTool, label: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "btn";
  node.dataset.sketchTool = tool;
  node.textContent = label;
  node.setAttribute("aria-pressed", S.editor.tool === tool ? "true" : "false");
  return node;
}

export function textButton(label: string, data: Record<string, string>): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "btn";
  node.textContent = label;
  for (const [key, value] of Object.entries(data)) node.dataset[key] = value;
  return node;
}
