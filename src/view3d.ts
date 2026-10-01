import * as THREE from "three";
import { syncBedGrid } from "./bed-grid";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { featureColor, SPEED_RAMP, SPEED_RANGE_MM_S, WEIGHT_RAMP, type ColorMode } from "./colors";
import { buildCutPlane, disposeTree, previewFrame, splitDragAt } from "./cut-plane";
import { GIZMO_SCREEN_PX, gizmoRadiusForPixels, parkLeftCameraSpace, snapStep } from "./gizmo-math";
import { clampSplit, roundSplit, type AxisBounds } from "./split-at";
import { fillHiddenKindMask, MARGIN_SHADE, MAX_KINDS, meshCenter, scenePoint } from "./preview-geom";
import { aimSection, anchor, clampOffset, normalize, sectionReach, threeClip, type SectionSpec, type Vec3 } from "./section-plane";
import { hexToThree, themeColors } from "./theme";

export interface LayerRange {
  ribbonStart: number;
  ribbonCount: number;
  faceStart: number;
  faceCount: number;
  travelStart: number;
  travelCount: number;
}

export interface RibbonBuffers {
  ranges: LayerRange[];
  kinds: string[];
  ribbonPos: Float32Array;
  ribbonInfo: Float32Array;
  facePos: Float32Array;
  faceInfo: Float32Array;
  travelPos: Float32Array;
  travelInfo: Float32Array;
  span: number;
  midZ: number;
  centerX: number;
  centerY: number;
  /** The camera reframes when this changes, and otherwise stays where the user left it. */
  frame: string;
}

export interface SliceView3d {
  setModel(min: number[], max: number[]): void;
  setGhost(positions: Float32Array | null): void;
  setBuffers(buffers: RibbonBuffers | null): void;
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
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;

  const root = new THREE.Group();
  scene.add(root);
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
  scene.add(cursor);
  const playGeo = new THREE.BufferGeometry();
  playGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  const playLine = new THREE.Line(playGeo, new THREE.LineBasicMaterial({ color: hexToThree(colors.amber), depthTest: false }));
  playLine.visible = false;
  playLine.renderOrder = 4;
  scene.add(playLine);

  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);
  const clipPlanes = [clipPlane];
  // Scene-space plane. Negative distance is the arrow side and is discarded in the fragment shader.
  const sectionPlane = { value: new THREE.Vector4(0, 1, 0, 1e6) };
  const sectionRig = buildSectionRig();
  scene.add(sectionRig.root);
  scene.add(sectionRig.gizmo);

  let ribbon: THREE.Mesh | null = null;
  let ghost: THREE.Mesh | null = null;
  let ghostSig = "";
  const ghostMat = new THREE.MeshBasicMaterial({ color: hexToThree(colors.mesh), clippingPlanes: clipPlanes });
  attachSectionClip(ghostMat, sectionPlane);
  let face: THREE.Mesh | null = null;
  let travelLines: THREE.LineSegments | null = null;
  let ranges: LayerRange[] = [];
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
  let planeSpec: { axis: "x" | "y"; at: number } | null = null;
  let planeCb: ((at: number) => void) | null = null;
  let section: SectionSpec | null = null;
  let sectionCb: ((section: SectionSpec, hud: string) => void) | null = null;
  let origin = { cx: 0, cy: 0 };
  let regionDrag = false;
  let sectionDrag: SectionDrag = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // Render only when something changed. Damping keeps emitting change
  // from controls.update() until the camera settles.
  let frameQueued = false;
  function requestRender() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(frame);
  }
  function frame() {
    frameQueued = false;
    controls.update();
    fitSection();
    renderer.render(scene, camera);
  }
  controls.addEventListener("change", requestRender);
  requestRender();

  function resize() {
    requestRender();
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    applyPixelRatio(renderer);
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  }

  function applyFocus() {
    if (ranges.length > 0 && ribbon && face && travelLines) {
      const lo = Math.max(0, Math.min(low, ranges.length - 1));
      const hi = Math.max(lo, Math.min(high, ranges.length - 1));
      const first = ranges[lo];
      const last = ranges[hi];
      ribbon.geometry.setDrawRange(first.ribbonStart, last.ribbonStart + last.ribbonCount - first.ribbonStart);
      face.geometry.setDrawRange(first.faceStart, last.faceStart + last.faceCount - first.faceStart);
      travelLines.geometry.setDrawRange(first.travelStart, last.travelStart + last.travelCount - first.travelStart);
      travelLines.visible = showTravel;
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

  function placePlane() {
    requestRender();
    const bounds = model ? asBounds(model.min, model.max) : null;
    const key = planeSpec && bounds
      ? `${planeSpec.axis}:${planeSpec.at.toFixed(2)}:${bounds.min.map((v) => v.toFixed(2)).join()}:${bounds.max.map((v) => v.toFixed(2)).join()}:${origin.cx.toFixed(2)}:${origin.cy.toFixed(2)}:${bedX}:${bedY}`
      : "";
    if (key === cutKey) return;
    cutKey = key;
    if (cut) {
      scene.remove(cut);
      disposeTree(cut);
      cut = null;
      cutPicks = [];
    }
    if (!planeSpec || !bounds) return;
    const built = buildCutPlane(planeSpec.axis, planeSpec.at, bounds, previewFrame(origin.cx, origin.cy), bedX, bedY);
    cut = built.group;
    cutPicks = built.picks;
    scene.add(cut);
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
    clipPlane.set(new THREE.Vector3(x, y, z), constant);
    sectionPlane.value.set(x, y, z, constant);
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
      canvas.style.cursor = sectionHit || regionHot ? "grab" : "";
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
    const raw = splitDragAt(raycaster.ray, planeSpec.axis, pivot, previewFrame(origin.cx, origin.cy), camera.position);
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
    canvas.style.cursor = "";
    paintRings(null);
    if (spun) emitSection("");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    if (!regionDrag && !sectionDrag) canvas.style.cursor = "";
  });

  function applyHidden() {
    fillHiddenKindMask(pathUniforms.hiddenKinds.value, kinds, hidden);
  }

  function dropBuffers() {
    if (ribbon) {
      root.remove(ribbon);
      ribbon.geometry.dispose();
      (ribbon.material as THREE.Material).dispose();
      ribbon = null;
    }
    if (face) {
      root.remove(face);
      face.geometry.dispose();
      (face.material as THREE.Material).dispose();
      face = null;
    }
    if (travelLines) {
      root.remove(travelLines);
      travelLines.geometry.dispose();
      (travelLines.material as THREE.Material).dispose();
      travelLines = null;
    }
    ranges = [];
  }

  return {
    resize,
    setBed(x, y, z) {
      bedX = x;
      bedY = y;
      bedZ = z;
    },
    setBuffers(buffers) {
      requestRender();
      dropBuffers();
      if (!buffers || buffers.ranges.length === 0) return;
      ranges = buffers.ranges;
      origin = { cx: buffers.centerX, cy: buffers.centerY };
      kinds = buffers.kinds;
      const palette = pathUniforms.palette.value;
      kinds.forEach((kind, i) => palette.set(linearRgb(featureColor(kind)), i * 3));
      applyHidden();
      ribbon = new THREE.Mesh(
        pathGeometry(buffers.ribbonPos, buffers.ribbonInfo),
        pathMaterial(pathUniforms, MARGIN_SHADE, 1, { side: THREE.DoubleSide }, clipPlanes),
      );
      face = new THREE.Mesh(
        pathGeometry(buffers.facePos, buffers.faceInfo),
        pathMaterial(pathUniforms, 1, 1, {
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }, clipPlanes),
      );
      travelLines = new THREE.LineSegments(
        pathGeometry(buffers.travelPos, buffers.travelInfo),
        pathMaterial(pathUniforms, 1, 0.7, { transparent: true }, clipPlanes),
      );
      root.add(ribbon);
      root.add(face);
      root.add(travelLines);
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
      bed.userData.gridKey = "";
      syncBedGrid(bed, bedX, bedY, hexToThree(colors.line), hexToThree(colors.bedMinor), bed.userData.cx ?? 0, bed.userData.cy ?? 0);
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
    setGhost(positions) {
      const sig = !positions || positions.length < 9
        ? ""
        : `${positions.length}:${positions[0]}:${positions[positions.length >> 1]}:${positions[positions.length - 1]}:${origin.cx.toFixed(3)}:${origin.cy.toFixed(3)}`;
      if (sig === ghostSig) return;
      ghostSig = sig;
      requestRender();
      if (ghost) {
        scene.remove(ghost);
        ghost.geometry.dispose();
        ghost = null;
      }
      if (!positions || positions.length < 9) return;
      const xyz = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        xyz[i] = positions[i] - origin.cx;
        xyz[i + 1] = positions[i + 2];
        xyz[i + 2] = -(positions[i + 1] - origin.cy);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(xyz, 3));
      geometry.computeVertexNormals();
      ghost = new THREE.Mesh(geometry, ghostMat);
      scene.add(ghost);
    },
    setModel(min, max) {
      const next = { min: [...min], max: [...max] };
      const same = !!model && model.min.every((v, i) => v === next.min[i]) && model.max.every((v, i) => v === next.max[i]);
      model = next;
      origin = meshCenter(min, max);
      if (!same && ranges.length === 0) {
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

function pathGeometry(pos: Float32Array, info: Float32Array) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("info", new THREE.BufferAttribute(info, 3));
  return geometry;
}

/** The legend's sRGB hex as the linear triple the shader works in, so both show the same color. */
const linearRgb = (hex: string) => new THREE.Color(hex).toArray() as [number, number, number];
const rgb = (hex: string) => `vec3(${linearRgb(hex).map((v) => v.toFixed(4)).join(", ")})`;
const [SPEED_LO, SPEED_HI] = SPEED_RANGE_MM_S;

/**
 * Colors each vertex from its (kind slot, blend weight, speed) triple; hidden kinds collapse off-screen.
 * `sectionPlane` is scene space (xyz = normal, w = constant). Fragments on the negative side are dropped.
 * The Three.js clipping chunks sample the same plane; a ShaderMaterial does not discard unless it does this itself.
 * `mvPosition` is the name those chunks expect.
 */
const PATH_VERTEX = `
attribute vec3 info;
uniform vec3 palette[${MAX_KINDS}];
uniform float hiddenKinds[${MAX_KINDS}];
uniform int mode;
uniform float shade;
uniform vec4 sectionPlane;
varying vec3 vColor;
varying float vSectionDist;
#include <clipping_planes_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  #include <clipping_planes_vertex>
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vSectionDist = dot(worldPos.xyz, sectionPlane.xyz) + sectionPlane.w;
  int kind = int(info.x + 0.5);
  if (hiddenKinds[kind] > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 color = palette[kind];
  if (mode == 1) color = mix(${rgb(WEIGHT_RAMP[0])}, ${rgb(WEIGHT_RAMP[1])}, info.y);
  if (mode == 2) color = mix(${rgb(SPEED_RAMP[0])}, ${rgb(SPEED_RAMP[1])}, clamp((info.z - ${SPEED_LO.toFixed(1)}) / ${(SPEED_HI - SPEED_LO).toFixed(1)}, 0.0, 1.0));
  vColor = color * shade;
  gl_Position = projectionMatrix * mvPosition;
}`;

const PATH_FRAGMENT = `
uniform float alpha;
varying vec3 vColor;
varying float vSectionDist;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
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
  clippingPlanes: THREE.Plane[],
) {
  return new THREE.ShaderMaterial({
    ...params,
    uniforms: { ...shared, shade: { value: shade }, alpha: { value: alpha } },
    vertexShader: PATH_VERTEX,
    fragmentShader: PATH_FRAGMENT,
    clipping: true,
    clippingPlanes,
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

function applyPixelRatio(renderer: THREE.WebGLRenderer) {
  const dpr = window.devicePixelRatio || 1;
  if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
}
