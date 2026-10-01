import {
  ArrowDownToLine,
  Boxes,
  createElement,
  Download,
  FolderOpen,
  Layers,
  Move3d,
  RefreshCw,
  Rotate3d,
  Scaling,
  SquareSplitHorizontal,
  X,
  type IconNode,
} from "lucide";
import { mountTooltips } from "./tooltip";
import "./chrome.css";

export type GizmoTool = "all" | "move" | "rotate";

export interface ChromeHooks {
  setGizmoTool(tool: GizmoTool): void;
  onToolReadout(): void;
}

export function mountChrome(hooks: ChromeHooks) {
  iconizeToolbar();
  mountTooltips();
  const rail = mountToolRail(hooks);
  mountShortcuts(hooks, rail);
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

function hint(el: Element | null, tip: string, shortcut = "") {
  if (!el || !(el instanceof HTMLElement)) return;
  el.dataset.tip = tip;
  if (shortcut) el.dataset.shortcut = shortcut;
  el.removeAttribute("title");
}

function iconizeToolbar() {
  const open = document.querySelector("#file")?.closest("label") ?? null;
  iconize(open, FolderOpen);
  hint(open, "Open a mesh", "Ctrl+O");

  const samples = document.querySelector("#samples summary");
  iconize(samples, Boxes);
  hint(samples, "Load a sample mesh");

  iconize(document.querySelector("#slice"), Layers);
  document.querySelector<HTMLElement>("#slice")?.setAttribute("data-shortcut", "Ctrl+Enter");

  iconize(document.querySelector("#cancel"), X);
  hint(document.querySelector("#cancel"), "Stop the slice in progress");

  iconize(document.querySelector("#export"), Download);
  hint(document.querySelector("#export"), "Save G-code", "Ctrl+E");

  iconize(document.querySelector("#force"), RefreshCw);
}

function mountToolRail(hooks: ChromeHooks) {
  const host = document.querySelector("#stage");
  const rail = document.createElement("nav");
  rail.id = "toolRail";
  rail.className = "tool-rail";
  rail.setAttribute("aria-label", "Prepare tools");
  rail.dataset.tool = "all";

  const move = toolButton("move", Move3d, "Move", "M", "Drag an arrow. Shift snaps 1 mm.");
  const rotate = toolButton("rotate", Rotate3d, "Rotate", "R", "Drag a ring. Shift snaps 15°.");
  const scale = toolButton("scale", Scaling, "Scale", "S", "No scale gizmo yet. Use Scale % in the mesh panel.");
  scale.classList.add("is-disabled");
  scale.setAttribute("aria-disabled", "true");
  scale.tabIndex = -1;
  const lay = toolButton("layflat", ArrowDownToLine, "Lay flat", "F", "Drop the flattest face onto the bed.");
  lay.classList.add("is-disabled");
  lay.setAttribute("aria-disabled", "true");
  const section = toolButton("section", SquareSplitHorizontal, "Section", "C", "Clip the preview. Does not change the slice.");
  section.setAttribute("aria-pressed", "false");

  const sep = document.createElement("div");
  sep.className = "rail-sep";
  rail.append(move, rotate, scale, lay, sep, section);
  host?.before(rail);

  const buttons = { move, rotate, scale, lay, section };

  rail.addEventListener("click", (ev) => {
    const button = (ev.target as Element | null)?.closest<HTMLButtonElement>("button");
    if (!button || button.classList.contains("is-disabled")) return;
    const id = button.dataset.tool;
    if (id === "move" || id === "rotate") selectManipulator(id, buttons, hooks);
    if (id === "layflat") document.querySelector<HTMLButtonElement>("#layflat")?.click();
    if (id === "section") toggleSection();
  });

  document.querySelector("#sectionOn")?.addEventListener("change", () => syncSection(section));
  const left = document.querySelector("#left");
  if (left) new MutationObserver(() => syncLay(lay)).observe(left, { childList: true, subtree: true });
  syncLay(lay);
  syncSection(section);
  return buttons;
}

function toolButton(id: string, node: IconNode, label: string, shortcut: string, tip: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tool";
  button.dataset.tool = id;
  button.dataset.tip = tip;
  button.dataset.shortcut = shortcut;
  button.setAttribute("aria-label", label);
  button.append(svgIcon(node));
  return button;
}

function selectManipulator(
  next: "move" | "rotate",
  buttons: { move: HTMLButtonElement; rotate: HTMLButtonElement },
  hooks: ChromeHooks,
) {
  const rail = document.querySelector<HTMLElement>("#toolRail");
  const current = rail?.dataset.tool;
  const tool: GizmoTool = current === next ? "all" : next;
  if (rail) rail.dataset.tool = tool;
  buttons.move.setAttribute("aria-pressed", tool === "move" ? "true" : "false");
  buttons.rotate.setAttribute("aria-pressed", tool === "rotate" ? "true" : "false");
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

function syncSection(button: HTMLButtonElement) {
  const on = !!document.querySelector<HTMLInputElement>("#sectionOn")?.checked;
  button.setAttribute("aria-pressed", on ? "true" : "false");
}

function syncLay(button: HTMLButtonElement) {
  const ready = !!document.querySelector("#layflat");
  button.classList.toggle("is-disabled", !ready);
  button.setAttribute("aria-disabled", ready ? "false" : "true");
  if (ready) button.tabIndex = 0;
  else button.tabIndex = -1;
}

function mountShortcuts(
  hooks: ChromeHooks,
  buttons: { move: HTMLButtonElement; rotate: HTMLButtonElement },
) {
  window.addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
    const target = ev.target as HTMLElement | null;
    const tag = target?.tagName;
    const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || !!target?.isContentEditable;
    if (typing) return;
    const help = document.querySelector("#help");
    if (help && !help.hasAttribute("hidden")) return;
    const key = ev.key.toLowerCase();
    if (key === "m") {
      selectManipulator("move", buttons, hooks);
      ev.preventDefault();
    } else if (key === "r") {
      selectManipulator("rotate", buttons, hooks);
      ev.preventDefault();
    } else if (key === "s") {
      focusScale();
      ev.preventDefault();
    } else if (key === "f") {
      document.querySelector<HTMLButtonElement>("#layflat")?.click();
      ev.preventDefault();
    } else if (key === "c") {
      toggleSection();
      ev.preventDefault();
    }
  });
}

function focusScale() {
  if (window.innerWidth <= 960) document.querySelector(".workspace")?.classList.add("show-left");
  const field = document.querySelector<HTMLInputElement>("#partScale");
  if (!field) return;
  field.focus();
  field.select();
}
