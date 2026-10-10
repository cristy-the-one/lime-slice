import { redoUserEdit, undoUserEdit } from "../app/history";
import {
  askProfileName,
  deleteSettingsProfile,
  duplicateSettingsProfile,
  exportSettingsProfile,
  openProfileFile,
  overwriteSettingsProfile,
  renameSettingsProfile,
  saveSettingsProfile,
  selectedProfileId,
} from "../app/profile-actions";
import { removePlateObject } from "../app/plate-actions";
import { saveCurrentProject } from "../app/project-io";
import { clearSettingsSearch, commitTypedFields, focusSettingsSearch, revealPrinterDetails } from "../app/settings";
import { state } from "../app/state";
import { scrub, setView } from "../app/viewer";
import { pickModelFile } from "../platform";
import { chordMatches, COMMANDS, helpGroups, MOUSE_HINTS, paletteCommands, rankCommands, shortcutOf, type CommandSpec } from "./commands";
import { pushToast } from "./toasts";
import "./phase2.css";

const MAX_ROWS = 12;
const PALETTE_CHORD = shortcutOf(COMMANDS.find((command) => command.id === "palette")!)!;

export function mountStageTabs() {
  const list = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Workspace"]');
  list?.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight" && ev.key !== "Home" && ev.key !== "End") return;
    const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const next = ev.key === "ArrowRight" ? tabs[(index + 1) % tabs.length]
      : ev.key === "ArrowLeft" ? tabs[(index - 1 + tabs.length) % tabs.length]
      : ev.key === "Home" ? tabs[0]
      : tabs[tabs.length - 1];
    next?.focus();
    next?.click();
  });
}

export function mountPalette() {
  const root = document.createElement("div");
  root.id = "palette";
  root.className = "palette";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "paletteLabel");
  root.innerHTML = `
    <div class="palette-card">
      <div class="palette-head">
        <label id="paletteLabel" for="paletteInput">Commands</label>
        <button class="btn" type="button" id="paletteClose">Close</button>
      </div>
      <input id="paletteInput" type="search" role="combobox" aria-expanded="true" aria-controls="paletteList" aria-autocomplete="list" placeholder="Search actions" autocomplete="off" />
      <ul id="paletteList" role="listbox" aria-label="Matching commands"></ul>
    </div>
  `;
  document.body.append(root);

  const input = root.querySelector<HTMLInputElement>("#paletteInput")!;
  const list = root.querySelector<HTMLUListElement>("#paletteList")!;
  const closeBtn = root.querySelector<HTMLButtonElement>("#paletteClose")!;
  let active = 0;
  let shown: CommandSpec[] = [];
  let restore: HTMLElement | null = null;

  function open() {
    if (!root.hidden) return;
    const help = document.querySelector<HTMLElement>("#help");
    if (help && !help.hidden) document.querySelector<HTMLButtonElement>("#helpClose")?.click();
    restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.hidden = false;
    document.documentElement.dataset.overlay = "palette";
    input.value = "";
    render("");
    input.focus();
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    if (document.documentElement.dataset.overlay === "palette") delete document.documentElement.dataset.overlay;
    list.innerHTML = "";
    restore?.focus();
    restore = null;
  }

  function render(query: string) {
    shown = rankCommands(paletteCommands(), query).slice(0, MAX_ROWS);
    active = 0;
    if (shown.length === 0) {
      list.innerHTML = `<li class="palette-empty" role="presentation">No matching commands</li>`;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    list.innerHTML = shown.map((command, index) => {
      const key = shortcutOf(command);
      const hint = key ? `<kbd>${escapeHtml(key)}</kbd>` : "";
      return `<li id="paletteOpt${index}" role="option" aria-selected="${index === 0 ? "true" : "false"}" data-id="${command.id}"><span>${escapeHtml(command.label)}<small>${escapeHtml(command.group)}</small></span>${hint}</li>`;
    }).join("");
    input.setAttribute("aria-activedescendant", "paletteOpt0");
  }

  function move(delta: number) {
    if (!shown.length) return;
    active = (active + delta + shown.length) % shown.length;
    list.querySelectorAll<HTMLElement>("[role=option]").forEach((el, index) => {
      el.setAttribute("aria-selected", index === active ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", `paletteOpt${active}`);
    list.querySelector(`#paletteOpt${active}`)?.scrollIntoView({ block: "nearest" });
  }

  function runActive() {
    const command = shown[active];
    if (!command) return;
    close();
    runCommand(command.id);
  }

  input.addEventListener("input", () => render(input.value));
  closeBtn.addEventListener("click", () => close());
  root.addEventListener("mousedown", (ev) => {
    if (ev.target === root) close();
  });
  list.addEventListener("mousemove", (ev) => {
    const option = (ev.target as Element | null)?.closest<HTMLElement>("[role=option]");
    if (!option) return;
    const index = Number(option.id.replace("paletteOpt", ""));
    if (!Number.isFinite(index) || index === active) return;
    active = index;
    list.querySelectorAll<HTMLElement>("[role=option]").forEach((el, i) => {
      el.setAttribute("aria-selected", i === active ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", option.id);
  });
  list.addEventListener("mousedown", (ev) => {
    const option = (ev.target as Element | null)?.closest<HTMLElement>("[role=option]");
    if (!option) return;
    ev.preventDefault();
    active = Number(option.id.replace("paletteOpt", ""));
    runActive();
  });

  document.addEventListener("lime-open-palette", open);

  // While open the palette owns every key. Opening is the `palette` command's, through `keys.ts`.
  window.addEventListener("keydown", (ev) => {
    if (root.hidden) return;
    const chord = chordMatches(PALETTE_CHORD, ev);
    if (chord || ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      ev.stopPropagation();
      move(1);
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      ev.stopPropagation();
      move(-1);
      return;
    }
    if (ev.key === "Home") {
      ev.preventDefault();
      ev.stopPropagation();
      active = 1;
      move(-1);
      return;
    }
    if (ev.key === "End") {
      ev.preventDefault();
      ev.stopPropagation();
      active = shown.length - 2;
      move(1);
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      runActive();
      return;
    }
    if (ev.key === "Tab") {
      ev.preventDefault();
      ev.stopPropagation();
      const order = ev.shiftKey ? [closeBtn, input] : [input, closeBtn];
      const next = document.activeElement === order[0] ? order[1] : order[0];
      next.focus();
      return;
    }
    if (ev.metaKey || ev.ctrlKey) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, true);
}

/** The whole shortcut sheet body, from the registry and the mouse gestures. */
export function fillHelpShortcuts(host: HTMLElement) {
  const section = (title: string, rows: { keys: string[]; label: string }[]) => {
    const items = rows.map((row) => `<li><span class="help-keys">${row.keys.map((key) => `<kbd>${escapeHtml(key)}</kbd>`).join(" ")}</span><span>${escapeHtml(row.label)}</span></li>`);
    return `<section class="help-group"><h3>${escapeHtml(title)}</h3><ul>${items.join("")}</ul></section>`;
  };
  const keys = helpGroups().map((group) => section(group.group, group.entries));
  const mouse = section("Mouse", MOUSE_HINTS.map((hint) => ({ keys: [hint.gesture], label: hint.label })));
  host.innerHTML = keys.join("") + mouse;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function click(selector: string) {
  document.querySelector<HTMLElement>(selector)?.click();
}

function visible(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  return !!el && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
}

function togglePanel(side: "left" | "right") {
  const collapse = side === "left" ? ".panel-collapse-left" : ".panel-collapse-right";
  const toggle = side === "left" ? "#toggleLeft" : "#toggleRight";
  if (visible(collapse)) click(collapse);
  else click(toggle);
}

function setTheme(value: string) {
  const select = document.querySelector<HTMLSelectElement>("#theme");
  if (!select) return;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function setLevel(level: string) {
  document.querySelector<HTMLButtonElement>(`[data-level-choice="${level}"]`)?.click();
}

function focusScale() {
  if (window.innerWidth <= 960) document.querySelector(".workspace")?.classList.add("show-left");
  const field = document.querySelector<HTMLInputElement>("#partScale");
  if (!field) return;
  field.focus();
  field.select();
}

const VIEW_CYCLE = ["flat", "split", "solid"] as const;

function stepBrush(by: number) {
  const radius = document.querySelector<HTMLInputElement>('.paint-bar:not([hidden]) input[type="range"]');
  if (!radius) return;
  radius.value = String(Math.min(Number(radius.max), Math.max(Number(radius.min), Number(radius.value) + by)));
  radius.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Slice from a key: a field still holding typed text stores it first, as clicking Slice would. */
function sliceFromKey(selector: string) {
  commitTypedFields();
  click(selector);
}

/** Runs the command's own case, else clicks its `target`. */
export function runCommand(id: string) {
  switch (id) {
    case "palette":
      document.dispatchEvent(new CustomEvent("lime-open-palette"));
      return;
    case "help":
      document.dispatchEvent(new CustomEvent("lime-open-help"));
      return;
    case "help-close":
      click("#helpClose");
      return;
    case "open":
      pickModelFile();
      return;
    case "save-project":
      void saveCurrentProject();
      return;
    case "samples": {
      const file = document.querySelector<HTMLDetailsElement>("#fileMenu");
      const menu = document.querySelector<HTMLDetailsElement>("#samples");
      if (file) file.open = true;
      if (menu) menu.open = true;
      return;
    }
    case "printer-pick": {
      const chip = document.querySelector<HTMLDetailsElement>("#printerChip");
      if (chip) chip.open = true;
      chip?.querySelector<HTMLSelectElement>("#machinePrinter")?.focus();
      return;
    }
    case "printer-edit":
      revealPrinterDetails();
      return;
    case "slice": {
      const button = document.querySelector<HTMLButtonElement>("#slice");
      if (!button) return;
      if (button.disabled) return;
      sliceFromKey("#slice");
      return;
    }
    case "force-slice":
      sliceFromKey("#force");
      return;
    case "send-printer": {
      const button = document.querySelector<HTMLButtonElement>("#sendPrinter");
      if (!button) return;
      if (button.disabled || button.hidden) return;
      button.click();
      return;
    }
    case "view-cycle":
      setView(VIEW_CYCLE[(VIEW_CYCLE.indexOf(state.viewMode) + 1) % VIEW_CYCLE.length]!, "user");
      return;
    case "layer-up":
      scrub(state.layer + 1);
      return;
    case "layer-down":
      scrub(state.layer - 1);
      return;
    case "layer-up-10":
      scrub(state.layer + 10);
      return;
    case "layer-down-10":
      scrub(state.layer - 10);
      return;
    case "layer-first":
      scrub(0);
      return;
    case "layer-last":
      scrub((state.result?.layers.length ?? 1) - 1);
      return;
    case "plate-remove":
      if (state.plate.selectedId) removePlateObject(state.plate.selectedId);
      return;
    case "tool-scale":
      focusScale();
      return;
    case "brush-smaller":
      stepBrush(-0.5);
      return;
    case "brush-larger":
      stepBrush(0.5);
      return;
    case "undo":
      undoUserEdit();
      return;
    case "redo":
      redoUserEdit();
      return;
    case "search":
      focusSettingsSearch();
      return;
    case "search-clear":
      clearSettingsSearch();
      return;
    case "theme-system":
      setTheme("system");
      return;
    case "theme-dark":
      setTheme("dark");
      return;
    case "theme-light":
      setTheme("light");
      return;
    case "level-simple":
      setLevel("simple");
      return;
    case "level-advanced":
      setLevel("advanced");
      return;
    case "level-expert":
      setLevel("expert");
      return;
    case "profile-save": {
      const typed = document.querySelector<HTMLInputElement>("#profileName")?.value.trim() ?? "";
      if (typed) saveSettingsProfile(typed);
      else if (selectedProfileId()) overwriteSettingsProfile(selectedProfileId());
      else {
        const name = askProfileName("");
        if (name) saveSettingsProfile(name);
      }
      return;
    }
    case "profile-rename": {
      const id = selectedProfileId();
      if (!id) {
        pushToast("Choose a profile first.", "info");
        return;
      }
      const current = document.querySelector<HTMLSelectElement>("#profilePick")?.selectedOptions[0]?.textContent ?? "";
      const name = askProfileName(current === "Current" ? "" : current);
      if (name) renameSettingsProfile(id, name);
      return;
    }
    case "profile-duplicate": {
      const id = selectedProfileId();
      if (!id) pushToast("Choose a profile first.", "info");
      else duplicateSettingsProfile(id);
      return;
    }
    case "profile-delete": {
      const id = selectedProfileId();
      if (!id) pushToast("Choose a profile first.", "info");
      else deleteSettingsProfile(id);
      return;
    }
    case "profile-export":
      exportSettingsProfile(selectedProfileId());
      return;
    case "profile-import":
      openProfileFile();
      return;
    case "panel-left":
      togglePanel("left");
      return;
    case "panel-right":
      togglePanel("right");
      return;
    default: {
      const target = COMMANDS.find((command) => command.id === id)?.target;
      if (target) click(target);
    }
  }
}

