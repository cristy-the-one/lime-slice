import { ChevronLeft, ChevronRight, createElement, type IconNode } from "lucide";

const LEFT_KEY = "lime-slice-panel-left";
const RIGHT_KEY = "lime-slice-panel-right";
const LEFT_COLLAPSE = "lime-slice-panel-left-collapsed";
const RIGHT_COLLAPSE = "lime-slice-panel-right-collapsed";

const LEFT_MIN = 180;
const LEFT_MAX = 480;
const RIGHT_MIN = 240;
const RIGHT_MAX = 560;

export function mountSplitters() {
  const workspace = document.querySelector<HTMLElement>(".workspace");
  if (!workspace || workspace.querySelector(".splitter")) return;

  const left = mountHandle(workspace, "left", "Resize settings");
  const right = mountHandle(workspace, "right", "Resize blend");
  const collapseLeft = mountCollapse(workspace, "left", "Collapse settings", ChevronLeft);
  const collapseRight = mountCollapse(workspace, "right", "Collapse blend", ChevronRight);

  const storedLeft = readWidth(LEFT_KEY);
  const storedRight = readWidth(RIGHT_KEY);
  if (storedLeft) workspace.style.setProperty("--panel-left", `${storedLeft}px`);
  if (storedRight) workspace.style.setProperty("--panel-right", `${storedRight}px`);
  if (localStorage.getItem(LEFT_COLLAPSE) === "1") setCollapsed(workspace, "left", true, collapseLeft);
  if (localStorage.getItem(RIGHT_COLLAPSE) === "1") setCollapsed(workspace, "right", true, collapseRight);

  bindDrag(workspace, left, "left", collapseLeft);
  bindDrag(workspace, right, "right", collapseRight);
  collapseLeft.addEventListener("click", () => toggleCollapsed(workspace, "left", collapseLeft));
  collapseRight.addEventListener("click", () => toggleCollapsed(workspace, "right", collapseRight));
}

function mountHandle(workspace: HTMLElement, side: "left" | "right", label: string) {
  const handle = document.createElement("div");
  handle.className = `splitter splitter-${side}`;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", label);
  workspace.append(handle);
  return handle;
}

function mountCollapse(workspace: HTMLElement, side: "left" | "right", label: string, icon: IconNode) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `btn panel-collapse panel-collapse-${side}`;
  button.setAttribute("aria-label", label);
  button.append(createElement(icon, { width: 14, height: 14, "aria-hidden": "true", class: "ico" }));
  workspace.append(button);
  return button;
}

function bindDrag(
  workspace: HTMLElement,
  handle: HTMLElement,
  side: "left" | "right",
  collapse: HTMLButtonElement,
) {
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || workspace.classList.contains(side === "left" ? "is-left-collapsed" : "is-right-collapsed")) return;
    ev.preventDefault();
    handle.classList.add("is-drag");
    handle.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => {
      const rect = workspace.getBoundingClientRect();
      const px = side === "left"
        ? clamp(e.clientX - rect.left, LEFT_MIN, LEFT_MAX)
        : clamp(rect.right - e.clientX, RIGHT_MIN, RIGHT_MAX);
      applyWidth(workspace, side, px);
    };
    const up = () => {
      handle.classList.remove("is-drag");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  handle.addEventListener("dblclick", () => {
    localStorage.removeItem(side === "left" ? LEFT_KEY : RIGHT_KEY);
    workspace.style.removeProperty(side === "left" ? "--panel-left" : "--panel-right");
    setCollapsed(workspace, side, false, collapse);
    localStorage.setItem(side === "left" ? LEFT_COLLAPSE : RIGHT_COLLAPSE, "0");
  });
}

function toggleCollapsed(workspace: HTMLElement, side: "left" | "right", button: HTMLButtonElement) {
  const collapsed = !workspace.classList.contains(side === "left" ? "is-left-collapsed" : "is-right-collapsed");
  setCollapsed(workspace, side, collapsed, button);
  localStorage.setItem(side === "left" ? LEFT_COLLAPSE : RIGHT_COLLAPSE, collapsed ? "1" : "0");
}

function setCollapsed(workspace: HTMLElement, side: "left" | "right", collapsed: boolean, button: HTMLButtonElement) {
  workspace.classList.toggle(side === "left" ? "is-left-collapsed" : "is-right-collapsed", collapsed);
  const prop = side === "left" ? "--panel-left" : "--panel-right";
  if (collapsed) {
    workspace.style.setProperty(prop, "28px");
    button.setAttribute("aria-label", side === "left" ? "Expand settings" : "Expand blend");
  } else {
    const stored = readWidth(side === "left" ? LEFT_KEY : RIGHT_KEY);
    if (stored) workspace.style.setProperty(prop, `${stored}px`);
    else workspace.style.removeProperty(prop);
    button.setAttribute("aria-label", side === "left" ? "Collapse settings" : "Collapse blend");
  }
  window.dispatchEvent(new Event("resize"));
}

function applyWidth(workspace: HTMLElement, side: "left" | "right", px: number) {
  workspace.style.setProperty(side === "left" ? "--panel-left" : "--panel-right", `${px}px`);
  localStorage.setItem(side === "left" ? LEFT_KEY : RIGHT_KEY, String(px));
  window.dispatchEvent(new Event("resize"));
}

function readWidth(key: string) {
  const value = Number(localStorage.getItem(key));
  if (!Number.isFinite(value) || value < 100) return 0;
  return value;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
