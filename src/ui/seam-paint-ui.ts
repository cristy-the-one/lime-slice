/**
 * The seam brush in Prepare: a rail tool and a bar with the radius and Clear.
 * It paints on the prepare mesh, so it works before the first slice.
 */
import { createElement, Spline } from "lucide";
import type { BrushHooks, PrepareView } from "../prepare-view";
import { BRUSH_R_DEFAULT_MM, BRUSH_R_MAX_MM, BRUSH_R_MIN_MM } from "../support-paint";
import type { SeamDisk } from "../seam-paint";
import { haptic } from "./haptics";
import { pushToast } from "./toasts";
import "./support-paint.css";

export interface SeamPaintHooks {
  view(): { disks: readonly SeamDisk[]; hasMesh: boolean };
  stroke(radius: number): BrushHooks;
  clear(): void;
  reveal(): void;
  /** Turn the support brush off before this one turns on. */
  yieldBrush?(): void;
  /** Give the stroke hooks back to the support brush. */
  restoreBrush?(): void;
}

export function mountSeamPaint(prepare: PrepareView, hooks: SeamPaintHooks) {
  const rail = document.querySelector<HTMLElement>("#toolRail");
  const tool = document.createElement("button");
  tool.type = "button";
  tool.className = "tool";
  tool.dataset.tool = "seam";
  tool.dataset.tip = "Paint where the seam should sit. The picker stays until a disk covers a wall.";
  tool.setAttribute("aria-label", "Paint seam");
  tool.setAttribute("aria-pressed", "false");
  tool.append(createElement(Spline, { width: 16, height: 16, "aria-hidden": "true", class: "ico" }));
  rail?.querySelector('[data-tool="paint"]')?.before(tool);

  const bar = document.createElement("div");
  bar.className = "paint-bar";
  bar.id = "seamBar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Paint seam");
  bar.hidden = true;
  bar.innerHTML = `
    <label class="pb-radius">
      <span class="scrub-label" data-scrub="field">Radius</span>
      <input id="seamRadius" data-brush-radius type="number" min="${BRUSH_R_MIN_MM}" max="${BRUSH_R_MAX_MM}" step="0.5" value="${BRUSH_R_DEFAULT_MM}" aria-label="Seam brush radius" />
    </label>
    <button type="button" class="btn" id="seamClear">Clear</button>
    <button type="button" class="btn" id="seamDone">Done</button>
    <span class="pb-status" id="seamStatus" role="status"></span>`;
  document.querySelector("#prepareBody")?.append(bar);

  const radiusInput = bar.querySelector<HTMLInputElement>("#seamRadius")!;
  const status = bar.querySelector<HTMLElement>("#seamStatus")!;
  const clear = bar.querySelector<HTMLButtonElement>("#seamClear")!;
  let on = false;
  const radius = () => {
    const n = Number(radiusInput.value);
    if (!Number.isFinite(n)) return BRUSH_R_DEFAULT_MM;
    return Math.min(BRUSH_R_MAX_MM, Math.max(BRUSH_R_MIN_MM, n));
  };

  function sync() {
    const view = hooks.view();
    tool.setAttribute("aria-pressed", on ? "true" : "false");
    tool.dataset.tipIdle ??= tool.dataset.tip ?? "";
    const blocked = !view.hasMesh;
    tool.classList.toggle("is-disabled", blocked);
    tool.setAttribute("aria-disabled", blocked ? "true" : "false");
    tool.dataset.tip = blocked ? "Load a mesh to paint the seam." : tool.dataset.tipIdle;
    if (blocked) tool.title = "Load a mesh to paint the seam.";
    else tool.removeAttribute("title");
    bar.hidden = !on;
    document.documentElement.dataset.seamPaint = on ? "1" : "";
    clear.disabled = view.disks.length === 0;
    status.textContent = view.disks.length > 0 ? `${view.disks.length} seam disk${view.disks.length === 1 ? "" : "s"}.` : "";
    if (on) prepare.setBrush({ kind: "seam", radius: radius() });
  }

  function bind() {
    prepare.onBrush({
      start: () => {
        current = hooks.stroke(radius());
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
      pushToast("Load a mesh to paint the seam.", "info");
      return;
    }
    if (next) hooks.yieldBrush?.();
    on = next;
    if (on) {
      hooks.reveal();
      bind();
    } else {
      prepare.setBrush(null);
      hooks.restoreBrush?.();
    }
    sync();
  }

  let current: BrushHooks | null = null;

  tool.addEventListener("click", () => setOn(!on));
  radiusInput.addEventListener("input", sync);
  clear.addEventListener("click", () => {
    hooks.clear();
    sync();
  });
  bar.querySelector("#seamDone")?.addEventListener("click", () => setOn(false));

  window.addEventListener("keydown", (ev) => {
    if (document.documentElement.dataset.overlay) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
    const target = ev.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target?.isContentEditable) return;
    if (!document.querySelector("#help")?.hasAttribute("hidden")) return;
    if (on && ev.key === "Escape") {
      setOn(false);
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
