/** Pointer, wheel and focus listeners on the canvas. */
import * as THREE from "three";
import { EDGE_KNOB_ID } from "../interact/edge-drag";
import { PULL_HANDLE_ID } from "./constants";
import { grabIntent } from "../viewport-grab";
import { knobEvent } from "./helpers";
import { mountTrackpadOrbit } from "../trackpad-orbit";
import { viewHelperHit } from "../viewport-chrome";
import type { ViewCtx } from "./ctx";

export function installEvents(ctx: ViewCtx): void {
  const { camera, canvas, controls, tip, viewHelper } = ctx;

  /** Knob pressed, not yet moved. A still release selects the edge; movement starts the fillet. */
  let edgePress: { pointerId: number; x: number; y: number } | null = null;
  let sectionGesture: { pointerId: number; base: number; origin: THREE.Vector3; normal: THREE.Vector3 } | null = null;
  let stressGesture: { pointerId: number } | null = null;
  const FACE_SLOP = 4;
  let sketchRoll: { pointerId: number; x: number } | null = null;

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button === 2 && !ctx.drag && !ctx.edgeDrag && !edgePress && !ctx.grab && grabIntent(ev) === "rotate" && ctx.beginGrab(ev, "rotate")) return;
    if (ev.button !== 0 || ctx.drag || ctx.edgeDrag || edgePress) {
      // --- S2: right-drag rolls about the plane normal while the sketch view is locked. ---
      if (ctx.sketchLock && ev.button === 2 && !ctx.drag && !ctx.edgeDrag) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        sketchRoll = { pointerId: ev.pointerId, x: ev.clientX };
      }
      return;
    }
    ctx.down = null;
    if (viewHelperHit(viewHelper, canvas, ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      ctx.kick();
      return;
    }
    // --- S2: drawing owns the left button before a face push or an orbit. ---
    if (ctx.sketchCapture) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      ctx.sketchPointerId = ev.pointerId;
      ctx.sketchCb(ctx.sketchPointerEvent("down", ev));
      return;
    }
    const part = ctx.handleAt(ev.clientX, ev.clientY);
    // A Ctrl press on the open solid is a grab, ahead of a face push, an edge knob or an orbit. The section and stress arrows keep their presses.
    const idle = !part || part.handle.id === PULL_HANDLE_ID || part.handle.id === EDGE_KNOB_ID;
    if (idle && !ctx.grab && grabIntent(ev) === "move" && !ctx.stressArrowHit(ev.clientX, ev.clientY) && !ctx.sectionHit(ev.clientX, ev.clientY) && ctx.beginGrab(ev, "move")) return;
    // P2. The knob sits on the edge, in front of a face push. A click still selects that edge; the fillet starts once the pointer moves.
    if (part?.handle.id === EDGE_KNOB_ID) {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      edgePress = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY };
      ctx.down = { x: ev.clientX, y: ev.clientY };
      return;
    }
    // --- A10. The section arrow is its own control. A face push behind it, the default when no tool is open, leaves the shaft alone.
    if (ctx.stressArrowHit(ev.clientX, ev.clientY)) {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      stressGesture = { pointerId: ev.pointerId };
      const dir = ctx.stressDragDir(ev.clientX, ev.clientY);
      ctx.stressDirCb(dir ?? [0, 0, -1], "start", { x: ev.clientX, y: ev.clientY });
      return;
    }
    if (ctx.sectionHit(ev.clientX, ev.clientY) && ctx.sectionPlaneWorld) {
      const origin = ctx.sectionPlaneWorld.origin.clone();
      const normal = ctx.sectionPlaneWorld.normal.clone();
      const base = ctx.sectionTravel(origin, normal, ev.clientX, ev.clientY);
      if (base != null) {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        controls.enabled = false;
        canvas.setPointerCapture(ev.pointerId);
        sectionGesture = { pointerId: ev.pointerId, base, origin, normal };
        ctx.sectionDragCb(0, "start");
        return;
      }
    }
    // --- P1: a face press is a push, before a handle or an orbit can take it. Empty space still orbits. ---
    if (ctx.beginFace(ev, part?.handle.id === PULL_HANDLE_ID)) return;
    if (part) {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      ctx.beginDrag(part, ev);
      return;
    }
    ctx.down = { x: ev.clientX, y: ev.clientY };
  }, { capture: true });
  canvas.addEventListener("pointermove", (ev) => {
    // --- S2 ---
    if (sketchRoll && ev.pointerId === sketchRoll.pointerId) {
      ctx.rollSketch(ev.clientX - sketchRoll.x);
      sketchRoll = { pointerId: ev.pointerId, x: ev.clientX };
      return;
    }
    if (ctx.sketchPointerId != null && ev.pointerId === ctx.sketchPointerId) {
      ctx.sketchCb(ctx.sketchPointerEvent("move", ev));
      return;
    }
    if (ctx.sketchCapture && ev.buttons === 0) {
      ctx.sketchCb(ctx.sketchPointerEvent("move", ev));
      return;
    }
    if (edgePress && ev.pointerId === edgePress.pointerId) {
      const moved = (ev.clientX - edgePress.x) ** 2 + (ev.clientY - edgePress.y) ** 2;
      if (moved <= 16) return;
      ctx.down = null;
      ctx.edgeDrag = { pointerId: ev.pointerId };
      edgePress = null;
      ctx.edgeKnobCb(knobEvent(ev, "down"));
      ctx.edgeKnobCb(knobEvent(ev, "move"));
      ctx.paintHandles();
      return;
    }
    if (ctx.edgeDrag) {
      if (ev.pointerId === ctx.edgeDrag.pointerId) ctx.edgeKnobCb(knobEvent(ev, "move"));
      return;
    }
    if (ctx.drag) {
      if (ev.pointerId === ctx.drag.pointerId) ctx.moveDrag(ev);
      return;
    }
    if (stressGesture && ev.pointerId === stressGesture.pointerId) {
      const dir = ctx.stressDragDir(ev.clientX, ev.clientY);
      if (dir) ctx.stressDirCb(dir, "move", { x: ev.clientX, y: ev.clientY });
      return;
    }
    if (sectionGesture && ev.pointerId === sectionGesture.pointerId) {
      const at = ctx.sectionTravel(sectionGesture.origin, sectionGesture.normal, ev.clientX, ev.clientY);
      if (at != null) ctx.sectionDragCb(at - sectionGesture.base, "move");
      return;
    }
    // --- P1 ---
    if (ctx.faceDown && ev.pointerId === ctx.faceDown.pointerId) {
      if (Math.hypot(ev.clientX - ctx.faceDown.x, ev.clientY - ctx.faceDown.y) > FACE_SLOP) ctx.faceDown.moved = true;
      if (ctx.faceDown.moved) {
        const hit = ctx.faceHit(ev) ?? ctx.faceDown.hit;
        ctx.faceCb(ctx.faceEvent("move", ev, hit));
        ctx.paintHandles();
      }
      return;
    }
    if (ctx.down) return;
    const over = ctx.handleAt(ev.clientX, ev.clientY);
    if (ctx.edgeHoverOn) ctx.updateEdgeHover(ev, over);
    // --- P1: a face hover still runs while an edge can light, so both idle gestures share the view. ---
    if (ctx.faceDrag && ctx.mode === "face") {
      // The arrow stays seated while the pointer is on it, so its tip can be reached and grabbed.
      if (over?.handle.id === PULL_HANDLE_ID && ctx.seatHit) {
        ctx.setOverHandle(PULL_HANDLE_ID);
        tip.hidden = true;
        return;
      }
      const knob = over?.handle.id === EDGE_KNOB_ID;
      const hit = knob ? null : ctx.faceHit(ev);
      ctx.seatHit = hit;
      ctx.setOverHandle(knob ? EDGE_KNOB_ID : null);
      tip.hidden = true;
      ctx.setHover(hit ? { kind: "face", index: hit.face } : null);
      ctx.faceCb(ctx.faceEvent("hover", ev, hit));
      return;
    }
    const knob = over?.handle.id === EDGE_KNOB_ID;
    ctx.setOverHandle(over?.handle.id ?? null);
    if (over && !knob) {
      ctx.setHover(null);
      ctx.showTip(ev, over.handle, over.handle.values);
      return;
    }
    tip.hidden = true;
    if (knob) {
      ctx.setHover(null);
      return;
    }
    ctx.setHover(ctx.pickAt(ev));
  });
  const finishDrag = (ev: PointerEvent) => {
    if (stressGesture && ev.pointerId === stressGesture.pointerId) {
      const dir = ctx.stressDragDir(ev.clientX, ev.clientY);
      ctx.stressDirCb(dir ?? [0, 0, -1], "end", { x: ev.clientX, y: ev.clientY });
      stressGesture = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      return;
    }
    if (sectionGesture && ev.pointerId === sectionGesture.pointerId) {
      const at = ctx.sectionTravel(sectionGesture.origin, sectionGesture.normal, ev.clientX, ev.clientY);
      ctx.sectionDragCb((at ?? sectionGesture.base) - sectionGesture.base, "end");
      sectionGesture = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      return;
    }
    // --- S2 ---
    if (sketchRoll && ev.pointerId === sketchRoll.pointerId) {
      sketchRoll = null;
      return;
    }
    if (ctx.sketchPointerId != null && ev.pointerId === ctx.sketchPointerId) {
      ctx.sketchCb(ctx.sketchPointerEvent("up", ev));
      ctx.sketchPointerId = null;
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      if (!ctx.sketchAnim && !viewHelper.animating) controls.enabled = true;
      return;
    }
    // --- P1 ---
    if (ctx.faceDown && ev.pointerId === ctx.faceDown.pointerId) {
      ctx.finishFace(ev);
      return;
    }
    if (edgePress && ev.pointerId === edgePress.pointerId) {
      edgePress = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      // A still release keeps `down`, so the click handler selects the edge under the knob.
      if (ev.type === "pointercancel") ctx.down = null;
      return;
    }
    if (ctx.edgeDrag && ev.pointerId === ctx.edgeDrag.pointerId) {
      ctx.edgeDrag = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      ctx.edgeKnobCb(knobEvent(ev, ev.type === "pointercancel" ? "cancel" : "up"));
      ctx.paintHandles();
      return;
    }
    if (!ctx.drag || ev.pointerId !== ctx.drag.pointerId) return;
    const done = ctx.drag;
    ctx.drag = null;
    controls.enabled = true;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    tip.hidden = true;
    ctx.snappedTo = null;
    ctx.showSnapMark();
    const measured = done.handle.id.startsWith("measure");
    const landed = ctx.struck;
    ctx.snapRun = null;
    ctx.showSnap(null);
    ctx.handleCb({ handle: done.handle, values: done.values, phase: "end", ...(measured ? { snap: landed } : {}) });
    ctx.paintHandles();
  };
  canvas.addEventListener("pointerup", finishDrag, { capture: true });
  canvas.addEventListener("pointercancel", finishDrag, { capture: true });
  canvas.addEventListener("pointerleave", (ev) => {
    ctx.setHover(null);
    ctx.seatHit = null;
    if (ctx.faceDrag && !ctx.faceDown) ctx.faceCb(ctx.faceEvent("hover", ev, null));
    if (ctx.drag || ctx.edgeDrag || edgePress) return;
    if (ctx.edgeLit != null) {
      ctx.edgeLit = null;
      ctx.paintLines();
      ctx.edgeHoverCb(null, null);
    }
    ctx.setOverHandle(null);
    tip.hidden = true;
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!ctx.down || ev.button !== 0) return;
    const moved = (ev.clientX - ctx.down.x) ** 2 + (ev.clientY - ctx.down.y) ** 2;
    ctx.down = null;
    if (moved > 16) return;
    const object = ctx.objectPicking ? ctx.objectAt(ev) : null;
    if (object) {
      ctx.objectPickCb(object);
      return;
    }
    // Ctrl-click on a grey object opens it, as picking its row in the plate does.
    const other = ctx.grabHooks && grabIntent(ev) === "move" ? ctx.objectAt(ev) : null;
    if (other) {
      ctx.grabHooks!.select(other);
      return;
    }
    ctx.pickCb(ctx.pickAt(ev), ev.shiftKey, { x: ev.clientX, y: ev.clientY });
    const probed = ctx.stressHitLocal(ev.clientX, ev.clientY);
    if (probed) ctx.stressProbeCb(probed);
    ctx.setHover(ctx.pickAt(ev));
  });

  // --- S2: zoom along the normal while the sketch view is locked. OrbitControls would dolly in screen space. ---
  canvas.addEventListener("wheel", (ev) => {
    if (!ctx.sketchLock) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const offset = camera.position.clone().sub(controls.target);
    const dist = Math.min(4000, Math.max(8, offset.length() * Math.exp(ev.deltaY * 0.001)));
    if (offset.lengthSq() < 1e-8) return;
    offset.setLength(dist);
    camera.position.copy(controls.target).add(offset);
    ctx.holdSketchAxis();
    ctx.kick();
  }, { capture: true, passive: false });
  // A two-finger touchpad scroll orbits; a pinch zooms. After the sketch's zoom, which keeps the view on its plane.
  mountTrackpadOrbit(canvas, controls);
  canvas.addEventListener("contextmenu", (ev) => {
    if (ctx.sketchLock || ctx.sketchCapture) ev.preventDefault();
  });
  // A number field becomes a text field on focus, which blurs and refocuses it. Read the field after that settles.
  // The dock only: a Settings field must not run this.
  const modelDock = document.getElementById("modelPanel");
  const onDockFocus = () => queueMicrotask(ctx.syncFocusedField);
  modelDock?.addEventListener("focusin", onDockFocus);
  modelDock?.addEventListener("focusout", onDockFocus);
}
