/**
 * A Windows precision touchpad in the 3D viewports. Its two-finger scroll reaches the page as a pixel wheel event, and
 * its pinch as a wheel event with ctrlKey. OrbitControls zooms on both. Here a two-finger scroll orbits, as a left drag
 * does, with the view following the fingers; a pinch and a mouse wheel still zoom. `wheelKind`, the 2D layer view's
 * test, tells them apart.
 */
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { wheelKind } from "./ui/flat-view.ts";

/** OrbitControls' own turn, the one a drag uses, so damping and the polar limits apply. */
interface Turning {
  _rotateLeft(angle: number): void;
  _rotateUp(angle: number): void;
}

/** The orbit of one two-finger scroll, in radians: a drag of the fingers' travel across the canvas height. */
export function trackpadTurn(deltaX: number, deltaY: number, height: number, rotateSpeed: number): { left: number; up: number } {
  const k = (2 * Math.PI * rotateSpeed) / Math.max(1, height);
  return { left: -deltaX * k, up: -deltaY * k };
}

/** Mount after the canvas's other wheel listeners, so a handle nudge or the sketch zoom that took the event keeps it. */
export function mountTrackpadOrbit(canvas: HTMLElement, controls: OrbitControls): void {
  const turning = controls as unknown as Partial<Turning>;
  canvas.addEventListener("wheel", (ev) => {
    if (ev.defaultPrevented || !controls.enabled || !controls.enableRotate) return;
    if (wheelKind(ev.deltaX, ev.deltaY, ev.deltaMode, ev.ctrlKey, ev.metaKey) !== "pan") return;
    if (typeof turning._rotateLeft !== "function" || typeof turning._rotateUp !== "function") return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const turn = trackpadTurn(ev.deltaX, ev.deltaY, canvas.clientHeight, controls.rotateSpeed);
    controls.dispatchEvent({ type: "start" });
    turning._rotateLeft(turn.left);
    turning._rotateUp(turn.up);
    controls.update();
    controls.dispatchEvent({ type: "end" });
  }, { capture: true, passive: false });
}
