import * as THREE from "three";
import type { MeasureFrame } from "./measure-overlay";

const scratch = new THREE.Vector3();

/**
 * How a perspective view turns print millimetres into pixels of its canvas box, and how far one pixel spans at the
 * orbit target. `place` writes a print point's position in the scene into its second argument. Call after the
 * frame is rendered, so the camera's matrices are current.
 */
export function perspectiveMeasure(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  w: number,
  h: number,
  place: (p: readonly [number, number, number], out: THREE.Vector3) => void,
): Pick<MeasureFrame, "project" | "mmPerPx"> {
  const reach = 2 * camera.position.distanceTo(target) * Math.tan((camera.fov * Math.PI) / 360) / camera.zoom;
  return {
    mmPerPx: reach / Math.max(1, h),
    project(p) {
      place(p, scratch);
      scratch.applyMatrix4(camera.matrixWorldInverse);
      if (scratch.z > -camera.near) return null;
      scratch.applyMatrix4(camera.projectionMatrix);
      return [(scratch.x * 0.5 + 0.5) * w, (-scratch.y * 0.5 + 0.5) * h];
    },
  };
}
