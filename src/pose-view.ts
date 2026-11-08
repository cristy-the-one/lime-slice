/**
 * The Pose stage's viewport (`docs/plan-pose.md`, section 4). Every object stands at its assembled pose, drawn the way
 * Model draws its open solid: one shaded, opaque material with outline edges. Unlike Model's grey context, no part here
 * turns transparent, so a design of many parts stays readable. The selected part is drawn in the pose colour, the rest
 * of its chain in the quieter chain colour, and parts that cross in amber, as the Assembly view tints them.
 *
 * The view draws and picks. It changes nothing: what a click selects is the app's call (`src/app/pose.ts`).
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { ContextPart } from "./model-context";
import { affineRows } from "./model-context";
import { posedBounds } from "./model-space";
import type { Bounds } from "./mesh-place";
import { hexToThree, themeColors, type ThemeColors } from "./theme";
import { mountBedReference, mountStudioLights, mountViewHelper, renderViewHelper, viewHelperHit } from "./viewport-chrome";
import { orbitGlide } from "./orbit-glide";
import { IDLE_EDGE } from "./model-view/constants";
import { lookOf, type PoseLook, type PoseLooks } from "./pose-look";

export type PoseCamera = "top" | "front" | "iso";

export interface PoseScene extends PoseLooks {
  parts: ContextPart[];
  /** Per-part colours for animation frames; no selection tint while playing. */
  colors?: ReadonlyMap<string, string>;
  /** An animation's background, #rrggbb. It replaces the stage colour and hides the bed, so the colour is the whole backdrop. */
  background?: string;
  gizmo?: { pivot: [number, number, number]; axes: [number, number, number][]; radius: number };
  marks?: { pivot: [number, number, number]; axis?: [number, number, number] }[];
}

export type ReachEvent =
  | { phase: "start"; object: string; point: [number, number, number] }
  | { phase: "change"; target: [number, number, number] }
  | { phase: "end" }
  | { phase: "cancel" };

export type TurnEvent = { phase: "start"; axis: number } | { phase: "end"; axis: number } | { phase: "change"; axis: number; delta: number };

export interface PoseHit { point: [number, number, number]; ray: { origin: [number, number, number]; direction: [number, number, number] }; shift: boolean; triangle: [number, number, number][] }

export interface PoseView {
  setScene(scene: PoseScene): void;
  setBed(x: number, y: number, z: number): void;
  setTheme(): void;
  setCamera(preset: PoseCamera): void;
  /** Frame every part, from the front right and above, as Model frames its solid. */
  frameAll(): void;
  resize(): void;
  /** Off-screen renderer with a camera fixed for the whole export. */
  beginCapture(size: number, preset?: { bounds: Bounds; direction: [number, number, number]; up?: [number, number, number] }): { frame(png?: boolean): Promise<{ png?: Uint8Array; rgb: Uint8Array }>; dispose(): void };
  /** A click (not a drag) on a part, or on empty space (`null`). */
  onPick(cb: ((id: string | null, hit?: PoseHit) => void) | null): void;
  onTurn(cb: ((event: TurnEvent) => void) | null): void;
  setReach(on: boolean): void;
  onReach(cb: ((event: ReachEvent) => boolean | void) | null): void;
  cancelReach(): void;
}

/** Edges sharper than this crease are outlined. Model's ghost outlines a mesh tool at the same angle. */
const EDGE_ANGLE_DEG = 30;
/** A press that moves less than this is a click, not an orbit. */
const CLICK_PX = 4;
/** Frames drawn with nothing changing before the loop stops, as Model's frame loop does. */
const STILL_FRAMES = 3;

export function createPoseView(canvas: HTMLCanvasElement): PoseView {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.touches.ONE = THREE.TOUCH.ROTATE;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
  const glide = orbitGlide(controls, camera);
  mountStudioLights(scene, "z-up");
  const viewHelper = mountViewHelper(camera, canvas);
  const bedRef = mountBedReference(scene, "z-up");
  let colors: ThemeColors = themeColors();
  let background: string | null = null;
  const clearColor = () => hexToThree(background ?? colors.stage);

  // Model's solid look (src/model-view/mesh.ts), opaque and depth-written, one material per look.
  const solid = (color: string, emissive = 0) =>
    new THREE.MeshStandardMaterial({
      color: hexToThree(color),
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      emissive: hexToThree(color),
      emissiveIntensity: emissive,
    });
  const materials: Record<PoseLook, THREE.MeshStandardMaterial> = {
    part: solid(colors.context),
    selected: solid(colors.pose, 0.12),
    chain: solid(colors.poseChain, 0.06),
    clash: solid(colors.amber, 0.25),
  };
  const animationMaterials = new Map<string, THREE.MeshStandardMaterial>();
  const edgeMaterial = new THREE.LineBasicMaterial({ color: IDLE_EDGE });

  const group = new THREE.Group();
  scene.add(group);
  /** One geometry and one outline per source array: a pose change rewrites matrices and uploads no vertex. */
  const held = new Map<Float32Array, { geometry: THREE.BufferGeometry; edges: THREE.EdgesGeometry }>();
  let box: Bounds | null = null;
  let framed = false;
  let pickCb: ((id: string | null, hit?: PoseHit) => void) | null = null;
  let turnCb: ((event: TurnEvent) => void) | null = null;
  let reachCb: ((event: ReachEvent) => boolean | void) | null = null;
  let reachEnabled = false;
  const gizmos = new THREE.Group();
  const marks = new THREE.Group();
  scene.add(gizmos, marks);
  const markLine = new THREE.LineBasicMaterial({ color: hexToThree(colors.pose), depthTest: false });
  const markBall = new THREE.MeshBasicMaterial({ color: hexToThree(colors.pose), depthTest: false });
  const markSphere = new THREE.SphereGeometry(1.5, 10, 8);
  const ringMaterial = new THREE.MeshBasicMaterial({ color: hexToThree(colors.pose), transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide });
  let ringGeometry: THREE.TorusGeometry | null = null;

  function geometryOf(positions: Float32Array) {
    let entry = held.get(positions);
    if (!entry) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      entry = { geometry, edges: new THREE.EdgesGeometry(geometry, EDGE_ANGLE_DEG) };
      held.set(positions, entry);
    }
    return entry;
  }

  function setScene(next: PoseScene) {
    const wanted = new Set(next.parts.map((part) => part.positions));
    for (const [positions, entry] of held) {
      if (wanted.has(positions)) continue;
      entry.geometry.dispose();
      entry.edges.dispose();
      held.delete(positions);
    }
    group.clear();
    background = next.background ?? null;
    renderer.setClearColor(clearColor(), 1);
    bedRef.setVisible(!background);
    if (background) canvas.dataset.animationBackground = background;
    else delete canvas.dataset.animationBackground;
    const colorsInFrame = new Set(next.colors?.values() ?? []);
    for (const [color, material] of animationMaterials) if (!colorsInFrame.has(color)) { material.dispose(); animationMaterials.delete(color); }
    const published: string[] = [];
    const looks: string[] = [];
    let union: Bounds | null = null;
    for (const part of next.parts) {
      const entry = geometryOf(part.positions);
      const look = lookOf(part.id, next);
      const matrix = new THREE.Matrix4().set(...(affineRows(part.matrix) as [number, number, number, number, number, number, number, number, number, number, number, number]), 0, 0, 0, 1);
      const color = next.colors?.get(part.id);
      let material = materials[look];
      if (color) {
        let custom = animationMaterials.get(color);
        if (!custom) { custom = solid(color); animationMaterials.set(color, custom); }
        material = custom;
      }
      const mesh = new THREE.Mesh(entry.geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      mesh.userData.id = part.id;
      const lines = new THREE.LineSegments(entry.edges, edgeMaterial);
      lines.matrixAutoUpdate = false;
      lines.matrix.copy(matrix);
      lines.raycast = () => undefined;
      group.add(mesh, lines);
      const one = posedBounds(part.positions, part.matrix);
      if (one) {
        published.push(`${part.id}:${[...one.min, ...one.max].map((value) => value.toFixed(2)).join(",")}`);
        union = union
          ? { min: [Math.min(union.min[0], one.min[0]), Math.min(union.min[1], one.min[1]), Math.min(union.min[2], one.min[2])], max: [Math.max(union.max[0], one.max[0]), Math.max(union.max[1], one.max[1]), Math.max(union.max[2], one.max[2])] }
          : one;
      }
      if (look !== "part") looks.push(`${part.id}:${look}`);
    }
    group.updateMatrixWorld(true);
    for (const mark of marks.children) if (mark instanceof THREE.Line) mark.geometry.dispose();
    marks.clear();
    for (const mark of next.marks ?? []) {
      const pivot = new THREE.Vector3(...mark.pivot);
      if (mark.axis) {
        const axis = new THREE.Vector3(...mark.axis).normalize().multiplyScalar(6);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([pivot.clone().sub(axis), pivot.clone().add(axis)]), markLine);
        line.renderOrder = 11; marks.add(line);
      } else {
        const dot = new THREE.Mesh(markSphere, markBall); dot.position.copy(pivot); dot.renderOrder = 11; marks.add(dot);
      }
    }
    gizmos.clear();
    ringGeometry?.dispose();
    ringGeometry = null;
    if (next.gizmo) {
      const { pivot, axes, radius } = next.gizmo;
      ringGeometry = new THREE.TorusGeometry(radius, Math.max(0.45, radius * 0.035), 8, 96);
      axes.forEach((axis, index) => {
        const ring = new THREE.Mesh(ringGeometry!, ringMaterial);
        ring.position.set(...pivot);
        ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...axis).normalize());
        ring.userData.axis = index;
        ring.userData.direction = new THREE.Vector3(...axis).normalize();
        ring.renderOrder = 10;
        gizmos.add(ring);
      });
      gizmos.updateMatrixWorld(true);
    }
    box = union;
    // For a test: every part's box where it stands, and which parts are not in the plain look.
    if (published.length) canvas.dataset.posed = published.join(" ");
    else delete canvas.dataset.posed;
    canvas.dataset.looks = looks.join(" ");
    if (next.colors?.size) canvas.dataset.animationColors = [...next.colors].map(([id, color]) => `${id}:${color}`).join(" ");
    else delete canvas.dataset.animationColors;
    canvas.dataset.opaque = String(Object.values(materials).every((material) => !material.transparent && material.opacity === 1 && material.depthWrite));
    if (next.selectedId) canvas.dataset.selected = next.selectedId;
    else delete canvas.dataset.selected;
    if (!framed && box && canvas.clientWidth > 0) {
      framed = true;
      frameAll();
    }
    kick();
  }

  function frameAll() {
    if (!box) return;
    aim(box, new THREE.Vector3(1, -1.15, 0.72));
  }

  function setCamera(preset: PoseCamera) {
    if (!box) return;
    const offset = preset === "top" ? new THREE.Vector3(0, -0.04, 1) : preset === "front" ? new THREE.Vector3(0, -1, 0.08) : new THREE.Vector3(1, -1.15, 0.72);
    aim(box, offset);
    canvas.dataset.cameraPreset = preset;
  }

  /** Model's framing: the box's centre, the box filling the view, seen along `from`. */
  function aim(target: Bounds, from: THREE.Vector3) {
    const look = new THREE.Vector3((target.min[0] + target.max[0]) / 2, (target.min[1] + target.max[1]) / 2, (target.min[2] + target.max[2]) / 2);
    const size = Math.max(target.max[0] - target.min[0], target.max[1] - target.min[1], target.max[2] - target.min[2], 1);
    const radius = (size * Math.sqrt(3)) / 2;
    const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.35;
    camera.near = Math.max(0.01, dist / 200);
    camera.far = dist * 20;
    controls.enableDamping = false;
    controls.update();
    camera.up.set(0, 0, 1);
    camera.position.copy(look).add(from.clone().normalize().multiplyScalar(dist));
    controls.target.copy(look);
    camera.updateProjectionMatrix();
    controls.update();
    controls.enableDamping = true;
    kick();
  }

  let running = false;
  let still = 0;
  function kick() {
    still = 0;
    if (running) return;
    running = true;
    let last = performance.now();
    const loop = () => {
      if (canvas.closest("[hidden]") != null) {
        running = false;
        return;
      }
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (viewHelper.animating) {
        controls.enabled = false;
        viewHelper.update(dt);
        if (!viewHelper.animating) controls.enabled = true;
      }
      const moved = glide(now);
      viewHelper.center.copy(controls.target);
      renderer.render(scene, camera);
      if (reachEnabled) {
        const rect = canvas.getBoundingClientRect();
        canvas.dataset.reachPoints = group.children.filter((part) => part instanceof THREE.Mesh && typeof part.userData.id === "string").map((part) => {
          const mesh = part as THREE.Mesh;
          const point = mesh.geometry.boundingSphere!.center.clone().applyMatrix4(mesh.matrixWorld).project(camera);
          return `${mesh.userData.id}:${(rect.left + (point.x + 1) * rect.width / 2).toFixed(1)},${(rect.top + (1 - point.y) * rect.height / 2).toFixed(1)}`;
        }).join(" ");
      } else delete canvas.dataset.reachPoints;
      if (gizmos.children.length && ringGeometry) {
        const rect = canvas.getBoundingClientRect();
        const radius = ringGeometry.parameters.radius;
        const centre = gizmos.children[0]!.position.clone().project(camera);
        canvas.dataset.turnCenter = `${(rect.left + (centre.x + 1) * rect.width / 2).toFixed(1)},${(rect.top + (1 - centre.y) * rect.height / 2).toFixed(1)}`;
        canvas.dataset.turnHandles = gizmos.children.map((ring) => {
          const at = ring.localToWorld(new THREE.Vector3(radius, 0, 0)).project(camera);
          return `${ring.userData.axis}:${(rect.left + (at.x + 1) * rect.width / 2).toFixed(1)},${(rect.top + (1 - at.y) * rect.height / 2).toFixed(1)}`;
        }).join(" ");
      } else { delete canvas.dataset.turnHandles; delete canvas.dataset.turnCenter; }
      renderViewHelper(renderer, viewHelper);
      still = moved || viewHelper.animating ? 0 : still + 1;
      if (still > STILL_FRAMES) {
        running = false;
        return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  controls.addEventListener("change", kick);
  controls.addEventListener("start", kick);
  new ResizeObserver(() => resize()).observe(canvas);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(width, height, false);
    if (!framed && box && rect.width > 0) {
      framed = true;
      frameAll();
    }
    kick();
  }

  // A click picks; a drag orbits. The press position tells them apart.
  const raycaster = new THREE.Raycaster();
  let press: { x: number; y: number; id: number } | null = null;
  let turnDrag: { pointer: number; axis: number; normal: THREE.Vector3; pivot: THREE.Vector3; from: THREE.Vector3; previous: number; total: number; emitted: number } | null = null;
  const rayAt = (x: number, y: number) => {
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), camera);
  };
  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !turnCb || !gizmos.children.length) return;
    rayAt(ev.clientX, ev.clientY);
    const hit = raycaster.intersectObjects(gizmos.children, false)[0];
    if (!hit) return;
    const ring = hit.object;
    const normal = (ring.userData.direction as THREE.Vector3).clone();
    const pivot = ring.position.clone();
    const point = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pivot), new THREE.Vector3());
    if (!point || point.distanceToSquared(pivot) < 1e-12) return;
    turnDrag = { pointer: ev.pointerId, axis: ring.userData.axis as number, normal, pivot, from: point.sub(pivot).normalize(), previous: 0, total: 0, emitted: 0 };
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    turnCb({ phase: "start", axis: turnDrag.axis });
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
  canvas.addEventListener("pointermove", (ev) => {
    if (!turnDrag || turnDrag.pointer !== ev.pointerId) return;
    rayAt(ev.clientX, ev.clientY);
    const point = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(turnDrag.normal, turnDrag.pivot), new THREE.Vector3());
    if (point && point.distanceToSquared(turnDrag.pivot) > 1e-12) {
      const to = point.sub(turnDrag.pivot).normalize();
      const raw = Math.atan2(turnDrag.normal.dot(new THREE.Vector3().crossVectors(turnDrag.from, to)), turnDrag.from.dot(to)) * 180 / Math.PI;
      let step = raw - turnDrag.previous;
      if (step > 180) step -= 360;
      if (step < -180) step += 360;
      turnDrag.previous = raw;
      turnDrag.total += step;
      const target = ev.shiftKey ? Math.round(turnDrag.total / 5) * 5 : turnDrag.total;
      if (Math.abs(target - turnDrag.emitted) > 1e-8) { turnDrag.emitted = target; turnCb?.({ phase: "change", axis: turnDrag.axis, delta: target }); }
    }
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
  const endTurn = (ev: PointerEvent) => {
    if (!turnDrag || turnDrag.pointer !== ev.pointerId) return;
    const axis = turnDrag.axis;
    turnDrag = null;
    controls.enabled = true;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    turnCb?.({ phase: "end", axis });
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  canvas.addEventListener("pointerup", endTurn, true);
  canvas.addEventListener("pointercancel", endTurn, true);
  let reachDrag: { pointer: number; plane: THREE.Plane } | null = null;
  canvas.addEventListener("pointerdown", (ev) => {
    if (!reachEnabled || ev.button !== 0 || !reachCb) return;
    rayAt(ev.clientX, ev.clientY);
    const hit = raycaster.intersectObjects(group.children, false).find((row) => typeof row.object.userData.id === "string");
    if (!hit) return;
    const point = hit.point.clone();
    const accepted = reachCb({ phase: "start", object: hit.object.userData.id as string, point: point.toArray() as [number, number, number] });
    if (accepted === false) return;
    const normal = camera.getWorldDirection(new THREE.Vector3());
    reachDrag = { pointer: ev.pointerId, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point) };
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault(); ev.stopImmediatePropagation();
  }, true);
  canvas.addEventListener("pointermove", (ev) => {
    if (!reachDrag || reachDrag.pointer !== ev.pointerId) return;
    rayAt(ev.clientX, ev.clientY);
    const point = raycaster.ray.intersectPlane(reachDrag.plane, new THREE.Vector3());
    if (point) reachCb?.({ phase: "change", target: point.toArray() as [number, number, number] });
    ev.preventDefault(); ev.stopImmediatePropagation();
  }, true);
  function finishReach(cancel: boolean): void {
    if (!reachDrag) return;
    const pointer = reachDrag.pointer;
    reachDrag = null;
    controls.enabled = true;
    if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    reachCb?.({ phase: cancel ? "cancel" : "end" });
  }
  canvas.addEventListener("pointerup", (ev) => {
    if (!reachDrag || reachDrag.pointer !== ev.pointerId) return;
    finishReach(false); ev.preventDefault(); ev.stopImmediatePropagation();
  }, true);
  canvas.addEventListener("pointercancel", (ev) => {
    if (!reachDrag || reachDrag.pointer !== ev.pointerId) return;
    finishReach(true); ev.preventDefault(); ev.stopImmediatePropagation();
  }, true);
  canvas.addEventListener("pointerdown", (ev) => {
    if (viewHelperHit(viewHelper, canvas, ev)) {
      kick();
      return;
    }
    press = ev.button === 0 ? { x: ev.clientX, y: ev.clientY, id: ev.pointerId } : null;
  });
  canvas.addEventListener("pointerup", (ev) => {
    const start = press;
    press = null;
    if (!start || start.id !== ev.pointerId || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > CLICK_PX) return;
    rayAt(ev.clientX, ev.clientY);
    const hit = raycaster.intersectObjects(group.children, false).find((row) => typeof row.object.userData.id === "string");
    const id = hit ? hit.object.userData.id as string : null;
    canvas.dataset.picked = id ?? "";
    const attr = hit?.object instanceof THREE.Mesh ? hit.object.geometry.getAttribute("position") : null;
    const triangle: [number, number, number][] = [];
    if (hit && attr && hit.face) for (const index of [hit.face.a, hit.face.b, hit.face.c]) {
      const point = hit.object.localToWorld(new THREE.Vector3().fromBufferAttribute(attr, index));
      triangle.push(point.toArray() as [number, number, number]);
    }
    pickCb?.(id, hit ? { point: hit.point.toArray() as [number, number, number], ray: { origin: raycaster.ray.origin.toArray() as [number, number, number], direction: raycaster.ray.direction.toArray() as [number, number, number] }, shift: ev.shiftKey, triangle } : undefined);
  });

  function setTheme() {
    colors = themeColors();
    renderer.setClearColor(clearColor(), 1);
    bedRef.setColors(hexToThree(colors.bed), hexToThree(colors.bedMinor), hexToThree(colors.line), hexToThree(colors.teal));
    const paint = (material: THREE.MeshStandardMaterial, color: string) => {
      material.color.setHex(hexToThree(color));
      material.emissive.setHex(hexToThree(color));
    };
    paint(materials.part, colors.context);
    paint(materials.selected, colors.pose);
    paint(materials.chain, colors.poseChain);
    paint(materials.clash, colors.amber);
    ringMaterial.color.setHex(hexToThree(colors.pose));
    markLine.color.setHex(hexToThree(colors.pose));
    markBall.color.setHex(hexToThree(colors.pose));
    canvas.dataset.poseColor = colors.pose;
    kick();
  }
  setTheme();

  return {
    setScene,
    setBed(x, y, z) {
      bedRef.setSize(x, y, z);
      kick();
    },
    setTheme,
    setCamera,
    frameAll,
    resize,
    beginCapture(size, preset) {
      const offscreen = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      offscreen.setPixelRatio(1); offscreen.setSize(size, size, false);
      offscreen.outputColorSpace = renderer.outputColorSpace;
      offscreen.toneMapping = renderer.toneMapping;
      const fixedCamera = camera.clone(); fixedCamera.aspect = 1; fixedCamera.updateProjectionMatrix();
      if (preset) {
        const direction = new THREE.Vector3(...preset.direction);
        if (direction.lengthSq() < 1e-12) { offscreen.dispose(); throw new Error("The animation camera needs a nonzero direction."); }
        const up = new THREE.Vector3(...(preset.up ?? [0, 0, 1])).normalize();
        if (up.lengthSq() < 1e-12 || Math.abs(up.dot(direction.clone().normalize())) > 0.999) { offscreen.dispose(); throw new Error("The animation camera up must not point along its direction."); }
        const min = new THREE.Vector3(...preset.bounds.min), max = new THREE.Vector3(...preset.bounds.max);
        const centre = min.clone().add(max).multiplyScalar(0.5);
        const radius = Math.max(1, max.clone().sub(min).length() / 2);
        fixedCamera.up.copy(up);
        const distance = radius / Math.sin(THREE.MathUtils.degToRad(fixedCamera.fov / 2)) * 1.1;
        fixedCamera.position.copy(centre).add(direction.normalize().multiplyScalar(distance));
        fixedCamera.near = Math.max(0.01, distance - radius * 1.5); fixedCamera.far = distance + radius * 1.5 + 10;
        fixedCamera.lookAt(centre); fixedCamera.updateProjectionMatrix(); fixedCamera.updateMatrixWorld();
      }
      const pixels = document.createElement("canvas"); pixels.width = size; pixels.height = size;
      const context = pixels.getContext("2d", { willReadFrequently: true });
      if (!context) { offscreen.dispose(); throw new Error("Could not create an animation canvas."); }
      return {
        async frame(png = true) {
          offscreen.setClearColor(clearColor(), 1);
          offscreen.render(scene, fixedCamera);
          context.drawImage(offscreen.domElement, 0, 0);
          const rgba = context.getImageData(0, 0, size, size).data, rgb = new Uint8Array(size * size * 3);
          for (let i = 0; i < size * size; i++) { rgb[i * 3] = rgba[i * 4]!; rgb[i * 3 + 1] = rgba[i * 4 + 1]!; rgb[i * 3 + 2] = rgba[i * 4 + 2]!; }
          if (!png) return { rgb };
          const blob = await new Promise<Blob | null>((resolve) => pixels.toBlob(resolve, "image/png"));
          if (!blob) throw new Error("Could not encode an animation frame.");
          return { png: new Uint8Array(await blob.arrayBuffer()), rgb };
        },
        dispose() { offscreen.dispose(); offscreen.forceContextLoss(); },
      };
    },
    onPick(cb) {
      pickCb = cb;
    },
    onTurn(cb) {
      turnCb = cb;
    },
    setReach(on) { reachEnabled = on; canvas.style.cursor = on ? "crosshair" : ""; kick(); },
    onReach(cb) { reachCb = cb; },
    cancelReach() { finishReach(true); },
  };
}
