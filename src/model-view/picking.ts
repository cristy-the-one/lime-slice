/** Picking: face and edge hits, hover, object picking, section probes, and surface points for Measure. */
import * as THREE from "three";
import { EDGE_PX } from "./constants";
import type { FaceHit, FacePointer, ModelPick } from "./types";
import { MEASURE_KIND_LABEL, type MeasureKind } from "../measure-snap";
import { type Vec3, lineParam } from "../model-drag";
import { featureAtHit } from "../measure-feature";
import { segmentDistance } from "./helpers";
import type { ViewCtx } from "./ctx";

export function installPicking(ctx: ViewCtx): void {
  const { body, camera, canvas, context, controls, pointer, posed, projected, raycaster, snapMark, snapMarkText } = ctx;
  ctx.beginFace = beginFace;
  ctx.faceEvent = faceEvent;
  ctx.faceHit = faceHit;
  ctx.finishFace = finishFace;
  ctx.greyHit = greyHit;
  ctx.objectAt = objectAt;
  ctx.pickAt = pickAt;
  ctx.pickEdge = pickEdge;
  ctx.sectionHit = sectionHit;
  ctx.sectionTravel = sectionTravel;
  ctx.setHover = setHover;
  ctx.showSnapMark = showSnapMark;
  ctx.surfacePoint = surfacePoint;


  /** P1. The face under the pointer, with the hit in model space and in the solid's frame. */
  function faceHit(ev: PointerEvent): FaceHit | null {
    if (!ctx.mesh || !ctx.solid || ctx.mode !== "face") return null;
    ctx.rayAt(ev.clientX, ev.clientY);
    const hit = ctx.solidHit(raycaster.intersectObject(ctx.mesh, false));
    if (!hit || hit.faceIndex == null) return null;
    const face = ctx.solid.triangles[hit.faceIndex];
    if (face == null) return null;
    const point = hit.point;
    const local = posed.worldToLocal(point.clone());
    return { face, triangle: hit.faceIndex, point: [point.x, point.y, point.z], local: [local.x, local.y, local.z] };
  }

  function faceEvent(phase: FacePointer["phase"], ev: PointerEvent, hit: FaceHit | null): FacePointer {
    const ray = ctx.rayAt(ev.clientX, ev.clientY);
    return {
      phase,
      face: hit?.face ?? null,
      triangle: hit?.triangle ?? null,
      point: hit?.point ?? null,
      local: hit?.local ?? null,
      ray: { origin: [ray.origin.x, ray.origin.y, ray.origin.z], direction: [ray.direction.x, ray.direction.y, ray.direction.z] },
      alt: ev.altKey,
      ctrl: ev.ctrlKey || ev.metaKey,
      shift: ev.shiftKey,
      meta: ev.metaKey,
      x: ev.clientX,
      y: ev.clientY,
    };
  }

  /** P1. Take the press when it lands on a face. False leaves the press for a handle or the orbit. */
  function beginFace(ev: PointerEvent, onArrow = false): boolean {
    if (!ctx.faceDrag || ctx.mode !== "face" || ev.button !== 0) return false;
    // A press on the arrow grabs the face it sits on, as the edge knob grabs its edge.
    const hit = (onArrow ? ctx.seatHit : null) ?? faceHit(ev);
    if (!hit) return false;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    ctx.faceDown = { x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId, moved: false, hit };
    ctx.faceCb(faceEvent("down", ev, hit));
    return true;
  }

  function finishFace(ev: PointerEvent) {
    const done = ctx.faceDown;
    ctx.faceDown = null;
    if (!done) return;
    controls.enabled = true;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    const hit = faceHit(ev) ?? done.hit;
    if (ev.type === "pointercancel") ctx.faceCb(faceEvent("cancel", ev, hit));
    else if (done.moved) ctx.faceCb(faceEvent("up", ev, hit));
    else {
      ctx.faceCb(faceEvent("click", ev, hit));
      ctx.pickCb({ kind: "face", index: hit.face, at: hit.point }, ev.shiftKey, { x: ev.clientX, y: ev.clientY });
      const probed = ctx.stressHitLocal(ev.clientX, ev.clientY);
      if (probed) ctx.stressProbeCb(probed);
      setHover({ kind: "face", index: hit.face });
    }
    ctx.paintHandles();
  }

  function pickFace(ev: PointerEvent): ModelPick | null {
    if (!ctx.mesh) return null;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = ctx.solidHit(raycaster.intersectObject(ctx.mesh, false));
    if (!hit || hit.faceIndex == null || !ctx.solid) return null;
    const face = ctx.solid.triangles[hit.faceIndex];
    if (face == null) return null;
    const point = hit.point;
    return { kind: "face", index: face, at: [point.x, point.y, point.z] };
  }

  function project(x: number, y: number, z: number, rect: DOMRect): { x: number; y: number; z: number } {
    projected.set(x, y, z);
    body.localToWorld(projected);
    projected.project(camera);
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
      z: projected.z,
    };
  }

  function pickEdge(ev: PointerEvent): ModelPick | null {
    if (!ctx.solid) return null;
    const rect = canvas.getBoundingClientRect();
    let best: { index: number; distance: number } | null = null;
    const seams = ctx.solid.seams && ctx.solid.seams.length > 0 ? new Set(ctx.solid.seams) : null;
    for (const edge of ctx.solid.edges) {
      // A seam is not an edge of the part: it is neither hovered nor picked (the MCP list keeps it, its index is unchanged).
      if (seams?.has(edge.id)) continue;
      const points = edge.points;
      for (let i = 0; i + 5 < points.length; i += 3) {
        // A segment the section hides wholly cannot be picked; one it crosses can, as its shown part is drawn.
        if (ctx.sectionClip.length > 0 && cutAwayLocal(points, i) && cutAwayLocal(points, i + 3)) continue;
        const a = project(points[i]!, points[i + 1]!, points[i + 2]!, rect);
        const b = project(points[i + 3]!, points[i + 4]!, points[i + 5]!, rect);
        if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) continue;
        const distance = segmentDistance(ev.clientX, ev.clientY, a.x, a.y, b.x, b.y);
        if (distance <= EDGE_PX && (best == null || distance < best.distance)) best = { index: edge.id, distance };
      }
    }
    return best ? { kind: "edge", index: best.index } : null;
  }

  const sectionProbe = new THREE.Vector3();

  /** Whether the section hides the solid-frame point at `points[i]`. */
  function cutAwayLocal(points: ArrayLike<number>, i: number): boolean {
    sectionProbe.set(points[i]!, points[i + 1]!, points[i + 2]!);
    body.localToWorld(sectionProbe);
    return ctx.cutAway(sectionProbe);
  }

  function pickAt(ev: PointerEvent): ModelPick | null {
    return ctx.mode === "face" ? pickFace(ev) : pickEdge(ev);
  }

  ctx.sectionArrowLength = 1;

  /** Screen distance to the section arrow. World points: the arrow lives in model space, not the solid's frame. */
  function sectionHit(x: number, y: number): boolean {
    if (!ctx.sectionPlaneWorld || !ctx.sectionArrow?.visible) return false;
    const rect = canvas.getBoundingClientRect();
    const tip = ctx.sectionPlaneWorld.origin.clone().addScaledVector(ctx.sectionPlaneWorld.normal, ctx.sectionArrowLength);
    const projectWorld = (point: THREE.Vector3) => {
      const p = point.clone().project(camera);
      return { x: rect.left + (p.x * 0.5 + 0.5) * rect.width, y: rect.top + (-p.y * 0.5 + 0.5) * rect.height, z: p.z };
    };
    const a = projectWorld(ctx.sectionPlaneWorld.origin);
    const b = projectWorld(tip);
    if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) return false;
    return segmentDistance(x, y, a.x, a.y, b.x, b.y) <= 14;
  }

  /** Millimetres along `normal` from `origin` to the pointer's closest approach. The line stays put for a whole drag. */
  function sectionTravel(origin: THREE.Vector3, normal: THREE.Vector3, x: number, y: number): number | null {
    const ray = ctx.rayAt(x, y);
    return lineParam(
      [origin.x, origin.y, origin.z],
      [normal.x, normal.y, normal.z],
      [ray.origin.x, ray.origin.y, ray.origin.z],
      [ray.direction.x, ray.direction.y, ray.direction.z],
    );
  }

  function sameHover(next: ModelPick | null) {
    if (!ctx.hover || !next) return ctx.hover === next;
    return ctx.hover.kind === next.kind && ctx.hover.index === next.index;
  }

  function setHover(next: ModelPick | null) {
    if (sameHover(next)) return;
    const edges = ctx.hover?.kind === "edge" || next?.kind === "edge";
    ctx.hover = next;
    ctx.paintFaces();
    if (edges) ctx.paintLines();
    ctx.kick();
  }

  /** The grey object under the pointer, unless the open solid is in front of it. */
  function objectAt(ev: PointerEvent): string | null {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    // The open solid's hidden half does not stand in front of a grey object.
    const hit = raycaster.intersectObjects(ctx.mesh ? [...context.children, ctx.mesh] : context.children, false).find((item) => item.object !== ctx.mesh || !ctx.cutAway(item.point));
    const id = hit?.object.userData.id;
    return typeof id === "string" ? id : null;
  }

  /** The feature near the hit that a Measure point lands on exactly: a corner, an edge's middle, a flat face's middle, the box. */
  function featureNear(hit: THREE.Intersection, object?: string): { kind: MeasureKind; at: THREE.Vector3 } | null {
    const target = hit.object instanceof THREE.Mesh ? hit.object : null;
    if (!target) return null;
    // Only the open solid has B-rep edges, so only it offers circle centres.
    const curves = target === ctx.mesh ? ctx.solid?.edges.filter((edge) => !ctx.solid?.seams?.includes(edge.id)).map((edge) => edge.points) : undefined;
    const found = featureAtHit(hit, target, camera, canvas, curves);
    if (!found) return null;
    ctx.snappedTo = { kind: found.kind, at: found.at, object };
    return found;
  }

  function showSnapMark() {
    const parent = canvas.parentElement?.getBoundingClientRect();
    if (!ctx.snappedTo || !parent) {
      snapMark.hidden = true;
      delete canvas.dataset.measureSnap;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const p = ctx.snappedTo.at.clone().project(camera);
    snapMark.style.left = `${rect.left - parent.left + ((p.x + 1) / 2) * rect.width}px`;
    snapMark.style.top = `${rect.top - parent.top + ((1 - p.y) / 2) * rect.height}px`;
    const named = ctx.snappedTo.object ? ctx.contextList.find((part) => part.id === ctx.snappedTo!.object)?.name : undefined;
    snapMarkText.textContent = named ? `${MEASURE_KIND_LABEL[ctx.snappedTo.kind]} · ${named}` : MEASURE_KIND_LABEL[ctx.snappedTo.kind];
    snapMark.hidden = false;
    canvas.dataset.measureSnap = `${ctx.snappedTo.kind}:${ctx.snappedTo.at.x.toFixed(3)},${ctx.snappedTo.at.y.toFixed(3)},${ctx.snappedTo.at.z.toFixed(3)}`;
  }

  /** The nearest grey object the ray strikes, and where. Nothing snaps to the open solid's own grey copy. */
  function greyHit(): THREE.Intersection | null {
    if (context.children.length === 0) return null;
    context.updateMatrixWorld(true);
    const self = new Set(ctx.contextList.filter((part) => part.self).map((part) => part.id));
    const hits = raycaster.intersectObjects(context.children, false).filter((item) => !self.has(String(item.object.userData.id)));
    return hits[0] ?? null;
  }

  /** `feature` is a Measure point: it may land on a grey object, and snaps to the corners, middles and circles of what it strikes. */
  function surfacePoint(x: number, y: number, snap: boolean, feature = false, featureSnap = true): Vec3 | null {
    ctx.snappedTo = null;
    ctx.struck = null;
    if (!ctx.mesh) return null;
    ctx.rayAt(x, y);
    let hit = ctx.solidHit(raycaster.intersectObject(ctx.mesh, false));
    let object: string | undefined;
    if (feature) {
      const other = greyHit();
      if (other && (!hit || other.distance < hit.distance)) {
        hit = other;
        object = String(other.object.userData.id);
      }
    }
    if (!hit) return null;
    ctx.struck = { kind: "surface", object };
    if (feature && featureSnap && !snap) {
      const found = featureNear(hit, object);
      if (found) {
        ctx.struck = { kind: found.kind, object };
        return [found.at.x, found.at.y, found.at.z];
      }
    }
    if (object) return [hit.point.x, hit.point.y, hit.point.z];
    // A point the user puts down is a model-space number, like every other tool field.
    const point = hit.point.clone();
    if (snap && hit.faceIndex != null) {
      const positions = ctx.mesh.geometry.getAttribute("position");
      let best: THREE.Vector3 | null = null;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = ctx.mesh.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, hit.faceIndex * 3 + corner));
        if (!best || vertex.distanceToSquared(point) < best.distanceToSquared(point)) best = vertex;
      }
      if (best) point.copy(best);
    }
    return [point.x, point.y, point.z];
  }
}
