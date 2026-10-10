/**
 * The support brush in Prepare: a rail tool and a bar with Enforce, Block, the radius, and Clear.
 * It paints on the prepare mesh, so it works before the first slice.
 */
import { createElement, Paintbrush } from "lucide";
import type { BrushHooks, PrepareView } from "../prepare-view";
import { BRUSH_R_DEFAULT_MM, BRUSH_R_MAX_MM, BRUSH_R_MIN_MM, paintCounts, tallyText, type PaintDisk, type PaintKind, type PaintTally } from "../support-paint";
import { haptic } from "./haptics";
import "./support-paint.css";

export interface SupportPaintHooks {
  /** The selected object's paint count, whether its supports print, and the shown result's tally. */
  view(): { disks: readonly PaintDisk[]; supportsOn: boolean; tally: PaintTally | null; hasMesh: boolean };
  /** One drag of the brush. */
  stroke(kind: PaintKind, radius: number): BrushHooks;
  clear(): void;
  /** Show the Prepare tab. */
  reveal(): void;
  /** Turn the other brush off before this one turns on. */
  yieldBrush?(): void;
}

const KIND_LABEL: Record<PaintKind, string> = { enforce: "Enforce", block: "Block" };

export function mountSupportPaint(prepare: PrepareView, hooks: SupportPaintHooks) {
  const rail = document.querySelector<HTMLElement>("#toolRail");
  const tool = document.createElement("button");
  tool.type = "button";
  tool.className = "tool";
  tool.dataset.tool = "paint";
  tool.dataset.tip = "Paint where supports must grow (Enforce) or must not (Block).";
  tool.setAttribute("aria-label", "Paint supports");
  tool.setAttribute("aria-pressed", "false");
  tool.append(createElement(Paintbrush, { width: 16, height: 16, "aria-hidden": "true", class: "ico" }));
  rail?.querySelector('[data-tool="supports"]')?.before(tool);

  const bar = document.createElement("div");
  bar.className = "paint-bar";
  bar.id = "paintBar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Paint supports");
  bar.hidden = true;
  bar.innerHTML = `
    <div class="pb-kind" role="group" aria-label="Brush">
      <button type="button" data-kind="enforce"><span class="pb-swatch" aria-hidden="true"></span>${KIND_LABEL.enforce}</button><button type="button" data-kind="block"><span class="pb-swatch" aria-hidden="true"></span>${KIND_LABEL.block}</button>
    </div>
    <label class="pb-radius">Radius
      <input id="brushRadius" type="range" min="${BRUSH_R_MIN_MM}" max="${BRUSH_R_MAX_MM}" step="0.5" value="${BRUSH_R_DEFAULT_MM}" aria-label="Brush radius" />
      <output id="brushRadiusOut" for="brushRadius"></output>
    </label>
    <button type="button" class="btn" id="paintClear">Clear</button>
    <button type="button" class="btn" id="paintDone">Done</button>
    <span class="pb-status" id="paintStatus" role="status"></span>`;
  document.querySelector("#prepareBody")?.append(bar);

  const radiusInput = bar.querySelector<HTMLInputElement>("#brushRadius")!;
  const radiusOut = bar.querySelector<HTMLOutputElement>("#brushRadiusOut")!;
  const status = bar.querySelector<HTMLElement>("#paintStatus")!;
  const clear = bar.querySelector<HTMLButtonElement>("#paintClear")!;
  let on = false;
  let kind: PaintKind = "block";

  const radius = () => Number(radiusInput.value);

  function sync() {
    const view = hooks.view();
    tool.setAttribute("aria-pressed", on ? "true" : "false");
    tool.classList.toggle("is-disabled", !view.hasMesh);
    bar.hidden = !on;
    document.documentElement.dataset.supportPaint = on ? "1" : "";
    for (const button of bar.querySelectorAll<HTMLButtonElement>("[data-kind]")) {
      button.setAttribute("aria-pressed", button.dataset.kind === kind ? "true" : "false");
    }
    radiusOut.textContent = `${radius().toFixed(1)} mm`;
    const counts = paintCounts(view.disks);
    clear.disabled = view.disks.length === 0;
    bar.dataset.enforce = String(counts.enforce);
    bar.dataset.block = String(counts.block);
    status.dataset.warn = "";
    const line = view.tally ? tallyText(view.tally) : null;
    if (!view.supportsOn) {
      status.textContent = "Supports are off.";
      status.dataset.warn = "1";
    } else if (line?.warn) {
      status.textContent = line.text;
      status.dataset.warn = "1";
    } else {
      status.textContent = view.disks.length > 0 ? `${counts.enforce} enforce, ${counts.block} block.` : "";
    }
    prepare.setBrush(on ? { kind, radius: radius() } : null);
  }

  function setOn(next: boolean) {
    if (next && !hooks.view().hasMesh) return;
    if (next) hooks.yieldBrush?.();
    on = next;
    if (on) hooks.reveal();
    sync();
    if (on) bind();
  }

  let current: BrushHooks | null = null;
  // A stroke's hooks are taken at its first dab, so a kind or radius change mid-drag waits for the next one.
  function bind() {
    prepare.onBrush({
      start: () => {
        current = hooks.stroke(kind, radius());
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
  bind();

  tool.addEventListener("click", () => setOn(!on));
  bar.addEventListener("click", (ev) => {
    const button = (ev.target as Element).closest<HTMLButtonElement>("[data-kind]");
    if (button?.dataset.kind === "enforce" || button?.dataset.kind === "block") {
      kind = button.dataset.kind;
      sync();
    }
  });
  radiusInput.addEventListener("input", sync);
  clear.addEventListener("click", () => {
    hooks.clear();
    sync();
  });
  bar.querySelector("#paintDone")?.addEventListener("click", () => setOn(false));

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
    /** Repaint the bar from the app: a new mesh, a landed slice, an undo. */
    refresh: sync,
    /** Leave the brush when the stage leaves Prepare. */
    stop() {
      if (on) setOn(false);
    },
    /** Put this brush's stroke hooks back after the seam brush releases them. */
    bind,
  };
}
