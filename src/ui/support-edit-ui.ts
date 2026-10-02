import { createElement, TreeDeciduous, X } from "lucide";
import type { CoverageGap, EditOutcome, SupportSkeleton } from "../support-edits";
import { alignOutcomes, appendEdit, badgeOf, clearEdits, editTitle, gapsToShow, outcomeText, removeEdit, undoLast, type EditEntry } from "../support-edit-list";
import { capsulesOf, indexSkeleton, pickGap, pickLimb, regrowFor, selectLimbs, sitesOf, type LimbIndex, type PickScope, type Visible } from "../support-pick";
import type { PickEvent, SliceView3d } from "../view3d";
import { isMobileLayout } from "../platform";
import { haptic } from "./haptics";
import { pushToast } from "./toasts";
import { chipAction, peekLine, scopeForGesture, selectionLabel, type CompactSelection } from "./compact/support-gesture";
import "./support-edit.css";

/** What the edit UI reads from the app each time it paints or picks. */
export interface SupportEditView {
  /** The shown result, null before the first slice. */
  result: { skeleton?: SupportSkeleton; coverage?: CoverageGap[]; supportEdits?: EditOutcome[] } | null;
  /** The edit list the shown result's request carried. */
  sent: readonly EditEntry[];
  edits: readonly EditEntry[];
  busy: boolean;
  /** Edits travel with the next slice only while this holds. */
  treeSupports: boolean;
  visible: Visible;
  /** The legend shows support, so limbs can be picked. */
  supportShown: boolean;
}

export interface SupportEditHooks {
  view(): SupportEditView;
  /** Keep `next` as the edit list and slice with it. */
  apply(next: EditEntry[]): void;
  /** Show the 3D preview. */
  reveal(): void;
}

type Target = { kind: "limb"; limb: number; scope: PickScope } | { kind: "gap"; gap: CoverageGap } | null;
type Why = "append" | "remove" | "clear";

const OTHER: Record<PickScope, PickScope> = { branch: "tree", tree: "branch" };
const SCOPE_LABEL: Record<PickScope, string> = { branch: "Branch", tree: "Tree" };
/** Pick tolerance past a limb's radius: a fixed floor plus a few screen pixels. */
const SLOP_MM = 0.3;
const SLOP_PX = 4;
const X_ICON = createElement(X, { width: 14, height: 14, "aria-hidden": "true", class: "ico" }).outerHTML;

export function mountSupportEdits(view3d: SliceView3d, hooks: SupportEditHooks) {
  const pane = document.querySelector<HTMLElement>("#pane3d")!;
  const toggle = document.querySelector<HTMLButtonElement>('#toolRail [data-tool="supports"]');
  const bar = document.createElement("div");
  bar.className = "support-editbar";
  bar.id = "supportEditbar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Edit supports");
  bar.hidden = true;
  bar.innerHTML = `
    <div class="se-scope" role="group" aria-label="Pick scope">
      <button type="button" data-scope="branch">${SCOPE_LABEL.branch}</button><button type="button" data-scope="tree">${SCOPE_LABEL.tree}</button>
    </div>
    <span class="se-readout" id="supportReadout"></span>
    <button class="btn se-danger" type="button" data-action="delete" aria-keyshortcuts="Delete"><span></span><kbd aria-hidden="true">Del</kbd></button>
    <button class="btn" type="button" data-action="regrow-selected" hidden>Regrow here</button>
    <button class="btn" type="button" data-action="done">Done</button>`;
  const scopeButtons = [...bar.querySelectorAll<HTMLButtonElement>("[data-scope]")];
  const readout = bar.querySelector<HTMLElement>(".se-readout")!;
  const deleteButton = bar.querySelector<HTMLButtonElement>('[data-action="delete"]')!;
  const regrowButton = bar.querySelector<HTMLButtonElement>('[data-action="regrow-selected"]')!;
  const panel = document.createElement("section");
  panel.className = "support-edits";
  panel.id = "supportEdits";
  panel.setAttribute("aria-label", "Support edits");
  panel.hidden = true;
  pane.append(bar, panel);

  const compactBtn = document.createElement("button");
  compactBtn.type = "button";
  compactBtn.id = "compactSupportEdit";
  compactBtn.className = "compact-hit";
  compactBtn.setAttribute("aria-label", "Edit supports");
  compactBtn.hidden = true;
  compactBtn.append(createElement(TreeDeciduous, { width: 18, height: 18, "aria-hidden": "true", class: "ico" }));
  const compactChip = document.createElement("div");
  compactChip.id = "compactSupportChip";
  compactChip.hidden = true;
  compactChip.innerHTML = `<span id="compactSupportChipLabel"></span><button type="button" id="compactSupportChipAction"></button>`;
  const chipLabel = compactChip.querySelector<HTMLElement>("#compactSupportChipLabel")!;
  const chipButton = compactChip.querySelector<HTMLButtonElement>("#compactSupportChipAction")!;
  document.querySelector("#stage")?.append(compactBtn, compactChip);

  let editing = false;
  let scope: PickScope = "branch";
  /** Set by a long-press so the click that follows takes the whole tree. */
  let nextScope: PickScope | null = null;
  let compactAnnounced = false;
  let hover: Target = null;
  let selected: Target = null;
  let expanded = false;
  let announce: Why | null = null;
  let nextId = 1;
  let lastMove: PickEvent | null = null;
  let panelHtml = "";
  let index: LimbIndex | null = null;
  let gaps: CoverageGap[] = [];
  let gapsFor: { result: SupportEditView["result"]; sent: readonly EditEntry[] } | null = null;
  const caps = new WeakMap<object, Float32Array>();

  function sync(v: SupportEditView) {
    const skeleton = v.result?.skeleton ?? null;
    if (skeleton !== (index?.skel ?? null)) {
      index = skeleton ? indexSkeleton(skeleton) : null;
      hover = null;
      selected = null;
    }
    if (gapsFor?.result !== v.result || gapsFor.sent !== v.sent) {
      gaps = gapsToShow(v.result?.coverage, v.sent, v.result?.supportEdits);
      gapsFor = { result: v.result, sent: v.sent };
      if (selected?.kind === "gap" && !gaps.includes(selected.gap)) selected = null;
      if (hover?.kind === "gap" && !gaps.includes(hover.gap)) hover = null;
    }
  }

  function ready() {
    return !!index && index.skel.id.length > 0;
  }

  function limbsOf(t: Target & { kind: "limb" }) {
    return selectLimbs(index!, t.limb, t.scope);
  }

  function capsulesFor(t: Target) {
    if (t?.kind !== "limb" || !index) return null;
    let hit = caps.get(t);
    if (!hit) {
      hit = capsulesOf(index, limbsOf(t));
      caps.set(t, hit);
    }
    return hit;
  }

  function same(a: Target, b: Target) {
    if (a?.kind === "gap" && b?.kind === "gap") return a.gap === b.gap;
    if (a?.kind === "limb" && b?.kind === "limb") return a.limb === b.limb && a.scope === b.scope;
    return a === b;
  }

  function pickAt(ev: PickEvent): Target {
    const v = hooks.view();
    const held = ev.kind === "click" ? nextScope : null;
    if (ev.kind === "click") nextScope = null;
    const picked = held ?? (ev.shiftKey ? OTHER[scope] : scope);
    const limb = v.supportShown && index ? pickLimb(index, ev.ray, v.visible, SLOP_MM + SLOP_PX * ev.pixelMm) : null;
    const gap = pickGap(gaps, ev.ray, v.visible, SLOP_PX * ev.pixelMm);
    if (gap && (!limb || gap.distance < limb.distance)) return { kind: "gap", gap: gaps[gap.gap] };
    return limb ? { kind: "limb", limb: limb.limb, scope: picked } : null;
  }

  function describe(t: Target) {
    if (!t) return scope === "branch" ? "Click a support. Shift-click takes the whole tree." : "Click a support. Shift-click takes one branch.";
    if (t.kind === "gap") return `Unheld · ${t.gap.areaMm2.toFixed(1)} mm² · Z ${t.gap.z[0].toFixed(2)}–${t.gap.z[1].toFixed(2)}`;
    const n = sitesOf(index!, limbsOf(t)).length;
    return `${SCOPE_LABEL[t.scope]} · ${n} tip${n === 1 ? "" : "s"}`;
  }

  function paintBar(v: SupportEditView) {
    bar.hidden = !editing;
    if (!editing) return;
    const locked = v.busy || !v.treeSupports;
    for (const button of scopeButtons) button.setAttribute("aria-pressed", button.dataset.scope === scope ? "true" : "false");
    readout.textContent = describe(selected ?? hover);
    const onGap = selected?.kind === "gap";
    deleteButton.hidden = onGap;
    regrowButton.hidden = !onGap;
    deleteButton.firstElementChild!.textContent = `Delete ${selected?.kind === "limb" ? selected.scope : scope}`;
    deleteButton.disabled = locked || selected?.kind !== "limb";
    regrowButton.disabled = locked;
  }

  function paintPanel(v: SupportEditView) {
    const shown = editing || v.edits.length > 0;
    panel.hidden = !shown;
    panel.classList.toggle("is-editing", editing);
    if (!shown) return;
    const open = editing || expanded;
    const outcomes = alignOutcomes(v.edits, v.sent, v.result?.supportEdits ?? []);
    const dis = v.busy ? " disabled" : "";
    const head = editing
      ? `<h2 class="se-title">Support edits</h2>`
      : `<button type="button" class="se-chip" data-action="expand" aria-expanded="${open}">Support edits · ${v.edits.length}</button>`;
    const tools = open && v.edits.length
      ? `<div class="se-tools"><button class="btn" type="button" data-action="undo"${dis}>Undo last</button><button class="btn" type="button" data-action="clear"${dis}>Clear all</button></div>`
      : "";
    let body = "";
    if (open) {
      const rows = v.edits.map((entry, i) => {
        const outcome = outcomes[i];
        const badge = badgeOf(outcome);
        const text = outcome ? outcomeText(entry, outcome) : "Not applied yet. Slice to apply.";
        return `<li class="se-row" data-edit="${entry.id}">
          <span class="se-idx">${i + 1}</span><span class="se-name">${editTitle(entry)}</span>
          <span class="se-badge" data-badge="${badge}">${badge}</span>
          <button class="se-remove" type="button" data-action="remove" data-id="${entry.id}" aria-label="Remove this edit"${dis}>${X_ICON}</button>
          <p class="se-text">${text}</p>
        </li>`;
      }).join("");
      body += v.edits.length ? `<ol class="se-rows">${rows}</ol>` : editing ? `<p class="se-empty">No edits yet.</p>` : "";
      if (editing && gaps.length) {
        const locked = v.busy || !v.treeSupports ? " disabled" : "";
        const items = gaps.map((gap, i) => `<li class="se-gap" data-gap="${i}"${hotGap() === i ? ' data-hot="true"' : ""}>
          <span>Z ${gap.z[0].toFixed(2)}–${gap.z[1].toFixed(2)} · ${gap.areaMm2.toFixed(1)} mm²</span>
          <button class="btn" type="button" data-action="regrow" data-gap="${i}"${locked}>Regrow</button>
        </li>`).join("");
        body += `<h3 class="se-sub">Unheld</h3><ul class="se-gaps">${items}</ul>`;
      }
      if (!v.treeSupports) body += `<p class="se-note">Tree supports are off. These edits apply again when they are back on.</p>`;
    }
    const html = `<div class="se-head">${head}${tools}</div>${body}`;
    if (html !== panelHtml) {
      panelHtml = html;
      panel.innerHTML = html;
    }
  }

  function hotGap() {
    const t = hover?.kind === "gap" ? hover : selected?.kind === "gap" ? selected : null;
    return t ? gaps.indexOf(t.gap) : null;
  }

  function paintOverlay(v: SupportEditView) {
    pane.dataset.gaps = String(editing ? gaps.length : 0);
    if (!editing) {
      view3d.setSupportOverlay(null);
      return;
    }
    const sel = capsulesFor(selected);
    const hov = same(hover, selected) ? null : capsulesFor(hover);
    view3d.setSupportOverlay({ hover: hov, selected: sel, gaps, hotGap: hotGap(), zLow: v.visible.zLow, zHigh: v.visible.zHigh });
  }

  function paintToggle() {
    const ok = ready();
    if (toggle) {
      toggle.classList.toggle("is-disabled", !ok);
      toggle.setAttribute("aria-disabled", ok ? "false" : "true");
      toggle.setAttribute("aria-pressed", editing ? "true" : "false");
    }
    const showCompact = isMobileLayout() && (ok || editing);
    compactBtn.hidden = !showCompact;
    compactBtn.classList.toggle("is-on", editing);
    compactBtn.setAttribute("aria-pressed", editing ? "true" : "false");
    compactBtn.setAttribute("aria-disabled", ok ? "false" : "true");
  }

  function compactSelection(): CompactSelection | null {
    if (!selected || !index) return null;
    if (selected.kind === "gap") return { kind: "gap", areaMm2: selected.gap.areaMm2, z: selected.gap.z };
    const sites = sitesOf(index, limbsOf(selected));
    return { kind: "limb", scope: selected.scope, tips: sites.length, z: sites[0]?.z ?? null };
  }

  function placePanel() {
    const host = document.querySelector("#compactSupports");
    if (isMobileLayout() && host) {
      if (panel.parentElement !== host) host.append(panel);
      return;
    }
    if (panel.parentElement !== pane) pane.append(panel);
  }

  function paintCompact(v: SupportEditView) {
    placePanel();
    const on = isMobileLayout() && editing;
    if (on !== compactAnnounced) {
      compactAnnounced = on;
      document.documentElement.dataset.supportEdit = on ? "1" : "";
      if (!on) delete document.documentElement.dataset.supportEdit;
      window.dispatchEvent(new CustomEvent("lime-support-edit", { detail: on }));
    }
    const selection = on ? compactSelection() : null;
    const action = chipAction(selection);
    compactChip.hidden = !action;
    if (action && selection) {
      compactChip.dataset.action = action;
      chipLabel.textContent = selectionLabel(selection);
      chipButton.textContent = action === "prune" ? "Prune" : "Regrow";
      chipButton.disabled = v.busy || !v.treeSupports;
    }
    const peek = document.querySelector<HTMLElement>("#compactSupportPeek");
    if (peek) {
      const text = peekLine({
        treeSupports: v.treeSupports,
        gaps,
        selected: selection ? selectionLabel(selection) : null,
      });
      peek.textContent = text;
      peek.dataset.warn = !selection && gaps.length > 0 ? "1" : "0";
    }
  }

  function refresh() {
    const v = hooks.view();
    sync(v);
    if (editing && !ready()) switchMode(false);
    paintToggle();
    paintBar(v);
    paintPanel(v);
    paintCompact(v);
    paintOverlay(v);
  }

  function setEditing(on: boolean) {
    if (on && !ready()) {
      pushToast("Slice with Organic tree supports to edit them.", "info");
      return;
    }
    if (on === editing) return;
    switchMode(on);
    if (on) {
      hooks.reveal();
      if (isMobileLayout()) {
        document.documentElement.classList.remove("chrome-hidden");
        document.querySelector<HTMLButtonElement>('#compactTabs [data-tab="preview"]')?.click();
      }
    }
    refresh();
  }

  function switchMode(on: boolean) {
    editing = on;
    hover = null;
    selected = null;
    lastMove = null;
    view3d.setPicking(on);
  }

  function commit(next: EditEntry[], why: Why) {
    if (hooks.view().busy) return;
    announce = why;
    hooks.apply(next);
  }

  function deleteSelected() {
    const v = hooks.view();
    if (selected?.kind !== "limb" || !index || v.busy || !v.treeSupports) return;
    const sites = sitesOf(index, limbsOf(selected));
    if (!sites.length) return;
    commit(appendEdit(v.edits, { id: nextId++, edit: { kind: "prune", sites }, scope: selected.scope }), "append");
  }

  function regrow(gap: CoverageGap) {
    const v = hooks.view();
    if (v.busy || !v.treeSupports) return;
    commit(appendEdit(v.edits, { id: nextId++, edit: regrowFor(gap), areaMm2: gap.areaMm2 }), "append");
  }

  function landed(ok: boolean) {
    const why = announce;
    announce = null;
    if (!ok || !why) return;
    const v = hooks.view();
    if (why === "clear") {
      pushToast("All support edits cleared.", "success");
      return;
    }
    if (why === "remove") {
      pushToast(v.treeSupports ? "Edit removed. Supports replayed." : "Edit removed.", "success");
      return;
    }
    const newest = v.edits[v.edits.length - 1];
    const outcome = newest ? alignOutcomes(v.edits, v.sent, v.result?.supportEdits ?? [])[v.edits.length - 1] : undefined;
    if (!newest || !outcome) return;
    const warn = outcome.status === "stale" || outcome.newlyFloatingMm2 > 0.05;
    pushToast(outcomeText(newest, outcome), warn ? "warn" : "success");
  }

  view3d.onPick((ev) => {
    if (!editing) return;
    if (ev.kind === "leave") {
      lastMove = null;
      if (hover) {
        hover = null;
        refresh();
      }
      return;
    }
    const target = pickAt(ev);
    if (ev.kind === "move") {
      lastMove = ev;
      if (same(target, hover)) return;
      hover = target;
    } else {
      selected = target;
      hover = target;
    }
    refresh();
  });

  toggle?.addEventListener("click", () => setEditing(!editing));
  compactBtn.addEventListener("click", () => {
    haptic("tap");
    setEditing(!editing);
  });
  chipButton.addEventListener("click", () => {
    haptic("tap");
    if (selected?.kind === "limb") deleteSelected();
    else if (selected?.kind === "gap") regrow(selected.gap);
  });
  window.addEventListener("lime-support-edit-toggle", () => setEditing(!editing));
  window.addEventListener("lime-support-edit-close", () => {
    if (editing) setEditing(false);
  });
  window.addEventListener("lime-support-hold", () => {
    if (!editing) return;
    nextScope = scopeForGesture("longpress");
  });
  window.addEventListener("lime-compact-ready", () => {
    placePanel();
    refresh();
  });

  bar.addEventListener("click", (ev) => {
    const button = (ev.target as Element).closest<HTMLButtonElement>("button");
    if (!button || button.disabled) return;
    const pick = button.dataset.scope as PickScope | undefined;
    if (pick) {
      scope = pick;
      if (selected?.kind === "limb") selected = { ...selected, scope: pick };
      refresh();
      return;
    }
    const action = button.dataset.action;
    if (action === "done") setEditing(false);
    if (action === "delete") deleteSelected();
    if (action === "regrow-selected" && selected?.kind === "gap") regrow(selected.gap);
  });

  panel.addEventListener("click", (ev) => {
    const button = (ev.target as Element).closest<HTMLButtonElement>("button");
    if (!button || button.disabled) return;
    const v = hooks.view();
    const action = button.dataset.action;
    if (action === "expand") {
      expanded = !expanded;
      refresh();
    }
    if (action === "undo" && v.edits.length) commit(undoLast(v.edits), "remove");
    if (action === "clear" && v.edits.length) commit(clearEdits(), "clear");
    if (action === "remove") commit(removeEdit(v.edits, Number(button.dataset.id)), "remove");
    if (action === "regrow") {
      const gap = gaps[Number(button.dataset.gap)];
      if (gap) regrow(gap);
    }
  });

  panel.addEventListener("pointerover", (ev) => {
    const row = (ev.target as Element).closest<HTMLElement>("[data-gap]");
    const gap = row ? gaps[Number(row.dataset.gap)] : undefined;
    const next: Target = gap ? { kind: "gap", gap } : null;
    if (!editing || same(next, hover)) return;
    hover = next;
    refresh();
  });

  // Capture, so Escape that closes the shortcut sheet in main.ts is seen while the sheet is still open.
  window.addEventListener("keydown", (ev) => {
    if (document.documentElement.dataset.overlay) return;
    const target = ev.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target?.isContentEditable) return;
    if (!document.querySelector("#help")?.hasAttribute("hidden")) return;
    if (ev.key === "Shift" && !ev.repeat && editing && lastMove) {
      hover = pickAt({ ...lastMove, shiftKey: true });
      refresh();
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key.toLowerCase() === "e" && !ev.repeat && !ev.shiftKey) {
      setEditing(!editing);
      ev.preventDefault();
      return;
    }
    if (!editing) return;
    if (ev.key === "Escape") {
      setEditing(false);
      ev.preventDefault();
    } else if (ev.key === "Delete" || ev.key === "Backspace") {
      deleteSelected();
      ev.preventDefault();
    }
  }, { capture: true });
  window.addEventListener("keyup", (ev) => {
    if (ev.key !== "Shift" || !editing || !lastMove) return;
    hover = pickAt({ ...lastMove, shiftKey: false });
    refresh();
  });
  window.addEventListener("lime-layout", () => {
    placePanel();
    refresh();
  });

  return {
    refresh,
    /** After a slice finishes; `ok` when a result landed. */
    landed,
    /** A new mesh: no limb or edit carries over. */
    reset() {
      setEditing(false);
      expanded = false;
      refresh();
    },
  };
}
