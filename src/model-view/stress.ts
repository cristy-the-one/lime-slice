/** Stress colouring: the displaced mesh, the load arrow, and its markers. */
import * as THREE from "three";
import { STRESS_LOAD } from "./constants";
import type { StressDraw } from "./types";
import type { Vec3 } from "../model-drag";
import { displacedAt, segmentDistance } from "./helpers";
import type { ViewCtx } from "./ctx";

export function installStress(ctx: ViewCtx): void {
  const { body, camera, canvas, raycaster, solidMaterial, stressGroup, stressMaterial } = ctx;
  ctx.applyStress = applyStress;
  ctx.publishStressClip = publishStressClip;
  ctx.stressArrowHit = stressArrowHit;
  ctx.stressDragDir = stressDragDir;
  ctx.stressHitLocal = stressHitLocal;

  let stressMesh: THREE.Mesh | null = null;
  let stressArrow: THREE.ArrowHelper | null = null;
  let stressMarkers: THREE.Mesh[] = [];
  let stressMarkerGeo: THREE.BufferGeometry | null = null;
  let stressMarkerMat: THREE.Material | null = null;
  let stressRest: Float32Array | null = null;
  let stressDisp: Float32Array | null = null;
  let stressScale = 1;
  let stressArrowLength = 8;
  let stressArrowFixed = false;

  function clearStressMarkers() {
    for (const marker of stressMarkers) stressGroup.remove(marker);
    stressMarkers = [];
    stressMarkerGeo?.dispose();
    stressMarkerMat?.dispose();
    stressMarkerGeo = null;
    stressMarkerMat = null;
    delete canvas.dataset.stressHotspot;
  }

  function clearStressDraw() {
    if (stressMesh) {
      stressGroup.remove(stressMesh);
      stressMesh.geometry.dispose();
      stressMesh = null;
    }
    clearStressMarkers();
    if (stressArrow) {
      stressGroup.remove(stressArrow);
      stressArrow.traverse((child) => {
        const marker = child as THREE.Mesh;
        marker.geometry?.dispose();
      });
      stressArrow = null;
    }
    delete canvas.dataset.stressArrow;
    stressRest = null;
    stressDisp = null;
    ctx.stressHold = new Set();
    ctx.stressLoad = new Set();
    delete canvas.dataset.stress;
    delete canvas.dataset.stressHold;
    delete canvas.dataset.stressLoad;
    if (ctx.mesh && !ctx.preview) ctx.mesh.visible = true;
    canvas.dataset.stressSolid = "shown";
  }

  function publishStressClip() {
    if (!stressRest || stressRest.length < 3) {
      delete canvas.dataset.stress;
      return;
    }
    body.updateMatrixWorld(true);
    const point = new THREE.Vector3();
    let shown = 0;
    let hidden = 0;
    for (let i = 0; i < stressRest.length; i += 3) {
      point.set(
        stressRest[i]! + (stressDisp?.[i] ?? 0) * stressScale,
        stressRest[i + 1]! + (stressDisp?.[i + 1] ?? 0) * stressScale,
        stressRest[i + 2]! + (stressDisp?.[i + 2] ?? 0) * stressScale,
      );
      body.localToWorld(point);
      if (ctx.cutAway(point)) hidden += 1;
      else shown += 1;
    }
    canvas.dataset.stress = `shown ${shown} hidden ${hidden}`;
  }

  function applyStress(draw: StressDraw | null) {
    clearStressDraw();
    if (!draw) {
      ctx.paintFaces();
      ctx.kick();
      return;
    }
    stressScale = draw.scale;
    if (draw.positions.length >= 3 && draw.triangles.length >= 3) {
      stressRest = draw.positions;
      stressDisp = draw.displacement;
      const posedPos = new Float32Array(draw.positions.length);
      for (let i = 0; i < posedPos.length; i += 1) posedPos[i] = draw.positions[i]! + (draw.displacement[i] ?? 0) * draw.scale;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(posedPos, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(draw.colors, 3));
      geometry.setIndex(new THREE.BufferAttribute(draw.triangles, 1));
      geometry.computeVertexNormals();
      stressMesh = new THREE.Mesh(geometry, stressMaterial);
      stressMesh.renderOrder = 3;
      stressGroup.add(stressMesh);
      if (ctx.mesh) ctx.mesh.visible = false;
      canvas.dataset.stressSolid = "hidden";
    } else if (draw.faces) {
      ctx.stressHold = new Set(draw.faces.hold);
      ctx.stressLoad = new Set(draw.faces.load);
      if (ctx.stressHold.size > 0) canvas.dataset.stressHold = [...ctx.stressHold].join(" ");
      if (ctx.stressLoad.size > 0) canvas.dataset.stressLoad = [...ctx.stressLoad].join(" ");
    }
    ctx.paintFaces();
    const spots = draw.markers ?? [];
    if (spots.length > 0) {
      let span = 1;
      if (draw.positions.length >= 6) {
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < draw.positions.length; i += 3) {
          for (let axis = 0; axis < 3; axis += 1) {
            const value = draw.positions[i + axis] ?? 0;
            if (value < lo[axis]!) lo[axis] = value;
            if (value > hi[axis]!) hi[axis] = value;
          }
        }
        span = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
      }
      // A small white wire cage drawn over the part: it shows where the worst point is without hiding the
      // colour there, and it rides on the deformed shape when that is on.
      stressMarkerGeo = new THREE.SphereGeometry(Math.max(0.3, span * 0.012), 12, 8);
      stressMarkerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, depthTest: false, transparent: true, opacity: 0.95 });
      for (const at of spots) {
        const marker = new THREE.Mesh(stressMarkerGeo, stressMarkerMat);
        const moved = displacedAt(draw, at);
        marker.position.set(moved[0], moved[1], moved[2]);
        marker.renderOrder = 10;
        marker.name = "stress-hotspot";
        marker.raycast = () => undefined;
        stressGroup.add(marker);
        stressMarkers.push(marker);
      }
      canvas.dataset.stressHotspot = spots.map((at) => at.map((value) => value.toFixed(3)).join(",")).join(";");
    }
    if (draw.arrow) {
      const dir = new THREE.Vector3(...draw.arrow.dir);
      if (dir.lengthSq() < 1e-12) dir.set(0, 0, -1);
      dir.normalize();
      ctx.stressSeat.set(...draw.arrow.at);
      stressArrowLength = Math.max(1, draw.arrow.length);
      stressArrowFixed = draw.arrow.fixed === true;
      canvas.dataset.stressArrow = draw.arrow.at.map((value) => value.toFixed(2)).join(",");
      // The head touches the face it pushes on, so the shaft stays outside the part.
      const tail = ctx.stressSeat.clone().addScaledVector(dir, -stressArrowLength);
      stressArrow = new THREE.ArrowHelper(dir, tail, stressArrowLength, STRESS_LOAD);
      stressArrow.traverse((child) => {
        child.raycast = () => undefined;
      });
      stressGroup.add(stressArrow);
    }
    stressMaterial.clippingPlanes = solidMaterial.clippingPlanes ?? [];
    body.updateMatrixWorld(true);
    publishStressClip();
    ctx.kick();
  }

  function stressArrowHit(x: number, y: number): boolean {
    if (!stressArrow || stressArrowFixed) return false;
    const rect = canvas.getBoundingClientRect();
    const origin = stressArrow.position.clone();
    const tip = ctx.stressSeat.clone();
    body.localToWorld(origin);
    body.localToWorld(tip);
    const projectWorld = (point: THREE.Vector3) => {
      const p = point.clone().project(camera);
      return { x: rect.left + (p.x * 0.5 + 0.5) * rect.width, y: rect.top + (-p.y * 0.5 + 0.5) * rect.height, z: p.z };
    };
    const a = projectWorld(origin);
    const b = projectWorld(tip);
    if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) return false;
    return segmentDistance(x, y, a.x, a.y, b.x, b.y) <= 14;
  }

  function stressDragDir(x: number, y: number): Vec3 | null {
    const seat = ctx.stressSeat.clone();
    body.localToWorld(seat);
    const ray = ctx.rayAt(x, y);
    const camDir = camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, seat);
    const hit = new THREE.Vector3();
    if (!ray.intersectPlane(plane, hit)) return null;
    // The pointer holds the tail: the load points from it to the face.
    hit.subVectors(seat, hit);
    if (hit.lengthSq() < 1e-8) return null;
    hit.normalize();
    const local = hit.transformDirection(new THREE.Matrix4().copy(body.matrixWorld).invert());
    const n = local.length();
    if (!(n > 1e-8)) return null;
    return [local.x / n, local.y / n, local.z / n];
  }

  function stressHitLocal(x: number, y: number): Vec3 | null {
    if (!stressMesh) return null;
    ctx.rayAt(x, y);
    const hits = raycaster.intersectObject(stressMesh, false);
    const hit = hits.find((item) => !ctx.cutAway(item.point));
    if (!hit) return null;
    const local = stressMesh.worldToLocal(hit.point.clone());
    const pos = stressMesh.geometry.getAttribute("position");
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pos.count; i += 1) {
      const d = (pos.getX(i) - local.x) ** 2 + (pos.getY(i) - local.y) ** 2 + (pos.getZ(i) - local.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return [pos.getX(best), pos.getY(best), pos.getZ(best)];
  }
}
