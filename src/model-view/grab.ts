/** Grabbing the open solid in the view: begin, move, end and cancel of a move or turn. */
import * as THREE from "three";
import { type Affine, inversePose, thenPose } from "../model-space";
import { GRAB_MOVE_SNAP_MM, GRAB_ROTATE_SNAP_DEG, GRAB_SLOP_PX, SNAP_EXACT_MM } from "./constants";
import type { Grab } from "./types";
import { type GrabIntent, grabAxisForKey, grabDegrees, nearerHit } from "../viewport-grab";
import { rayAtHeight, turnPoseAbout } from "../model-grab";
import { signed } from "./helpers";
import { snapStep } from "../gizmo-math";
import type { ViewCtx } from "./ctx";

export function installGrab(ctx: ViewCtx): void {
  const { canvas, controls, posed, raycaster, snapGroup, tip } = ctx;
  ctx.beginGrab = beginGrab;
  ctx.cancelGrab = cancelGrab;
  ctx.mountGrabListeners = mountGrabListeners;
  ctx.seatSnapGuides = seatSnapGuides;
  ctx.setGrabHint = setGrabHint;

  let grabHint = false;
  let lastPointer: { clientX: number; clientY: number } | null = null;

  ctx.grab = null;
  /** The pose the grab last asked for, in the view it started in. */
  let grabAsked: Affine | null = null;
  /** When a Ctrl-right press last ended: the menu a right release asks for is not wanted after a turn. */
  let lastRightGrab = 0;
  /** The open solid, when the ray strikes it in front of every grey object. The ray is already set. */
  function solidInFront(): THREE.Intersection | null {
    if (!ctx.mesh) return null;
    const own = ctx.solidHit(raycaster.intersectObject(ctx.mesh, false));
    if (!own) return null;
    const other = ctx.greyHit();
    return nearerHit(own.distance, other?.distance ?? null) === "selected" ? own : null;
  }

  function beginGrab(ev: PointerEvent, intent: GrabIntent): boolean {
    if (!ctx.grabHooks || !ctx.mesh || !ctx.solid || ctx.sketchCapture || ctx.sketchLock || ctx.objectPicking || !ctx.grabHooks.ready()) return false;
    ctx.rayAt(ev.clientX, ev.clientY);
    if (!solidInFront()) return false;
    ctx.grab = { phase: "pending", pointerId: ev.pointerId, intent, x: ev.clientX, y: ev.clientY, axis: "z" };
    if (intent === "rotate") lastRightGrab = performance.now();
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    setGrabHint(false);
    ev.preventDefault();
    ev.stopImmediatePropagation();
    return true;
  }

  /** The pointer has left the slop: the grab is real, so the app opens Place and begins its step. */
  function startGrab(pending: Extract<Grab, { phase: "pending" }>): boolean {
    if (!ctx.grabHooks || !ctx.solid || !ctx.ownBox || !ctx.grabHooks.start()) {
      cancelGrab(false);
      return false;
    }
    canvas.style.cursor = "grabbing";
    tip.hidden = true;
    const start = ctx.poseNow;
    if (pending.intent === "move") {
      ctx.rayAt(pending.x, pending.y);
      const hit = solidInFront();
      const height = hit?.point.z ?? ctx.solidBox?.min[2] ?? 0;
      const ray = raycaster.ray;
      const from = rayAtHeight([ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z], height);
      if (!from) {
        cancelGrab(true);
        return false;
      }
      ctx.beginSnap();
      ctx.grab = { phase: "go", pointerId: pending.pointerId, intent: "move", start, height, from, offset: [0, 0, 0] };
    } else {
      const middle = new THREE.Vector3((ctx.ownBox.min[0] + ctx.ownBox.max[0]) / 2, (ctx.ownBox.min[1] + ctx.ownBox.max[1]) / 2, (ctx.ownBox.min[2] + ctx.ownBox.max[2]) / 2);
      const posedMiddle = middle.applyMatrix4(posed.matrix);
      ctx.grab = { phase: "go", pointerId: pending.pointerId, intent: "rotate", start, centre: [posedMiddle.x, posedMiddle.y, posedMiddle.z], axis: pending.axis, lastX: pending.x, total: 0 };
    }
    return true;
  }

  function endGrab(ev: PointerEvent) {
    const done = ctx.grab;
    if (!done || ev.pointerId !== done.pointerId) return;
    ctx.grab = null;
    if (done.intent === "rotate") lastRightGrab = performance.now();
    controls.enabled = true;
    canvas.style.cursor = "";
    tip.hidden = true;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    ctx.snapRun = null;
    ctx.showSnap(null);
    grabAsked = null;
    seatSnapGuides();
    if (done.phase === "pending") {
      // Never moved: a Ctrl-click on the solid is the click it was.
      if (ev.type !== "pointercancel") ctx.pickCb(ctx.pickAt(ev), ev.shiftKey, { x: ev.clientX, y: ev.clientY });
      return;
    }
    if (ev.type === "pointercancel") ctx.grabHooks?.cancel();
    else ctx.grabHooks?.end();
  }

  /** Esc, or a press the app refused. `began` is whether the app was told, and has a step to put back. */
  function cancelGrab(began: boolean) {
    const done = ctx.grab;
    if (!done) return;
    ctx.grab = null;
    if (done.intent === "rotate") lastRightGrab = performance.now();
    controls.enabled = true;
    canvas.style.cursor = "";
    tip.hidden = true;
    if (canvas.hasPointerCapture(done.pointerId)) canvas.releasePointerCapture(done.pointerId);
    ctx.snapRun = null;
    ctx.showSnap(null);
    grabAsked = null;
    seatSnapGuides();
    if (began) ctx.grabHooks?.cancel();
  }

  function grabMoveTo(pose: Affine) {
    grabAsked = pose;
    ctx.grabHooks?.move(pose);
  }

  /**
   * --- Assemblies M10. A part open in its own frame stays put while the others move: the snap guides, worked out in the
   * view the grab started in, follow the others. Identity whenever the part stands where the grab asked.
   */
  function seatSnapGuides() {
    const { m, t } = ctx.grab?.phase === "go" && grabAsked ? thenPose(inversePose(grabAsked), ctx.poseNow) : { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
    snapGroup.matrixAutoUpdate = false;
    snapGroup.matrix.set(m[0]!, m[1]!, m[2]!, t[0]!, m[3]!, m[4]!, m[5]!, t[1]!, m[6]!, m[7]!, m[8]!, t[2]!, 0, 0, 0, 1);
    snapGroup.updateMatrixWorld(true);
  }

  function moveGrab(ev: PointerEvent) {
    const now = ctx.grab;
    if (!now || ev.pointerId !== now.pointerId) return;
    if (now.phase === "pending") {
      if (Math.hypot(ev.clientX - now.x, ev.clientY - now.y) <= GRAB_SLOP_PX) return;
      if (!startGrab(now)) return;
      moveGrab(ev);
      return;
    }
    if (now.intent === "move") {
      const ray = ctx.rayAt(ev.clientX, ev.clientY);
      const at = rayAtHeight([ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z], now.height);
      if (!at) return;
      const raw: [number, number] = [at[0] - now.from[0], at[1] - now.from[1]];
      const hit = ev.shiftKey || ev.altKey ? null : ctx.snapAt(["x", "y"], [raw[0], raw[1], 0]);
      if (!hit) ctx.showSnap(null);
      const dx = hit ? raw[0] + hit.delta[0] : snapStep(raw[0], ev.shiftKey, GRAB_MOVE_SNAP_MM);
      const dy = hit ? raw[1] + hit.delta[1] : snapStep(raw[1], ev.shiftKey, GRAB_MOVE_SNAP_MM);
      if (Math.abs(dx - now.offset[0]) < (hit ? SNAP_EXACT_MM : 0.02) && Math.abs(dy - now.offset[1]) < (hit ? SNAP_EXACT_MM : 0.02)) return;
      now.offset = [dx, dy, 0];
      grabMoveTo({ m: now.start.m, t: [now.start.t[0] + dx, now.start.t[1] + dy, now.start.t[2]] });
      ctx.placeTip(ev, `X ${signed(dx)}, Y ${signed(dy)} mm${ctx.snapLabel ? ` · ${ctx.snapLabel}` : ""}`);
      return;
    }
    now.total += grabDegrees(ev.clientX - now.lastX);
    now.lastX = ev.clientX;
    const deg = snapStep(now.total, ev.shiftKey, GRAB_ROTATE_SNAP_DEG);
    grabMoveTo(turnPoseAbout(now.start, now.centre, now.axis, deg));
    ctx.placeTip(ev, `${now.axis.toUpperCase()} ${signed(deg)}°`);
  }

  /** Ctrl held with the pointer over the open solid, with nothing going on: say what a drag does, and show the grab cursor. */
  function grabOver(ev: { clientX: number; clientY: number; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || !ctx.grabHooks || !ctx.mesh || ctx.sketchCapture || ctx.sketchLock || ctx.objectPicking || !ctx.grabHooks.ready()) return false;
    ctx.rayAt(ev.clientX, ev.clientY);
    return solidInFront() !== null;
  }

  function setGrabHint(over: boolean) {
    if (grabHint === over) return;
    grabHint = over;
    canvas.style.cursor = over ? "grab" : "";
    ctx.grabHooks?.hint(over);
  }

  /** Called once, before the view is returned: the helpers here are declarations, but a listener is a statement and has to run. */
  function mountGrabListeners() {
    canvas.addEventListener("pointermove", (ev) => {
      lastPointer = { clientX: ev.clientX, clientY: ev.clientY };
      if (ctx.grab) {
        moveGrab(ev);
        ev.stopImmediatePropagation();
        return;
      }
      if (!ctx.drag && !ctx.down) setGrabHint(grabOver(ev));
    }, { capture: true });
    canvas.addEventListener("pointerleave", () => {
      lastPointer = null;
      setGrabHint(false);
    });
    window.addEventListener("keydown", (ev) => {
      const now = ctx.grab;
      if (now) {
        const axis = now.intent === "rotate" ? grabAxisForKey(ev.key) : null;
        if (ev.key !== "Escape" && !axis) return;
        if (ev.key === "Escape") cancelGrab(now.phase === "go");
        else if (now.phase === "pending" && axis) {
          ctx.grab = { ...now, axis };
        } else if (now.phase === "go" && now.intent === "rotate" && axis) {
          // A new axis turns from where the part now stands.
          ctx.grab = { ...now, axis, start: ctx.poseNow, total: 0 };
        }
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        return;
      }
      if ((ev.key === "Control" || ev.key === "Meta") && lastPointer && !ctx.drag && !ctx.down) setGrabHint(grabOver({ ...lastPointer, ctrlKey: true, metaKey: false, altKey: ev.altKey }));
    }, true);
    window.addEventListener("keyup", (ev) => {
      if (ev.key === "Control" || ev.key === "Meta") setGrabHint(false);
    });
    canvas.addEventListener("pointerup", endGrab, { capture: true });
    canvas.addEventListener("pointercancel", endGrab, { capture: true });
    // The menu a right release asks for is not wanted after a Ctrl-right turn.
    canvas.addEventListener("contextmenu", (ev) => {
      if (ctx.grab || performance.now() - lastRightGrab < 400) ev.preventDefault();
    });
  }
}
