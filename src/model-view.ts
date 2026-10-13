import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
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

const PALETTE = [0x8fb83a, 0x3d8bfd, 0xe0a045, 0x2ec4b6, 0xc46b4a, 0x9b7ed9];
const SELECTED = 0xffd34d;
const EDGE_PX = 12;

export interface ModelView {
  setSolid(solid: ModelSolid | null): void;
  setPickMode(mode: "face" | "edge"): void;
  highlight(picks: ModelPick[]): void;
  setTheme(): void;
  resize(): void;
  onPick(cb: (pick: ModelPick) => void): void;
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

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(1, -1.4, 2);
  scene.add(key);

  let colors = themeColors();
  renderer.setClearColor(hexToThree(colors.stage), 1);

  let solid: ModelSolid | null = null;
  let mode: "face" | "edge" = "face";
  let mesh: THREE.Mesh | null = null;
  let edgeLines: THREE.LineSegments | null = null;
  let selectedLines: THREE.LineSegments | null = null;
  let picks: ModelPick[] = [];
  let pickCb: (pick: ModelPick) => void = () => {};
  let down: { x: number; y: number } | null = null;
  let running = false;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const projected = new THREE.Vector3();

  function clearGeometry() {
    for (const object of [mesh, edgeLines, selectedLines]) {
      if (!object) continue;
      scene.remove(object);
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
    }
    mesh = null;
    edgeLines = null;
    selectedLines = null;
  }

  function colorOf(hex: number, into: Float32Array, offset: number) {
    into[offset] = ((hex >> 16) & 255) / 255;
    into[offset + 1] = ((hex >> 8) & 255) / 255;
    into[offset + 2] = hex & 255 ? (hex & 255) / 255 : 0;
  }

  function paintFaces() {
    if (!mesh || !solid) return;
    const selected = picks.find((pick) => pick.kind === "face")?.index ?? null;
    const attribute = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    solid.triangles.forEach((face, triangle) => {
      const hex = face === selected ? SELECTED : PALETTE[Math.abs(face) % PALETTE.length]!;
      const offset = triangle * 9;
      for (let vertex = 0; vertex < 3; vertex += 1) colorOf(hex, array, offset + vertex * 3);
    });
    attribute.needsUpdate = true;
  }

  function paintEdges() {
    if (selectedLines) {
      scene.remove(selectedLines);
      selectedLines.geometry.dispose();
      (selectedLines.material as THREE.Material).dispose();
      selectedLines = null;
    }
    if (!solid) return;
    const wanted = new Set(picks.filter((pick) => pick.kind === "edge").map((pick) => pick.index));
    if (wanted.size === 0) return;
    const positions: number[] = [];
    for (const edge of solid.edges) {
      if (!wanted.has(edge.id)) continue;
      const points = edge.points;
      for (let i = 0; i + 5 < points.length; i += 3) {
        positions.push(points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!, points[i + 4]!, points[i + 5]!);
      }
    }
    if (positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: SELECTED, depthTest: false });
    selectedLines = new THREE.LineSegments(geometry, material);
    selectedLines.renderOrder = 2;
    scene.add(selectedLines);
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
    const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    const radius = size * Math.sqrt(3) / 2;
    const fov = (camera.fov * Math.PI) / 180;
    const narrow = canvas.clientWidth < 720;
    // The phone overlay sits on the top of the canvas, so the solid is framed under it.
    if (narrow) center.z += size * 0.55;
    const dist = (radius / Math.sin(fov / 2)) * (narrow ? 1.85 : 1.35);
    camera.near = Math.max(0.01, dist / 200);
    camera.far = dist * 20;
    camera.position.copy(center).add(new THREE.Vector3(1, -1.15, 0.72).normalize().multiplyScalar(dist));
    controls.target.copy(center);
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
    projected.set(x, y, z).project(camera);
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

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    down = { x: ev.clientX, y: ev.clientY };
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!down || ev.button !== 0) return;
    const moved = (ev.clientX - down.x) ** 2 + (ev.clientY - down.y) ** 2;
    down = null;
    if (moved > 16) return;
    const pick = mode === "face" ? pickFace(ev) : pickEdge(ev);
    if (pick) pickCb(pick);
  });

  return {
    setSolid(next) {
      clearGeometry();
      solid = next;
      picks = [];
      if (!next || next.positions.length < 9) {
        kick();
        return;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(next.positions, 3));
      const color = new Float32Array(next.positions.length);
      geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
      geometry.computeVertexNormals();
      const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
      mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
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
        edgeLines = new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: hexToThree(colors.muted) }));
        scene.add(edgeLines);
      }
      paintFaces();
      frame(next.positions);
      resize();
    },
    setPickMode(next) {
      mode = next;
    },
    highlight(next) {
      picks = next;
      paintFaces();
      paintEdges();
      kick();
    },
    setTheme() {
      colors = themeColors();
      renderer.setClearColor(hexToThree(colors.stage), 1);
      if (edgeLines) (edgeLines.material as THREE.LineBasicMaterial).color.set(hexToThree(colors.muted));
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
