import {
  ArrowDownToLine,
  createElement,
  Download,
  Printer,
  Layers,
  Move3d,
  RefreshCw,
  Rotate3d,
  Scaling,
  SquareSplitHorizontal,
  TreeDeciduous,
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
}

function mountToolRail(hooks: ChromeHooks) {
  const host = document.querySelector("#stage");
  const rail = document.createElement("nav");
  rail.id = "toolRail";
  rail.className = "tool-rail";
  rail.setAttribute("aria-label", "Prepare tools");
  rail.dataset.tool = "all";

  const move = toolButton("move", Move3d, "Move", "Drag the part on the bed, or an arrow. Shift snaps 1 mm.");
  const rotate = toolButton("rotate", Rotate3d, "Rotate", "Drag a ring. Shift snaps 15°.");
  const scale = toolButton("scale", Scaling, "Scale", "No scale gizmo yet. Use Scale % in the mesh panel.");
  scale.classList.add("is-disabled");
  scale.setAttribute("aria-disabled", "true");
  scale.tabIndex = -1;
  const lay = toolButton("layflat", ArrowDownToLine, "Lay flat", "Drop the flattest face onto the bed.");
  lay.classList.add("is-disabled");
  lay.setAttribute("aria-disabled", "true");
  const section = toolButton("section", SquareSplitHorizontal, "Section", "Clip the preview. Does not change the slice.");
  section.setAttribute("aria-pressed", "false");
  const supports = toolButton("supports", TreeDeciduous, "Edit supports", "Pick tree supports to delete or regrow. Does not move the part.");
  supports.setAttribute("aria-pressed", "false");
  supports.classList.add("is-disabled");
  supports.setAttribute("aria-disabled", "true");

  const sep = document.createElement("div");
  sep.className = "rail-sep";
  rail.append(move, rotate, scale, lay, sep, section, supports, gizmoNudge());
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

