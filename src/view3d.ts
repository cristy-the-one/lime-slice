import * as THREE from "three";
import { syncBedGrid } from "./bed-grid";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { featureColor, SPEED_RAMP, SPEED_RANGE_MM_S, WEIGHT_RAMP, type ColorMode } from "./colors";
import { buildCutPlane, disposeTree, previewFrame, splitDragAt } from "./cut-plane";
import { GIZMO_SCREEN_PX, gizmoRadiusForPixels, parkLeftCameraSpace, snapStep } from "./gizmo-math";
import { clampSplit, roundSplit, type AxisBounds } from "./split-at";
import { fillHiddenKindMask, INNER_HALF_SCALE, KIND_SHIFT, MARGIN_SHADE, MAX_KINDS, meshCenter, scenePoint, STYLE_WORDS, WEIGHT_STEPS, type PointRun, type PreviewChunk, type PreviewGeometry } from "./preview-geom";
import { aimSection, anchor, clampOffset, normalize, sectionReach, threeClip, type SectionSpec, type Vec3 } from "./section-plane";
import { hexToThree, themeColors, type ThemeColors } from "./theme";
import { poseAffine, type PlacedPart } from "./mesh-place";
import type { CoverageGap } from "./support-edits";
import { replyFrameRay, sceneShift } from "./bed-offset";
import type { Ray } from "./support-pick";

export interface PreviewBuffers extends PreviewGeometry {
  span: number;
  midZ: number;
  centerX: number;
  centerY: number;
  /** The camera reframes when this changes, and otherwise stays where the user left it. */
  frame: string;
}

export interface SupportOverlay {
  /** Capsules from `capsulesOf`, print space. */
  hover: Float32Array | null;
  selected: Float32Array | null;
  gaps: readonly CoverageGap[];
  /** Hovered or selected gap, drawn brighter. */
  hotGap: number | null;
  /** Layer slab, print z. The overlay clips to it. */
  zLow: number;
  zHigh: number;
}

export interface PickEvent {
  kind: "move" | "click" | "leave";
  ray: Ray;
  shiftKey: boolean;
  /** Millimetres one screen pixel spans at the orbit target. */
  pixelMm: number;
}

export interface SliceView3d {
  setModel(min: number[], max: number[]): void;
  /** Rebuilds the ghost only for another `canonical` array; a pose change moves it. */
  setGhost(part: PlacedPart | null): void;
  setBuffers(buffers: PreviewBuffers | null): void;
  setBed(x: number, y: number, z: number): void;
  setRange(low: number, high: number): void;
  setShowTravel(show: boolean): void;
  setHidden(kinds: ReadonlySet<string>): void;
  setColorMode(mode: ColorMode): void;
  setPlane(plane: { axis: "x" | "y"; at: number } | null): void;
  onPlane(cb: ((at: number) => void) | null): void;
  setBedOpacity(opacity: number): void;
  setSection(section: SectionSpec | null): void;
  onSection(cb: ((section: SectionSpec, hud: string) => void) | null): void;
  setTheme(): void;
  setPlayhead(seg: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } | null): void;
  /** Reply-frame geometry plus this bed offset, as a group matrix. Buffers stay put. */
  setBedOffset(x: number, y: number): void;
  /**
   * Each plate object's paths drawn at its own offset on top of the bed offset, one group
   * matrix per object, and the support overlay and picking at object `support`'s offset.
   */
  setObjectOffsets(offsets: readonly (readonly [number, number])[], support: number): void;
  setSupportOverlay(overlay: SupportOverlay | null): void;
  /** Edit-mode pointer: `move` on hover, `click` on a press-release that moved under 5 px (a drag still orbits). Rays are print space. */
  onPick(cb: ((ev: PickEvent) => void) | null): void;
  /** Crosshair cursor, and only then `onPick` fires. */
  setPicking(on: boolean): void;
  resize(): void;
}

const noopView: SliceView3d = {
  setModel() {},
  setGhost() {},
  setBuffers() {},
  setBed() {},
  setRange() {},
  setShowTravel() {},
  setHidden() {},
  setColorMode() {},
  setPlane() {},
  onPlane() {},
  setBedOpacity() {},
  setSection() {},
  onSection() {},
  setTheme() {},
  setPlayhead() {},
  setBedOffset() {},
  setObjectOffsets() {},
  setSupportOverlay() {},
  onPick() {},
  setPicking() {},
  resize() {},
};

export function createSliceView(canvas: HTMLCanvasElement): SliceView3d {
  try {
    return mountSliceView(canvas);
  } catch (err) {
    console.error(err);
    return noopView;
  }
}

function mountSliceView(canvas: HTMLCanvasElement): SliceView3d {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.localClippingEnabled = true;
  applyPixelRatio(renderer);
  let colors = themeColors();
  renderer.setClearColor(hexToThree(colors.stage), 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  canvas.dataset.projection = camera.isPerspectiveCamera ? "perspective" : "orthographic";
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.touches.ONE = THREE.TOUCH.ROTATE;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

  const root = new THREE.Group();
  /** One group per plate object, positioned at that object's offset. */
  const objectGroups: THREE.Group[] = [];
  let objectsKey = "";
  const previewShift = new THREE.Group();
  previewShift.add(root);
  scene.add(previewShift);
  let bedOff: [number, number] = [0, 0];
  canvas.dataset.bedOffset = "0.000,0.000";
  const bed = new THREE.Group();
  scene.add(bed);
  const bedPlateMat = new THREE.MeshBasicMaterial({
    color: hexToThree(colors.bed),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  const bedPlate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bedPlateMat);
  bedPlate.rotation.x = -Math.PI / 2;
  scene.add(bedPlate);
  const bedEdge = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: hexToThree(colors.teal) }),
  );
  scene.add(bedEdge);
  const volume = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: hexToThree(colors.teal), transparent: true, opacity: 0.35 }),
  );
  scene.add(volume);
  let bedX = 220;
  let bedY = 220;
  let bedZ = 250;
  syncBedGrid(bed, bedX, bedY, hexToThree(colors.line), hexToThree(colors.bedMinor));

  let cut: THREE.Group | null = null;
  let cutPicks: THREE.Object3D[] = [];
  let cutKey = "";
  const cursorMat = new THREE.MeshBasicMaterial({ color: hexToThree(colors.amber), depthTest: false });
  const cursor = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 10), cursorMat);
  cursor.visible = false;
  cursor.renderOrder = 4;
  previewShift.add(cursor);
  const playGeo = new THREE.BufferGeometry();
  playGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  const playLine = new THREE.Line(playGeo, new THREE.LineBasicMaterial({ color: hexToThree(colors.amber), depthTest: false }));
  playLine.visible = false;
  playLine.renderOrder = 4;
  previewShift.add(playLine);

  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);
  const clipPlanes = [clipPlane];
  // Scene-space plane. Negative distance is the arrow side and is discarded in the fragment shader.
  const sectionPlane = { value: new THREE.Vector4(0, 1, 0, 1e6) };
  const sectionRig = buildSectionRig();
  previewShift.add(sectionRig.root);
  scene.add(sectionRig.gizmo);

  let ghost: THREE.Mesh | null = null;
  let ghostSig = "";
  let ghostSource: Float32Array | null = null;
  const ghostMat = new THREE.MeshBasicMaterial({ color: hexToThree(colors.mesh), clippingPlanes: clipPlanes });
  attachSectionClip(ghostMat, sectionPlane);
  let chunks: ChunkMeshes[] = [];
  /** Frame key of the paths the camera was last aimed at. */
  let framed = "";
  let model: { min: number[]; max: number[] } | null = null;
  let low = 0;
  let high = 0;
  let showTravel = false;
  let kinds: string[] = [];
  let hidden: ReadonlySet<string> = new Set();
  const pathUniforms = {
    palette: { value: new Float32Array(MAX_KINDS * 3) },
    hiddenKinds: { value: new Float32Array(MAX_KINDS) },
    mode: { value: 0 },
    sectionPlane,
  };
  const marginMat = pathMaterial(pathUniforms, MARGIN_SHADE, 1, { side: THREE.DoubleSide });
  const faceMat = pathMaterial(pathUniforms, 1, 1, {
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const travelMat = pathMaterial(pathUniforms, 1, 0.7, { transparent: true });
  let planeSpec: { axis: "x" | "y"; at: number } | null = null;
  let planeCb: ((at: number) => void) | null = null;
  let section: SectionSpec | null = null;
  let sectionCb: ((section: SectionSpec, hud: string) => void) | null = null;
  let origin = { cx: 0, cy: 0 };
  let regionDrag = false;
  let sectionDrag: SectionDrag = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const support = buildSupportOverlay(clipPlane, colors);
  previewShift.add(support.root);
  let picking = false;
  let pickCb: ((ev: PickEvent) => void) | null = null;
  let press: { x: number; y: number } | null = null;

  // Render only when something changed. Damping keeps emitting change
  // from controls.update() until the camera settles.
  let frameQueued = false;
  /** A pointer is on the controls, and whether frames draw at one pixel per CSS pixel. */
  let held = false;
  let lowRes = false;
  function requestRender() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(frame);
  }
  function frame() {
    frameQueued = false;
    const moved = controls.update();
    // An orbit draws at device pixel ratio 1 from its first move until the camera settles, then once sharp.
    const low = moved ? held || lowRes : held && lowRes;
    if (low !== lowRes) {
      lowRes = low;
      applyPixelRatio(renderer, lowRes);
    }
    fitSection();
    renderer.render(scene, camera);
  }
  controls.addEventListener("change", requestRender);
  let userAimed = false;
  controls.addEventListener("start", () => {
    held = true;
    userAimed = true;
  });
  controls.addEventListener("end", () => {
    held = false;
    requestRender();
  });
  frameEmptyPerspective();

  function resize() {
    requestRender();
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    applyPixelRatio(renderer, lowRes);
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  }

  function applyFocus() {
    for (const c of chunks) {
      const lo = Math.max(low, c.first) - c.first;
      const hi = Math.min(high, c.first + c.chunk.indices.length - 1) - c.first;
      showLayers(c.beads, c.chunk.beads, lo, hi);
      showLayers(c.travel, c.chunk.travel, showTravel ? lo : 1, showTravel ? hi : 0);
    }
    placePlane();
  }

  function placeBed(span: number, centerX = 0, centerY = 0) {
    const size = Math.max(bedX, bedY, span);
    syncBedGrid(bed, bedX, bedY, hexToThree(colors.line), hexToThree(colors.bedMinor), centerX, centerY);
    bedPlate.scale.set(bedX, bedY, 1);
    bedPlate.position.set(bedX / 2 - centerX, -0.05, -(bedY / 2 - centerY));
    bedEdge.geometry.dispose();
    bedEdge.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-centerX, 0.08, centerY),
      new THREE.Vector3(bedX - centerX, 0.08, centerY),
      new THREE.Vector3(bedX - centerX, 0.08, -(bedY - centerY)),
      new THREE.Vector3(-centerX, 0.08, -(bedY - centerY)),
    ]);
    volume.scale.set(bedX, bedZ, bedY);
    volume.position.set(bedX / 2 - centerX, bedZ / 2, -(bedY / 2 - centerY));
    return size;
  }

  /** Iso perspective of the empty bed. A user orbit, a mesh, or a slice keeps its own camera. */
  function frameEmptyPerspective() {
    if (userAimed || model || chunks.length > 0) return;
    placeBed(Math.max(bedX, bedY));
    camera.position.set(bedX * 0.85, bedZ * 0.55, bedY * 0.95);
    controls.target.set(bedX / 2, Math.min(30, bedZ * 0.12), -bedY / 2);
    controls.update();
    requestRender();
  }

  function placePlane() {
    requestRender();
    const bounds = model ? asBounds(model.min, model.max) : null;
    const key = planeSpec && bounds
      ? `${planeSpec.axis}:${planeSpec.at.toFixed(2)}:${bounds.min.map((v) => v.toFixed(2)).join()}:${bounds.max.map((v) => v.toFixed(2)).join()}:${origin.cx.toFixed(2)}:${origin.cy.toFixed(2)}:${bedX}:${bedY}`
      : "";
    if (key === cutKey) return;
    cutKey = key;
    if (cut) {
      cut.removeFromParent();
      disposeTree(cut);
      cut = null;
      cutPicks = [];
    }
    if (!planeSpec || !bounds) return;
    const built = buildCutPlane(planeSpec.axis, planeSpec.at, bounds, previewFrame(origin.cx, origin.cy), bedX, bedY);
    cut = built.group;
    cutPicks = built.picks;
    previewShift.add(cut);
  }

  function pointerNdc(ev: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    fitSection();
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
  }

  function partCenter(): Vec3 | null {
    if (!model) return null;
    return [
      (model.min[0] + model.max[0]) / 2,
      (model.min[1] + model.max[1]) / 2,
      (model.min[2] + model.max[2]) / 2,
    ];
  }

  function reach() {
    return model ? sectionReach(model.min, model.max) : 100;
  }

  function writeClip(x: number, y: number, z: number, constant: number) {
    const shift = previewShift.position;
    const adjusted = constant - (x * shift.x + y * shift.y + z * shift.z);
    clipPlane.set(new THREE.Vector3(x, y, z), adjusted);
    sectionPlane.value.set(x, y, z, adjusted);
  }

  function syncClip() {
    const center = partCenter();
    if (!section || !center) {
      writeClip(0, 1, 0, 1e6);
      return;
    }
    const placed = threeClip(center, section);
    writeClip(placed.normal[0], placed.normal[1], placed.normal[2], placed.constant);
  }

  const park = new THREE.Vector3();

  function fitSection() {
    if (!sectionRig.gizmo.visible) return;
    const rect = canvas.getBoundingClientRect();
    camera.updateMatrixWorld();
    const distance = Math.max(8, camera.position.distanceTo(controls.target));
    const radius = gizmoRadiusForPixels(distance, camera.fov, rect.height, GIZMO_SCREEN_PX, camera.zoom);
    sectionRig.rings.scale.setScalar(radius);
    sectionRig.arrow.scale.setScalar(radius * 0.72);
    const [x, y, z] = parkLeftCameraSpace(rect.width, distance, camera.fov, camera.aspect, camera.zoom);
    park.set(x, y, z);
    park.applyMatrix4(camera.matrixWorld);
    sectionRig.gizmo.position.copy(park);
    sectionRig.gizmo.updateMatrixWorld(true);
  }

  function placeSection() {
    const center = partCenter();
    const show = !!section && !!center;
    sectionRig.root.visible = show;
    sectionRig.gizmo.visible = show;
    if (section && center) {
      const foot = anchor(center, section);
      sectionRig.root.position.set(foot[0] - origin.cx, foot[2], -(foot[1] - origin.cy));
      const dir = new THREE.Vector3(section.normal[0], section.normal[2], -section.normal[1]);
      if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
      dir.normalize();
      sectionRig.sheet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      sectionRig.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      const span = Math.max(24, reach() * 2);
      sectionRig.sheet.scale.set(span, span, 1);
      fitSection();
    }
    syncClip();
    requestRender();
  }

  function emitSection(hud: string) {
    if (!section) return;
    sectionCb?.({
      normal: [section.normal[0], section.normal[1], section.normal[2]],
      offset: section.offset,
    }, hud);
  }

  function sectionPick(): SectionHit | null {
    if (!sectionRig.gizmo.visible) return null;
    const hits = raycaster.intersectObjects(sectionRig.picks, false);
    let ring: Axis | null = null;
    let ringDist = Infinity;
    for (const hit of hits) {
      const kind = hit.object.userData.section as string | undefined;
      if (kind === "ring" && hit.distance < ringDist) {
        const axis = hit.object.userData.axis as Axis;
        if (axis === "x" || axis === "y" || axis === "z") {
          ring = axis;
          ringDist = hit.distance;
        }
      }
    }
    return ring ? { axis: ring, distance: ringDist } : null;
  }

  function angleOn(axis: Axis): number | null {
    if (!sectionRig.gizmo.visible) return null;
    const originV = sectionRig.gizmo.getWorldPosition(new THREE.Vector3());
    const dir = sceneAxis(axis);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, originV);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    const v = new THREE.Vector3(hit.x - originV.x, -(hit.z - originV.z), hit.y - originV.y);
    const ax = printAxis(axis);
    const along = v.x * ax.x + v.y * ax.y + v.z * ax.z;
    v.addScaledVector(ax, -along);
    if (v.lengthSq() < 1e-8) return null;
    const u = new THREE.Vector3();
    if (Math.abs(ax.x) < 0.9) u.crossVectors(ax, new THREE.Vector3(1, 0, 0));
    else u.crossVectors(ax, new THREE.Vector3(0, 1, 0));
    u.normalize();
    const w = new THREE.Vector3().crossVectors(ax, u);
    return Math.atan2(v.dot(w), v.dot(u));
  }

  let ringHover: Axis | null = null;
  function paintRings(active: Axis | null) {
    if (active === ringHover) return;
    ringHover = active;
    for (const [axis, mat] of sectionRig.ringMats) {
      mat.color.setHex(active === axis ? hexToThree(colors.gizmoHot) : ringHex(axis));
    }
    requestRender();
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !model) return;
    pointerNdc(ev);
    const sectionHit = sectionPick();
    const regionHit = planeSpec ? raycaster.intersectObjects(cutPicks, false)[0] : undefined;
    const takeSection = !!sectionHit && (!regionHit || sectionHit.distance <= regionHit.distance);
    if (takeSection && section && sectionHit) {
      sectionDrag = {
        axis: sectionHit.axis,
        last: angleOn(sectionHit.axis) ?? 0,
        total: 0,
        applied: 0,
        base: { normal: [...section.normal], offset: section.offset },
      };
      paintRings(sectionHit.axis);
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      canvas.style.cursor = "grabbing";
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (!planeSpec || !regionHit) return;
    regionDrag = true;
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    canvas.style.cursor = "grabbing";
    ev.preventDefault();
    ev.stopPropagation();
  }, { capture: true });
  canvas.addEventListener("pointermove", (ev) => {
    if (!model) return;
    if (!regionDrag && !sectionDrag) {
      pointerNdc(ev);
      const sectionHit = sectionPick();
      const regionHot = !!planeSpec && raycaster.intersectObjects(cutPicks, false).length > 0;
      canvas.style.cursor = sectionHit || regionHot ? "grab" : restCursor();
      paintRings(sectionHit ? sectionHit.axis : null);
      return;
    }
    canvas.style.cursor = "grabbing";
    pointerNdc(ev);
    if (sectionDrag && section) {
      const angle = angleOn(sectionDrag.axis);
      if (angle == null) return;
      let step = angle - sectionDrag.last;
      while (step > Math.PI) step -= Math.PI * 2;
      while (step < -Math.PI) step += Math.PI * 2;
      sectionDrag.last = angle;
      sectionDrag.total += step * (180 / Math.PI);
      const target = snapStep(sectionDrag.total, ev.shiftKey, 15);
      if (Math.abs(target - sectionDrag.applied) < 0.04) return;
      sectionDrag.applied = target;
      const axis = printAxis(sectionDrag.axis);
      const next = aimSection(sectionDrag.base, [axis.x, axis.y, axis.z], target * Math.PI / 180);
      section = { normal: next.normal, offset: clampOffset(next.offset, reach()) };
      placeSection();
      const sign = target >= 0 ? "+" : "";
      emitSection(`${sectionDrag.axis.toUpperCase()} ${sign}${target.toFixed(0)}°`);
      const rebased = angleOn(sectionDrag.axis);
      if (rebased != null) sectionDrag.last = rebased;
      return;
    }
    if (!planeSpec || !regionDrag) return;
    const bounds = asBounds(model.min, model.max);
    const pivot: [number, number, number] = [
      planeSpec.axis === "x" ? planeSpec.at : (bounds.min[0] + bounds.max[0]) / 2,
      planeSpec.axis === "y" ? planeSpec.at : (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    const ray = raycaster.ray.clone();
    ray.origin.sub(previewShift.position);
    const raw = splitDragAt(ray, planeSpec.axis, pivot, previewFrame(origin.cx, origin.cy), camera.position);
    if (raw == null) return;
    const at = roundSplit(clampSplit(raw, bounds, planeSpec.axis));
    if (Math.abs(at - planeSpec.at) < 0.05) return;
    planeSpec = { ...planeSpec, at };
    placePlane();
    planeCb?.(at);
  });
  const endDrag = () => {
    const spun = sectionDrag;
    regionDrag = false;
    sectionDrag = null;
    controls.enabled = true;
    canvas.style.cursor = restCursor();
    paintRings(null);
    if (spun) emitSection("");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", (ev) => {
    if (!regionDrag && !sectionDrag) canvas.style.cursor = restCursor();
    emitPick("leave", ev);
  });

  function restCursor() {
    return picking ? "crosshair" : "";
  }
  function emitPick(kind: PickEvent["kind"], ev: PointerEvent) {
    if (!picking || !pickCb || !model) return;
    pointerNdc(ev);
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    const rect = canvas.getBoundingClientRect();
    const viewMm = 2 * camera.position.distanceTo(controls.target) * Math.tan((camera.fov * Math.PI) / 360);
    const [px, py, pz] = replyFrameRay(
      [o.x + origin.cx, origin.cy - o.z, o.y],
      [previewShift.position.x + support.root.position.x, -(previewShift.position.z + support.root.position.z)],
    );
    pickCb({
      kind,
      ray: { origin: [px, py, pz], dir: [d.x, -d.z, d.y] },
      shiftKey: ev.shiftKey,
      pixelMm: viewMm / Math.max(1, rect.height) / camera.zoom,
    });
  }
  // The section and region handlers run first, in the capture phase; a press they took never picks.
  canvas.addEventListener("pointerdown", (ev) => {
    press = ev.button === 0 && picking && !regionDrag && !sectionDrag ? { x: ev.clientX, y: ev.clientY } : null;
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (ev.buttons === 0 && !regionDrag && !sectionDrag) emitPick("move", ev);
  });
  canvas.addEventListener("pointerup", (ev) => {
    const at = press;
    press = null;
    if (at && Math.hypot(ev.clientX - at.x, ev.clientY - at.y) < 5) emitPick("click", ev);
  });

  function applyHidden() {
    fillHiddenKindMask(pathUniforms.hiddenKinds.value, kinds, hidden);
  }

  function dropChunks(drop: Iterable<ChunkMeshes>) {
    for (const c of drop) {
      for (const mesh of [...c.beads.meshes, ...c.travel.meshes]) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
      }
    }
  }

  /** The group object `o`'s chunks draw under, made on first use. */
  function objectGroup(o: number) {
    while (objectGroups.length <= o) {
      const group = new THREE.Group();
      root.add(group);
      objectGroups.push(group);
    }
    return objectGroups[o];
  }

  return {
    resize,
    setBed(x, y, z) {
      bedX = x;
      bedY = y;
      bedZ = z;
      frameEmptyPerspective();
    },
    setBuffers(buffers) {
      requestRender();
      // A chunk object the last buffers also held keeps its meshes and GPU buffers.
      const shown = new Map(chunks.map((c) => [c.chunk, c]));
      chunks = [];
      if (!buffers || buffers.chunks.length === 0) {
        dropChunks(shown.values());
        return;
      }
      origin = { cx: buffers.centerX, cy: buffers.centerY };
      kinds = buffers.kinds;
      const palette = pathUniforms.palette.value;
      kinds.forEach((kind, i) => palette.set(linearRgb(featureColor(kind)), i * 3));
      applyHidden();
      // The renderer culls by each geometry's bounding sphere and cannot compute
      // one for instanced points. A sphere around the print's bounds holds every path.
      const sphere = new THREE.Sphere(new THREE.Vector3(0, buffers.midZ, 0), buffers.span + 10);
      // `first` counts layers within one object: every object's chunks span the whole preview.
      let first = 0;
      let object = -1;
      for (const chunk of buffers.chunks) {
        if (chunk.object !== object) {
          object = chunk.object;
          first = 0;
        }
        let meshes = shown.get(chunk);
        shown.delete(chunk);
        if (!meshes) {
          meshes = chunkMeshes(chunk, sphere, marginMat, faceMat, travelMat);
          const group = objectGroup(chunk.object);
          for (const mesh of [...meshes.beads.meshes, ...meshes.travel.meshes]) group.add(mesh);
        }
        meshes.first = first;
        chunks.push(meshes);
        first += chunk.indices.length;
      }
      dropChunks(shown.values());
      const size = placeBed(buffers.span, buffers.centerX, buffers.centerY);
      if (buffers.frame !== framed) {
        framed = buffers.frame;
        camera.position.set(size * 0.9, buffers.midZ + size * 0.45, size * 0.9);
        controls.target.set(0, buffers.midZ, 0);
        controls.update();
      }
      applyFocus();
      placeSection();
    },
    setShowTravel(show) {
      showTravel = show;
      applyFocus();
    },
    setHidden(next) {
      hidden = new Set(next);
      applyHidden();
      requestRender();
    },
    setColorMode(mode) {
      pathUniforms.mode.value = mode === "weight" ? 1 : mode === "speed" ? 2 : 0;
      requestRender();
    },
    setRange(nextLow, nextHigh) {
      low = nextLow;
      high = nextHigh;
      applyFocus();
    },
    setPlane(spec) {
      planeSpec = spec;
      placePlane();
    },
    onPlane(cb) {
      planeCb = cb;
    },
    setBedOpacity(opacity) {
      applyPlateOpacity(bedPlateMat, bedPlate, opacity);
      requestRender();
    },
    setSection(spec) {
      if (sectionDrag) return;
      const next = spec ? { normal: normalize(spec.normal), offset: clampOffset(spec.offset, reach()) } : null;
      if (sameSection(section, next)) return;
      section = next;
      placeSection();
    },
    onSection(cb) {
      sectionCb = cb;
    },
    setTheme() {
      requestRender();
      colors = themeColors();
      renderer.setClearColor(hexToThree(colors.stage), 1);
      cutKey = "";
      placePlane();
      cursorMat.color.setHex(hexToThree(colors.amber));
      sectionRig.arrowMat.color.setHex(hexToThree(colors.amber));
      bedPlateMat.color.setHex(hexToThree(colors.bed));
      ghostMat.color.setHex(hexToThree(colors.mesh));
      (sectionRig.sheet.material as THREE.MeshBasicMaterial).color.setHex(hexToThree(colors.sheet));
      const sheetEdge = sectionRig.sheet.children[0] as THREE.LineLoop;
      (sheetEdge.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.sheet));
      for (const [axis, mat] of sectionRig.ringMats) {
        mat.color.setHex(hexToThree(axis === "x" ? colors.axisX : axis === "y" ? colors.axisY : colors.axisZ));
      }
      (bedEdge.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.teal));
      (playLine.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.amber));
      (volume.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.teal));
      support.recolor(colors);
      bed.userData.gridKey = "";
      syncBedGrid(bed, bedX, bedY, hexToThree(colors.line), hexToThree(colors.bedMinor), bed.userData.cx ?? 0, bed.userData.cy ?? 0);
    },
    setBedOffset(x, y) {
      const ox = Number.isFinite(x) ? x : 0;
      const oy = Number.isFinite(y) ? y : 0;
      if (Math.abs(ox - bedOff[0]) < 1e-4 && Math.abs(oy - bedOff[1]) < 1e-4) return;
      bedOff = [ox, oy];
      previewShift.position.set(ox, 0, -oy);
      canvas.dataset.bedOffset = `${ox.toFixed(3)},${oy.toFixed(3)}`;
      syncClip();
      requestRender();
    },
    setObjectOffsets(offsets, supportObject) {
      const key = `${offsets.map((o) => `${o[0].toFixed(4)},${o[1].toFixed(4)}`).join(";")}|${supportObject}`;
      if (key === objectsKey) return;
      objectsKey = key;
      offsets.forEach(([x, y], o) => objectGroup(o).position.set(...sceneShift([x, y])));
      const [sx, sy] = offsets[supportObject] ?? [0, 0];
      support.root.position.set(...sceneShift([sx, sy]));
      canvas.dataset.objectOffsets = offsets.map((o) => `${o[0].toFixed(3)},${o[1].toFixed(3)}`).join(";");
      requestRender();
    },
    setPlayhead(seg) {
      requestRender();
      if (!seg || !model) {
        cursor.visible = false;
        playLine.visible = false;
        return;
      }
      cursor.visible = true;
      playLine.visible = true;
      const head = scenePoint(seg.x1, seg.y1, seg.z1, origin.cx, origin.cy);
      const tail = scenePoint(seg.x0, seg.y0, seg.z0, origin.cx, origin.cy);
      cursor.position.set(head[0], head[1], head[2]);
      const pos = playGeo.getAttribute("position") as THREE.BufferAttribute;
      pos.setXYZ(0, tail[0], tail[1], tail[2]);
      pos.setXYZ(1, head[0], head[1], head[2]);
      pos.needsUpdate = true;
    },
    setSupportOverlay(next) {
      if (support.set(next, origin)) requestRender();
    },
    onPick(cb) {
      pickCb = cb;
    },
    setPicking(on) {
      picking = on;
      if (!on) press = null;
      if (!regionDrag && !sectionDrag) canvas.style.cursor = restCursor();
    },
    setGhost(part) {
      const canonical = part && part.canonical.length >= 9 ? part.canonical : null;
      const a = canonical && part ? poseAffine(part.pose) : null;
      const sig = a ? `${a.join()}:${origin.cx}:${origin.cy}` : "";
      if (sig === ghostSig && canonical === ghostSource) return;
      ghostSig = sig;
      requestRender();
      if (canonical !== ghostSource) {
        ghostSource = canonical;
        if (ghost) {
          scene.remove(ghost);
          ghost.geometry.dispose();
          ghost = null;
        }
        if (canonical) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(canonical, 3));
          ghost = new THREE.Mesh(geometry, ghostMat);
          ghost.matrixAutoUpdate = false;
          scene.add(ghost);
        }
      }
      if (ghost && a) {
        // Print X, Y, Z is scene X, -Z, Y, centered on the model like the toolpaths.
        ghost.matrix.set(a[0], a[1], a[2], a[3] - origin.cx, a[8], a[9], a[10], a[11], -a[4], -a[5], -a[6], origin.cy - a[7], 0, 0, 0, 1);
        ghost.matrixWorldNeedsUpdate = true;
      }
    },
    setModel(min, max) {
      const next = { min: [...min], max: [...max] };
      const same = !!model && model.min.every((v, i) => v === next.min[i]) && model.max.every((v, i) => v === next.max[i]);
      model = next;
      origin = meshCenter(min, max);
      if (!same && chunks.length === 0) {
        const span = Math.max(next.max[0] - next.min[0], next.max[1] - next.min[1], next.max[2] - next.min[2], 1);
        const midZ = (next.min[2] + next.max[2]) / 2;
        placeBed(span, origin.cx, origin.cy);
        const dist = Math.max(span, 28) * 2.3;
        camera.position.set(dist * 0.85, midZ + dist * 0.55, dist * 0.95);
        controls.target.set(0, Math.max(midZ, 6), 0);
        controls.update();
      }
      placePlane();
      placeSection();
    },
  };
}

function asBounds(min: number[], max: number[]): AxisBounds {
  return {
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
  };
}

/** One chunk's draws: margin box and bright face share the bead points; travel lines have their own. */
interface ChunkMeshes {
  chunk: PreviewChunk;
  /** Position of the chunk's first layer in the whole preview. */
  first: number;
  beads: PointDraw;
  travel: PointDraw;
}

/** Meshes drawing one point run, one instance per point. */
interface PointDraw {
  meshes: (THREE.Mesh | THREE.LineSegments)[];
  xyz: THREE.InstancedInterleavedBuffer;
  style: THREE.InstancedInterleavedBuffer;
  /** Point the instance attributes start at. */
  from: number;
}

/**
 * Corner of the bead box per vertex: x picks the segment end, y the side
 * (times half width), z the bottom (times bead height). Four sides, no caps,
 * wound outward.
 */
const BOX_CORNERS = [0, 1, 0, 0, -1, 0, 1, 1, 0, 1, -1, 0, 0, 1, 1, 0, -1, 1, 1, 1, 1, 1, -1, 1];
const BOX_INDEX = [1, 3, 2, 1, 2, 0, 5, 6, 7, 5, 4, 6, 0, 2, 6, 0, 6, 4, 1, 7, 3, 1, 5, 7];
const FACE_CORNERS = [0, INNER_HALF_SCALE, 0, 0, -INNER_HALF_SCALE, 0, 1, INNER_HALF_SCALE, 0, 1, -INNER_HALF_SCALE, 0];
const FACE_INDEX = [1, 3, 2, 1, 2, 0];
const LINE_CORNERS = [0, 0, 0, 1, 0, 0];

function chunkMeshes(chunk: PreviewChunk, sphere: THREE.Sphere, margin: THREE.Material, face: THREE.Material, travel: THREE.Material): ChunkMeshes {
  const beads = pointDraw(chunk.beads, [
    new THREE.Mesh(instanced(BOX_CORNERS, BOX_INDEX, sphere), margin),
    new THREE.Mesh(instanced(FACE_CORNERS, FACE_INDEX, sphere), face),
  ]);
  const lines = pointDraw(chunk.travel, [new THREE.LineSegments(instanced(LINE_CORNERS, null, sphere), travel)]);
  return { chunk, first: 0, beads, travel: lines };
}

function pointDraw(run: PointRun, meshes: (THREE.Mesh | THREE.LineSegments)[]): PointDraw {
  return {
    meshes,
    xyz: new THREE.InstancedInterleavedBuffer(run.xyz, 3),
    style: new THREE.InstancedInterleavedBuffer(run.style, STYLE_WORDS),
    from: -1,
  };
}

function instanced(corners: number[], index: number[] | null, sphere: THREE.Sphere) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("corner", new THREE.Float32BufferAttribute(corners, 3));
  if (index) geometry.setIndex(index);
  else geometry.setDrawRange(0, corners.length / 3);
  geometry.boundingSphere = sphere.clone();
  geometry.instanceCount = 0;
  return geometry;
}

/**
 * Draws layers `lo..hi` of the chunk, none when `lo > hi`. Instance `i` is the
 * segment from point `i` to point `i + 1`, so the attributes start at the
 * layers' first point. A layer's last point ends a path: no instance for it.
 */
function showLayers(draw: PointDraw, run: PointRun, lo: number, hi: number) {
  const count = lo <= hi ? run.at[hi + 1] - run.at[lo] - 1 : 0;
  for (const mesh of draw.meshes) {
    mesh.visible = count > 0;
    (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.max(0, count);
  }
  const from = run.at[lo];
  if (count <= 0 || from === draw.from) return;
  draw.from = from;
  for (const mesh of draw.meshes) {
    const geometry = mesh.geometry;
    geometry.setAttribute("segA", new THREE.InterleavedBufferAttribute(draw.xyz, 3, from * 3));
    geometry.setAttribute("segB", new THREE.InterleavedBufferAttribute(draw.xyz, 3, (from + 1) * 3));
    geometry.setAttribute("segStyle", new THREE.InterleavedBufferAttribute(draw.style, STYLE_WORDS, from * STYLE_WORDS));
  }
}

/** The legend's sRGB hex as the linear triple the shader works in, so both show the same color. */
const linearRgb = (hex: string) => new THREE.Color(hex).toArray() as [number, number, number];
const rgb = (hex: string) => `vec3(${linearRgb(hex).map((v) => v.toFixed(4)).join(", ")})`;
const [SPEED_LO, SPEED_HI] = SPEED_RANGE_MM_S;

/**
 * Expands one segment per instance: from `segA` to `segB`, sideways by the
 * half width and down by the bead height in `segStyle`, colored by its kind
 * slot, blend weight, and speed. Hidden kinds and path ends collapse off-screen.
 * Fragments on the negative side of `sectionPlane` (scene space, xyz = normal,
 * w = constant) are dropped.
 */
const PATH_VERTEX = `
attribute vec3 corner;
attribute vec3 segA;
attribute vec3 segB;
attribute vec4 segStyle;
uniform vec3 palette[${MAX_KINDS}];
uniform float hiddenKinds[${MAX_KINDS}];
uniform int mode;
uniform float shade;
uniform vec4 sectionPlane;
varying vec3 vColor;
varying float vSectionDist;
void main() {
  float slot = floor(segStyle.x / ${KIND_SHIFT.toFixed(1)});
  int kind = int(slot);
  if (segStyle.w < 0.5 || hiddenKinds[kind] > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 run = segB.xz - segA.xz;
  float len = length(run);
  vec2 side = len > 0.0 ? vec2(run.y, -run.x) / len : vec2(0.0);
  vec3 point = mix(segA, segB, corner.x);
  point.xz += side * (segStyle.z * 0.001 * corner.y);
  point.y -= segStyle.w * 0.001 * corner.z;
  vec4 mvPosition = modelViewMatrix * vec4(point, 1.0);
  vec4 worldPos = modelMatrix * vec4(point, 1.0);
  vSectionDist = dot(worldPos.xyz, sectionPlane.xyz) + sectionPlane.w;
  float weight = (segStyle.x - slot * ${KIND_SHIFT.toFixed(1)}) / ${WEIGHT_STEPS.toFixed(1)};
  float speed = segStyle.y * 0.1;
  vec3 color = palette[kind];
  if (mode == 1) color = mix(${rgb(WEIGHT_RAMP[0])}, ${rgb(WEIGHT_RAMP[1])}, weight);
  if (mode == 2) color = mix(${rgb(SPEED_RAMP[0])}, ${rgb(SPEED_RAMP[1])}, clamp((speed - ${SPEED_LO.toFixed(1)}) / ${(SPEED_HI - SPEED_LO).toFixed(1)}, 0.0, 1.0));
  vColor = color * shade;
  gl_Position = projectionMatrix * mvPosition;
}`;

const PATH_FRAGMENT = `
uniform float alpha;
varying vec3 vColor;
varying float vSectionDist;
void main() {
  if (vSectionDist < -0.0001) discard;
  gl_FragColor = vec4(vColor, alpha);
  #include <colorspace_fragment>
}`;

/** Same discard for the solid ghost, which is a built-in material. */
function attachSectionClip(material: THREE.Material, plane: { value: THREE.Vector4 }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.sectionPlane = plane;
    shader.vertexShader = `uniform vec4 sectionPlane;\nvarying float vSectionDist;\n${shader.vertexShader.replace(
      "#include <project_vertex>",
      "#include <project_vertex>\n\tvSectionDist = dot((modelMatrix * vec4(position, 1.0)).xyz, sectionPlane.xyz) + sectionPlane.w;",
    )}`;
    shader.fragmentShader = `uniform vec4 sectionPlane;\nvarying float vSectionDist;\n${shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      "if (vSectionDist < -0.0001) discard;\n\t#include <opaque_fragment>",
    )}`;
  };
}

function pathMaterial(
  shared: Record<string, THREE.IUniform>,
  shade: number,
  alpha: number,
  params: THREE.ShaderMaterialParameters,
) {
  return new THREE.ShaderMaterial({
    ...params,
    uniforms: { ...shared, shade: { value: shade }, alpha: { value: alpha } },
    vertexShader: PATH_VERTEX,
    fragmentShader: PATH_FRAGMENT,
  });
}

type Axis = "x" | "y" | "z";
type SectionHit = { axis: Axis; distance: number };
type SectionDrag = { axis: Axis; last: number; total: number; applied: number; base: SectionSpec } | null;

function ringHex(axis: Axis): number {
  const colors = themeColors();
  const hex = axis === "x" ? colors.axisX : axis === "y" ? colors.axisY : colors.axisZ;
  return hexToThree(hex);
}

function sameSection(a: SectionSpec | null, b: SectionSpec | null) {
  if (!a || !b) return a === b;
  return Math.abs(a.offset - b.offset) < 1e-4
    && Math.abs(a.normal[0] - b.normal[0]) < 1e-4
    && Math.abs(a.normal[1] - b.normal[1]) < 1e-4
    && Math.abs(a.normal[2] - b.normal[2]) < 1e-4;
}

function applyPlateOpacity(mat: THREE.MeshBasicMaterial, mesh: THREE.Object3D, opacity: number) {
  const o = Math.min(1, Math.max(0, opacity));
  const solid = o >= 0.999;
  const transparent = !solid;
  if (mat.transparent !== transparent || mat.depthWrite !== solid) {
    mat.transparent = transparent;
    mat.depthWrite = solid;
    mat.needsUpdate = true;
  }
  mat.opacity = o;
  mesh.visible = o > 0.004;
}

function sceneAxis(axis: Axis) {
  if (axis === "x") return new THREE.Vector3(1, 0, 0);
  if (axis === "y") return new THREE.Vector3(0, 0, -1);
  return new THREE.Vector3(0, 1, 0);
}

function printAxis(axis: Axis) {
  if (axis === "x") return new THREE.Vector3(1, 0, 0);
  if (axis === "y") return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

function orientRing(mesh: THREE.Mesh, axis: Axis) {
  if (axis === "x") mesh.rotation.y = Math.PI / 2;
  else if (axis === "z") mesh.rotation.x = Math.PI / 2;
}

function buildSectionRig() {
  const root = new THREE.Group();
  root.visible = false;
  const sheet = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: hexToThree(themeColors().sheet), transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
  );
  sheet.renderOrder = 3;
  sheet.raycast = () => undefined;
  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ], 3)),
    new THREE.LineBasicMaterial({ color: hexToThree(themeColors().sheet), transparent: true, opacity: 0.95, depthTest: false }),
  );
  border.renderOrder = 4;
  border.raycast = () => undefined;
  sheet.add(border);
  const arrowMat = new THREE.MeshBasicMaterial({ color: hexToThree(themeColors().amber), depthTest: false, toneMapped: false });
  const arrow = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.55, 10), arrowMat);
  shaft.position.y = 0.38;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28, 12), arrowMat);
  head.position.y = 0.76;
  for (const part of [shaft, head]) {
    part.renderOrder = 6;
    part.frustumCulled = false;
    part.raycast = () => undefined;
    arrow.add(part);
  }
  arrow.renderOrder = 6;
  const gizmo = new THREE.Group();
  gizmo.visible = false;
  const rings = new THREE.Group();
  const ringMats = new Map<Axis, THREE.MeshBasicMaterial>();
  const picks: THREE.Object3D[] = [];
  const ringGeo = new THREE.TorusGeometry(1, 0.046, 10, 64);
  const pickGeo = new THREE.TorusGeometry(1, 0.11, 8, 24);
  for (const axis of ["x", "y", "z"] as const) {
    const mat = new THREE.MeshBasicMaterial({ color: ringHex(axis), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
    const show = new THREE.Mesh(ringGeo, mat);
    const pick = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    orientRing(show, axis);
    orientRing(pick, axis);
    show.renderOrder = 6;
    show.frustumCulled = false;
    show.raycast = () => undefined;
    pick.frustumCulled = false;
    pick.userData.section = "ring";
    pick.userData.axis = axis;
    rings.add(show, pick);
    picks.push(pick);
    ringMats.set(axis, mat);
  }
  root.add(sheet);
  gizmo.add(arrow, rings);
  return { root, gizmo, sheet, arrow, arrowMat, rings, ringMats, picks };
}

/** How far the highlight sits outside a limb's mean radius, so it wraps the printed ribbon. */
const WRAP_MM = 0.12;

/**
 * Support-edit highlights: hovered and selected limbs as capsules, each drawn twice
 * (an x-ray pass that ignores depth, then a solid pass), and coverage gaps as outlines and fills.
 * Every material clips to the section and to the visible layer slab.
 */
function buildSupportOverlay(sectionClip: THREE.Plane, initial: ThemeColors) {
  const root = new THREE.Group();
  const slabLow = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);
  const slabHigh = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  const clippingPlanes = [sectionClip, slabLow, slabHigh];
  const stick = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
  const ball = new THREE.SphereGeometry(1, 14, 10);
  const passes = (hex: string) => [
    new THREE.MeshBasicMaterial({ color: hexToThree(hex), transparent: true, opacity: 0.28, depthTest: false, depthWrite: false, clippingPlanes }),
    new THREE.MeshBasicMaterial({ color: hexToThree(hex), transparent: true, opacity: 0.9, clippingPlanes }),
  ];
  const hoverMats = passes(initial.gizmoHot);
  const selectMats = passes(initial.amber);
  const gapLine = new THREE.LineBasicMaterial({ color: hexToThree(initial.danger), transparent: true, opacity: 0.95, depthTest: false, clippingPlanes });
  const gapFill = new THREE.MeshBasicMaterial({ color: hexToThree(initial.danger), transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, side: THREE.DoubleSide, clippingPlanes });
  const gapHot = gapFill.clone();
  gapHot.opacity = 0.45;
  const hoverGroup = new THREE.Group();
  const selectGroup = new THREE.Group();
  const gapGroup = new THREE.Group();
  root.add(gapGroup, selectGroup, hoverGroup);
  let built: { hover: Float32Array | null; selected: Float32Array | null; gaps: readonly CoverageGap[] | null; hot: number | null; at: string } = {
    hover: null,
    selected: null,
    gaps: null,
    hot: null,
    at: "",
  };

  function clear(group: THREE.Group) {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.InstancedMesh) child.dispose();
      else if (child instanceof THREE.Mesh || child instanceof THREE.LineLoop) child.geometry.dispose();
    }
  }

  function fillCapsules(group: THREE.Group, caps: Float32Array | null, mats: THREE.Material[], cx: number, cy: number) {
    clear(group);
    if (!caps || caps.length === 0) return;
    const n = caps.length / 8;
    const sticks = mats.map((mat) => new THREE.InstancedMesh(stick, mat, n));
    const balls = mats.map((mat) => new THREE.InstancedMesh(ball, mat, n * 2));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const none = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const c = caps.subarray(i * 8, i * 8 + 8);
      const a = new THREE.Vector3(...scenePoint(c[0], c[1], c[2], cx, cy));
      const b = new THREE.Vector3(...scenePoint(c[4], c[5], c[6], cx, cy));
      const along = b.clone().sub(a);
      const len = along.length();
      if (len > 1e-6) q.setFromUnitVectors(up, along.divideScalar(len));
      else q.identity();
      const r = (c[3] + c[7]) / 2 + WRAP_MM;
      m.compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(r, Math.max(len, 1e-4), r));
      for (const mesh of sticks) mesh.setMatrixAt(i, m);
      const ends: [number, THREE.Vector3, number][] = [[i * 2, a, c[3]], [i * 2 + 1, b, c[7]]];
      for (const [k, at, rk] of ends) {
        const rr = rk + WRAP_MM;
        m.compose(at, none, new THREE.Vector3(rr, rr, rr));
        for (const mesh of balls) mesh.setMatrixAt(k, m);
      }
    }
    [...sticks, ...balls].forEach((mesh, i) => {
      mesh.frustumCulled = false;
      mesh.renderOrder = i % 2 === 0 ? 4 : 5;
      group.add(mesh);
    });
  }

  function fillGaps(gaps: readonly CoverageGap[], hot: number | null, cx: number, cy: number) {
    clear(gapGroup);
    gaps.forEach((gap, i) => {
      const y = gap.z[1];
      const box: [number, number][] = [[gap.min[0], gap.min[1]], [gap.max[0], gap.min[1]], [gap.max[0], gap.max[1]], [gap.min[0], gap.max[1]]];
      const loops = gap.outline.filter((loop) => loop.length >= 3);
      const shown = loops.length ? loops : [box];
      for (const loop of shown) {
        const line = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(loop.map(([x, py]) => new THREE.Vector3(...scenePoint(x, py, y, cx, cy)))),
          gapLine,
        );
        line.renderOrder = 6;
        gapGroup.add(line);
      }
      const flat = (loop: [number, number][]) => loop.map(([x, py]) => new THREE.Vector2(x - cx, -(py - cy)));
      // A gap is one connected piece, so its largest loop is the outside and the rest are holes.
      const byArea = [...shown].sort((p, r) => Math.abs(THREE.ShapeUtils.area(flat(r))) - Math.abs(THREE.ShapeUtils.area(flat(p))));
      const shape = new THREE.Shape(flat(byArea[0]));
      shape.holes = byArea.slice(1).map((loop) => new THREE.Path(flat(loop)));
      const geometry = new THREE.ShapeGeometry(shape);
      geometry.rotateX(Math.PI / 2);
      geometry.translate(0, y, 0);
      const fill = new THREE.Mesh(geometry, i === hot ? gapHot : gapFill);
      fill.renderOrder = 5;
      gapGroup.add(fill);
    });
  }

  return {
    root,
    /** True when anything drawn changed. */
    set(next: SupportOverlay | null, origin: { cx: number; cy: number }) {
      const at = `${origin.cx},${origin.cy}`;
      const moved = at !== built.at;
      const hover = next?.hover ?? null;
      const selected = next?.selected ?? null;
      const gaps = next?.gaps ?? [];
      const hot = next?.hotGap ?? null;
      if (moved || hover !== built.hover) fillCapsules(hoverGroup, hover, hoverMats, origin.cx, origin.cy);
      if (moved || selected !== built.selected) fillCapsules(selectGroup, selected, selectMats, origin.cx, origin.cy);
      if (moved || gaps !== built.gaps || hot !== built.hot) fillGaps(gaps, hot, origin.cx, origin.cy);
      const low = next ? -(next.zLow - 1e-3) : 1e6;
      const high = next ? next.zHigh + 1e-3 : 1e6;
      const changed = moved || hover !== built.hover || selected !== built.selected || gaps !== built.gaps || hot !== built.hot
        || low !== slabLow.constant || high !== slabHigh.constant;
      built = { hover, selected, gaps, hot, at };
      slabLow.constant = low;
      slabHigh.constant = high;
      return changed;
    },
    recolor(colors: ThemeColors) {
      for (const mat of hoverMats) mat.color.setHex(hexToThree(colors.gizmoHot));
      for (const mat of selectMats) mat.color.setHex(hexToThree(colors.amber));
      for (const mat of [gapLine, gapFill, gapHot]) mat.color.setHex(hexToThree(colors.danger));
    },
  };
}

function applyPixelRatio(renderer: THREE.WebGLRenderer, low = false) {
  const dpr = low ? 1 : window.devicePixelRatio || 1;
  if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
}
