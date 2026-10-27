import type * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** OrbitControls damps once per call; a call stands for one frame at this rate. */
const STEP_MS = 1000 / 60;
/** A frame after a long stall catches up at most this many steps. */
const MAX_STEPS = 30;
/** The glide ends once all that is left of it moves the view less than this. */
const SETTLE_PX = 0.25;

/**
 * Moves OrbitControls by wall-clock time and ends the glide once the rest of it is under a pixel. The controls damp
 * per call and report change until the camera moves less than a micrometre: about 120 calls after an orbit. One call
 * a frame made that two seconds at 60 fps, and half a minute of redrawing in a browser drawing without a graphics card.
 * Returns whether the camera moved.
 */
export function orbitGlide(controls: OrbitControls, camera: THREE.PerspectiveCamera): (now: number) => boolean {
  let last = -1;
  const eye = camera.position.clone();
  const aim = controls.target.clone();
  return (now) => {
    // The first frame after a still view is one step, so a new drag does not jump.
    const steps = last < 0 ? 1 : Math.min(MAX_STEPS, Math.max(1, Math.round((now - last) / STEP_MS)));
    let moved = false;
    for (let i = 0; i < steps; i++) {
      eye.copy(camera.position);
      aim.copy(controls.target);
      if (controls.update()) moved = true;
    }
    last = moved ? now : -1;
    const height = (controls.domElement as HTMLElement | null)?.clientHeight ?? 0;
    if (!moved || !controls.enableDamping || height < 1) return moved;
    const step = Math.max(eye.distanceTo(camera.position), aim.distanceTo(controls.target));
    const damping = controls.dampingFactor;
    const pixel = (2 * camera.position.distanceTo(controls.target) * Math.tan((camera.fov * Math.PI) / 360)) / (camera.zoom * height);
    // Each step moves the last one times (1 - damping), so what is left sums to step * (1 - damping) / damping.
    if ((step * (1 - damping)) / damping < SETTLE_PX * pixel) {
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = true;
      last = -1;
    }
    return moved;
  };
}
