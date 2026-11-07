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
}

export interface PoseView {
  setScene(scene: PoseScene): void;
  setBed(x: number, y: number, z: number): void;
  setTheme(): void;
  setCamera(preset: PoseCamera): void;
  /** Frame every part, from the front right and above, as Model frames its solid. */
  frameAll(): void;
  resize(): void;
  /** A click (not a drag) on a part, or on empty space (`null`). */
  onPick(cb: ((id: string | null) => void) | null): void;
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
  const edgeMaterial = new THREE.LineBasicMaterial({ color: IDLE_EDGE });

  const group = new THREE.Group();
  scene.add(group);
  /** One geometry and one outline per source array: a pose change rewrites matrices and uploads no vertex. */
  const held = new Map<Float32Array, { geometry: THREE.BufferGeometry; edges: THREE.EdgesGeometry }>();
  let box: Bounds | null = null;
  let framed = false;
  let pickCb: ((id: string | null) => void) | null = null;

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
    const published: string[] = [];
    const looks: string[] = [];
    let union: Bounds | null = null;
    for (const part of next.parts) {
      const entry = geometryOf(part.positions);
      const look = lookOf(part.id, next);
      const matrix = new THREE.Matrix4().set(...(affineRows(part.matrix) as [number, number, number, number, number, number, number, number, number, number, number, number]), 0, 0, 0, 1);
      const mesh = new THREE.Mesh(entry.geometry, materials[look]);
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
    box = union;
    // For a test: every part's box where it stands, and which parts are not in the plain look.
    if (published.length) canvas.dataset.posed = published.join(" ");
    else delete canvas.dataset.posed;
    canvas.dataset.looks = looks.join(" ");
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
    const id = pickAt(ev.clientX, ev.clientY);
    canvas.dataset.picked = id ?? "";
    pickCb?.(id);
  });

  function pickAt(clientX: number, clientY: number): string | null {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(group.children, false).find((row) => typeof row.object.userData.id === "string");
    return hit ? (hit.object.userData.id as string) : null;
  }

  function setTheme() {
    colors = themeColors();
    renderer.setClearColor(hexToThree(colors.stage), 1);
    bedRef.setColors(hexToThree(colors.bed), hexToThree(colors.bedMinor), hexToThree(colors.line), hexToThree(colors.teal));
    const paint = (material: THREE.MeshStandardMaterial, color: string) => {
      material.color.setHex(hexToThree(color));
      material.emissive.setHex(hexToThree(color));
    };
    paint(materials.part, colors.context);
    paint(materials.selected, colors.pose);
    paint(materials.chain, colors.poseChain);
    paint(materials.clash, colors.amber);
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
    onPick(cb) {
      pickCb = cb;
    },
  };
}
