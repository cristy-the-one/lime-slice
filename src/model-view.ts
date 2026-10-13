import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { gizmoRadiusForPixels } from "./gizmo-math";
import { dragLabel, dragValue, lineParam, moveFine, startFine, wrapDegrees, type DragHandle, type FinePointer, type Vec3 } from "./model-drag";
import { faceBoundarySegments, faceColor } from "./model-select";
import { hexToThree, themeColors } from "./theme";

export interface ModelPick {
  kind: "face" | "edge";
  index: number;
}

export interface ModelSolid {
  id: number;
  volumeMm3: number;
  positions: Float32Array;
  triangles: number[];
  edges: { id: number; lengthMm: number; points: Float32Array }[];
}

/** A local stand-in for the tool. The kernel runs on Apply, not while the numbers move. */
export type ModelGhost =
  | { kind: "box"; x: number; y: number; z: number; dx: number; dy: number; dz: number; turn?: Vec3 }
  | { kind: "cylinder"; x: number; y: number; z: number; radius: number; height: number; turn?: Vec3 }
  | { kind: "sphere"; x: number; y: number; z: number; radius: number }
  | { kind: "plane"; z: number }
  | { kind: "hole"; x: number; y: number; z: number; radius: number; depth: number }
  | { kind: "scale"; factor: number }
  | { kind: "blend"; edge: number; radius: number }
  | { kind: "measure"; a: Vec3; b: Vec3 };

/** A handle moved. `values` go into the handle's fields in order. */
export interface HandleDrag {
  handle: DragHandle;
  values: number[];
  phase: "move" | "end";
}

const EDGE_PX = 16;
/** On-screen length of one handle unit. An arrow is about this long. */
const HANDLE_PX = 92;
const IDLE_EDGE = 0x8d9780;

export interface ModelView {
  setSolid(solid: ModelSolid | null): void;
  setPickMode(mode: "face" | "edge"): void;
  highlight(picks: ModelPick[]): void;
  setGhost(ghost: ModelGhost | null): void;
  setTheme(): void;
  resize(): void;
  onPick(cb: (pick: ModelPick | null, shift: boolean) => void): void;
  setHandles(handles: DragHandle[]): void;
  onHandleDrag(cb: (drag: HandleDrag) => void): void;
}

export function createModelView(canvas: HTMLCanvasElement): ModelView {
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

  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(1, -1.4, 2);
  scene.add(key);

  let colors = themeColors();
  let accent = readAccent();
  renderer.setClearColor(hexToThree(colors.stage), 1);

  const body = new THREE.Group();
  const ghosts = new THREE.Group();
  const handleGroup = new THREE.Group();
  scene.add(body, ghosts, handleGroup);

  let solid: ModelSolid | null = null;
  let boundaries = new Map<number, number[]>();
  let center = new THREE.Vector3();
  let extent = 1;
  let mode: "face" | "edge" = "face";
  let mesh: THREE.Mesh | null = null;
  let edgeLines: THREE.LineSegments | null = null;
  let faceOutline: LineSegments2 | null = null;
  let selectedEdges: LineSegments2 | null = null;
  let hoverEdges: LineSegments2 | null = null;
  const fatLines: LineMaterial[] = [];
  let picks: ModelPick[] = [];
  let hover: ModelPick | null = null;
  let ghost: ModelGhost | null = null;
  let pickCb: (pick: ModelPick | null, shift: boolean) => void = () => {};
  let down: { x: number; y: number } | null = null;
  let running = false;
  let handleParts: HandlePart[] = [];
  let overHandle: string | null = null;
  let drag: ActiveDrag | null = null;
  let handleCb: (drag: HandleDrag) => void = () => {};
  const tip = document.createElement("div");
  tip.className = "model-drag-tip";
  tip.hidden = true;
  canvas.parentElement?.append(tip);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const projected = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);

  function readAccent(): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    return hexToThree(raw || "#a3e635");
  }

  function disposeObject(object: THREE.Object3D) {
    object.traverse((child) => {
      const geometry = (child as THREE.Mesh).geometry;
      geometry?.dispose();
      const material = (child as THREE.Mesh).material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    });
  }

  function clearBody() {
    for (const object of [mesh, edgeLines, faceOutline, selectedEdges, hoverEdges]) {
      if (!object) continue;
      body.remove(object);
      disposeObject(object);
    }
    mesh = null;
    edgeLines = null;
    faceOutline = null;
    selectedEdges = null;
    hoverEdges = null;
    fatLines.length = 0;
  }

  function clearGhosts() {
    for (const child of [...ghosts.children]) {
      ghosts.remove(child);
      disposeObject(child);
    }
  }

  function writeColor(hex: number, into: Float32Array, offset: number) {
    into[offset] = ((hex >> 16) & 255) / 255;
    into[offset + 1] = ((hex >> 8) & 255) / 255;
    into[offset + 2] = (hex & 255) / 255;
  }

  function paintFaces() {
    if (!mesh || !solid) return;
    const selected = new Set(picks.filter((pick) => pick.kind === "face").map((pick) => pick.index));
    const hoverFace = mode === "face" && hover?.kind === "face" ? hover.index : null;
    const attribute = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    solid.triangles.forEach((face, triangle) => {
      const hex = faceColor(face, selected.has(face), hoverFace === face, accent);
      const offset = triangle * 9;
      for (let vertex = 0; vertex < 3; vertex += 1) writeColor(hex, array, offset + vertex * 3);
    });
    attribute.needsUpdate = true;
  }

  function fatLine(positions: number[], width: number, opacity: number): LineSegments2 | null {
    if (positions.length < 6) return null;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({
      color: accent,
      linewidth: width,
      transparent: opacity < 1,
      opacity,
      depthTest: false,
      worldUnits: false,
    });
    material.resolution.copy(lineResolution());
    fatLines.push(material);
    const lines = new LineSegments2(geometry, material);
    lines.renderOrder = 3;
    lines.raycast = () => undefined;
    return lines;
  }

  function replaceLine(current: LineSegments2 | null, positions: number[], width: number, opacity: number): LineSegments2 | null {
    if (current) {
      body.remove(current);
      const material = current.material as LineMaterial;
      const index = fatLines.indexOf(material);
      if (index >= 0) fatLines.splice(index, 1);
      disposeObject(current);
    }
    const next = fatLine(positions, width, opacity);
    if (next) body.add(next);
    return next;
  }

  function paintLines() {
    const selectedFaces = picks.filter((pick) => pick.kind === "face").map((pick) => pick.index);
    const outline: number[] = [];
    for (const face of selectedFaces) outline.push(...(boundaries.get(face) ?? []));
    faceOutline = replaceLine(faceOutline, outline, 2.5, 1);

    const wanted = new Set(picks.filter((pick) => pick.kind === "edge").map((pick) => pick.index));
    selectedEdges = replaceLine(selectedEdges, edgePositions(wanted), 4, 1);

    const hoverEdge = mode === "edge" && hover?.kind === "edge" && !wanted.has(hover.index) ? hover.index : null;
    hoverEdges = replaceLine(hoverEdges, hoverEdge == null ? [] : edgePositions(new Set([hoverEdge])), 2, 0.8);
  }

  function edgePositions(ids: Set<number>): number[] {
    if (!solid || ids.size === 0) return [];
    const positions: number[] = [];
    for (const edge of solid.edges) {
      if (!ids.has(edge.id)) continue;
      const points = edge.points;
      for (let i = 0; i + 5 < points.length; i += 3) {
        positions.push(points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!, points[i + 4]!, points[i + 5]!);
      }
    }
    return positions;
  }

  function lineResolution() {
    return new THREE.Vector2(Math.max(1, renderer.domElement.width), Math.max(1, renderer.domElement.height));
  }

  function syncLineResolution() {
    const resolution = lineResolution();
    for (const material of fatLines) material.resolution.copy(resolution);
  }

  function applyScale() {
    const factor = ghost?.kind === "scale" && ghost.factor > 0 ? ghost.factor : 1;
    body.scale.setScalar(factor);
    body.position.set(center.x * (1 - factor), center.y * (1 - factor), center.z * (1 - factor));
  }

  function ghostMaterial(opacity: number) {
    return new THREE.MeshLambertMaterial({
      color: accent,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  function addGhostMesh(geometry: THREE.BufferGeometry, position: THREE.Vector3, opacity = 0.22) {
    const meshGhost = new THREE.Mesh(geometry, ghostMaterial(opacity));
    meshGhost.position.copy(position);
    meshGhost.renderOrder = 2;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.95 }),
    );
    edges.raycast = () => undefined;
    meshGhost.add(edges);
    ghosts.add(meshGhost);
    return meshGhost;
  }

  function pointCylinder(x: number, y: number, z: number, radius: number, height: number) {
    if (!(radius > 0) || !(height > 0)) return;
    const geometry = new THREE.CylinderGeometry(radius, radius, height, 32);
    const meshGhost = addGhostMesh(geometry, new THREE.Vector3(x, y, z));
    meshGhost.quaternion.setFromUnitVectors(yAxis, zAxis);
    return meshGhost;
  }

  function rebuildGhost() {
    clearGhosts();
    applyScale();
    const current = ghost;
    if (!current || !solid) return;
    if (current.kind === "box") {
      if (current.dx > 0 && current.dy > 0 && current.dz > 0) {
        const box = addGhostMesh(
          new THREE.BoxGeometry(current.dx, current.dy, current.dz),
          new THREE.Vector3(current.x + current.dx / 2, current.y + current.dy / 2, current.z + current.dz / 2),
        );
        box.quaternion.copy(turnQuaternion(current.turn));
      }
      return;
    }
    if (current.kind === "cylinder") {
      const cylinder = pointCylinder(current.x, current.y, current.z + current.height / 2, current.radius, current.height);
      cylinder?.quaternion.premultiply(turnQuaternion(current.turn));
      return;
    }
    if (current.kind === "measure") {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...current.a), new THREE.Vector3(...current.b)]),
        new THREE.LineDashedMaterial({ color: accent, dashSize: Math.max(extent / 60, 0.3), gapSize: Math.max(extent / 90, 0.2), depthTest: false, transparent: true }),
      );
      line.computeLineDistances();
      line.renderOrder = 5;
      line.raycast = () => undefined;
      ghosts.add(line);
      return;
    }
    if (current.kind === "sphere") {
      if (current.radius > 0) addGhostMesh(new THREE.SphereGeometry(current.radius, 28, 18), new THREE.Vector3(current.x, current.y, current.z));
      return;
    }
    if (current.kind === "hole") {
      pointCylinder(current.x, current.y, current.z - current.depth / 2, current.radius, current.depth);
      return;
    }
    if (current.kind === "plane") {
      const span = Math.max(extent * 1.45, 30);
      addGhostMesh(new THREE.PlaneGeometry(span, span), new THREE.Vector3(center.x, center.y, current.z), 0.2);
      return;
    }
    if (current.kind === "blend") {
      if (!(current.radius > 0)) return;
      const edge = solid.edges.find((item) => item.id === current.edge);
      if (!edge) return;
      const points: THREE.Vector3[] = [];
      for (let i = 0; i + 2 < edge.points.length; i += 3) {
        const next = new THREE.Vector3(edge.points[i], edge.points[i + 1], edge.points[i + 2]);
        const prev = points[points.length - 1];
        if (!prev || prev.distanceToSquared(next) > 1e-8) points.push(next);
      }
      if (points.length < 2) return;
      const curve = new THREE.CatmullRomCurve3(points);
      const tube = new THREE.TubeGeometry(curve, Math.max(8, points.length * 3), current.radius, 8, false);
      addGhostMesh(tube, new THREE.Vector3(), 0.38);
    }
  }

  function frame(positions: Float32Array) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    extent = size;
    const look = center.clone();
    const radius = size * Math.sqrt(3) / 2;
    const fov = (camera.fov * Math.PI) / 180;
    const narrow = canvas.clientWidth < 720;
    // A slim toolbar sits on the top of a phone canvas, so the solid sits just under it.
    if (narrow) look.z += size * 0.12;
    const dist = (radius / Math.sin(fov / 2)) * (narrow ? 1.7 : 1.35);
    camera.near = Math.max(0.01, dist / 200);
    camera.far = dist * 20;
    camera.position.copy(look).add(new THREE.Vector3(1, -1.15, 0.72).normalize().multiplyScalar(dist));
    controls.target.copy(look);
    camera.updateProjectionMatrix();
    controls.update();
  }

  function kick() {
    if (running) return;
    running = true;
    const frameLoop = () => {
      const hidden = canvas.closest("[hidden]") != null;
      if (hidden) {
        running = false;
        return;
      }
      controls.update();
      sizeHandles();
      renderer.render(scene, camera);
      requestAnimationFrame(frameLoop);
    };
    requestAnimationFrame(frameLoop);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(width, height, false);
    syncLineResolution();
    kick();
  }

  function pickFace(ev: PointerEvent): ModelPick | null {
    if (!mesh) return null;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(mesh, false)[0];
    if (!hit || hit.faceIndex == null || !solid) return null;
    const face = solid.triangles[hit.faceIndex];
    if (face == null) return null;
    return { kind: "face", index: face };
  }

  function project(x: number, y: number, z: number, rect: DOMRect): { x: number; y: number; z: number } {
    projected.set(x, y, z);
    body.localToWorld(projected);
    projected.project(camera);
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
      z: projected.z,
    };
  }

  function pickEdge(ev: PointerEvent): ModelPick | null {
    if (!solid) return null;
    const rect = canvas.getBoundingClientRect();
    let best: { index: number; distance: number } | null = null;
    for (const edge of solid.edges) {
      const points = edge.points;
      for (let i = 0; i + 5 < points.length; i += 3) {
        const a = project(points[i]!, points[i + 1]!, points[i + 2]!, rect);
        const b = project(points[i + 3]!, points[i + 4]!, points[i + 5]!, rect);
        if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) continue;
        const distance = segmentDistance(ev.clientX, ev.clientY, a.x, a.y, b.x, b.y);
        if (distance <= EDGE_PX && (best == null || distance < best.distance)) best = { index: edge.id, distance };
      }
    }
    return best ? { kind: "edge", index: best.index } : null;
  }

  function pickAt(ev: PointerEvent): ModelPick | null {
    return mode === "face" ? pickFace(ev) : pickEdge(ev);
  }

  function sameHover(next: ModelPick | null) {
    if (!hover || !next) return hover === next;
    return hover.kind === next.kind && hover.index === next.index;
  }

  function setHover(next: ModelPick | null) {
    if (sameHover(next)) return;
    const edges = hover?.kind === "edge" || next?.kind === "edge";
    hover = next;
    paintFaces();
    if (edges) paintLines();
    kick();
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || drag) return;
    const part = handleAt(ev.clientX, ev.clientY);
    if (!part) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    beginDrag(part.handle, ev);
  }, { capture: true });
  canvas.addEventListener("pointermove", (ev) => {
    if (drag) {
      if (ev.pointerId === drag.pointerId) moveDrag(ev);
      return;
    }
    if (down) return;
    const over = handleAt(ev.clientX, ev.clientY);
    setOverHandle(over?.handle.id ?? null);
    if (over) {
      setHover(null);
      return;
    }
    setHover(pickAt(ev));
  });
  const finishDrag = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const done = drag;
    drag = null;
    controls.enabled = true;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    tip.hidden = true;
    handleCb({ handle: done.handle, values: done.values, phase: "end" });
    paintHandles();
  };
  canvas.addEventListener("pointerup", finishDrag, { capture: true });
  canvas.addEventListener("pointercancel", finishDrag, { capture: true });
  canvas.addEventListener("pointerleave", () => {
    setHover(null);
    if (!drag) setOverHandle(null);
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!down || ev.button !== 0) return;
    const moved = (ev.clientX - down.x) ** 2 + (ev.clientY - down.y) ** 2;
    down = null;
    if (moved > 16) return;
    pickCb(pickAt(ev), ev.shiftKey);
    setHover(pickAt(ev));
  });

  return {
    setSolid(next) {
      clearBody();
      solid = next;
      picks = [];
      hover = null;
      boundaries = new Map();
      center.set(0, 0, 0);
      extent = 1;
      if (!next || next.positions.length < 9) {
        clearGhosts();
        ghost = null;
        applyScale();
        kick();
        return;
      }
      boundaries = faceBoundarySegments(next.positions, next.triangles);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(next.positions, 3));
      const color = new Float32Array(next.positions.length);
      geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
      geometry.computeVertexNormals();
      const material = new THREE.MeshLambertMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      mesh = new THREE.Mesh(geometry, material);
      body.add(mesh);
      const segments: number[] = [];
      for (const edge of next.edges) {
        const points = edge.points;
        for (let i = 0; i + 5 < points.length; i += 3) {
          segments.push(points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!, points[i + 4]!, points[i + 5]!);
        }
      }
      if (segments.length > 0) {
        const lines = new THREE.BufferGeometry();
        lines.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
        edgeLines = new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: IDLE_EDGE }));
        edgeLines.raycast = () => undefined;
        body.add(edgeLines);
      }
      paintFaces();
      frame(next.positions);
      rebuildGhost();
      resize();
    },
    setPickMode(next) {
      mode = next;
      hover = null;
      paintFaces();
      paintLines();
      kick();
    },
    highlight(next) {
      picks = next;
      paintFaces();
      paintLines();
      kick();
    },
    setGhost(next) {
      ghost = next;
      rebuildGhost();
      kick();
    },
    setTheme() {
      colors = themeColors();
      accent = readAccent();
      renderer.setClearColor(hexToThree(colors.stage), 1);
      paintFaces();
      paintLines();
      rebuildGhost();
      kick();
    },
    resize,
    onPick(cb) {
      pickCb = cb;
    },
    setHandles(next) {
      buildHandles(next);
      kick();
    },
    onHandleDrag(cb) {
      handleCb = cb;
    },
  };

  function handleColor(color: DragHandle["color"]): number {
    if (color === "x") return hexToThree(colors.axisX);
    if (color === "y") return hexToThree(colors.axisY);
    if (color === "z") return hexToThree(colors.axisZ);
    return accent;
  }

  function buildHandles(next: DragHandle[]) {
    for (const part of handleParts) {
      handleGroup.remove(part.root);
      disposeObject(part.root);
    }
    handleParts = next.map((handle) => handlePart(handle));
    for (const part of handleParts) handleGroup.add(part.root);
    if (overHandle && !next.some((handle) => handle.id === overHandle)) overHandle = null;
    paintHandles();
  }

  function handlePart(handle: DragHandle): HandlePart {
    const root = new THREE.Group();
    root.position.set(...handle.origin);
    const dir = new THREE.Vector3(...handle.dir).normalize();
    const material = new THREE.MeshBasicMaterial({ color: handleColor(handle.color), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
    const hidden = new THREE.MeshBasicMaterial({ visible: false });
    const shown: THREE.Mesh[] = [];
    const picks: THREE.Mesh[] = [];
    const place = (mesh: THREE.Mesh, from: THREE.Vector3, offset: number) => {
      mesh.quaternion.setFromUnitVectors(from, dir);
      mesh.position.copy(dir).multiplyScalar(offset);
      root.add(mesh);
    };
    if (handle.look === "arrow") {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.55, 10), material);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.098, 0.3, 14), material);
      const pick = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.85, 8), hidden);
      place(shaft, yAxis, 0.4);
      place(head, yAxis, 0.82);
      place(pick, yAxis, 0.55);
      shown.push(shaft, head);
      picks.push(pick);
    } else if (handle.look === "knob") {
      const knob = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), material);
      const pick = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), hidden);
      place(knob, yAxis, 0);
      place(pick, yAxis, 0);
      shown.push(knob);
      picks.push(pick);
    } else if (handle.look === "ring") {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.03, 10, 64), material);
      const pick = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.09, 8, 32), hidden);
      place(ring, zAxis, 0);
      place(pick, zAxis, 0);
      shown.push(ring);
      picks.push(pick);
    } else {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), material);
      const pick = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), hidden);
      place(dot, yAxis, 0);
      place(pick, yAxis, 0);
      shown.push(dot);
      picks.push(pick);
    }
    for (const mesh of [...shown, ...picks]) {
      mesh.renderOrder = handle.look === "ring" ? 6 : 7;
      mesh.frustumCulled = false;
    }
    return { handle, root, material, picks };
  }

  function paintHandles() {
    const hot = hexToThree(colors.gizmoHot);
    for (const part of handleParts) {
      const on = drag?.handle.id === part.handle.id || (!drag && overHandle === part.handle.id);
      part.material.color.setHex(on ? hot : handleColor(part.handle.color));
    }
    canvas.style.cursor = drag ? "grabbing" : overHandle ? "grab" : "";
    kick();
  }

  function setOverHandle(next: string | null) {
    if (overHandle === next) return;
    overHandle = next;
    paintHandles();
  }

  function sizeHandles() {
    const height = canvas.clientHeight;
    const grips: string[] = [];
    for (const part of handleParts) {
      const distance = camera.position.distanceTo(part.root.position);
      const size = gizmoRadiusForPixels(distance, camera.fov, height, HANDLE_PX, camera.zoom);
      part.root.scale.setScalar(size);
      const at = gripPoint(part.handle, size).project(camera);
      grips.push(`${part.handle.id}:${Math.round((at.x * 0.5 + 0.5) * canvas.clientWidth)},${Math.round((-at.y * 0.5 + 0.5) * height)}`);
    }
    const text = grips.join(" ");
    if (canvas.dataset.handles !== text) canvas.dataset.handles = text;
  }

  /** Where a pointer grabs a handle: an arrow's head, a ring's rim, or a knob or dot itself. */
  function gripPoint(handle: DragHandle, size: number): THREE.Vector3 {
    const origin = new THREE.Vector3(...handle.origin);
    const dir = new THREE.Vector3(...handle.dir).normalize();
    if (handle.look === "arrow") return origin.addScaledVector(dir, 0.82 * size);
    if (handle.look !== "ring") return origin;
    const toCamera = camera.position.clone().sub(origin);
    let rim = toCamera.sub(dir.clone().multiplyScalar(toCamera.dot(dir)));
    if (rim.lengthSq() < 1e-9) rim = Math.abs(dir.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(dir) : new THREE.Vector3(1, 0, 0).cross(dir);
    const side = rim.normalize().cross(dir);
    return origin.addScaledVector(side, 0.7 * size);
  }

  function rayAt(x: number, y: number) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((x - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointer.y = -((y - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return raycaster.ray;
  }

  function handleAt(x: number, y: number): HandlePart | null {
    if (handleParts.length === 0) return null;
    sizeHandles();
    handleGroup.updateMatrixWorld(true);
    rayAt(x, y);
    let best: { part: HandlePart; rank: number; distance: number } | null = null;
    for (const part of handleParts) {
      const hit = raycaster.intersectObjects(part.picks, false)[0];
      if (!hit) continue;
      // Knobs and dots sit on arrows, and arrows inside rings, so the smaller target wins an overlap.
      const rank = part.handle.look === "ring" ? 2 : part.handle.look === "arrow" ? 1 : 0;
      if (!best || rank < best.rank || (rank === best.rank && hit.distance < best.distance)) best = { part, rank, distance: hit.distance };
    }
    return best?.part ?? null;
  }

  function ringAngle(handle: DragHandle, x: number, y: number): number | null {
    const ray = rayAt(x, y);
    const normal = new THREE.Vector3(...handle.dir).normalize();
    const origin = new THREE.Vector3(...handle.origin);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
    if (Math.abs(ray.direction.dot(normal)) < 0.05) return null;
    const hit = ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    const u = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(normal).normalize() : new THREE.Vector3(1, 0, 0).cross(normal).normalize();
    const v = normal.clone().cross(u);
    const offset = hit.sub(origin);
    return (Math.atan2(offset.dot(v), offset.dot(u)) * 180) / Math.PI;
  }

  function axisParam(handle: DragHandle, x: number, y: number): number | null {
    const ray = rayAt(x, y);
    const dir = new THREE.Vector3(...handle.dir).normalize();
    return lineParam(handle.origin, [dir.x, dir.y, dir.z], [ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z]);
  }

  function surfacePoint(x: number, y: number, snap: boolean): Vec3 | null {
    if (!mesh) return null;
    rayAt(x, y);
    const hit = raycaster.intersectObject(mesh, false)[0];
    if (!hit) return null;
    const point = body.worldToLocal(hit.point.clone());
    if (snap && hit.faceIndex != null) {
      const positions = mesh.geometry.getAttribute("position");
      let best: THREE.Vector3 | null = null;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = new THREE.Vector3().fromBufferAttribute(positions, hit.faceIndex * 3 + corner);
        if (!best || vertex.distanceToSquared(point) < best.distanceToSquared(point)) best = vertex;
      }
      if (best) point.copy(best);
    }
    return [point.x, point.y, point.z];
  }

  function beginDrag(handle: DragHandle, ev: PointerEvent) {
    const fine = startFine(ev.clientX, ev.clientY, ev.shiftKey);
    drag = {
      handle,
      pointerId: ev.pointerId,
      fine,
      values: [...handle.values],
      startParam: handle.kind === "axis" ? axisParam(handle, ev.clientX, ev.clientY) : null,
      lastAngle: handle.kind === "ring" ? ringAngle(handle, ev.clientX, ev.clientY) : null,
      turned: 0,
    };
    paintHandles();
    showTip(ev);
  }

  function moveDrag(ev: PointerEvent) {
    const current = drag;
    if (!current) return;
    const fine = ev.shiftKey;
    const snap = ev.ctrlKey || ev.metaKey;
    current.fine = moveFine(current.fine, ev.clientX, ev.clientY, fine);
    const { x, y } = current.fine;
    const handle = current.handle;
    let next: number[] | null = null;
    if (handle.kind === "axis") {
      const param = axisParam(handle, x, y);
      if (param != null && current.startParam != null) next = [dragValue(handle, handle.values[0] ?? 0, param - current.startParam, snap, fine)];
    } else if (handle.kind === "ring") {
      const angle = ringAngle(handle, x, y);
      if (angle != null) {
        if (current.lastAngle != null) current.turned += wrapDegrees(angle - current.lastAngle);
        current.lastAngle = angle;
        next = [wrapDegrees(dragValue(handle, handle.values[0] ?? 0, current.turned, snap, fine))];
      }
    } else {
      const point = surfacePoint(x, y, snap);
      const places = fine ? 100 : 10;
      if (point) next = point.map((value) => Math.round(value * places) / places);
    }
    if (next && next.some((value, i) => value !== current.values[i])) {
      current.values = next;
      handleCb({ handle, values: next, phase: "move" });
    }
    showTip(ev);
  }

  function showTip(ev: PointerEvent) {
    if (!drag) return;
    const parent = canvas.parentElement?.getBoundingClientRect();
    if (!parent) return;
    tip.textContent = dragLabel(drag.handle, drag.values);
    tip.style.left = `${ev.clientX - parent.left + 14}px`;
    tip.style.top = `${ev.clientY - parent.top + 14}px`;
    tip.hidden = false;
  }
}

interface HandlePart {
  handle: DragHandle;
  root: THREE.Group;
  material: THREE.MeshBasicMaterial;
  picks: THREE.Mesh[];
}

interface ActiveDrag {
  handle: DragHandle;
  pointerId: number;
  fine: FinePointer;
  values: number[];
  startParam: number | null;
  lastAngle: number | null;
  turned: number;
}

/** R = Rz·Ry·Rx for degrees, the order the kernel turns a primitive. */
function turnQuaternion(turn: Vec3 | undefined): THREE.Quaternion {
  if (!turn) return new THREE.Quaternion();
  const rad = Math.PI / 180;
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(turn[0] * rad, turn[1] * rad, turn[2] * rad, "ZYX"));
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const abx = bx - ax;
  const aby = by - ay;
  const length2 = abx * abx + aby * aby;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / length2));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}
