/**
 * The seam brush in Prepare: a rail tool and a bar with the radius and Clear.
 * It paints on the prepare mesh, so it works before the first slice.
 */
import { createElement, Spline } from "lucide";
import type { BrushHooks, PrepareView } from "../prepare-view";
import { BRUSH_R_DEFAULT_MM, BRUSH_R_MAX_MM, BRUSH_R_MIN_MM } from "../support-paint";
import type { SeamDisk } from "../seam-paint";
import { haptic } from "./haptics";
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
    <label class="pb-radius">Radius
      <input id="seamRadius" type="range" min="${BRUSH_R_MIN_MM}" max="${BRUSH_R_MAX_MM}" step="0.5" value="${BRUSH_R_DEFAULT_MM}" aria-label="Seam brush radius" />
      <output id="seamRadiusOut" for="seamRadius"></output>
    </label>
    <button type="button" class="btn" id="seamClear">Clear</button>
    <button type="button" class="btn" id="seamDone">Done</button>
    <span class="pb-status" id="seamStatus" role="status"></span>`;
  document.querySelector("#prepareBody")?.append(bar);

  const radiusInput = bar.querySelector<HTMLInputElement>("#seamRadius")!;
  const radiusOut = bar.querySelector<HTMLOutputElement>("#seamRadiusOut")!;
  const status = bar.querySelector<HTMLElement>("#seamStatus")!;
  const clear = bar.querySelector<HTMLButtonElement>("#seamClear")!;
  let on = false;
  const radius = () => Number(radiusInput.value);

  function sync() {
    const view = hooks.view();
    tool.setAttribute("aria-pressed", on ? "true" : "false");
    tool.classList.toggle("is-disabled", !view.hasMesh);
    bar.hidden = !on;
    document.documentElement.dataset.seamPaint = on ? "1" : "";
    radiusOut.textContent = `${radius().toFixed(1)} mm`;
    clear.disabled = view.disks.length === 0;
    status.textContent = view.disks.length > 0 ? `${view.disks.length} seam disk${view.disks.length === 1 ? "" : "s"}.` : "";
    prepare.setBrush(on ? { kind: "seam", radius: radius() } : null);
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
    if (next && !hooks.view().hasMesh) return;
    if (next) hooks.yieldBrush?.();
    on = next;
    if (on) {
      hooks.reveal();
      bind();
    } else hooks.restoreBrush?.();
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
