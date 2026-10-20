import {
  ArrowDownToLine,
  Box,
  ChevronDown,
  ChevronUp,
  Columns2,
  createElement,
  Download,
  Grid3x3,
  Minus,
  Plus,
  Printer,
  Layers,
  Move3d,
  Palette,
  PanelLeft,
  RefreshCw,
  Rotate3d,
  Ruler,
  Scaling,
  Square,
  SquareSplitHorizontal,
  TreeDeciduous,
  X,
  type IconNode,
} from "lucide";
import { mountRailFlyouts } from "./rail-fly";
import { toggleDock } from "./splitters";
import { mountTooltips } from "./tooltip";
import "./chrome.css";

export type GizmoTool = "all" | "move" | "rotate" | "scale";
export type Stage = "prepare" | "preview" | "gcode" | "model";
export type ViewMode = "flat" | "split" | "solid";

export interface ChromeHooks {
  stage(): Stage;
  viewMode(): ViewMode;
  setViewMode(mode: ViewMode): void;
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
 * The rail at the far left: one vertical toolbar whose tool sets follow the stage. Preview and G-code share theirs,
 * which replace the old view bar; Measure and Section show in the slicer stages. Model's set comes from the markup
 * (its buttons keep their ids for the Model code), and its foot holds Undo, Redo and STEP. The foot holds the
 * left dock toggle.
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

  const views = (["flat", "split", "solid"] as const).map((mode) => viewButton(mode, hooks.viewMode()));
  const measure = toolButton("rulers", Ruler, "Measure", "Sizes: the part's length, width and height, a scale bar, and numbers along the bed. The scale bar is measured at the view centre.");
  measure.id = "measureField";
  measure.setAttribute("aria-pressed", "false");
  const section = toolButton("section", SquareSplitHorizontal, "Section", "Clip the preview on a free plane. Does not change the slice.");
  section.setAttribute("aria-pressed", "false");

  const place = railSet("prepare", "Place");
  place.append(caption("Place"), move, rotate, scale, lay, sep(), caption("View"));
  const look = railSet("preview", "View");
  look.append(
    caption("View"),
    ...views,
    sep(),
    flyButton("flyColor", Palette, "Color by"),
    flyButton("flyFeatures", Layers, "Features shown"),
  );
  const bed = railSet("prepare preview", "Bed");
  bed.append(flyButton("flyBed", Grid3x3, "Bed opacity"));
  const shared = railSet("prepare preview gcode", "Measure and section");
  shared.append(measure, section);
  const paints = railSet("prepare", "Paint");
  paints.append(sep(), caption("Paint"), paint);
  const edits = railSet("preview gcode", "Edit");
  edits.append(sep(), caption("Edit"), supports);

  const foot = document.createElement("div");
  foot.className = "rail-foot";
  const leftToggle = toolButton("dock", PanelLeft, "Settings panel", "Settings panel");
  leftToggle.id = "leftToggle";
  leftToggle.setAttribute("aria-controls", "leftDock");
  leftToggle.setAttribute("aria-expanded", "true");
  // Shown only while settings sit in a closed drawer (961–1200 px), so the one way to them is labelled.
  const label = document.createElement("span");
  label.className = "rail-label";
  label.setAttribute("aria-hidden", "true");
  label.textContent = "Settings";
  leftToggle.append(label);
  // E3. Model's Undo, Redo and STEP sit over the dock toggle.
  const modelFoot = document.querySelector<HTMLElement>("#railModelFoot");
  if (modelFoot) foot.append(modelFoot);
  foot.append(leftToggle);

  const model = document.querySelector<HTMLElement>("#railModel");
  rail.append(place, look, bed, shared, paints, edits, ...(model ? [model] : []), gizmoNudge(), foot);
  host?.prepend(rail);
  mountRovingFocus(rail);
  mountRailFolds(rail);
  flyouts = mountRailFlyouts(rail);
  paintRailStage(hooks.stage());

  const buttons = { move, rotate, scale };

  rail.addEventListener("click", (ev) => {
    const button = (ev.target as Element | null)?.closest<HTMLButtonElement>("button");
    if (!button || button.classList.contains("is-disabled")) return;
    // Model's tools are the Model code's (its Scale is not the gizmo's).
    if (button.closest("#railModel, #railModelFoot")) return;
    const id = button.dataset.tool;
    if (id === "move" || id === "rotate" || id === "scale") selectManipulator(id, buttons, hooks);
    if (id === "layflat") document.querySelector<HTMLButtonElement>("#layflat")?.click();
    if (id === "section") toggleSection();
    if (id === "dock") toggleDock("left");
    const mode = button.dataset.mode;
    if (mode === "flat" || mode === "split" || mode === "solid") hooks.setViewMode(mode);
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

const VIEW_MODE: Record<ViewMode, { label: string; icon: IconNode; tip: string }> = {
  flat: { label: "2D", icon: Square, tip: "2D layer" },
  split: { label: "Split", icon: Columns2, tip: "2D and 3D side by side" },
  solid: { label: "3D", icon: Box, tip: "3D toolpath" },
};

function viewButton(mode: ViewMode, current: ViewMode) {
  const view = VIEW_MODE[mode];
  const button = toolButton(`view-${mode}`, view.icon, view.label, view.tip);
  button.dataset.mode = mode;
  button.setAttribute("aria-pressed", String(mode === current));
  return button;
}

/** A rail button that opens a panel beside the rail. */
function flyButton(panel: string, icon: IconNode, label: string) {
  const button = toolButton(`fly-${panel}`, icon, label, label);
  button.classList.add("more");
  button.dataset.fly = panel;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", panel);
  return button;
}

let flyouts: { close(): void } | null = null;

/** Show the stage's tool set, and name the toolbar and the stage landmark after it. */
export function paintRailStage(stage: Stage) {
  document.documentElement.dataset.stage = stage;
  paintDockNames(stage);
  const rail = document.querySelector<HTMLElement>("#toolRail");
  if (!rail) return;
  const focused = rail.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
  rail.querySelectorAll<HTMLElement>(".rail-set").forEach((set) => {
    set.hidden = !(set.dataset.for ?? "").split(" ").includes(stage);
  });
  rail.setAttribute("aria-label", `${STAGE_NAME[stage]} tools`);
  flyouts?.close();
  document.querySelector("#stage")?.setAttribute("aria-label", STAGE_NAME[stage]);
  // A rail button that just left with its set hands focus to its twin in the new set, else to the new tab stop.
  if (focused?.closest("[hidden]")) {
    const twin = railButtons(rail).find((button) => button.dataset.tool === focused.dataset.tool);
    rovingReset(rail);
    (twin ?? rail.querySelector<HTMLButtonElement>("button[tabindex='0']"))?.focus();
    fitRail();
    return;
  }
  rovingReset(rail);
  fitRail();
}

/**
 * E3. The left dock is Settings in the slicer stages and Model in Model; the right is Results, or Inspect in Model.
 * Their headings, landmarks, close buttons and openers say so.
 */
function paintDockNames(stage: Stage) {
  const model = stage === "model";
  const names = { left: model ? "Model" : "Settings", right: model ? "Inspect" : "Results" };
  for (const side of ["left", "right"] as const) {
    const dock = document.querySelector<HTMLElement>(side === "left" ? "#leftDock" : "#rightDock");
    if (!dock) continue;
    dock.setAttribute("aria-label", names[side]);
    const heading = dock.querySelector(".dock-head h2");
    if (heading) heading.textContent = names[side];
    dock.querySelector(".dock-close")?.setAttribute("aria-label", `Collapse ${model && side === "left" ? "the Model panel" : names[side].toLowerCase()}`);
    document.querySelector(`.splitter-${side}`)?.setAttribute("aria-label", `Resize ${model && side === "left" ? "the Model panel" : names[side].toLowerCase()}`);
  }
  const toggle = document.querySelector<HTMLElement>("#leftToggle");
  if (toggle) {
    toggle.dataset.tip = `${names.left} panel`;
    toggle.setAttribute("aria-label", `${names.left} panel`);
    const label = toggle.querySelector(".rail-label");
    if (label) label.textContent = names.left;
  }
  const hint = document.querySelector("#statusHint");
  if (hint) hint.textContent = model ? "The Model panel is in the drawer (Ctrl+B)" : "Settings are in the drawer (Ctrl+B)";
  const timing = document.querySelector<HTMLElement>("#timing");
  if (timing) timing.dataset.tip = `${names.right} panel`;
  // Inspect fills only in Model: it catches up as Model shows.
  if (model) window.dispatchEvent(new Event("lime-inspect"));
}

/** E3. Groups fold into one flyout button when the rail is too short for every tool, the least used first. */
const FOLD_ORDER = ["frame", "inspect", "combine", "feature", "modify", "create"];
let openFold: HTMLElement | null = null;

function mountRailFolds(rail: HTMLElement) {
  for (const group of rail.querySelectorAll<HTMLElement>(".rail-group[data-group]")) {
    const tools = group.querySelector<HTMLElement>(":scope > .rail-tools");
    if (!tools) continue;
    const name = group.getAttribute("aria-label") ?? "";
    tools.id ||= `railTools-${group.dataset.group}`;
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "rail-fold more";
    fold.hidden = true;
    fold.setAttribute("aria-label", `${name} tools`);
    fold.setAttribute("aria-haspopup", "true");
    fold.setAttribute("aria-expanded", "false");
    fold.setAttribute("aria-controls", tools.id);
    tools.before(fold);
  }
  rail.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const fold = target?.closest<HTMLButtonElement>(".rail-fold");
    if (fold) {
      const group = fold.closest<HTMLElement>(".rail-group");
      if (group && group === openFold) closeFold(false);
      else if (group) showFold(group, (ev as MouseEvent).detail === 0);
      return;
    }
    // A tool picked from an open fold closes it; the tool's own click runs as from the rail.
    if (openFold && target?.closest("button") && openFold.contains(target) && !target.closest(".model-feature-more")) closeFold(true);
  });
  rail.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !openFold || !openFold.contains(ev.target as Node)) return;
    ev.preventDefault();
    ev.stopPropagation();
    closeFold(true);
  });
  document.addEventListener("pointerdown", (ev) => {
    if (openFold && !openFold.contains(ev.target as Node)) closeFold(false);
  }, true);
  window.addEventListener("resize", () => fitRail());
  window.addEventListener("lime-layout", () => fitRail());
  window.addEventListener("lime-rail", () => fitRail());
  // A drawer's labelled toggle is taller than the plain one.
  const ws = document.querySelector(".workspace");
  if (ws) new MutationObserver(() => fitRail()).observe(ws, { attributes: true, attributeFilter: ["class"] });
}

function showFold(group: HTMLElement, keyboard: boolean) {
  closeFold(false);
  const fold = group.querySelector<HTMLElement>(":scope > .rail-fold");
  const tools = group.querySelector<HTMLElement>(":scope > .rail-tools");
  const rail = group.closest<HTMLElement>("#toolRail");
  if (!fold || !tools || !rail) return;
  openFold = group;
  group.dataset.open = "";
  fold.setAttribute("aria-expanded", "true");
  const at = fold.getBoundingClientRect();
  tools.style.left = `${rail.getBoundingClientRect().right + 4}px`;
  tools.style.top = `${Math.max(8, Math.min(at.top - 4, window.innerHeight - tools.offsetHeight - 8))}px`;
  if (keyboard) tools.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function closeFold(refocus: boolean) {
  const group = openFold;
  if (!group) return;
  openFold = null;
  delete group.dataset.open;
  const fold = group.querySelector<HTMLElement>(":scope > .rail-fold");
  fold?.setAttribute("aria-expanded", "false");
  if (refocus) fold?.focus();
}

/**
 * Fit Model's tools to the rail's height, giving up the least first: the group captions, then 4 px of each button,
 * then whole groups, which fold into one button each, least used first. Everything comes back when there is room.
 * Runs on a resize, a stage change, and when a solid's tools come or go; never per frame.
 */
export function fitRail() {
  const rail = document.querySelector<HTMLElement>("#toolRail");
  if (!rail) return;
  closeFold(false);
  const overflows = () => rail.scrollHeight > rail.clientHeight + 1;
  const groups = FOLD_ORDER
    .map((name) => rail.querySelector<HTMLElement>(`.rail-group[data-group="${name}"]`))
    .filter((group): group is HTMLElement => !!group);
  const fold = (group: HTMLElement, on: boolean) => {
    group.toggleAttribute("data-folded", on);
    const button = group.querySelector<HTMLElement>(":scope > .rail-fold");
    if (!button) return;
    if (button.hidden === on) button.hidden = !on;
    // The group's first icon and its tools' names, taken once the Model code has labelled them.
    const tools = group.querySelector<HTMLElement>(":scope > .rail-tools");
    const icon = tools?.querySelector(".ico");
    if (on && icon && !button.querySelector(".ico")) {
      button.append(icon.cloneNode(true));
      const names = [...(tools?.querySelectorAll<HTMLElement>(".model-tool-label") ?? [])].map((label) => label.textContent).join(", ");
      button.dataset.tip = `${group.getAttribute("aria-label") ?? ""}: ${names}`;
    }
  };
  for (const group of groups) fold(group, false);
  delete rail.dataset.fit;
  if (document.documentElement.classList.contains("layout-compact") || rail.querySelector("#railModel")?.closest("[hidden]")) return;
  if (overflows()) rail.dataset.fit = "bare";
  if (overflows()) rail.dataset.fit = "dense";
  for (const group of groups) {
    if (!overflows()) break;
    // A group is display: contents, so its own box says nothing: a shown tool in it does.
    if (!group.querySelector<HTMLElement>(":scope > .rail-tools button")?.checkVisibility()) continue;
    fold(group, true);
  }
  rovingReset(rail);
}

/** The rail's reachable buttons: not in a hidden set or group. */
function railButtons(rail: HTMLElement) {
  // The Features menu's items are a menu's, not the toolbar's.
  return [...rail.querySelectorAll<HTMLButtonElement>("button")].filter((button) => !button.closest("[hidden], [role=menu]") && button.checkVisibility());
}

/** One tab stop for the rail: the arrows walk it, Home and End jump to its ends. */
function mountRovingFocus(rail: HTMLElement) {
  rail.addEventListener("focusin", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.tagName !== "BUTTON" || target.closest("[role=menu]")) return;
    for (const button of rail.querySelectorAll<HTMLButtonElement>("button")) button.tabIndex = button === target ? 0 : -1;
  });
  const steps: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
  rail.addEventListener("keydown", (ev) => {
    const step = steps[ev.key];
    // A menu in the rail (Features) walks its own items.
    if (step === undefined || ev.altKey || ev.ctrlKey || ev.metaKey || ev.defaultPrevented) return;
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
  if (buttons.length === 0) return;
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

export function syncSection() {
  const on = !!document.querySelector<HTMLInputElement>("#sectionOn")?.checked;
  document.querySelectorAll('#toolRail [data-tool="section"]').forEach((button) => button.setAttribute("aria-pressed", on ? "true" : "false"));
}

function syncLay(button: HTMLButtonElement) {
  const ready = !!document.querySelector("#layflat");
  button.classList.toggle("is-disabled", !ready);
  button.setAttribute("aria-disabled", ready ? "false" : "true");
}

