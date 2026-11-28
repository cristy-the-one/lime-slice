/**
 * The hover highlight shared by Model, Pose and Prepare. The object under the pointer that a click (Model and Prepare:
 * a Ctrl-click) would select is outlined, so the person sees what they are about to pick before they pick it.
 *
 * This module only watches the pointer: at most one pick a frame, none while a button is down (an orbit or a drag), and
 * the outline goes when the pointer leaves the canvas. Each view says what is under a point (`pick`) and how to draw it
 * (`draw`, `src/hover-outline.ts`). The canvas publishes the hovered object's id in `data-hover-object`, empty for none.
 */
import type { Camera, Matrix4, Scene, WebGLRenderer } from "three";
import type { HoverOutline } from "./hover-outline";

/** What the pointer is over: the object's id, its source triangles (a cache key and the outline's source) and where it stands. */
export interface HoverHit {
  id: string;
  positions: Float32Array;
  matrixWorld: Matrix4;
}

export interface HoverHost {
  canvas: HTMLCanvasElement;
  /** The object a click at this point would select, or null. Never the selected object, which is already marked. */
  pick(clientX: number, clientY: number): HoverHit | null;
  /** Draw this object's outline, or with null take it away. */
  draw(hit: HoverHit | null): void;
}

export interface Hover {
  /** The scene or the selection changed: look again where the pointer is, and draw again. */
  refresh(): void;
}

/**
 * What a view draws with. The line code loads on the first hover; a hover that ends before it arrived draws nothing.
 * `kick` asks the view for a frame.
 */
export function hoverDrawer(scene: Scene, canvas: HTMLCanvasElement, color: () => string, kick: () => void) {
  let outline: HoverOutline | null = null;
  let wanted: HoverHit | null = null;
  let loading = false;
  return {
    draw(hit: HoverHit | null) {
      wanted = hit;
      if (outline) {
        if (hit) outline.show(hit);
        else outline.hide();
        // For a test: the outline is on screen.
        canvas.dataset.hoverDrawn = String(!!hit);
        kick();
        return;
      }
      if (!hit || loading) return;
      loading = true;
      void import("./hover-outline").then((made) => {
        outline = made.createHoverOutline(scene, canvas, color());
        if (wanted) outline.show(wanted);
        canvas.dataset.hoverDrawn = String(!!wanted);
        kick();
      });
    },
    recolor() {
      outline?.setColor(color());
    },
    resize() {
      outline?.resize();
    },
    /** Lay the outline over the picture `renderer` has just drawn. */
    paint(renderer: WebGLRenderer, camera: Camera) {
      outline?.paint(renderer, camera);
    },
  };
}

export function mountHover(host: HoverHost): Hover {
  const { canvas } = host;
  canvas.dataset.hoverObject = "";
  let at: { x: number; y: number } | null = null;
  let pressed = false;
  let frame = 0;
  let forced = false;
  let shown: string | null = null;

  function run(force: boolean) {
    frame = 0;
    const hit = at && !pressed ? host.pick(at.x, at.y) : null;
    const id = hit?.id ?? null;
    if (id === shown && !(force && id)) return;
    shown = id;
    canvas.dataset.hoverObject = id ?? "";
    host.draw(hit);
  }

  function schedule(force = false) {
    if (force) forced = true;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      const again = forced;
      forced = false;
      run(again);
    });
  }

  // On the window, in the capture phase: a view's own press handlers stop the event before one on the canvas would hear it.
  const onCanvas = (ev: Event) => ev.target === canvas;
  window.addEventListener("pointermove", (ev) => {
    if (!onCanvas(ev)) return;
    at = { x: ev.clientX, y: ev.clientY };
    pressed = ev.buttons !== 0;
    schedule();
  }, true);
  window.addEventListener("pointerdown", (ev) => {
    if (!onCanvas(ev)) return;
    pressed = true;
    // Gone at once: a press starts a pick, an orbit or a drag, and none of them wants the outline in the way.
    if (shown) schedule();
  }, true);
  window.addEventListener("pointerup", (ev) => {
    if (!onCanvas(ev)) return;
    pressed = ev.buttons !== 0;
    schedule(true);
  }, true);
  window.addEventListener("pointercancel", () => {
    pressed = false;
  }, true);
  canvas.addEventListener("pointerleave", () => {
    at = null;
    pressed = false;
    if (frame) cancelAnimationFrame(frame);
    forced = false;
    run(false);
  });

  return { refresh: () => schedule(true) };
}
