import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { boundsOf } from "./mesh-place";
import { buildCutPlane, disposeTree, prepareFrame, splitDragAt, type PrintFrame } from "./cut-plane";
import { clampSplit, roundSplit, type SplitAxis } from "./split-at";
import { hexToThree, themeColors } from "./theme";

export interface PrepareView {
  setMesh(positions: Float32Array | null, frameCamera?: boolean): void;
  setBed(x: number, y: number, z: number): void;
  setSplit(split: { axis: SplitAxis; at: number } | null): void;
  onSplit(cb: ((at: number) => void) | null): void;
  onRotate(cb: ((axis: "x" | "y" | "z", deltaDeg: number, totalDeg: number) => void) | null): void;
  onRotateEnd(cb: (() => void) | null): void;
  setTheme(): void;
  resize(): void;
}

const RING: Record<"x" | "y" | "z", number> = { x: 0xe85d4c, y: 0x8fce6a, z: 0x6aa7ff };

export function createPrepareView(canvas: HTMLCanvasElement): PrepareView {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const dpr = () => window.devicePixelRatio || 1;
  renderer.setPixelRatio(dpr());
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 8000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;

  const frame: PrintFrame = prepareFrame();
  let colors = themeColors();
  renderer.setClearColor(hexToThree(colors.stage), 1);

  let bed = new THREE.GridHelper(1, 10, hexToThree(colors.line), hexToThree(colors.bedMinor));
  scene.add(bed);
  const plateMat = new THREE.MeshBasicMaterial({ color: 0x161a22, side: THREE.DoubleSide });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), plateMat);
  plate.rotation.x = -Math.PI / 2;
  scene.add(plate);
  const bedEdge = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: hexToThree(colors.teal) }),
  );
  scene.add(bedEdge);
  const volumeMat = new THREE.LineBasicMaterial({ color: hexToThree(colors.teal), transparent: true, opacity: 0.4 });
  const volume = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), volumeMat);
  scene.add(volume);
  const triad = buildTriad();
  scene.add(triad);

  const material = new THREE.MeshStandardMaterial({ color: 0xc6f26d, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  let mesh: THREE.Mesh | null = null;
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(80, 160, 40);
  scene.add(key);

  const gizmo = new THREE.Group();
  gizmo.renderOrder = 6;
  scene.add(gizmo);
  const rings = new Map<"x" | "y" | "z", { show: THREE.Mesh; pick: THREE.Mesh }>();
  for (const axis of ["x", "y", "z"] as const) {
    const show = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.045, 12, 64),
      new THREE.MeshBasicMaterial({ color: RING[axis], depthTest: false, transparent: true, opacity: 0.95 }),
    );
    const pick = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.14, 8, 24),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    orientRing(show, axis);
    orientRing(pick, axis);
    show.renderOrder = 6;
    show.userData.axis = axis;
    pick.userData.axis = axis;
    pick.userData.pick = "ring";
    gizmo.add(show, pick);
    rings.set(axis, { show, pick });
  }
  const shaftGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Array(18).fill(0), 3));
  const shafts = new THREE.LineSegments(shaftGeo, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
  shafts.renderOrder = 6;
  gizmo.add(shafts);
  const axisLabels = {
    x: axisSprite("X", "#e85d4c"),
    y: axisSprite("Y", "#8fce6a"),
    z: axisSprite("Z", "#6aa7ff"),
  };
  gizmo.add(axisLabels.x, axisLabels.y, axisLabels.z);

  let cut: THREE.Group | null = null;
  let cutPicks: THREE.Object3D[] = [];
  let cutKey = "";
  let split: { axis: SplitAxis; at: number } | null = null;
  let meshBounds: ReturnType<typeof boundsOf> | null = null;

  let bedX = 220;
  let bedY = 220;
  let bedZ = 250;
  let splitCb: ((at: number) => void) | null = null;
  let rotateCb: ((axis: "x" | "y" | "z", deltaDeg: number, totalDeg: number) => void) | null = null;
  let rotateEndCb: (() => void) | null = null;

  const gizmoCenter = new THREE.Vector3();
  let gizmoRadius = 24;
  let drag: "cut" | "x" | "y" | "z" | null = null;
  let hoverAxis: "x" | "y" | "z" | null = null;
  let lastAngle = 0;
  let totalDeg = 0;
  let appliedDeg = 0;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let frameQueued = false;
  function requestRender() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(paint);
  }
  function paint() {
    frameQueued = false;
    controls.update();
    renderer.render(scene, camera);
  }
  controls.addEventListener("change", requestRender);

  function layoutBed() {
    bed.scale.set(bedX, 1, bedY);
    bed.position.set(bedX / 2, 0, -bedY / 2);
    plate.scale.set(bedX, bedY, 1);
    plate.position.set(bedX / 2, -0.04, -bedY / 2);
    volume.scale.set(bedX, bedZ, bedY);
    volume.position.set(bedX / 2, bedZ / 2, -bedY / 2);
    const y = 0.08;
    bedEdge.geometry.dispose();
    bedEdge.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, y, 0),
      new THREE.Vector3(bedX, y, 0),
      new THREE.Vector3(bedX, y, -bedY),
      new THREE.Vector3(0, y, -bedY),
    ]);
    triad.position.set(0, 0.2, 0);
    requestRender();
  }
  function frameBed() {
    camera.position.set(bedX * 0.85, bedZ * 0.55, bedY * 0.95);
    controls.target.set(bedX / 2, Math.min(30, bedZ * 0.12), -bedY / 2);
    controls.update();
    requestRender();
  }
  layoutBed();
  frameBed();

  function placeGizmo() {
    gizmo.visible = !!meshBounds;
    if (!meshBounds) return;
    const { min, max } = meshBounds;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    const cz = (min[2] + max[2]) / 2;
    gizmoCenter.copy(frame.toScene(cx, cy, cz));
    gizmo.position.copy(gizmoCenter);
    const sx = max[0] - min[0];
    const sy = max[1] - min[1];
    const sz = max[2] - min[2];
    gizmoRadius = 0.5 * Math.hypot(sx, sy, sz) + Math.max(6, 0.08 * Math.max(sx, sy, sz));
    for (const { show, pick } of rings.values()) {
      show.scale.setScalar(gizmoRadius);
      pick.scale.setScalar(gizmoRadius);
    }
    const r = gizmoRadius * 1.15;
    const pos = shafts.geometry.getAttribute("position") as THREE.BufferAttribute;
    const verts = [
      -r, 0, 0, r, 0, 0,
      0, 0, -r, 0, 0, r,
      0, -r, 0, 0, r, 0,
    ];
    pos.set(verts);
    pos.needsUpdate = true;
    shafts.geometry.computeBoundingSphere();
    const label = gizmoRadius * 1.28;
    axisLabels.x.position.set(label, 0, 0);
    axisLabels.y.position.set(0, 0, -label);
    axisLabels.z.position.set(0, label, 0);
    const s = Math.max(6, gizmoRadius * 0.28);
    for (const sprite of Object.values(axisLabels)) sprite.scale.set(s, s, 1);
  }

  function rebuildCut() {
    const key = split && meshBounds
      ? `${split.axis}:${split.at.toFixed(2)}:${meshBounds.min.map((v) => v.toFixed(2)).join()}:${meshBounds.max.map((v) => v.toFixed(2)).join()}:${bedX}:${bedY}`
      : "";
    if (key === cutKey) return;
    cutKey = key;
    if (cut) {
      scene.remove(cut);
      disposeTree(cut);
      cut = null;
      cutPicks = [];
    }
    if (!split || !meshBounds) return;
    const built = buildCutPlane(split.axis, split.at, meshBounds, frame, bedX, bedY);
    cut = built.group;
    cutPicks = built.picks;
    scene.add(cut);
    requestRender();
  }

  function ndc(ev: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
  }

  function hitRing(ev: PointerEvent): "x" | "y" | "z" | null {
    if (!meshBounds) return null;
    ndc(ev);
    const picks = [...rings.values()].map((r) => r.pick);
    const hit = raycaster.intersectObjects(picks, false)[0];
    const axis = hit?.object.userData.axis as "x" | "y" | "z" | undefined;
    return axis ?? null;
  }

  function hitCut(ev: PointerEvent): boolean {
    if (!split || cutPicks.length === 0) return false;
    ndc(ev);
    return raycaster.intersectObjects(cutPicks, false).length > 0;
  }

  function printAngle(axis: "x" | "y" | "z"): number | null {
    const dir = sceneAxis(axis);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, gizmoCenter);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    const print = frame.fromScene(hit);
    const c = frame.fromScene(gizmoCenter);
    const v = new THREE.Vector3(print[0] - c[0], print[1] - c[1], print[2] - c[2]);
    const ax = printAxis(axis);
    v.addScaledVector(ax, -v.dot(ax));
    if (v.lengthSq() < 1e-8) return null;
    const u = new THREE.Vector3();
    if (Math.abs(ax.x) < 0.9) u.crossVectors(ax, new THREE.Vector3(1, 0, 0));
    else u.crossVectors(ax, new THREE.Vector3(0, 1, 0));
    u.normalize();
    const w = new THREE.Vector3().crossVectors(ax, u);
    return Math.atan2(v.dot(w), v.dot(u));
  }

  function paintRings(active: "x" | "y" | "z" | null, hover: "x" | "y" | "z" | null) {
    for (const [axis, { show }] of rings) {
      const mat = show.material as THREE.MeshBasicMaterial;
      mat.color.setHex(axis === active || axis === hover ? 0xffffff : RING[axis]);
      mat.opacity = axis === active ? 1 : 0.92;
    }
    requestRender();
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const ring = hitRing(ev);
    if (ring) {
      drag = ring;
      const angle = printAngle(ring);
      lastAngle = angle ?? 0;
      totalDeg = 0;
      appliedDeg = 0;
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      paintRings(ring, null);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (hitCut(ev) && split && meshBounds) {
      drag = "cut";
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, { capture: true });

  canvas.addEventListener("pointermove", (ev) => {
    if (!drag) {
      const ring = hitRing(ev);
      canvas.style.cursor = ring || hitCut(ev) ? "grab" : "";
      if (ring !== hoverAxis) {
        hoverAxis = ring;
        paintRings(null, ring);
      }
      return;
    }
    canvas.style.cursor = "grabbing";
    ndc(ev);
    if (drag === "cut") {
      if (!split || !meshBounds) return;
      const { min, max } = meshBounds;
      const pivot: [number, number, number] = [
        split.axis === "x" ? split.at : (min[0] + max[0]) / 2,
        split.axis === "y" ? split.at : (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2,
      ];
      const raw = splitDragAt(raycaster.ray, split.axis, pivot, frame, camera.position);
      if (raw == null) return;
      const at = roundSplit(clampSplit(raw, meshBounds, split.axis));
      if (Math.abs(at - split.at) < 0.05) return;
      split = { ...split, at };
      cutKey = "";
      rebuildCut();
      splitCb?.(at);
      return;
    }
    const axis = drag;
    const angle = printAngle(axis);
    if (angle == null) return;
    let step = angle - lastAngle;
    while (step > Math.PI) step -= Math.PI * 2;
    while (step < -Math.PI) step += Math.PI * 2;
    lastAngle = angle;
    totalDeg += step * (180 / Math.PI);
    const target = ev.shiftKey ? Math.round(totalDeg / 15) * 15 : totalDeg;
    const send = target - appliedDeg;
    if (Math.abs(send) < 0.04) return;
    appliedDeg = target;
    rotateCb?.(axis, send, target);
    const rebased = printAngle(axis);
    if (rebased != null) lastAngle = rebased;
  });

  const endDrag = () => {
    const wasRotate = drag === "x" || drag === "y" || drag === "z";
    drag = null;
    hoverAxis = null;
    controls.enabled = true;
    canvas.style.cursor = "";
    paintRings(null, null);
    if (wasRotate) rotateEndCb?.();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  function framePart() {
    if (!meshBounds) return;
    const { min, max } = meshBounds;
    const mid = frame.toScene((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const dist = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 28) * 2.4;
    camera.position.set(mid.x + dist * 0.85, mid.y + dist * 0.62, mid.z + dist * 0.9);
    controls.target.copy(mid);
    controls.update();
    requestRender();
  }

  return {
    resize() {
      requestRender();
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const next = dpr();
      if (renderer.getPixelRatio() !== next) renderer.setPixelRatio(next);
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
    },
    setBed(x, y, z) {
      bedX = Math.max(10, x);
      bedY = Math.max(10, y);
      bedZ = Math.max(10, z);
      cutKey = "";
      layoutBed();
      rebuildCut();
    },
    setMesh(positions, frameCamera = false) {
      requestRender();
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh = null;
      }
      meshBounds = positions && positions.length >= 9 ? boundsOf(positions) : null;
      placeGizmo();
      cutKey = "";
      rebuildCut();
      if (!positions || positions.length < 9) return;
      const geometry = new THREE.BufferGeometry();
      const xyz = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        xyz[i] = positions[i];
        xyz[i + 1] = positions[i + 2];
        xyz[i + 2] = -positions[i + 1];
      }
      geometry.setAttribute("position", new THREE.BufferAttribute(xyz, 3));
      geometry.computeVertexNormals();
      mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      if (frameCamera) framePart();
    },
    setSplit(next) {
      split = next;
      rebuildCut();
    },
    onSplit(cb) { splitCb = cb; },
    onRotate(cb) { rotateCb = cb; },
    onRotateEnd(cb) { rotateEndCb = cb; },
    setTheme() {
      colors = themeColors();
      renderer.setClearColor(hexToThree(colors.stage), 1);
      (bedEdge.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.teal));
      volumeMat.color.setHex(hexToThree(colors.teal));
      const next = new THREE.GridHelper(1, 10, hexToThree(colors.line), hexToThree(colors.bedMinor));
      next.scale.copy(bed.scale);
      next.position.copy(bed.position);
      scene.remove(bed);
      bed.geometry.dispose();
      const mats = Array.isArray(bed.material) ? bed.material : [bed.material];
      mats.forEach((mat) => mat.dispose());
      bed = next;
      scene.add(bed);
      requestRender();
    },
  };
}

function orientRing(mesh: THREE.Mesh, axis: "x" | "y" | "z") {
  if (axis === "x") mesh.rotation.y = Math.PI / 2;
  else if (axis === "z") mesh.rotation.x = Math.PI / 2;
}

function sceneAxis(axis: "x" | "y" | "z") {
  if (axis === "x") return new THREE.Vector3(1, 0, 0);
  if (axis === "y") return new THREE.Vector3(0, 0, -1);
  return new THREE.Vector3(0, 1, 0);
}

function printAxis(axis: "x" | "y" | "z") {
  if (axis === "x") return new THREE.Vector3(1, 0, 0);
  if (axis === "y") return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

function axisSprite(text: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = color;
  ctx.font = "700 84px IBM Plex Sans, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.renderOrder = 7;
  return sprite;
}

function buildTriad() {
  const g = new THREE.Group();
  const len = 18;
  const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0, len, 0, 0,
    0, 0, 0, 0, 0, -len,
    0, 0, 0, 0, len, 0,
  ], 3));
  const colors = new Float32Array([
    0.91, 0.36, 0.30, 0.91, 0.36, 0.30,
    0.56, 0.81, 0.42, 0.56, 0.81, 0.42,
    0.42, 0.65, 1, 0.42, 0.65, 1,
  ]);
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false })));
  return g;
}
