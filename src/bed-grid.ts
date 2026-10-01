import * as THREE from "three";

const MINOR_MM = 10;
const MAJOR_MM = 50;

/** Major and minor lines on the build plate, in print millimetres. Origin sits at (0, 0). */
export function syncBedGrid(
  group: THREE.Group,
  width: number,
  depth: number,
  minorColor: number,
  majorColor: number,
  centerX = 0,
  centerY = 0,
) {
  const w = Math.max(MINOR_MM, width);
  const d = Math.max(MINOR_MM, depth);
  const key = `${w.toFixed(2)}:${d.toFixed(2)}:${minorColor}:${majorColor}`;
  group.userData.cx = centerX;
  group.userData.cy = centerY;
  if (group.userData.gridKey !== key) {
    group.userData.gridKey = key;
    clearGroup(group);
    group.add(buildLines(w, d, minorColor, majorColor));
  }
  group.position.set(-centerX, 0, centerY);
}

function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((node) => {
      const mesh = node as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((item) => item.dispose());
      else mat?.dispose();
    });
  }
}

function buildLines(width: number, depth: number, minorColor: number, majorColor: number) {
  const minor: number[] = [];
  const major: number[] = [];
  const y = 0.03;
  const bucketFor = (value: number, limit: number) =>
    value <= 0.01 || Math.abs(value - limit) <= 0.01 || Math.round(value) % MAJOR_MM === 0 ? major : minor;
  for (let x = 0; x <= width + 0.01; x += MINOR_MM) {
    bucketFor(x, width).push(x, y, 0, x, y, -depth);
  }
  for (let z = 0; z <= depth + 0.01; z += MINOR_MM) {
    bucketFor(z, depth).push(0, y, -z, width, y, -z);
  }
  const root = new THREE.Group();
  addLines(root, minor, minorColor, 0.7);
  addLines(root, major, majorColor, 1);
  return root;
}

function addLines(root: THREE.Group, pts: number[], color: number, opacity: number) {
  if (pts.length < 6) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  root.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity })));
}
