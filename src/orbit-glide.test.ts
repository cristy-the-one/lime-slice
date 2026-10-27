import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { orbitGlide } from "./orbit-glide.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

type Rig = { camera: THREE.PerspectiveCamera; controls: OrbitControls & { _rotateLeft(angle: number): void } };

/** The Preview view's camera: 300 mm from the target, in a view 800 px tall. */
function rig(): Rig {
  const camera = new THREE.PerspectiveCamera(40, 1.5, 0.1, 5000);
  camera.position.set(0, 100, 280);
  const controls = new OrbitControls(camera) as Rig["controls"];
  controls.domElement = { clientHeight: 800 } as HTMLElement;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();
  return { camera, controls };
}

/** Frames, `ms` apart, until the camera stops, after an orbit of `angle`. */
function settle({ controls }: Rig, step: (now: number) => boolean, angle: number, ms: number): number {
  controls._rotateLeft(angle);
  let frames = 0;
  while (step(1000 + frames * ms)) frames += 1;
  return frames;
}

// One update a frame, as before: about 120 frames whatever the frame rate.
const plain = rig();
const plainFrames = settle(plain, () => plain.controls.update(), 0.9, 1000 / 60);
check("plain damping runs past 100 frames", plainFrames > 100, `${plainFrames}`);

const fast = rig();
const fastFrames = settle(fast, orbitGlide(fast.controls, fast.camera), 0.9, 1000 / 60);
check("at 60 fps the sub-pixel tail is skipped", fastFrames < plainFrames - 10, `${fastFrames} vs ${plainFrames}`);

const slow = rig();
const slowFrames = settle(slow, orbitGlide(slow.controls, slow.camera), 0.9, 250);
check("at 4 fps the glide ends within 3 s", slowFrames * 250 <= 3000, `${slowFrames} frames`);
// A pixel at the target is 2 * 296 mm * tan(20°) / 800 px, about 0.27 mm.
check("the glide ends where plain damping does", slow.camera.position.distanceTo(plain.camera.position) < 0.27, slow.camera.position.distanceTo(plain.camera.position).toFixed(4));
check("so does the 60 fps one", fast.camera.position.distanceTo(plain.camera.position) < 0.27, fast.camera.position.distanceTo(plain.camera.position).toFixed(4));

// A frame after a still view damps one step, so a drag after a long idle does not jump.
const idle = rig();
const glide = orbitGlide(idle.controls, idle.camera);
const before = idle.controls.getAzimuthalAngle();
idle.controls._rotateLeft(0.5);
glide(60_000);
const turned = Math.abs(idle.controls.getAzimuthalAngle() - before);
check("the first frame after idle turns one damping step", Math.abs(turned - 0.5 * 0.08) < 1e-6, turned.toFixed(6));

if (failed > 0) {
  console.error(`${failed} orbit-glide check(s) failed`);
  process.exit(1);
}
console.log("orbit-glide ok");
