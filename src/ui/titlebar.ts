import { createElement, Minus, Settings, Square, X, type IconNode } from "lucide";
import { isDesktopShell, isTauri } from "../platform";

const CHROME_KEY = "lime-slice-chrome";

function svgIcon(node: IconNode, size = 16) {
  return createElement(node, {
    width: size,
    height: size,
    "aria-hidden": "true",
    class: "ico",
  });
}

/** Custom titlebar controls, centered workspace tabs, and the theme gear. Browser stays on the native frame. */
export function mountTitlebar() {
  const top = document.querySelector<HTMLElement>(".top");
  if (!top || top.dataset.ready === "1") return;
  top.dataset.ready = "1";
  top.classList.add("titlebar");
  top.setAttribute("data-tauri-drag-region", "");
  document.documentElement.dataset.chrome = "native";

  const tabs = document.querySelector<HTMLElement>('#stage [role="tablist"]');
  const action = top.querySelector(".action-row");
  if (tabs && action) {
    tabs.classList.add("title-tabs");
    action.before(tabs);
  }

  const gear = document.createElement("details");
  gear.id = "gear";
  gear.className = "menu gear-menu";
  const summary = document.createElement("summary");
  summary.className = "btn";
  summary.setAttribute("aria-label", "Theme and connection");
  summary.dataset.tip = "Theme and connection";
  summary.append(svgIcon(Settings));
  const panel = document.createElement("div");
  panel.className = "gear-panel";
  const theme = document.querySelector(".theme-field");
  if (theme) panel.append(theme);
  const native = document.createElement("label");
  native.className = "check tauri-only";
  native.innerHTML = `<input id="nativeFrame" type="checkbox" /> System title bar`;
  panel.append(native);
  gear.append(summary, panel);
  action?.after(gear);

  const wins = document.createElement("div");
  wins.className = "win-controls";
  wins.append(
    winButton("winMin", "Minimize", Minus),
    winButton("winMax", "Maximize", Square),
    winButton("winClose", "Close", X, "win-close"),
  );
  top.append(wins);

  void bindWindow(gear);
}

function winButton(id: string, label: string, icon: IconNode, extra = "") {
  const button = document.createElement("button");
  button.id = id;
  button.type = "button";
  button.className = `btn ${extra}`.trim();
  button.setAttribute("aria-label", label);
  button.append(svgIcon(icon, 14));
  return button;
}

async function bindWindow(gear: HTMLDetailsElement) {
  if (!isTauri()) return;
  document.documentElement.dataset.tauri = "1";
  if (!isDesktopShell()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const stored = localStorage.getItem(CHROME_KEY);
  if (stored === "native" || stored === "custom") {
    await win.setDecorations(stored === "native");
  }
  const decorated = await win.isDecorated();
  applyChrome(decorated);
  const box = document.querySelector<HTMLInputElement>("#nativeFrame");
  if (box) {
    box.checked = decorated;
    box.addEventListener("change", () => {
      const native = box.checked;
      localStorage.setItem(CHROME_KEY, native ? "native" : "custom");
      applyChrome(native);
      void win.setDecorations(native);
      gear.open = false;
    });
  }
  document.querySelector("#winMin")?.addEventListener("click", () => void win.minimize());
  document.querySelector("#winMax")?.addEventListener("click", () => void win.toggleMaximize());
  document.querySelector("#winClose")?.addEventListener("click", () => void win.close());
}

function applyChrome(decorated: boolean) {
  document.documentElement.dataset.chrome = decorated ? "native" : "custom";
}
