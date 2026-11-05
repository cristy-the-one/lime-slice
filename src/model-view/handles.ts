/** Drag handles: building and painting them, the edge knob, hit tests, and the drag itself. */
import * as THREE from "three";
import { ARROW_HEAD } from "./constants";
import type { ActiveDrag, HandlePart } from "./types";
import { type DragHandle, axisValues, dragValue, lineParam, moveFine, planeValues, startFine, wrapDegrees } from "../model-drag";
import { EDGE_KNOB_ID } from "../interact/edge-drag";
import { HANDLE_KNOB_PICK, HANDLE_RING_RADIUS } from "../gizmo-math";
import { aspectTip } from "../handle-emphasis";
import { hexToThree } from "../theme";
import { localPoint } from "../workplane";
import type { ViewCtx } from "./ctx";

export function installHandles(ctx: ViewCtx): void {
  const { camera, canvas, handleGroup, pointer, raycaster, tip, yAxis, zAxis } = ctx;
  ctx.aspectHandle = aspectHandle;
  ctx.beginDrag = beginDrag;
  ctx.buildHandles = buildHandles;
  ctx.clearEdgeKnob = clearEdgeKnob;
  ctx.drawnHandles = drawnHandles;
  ctx.handleAt = handleAt;
  ctx.handleColor = handleColor;
  ctx.handlePart = handlePart;
  ctx.moveDrag = moveDrag;
  ctx.paintHandles = paintHandles;
  ctx.placeTip = placeTip;
  ctx.rayAt = rayAt;
  ctx.showTip = showTip;
  ctx.updateEdgeHover = updateEdgeHover;


  function handleColor(color: DragHandle["color"]): number {
    if (color === "x") return hexToThree(ctx.colors.axisX);
    if (color === "y") return hexToThree(ctx.colors.axisY);
    if (color === "z") return hexToThree(ctx.colors.axisZ);
    return ctx.accent;
  }

  function buildHandles(next: DragHandle[]) {
    const same = ctx.handleParts.length === next.length && next.every((handle, index) => {
      const held = ctx.handleParts[index]!.handle;
      return held.id === handle.id && held.look === handle.look && held.kind === handle.kind;
    });
    // A size drag only changes numbers. Rebuilding the arrows each move kept their geometries alive past GC.
    if (same) {
      for (let index = 0; index < next.length; index += 1) {
        const part = ctx.handleParts[index]!;
        part.handle = next[index]!;
        // --- Assemblies M10. A handle whose axis turned with the view turns with it, without new geometry; one under a
        // drag keeps the axis the drag started on.
        if (!ctx.drag) part.root.quaternion.setFromUnitVectors(part.built, new THREE.Vector3(...part.handle.dir).normalize());
      }
      ctx.collectFieldInputs();
      if (ctx.overHandle && !next.some((handle) => handle.id === ctx.overHandle)) ctx.overHandle = null;
      paintHandles();
      return;
    }
    for (const part of ctx.handleParts) {
      handleGroup.remove(part.root);
      ctx.disposeObject(part.root);
    }
    ctx.handleParts = next.map((handle) => handlePart(handle));
    for (const part of ctx.handleParts) handleGroup.add(part.root);
    ctx.collectFieldInputs();
    if (ctx.overHandle && !next.some((handle) => handle.id === ctx.overHandle)) ctx.overHandle = null;
    paintHandles();
  }

  function handlePart(handle: DragHandle): HandlePart {
    const root = new THREE.Group();
    const dir = new THREE.Vector3(...handle.dir).normalize();
    const material = new THREE.MeshBasicMaterial({ color: handleColor(handle.color), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
    const hidden = new THREE.MeshBasicMaterial({ visible: false });
    const shown: THREE.Mesh[] = [];
    const picks: THREE.Mesh[] = [];
    const place = (mesh: THREE.Mesh, from: THREE.Vector3, offset: number) => {
      mesh.quaternion.setFromUnitVectors(from, dir);
      mesh.position.copy(dir).multiplyScalar(offset);
      root.add(mesh);
    };
    if (handle.look === "arrow") {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.55, 10), material);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.098, 0.3, 14), material);
      const pick = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.85, 8), hidden);
      place(shaft, yAxis, 0.4);
      place(head, yAxis, ARROW_HEAD);
      place(pick, yAxis, 0.55);
      shown.push(shaft, head);
      picks.push(pick);
    } else if (handle.look === "knob") {
      const knob = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), material);
      const pick = new THREE.Mesh(new THREE.SphereGeometry(HANDLE_KNOB_PICK, 10, 8), hidden);
      place(knob, yAxis, 0);
      place(pick, yAxis, 0);
      shown.push(knob);
      picks.push(pick);
    } else if (handle.look === "ring") {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(HANDLE_RING_RADIUS, 0.03, 10, 64), material);
      const pick = new THREE.Mesh(new THREE.TorusGeometry(HANDLE_RING_RADIUS, 0.09, 8, 32), hidden);
      place(ring, zAxis, 0);
      place(pick, zAxis, 0);
      shown.push(ring);
      picks.push(pick);
    } else {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 10), material);
      const pick = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), hidden);
      place(dot, yAxis, 0);
      place(pick, yAxis, 0);
      shown.push(dot);
      picks.push(pick);
    }
    for (const mesh of [...shown, ...picks]) {
      mesh.renderOrder = handle.look === "ring" ? 6 : 7;
      mesh.frustumCulled = false;
    }
    return { handle, root, material, picks, built: dir.clone() };
  }

  /** Tool handles plus the edge knob, when one is showing. */
  function drawnHandles(): HandlePart[] {
    return ctx.edgeKnobPart ? [...ctx.handleParts, ctx.edgeKnobPart] : ctx.handleParts;
  }

  function paintHandles() {
    const hot = hexToThree(ctx.colors.gizmoHot);
    const lit = aspectHandle()?.id ?? null;
    for (const part of drawnHandles()) {
      const on = part.handle.id === lit || (ctx.edgeDrag != null && part.handle.id === EDGE_KNOB_ID);
      part.material.color.setHex(on ? hot : handleColor(part.handle.color));
    }
    canvas.style.cursor = ctx.sketchCapture ? "crosshair" : ctx.drag || ctx.edgeDrag || ctx.faceDown?.moved ? "grabbing" : ctx.overHandle || (ctx.faceDrag && ctx.hover?.kind === "face") ? "grab" : "";
    ctx.paintAspect();
    ctx.kick();
  }

  /** Drag, then the handle under the pointer, then the focused field. Nothing here lights the whole solid. */
  function aspectHandle(): DragHandle | null {
    ctx.lightEveryHole = false;
    if (ctx.drag) return { ...ctx.drag.handle, values: ctx.drag.values };
    if (ctx.overHandle) return drawnHandles().find((part) => part.handle.id === ctx.overHandle)?.handle ?? null;
    if (ctx.focusedField) {
      const matches = ctx.handleParts.filter((part) => part.handle.fields.includes(ctx.focusedField!));
      if (ctx.focusedHole != null) {
        const indexed = matches.find((part) => part.handle.holeIndex === ctx.focusedHole);
        if (indexed) return indexed.handle;
      }
      const grouped = matches.filter((part) => part.handle.holeIndex != null);
      if (ctx.focusedHole == null && grouped.length > 1) ctx.lightEveryHole = true;
      return matches[0]?.handle ?? null;
    }
    return null;
  }

  function clearEdgeKnob() {
    if (!ctx.edgeKnobPart) return;
    handleGroup.remove(ctx.edgeKnobPart.root);
    ctx.disposeObject(ctx.edgeKnobPart.root);
    ctx.edgeKnobPart = null;
    if (ctx.overHandle === EDGE_KNOB_ID) ctx.overHandle = null;
  }

  /** Keep the lit edge while the pointer is on its knob, so reaching for the knob does not dismiss it. */
  function updateEdgeHover(ev: PointerEvent, over: HandlePart | null) {
    if (ctx.edgeKnobPart && over === ctx.edgeKnobPart) {
      ctx.edgeHoverCb(ctx.edgeLit, { x: ev.clientX, y: ev.clientY });
      return;
    }
    const index = ctx.pickEdge(ev)?.index ?? null;
    const at = { x: ev.clientX, y: ev.clientY };
    if (index === ctx.edgeLit) {
      ctx.edgeHoverCb(index, at);
      return;
    }
    ctx.edgeLit = index;
    ctx.paintLines();
    ctx.kick();
    ctx.edgeHoverCb(index, at);
  }

  function rayAt(x: number, y: number) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((x - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointer.y = -((y - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return raycaster.ray;
  }

  function handleAt(x: number, y: number): HandlePart | null {
    const parts = drawnHandles();
    if (parts.length === 0) return null;
    ctx.sizeHandles();
    handleGroup.updateMatrixWorld(true);
    rayAt(x, y);
    let best: { part: HandlePart; rank: number; distance: number } | null = null;
    for (const part of parts) {
      const hit = raycaster.intersectObjects(part.picks, false)[0];
      if (!hit) continue;
      // Knobs and dots sit on arrows, and arrows inside rings, so the smaller target wins an overlap.
      const rank = part.handle.look === "ring" ? 2 : part.handle.look === "arrow" ? 1 : 0;
      if (!best || rank < best.rank || (rank === best.rank && hit.distance < best.distance)) best = { part, rank, distance: hit.distance };
    }
    return best?.part ?? null;
  }

  function ringAngle(active: ActiveDrag, x: number, y: number): number | null {
    const ray = rayAt(x, y);
    const normal = new THREE.Vector3(...active.handle.dir).normalize();
    const origin = active.anchor;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
    if (Math.abs(ray.direction.dot(normal)) < 0.05) return null;
    const hit = ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    const u = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(normal).normalize() : new THREE.Vector3(1, 0, 0).cross(normal).normalize();
    const v = normal.clone().cross(u);
    const offset = hit.sub(origin);
    return (Math.atan2(offset.dot(v), offset.dot(u)) * 180) / Math.PI;
  }

  /** Where the pointer's ray meets the plane square to a `plane` handle's `dir` through where it was grabbed; null edge-on. */
  function planeHit(active: ActiveDrag, x: number, y: number): THREE.Vector3 | null {
    const ray = rayAt(x, y);
    const normal = new THREE.Vector3(...active.handle.dir).normalize();
    if (Math.abs(ray.direction.dot(normal)) < 0.05) return null;
    return ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, active.anchor), new THREE.Vector3());
  }

  function axisParam(active: ActiveDrag, x: number, y: number): number | null {
    const ray = rayAt(x, y);
    const dir = new THREE.Vector3(...active.handle.dir).normalize();
    const origin = active.anchor;
    return lineParam([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], [ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z]);
  }

  /** The line or plane a drag measures against is fixed where the handle stood when it was grabbed. */
  function beginDrag(part: HandlePart, ev: PointerEvent) {
    const handle = part.handle;
    const active: ActiveDrag = {
      handle,
      anchor: part.root.position.clone(),
      pointerId: ev.pointerId,
      fine: startFine(ev.clientX, ev.clientY, ev.shiftKey),
      values: [...handle.values],
      startParam: null,
      lastAngle: null,
      turned: 0,
    };
    ctx.struck = null;
    if (handle.kind === "axis" && handle.id.startsWith("place-")) ctx.beginSnap();
    if (handle.kind === "axis") active.startParam = axisParam(active, ev.clientX, ev.clientY);
    if (handle.kind === "ring") active.lastAngle = ringAngle(active, ev.clientX, ev.clientY);
    if (handle.kind === "plane") active.startHit = planeHit(active, ev.clientX, ev.clientY);
    ctx.drag = active;
    paintHandles();
    showTip(ev, handle, active.values);
  }

  function moveDrag(ev: PointerEvent) {
    const current = ctx.drag;
    if (!current) return;
    const fine = ev.shiftKey;
    const snap = ev.ctrlKey || ev.metaKey;
    current.fine = moveFine(current.fine, ev.clientX, ev.clientY, fine);
    const { x, y } = current.fine;
    const handle = current.handle;
    let next: number[] | null = null;
    if (handle.kind === "axis") {
      const param = axisParam(current, x, y);
      if (param != null && current.startParam != null) next = axisValues(handle, handle.values, param - current.startParam, snap, fine);
    } else if (handle.kind === "plane") {
      const hit = planeHit(current, x, y);
      const axes = handle.axes;
      if (hit && current.startHit && axes) {
        const moved = hit.clone().sub(current.startHit);
        next = planeValues(handle, handle.values, axes.map((axis) => moved.dot(new THREE.Vector3(...axis))), snap, fine);
      }
    } else if (handle.kind === "ring") {
      const angle = ringAngle(current, x, y);
      if (angle != null) {
        if (current.lastAngle != null) current.turned += wrapDegrees(angle - current.lastAngle);
        current.lastAngle = angle;
        next = [wrapDegrees(dragValue(handle, handle.values[0] ?? 0, current.turned, snap, fine))];
      }
    } else {
      let point = ctx.surfacePoint(x, y, snap, handle.id.startsWith("measure"), !ev.altKey);
      ctx.showSnapMark();
      if (point && handle.frame) point = localPoint(handle.frame, point);
      const places = ctx.snappedTo ? 1000 : fine ? 100 : 10;
      if (point) next = point.map((value) => Math.round(value * places) / places);
    }
    if (next && handle.kind === "axis" && handle.id.startsWith("place-")) next = ctx.snapPlaceArrow(handle, next, !(ev.altKey || snap || fine));
    if (next && next.some((value, i) => value !== current.values[i])) {
      current.values = next;
      ctx.handleCb({ handle, values: next, phase: "move", ...(handle.id.startsWith("measure") ? { snap: ctx.struck } : {}) });
      ctx.paintAspect();
    }
    showTip(ev, handle, current.values);
  }

  function showTip(ev: PointerEvent, handle: DragHandle, values: readonly number[]) {
    if (ctx.aspectNow?.mapped && ctx.aspectNow.dimension) {
      tip.hidden = true;
      return;
    }
    const text = aspectTip(handle, values);
    placeTip(ev, ctx.snapLabel && handle.id.startsWith("place-") ? `${text} · ${ctx.snapLabel}` : text);
  }

  /** The short label that follows the pointer. */
  function placeTip(ev: { clientX: number; clientY: number }, text: string) {
    const parent = canvas.parentElement?.getBoundingClientRect();
    if (!parent) return;
    tip.textContent = text;
    tip.hidden = false;
    // The dock sits at the right edge, so the tip flips to the pointer's left rather than run off the canvas.
    const right = ev.clientX - parent.left + 14;
    const left = right + tip.offsetWidth > parent.width - 4 ? ev.clientX - parent.left - 14 - tip.offsetWidth : right;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${ev.clientY - parent.top + 14}px`;
  }
}
