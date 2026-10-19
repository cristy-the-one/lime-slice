import {
  ArrowDownToLine,
  ChevronDown,
  ChevronUp,
  createElement,
  Download,
  Minus,
  Plus,
  Printer,
  Layers,
  Move3d,
  PanelLeft,
  RefreshCw,
  Rotate3d,
  Scaling,
  SquareSplitHorizontal,
  TreeDeciduous,
  X,
  type IconNode,
} from "lucide";
import { toggleDock } from "./splitters";
import { mountTooltips } from "./tooltip";
import "./chrome.css";

export type GizmoTool = "all" | "move" | "rotate" | "scale";
export type Stage = "prepare" | "preview" | "gcode" | "model";

export interface ChromeHooks {
  stage(): Stage;
  setGizmoTool(tool: GizmoTool): void;
  onToolReadout(): void;
}

export function mountChrome(hooks: ChromeHooks) {
  iconizeToolbar();
  mountTooltips();
  mountToolRail(hooks);
}

function svgIcon(node: IconNode, size = 16) {
  return createElement(node, {
    width: size,
    height: size,
    "aria-hidden": "true",
    class: "ico",
  });
}

function iconize(el: Element | null, node: IconNode) {
  if (!el || el.querySelector(":scope > .ico")) return;
  el.prepend(svgIcon(node));
  el.classList.add("with-ico");
}

function iconOnly(el: Element | null, node: IconNode, size: number) {
  if (el && !el.querySelector(":scope > .ico")) el.replaceChildren(svgIcon(node, size));
}

function hint(el: Element | null, tip: string) {
  if (!el || !(el instanceof HTMLElement)) return;
  el.dataset.tip = tip;
  el.removeAttribute("title");
}

function iconizeToolbar() {
  iconize(document.querySelector("#slice"), Layers);

  iconize(document.querySelector("#cancel"), X);
  hint(document.querySelector("#cancel"), "Stop the slice in progress");

  iconize(document.querySelector("#export"), Download);
  hint(document.querySelector("#export"), "Save G-code");

  iconize(document.querySelector("#sendPrinter"), Printer);

  iconize(document.querySelector("#force"), RefreshCw);

  iconOnly(document.querySelector("#layerNext"), ChevronUp, 14);
  iconOnly(document.querySelector("#layerPrev"), ChevronDown, 14);
  iconOnly(document.querySelector("#flatZoomIn"), Plus, 14);
  iconOnly(document.querySelector("#flatZoomOut"), Minus, 14);
}

const STAGE_NAME: Record<Stage, string> = { prepare: "Prepare", preview: "Preview", gcode: "G-code", model: "Model" };

/**
 * The rail at the far left: one vertical toolbar whose tool set follows the stage. Prepare's set also serves Model
 * until Model has a set of its own; Preview and G-code share one. The foot holds the settings dock toggle.
 */
function mountToolRail(hooks: ChromeHooks) {
  const host = document.querySelector(".workspace");
  const rail = document.createElement("div");
  rail.id = "toolRail";
  rail.className = "tool-rail";
  rail.setAttribute("role", "toolbar");
  rail.setAttribute("aria-orientation", "vertical");
  rail.setAttribute("aria-label", "Prepare tools");
  rail.dataset.tool = "all";

  const move = toolButton("move", Move3d, "Move", "Drag the part on the bed, or an arrow. Shift snaps 1 mm.");
  const rotate = toolButton("rotate", Rotate3d, "Rotate", "Drag a ring. Shift snaps 15°.");
  const scale = toolButton("scale", Scaling, "Scale", "Drag the scale handle or an axis knob. Shift snaps 5%.");
  scale.setAttribute("aria-pressed", "false");
  const lay = toolButton("layflat", ArrowDownToLine, "Lay flat", "Drop the flattest face onto the bed.");
  lay.classList.add("is-disabled");
  lay.setAttribute("aria-disabled", "true");
  const supports = toolButton("supports", TreeDeciduous, "Edit supports", "Pick tree supports to delete or regrow. Does not move the part.");
  supports.setAttribute("aria-pressed", "false");
  supports.classList.add("is-disabled");
  supports.setAttribute("aria-disabled", "true");
  // The paint brushes mount themselves into this group.
  const paint = document.createElement("div");
  paint.id = "railPaint";
  paint.className = "rail-group";
  paint.setAttribute("role", "group");
  paint.setAttribute("aria-label", "Paint");

  const prepareSet = railSet("prepare model", "Prepare tools");
  prepareSet.append(caption("Place"), move, rotate, scale, lay, sep(), caption("View"), sectionButton(), sep(), caption("Paint"), paint);
  const previewSet = railSet("preview gcode", "Preview tools");
  previewSet.append(caption("View"), sectionButton(), sep(), caption("Edit"), supports);

  const foot = document.createElement("div");
  foot.className = "rail-foot";
  const leftToggle = toolButton("dock", PanelLeft, "Settings panel", "Settings panel");
  leftToggle.id = "leftToggle";
  leftToggle.setAttribute("aria-controls", "leftDock");
  leftToggle.setAttribute("aria-expanded", "true");
  foot.append(leftToggle);

  rail.append(prepareSet, previewSet, gizmoNudge(), foot);
  host?.prepend(rail);
  mountRovingFocus(rail);
  paintRailStage(hooks.stage());

  const buttons = { move, rotate, scale };

  rail.addEventListener("click", (ev) => {
    const button = (ev.target as Element | null)?.closest<HTMLButtonElement>("button");
    if (!button || button.classList.contains("is-disabled")) return;
    const id = button.dataset.tool;
    if (id === "move" || id === "rotate" || id === "scale") selectManipulator(id, buttons, hooks);
    if (id === "layflat") document.querySelector<HTMLButtonElement>("#layflat")?.click();
    if (id === "section") toggleSection();
    if (id === "dock") toggleDock("left");
  });

  document.querySelector("#sectionOn")?.addEventListener("change", () => syncSection());
  const left = document.querySelector("#left");
  if (left) new MutationObserver(() => syncLay(lay)).observe(left, { childList: true, subtree: true });
  syncLay(lay);
  syncSection();
}

function railSet(stages: string, label: string) {
  const set = document.createElement("div");
  set.className = "rail-set";
  set.dataset.for = stages;
  set.setAttribute("role", "group");
  set.setAttribute("aria-label", label);
  return set;
}

function caption(text: string) {
  const el = document.createElement("span");
  el.className = "rail-caption";
  el.setAttribute("aria-hidden", "true");
  el.textContent = text;
  return el;
}

function sep() {
  const line = document.createElement("div");
  line.className = "rail-sep";
  return line;
}

function sectionButton() {
  const button = toolButton("section", SquareSplitHorizontal, "Section", "Clip the preview. Does not change the slice.");
  button.setAttribute("aria-pressed", "false");
  return button;
}

/** Show the stage's tool set, and name the toolbar and the stage landmark after it. */
export function paintRailStage(stage: Stage) {
  const rail = document.querySelector<HTMLElement>("#toolRail");
  if (!rail) return;
  const focused = rail.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
  rail.querySelectorAll<HTMLElement>(".rail-set").forEach((set) => {
    set.hidden = !(set.dataset.for ?? "").split(" ").includes(stage);
  });
  rail.setAttribute("aria-label", `${STAGE_NAME[stage]} tools`);
  document.querySelector("#stage")?.setAttribute("aria-label", STAGE_NAME[stage]);
  // A rail button that just left with its set hands focus to its twin in the new set, else to the new tab stop.
  if (focused?.closest("[hidden]")) {
    const twin = railButtons(rail).find((button) => button.dataset.tool === focused.dataset.tool);
    rovingReset(rail);
    (twin ?? rail.querySelector<HTMLButtonElement>("button[tabindex='0']"))?.focus();
    return;
  }
  rovingReset(rail);
}

/** The rail's reachable buttons: not in a hidden set or group. */
function railButtons(rail: HTMLElement) {
  return [...rail.querySelectorAll<HTMLButtonElement>("button")].filter((button) => !button.closest("[hidden]"));
}

/** One tab stop for the rail: the arrows walk it, Home and End jump to its ends. */
function mountRovingFocus(rail: HTMLElement) {
  rail.addEventListener("focusin", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.tagName !== "BUTTON") return;
    for (const button of rail.querySelectorAll<HTMLButtonElement>("button")) button.tabIndex = button === target ? 0 : -1;
  });
  const steps: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
  rail.addEventListener("keydown", (ev) => {
    const step = steps[ev.key];
    if (step === undefined || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const buttons = railButtons(rail);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    ev.preventDefault();
    const next = step === -Infinity ? 0 : step === Infinity ? buttons.length - 1 : (at + step + buttons.length) % buttons.length;
    buttons[next].focus();
  });
  // The paint brushes and the gizmo nudge come and go after mount.
  new MutationObserver(() => rovingReset(rail)).observe(rail, { childList: true, subtree: true, attributeFilter: ["hidden"] });
}

/** Exactly one shown rail button sits in the tab order: the focused one, else the one that had the stop, else the first. */
function rovingReset(rail: HTMLElement) {
  const buttons = railButtons(rail);
  const keep = buttons.find((button) => button === document.activeElement)
    ?? buttons.find((button) => button.tabIndex === 0)
    ?? buttons[0];
  for (const button of rail.querySelectorAll<HTMLButtonElement>("button")) {
    const tab = button === keep ? 0 : -1;
    if (button.tabIndex !== tab) button.tabIndex = tab;
  }
}

function gizmoNudge() {
  const row = document.createElement("div");
  row.id = "gizmoNudge";
  row.className = "gizmo-nudge";
  row.hidden = true;
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Fine gizmo nudge");
  for (const axis of ["x", "y", "z"] as const) {
    for (const sign of [-1, 1] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.axis = axis;
      button.dataset.sign = String(sign);
      const dir = sign < 0 ? "−" : "+";
      button.textContent = `${axis.toUpperCase()}${dir}`;
      button.setAttribute("aria-label", `Nudge ${axis.toUpperCase()} ${dir}0.1 mm`);
      row.append(button);
    }
  }
  return row;
}

function toolButton(id: string, node: IconNode, label: string, tip: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tool";
  button.dataset.tool = id;
  button.dataset.tip = tip;
  button.setAttribute("aria-label", label);
  button.append(svgIcon(node));
  return button;
}

function selectManipulator(
  next: "move" | "rotate" | "scale",
  buttons: { move: HTMLButtonElement; rotate: HTMLButtonElement; scale: HTMLButtonElement },
  hooks: ChromeHooks,
) {
  const rail = document.querySelector<HTMLElement>("#toolRail");
  const current = rail?.dataset.tool;
  const tool: GizmoTool = current === next ? "all" : next;
  if (rail) rail.dataset.tool = tool;
  buttons.move.setAttribute("aria-pressed", tool === "move" ? "true" : "false");
  buttons.rotate.setAttribute("aria-pressed", tool === "rotate" ? "true" : "false");
  buttons.scale.setAttribute("aria-pressed", tool === "scale" ? "true" : "false");
  hooks.setGizmoTool(tool);
  hooks.onToolReadout();
  if (tool !== "all") document.querySelector<HTMLButtonElement>("#tabPrepare")?.click();
}

function toggleSection() {
  const box = document.querySelector<HTMLInputElement>("#sectionOn");
  if (!box) return;
  const preview = document.querySelector<HTMLButtonElement>("#tabPreview")?.getAttribute("aria-pressed") === "true";
  if (preview && box.checked) {
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  document.querySelector<HTMLButtonElement>("#tabPreview")?.click();
  document.querySelector<HTMLButtonElement>('[data-mode="solid"]')?.click();
  if (!box.checked) {
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function syncSection() {
  const on = !!document.querySelector<HTMLInputElement>("#sectionOn")?.checked;
  document.querySelectorAll('#toolRail [data-tool="section"]').forEach((button) => button.setAttribute("aria-pressed", on ? "true" : "false"));
}

function syncLay(button: HTMLButtonElement) {
  const ready = !!document.querySelector("#layflat");
  button.classList.toggle("is-disabled", !ready);
  button.setAttribute("aria-disabled", ready ? "false" : "true");
}

