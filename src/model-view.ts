import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
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
  | { kind: "box"; x: number; y: number; z: number; dx: number; dy: number; dz: number }
  | { kind: "cylinder"; x: number; y: number; z: number; radius: number; height: number }
  | { kind: "sphere"; x: number; y: number; z: number; radius: number }
  | { kind: "plane"; z: number }
  | { kind: "hole"; x: number; y: number; z: number; radius: number; depth: number }
  | { kind: "scale"; factor: number }
  | { kind: "blend"; edge: number; radius: number };

const EDGE_PX = 16;
const IDLE_EDGE = 0x8d9780;

export interface ModelView {
  setSolid(solid: ModelSolid | null): void;
  setPickMode(mode: "face" | "edge"): void;
  highlight(picks: ModelPick[]): void;
  setGhost(ghost: ModelGhost | null): void;
  setTheme(): void;
  resize(): void;
  onPick(cb: (pick: ModelPick | null, shift: boolean) => void): void;
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
  scene.add(body, ghosts);

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
  }

  function rebuildGhost() {
    clearGhosts();
    applyScale();
    const current = ghost;
    if (!current || !solid) return;
    if (current.kind === "box") {
      if (current.dx > 0 && current.dy > 0 && current.dz > 0) {
        addGhostMesh(
          new THREE.BoxGeometry(current.dx, current.dy, current.dz),
          new THREE.Vector3(current.x + current.dx / 2, current.y + current.dy / 2, current.z + current.dz / 2),
        );
      }
      return;
    }
    if (current.kind === "cylinder") {
      pointCylinder(current.x, current.y, current.z + current.height / 2, current.radius, current.height);
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
    if (ev.button !== 0) return;
    down = { x: ev.clientX, y: ev.clientY };
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (down) return;
    setHover(pickAt(ev));
  });
  canvas.addEventListener("pointerleave", () => setHover(null));
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
  };
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const abx = bx - ax;
  const aby = by - ay;
  const length2 = abx * abx + aby * aby;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / length2));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}
