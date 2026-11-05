/** Handle layout: screen boxes, the ghost's bounds, and the size and seat of each grip. */
import * as THREE from "three";
import { ARROW_HEAD, HANDLE_PX } from "./constants";
import { type DockSeat, HANDLE_KNOB_PICK, HANDLE_RING_RADIUS, dockSeat, gizmoRadiusForPixels } from "../gizmo-math";
import type { DragHandle } from "../model-drag";
import type { ModelSolid } from "./types";
import { faceTable } from "../interact/face-table";
import type { ViewCtx } from "./ctx";

export function installLayout(ctx: ViewCtx): void {
  const { INSIDE, body, camera, canvas, context, controls, dockAt, ghosts, scene } = ctx;
  ctx.ghostBounds = ghostBounds;
  ctx.gripPoint = gripPoint;
  ctx.sizeHandles = sizeHandles;

  /** The dock's seat for the canvas size it was worked out for: it changes only when the canvas does. */
  let seated: { width: number; height: number; seat: DockSeat } | null = null;
  /** The ghost's world box and face points. Rebuilt when the ghost is, and re-projected when only its pose changes. */
  let ghostCache: { serial: number; pose: number; centre: THREE.Vector3; min: THREE.Vector3; max: THREE.Vector3; faces: Map<string, THREE.Vector3> } | null = null;
  /** What `data-faces` was last written for, so a still view does not redo it. */
  let facesSolid: ModelSolid | null = null;

  /** Docked handles share one screen-fixed seat. A feature handle stays on the solid. */
  /** Where the grey context and the open solid land on screen, each as `x,y,w,h` canvas pixels, so a test can click or compare them. */
  function publishScreenBoxes(width: number, height: number) {
    const contextText = context.children.length > 0 ? screenRect(new THREE.Box3().setFromObject(context), width, height) : null;
    if (contextText === null) delete canvas.dataset.contextScreen;
    else if (canvas.dataset.contextScreen !== contextText) canvas.dataset.contextScreen = contextText;
    const solidText = ctx.solidBox ? screenRect(new THREE.Box3(new THREE.Vector3(...ctx.solidBox.min), new THREE.Vector3(...ctx.solidBox.max)), width, height) : null;
    if (solidText === null) delete canvas.dataset.solidScreen;
    else if (canvas.dataset.solidScreen !== solidText) canvas.dataset.solidScreen = solidText;
  }

  /**
   * P1. Each face's centre on the canvas and its outward normal in model space: `index:x,y:nx,ny,nz`.
   * The centres and normals are read once per solid; the text is redone only when the camera, the pose or the canvas changed.
   */
  function publishFaces(width: number, height: number) {
    if (!ctx.faceDrag || !ctx.solid) {
      ctx.facesKey = "";
      if (canvas.dataset.faces) delete canvas.dataset.faces;
      return;
    }
    body.updateMatrixWorld(true);
    const key = `${width},${height};${camera.matrixWorld.elements.join(",")};${camera.projectionMatrix.elements.join(",")};${body.matrixWorld.elements.join(",")}`;
    if (facesSolid === ctx.solid && key === ctx.facesKey) return;
    facesSolid = ctx.solid;
    ctx.facesKey = key;
    const parts: string[] = [];
    const world = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (const [face, row] of faceTable(ctx.solid.positions, ctx.solid.triangles)) {
      world.set(...row.centre);
      body.localToWorld(world);
      const p = world.project(camera);
      const x = Math.round((p.x * 0.5 + 0.5) * width);
      const y = Math.round((-p.y * 0.5 + 0.5) * height);
      normal.set(...(row.normal ?? [0, 0, 1])).transformDirection(body.matrixWorld);
      parts.push(`${face}:${x},${y}:${normal.x.toFixed(3)},${normal.y.toFixed(3)},${normal.z.toFixed(3)}`);
    }
    const text = parts.join(" ");
    if (canvas.dataset.faces !== text) canvas.dataset.faces = text;
  }

  function screenRect(box: THREE.Box3, width: number, height: number): string {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const p = new THREE.Vector3(x, y, z).project(camera);
          minX = Math.min(minX, (p.x * 0.5 + 0.5) * width);
          maxX = Math.max(maxX, (p.x * 0.5 + 0.5) * width);
          minY = Math.min(minY, (-p.y * 0.5 + 0.5) * height);
          maxY = Math.max(maxY, (-p.y * 0.5 + 0.5) * height);
        }
      }
    }
    return [minX, minY, maxX - minX, maxY - minY].map(Math.round).join(",");
  }

  function canvasPoint(point: THREE.Vector3, width: number, height: number): { x: number; y: number } {
    const mark = point.clone().project(camera);
    return { x: (mark.x * 0.5 + 0.5) * width, y: (-mark.y * 0.5 + 0.5) * height };
  }

  /** World box of the ghost. The walk runs once per ghost, not once per frame. */
  function ghostBounds(): { centre: THREE.Vector3; min: THREE.Vector3; max: THREE.Vector3 } | null {
    if (ghosts.children.length === 0) {
      ghostCache = null;
      return null;
    }
    if (ghostCache?.serial === ctx.ghostSerial && ghostCache.pose === ctx.ghostPose) return ghostCache;
    ghosts.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(ghosts);
    if (box.isEmpty()) {
      ghostCache = null;
      return null;
    }
    ghostCache = { serial: ctx.ghostSerial, pose: ctx.ghostPose, centre: box.getCenter(new THREE.Vector3()), min: box.min.clone(), max: box.max.clone(), faces: new Map() };
    return ghostCache;
  }

  /** The ghost's centre, its screen box, and a handle size that follows that box. */
  function readGhost(width: number, height: number): { centre: THREE.Vector3; span: number; hits: boolean; size: number; screen: string } | null {
    const box = ghostBounds();
    if (!box) return null;
    const centre = box.centre;
    const xs: number[] = [];
    const ys: number[] = [];
    const corner = new THREE.Vector3();
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const at = canvasPoint(corner.set(x, y, z), width, height);
          xs.push(at.x);
          ys.push(at.y);
        }
      }
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY);
    const px = Math.min(96, Math.max(28, span * 0.22));
    const size = gizmoRadiusForPixels(camera.position.distanceTo(centre), camera.fov, height, px, camera.zoom);
    const mid = canvasPoint(centre, width, height);
    return {
      centre,
      span,
      hits: mid.x >= 8 && mid.x <= width - 8 && mid.y >= 8 && mid.y <= height - 8,
      size,
      screen: [minX, minY, maxX - minX, maxY - minY].map((value) => Math.round(value)).join(","),
    };
  }

  /** The centre of the ghost's face that `dir` points at: the supporting plane through the centre. */
  function facePoint(centre: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 {
    const axis = dir.clone().normalize();
    const key = `${axis.x.toFixed(5)},${axis.y.toFixed(5)},${axis.z.toFixed(5)}`;
    const known = ghostCache?.faces.get(key);
    if (known) return known.clone();
    let half = 0;
    const vertex = new THREE.Vector3();
    ghosts.traverse((obj) => {
      const geometry = (obj as THREE.Mesh).geometry;
      const attr = geometry?.getAttribute?.("position");
      if (!attr) return;
      obj.updateWorldMatrix(true, false);
      for (let i = 0; i < attr.count; i += 1) {
        vertex.fromBufferAttribute(attr, i).applyMatrix4(obj.matrixWorld);
        half = Math.max(half, vertex.sub(centre).dot(axis));
      }
    });
    const at = centre.clone().addScaledVector(axis, Math.max(half, 0));
    ghostCache?.faces.set(key, at.clone());
    return at;
  }

  function sizeHandles() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    publishScreenBoxes(width, height);
    publishFaces(width, height);
    camera.updateMatrixWorld();
    const needsGhost = ctx.drawnHandles().some((part) => part.handle.seat.at === "ghost");
    const ghostNow = needsGhost ? readGhost(width, height) : null;
    const onGhost = ghostNow != null && ghostNow.hits && ghostNow.span >= 24;
    if (ghostNow) canvas.dataset.ghostScreen = ghostNow.screen;
    else delete canvas.dataset.ghostScreen;
    const wantsDock = ctx.handleParts.some((part) => {
      const seat = part.handle.seat;
      return seat.at === "dock" || (seat.at === "ghost" && !onGhost);
    });
    let dockSize = 0;
    if (wantsDock) {
      if (seated?.width !== width || seated.height !== height) seated = { width, height, seat: dockSeat(width, height, camera.fov, HANDLE_PX) };
      const { ndcX, ndcY, handlePx } = seated.seat;
      dockAt.set(ndcX, ndcY, controls.target.clone().project(camera).z).unproject(camera);
      dockSize = gizmoRadiusForPixels(camera.position.distanceTo(dockAt), camera.fov, height, handlePx, camera.zoom);
      const mark = canvasPoint(dockAt, width, height);
      const text = `${Math.round(mark.x)},${Math.round(mark.y)}`;
      if (canvas.dataset.gizmoAt !== text) canvas.dataset.gizmoAt = text;
      if (canvas.dataset.dockPx !== String(handlePx)) canvas.dataset.dockPx = String(handlePx);
    } else {
      delete canvas.dataset.gizmoAt;
      delete canvas.dataset.dockPx;
    }
    const grips: string[] = [];
    const seats: string[] = [];
    for (const part of ctx.drawnHandles()) {
      const seat = part.handle.seat;
      const dir = new THREE.Vector3(...part.handle.dir).normalize();
      let size = dockSize;
      if (seat.at === "ghost" && onGhost && ghostNow) {
        const at = seat.role === "face" ? facePoint(ghostNow.centre, dir) : ghostNow.centre.clone();
        if (seat.role === "face") at.addScaledVector(dir, HANDLE_KNOB_PICK * ghostNow.size);
        part.root.position.copy(at);
        size = ghostNow.size;
      } else if (seat.at === "feature") {
        part.root.position.set(...seat.origin);
        size = gizmoRadiusForPixels(camera.position.distanceTo(part.root.position), camera.fov, height, HANDLE_PX, camera.zoom);
      } else {
        const reach = seat.at === "dock" ? seat.reach : seat.fallback;
        part.root.position.copy(dockAt).addScaledVector(dir, reach * dockSize);
      }
      part.root.scale.setScalar(size);
      const seatAt = canvasPoint(part.root.position, width, height);
      seats.push(`${part.handle.id}:${Math.round(seatAt.x)},${Math.round(seatAt.y)}`);
      const at = gripPoint(part.handle, part.root.position, size).project(camera);
      grips.push(`${part.handle.id}:${Math.round((at.x * 0.5 + 0.5) * width)},${Math.round((-at.y * 0.5 + 0.5) * height)}`);
    }
    const seatText = seats.join(" ");
    if (canvas.dataset.handleSeat !== seatText) canvas.dataset.handleSeat = seatText;
    const text = grips.join(" ");
    if (canvas.dataset.handles !== text) canvas.dataset.handles = text;
    if (ctx.aspectNow) {
      ctx.placeAspectLabel();
      // The sample is for a still view. Raycasting the solid on every drag frame dominates the frame.
      if (!ctx.drag) ctx.publishAspectSample();
    } else if (canvas.dataset.aspectSample) delete canvas.dataset.aspectSample;
    // --- A10. The section arrow, sized like a handle, drawn in model space.
    if (ctx.sectionPlaneWorld) {
      if (!ctx.sectionArrow) {
        ctx.sectionArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, INSIDE);
        ctx.sectionArrow.raycast = () => undefined;
        scene.add(ctx.sectionArrow);
      }
      ctx.sectionArrowLength = gizmoRadiusForPixels(camera.position.distanceTo(ctx.sectionPlaneWorld.origin), camera.fov, height, HANDLE_PX, camera.zoom);
      ctx.sectionArrow.position.copy(ctx.sectionPlaneWorld.origin);
      ctx.sectionArrow.setDirection(ctx.sectionPlaneWorld.normal);
      ctx.sectionArrow.setLength(ctx.sectionArrowLength, ctx.sectionArrowLength * 0.28, ctx.sectionArrowLength * 0.16);
      ctx.sectionArrow.visible = true;
      const head = ctx.sectionPlaneWorld.origin.clone().addScaledVector(ctx.sectionPlaneWorld.normal, ctx.sectionArrowLength * 0.85);
      const at = head.clone().project(camera);
      const handle = `${Math.round((at.x * 0.5 + 0.5) * width)} ${Math.round((-at.y * 0.5 + 0.5) * height)}`;
      if (canvas.dataset.sectionHandle !== handle) canvas.dataset.sectionHandle = handle;
    } else if (ctx.sectionArrow) {
      ctx.sectionArrow.visible = false;
      delete canvas.dataset.sectionHandle;
    }
  }

  /** Where a pointer grabs a handle: an arrow's head, a ring's rim, or a knob or dot itself. */
  function gripPoint(handle: DragHandle, at: THREE.Vector3, size: number): THREE.Vector3 {
    const origin = at.clone();
    const dir = new THREE.Vector3(...handle.dir).normalize();
    if (handle.look === "arrow") return origin.addScaledVector(dir, ARROW_HEAD * size);
    if (handle.look !== "ring") return origin;
    const toCamera = camera.position.clone().sub(origin);
    let rim = toCamera.sub(dir.clone().multiplyScalar(toCamera.dot(dir)));
    if (rim.lengthSq() < 1e-9) rim = Math.abs(dir.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(dir) : new THREE.Vector3(1, 0, 0).cross(dir);
    const side = rim.normalize().cross(dir);
    // Arrows point to +X, +Y and +Z, so the rim's grip is on the other side of the ring from them.
    if (side.x + side.y + side.z > 0) side.negate();
    return origin.addScaledVector(side, HANDLE_RING_RADIUS * size);
  }
}
