/** The strip under the card while a feature is open: How, mode, axis, round corners, the value field. */
import { S } from "./state";
import { canAddAbove, heightField } from "./above";
import { textButton } from "./cards";
import { showMeButton } from "./demo";
import { resolvedMode } from "./extrude";
import { PROFILE_SKETCH_STEPS, modelAxisName } from "./helpers";
import { resolvedLoftMode, scaleOf } from "./loft";
import { armRevolveProbe, resolvedRevolveMode } from "./revolve";
import { featureBlocked, markBlocked, pickPrompt } from "./starts";
import { armSweepProbe, madeSweep, resolvedSweepMode, roundedSweep } from "./sweep";
import type { SweepRound } from "./types";
import { drawingFrame, publish } from "./view";
import { demoForHow } from "../../sketch/demos";
import { activeSketch } from "../../sketch/session";
import { hintSteps } from "../../sketch/hints";
import { ASSIST_PURPOSE, REASON } from "../../sketch/reasons";
import { axisChoices, sameAxisLine, regionCrossesAxis } from "../../sketch/revolve";

/** Replaces Make while Extrude, Revolve, Loft or Sweep is open. */
export function featureStrip(): HTMLElement {
  const strip = document.createElement("section");
  strip.className = "sketch-section sketch-feature";
  strip.dataset.sketchSection = "feature";
  const sentence = pickPrompt();
  const prompt = document.createElement("p");
  prompt.className = "sketch-prompt-text model-note";
  prompt.setAttribute("role", "status");
  prompt.textContent = sentence;
  prompt.toggleAttribute("hidden", sentence === "");
  const name = document.createElement("p");
  name.className = "sketch-feature-name";
  name.textContent = S.gesture ? "Extrude" : S.revolve ? "Revolve" : S.loft ? "Loft" : S.sweep?.pipe ? "Pipe" : "Sweep";
  const head = document.createElement("div");
  head.className = "sketch-feature-row";
  // A demo is always a new object, so Join, Cut and New object have nothing to choose between.
  head.append(name, ...(S.demo ? [] : [modeControl()]));
  const options = document.createElement("div");
  options.className = "sketch-feature-row";
  if (S.revolve) options.append(textButton("Flip", { sketchFlip: "" }));
  const axes = S.revolve ? axisRow() : null;
  if (S.sweep?.oneSketch) {
    const up = S.sweep.oneSketch.stance === "up";
    const stance = textButton(up ? "Profile: stood up at the start" : "Profile: as drawn", { sketchStance: S.sweep.oneSketch.stance });
    stance.setAttribute("aria-pressed", up ? "true" : "false");
    stance.dataset.tip = up
      ? "The shape is turned to face along the route and moved to its start. Click to keep it where you drew it."
      : "The shape stays where you drew it, flat beside the route. Click to stand it up at the route's start.";
    stance.title = stance.dataset.tip;
    options.append(stance);
  }
  if (S.sweep?.round) options.append(...roundControls(S.sweep.round));
  if (S.loft) {
    const ruled = textButton(S.loft.ruled ? "Ruled (S)" : "Smooth (S)", { sketchRuled: S.loft.ruled ? "1" : "0" });
    ruled.dataset.tip = "S toggles smooth and ruled.";
    ruled.title = ruled.dataset.tip;
    options.append(ruled);
  }
  if (S.loft && canAddAbove()) {
    const add = textButton("Add a shape above", { sketchAbove: "" });
    add.classList.add("primary");
    add.dataset.tipIdle = ASSIST_PURPOSE.above;
    markBlocked(add, "");
    options.append(heightField(), add);
  }
  const value = featureValue();
  if (value) options.append(value);
  const kind = S.gesture ? "extrude" : S.revolve ? "revolve" : S.loft ? "loft" : S.sweep?.pipe ? "pipe" : S.sweep?.oneSketch ? "sweep-one" : "sweep";
  options.append(howControl(kind));
  const apply = textButton("Apply", { sketchApply: "" });
  apply.classList.add("primary");
  apply.dataset.tipIdle = "Keep this feature";
  markBlocked(apply, featureBlocked());
  const actions = document.createElement("div");
  actions.className = "sketch-feature-actions";
  actions.append(apply, textButton("Cancel", { sketchCancel: "" }));
  strip.append(prompt, head, ...(axes ? [axes] : []), options, actions);
  return strip;
}

/**
 * V1: "Spin around:" and the axes in words, helper lines first. The pressed one is the axis in use; one the shape
 * crosses is greyed with the reason. While the axis still follows the pointer, none is pressed.
 */
function axisRow(): HTMLElement | null {
  const sketch = activeSketch(S.editor);
  const frame = drawingFrame();
  if (!S.revolve || !sketch) return null;
  S.shownAxes = axisChoices(sketch, S.revolve.regions, S.revolve.follow ? null : S.revolve.axis, frame ? { u: modelAxisName(frame.u), v: modelAxisName(frame.v) } : {});
  const row = document.createElement("div");
  row.className = "sketch-feature-row sketch-axes";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Spin around");
  const lead = document.createElement("span");
  lead.className = "sketch-axes-lead";
  lead.textContent = "Spin around:";
  row.append(lead);
  for (const choice of S.shownAxes) {
    const button = textButton(choice.label, { sketchAxis: choice.label });
    button.setAttribute("aria-pressed", !S.revolve.follow && sameAxisLine(choice.axis, S.revolve.axis) ? "true" : "false");
    button.dataset.tipIdle = "Spin the shape around this line.";
    markBlocked(button, choice.crosses ? REASON.axisCrosses : "");
    row.append(button);
  }
  return row;
}

export function pickListedAxis(label: string) {
  const choice = S.shownAxes.find((item) => item.label === label);
  if (!S.revolve || !choice) return;
  S.revolve = { ...S.revolve, axis: choice.axis, follow: false, crossing: S.revolve.regions.some((region) => regionCrossesAxis(region, choice.axis)) };
  S.cardFocus = [`[data-sketch-axis="${label.replace(/"/g, "")}"]`];
  publish("open");
  armRevolveProbe();
}

function howSeen(kind: string): number {
  const key = `lime-slice-how-${kind}`;
  try {
    if (S.howFeature !== kind) {
      S.howFeature = kind;
      const next = Number(localStorage.getItem(key) ?? "0") + 1;
      const count = Number.isFinite(next) && next > 0 ? next : 1;
      localStorage.setItem(key, String(count));
      return count;
    }
    const seen = Number(localStorage.getItem(key) ?? "1");
    return Number.isFinite(seen) && seen > 0 ? seen : 1;
  } catch {
    return 1;
  }
}

export function closeHow(refocus: boolean) {
  S.howOpen = false;
  const pop = S.cards?.querySelector<HTMLElement>("#sketchHow");
  const button = S.cards?.querySelector<HTMLButtonElement>(".sketch-how-open");
  if (pop) pop.hidden = true;
  button?.setAttribute("aria-expanded", "false");
  if (refocus) button?.focus();
}

/** Numbered steps beside the feature strip. Open the first three times, then a ? button. */
export function howControl(kind: "extrude" | "revolve" | "loft" | "sweep" | "sweep-one" | "pipe" | "profile"): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sketch-how";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn sketch-how-open";
  button.textContent = "?";
  button.setAttribute("aria-label", "How");
  const pop = document.createElement("div");
  pop.id = "sketchHow";
  pop.className = "sketch-how-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "How");
  const list = document.createElement("ol");
  for (const step of kind === "profile" ? PROFILE_SKETCH_STEPS : hintSteps(kind)) {
    const item = document.createElement("li");
    item.textContent = step;
    list.append(item);
  }
  // P2 (R5): the first line is Show me, which opens this tool's demo. A demo has none of its own.
  const shown = S.demo ? null : demoForHow(kind);
  if (shown) pop.append(showMeButton(shown, "Show me"));
  pop.append(list);
  let open: boolean;
  if (S.demo) {
    // The demo's strip says the next click, so its How stays shut, and a demo isn't counted as a visit.
    open = S.howFeature === kind && S.howOpen;
    S.howFeature = kind;
  } else if (S.howFeature === kind) {
    // The card is rebuilt within one visit (another value, the demo closed): the How stays as the person left it.
    open = S.howOpen;
  } else open = howSeen(kind) <= 3;
  S.howOpen = open;
  pop.hidden = !open;
  button.setAttribute("aria-expanded", open ? "true" : "false");
  button.setAttribute("aria-controls", "sketchHow");
  button.addEventListener("click", (ev) => {
    ev.stopPropagation();
    S.howOpen = pop.hidden;
    pop.hidden = !pop.hidden;
    button.setAttribute("aria-expanded", pop.hidden ? "false" : "true");
  });
  wrap.append(button, pop);
  return wrap;
}

function modeControl(): HTMLElement {
  const choice = S.sweep ? S.sweep.choice : S.loft ? S.loft.choice : S.revolve ? S.revolve.choice : S.gesture?.choice ?? "auto";
  const resolved = S.sweep ? resolvedSweepMode() : S.loft ? resolvedLoftMode() : S.revolve ? resolvedRevolveMode() : resolvedMode();
  const seg = document.createElement("div");
  seg.className = "sketch-modes";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Join, cut, or new object");
  const modes: { choice: "fuse" | "cut" | "new" | "common"; label: string }[] = [
    { choice: "fuse", label: "Join" },
    { choice: "cut", label: "Cut" },
    { choice: "new", label: "New object" },
  ];
  if (resolved === "common") modes.push({ choice: "common", label: "Intersect" });
  for (const mode of modes) {
    const auto = choice === "auto" && mode.choice === resolved;
    const selected = mode.choice === resolved;
    const button = textButton(auto ? `Auto · ${mode.label}` : mode.label, { sketchMode: mode.choice });
    button.setAttribute("aria-pressed", selected ? "true" : "false");
    // Each segment names its own choice. The selected one says that M cycles the group.
    button.dataset.tip = selected ? `${mode.label}. M cycles Join, Cut, and New object` : mode.label;
    button.title = button.dataset.tip;
    seg.append(button);
  }
  return seg;
}

/** S3: Round corners, pressed while on, and the radius it rounds with. */
function roundControls(round: SweepRound): HTMLElement[] {
  const toggle = textButton("Round corners", { sketchRound: round.on ? "1" : "0" });
  toggle.setAttribute("aria-pressed", round.on ? "true" : "false");
  toggle.dataset.tipIdle = ASSIST_PURPOSE.roundCorners;
  markBlocked(toggle, "");
  if (!round.on) return [toggle];
  const label = document.createElement("label");
  label.className = "sketch-value sketch-round-radius";
  label.append("Radius ");
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.size = 4;
  input.value = String(round.radius);
  input.dataset.sketchRoundRadius = "";
  input.dataset.ownKeys = "";
  input.setAttribute("aria-label", "Corner radius");
  input.title = "The smallest radius the shape can follow. Type a larger one for a wider bend, or clear it for the smallest again.";
  // Each keystroke takes the radius, so Enter (which applies the sweep) applies what is typed. The card isn't rebuilt
  // while typing: refreshBlocked writes a radius worked out again into the field only when it isn't focused.
  input.addEventListener("input", () => {
    if (!S.sweep?.round) return;
    const text = input.value.trim();
    const value = Number(text.replace(",", "."));
    if (text !== "" && !(value > 0)) {
      S.host.readout("Type the corner radius in millimetres, such as 5.");
      return;
    }
    S.sweep = roundedSweep({ ...S.sweep, round: { ...S.sweep.round, on: true, typed: text !== "", radius: text === "" ? S.sweep.round.radius : value } });
    publish("skip");
    armSweepProbe();
  });
  const unit = document.createElement("span");
  unit.textContent = "mm";
  label.append(input, unit);
  return [toggle, label];
}

function featureValue(): HTMLLabelElement | null {
  if (S.loft || (!S.gesture && !S.revolve && !S.sweep)) return null;
  const label = document.createElement("label");
  label.className = "sketch-value";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.dataset.sketchValue = "";
  const unit = document.createElement("span");
  if (S.gesture) {
    input.value = String(S.gesture.distance);
    input.setAttribute("aria-label", "Distance");
    unit.textContent = "mm";
  } else if (S.revolve) {
    input.value = String(S.revolve.angle);
    input.setAttribute("aria-label", "Angle");
    unit.textContent = "°";
  } else if (S.sweep?.pipe) {
    input.value = String(S.sweep.pipe.diameter);
    input.setAttribute("aria-label", "Diameter");
    unit.textContent = "mm";
  } else if (S.sweep) {
    input.value = String(scaleOf(S.sweep.scale));
    input.setAttribute("aria-label", "End scale");
    unit.textContent = "×";
  }
  input.addEventListener("change", () => {
    const value = Number(input.value.trim().replace(",", "."));
    if (!Number.isFinite(value)) return;
    if (S.gesture) S.gesture = { ...S.gesture, distance: value, upTo: null, guide: null };
    else if (S.revolve) S.revolve = { ...S.revolve, angle: value, follow: false };
    else if (S.sweep?.pipe) S.sweep = roundedSweep(madeSweep({ ...S.sweep, pipe: { ...S.sweep.pipe, diameter: value } }));
    else if (S.sweep) S.sweep = { ...S.sweep, scale: value, note: "" };
    publish("values");
  });
  label.append(input, unit);
  return label;
}
