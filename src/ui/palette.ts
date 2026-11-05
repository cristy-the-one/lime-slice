import { fx } from "../app/fx";
import { redoUserEdit, undoUserEdit } from "../app/history";
import { runSketchKey } from "../app/sketch-keys";
import { frameModel } from "../app/model";
import { escapeModel, openJoinTool } from "./model-chrome";
import { editModelStep, toggleModelHistoryFocus } from "./model-history";
import { toggleParameters } from "./parameters";
import { revealStress } from "./stress.ts";
import { togglePluginsPanel } from "./plugins-panel.ts";
import { openSplitPrint } from "./split-print.ts";
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
import { newProject } from "../app/new-project";
import { saveCurrentProject } from "../app/project-io";
import { clearSettingsSearch, commitTypedFields, focusSettingsSearch, revealPrinterDetails } from "../app/settings";
import { state } from "../app/state";
import { measureOn, setMeasureOn } from "../measure-pref";
import { scrub, setStage, setView } from "../app/viewer";
import { applyViewPreset } from "./viewport";
import { pickModelFile } from "../platform";
import { nudgeBrushRadius } from "./brush-radius";
import { chordMatches, COMMANDS, filterHelp, groupsForStage, paletteCommands, rankCommands, shortcutOf, sheetGroups, type CommandSpec, type HelpGroup } from "./commands";
import { loadRecent, pushRecent, withRecents } from "./palette-recent";
import { toggleDock } from "./splitters";
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
  let recentShown = 0;
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
    // The palette's own row is not offered while it is open. With nothing typed, the last five commands lead.
    const offered = paletteCommands().filter((command) => command.id !== "palette");
    if (query.trim()) {
      shown = rankCommands(offered, query).slice(0, MAX_ROWS);
      recentShown = 0;
    } else {
      const { top, rest } = withRecents(offered, loadRecent());
      shown = [...top, ...rest].slice(0, MAX_ROWS);
      recentShown = top.length;
    }
    active = 0;
    if (shown.length === 0) {
      list.innerHTML = `<li class="palette-empty" role="presentation">No matching commands</li>`;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    list.innerHTML = shown.map((command, index) => {
      const key = shortcutOf(command);
      const hint = key ? `<kbd>${escapeHtml(key)}</kbd>` : "";
      return `<li id="paletteOpt${index}" role="option" aria-selected="${index === 0 ? "true" : "false"}" data-id="${command.id}"><span>${escapeHtml(command.label)}<small>${index < recentShown ? "Recent, " : ""}${escapeHtml(command.group)}</small></span>${hint}</li>`;
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
    pushRecent(command.id);
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
    // Keep the input's native editing keys, including AltGr on Windows/Linux.
    if (document.activeElement === input && (ev.getModifierState("AltGraph") ||
        ((ev.ctrlKey || ev.metaKey) && /^[acvxyz]$/i.test(ev.key)))) return;
    // A focused Close button must receive its native Enter/Space activation.
    if (document.activeElement === closeBtn && (ev.key === "Enter" || ev.key === " ")) return;
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

/**
 * The shortcut sheet, from the registry and the mouse gestures. A group is a folded section; only this workspace's
 * groups start open. The search box filters rows with the palette's matching and opens every group that has a hit.
 */
export function fillHelpShortcuts(host: HTMLElement) {
  const search = document.querySelector<HTMLInputElement>("#helpSearch");
  const everything: HelpGroup[] = sheetGroups();
  const open = new Set<string>();

  const section = (group: HelpGroup, isOpen: boolean) => {
    const rows = group.entries.map((entry) => {
      const context = entry.context && entry.context !== group.group ? ` <small class="help-ctx">${escapeHtml(entry.context)}</small>` : "";
      return `<li><span class="help-keys">${entry.keys.map((key) => `<kbd>${escapeHtml(key)}</kbd>`).join(" ")}</span><span class="help-what"><span class="help-label">${escapeHtml(entry.label)}</span>${context}</span></li>`;
    });
    return `<details class="help-group" data-group="${escapeHtml(group.group)}"${isOpen ? " open" : ""}><summary><h3>${escapeHtml(group.group)}</h3><span class="help-count">${group.entries.length}</span></summary><ul>${rows.join("")}</ul></details>`;
  };

  const paint = () => {
    const query = search?.value ?? "";
    const searching = query.trim() !== "";
    const groups = filterHelp(everything, query);
    host.innerHTML = groups.length
      ? groups.map((group) => section(group, searching || open.has(group.group))).join("")
      : `<p class="help-empty">No shortcut matches "${escapeHtml(query.trim())}".</p>`;
  };

  host.addEventListener("click", (ev) => {
    const summary = (ev.target as Element | null)?.closest("summary");
    const group = summary?.parentElement;
    if (!(group instanceof HTMLDetailsElement) || !group.dataset.group || (search?.value.trim() ?? "") !== "") return;
    // The browser flips `open` after this handler, so the old value says which way it is going.
    if (group.open) open.delete(group.dataset.group);
    else open.add(group.dataset.group);
  });
  search?.addEventListener("input", paint);
  document.addEventListener("lime-help-opened", () => {
    if (search) search.value = "";
    open.clear();
    const sketchPhase = document.querySelector("#model")?.getAttribute("data-sketch");
    for (const name of groupsForStage(state.stage, state.stage === "model" && (sketchPhase === "editing" || sketchPhase === "choosing"))) open.add(name);
    paint();
    search?.focus();
  });
  paint();
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function click(selector: string) {
  for (const part of selector.split(",")) {
    const el = document.querySelector<HTMLElement>(part.trim());
    if (!el?.isConnected || el.closest("[hidden]") || el.getClientRects().length === 0) continue;
    el.click();
    return;
  }
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

const VIEW_CYCLE = ["flat", "split", "solid"] as const;

function stepBrush(by: number) {
  nudgeBrushRadius(by);
}

/** Slice from a key: a field still holding typed text stores it first, as clicking Slice would. */
function sliceFromKey(selector: string) {
  commitTypedFields();
  click(selector);
}

/** Runs the command's own case, else clicks its `target`. */
export function runCommand(id: string) {
  if (id.startsWith("sketch-")) {
    runSketchKey(id);
    return;
  }
  switch (id) {
    case "palette":
      document.dispatchEvent(new CustomEvent("lime-open-palette"));
      return;
    case "help":
      document.dispatchEvent(new CustomEvent("lime-open-help"));
      return;
    case "help-close":
    case "help-close-key":
      click("#helpClose");
      return;
    case "new-project":
      void newProject();
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
    case "calibrate":
      document.dispatchEvent(new CustomEvent("lime-open-calibrate"));
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
    case "brush-smaller":
      stepBrush(-0.5);
      return;
    case "brush-larger":
      stepBrush(0.5);
      return;
    case "undo":
      // In Model this steps the solid's history only, never Prepare's, even with nothing left to undo.
      if (state.stage === "model") {
        const button = document.querySelector<HTMLButtonElement>("#modelUndo");
        if (button && !button.disabled) button.click();
        return;
      }
      undoUserEdit();
      return;
    case "model-escape":
      escapeModel();
      return;
    case "model-view-top":
      fx.model?.setCameraPreset("top");
      return;
    case "model-view-front":
      fx.model?.setCameraPreset("front");
      return;
    case "model-view-iso":
      fx.model?.setCameraPreset("iso");
      return;
    case "model-join":
      openJoinTool();
      return;
    case "model-reset-view":
      // The button sits in the View menu, which is hidden until it opens. Clicking it does nothing.
      frameModel(false);
      return;
    case "model-frame-all":
      frameModel(true);
      return;
    case "model-history":
      toggleModelHistoryFocus();
      return;
    case "model-edit-step":
      editModelStep();
      return;
    case "model-parameters":
      toggleParameters();
      return;
    case "model-stress":
      revealStress();
      return;
    case "model-plugins":
      togglePluginsPanel();
      return;
    case "model-split-print":
      openSplitPrint();
      return;
    case "redo":
      // In Model this steps the solid's history only, never Prepare's, even with nothing left to redo.
      if (state.stage === "model") {
        const button = document.querySelector<HTMLButtonElement>("#modelRedo");
        if (button && !button.disabled) button.click();
        return;
      }
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
      toggleDock("left");
      return;
    case "panel-right":
      toggleDock("right");
      return;
    case "tab-prepare":
      setStage("prepare");
      return;
    case "tab-preview":
      setStage("preview");
      return;
    case "tab-gcode":
      setStage("gcode");
      return;
    case "tab-model":
      setStage("model");
      return;
    case "view-top":
      applyViewPreset("top");
      return;
    case "view-front":
      applyViewPreset("front");
      return;
    case "view-iso":
      applyViewPreset("iso");
      return;
    case "measure":
      setMeasureOn(!measureOn());
      return;
    case "restore-hidden": {
      const root = document.documentElement;
      if (root.classList.contains("layout-compact") && root.classList.contains("chrome-hidden")) {
        document.querySelector<HTMLButtonElement>("#compactChromeShow")?.click();
        return;
      }
      document.querySelector<HTMLButtonElement>("#contextBarRestore")?.click();
      return;
    }
    default: {
      const target = COMMANDS.find((command) => command.id === id)?.target;
      if (target) click(target);
    }
  }
}

