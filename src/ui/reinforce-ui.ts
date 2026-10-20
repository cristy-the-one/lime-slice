/**
 * The Reinforce tool in Prepare: a rail tool and a bar with the `Brush` / `Along edge` mode, brush radius or strip
 * offset and width, depth, fill-through, `New region`, `Box`, `Cylinder`, volume gizmo mode (`Move` / `Scale`),
 * and the per-region density list (`docs/reinforcement.md`).
 */
import { createElement, Shield } from "lucide";
import type { BrushHooks, PrepareView } from "../prepare-view";
import type { Vec3 } from "../support-paint";
import {
  BRUSH_R_DEFAULT_MM,
  BRUSH_R_MAX_MM,
  BRUSH_R_MIN_MM,
  REINFORCE_DENSITY_STEP,
  REINFORCE_DEPTH_DEFAULT_MM,
  REINFORCE_DEPTH_MAX_MM,
  totalReinforceDisks,
  type ReinforceRegion,
} from "../reinforcement";
import { haptic } from "./haptics";
import { pushToast } from "./toasts";
import "./support-paint.css";

const STRIP_OFFSET_MAX_MM = 50;

export interface ReinforcePaintHooks {
  view(): {
    regions: readonly ReinforceRegion[];
    activeIndex: number;
    volumeTool: "move" | "scale";
    normalDensity: number;
    hasMesh: boolean;
  };
  stroke(radius: number, defaults: { depthMm: number; fillThrough: boolean }): BrushHooks;
  strip(hits: { point: Vec3; normal: Vec3 }[], radius: number, defaults: { depthMm: number; fillThrough: boolean }): void;
  selectRegion(index: number): void;
  newRegion(): void;
  addVolume(kind: "box" | "cylinder"): void;
  setVolumeTool(tool: "move" | "scale"): void;
  setDepth(depthMm: number, commit: boolean): void;
  setFillThrough(fillThrough: boolean): void;
  setDensity(index: number, density: number, commit: boolean): void;
  deleteRegion(index: number): void;
  clear(): void;
  onDone(): void;
  reveal(): void;
  yieldBrush?(): void;
  restoreBrush?(): void;
}

export function mountReinforcePaint(prepare: PrepareView, hooks: ReinforcePaintHooks) {
  const rail = document.querySelector<HTMLElement>("#toolRail");
  const tool = document.createElement("button");
  tool.type = "button";
  tool.className = "tool";
  tool.dataset.tool = "reinforce";
  tool.dataset.tip = "Paint or adjust regions that print denser infill up to 100% solid.";
  tool.setAttribute("aria-label", "Reinforce");
  tool.setAttribute("aria-pressed", "false");
  tool.append(createElement(Shield, { width: 16, height: 16, "aria-hidden": "true", class: "ico" }));
  rail?.querySelector('[data-tool="paint"]')?.before(tool);

  const bar = document.createElement("div");
  bar.className = "paint-bar reinforce-bar";
  bar.id = "reinforceBar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Reinforce");
  bar.hidden = true;
  bar.innerHTML = `
    <div class="pb-kind" id="reinforceMode" role="group" aria-label="Reinforce mode">
      <button type="button" data-reinforce-mode="brush" aria-pressed="true">Brush</button>
      <button type="button" data-reinforce-mode="edge" aria-pressed="false">Along edge</button>
    </div>
    <label class="pb-radius" id="reinforceRadiusField">
      <span class="scrub-label" data-scrub="field">Radius</span>
      <input id="reinforceRadius" data-brush-radius type="number" min="${BRUSH_R_MIN_MM}" max="${BRUSH_R_MAX_MM}" step="0.5" value="${BRUSH_R_DEFAULT_MM}" aria-label="Reinforce brush radius" />
    </label>
    <label class="pb-radius" id="reinforceOffsetField" hidden>
      <span class="scrub-label" data-scrub="field">Offset</span>
      <input id="reinforceOffset" type="number" min="0" max="${STRIP_OFFSET_MAX_MM}" step="0.5" value="0" aria-label="Strip distance from the edge, mm" />
    </label>
    <label class="pb-radius" id="reinforceWidthField" hidden>
      <span class="scrub-label" data-scrub="field">Width</span>
      <input id="reinforceWidth" type="number" min="${2 * BRUSH_R_MIN_MM}" max="${2 * BRUSH_R_MAX_MM}" step="0.5" value="${2 * BRUSH_R_DEFAULT_MM}" aria-label="Strip width, mm" />
    </label>
    <label class="pb-radius" id="reinforceDepthField">Depth
      <input id="reinforceDepth" type="range" min="0.5" max="${REINFORCE_DEPTH_MAX_MM}" step="0.5" value="${REINFORCE_DEPTH_DEFAULT_MM}" aria-label="Reinforce depth" />
      <output id="reinforceDepthOut" for="reinforceDepth"></output>
    </label>
    <label class="pb-check" id="reinforceFillThroughField">
      <input id="reinforceFillThrough" type="checkbox" aria-label="Fill through" />
      Fill through
    </label>
    <button type="button" class="btn" id="reinforceNewRegion">New region</button>
    <button type="button" class="btn" id="reinforceAddBox">Box</button>
    <button type="button" class="btn" id="reinforceAddCylinder">Cylinder</button>
    <div class="pb-kind" id="reinforceVolGizmo" role="group" aria-label="Volume gizmo" hidden>
      <button type="button" id="reinforceToolMove" aria-pressed="true">Move</button>
      <button type="button" id="reinforceToolScale" aria-pressed="false">Scale</button>
    </div>
    <button type="button" class="btn" id="reinforceClear">Clear</button>
    <button type="button" class="btn" id="reinforceDone">Done</button>
    <div class="pb-regions" id="reinforceRegions" role="list" aria-label="Reinforcement regions"></div>
    <span class="pb-status" id="reinforceStatus" role="status"></span>`;
  document.querySelector("#prepareBody")?.append(bar);

  const modeGroup = bar.querySelector<HTMLElement>("#reinforceMode")!;
  const radiusField = bar.querySelector<HTMLElement>("#reinforceRadiusField")!;
  const radiusInput = bar.querySelector<HTMLInputElement>("#reinforceRadius")!;
  const offsetField = bar.querySelector<HTMLElement>("#reinforceOffsetField")!;
  const offsetInput = bar.querySelector<HTMLInputElement>("#reinforceOffset")!;
  const widthField = bar.querySelector<HTMLElement>("#reinforceWidthField")!;
  const widthInput = bar.querySelector<HTMLInputElement>("#reinforceWidth")!;
  const depthField = bar.querySelector<HTMLElement>("#reinforceDepthField")!;
  const depthInput = bar.querySelector<HTMLInputElement>("#reinforceDepth")!;
  const depthOut = bar.querySelector<HTMLOutputElement>("#reinforceDepthOut")!;
  const fillThroughInput = bar.querySelector<HTMLInputElement>("#reinforceFillThrough")!;
  const newRegionBtn = bar.querySelector<HTMLButtonElement>("#reinforceNewRegion")!;
  const addBoxBtn = bar.querySelector<HTMLButtonElement>("#reinforceAddBox")!;
  const addCylinderBtn = bar.querySelector<HTMLButtonElement>("#reinforceAddCylinder")!;
  const volGizmo = bar.querySelector<HTMLElement>("#reinforceVolGizmo")!;
  const moveToolBtn = bar.querySelector<HTMLButtonElement>("#reinforceToolMove")!;
  const scaleToolBtn = bar.querySelector<HTMLButtonElement>("#reinforceToolScale")!;
  const clearBtn = bar.querySelector<HTMLButtonElement>("#reinforceClear")!;
  const regionsList = bar.querySelector<HTMLElement>("#reinforceRegions")!;
  const status = bar.querySelector<HTMLElement>("#reinforceStatus")!;

  let on = false;
  let pendingDepthMm = REINFORCE_DEPTH_DEFAULT_MM;
  let pendingFillThrough = false;
  let mode: "brush" | "edge" = "brush";
  /** Width takes 2 x Radius on the first switch to Along edge and keeps the user's value after that. */
  let widthSeeded = false;
  let edgesReady = false;

  const radius = () => {
    const n = Number(radiusInput.value);
    if (!Number.isFinite(n)) return BRUSH_R_DEFAULT_MM;
    return Math.min(BRUSH_R_MAX_MM, Math.max(BRUSH_R_MIN_MM, n));
  };
  const stripRadius = () => {
    const n = Number(widthInput.value) / 2;
    if (!Number.isFinite(n)) return radius();
    return Math.min(BRUSH_R_MAX_MM, Math.max(BRUSH_R_MIN_MM, n));
  };
  const stripOffset = () => {
    const n = Number(offsetInput.value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(STRIP_OFFSET_MAX_MM, Math.max(0, n));
  };
  const defaults = () => ({ depthMm: pendingDepthMm, fillThrough: pendingFillThrough });

  function activePaintRegion(regions: readonly ReinforceRegion[], activeIndex: number) {
    const r = regions[activeIndex];
    return r && r.kind === "paint" ? r : null;
  }

  function activeVolumeRegion(regions: readonly ReinforceRegion[], activeIndex: number) {
    const r = regions[activeIndex];
    return r && (r.kind === "box" || r.kind === "cylinder") ? r : null;
  }

  function regionLabel(reg: ReinforceRegion, index: number): string {
    if (reg.kind === "paint") {
      const detail = reg.fillThrough ? "through" : `${Number(reg.depthMm.toFixed(1))} mm`;
      return `Paint ${index + 1} (${detail})`;
    }
    const kind = reg.kind === "box" ? "Box" : "Cylinder";
    return `${kind} ${index + 1}`;
  }

  function densityReadout(density: number, normalDensity: number): string {
    if (density <= normalDensity + 1e-6) return "Normal";
    return `${Math.round(density * 100)}%`;
  }

  function syncRegionsList(
    regions: readonly ReinforceRegion[],
    activeIndex: number,
    normalDensity: number,
  ) {
    regionsList.hidden = regions.length === 0;
    const minDensity = Math.min(
      1,
      Math.max(0, Math.round(Math.floor((normalDensity + 1e-9) / REINFORCE_DENSITY_STEP) * REINFORCE_DENSITY_STEP * 100) / 100),
    );

    while (regionsList.children.length > regions.length) {
      regionsList.lastElementChild?.remove();
    }
    while (regionsList.children.length < regions.length) {
      const row = document.createElement("div");
      row.className = "pb-region-row";
      row.setAttribute("role", "listitem");
      row.innerHTML = `
        <button type="button" class="pb-region-select"></button>
        <span class="pb-region-end">Normal</span>
        <input type="range" class="pb-region-density" max="1" step="${REINFORCE_DENSITY_STEP}" aria-label="Region density" />
        <output class="pb-region-out"></output>
        <button type="button" class="btn pb-region-del" aria-label="Delete region">Delete</button>`;
      regionsList.append(row);
    }

    regions.forEach((reg, idx) => {
      const row = regionsList.children[idx] as HTMLElement;
      const isSelected = idx === activeIndex;
      row.dataset.regionIndex = String(idx);
      row.dataset.regionKind = reg.kind;
      row.dataset.active = isSelected ? "1" : "0";
      const selectBtn = row.querySelector<HTMLButtonElement>(".pb-region-select")!;
      selectBtn.textContent = regionLabel(reg, idx);
      selectBtn.setAttribute("aria-pressed", isSelected ? "true" : "false");

      const slider = row.querySelector<HTMLInputElement>(".pb-region-density")!;
      slider.min = String(minDensity);
      const effectiveVal = Math.max(minDensity, reg.density);
      if (document.activeElement !== slider) {
        slider.value = String(effectiveVal);
      }

      const out = row.querySelector<HTMLOutputElement>(".pb-region-out")!;
      out.textContent = densityReadout(reg.density, normalDensity);
    });
  }

  function sync() {
    const view = hooks.view();
    tool.setAttribute("aria-pressed", on ? "true" : "false");
    tool.dataset.tipIdle ??= tool.dataset.tip ?? "";
    const blocked = !view.hasMesh;
    tool.classList.toggle("is-disabled", blocked);
    tool.setAttribute("aria-disabled", blocked ? "true" : "false");
    tool.dataset.tip = blocked ? "Load a mesh to reinforce." : tool.dataset.tipIdle;
    if (blocked) tool.title = "Load a mesh to reinforce.";
    else tool.removeAttribute("title");
    bar.hidden = !on;
    document.documentElement.dataset.reinforcePaint = on ? "1" : "";
    const paintReg = activePaintRegion(view.regions, view.activeIndex);
    const volReg = activeVolumeRegion(view.regions, view.activeIndex);
    const depthMm = paintReg ? paintReg.depthMm : pendingDepthMm;
    const fillThrough = paintReg ? Boolean(paintReg.fillThrough) : pendingFillThrough;

    if (document.activeElement !== depthInput) {
      depthInput.value = String(depthMm);
    }
    depthOut.textContent = `${Number(depthInput.value).toFixed(1)} mm`;
    fillThroughInput.checked = fillThrough;
    depthField.hidden = fillThrough;

    volGizmo.hidden = !volReg;
    moveToolBtn.setAttribute("aria-pressed", view.volumeTool === "move" ? "true" : "false");
    scaleToolBtn.setAttribute("aria-pressed", view.volumeTool === "scale" ? "true" : "false");

    clearBtn.disabled = view.regions.length === 0;
    syncRegionsList(view.regions, view.activeIndex, view.normalDensity);

    const edge = mode === "edge";
    for (const btn of modeGroup.querySelectorAll<HTMLButtonElement>("button")) {
      btn.setAttribute("aria-pressed", btn.dataset.reinforceMode === mode ? "true" : "false");
    }
    radiusField.hidden = edge;
    offsetField.hidden = !edge;
    widthField.hidden = !edge;
    radiusInput.toggleAttribute("data-brush-radius", !edge);
    widthInput.toggleAttribute("data-brush-radius", edge);
    syncStatus(view.regions);

    if (on) {
      prepare.setBrush(edge ? { kind: "reinforce", radius: stripRadius(), edge: { offset: stripOffset() } } : { kind: "reinforce", radius: radius() });
    }
  }

  function syncStatus(regions: readonly ReinforceRegion[]) {
    const diskCount = totalReinforceDisks(regions);
    if (mode === "edge" && !edgesReady) {
      status.textContent = "Finding edges…";
    } else if (regions.length === 0) {
      status.textContent = "";
    } else {
      status.textContent = `${regions.length} region${regions.length === 1 ? "" : "s"}, ${diskCount} disk${diskCount === 1 ? "" : "s"}.`;
    }
  }

  function bind() {
    prepare.onReinforceStrip({
      ready: (ready) => {
        edgesReady = ready;
        syncStatus(hooks.view().regions);
      },
      commit: (hits, r) => {
        hooks.strip(hits, r, defaults());
        haptic("tap");
      },
    });
    prepare.onBrush({
      start: () => {
        current = hooks.stroke(radius(), defaults());
        current.start();
        haptic("tap");
      },
      hit: (point, normal) => current?.hit(point, normal),
      end: () => {
        current?.end();
        current = null;
        sync();
      },
      cancel: () => {
        current?.cancel();
        current = null;
        sync();
      },
    });
  }

  function setOn(next: boolean) {
    if (next && !hooks.view().hasMesh) {
      pushToast("Load a mesh to reinforce.", "info");
      return;
    }
    if (next) hooks.yieldBrush?.();
    on = next;
    if (on) {
      hooks.reveal();
      bind();
    } else {
      prepare.setBrush(null);
      hooks.onDone();
      hooks.restoreBrush?.();
    }
    sync();
  }

  let current: BrushHooks | null = null;

  tool.addEventListener("click", () => setOn(!on));
  radiusInput.addEventListener("input", sync);
  offsetInput.addEventListener("input", sync);
  widthInput.addEventListener("input", sync);
  modeGroup.addEventListener("click", (ev) => {
    const next = (ev.target as Element).closest<HTMLButtonElement>("button")?.dataset.reinforceMode;
    if (next !== "brush" && next !== "edge") return;
    if (next === "edge" && !widthSeeded) {
      widthInput.value = String(2 * radius());
      widthSeeded = true;
    }
    mode = next;
    sync();
  });

  depthInput.addEventListener("input", () => {
    const val = Number(depthInput.value);
    pendingDepthMm = val;
    const view = hooks.view();
    if (activePaintRegion(view.regions, view.activeIndex)) {
      hooks.setDepth(val, false);
    } else {
      sync();
    }
  });
  depthInput.addEventListener("change", () => {
    const val = Number(depthInput.value);
    pendingDepthMm = val;
    const view = hooks.view();
    if (activePaintRegion(view.regions, view.activeIndex)) {
      hooks.setDepth(val, true);
    } else {
      sync();
    }
  });

  fillThroughInput.addEventListener("change", () => {
    const checked = fillThroughInput.checked;
    pendingFillThrough = checked;
    const view = hooks.view();
    if (activePaintRegion(view.regions, view.activeIndex)) {
      hooks.setFillThrough(checked);
    } else {
      sync();
    }
  });

  newRegionBtn.addEventListener("click", () => {
    pendingDepthMm = REINFORCE_DEPTH_DEFAULT_MM;
    pendingFillThrough = false;
    hooks.newRegion();
    sync();
  });

  addBoxBtn.addEventListener("click", () => {
    hooks.addVolume("box");
    sync();
  });

  addCylinderBtn.addEventListener("click", () => {
    hooks.addVolume("cylinder");
    sync();
  });

  moveToolBtn.addEventListener("click", () => {
    hooks.setVolumeTool("move");
    sync();
  });

  scaleToolBtn.addEventListener("click", () => {
    hooks.setVolumeTool("scale");
    sync();
  });

  clearBtn.addEventListener("click", () => {
    hooks.clear();
    sync();
  });

  bar.querySelector("#reinforceDone")?.addEventListener("click", () => setOn(false));

  regionsList.addEventListener("click", (ev) => {
    const target = ev.target as Element;
    const row = target.closest<HTMLElement>(".pb-region-row");
    if (!row) return;
    const idx = Number(row.dataset.regionIndex);
    if (!Number.isInteger(idx)) return;
    if (target.closest(".pb-region-del")) {
      hooks.deleteRegion(idx);
      sync();
      return;
    }
    if (target.closest(".pb-region-select")) {
      hooks.selectRegion(idx);
      sync();
    }
  });

  regionsList.addEventListener("input", (ev) => {
    const target = ev.target as HTMLElement;
    if (!target.classList.contains("pb-region-density")) return;
    const row = target.closest<HTMLElement>(".pb-region-row");
    if (!row) return;
    const idx = Number(row.dataset.regionIndex);
    if (!Number.isInteger(idx)) return;
    hooks.selectRegion(idx);
    hooks.setDensity(idx, Number((target as HTMLInputElement).value), false);
    sync();
  });

  regionsList.addEventListener("change", (ev) => {
    const target = ev.target as HTMLElement;
    if (!target.classList.contains("pb-region-density")) return;
    const row = target.closest<HTMLElement>(".pb-region-row");
    if (!row) return;
    const idx = Number(row.dataset.regionIndex);
    if (!Number.isInteger(idx)) return;
    hooks.setDensity(idx, Number((target as HTMLInputElement).value), true);
    sync();
  });

  window.addEventListener("keydown", (ev) => {
    if (document.documentElement.dataset.overlay) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
    const target = ev.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target?.isContentEditable) return;
    if (!document.querySelector("#help")?.hasAttribute("hidden")) return;
    if (on && ev.key === "Escape") {
      if (!prepare.cancelStrip()) setOn(false);
      ev.preventDefault();
    }
  });

  sync();
  return {
    refresh: sync,
    stop() {
      if (on) setOn(false);
    },
  };
}
