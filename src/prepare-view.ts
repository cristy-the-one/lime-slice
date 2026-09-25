import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export interface PrepareView {
  setMesh(positions: Float32Array | null): void;
  setBed(x: number, y: number, z: number): void;
  resize(): void;
}

export function createPrepareView(canvas: HTMLCanvasElement): PrepareView {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0c0e12, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 8000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;

  const bed = new THREE.GridHelper(1, 10, 0x3a4254, 0x242a36);
  scene.add(bed);
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x161a22, side: THREE.DoubleSide }),
  );
  plate.rotation.x = -Math.PI / 2;
  scene.add(plate);
  const volume = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0x2ec4b6, transparent: true, opacity: 0.55 }),
  );
  scene.add(volume);
  const material = new THREE.MeshStandardMaterial({ color: 0xc6f26d, roughness: 0.55, metalness: 0.05 });
  let mesh: THREE.Mesh | null = null;
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(80, 160, 40);
  scene.add(key);

  let bedX = 220;
  let bedY = 220;
  let bedZ = 250;

  function frame() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function placeVolume() {
    bed.scale.set(bedX, 1, bedY);
    bed.position.set(bedX / 2, 0, -bedY / 2);
    plate.scale.set(bedX, bedY, 1);
    plate.position.set(bedX / 2, -0.05, -bedY / 2);
    volume.scale.set(bedX, bedZ, bedY);
    volume.position.set(bedX / 2, bedZ / 2, -bedY / 2);
    camera.position.set(bedX * 0.85, bedZ * 0.72, bedY * 0.95);
    controls.target.set(bedX / 2, Math.min(40, bedZ * 0.15), -bedY / 2);
    controls.update();
  }
  placeVolume();

  return {
    resize() {
      const rect = canvas.getBoundingClientRect();
      renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
      camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
      camera.updateProjectionMatrix();
    },
    setBed(x, y, z) {
      bedX = Math.max(10, x);
      bedY = Math.max(10, y);
      bedZ = Math.max(10, z);
      placeVolume();
    },
    setMesh(positions) {
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh = null;
      }
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
    },
  };
}
