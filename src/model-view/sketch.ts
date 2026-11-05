/** The sketch view: camera pose and lock, the drawn entities, and the workplane datum. */
import * as THREE from "three";
import { type CameraPose, mmPerPixel } from "../sketch/frame";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { SketchViewPointer } from "./types";
import type { Vec3 } from "../model-drag";
import { hexToThree } from "../theme";
import type { ViewCtx } from "./ctx";

export function installSketch(ctx: ViewCtx): void {
  const { camera, canvas, controls, datum, datumLines, fatLines, sketchGroup, sketchNormal } = ctx;
  ctx.addSketchDots = addSketchDots;
  ctx.addSketchQuad = addSketchQuad;
  ctx.applySketchLock = applySketchLock;
  ctx.applySketchPose = applySketchPose;
  ctx.clearSketchDraw = clearSketchDraw;
  ctx.currentSketchPose = currentSketchPose;
  ctx.drawDatum = drawDatum;
  ctx.holdSketchAxis = holdSketchAxis;
  ctx.placeSketchOffset = placeSketchOffset;
  ctx.rollSketch = rollSketch;
  ctx.sketchPointerEvent = sketchPointerEvent;
  ctx.sketchStrokeStyle = sketchStrokeStyle;

  /** What the datum's lines were drawn for: its size and the theme. */
  let datumDrawn = "";
  let sketchLastUp = { t: 0, x: 0, y: 0 };

  // --- S2 sketch camera and drawing ---
  function currentSketchPose(): CameraPose {
    return {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      up: [camera.up.x, camera.up.y, camera.up.z],
    };
  }

  function applySketchPose(pose: CameraPose) {
    camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
    camera.up.set(pose.up[0], pose.up[1], pose.up[2]);
    camera.lookAt(controls.target);
  }

  function applySketchLock(on: boolean) {
    ctx.sketchLock = on;
    if (on) {
      const offset = camera.position.clone().sub(controls.target);
      if (offset.lengthSq() > 1e-8) sketchNormal.copy(offset.normalize());
      controls.enableRotate = false;
      controls.enableZoom = false;
      controls.enablePan = true;
      controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
      controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      canvas.dataset.sketchCamera = "locked";
      return;
    }
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.enablePan = true;
    if (ctx.sketchSaved) {
      controls.mouseButtons.MIDDLE = ctx.sketchSaved.middle;
      controls.mouseButtons.RIGHT = ctx.sketchSaved.right;
    }
    canvas.dataset.sketchCamera = "free";
  }

  /** Keep the eye on the plane normal after a pan. The target may move; the eye follows along the normal. */
  function holdSketchAxis() {
    if (!ctx.sketchLock) return;
    const offset = camera.position.clone().sub(controls.target);
    const dist = offset.length();
    if (!(dist > 1)) return;
    const along = offset.dot(sketchNormal);
    const lateral = Math.sqrt(Math.max(0, dist * dist - along * along));
    if (lateral < 0.05) return;
    const sign = along >= 0 ? 1 : -1;
    camera.position.copy(controls.target).addScaledVector(sketchNormal, sign * dist);
    const up = camera.up.clone().addScaledVector(sketchNormal, -camera.up.dot(sketchNormal));
    if (up.lengthSq() > 1e-8) camera.up.copy(up.normalize());
  }

  function rollSketch(dx: number) {
    if (!ctx.sketchLock || !Number.isFinite(dx) || dx === 0) return;
    camera.up.applyAxisAngle(sketchNormal, -dx * 0.008);
    holdSketchAxis();
    ctx.kick();
  }

  /** Two pixels toward the camera, so a line on the solid does not fight the surface. */
  function placeSketchOffset() {
    if (!sketchGroup.visible) {
      sketchGroup.position.set(0, 0, 0);
      return;
    }
    const dist = Math.max(1, camera.position.distanceTo(controls.target));
    const mm = mmPerPixel(dist, camera.fov, Math.max(1, canvas.clientHeight));
    const toward = camera.position.clone().sub(controls.target);
    if (toward.lengthSq() < 1e-8) return;
    toward.normalize().multiplyScalar(2 * mm);
    sketchGroup.position.copy(toward);
  }

  function sketchPointerEvent(phase: SketchViewPointer["phase"], ev: PointerEvent): SketchViewPointer {
    let double = false;
    if (phase === "up") {
      const now = performance.now();
      double = now - sketchLastUp.t < 400 && (ev.clientX - sketchLastUp.x) ** 2 + (ev.clientY - sketchLastUp.y) ** 2 < 36;
      sketchLastUp = { t: now, x: ev.clientX, y: ev.clientY };
    }
    return {
      phase,
      x: ev.clientX,
      y: ev.clientY,
      button: ev.button,
      shift: ev.shiftKey,
      ctrl: ev.ctrlKey || ev.metaKey,
      alt: ev.altKey,
      meta: ev.metaKey,
      double,
    };
  }

  function clearSketchDraw() {
    for (const child of [...sketchGroup.children]) {
      sketchGroup.remove(child);
      const material = (child as THREE.Mesh).material;
      const list = Array.isArray(material) ? material : material ? [material] : [];
      for (const item of list) {
        const index = fatLines.indexOf(item as LineMaterial);
        if (index >= 0) fatLines.splice(index, 1);
      }
      ctx.disposeObject(child);
    }
  }

  function sketchStrokeStyle(role: string): { width: number; opacity: number; color: number } {
    if (role === "grid") return { width: 1, opacity: 0.35, color: 0x8a93a3 };
    if (role === "ref") return { width: 1, opacity: 0.55, color: hexToThree(ctx.colors.teal) };
    // U1: the edge Copy edge would copy, brighter and wider under the pointer.
    if (role === "refHot") return { width: 2.5, opacity: 1, color: hexToThree(ctx.colors.teal) };
    if (role === "selected") return { width: 2.5, opacity: 1, color: 0xffd166 };
    if (role === "construction") return { width: 1, opacity: 0.7, color: 0x8a93a3 };
    if (role === "rubber") return { width: 1.5, opacity: 0.95, color: ctx.accent };
    if (role === "hint") return { width: 1, opacity: 0.7, color: hexToThree(ctx.colors.teal) };
    // --- F2. The plane axes are dashed; a region that crosses the revolve axis is red. ---
    if (role === "axis") return { width: 1, opacity: 0.85, color: 0x8a93a3 };
    if (role === "refuse") return { width: 2.5, opacity: 1, color: hexToThree(ctx.colors.danger) };
    return { width: 2, opacity: 1, color: ctx.accent };
  }

  function addSketchDots(points: Vec3[], role: string) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(points.length * 3);
    points.forEach((at, index) => positions.set(at, index * 3));
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const selected = role === "selected" || role === "hover";
    const material = new THREE.PointsMaterial({
      color: role === "refuse" ? hexToThree(ctx.colors.danger) : role === "selected" ? 0xffd166 : role === "hover" ? 0xffffff : ctx.accent,
      // R2: a red mark is larger than a point, so an open end reads at a glance.
      size: role === "refuse" ? 12 : selected ? 8 : 6,
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    });
    const cloud = new THREE.Points(geometry, material);
    cloud.renderOrder = role === "refuse" ? 7 : 6;
    cloud.raycast = () => undefined;
    sketchGroup.add(cloud);
  }

  function addSketchQuad(corners: [Vec3, Vec3, Vec3, Vec3], hot: boolean) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(corners.flat(), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const material = new THREE.MeshBasicMaterial({
      color: hot ? hexToThree(ctx.colors.teal) : 0x9eb0c4,
      transparent: true,
      opacity: hot ? 0.28 : 0.1,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const quad = new THREE.Mesh(geometry, material);
    quad.raycast = () => undefined;
    quad.renderOrder = 1;
    sketchGroup.add(quad);
  }

  /**
   * The datum in its own U, V, W: a square in the UV plane, the solid's size, lifted a hair along W off the face it
   * sits on, faint where the solid hides it, and a U, V, W triad drawn over everything. It takes no picks, and is
   * drawn again only for a new size or theme: moving the frame moves its matrix.
   */
  function drawDatum() {
    const key = `${ctx.extent}|${ctx.colors.teal}|${ctx.colors.axisX}|${ctx.colors.axisY}|${ctx.colors.axisZ}`;
    if (!ctx.datumPlane || key === datumDrawn) return;
    datumDrawn = key;
    for (const child of [...datum.children]) {
      datum.remove(child);
      ctx.disposeObject(child);
    }
    datumLines.length = 0;
    const half = ctx.extent / 2;
    const lift = Math.min(0.35, ctx.extent * 0.01);
    const rim = [[-half, -half], [half, -half], [half, half], [-half, half]];
    const square = rim.flatMap(([u, v], i) => [u!, v!, lift, rim[(i + 1) % 4]![0]!, rim[(i + 1) % 4]![1]!, lift]);
    const arm = ctx.extent * 0.3;
    const line = (positions: number[], color: number, width: number, opacity: number, depthTest: boolean, order: number) => {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(positions);
      const material = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, depthTest, worldUnits: false });
      material.resolution.copy(ctx.lineResolution());
      datumLines.push(material);
      const lines = new LineSegments2(geometry, material);
      lines.renderOrder = order;
      lines.raycast = () => undefined;
      datum.add(lines);
    };
    const teal = hexToThree(ctx.colors.teal);
    line(square, teal, 1, 0.3, false, 1);
    line(square, teal, 1.5, 0.95, true, 2);
    line([0, 0, lift, arm, 0, lift], hexToThree(ctx.colors.axisX), 2.5, 1, false, 3);
    line([0, 0, lift, 0, arm, lift], hexToThree(ctx.colors.axisY), 2.5, 1, false, 3);
    line([0, 0, lift, 0, 0, lift + arm], hexToThree(ctx.colors.axisZ), 2.5, 1, false, 3);
  }
}
