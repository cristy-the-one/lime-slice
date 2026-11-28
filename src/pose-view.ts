/**
 * The Pose stage's viewport (`docs/plan-pose.md`, section 4). Every object stands at its assembled pose, drawn the way
 * Model draws its open solid: one shaded, opaque material with outline edges. Unlike Model's grey context, no part here
 * turns transparent unless it is glass (`PlateObject.glass`): a glass part is drawn see-through, faint and cool, with its
 * outline kept, so a design of many parts stays readable. The selected part is drawn in the pose colour, the rest
 * of its chain in the quieter chain colour, and parts that cross in amber, as the Assembly view tints them.
 *
 * The view draws and picks. It changes nothing: what a click selects is the app's call (`src/app/pose.ts`).
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { ContextPart } from "./model-context";
import { affineRows } from "./model-context";
import { posedBounds } from "./model-space";
import { sharpEdges } from "./mesh-edges";
import type { Bounds } from "./mesh-place";
import { hexToThree, themeColors, type ThemeColors } from "./theme";
import { mountBedReference, mountStudioLights, mountViewHelper, renderViewHelper, viewHelperHit } from "./viewport-chrome";
import { orbitGlide } from "./orbit-glide";
import { IDLE_EDGE } from "./model-view/constants";
import { lookOf, type PoseLook, type PoseLooks } from "./pose-look";
import { grabDegrees } from "./viewport-grab";
import { isCreased, isShaded, onShading, plateGeometry, shadeGeometry } from "./plate-shading-carry";
import type { Screen } from "./place-snap";
import { hoverDrawer, mountHover } from "./hover";

export type PoseCamera = "top" | "front" | "iso";

export interface PoseScene extends PoseLooks {
  parts: ContextPart[];
  /** Parts of glass: drawn see-through, after the opaque ones, and still picked. */
  glass?: ReadonlySet<string>;
  /** Per-part colours for animation frames; no selection tint while playing. */
  colors?: ReadonlyMap<string, string>;
  /** An animation's background, #rrggbb. It replaces the stage colour and hides the bed, so the colour is the whole backdrop. */
  background?: string;
  gizmo?: { pivot: [number, number, number]; axes: [number, number, number][]; radius: number; slide?: boolean };
  marks?: { pivot: [number, number, number]; axis?: [number, number, number] }[];
}

export type ReachEvent =
  | { phase: "start"; object: string; point: [number, number, number] }
  | { phase: "change"; target: [number, number, number] }
  | { phase: "end" }
  | { phase: "cancel" };

export type TurnEvent = { phase: "start"; axis: number } | { phase: "end"; axis: number } | { phase: "change"; axis: number; delta: number };

export type MoveAxis = "x" | "y" | "z";

/** A Move drag. The view reports it; Pose decides the pose. */
export type MoveEvent =
  | { phase: "start"; kind: "move" | "turn"; object: string }
  | { phase: "change"; kind: "move"; delta: [number, number, number]; shift: boolean; alt: boolean; screen: Screen }
  | { phase: "change"; kind: "turn"; axis: MoveAxis; degrees: number; shift: boolean }
  | { phase: "end" }
  | { phase: "cancel" };

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
  setMove(on: boolean): void;
  onMove(cb: ((event: MoveEvent) => void) | null): void;
  cancelMove(): void;
}

/** Edges sharper than this crease are outlined. Model's ghost outlines a mesh tool at the same angle. */
const EDGE_ANGLE_DEG = 30;
/** A press that moves less than this is a click, not an orbit. */
const CLICK_PX = 4;
/** Frames drawn with nothing changing before the loop stops, as Model's frame loop does. */
const STILL_FRAMES = 3;
/** A glass part's opacity, and the cool tint laid over its own colour. */
const GLASS_OPACITY = 0.28;
const GLASS_TINT = 0xa8d8ff;
const GLASS_TINT_MIX = 0.3;

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
  /** A part's look as glass: its colour toward a cool tint, see-through, and no depth written so what is behind shows. */
  const paintGlass = (material: THREE.MeshStandardMaterial, color: string) => {
    material.color.setHex(hexToThree(color)).lerp(new THREE.Color(GLASS_TINT), GLASS_TINT_MIX);
    material.emissive.copy(material.color);
  };
  const glassOf = (color: string, emissive = 0) => {
    const material = solid(color, emissive);
    paintGlass(material, color);
    material.transparent = true;
    material.opacity = GLASS_OPACITY;
    material.depthWrite = false;
    return material;
  };
  const glassMaterials: Record<PoseLook, THREE.MeshStandardMaterial> = {
    part: glassOf(colors.context),
    selected: glassOf(colors.pose, 0.12),
    chain: glassOf(colors.poseChain, 0.06),
    clash: glassOf(colors.amber, 0.25),
  };
  const animationMaterials = new Map<string, THREE.MeshStandardMaterial>();
  const animationGlass = new Map<string, THREE.MeshStandardMaterial>();
  const edgeMaterial = new THREE.LineBasicMaterial({ color: IDLE_EDGE });

  const group = new THREE.Group();
  scene.add(group);
  /** One geometry and one outline per source array: a pose change rewrites matrices and uploads no vertex. */
  const held = new Map<Float32Array, { geometry: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();
  let box: Bounds | null = null;
  let framed = false;
  /** The meshes of the scene last shown: a scene that shares none of them is another plate, and is framed anew. */
  let shown = new Set<Float32Array>();
  let pickCb: ((id: string | null, hit?: PoseHit) => void) | null = null;
  let turnCb: ((event: TurnEvent) => void) | null = null;
  let reachCb: ((event: ReachEvent) => boolean | void) | null = null;
  let reachEnabled = false;
  let moveCb: ((event: MoveEvent) => void) | null = null;
  let moveEnabled = false;
  let sceneParts: ContextPart[] = [];
  let sceneSelected: string | null = null;
  const gizmos = new THREE.Group();
  const marks = new THREE.Group();
  scene.add(gizmos, marks);
  const markLine = new THREE.LineBasicMaterial({ color: hexToThree(colors.pose), depthTest: false });
  const markBall = new THREE.MeshBasicMaterial({ color: hexToThree(colors.pose), depthTest: false });
  const markSphere = new THREE.SphereGeometry(1.5, 10, 8);
  const ringMaterial = new THREE.MeshBasicMaterial({ color: hexToThree(colors.pose), transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide });
  // The slide arrow uses its own material so a hover can light it without recolouring a hinge's ring.
  const slideMaterial = new THREE.MeshBasicMaterial({ color: hexToThree(colors.pose), transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide });
  const slidePickMaterial = new THREE.MeshBasicMaterial({ visible: false, depthTest: false, side: THREE.DoubleSide });
  let slideHot = false;
  /** The same hot colour a ring takes when the pointer is on it: white, and fully opaque. */
  function paintSlide(hot: boolean): void {
    const color = hexToThree(hot ? colors.gizmoHot : colors.pose);
    if (slideHot === hot && slideMaterial.color.getHex() === color && slideMaterial.opacity === (hot ? 1 : 0.85)) return;
    slideHot = hot;
    slideMaterial.color.setHex(color);
    slideMaterial.opacity = hot ? 1 : 0.85;
    if (!reachEnabled) canvas.style.cursor = hot ? "grab" : "";
    kick();
  }
  let ringGeometry: THREE.TorusGeometry | null = null;
  let arrowGeometries: THREE.BufferGeometry[] = [];

  function geometryOf(positions: Float32Array) {
    let entry = held.get(positions);
    if (!entry) {
      // The exact corner normals when the part has them (src/plate-shading.ts), else creased ones from its own triangles.
      const geometry = plateGeometry(positions);
      geometry.computeBoundingSphere();
      // The segments `EdgesGeometry` draws, in its order, from integer tables in place of its string keys: about
      // a fifth of the time on a part of a few hundred thousand triangles, which every part pays on entering Pose.
      const edges = new THREE.BufferGeometry();
      edges.setAttribute("position", new THREE.BufferAttribute(sharpEdges(positions, EDGE_ANGLE_DEG), 3));
      entry = { geometry, edges };
      held.set(positions, entry);
    }
    return entry;
  }

  // A part's exact normals can come after it is drawn (a project just opened): its geometry takes them in place.
  onShading(() => {
    let changed = false;
    for (const [positions, entry] of held) if (!isShaded(entry.geometry) && shadeGeometry(entry.geometry, positions)) changed = true;
    if (changed) publishShading();
  });

  /** For the tests: how many of the parts drawn (a duplicate counts apart) are shaded with their exact normals, and how many from their own triangles. */
  function publishShading() {
    let shaded = 0;
    let creasedParts = 0;
    for (const node of group.children) {
      if (!(node instanceof THREE.Mesh)) continue;
      const geometry = node.geometry as THREE.BufferGeometry;
      if (isShaded(geometry)) shaded += 1;
      else if (isCreased(geometry)) creasedParts += 1;
    }
    canvas.dataset.plateShaded = String(shaded);
    canvas.dataset.plateCreased = String(creasedParts);
  }

  function setScene(next: PoseScene) {
    const wanted = new Set(next.parts.map((part) => part.positions));
    // Another file was opened: the camera still looks at where the last one stood, and a small part is out of view.
    if (framed && shown.size > 0 && wanted.size > 0 && ![...wanted].some((positions) => shown.has(positions))) framed = false;
    shown = wanted;
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
    for (const [color, material] of animationGlass) if (!colorsInFrame.has(color)) { material.dispose(); animationGlass.delete(color); }
    const glassIds: string[] = [];
    const published: string[] = [];
    const looks: string[] = [];
    let union: Bounds | null = null;
    let selectedBox: Bounds | null = null;
    for (const part of next.parts) {
      const entry = geometryOf(part.positions);
      const look = lookOf(part.id, next);
      const matrix = new THREE.Matrix4().set(...(affineRows(part.matrix) as [number, number, number, number, number, number, number, number, number, number, number, number]), 0, 0, 0, 1);
      const color = next.colors?.get(part.id);
      const glass = next.glass?.has(part.id) === true;
      let material = glass ? glassMaterials[look] : materials[look];
      if (color) {
        const held = glass ? animationGlass : animationMaterials;
        let custom = held.get(color);
        if (!custom) { custom = glass ? glassOf(color) : solid(color); held.set(color, custom); }
        material = custom;
      }
      const mesh = new THREE.Mesh(entry.geometry, material);
      // Transparent parts draw after the opaque ones (three sorts them so); the order here puts them after each other too.
      if (glass) { mesh.renderOrder = 2; glassIds.push(part.id); }
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
      if (part.id === next.selectedId && one) selectedBox = one;
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
    for (const geometry of arrowGeometries) geometry.dispose();
    arrowGeometries = [];
    if (next.gizmo) {
      const { pivot, axes, radius } = next.gizmo;
      const at = new THREE.Vector3(...pivot);
      if (next.gizmo.slide) {
        const dir = new THREE.Vector3(...axes[0]!).normalize();
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        const back = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
        // The part's centre, dropped onto the slide axis. A projection that misses the part keeps the pivot.
        const centre = selectedBox
          ? new THREE.Vector3((selectedBox.min[0] + selectedBox.max[0]) / 2, (selectedBox.min[1] + selectedBox.max[1]) / 2, (selectedBox.min[2] + selectedBox.max[2]) / 2)
          : at.clone();
        const projected = at.clone().add(dir.clone().multiplyScalar(dir.dot(centre.clone().sub(at))));
        const onPart = !!selectedBox && projected.x >= selectedBox.min[0] - 1e-4 && projected.x <= selectedBox.max[0] + 1e-4
          && projected.y >= selectedBox.min[1] - 1e-4 && projected.y <= selectedBox.max[1] + 1e-4
          && projected.z >= selectedBox.min[2] - 1e-4 && projected.z <= selectedBox.max[2] + 1e-4;
        const origin = onPart ? projected : at.clone();
        let minAlong = 0, maxAlong = 0;
        if (selectedBox) {
          minAlong = Infinity; maxAlong = -Infinity;
          for (const x of [selectedBox.min[0], selectedBox.max[0]]) for (const y of [selectedBox.min[1], selectedBox.max[1]]) for (const z of [selectedBox.min[2], selectedBox.max[2]]) {
            const along = dir.dot(new THREE.Vector3(x, y, z).sub(origin));
            minAlong = Math.min(minAlong, along); maxAlong = Math.max(maxAlong, along);
          }
        }
        const span = Math.max(maxAlong - minAlong, radius);
        // Past the box by at least 20% of its extent on each side, so both heads clear the part.
        const half = Math.max(Math.abs(minAlong), Math.abs(maxAlong)) + span * 0.2;
        const shaftR = Math.max(1.8, span * 0.07);
        const headR = shaftR * 2.8;
        const headLen = Math.min(half * 0.34, Math.max(span * 0.18, headR * 1.4));
        const shaftLen = Math.max(half - headLen, half * 0.4) * 2;
        const shaftGeo = new THREE.CylinderGeometry(shaftR, shaftR, shaftLen, 12);
        const headGeo = new THREE.ConeGeometry(headR, headLen, 16);
        const pickGeo = new THREE.CylinderGeometry(headR * 1.35, headR * 1.35, half * 2, 10);
        arrowGeometries.push(shaftGeo, headGeo, pickGeo);
        const tip = origin.clone().add(dir.clone().multiplyScalar(half - headLen * 0.35));
        const place = (mesh: THREE.Mesh, along: number, turn: THREE.Quaternion) => {
          mesh.quaternion.copy(turn);
          mesh.position.copy(origin).add(dir.clone().multiplyScalar(along));
          mesh.userData.axis = 0;
          mesh.userData.direction = dir;
          mesh.userData.slide = true;
          mesh.userData.pivot = at;
          mesh.userData.tip = tip;
          mesh.renderOrder = 10;
          mesh.frustumCulled = false;
          gizmos.add(mesh);
        };
        place(new THREE.Mesh(shaftGeo, slideMaterial), 0, quat);
        place(new THREE.Mesh(headGeo, slideMaterial), half - headLen / 2, quat);
        place(new THREE.Mesh(headGeo, slideMaterial), -(half - headLen / 2), back);
        place(new THREE.Mesh(pickGeo, slidePickMaterial), 0, quat);
      } else {
        ringGeometry = new THREE.TorusGeometry(radius, Math.max(0.45, radius * 0.035), 8, 96);
        axes.forEach((axis, index) => {
          const ring = new THREE.Mesh(ringGeometry!, ringMaterial);
          ring.position.copy(at);
          ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...axis).normalize());
          ring.userData.axis = index;
          ring.userData.direction = new THREE.Vector3(...axis).normalize();
          ring.renderOrder = 10;
          gizmos.add(ring);
        });
      }
      gizmos.updateMatrixWorld(true);
    }
    box = union;
    // For a test: every part's box where it stands, and which parts are not in the plain look.
    if (published.length) canvas.dataset.posed = published.join(" ");
    else delete canvas.dataset.posed;
    canvas.dataset.looks = looks.join(" ");
    publishShading();
    sceneParts = next.parts;
    if (next.colors?.size) canvas.dataset.animationColors = [...next.colors].map(([id, color]) => `${id}:${color}`).join(" ");
    else delete canvas.dataset.animationColors;
    canvas.dataset.opaque = String(glassIds.length === 0 && Object.values(materials).every((material) => !material.transparent && material.opacity === 1 && material.depthWrite));
    if (glassIds.length) canvas.dataset.glass = glassIds.join(" ");
    else delete canvas.dataset.glass;
    sceneSelected = next.selectedId;
    if (next.selectedId) canvas.dataset.selected = next.selectedId;
    else delete canvas.dataset.selected;
    hover.refresh();
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
    placeCamera(look, from, dist);
  }

  /** The camera `dist` mm from `at`, toward `from`, looking at `at`. A test uses it to click a face the whole-press frame draws thinner than a pixel. */
  function placeCamera(at: THREE.Vector3, from: THREE.Vector3, dist: number) {
    camera.near = Math.max(0.01, dist / 200);
    camera.far = dist * 20;
    controls.enableDamping = false;
    controls.update();
    camera.up.set(0, 0, 1);
    camera.position.copy(at).add(from.clone().normalize().multiplyScalar(dist));
    controls.target.copy(at);
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
      outline.paint(renderer, camera);
      // For a test: where the camera stands, to a tenth of a millimetre, so a select can be shown to leave it alone.
      const eye = camera.position, look = controls.target;
      const where = `${[eye.x, eye.y, eye.z].map((value) => value.toFixed(1)).join(",")};${[look.x, look.y, look.z].map((value) => value.toFixed(1)).join(",")}`;
      if (canvas.dataset.camera !== where) canvas.dataset.camera = where;
      if (moveEnabled && sceneParts.length) {
        const rect = canvas.getBoundingClientRect();
        const project = (point: THREE.Vector3) => {
          const v = point.clone().project(camera);
          return [(v.x * 0.5 + 0.5) * rect.width, (0.5 - v.y * 0.5) * rect.height] as const;
        };
        canvas.dataset.screen = sceneParts.map((part) => {
          const bounds = posedBounds(part.positions, part.matrix);
          if (!bounds) return "";
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
            const [sx, sy] = project(new THREE.Vector3(x, y, z));
            x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
          }
          return `${part.id}:${x0.toFixed(1)},${y0.toFixed(1)},${(x1 - x0).toFixed(1)},${(y1 - y0).toFixed(1)}`;
        }).filter(Boolean).join(" ");
      } else delete canvas.dataset.screen;
      if (reachEnabled) {
        const rect = canvas.getBoundingClientRect();
        canvas.dataset.reachPoints = group.children.filter((part) => part instanceof THREE.Mesh && typeof part.userData.id === "string").map((part) => {
          const mesh = part as THREE.Mesh;
          const point = mesh.geometry.boundingSphere!.center.clone().applyMatrix4(mesh.matrixWorld).project(camera);
          return `${mesh.userData.id}:${(rect.left + (point.x + 1) * rect.width / 2).toFixed(1)},${(rect.top + (1 - point.y) * rect.height / 2).toFixed(1)}`;
        }).join(" ");
      } else delete canvas.dataset.reachPoints;
      // A test names a direction (`x,y,z`) so a flat face that faces away from Front can be clicked.
      const lookFrom = canvas.dataset.lookFrom;
      if (lookFrom && box) {
        const [x, y, z] = lookFrom.split(",").map(Number);
        if (x !== undefined && y !== undefined && z !== undefined && [x, y, z].every(Number.isFinite) && Math.hypot(x, y, z) > 1e-6) {
          delete canvas.dataset.lookFrom;
          const from = new THREE.Vector3(x, y, z);
          const lookLocal = canvas.dataset.lookLocal;
          const lookDist = Number(canvas.dataset.lookDist);
          const split = lookLocal?.indexOf(":") ?? -1;
          const [lx, ly, lz] = split >= 0 ? lookLocal!.slice(split + 1).split(",").map(Number) : [];
          const mesh = split >= 0 ? group.children.find((part) => part instanceof THREE.Mesh && part.userData.id === lookLocal!.slice(0, split)) : undefined;
          if (mesh && lx !== undefined && ly !== undefined && lz !== undefined && [lx, ly, lz].every(Number.isFinite) && lookDist > 1) {
            placeCamera(new THREE.Vector3(lx, ly, lz).applyMatrix4(mesh.matrixWorld), from, lookDist);
          } else aim(box, from);
          canvas.dataset.cameraFrom = `${x},${y},${z}`;
        }
      }
      // lookAt refreshes the world matrix and then changes the quaternion, so a projection in this same frame
      // would use the camera from before the aim and publish the ring off the canvas. Publish where it stands now.
      camera.updateMatrixWorld(true);
      // A test names a part-local point (`id:x,y,z`). Project it with this camera so a click can land on a known hole.
      const projectSpec = canvas.dataset.projectLocal;
      if (projectSpec) {
        const rect = canvas.getBoundingClientRect();
        const meshes = new Map(group.children.filter((part) => part instanceof THREE.Mesh && typeof part.userData.id === "string").map((part) => [(part as THREE.Mesh).userData.id as string, part as THREE.Mesh]));
        const projected: string[] = [];
        for (const item of projectSpec.split(" ")) {
          const split = item.indexOf(":");
          if (split < 0) continue;
          const id = item.slice(0, split);
          const [x, y, z] = item.slice(split + 1).split(",").map(Number);
          const mesh = meshes.get(id);
          if (!mesh || x === undefined || y === undefined || z === undefined || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
          const point = new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld).project(camera);
          projected.push(`${id}:${(rect.left + (point.x + 1) * rect.width / 2).toFixed(1)},${(rect.top + (1 - point.y) * rect.height / 2).toFixed(1)}`);
        }
        canvas.dataset.projected = projected.join(" ");
      } else delete canvas.dataset.projected;
      if (gizmos.children.length) {
        const rect = canvas.getBoundingClientRect();
        const radius = ringGeometry?.parameters.radius ?? 0;
        const origin = (gizmos.children[0]!.userData.pivot as THREE.Vector3 | undefined)?.clone() ?? gizmos.children[0]!.position.clone();
        const centre = origin.project(camera);
        canvas.dataset.turnCenter = `${(rect.left + (centre.x + 1) * rect.width / 2).toFixed(1)},${(rect.top + (1 - centre.y) * rect.height / 2).toFixed(1)}`;
        const handles = new Map<number, string>();
        for (const ring of gizmos.children) {
          const axis = ring.userData.axis as number;
          if (handles.has(axis)) continue;
          const tip = ring.userData.tip as THREE.Vector3 | undefined;
          const at = (tip ? tip.clone() : ring.localToWorld(new THREE.Vector3(radius, 0, 0))).project(camera);
          handles.set(axis, `${axis}:${(rect.left + (at.x + 1) * rect.width / 2).toFixed(1)},${(rect.top + (1 - at.y) * rect.height / 2).toFixed(1)}`);
        }
        canvas.dataset.turnHandles = [...handles.values()].join(" ");
        canvas.dataset.turnKind = gizmos.children.some((ring) => ring.userData.slide) ? "slide" : "ring";
      } else { delete canvas.dataset.turnHandles; delete canvas.dataset.turnCenter; delete canvas.dataset.turnKind; }
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
  // A test sets data-look-from after the view has settled. The loop has already stopped, so wake it.
  new MutationObserver(() => { if (canvas.dataset.lookFrom || canvas.dataset.projectLocal) kick(); }).observe(canvas, { attributes: true, attributeFilter: ["data-look-from", "data-project-local"] });
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
    outline.resize();
    if (!framed && box && rect.width > 0) {
      framed = true;
      frameAll();
    }
    kick();
  }

  // Move: a drag on a part translates it on a horizontal plane; a right-drag turns it. A short press still picks.
  type MovePending = { pointer: number; x: number; y: number; button: number; object: string; point: THREE.Vector3; axis: MoveAxis };
  let movePending: MovePending | null = null;
  let moveDrag: { pointer: number; kind: "move" | "turn"; object: string; point: THREE.Vector3; plane: THREE.Plane; axis: MoveAxis; x0: number } | null = null;
  const screenBasis = (at: THREE.Vector3): Screen => {
    const rect = canvas.getBoundingClientRect();
    const project = (point: THREE.Vector3) => {
      const v = point.clone().project(camera);
      return [(v.x * 0.5 + 0.5) * rect.width, (0.5 - v.y * 0.5) * rect.height] as [number, number];
    };
    const origin = project(at);
    const along = (x: number, y: number, z: number): [number, number] => {
      const point = project(at.clone().add(new THREE.Vector3(x, y, z)));
      return [point[0] - origin[0], point[1] - origin[1]];
    };
    return { x: along(1, 0, 0), y: along(0, 1, 0), z: along(0, 0, 1) };
  };
  function finishMove(cancel: boolean): void {
    const pending = movePending;
    const active = moveDrag;
    movePending = null;
    moveDrag = null;
    controls.enabled = true;
    const pointer = active?.pointer ?? pending?.pointer;
    if (pointer !== undefined && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    if (active) moveCb?.({ phase: cancel ? "cancel" : "end" });
    else if (pending && pending.button === 0 && !cancel) {
      canvas.dataset.picked = pending.object;
      pickCb?.(pending.object);
    }
  }
  canvas.addEventListener("pointerdown", (ev) => {
    if (!moveEnabled || moveDrag || movePending || (ev.button !== 0 && ev.button !== 2)) return;
    if (viewHelperHit(viewHelper, canvas, ev)) return;
    rayAt(ev.clientX, ev.clientY);
    const hit = raycaster.intersectObjects(group.children, false).find((row) => typeof row.object.userData.id === "string");
    if (!hit) return;
    movePending = { pointer: ev.pointerId, x: ev.clientX, y: ev.clientY, button: ev.button, object: hit.object.userData.id as string, point: hit.point.clone(), axis: "z" };
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
  canvas.addEventListener("pointermove", (ev) => {
    if (movePending && movePending.pointer === ev.pointerId && Math.hypot(ev.clientX - movePending.x, ev.clientY - movePending.y) > CLICK_PX) {
      const pending = movePending;
      movePending = null;
      const kind = pending.button === 2 ? "turn" : "move";
      moveDrag = { pointer: pending.pointer, kind, object: pending.object, point: pending.point, plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -pending.point.z), axis: pending.axis, x0: pending.x };
      moveCb?.({ phase: "start", kind, object: pending.object });
    }
    if (!moveDrag || moveDrag.pointer !== ev.pointerId) return;
    if (moveDrag.kind === "turn") moveCb?.({ phase: "change", kind: "turn", axis: moveDrag.axis, degrees: grabDegrees(ev.clientX - moveDrag.x0), shift: ev.shiftKey });
    else {
      rayAt(ev.clientX, ev.clientY);
      const point = raycaster.ray.intersectPlane(moveDrag.plane, new THREE.Vector3());
      if (point) {
        moveCb?.({
          phase: "change",
          kind: "move",
          delta: [point.x - moveDrag.point.x, point.y - moveDrag.point.y, point.z - moveDrag.point.z],
          shift: ev.shiftKey,
          alt: ev.altKey,
          screen: screenBasis(moveDrag.point),
        });
      }
    }
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
  const endMovePointer = (ev: PointerEvent) => {
    if (moveDrag?.pointer === ev.pointerId || movePending?.pointer === ev.pointerId) {
      finishMove(false);
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  };
  canvas.addEventListener("pointerup", endMovePointer, true);
  canvas.addEventListener("pointercancel", (ev) => {
    if (moveDrag?.pointer === ev.pointerId || movePending?.pointer === ev.pointerId) finishMove(true);
  }, true);
  canvas.addEventListener("contextmenu", (ev) => { if (moveEnabled) ev.preventDefault(); });
  window.addEventListener("keydown", (ev) => {
    if (!moveDrag && !movePending) return;
    if (ev.key === "Escape") {
      finishMove(true);
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    const axis = ev.key.toLowerCase();
    if (axis !== "x" && axis !== "y" && axis !== "z") return;
    if (movePending) movePending.axis = axis;
    if (moveDrag?.kind === "turn") moveDrag.axis = axis;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);

  // A click picks; a drag orbits. The press position tells them apart.
  const raycaster = new THREE.Raycaster();
  let press: { x: number; y: number; id: number } | null = null;
  let turnDrag: { pointer: number; axis: number; normal: THREE.Vector3; pivot: THREE.Vector3; from: THREE.Vector3; previous: number; total: number; emitted: number; slide?: boolean; axisDir?: THREE.Vector3; startAlong?: number } | null = null;
  /** A plane that contains `axis` and faces the camera, so a drag along the arrow reads as millimetres. */
  const slidePlane = (axis: THREE.Vector3): THREE.Vector3 => {
    const view = camera.getWorldDirection(new THREE.Vector3());
    let side = new THREE.Vector3().crossVectors(axis, view);
    if (side.lengthSq() < 1e-8) {
      side = new THREE.Vector3().crossVectors(axis, camera.up);
      if (side.lengthSq() < 1e-8) side = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(1, 0, 0));
    }
    return new THREE.Vector3().crossVectors(axis, side).normalize();
  };
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
    const direction = (ring.userData.direction as THREE.Vector3).clone();
    const pivot = ring.userData.slide ? (ring.userData.pivot as THREE.Vector3).clone() : ring.position.clone();
    if (ring.userData.slide) {
      const normal = slidePlane(direction);
      const point = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pivot), new THREE.Vector3());
      if (!point) return;
      turnDrag = { pointer: ev.pointerId, axis: ring.userData.axis as number, normal, pivot, from: new THREE.Vector3(), previous: 0, total: 0, emitted: 0, slide: true, axisDir: direction, startAlong: point.sub(pivot).dot(direction) };
    } else {
      const point = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(direction, pivot), new THREE.Vector3());
      if (!point || point.distanceToSquared(pivot) < 1e-12) return;
      turnDrag = { pointer: ev.pointerId, axis: ring.userData.axis as number, normal: direction, pivot, from: point.sub(pivot).normalize(), previous: 0, total: 0, emitted: 0 };
    }
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    if (turnDrag.slide) paintSlide(true);
    canvas.dataset.turnActive = String(turnDrag.axis);
    turnCb({ phase: "start", axis: turnDrag.axis });
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
  canvas.addEventListener("pointermove", (ev) => {
    if (!turnDrag || turnDrag.pointer !== ev.pointerId) return;
    rayAt(ev.clientX, ev.clientY);
    if (turnDrag.slide && turnDrag.axisDir && turnDrag.startAlong !== undefined) {
      const point = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(turnDrag.normal, turnDrag.pivot), new THREE.Vector3());
      if (point) {
        const delta = point.sub(turnDrag.pivot).dot(turnDrag.axisDir) - turnDrag.startAlong;
        if (Math.abs(delta - turnDrag.emitted) > 1e-8) { turnDrag.emitted = delta; turnCb?.({ phase: "change", axis: turnDrag.axis, delta }); }
      }
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
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
    const wasSlide = !!turnDrag.slide;
    turnDrag = null;
    delete canvas.dataset.turnActive;
    controls.enabled = true;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    if (wasSlide) {
      rayAt(ev.clientX, ev.clientY);
      paintSlide(!!raycaster.intersectObjects(gizmos.children, false)[0]?.object.userData.slide);
    }
    turnCb?.({ phase: "end", axis });
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  canvas.addEventListener("pointerup", endTurn, true);
  canvas.addEventListener("pointercancel", endTurn, true);
  canvas.addEventListener("pointermove", (ev) => {
    if (turnDrag || !gizmos.children.some((child) => child.userData.slide)) {
      if (!turnDrag && slideHot) paintSlide(false);
      return;
    }
    rayAt(ev.clientX, ev.clientY);
    paintSlide(!!raycaster.intersectObjects(gizmos.children, false)[0]?.object.userData.slide);
  });
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

  /** The part under the pointer that a click would select, but for the selected one: its outline is drawn over everything. */
  const outline = hoverDrawer(scene, canvas, () => colors.hover, kick);
  const hover = mountHover({
    canvas,
    pick(x, y) {
      rayAt(x, y);
      const hit = raycaster.intersectObjects(group.children, false).find((row) => typeof row.object.userData.id === "string");
      const id = hit ? (hit.object.userData.id as string) : null;
      if (!hit || id === null || id === sceneSelected) return null;
      const part = sceneParts.find((row) => row.id === id);
      return part ? { id, positions: part.positions, matrixWorld: hit.object.matrixWorld } : null;
    },
    draw: outline.draw,
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
    paintGlass(glassMaterials.part, colors.context);
    paintGlass(glassMaterials.selected, colors.pose);
    paintGlass(glassMaterials.chain, colors.poseChain);
    paintGlass(glassMaterials.clash, colors.amber);
    outline.recolor();
    ringMaterial.color.setHex(hexToThree(colors.pose));
    slideMaterial.color.setHex(hexToThree(slideHot ? colors.gizmoHot : colors.pose));
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
    setMove(on) {
      moveEnabled = on;
      if (!on) {
        finishMove(true);
        delete canvas.dataset.snap;
        delete canvas.dataset.snapTarget;
      } else {
        canvas.dataset.snap = "";
        canvas.dataset.snapTarget = "";
      }
      kick();
    },
    onMove(cb) { moveCb = cb; },
    cancelMove() { finishMove(true); },
  };
}
