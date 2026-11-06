/** The frame loop: camera framing and publishing, resize, and the redraw kick. */
import * as THREE from "three";
import { type Affine, posedBounds } from "../model-space";
import { boundsOf } from "../mesh-place";
import type { Box } from "../measure";
import { STILL_FRAMES } from "./constants";
import { lerpPose } from "../sketch/frame";
import { onMeasureChange } from "../measure-pref";
import { renderViewHelper } from "../viewport-chrome";
import type { ViewCtx } from "./ctx";

export function installFrame(ctx: ViewCtx): void {
  const { camera, canvas, controls, glide, posed, renderer, scene, sketchGroup, viewHelper } = ctx;
  ctx.frameBox = frameBox;
  ctx.kick = kick;
  ctx.measureSolid = measureSolid;
  ctx.publishCamera = publishCamera;
  ctx.resize = resize;
  ctx.setPosedMatrix = setPosedMatrix;

  let running = false;
  /** Frames drawn with nothing changing; past `STILL_FRAMES` the loop stops until the next `kick`. */
  let still = 0;
  let sketchViewCamera = "";
  let sketchViewing = false;

  /** The solid's centre in its own frame, which a scale preview grows about, and its largest side. */
  function measureSolid(positions: Float32Array) {
    const own = boundsOf(positions);
    ctx.ownBox = own;
    ctx.center = new THREE.Vector3((own.min[0] + own.max[0]) / 2, (own.min[1] + own.max[1]) / 2, (own.min[2] + own.max[2]) / 2);
    ctx.extent = Math.max(own.max[0] - own.min[0], own.max[1] - own.min[1], own.max[2] - own.min[2], 1);
  }

  function setPosedMatrix(next: Affine) {
    ctx.poseNow = next;
    const { m, t } = next;
    posed.matrix.set(m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2], 0, 0, 0, 1);
    posed.updateMatrixWorld(true);
    ctx.solidBox = ctx.solid && ctx.solid.positions.length >= 9 ? posedBounds(ctx.solid.positions, next) : null;
    const text = ctx.solidBox ? [...ctx.solidBox.min, ...ctx.solidBox.max].map((value) => value.toFixed(2)).join(",") : "";
    if (text) canvas.dataset.solid = text;
    else delete canvas.dataset.solid;
  }

  /** The one framing every caller shares: the box's centre, seen from the front right and above, the box filling the view. */
  function frameBox(box: Box) {
    const look = new THREE.Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
    const size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2], 1);
    const radius = size * Math.sqrt(3) / 2;
    const fov = (camera.fov * Math.PI) / 180;
    const narrow = canvas.clientWidth < 720;
    // A slim toolbar sits on the top of a phone canvas, so the solid sits just under it.
    if (narrow) look.z += size * 0.12;
    const dist = (radius / Math.sin(fov / 2)) * (narrow ? 1.7 : 1.35);
    camera.near = Math.max(0.01, dist / 200);
    camera.far = dist * 20;
    // An orbit still gliding would carry on past the reset: let it land first, undamped.
    controls.enableDamping = false;
    controls.update();
    camera.position.copy(look).add(new THREE.Vector3(1, -1.15, 0.72).normalize().multiplyScalar(dist));
    controls.target.copy(look);
    camera.updateProjectionMatrix();
    controls.update();
    controls.enableDamping = true;
    kick();
  }

  /** The camera as `x,y,z;tx,ty,tz` to a tenth of a millimetre, so a test can tell one view from another. */
  function publishCamera() {
    const p = camera.position;
    const t = controls.target;
    const text = `${[p.x, p.y, p.z].map((value) => value.toFixed(1)).join(",")};${[t.x, t.y, t.z].map((value) => value.toFixed(1)).join(",")}`;
    if (canvas.dataset.camera !== text) canvas.dataset.camera = text;
    // --- S2: the grid follows the camera, and only when the camera actually moved. ---
    if (sketchGroup.visible && text !== sketchViewCamera && !sketchViewing) {
      sketchViewCamera = text;
      sketchViewing = true;
      try {
        ctx.sketchViewCb();
      } finally {
        sketchViewing = false;
      }
    } else sketchViewCamera = text;
  }

  /**
   * Draw from the next frame on, until the view has been still for a few frames. Every change to what the view shows
   * kicks it, and so do the controls while the camera moves or glides, so a view nobody touches draws nothing: drawing
   * the same frame over and over took the processor the modeler needed (a check on the back cover ran 0.4 s alone and
   * 1.2 s beside the view in a browser drawing without a graphics card).
   */
  function kick() {
    still = 0;
    if (running) return;
    running = true;
    let lastPaint = performance.now();
    const frameLoop = () => {
      const hidden = canvas.closest("[hidden]") != null;
      if (hidden) {
        running = false;
        return;
      }
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastPaint) / 1000);
      lastPaint = now;
      if (viewHelper.animating) {
        controls.enabled = false;
        viewHelper.update(dt);
        if (!viewHelper.animating && ctx.sketchPointerId == null) controls.enabled = true;
      }
      let moved = false;
      // --- S2: a turn onto the plane is ours. OrbitControls would fight a new up vector. ---
      if (ctx.sketchAnim) {
        const t = (now - ctx.sketchAnim.start) / Math.max(1, ctx.sketchAnim.ms);
        ctx.applySketchPose(lerpPose(ctx.sketchAnim.from, ctx.sketchAnim.to, t));
        if (t >= 1) {
          const lock = ctx.sketchAnim.lock;
          ctx.sketchAnim = null;
          ctx.applySketchLock(lock);
        }
        moved = true;
      } else {
        moved = glide(now);
        if (ctx.sketchLock) ctx.holdSketchAxis();
      }
      ctx.placeSketchOffset();
      publishCamera();
      ctx.sizeHandles();
      viewHelper.center.copy(controls.target);
      renderer.render(scene, camera);
      renderViewHelper(renderer, viewHelper);
      ctx.drawMeasure();
      ctx.paintFit();
      ctx.placeTags();
      still = moved || viewHelper.animating ? 0 : still + 1;
      if (still > STILL_FRAMES) {
        running = false;
        return;
      }
      requestAnimationFrame(frameLoop);
    };
    requestAnimationFrame(frameLoop);
  }
  controls.addEventListener("change", kick);
  controls.addEventListener("start", kick);
  onMeasureChange(kick);
  new ResizeObserver(() => kick()).observe(canvas);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(width, height, false);
    ctx.syncLineResolution();
    kick();
  }
}
