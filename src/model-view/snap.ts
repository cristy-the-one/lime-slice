/** Move snapping: what a drag snaps to and the guides drawn for it. */
import * as THREE from "three";
import type { Box } from "../measure";
import type { DragHandle } from "../model-drag";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { type Screen, type SnapAxis, type SnapHit, shifted, snapMove } from "../place-snap";
import { neighbourTargets, solidFootprint } from "../place-snap-scene";
import { warmFeatures } from "../measure-feature";
import type { ViewCtx } from "./ctx";

export function installSnap(ctx: ViewCtx): void {
  const { camera, canvas, context, contextMat, snapGroup, snapLineMat, targetMat } = ctx;
  ctx.beginSnap = beginSnap;
  ctx.markTarget = markTarget;
  ctx.showSnap = showSnap;
  ctx.snapAt = snapAt;
  ctx.snapPlaceArrow = snapPlaceArrow;
  ctx.warmSnap = warmSnap;

  let warmTimer = 0;

  /** Pixels one millimetre of each model axis draws at the part's middle, as the vector it draws. */
  function screenScale(box: Box): Screen {
    camera.updateMatrixWorld();
    const rect = canvas.getBoundingClientRect();
    const probe = new THREE.Vector3();
    const at = (x: number, y: number, z: number): [number, number] => {
      probe.set(x, y, z).project(camera);
      return [((probe.x + 1) / 2) * rect.width, ((1 - probe.y) / 2) * rect.height];
    };
    const cx = (box.min[0] + box.max[0]) / 2;
    const cy = (box.min[1] + box.max[1]) / 2;
    const cz = (box.min[2] + box.max[2]) / 2;
    const o = at(cx, cy, cz);
    const along = (p: [number, number]): [number, number] => [p[0] - o[0], p[1] - o[1]];
    return { x: along(at(cx + 1, cy, cz)), y: along(at(cx, cy + 1, cz)), z: along(at(cx, cy, cz + 1)) };
  }

  /**
   * The outlines a snap reads, and with `measuring` the features a Measure point reads, are a pass over every vertex of
   * each object: a few hundred milliseconds for a part of 170 000 triangles. They are built a moment after the objects
   * change, one object to a task, so the first drag or hover finds them held.
   */
  function warmSnap() {
    window.clearTimeout(warmTimer);
    warmTimer = window.setTimeout(() => {
      const jobs: (() => void)[] = [];
      if (ctx.solid && ctx.solid.positions.length >= 9) {
        const own = ctx.solid;
        jobs.push(() => void solidFootprint(own.positions, ctx.poseNow));
        if (ctx.measureOpen) jobs.push(() => warmFeatures(own.positions, own.edges.filter((edge) => !own.seams?.includes(edge.id)).map((edge) => edge.points)));
      }
      for (const part of ctx.contextList) {
        if (part.self) continue;
        jobs.push(() => void neighbourTargets([part]));
        if (ctx.measureOpen) jobs.push(() => warmFeatures(part.positions));
      }
      const next = () => {
        jobs.shift()?.();
        if (jobs.length > 0) warmTimer = window.setTimeout(next, 0);
      };
      next();
    }, 700);
  }

  /** Builds what a move snaps on: the open solid where it stands, and every grey object Model shows. */
  function beginSnap() {
    ctx.snapRun = null;
    if (!ctx.solid || ctx.solid.positions.length < 9 || !ctx.solidBox) return;
    ctx.snapRun = { moving: solidFootprint(ctx.solid.positions, ctx.poseNow), targets: neighbourTargets(ctx.contextList.filter((part) => !part.self)), screen: screenScale(ctx.solidBox) };
  }

  /** The snap for a drag that has moved the part by `offset` from where it started. Null when there is nothing to snap to. */
  function snapAt(axes: SnapAxis[], offset: [number, number, number]): SnapHit | null {
    if (!ctx.snapRun) return null;
    const hit = snapMove({ moving: shifted(ctx.snapRun.moving, offset), targets: ctx.snapRun.targets, bed: null, axes, screen: ctx.snapRun.screen });
    showSnap(hit);
    return hit;
  }

  /** A Place arrow's value, moved to what the part snaps to along its axis. `on` is false while Alt, Ctrl or Shift holds the snap off. */
  function snapPlaceArrow(handle: DragHandle, next: number[], on: boolean): number[] {
    const axis = handle.id.slice(-1);
    if (!(axis === "x" || axis === "y" || axis === "z") || next.length !== 1) return next;
    const i = axis === "x" ? 0 : axis === "y" ? 1 : 2;
    const offset: [number, number, number] = [0, 0, 0];
    offset[i] = next[0]! - (handle.values[0] ?? 0);
    const hit = on ? snapAt([axis], offset) : null;
    if (!hit) {
      showSnap(null);
      return next;
    }
    return [Math.round((next[0]! + hit.delta[i]) * 1e3) / 1e3];
  }

  function markTarget(id: string | null) {
    if (id === ctx.markedTarget) return;
    ctx.markedTarget = id;
    for (const node of context.children as THREE.Mesh[]) node.material = node.userData.id === ctx.markedTarget ? targetMat : contextMat;
    canvas.dataset.snapTarget = ctx.markedTarget ?? "";
    ctx.kick();
  }

  function clearSnapGuides() {
    for (const child of [...snapGroup.children]) {
      snapGroup.remove(child);
      (child as LineSegments2).geometry?.dispose();
    }
  }

  /** Guide lines and a marker for what the drag is snapped to, drawn in the amber the Prepare snap uses. */
  function showSnap(hit: SnapHit | null) {
    markTarget(hit?.targetId ?? ctx.alignMark);
    const label = hit?.label ?? null;
    if (label === ctx.snapLabel) return;
    ctx.snapLabel = label;
    clearSnapGuides();
    if (hit && ctx.snapRun) {
      const points: number[] = [];
      for (const g of hit.guides) points.push(...g.a, ...g.b);
      const reach = 7 / Math.max(Math.hypot(...ctx.snapRun.screen.x), Math.hypot(...ctx.snapRun.screen.y), 1e-6);
      for (const p of hit.points) {
        points.push(p[0] - reach, p[1], p[2], p[0] + reach, p[1], p[2]);
        points.push(p[0], p[1] - reach, p[2], p[0], p[1] + reach, p[2]);
      }
      const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(points), snapLineMat);
      lines.renderOrder = 7;
      lines.frustumCulled = false;
      lines.raycast = () => undefined;
      snapGroup.add(lines);
    }
    if (label) canvas.dataset.snap = label;
    else delete canvas.dataset.snap;
    ctx.kick();
  }
}
