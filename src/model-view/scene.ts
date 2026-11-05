/** Scene setup: the renderer, camera, orbit controls, lights, bed reference, and the scene's top-level groups. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { hexToThree, themeColors } from "../theme";
import { mountBedReference, mountStudioLights, mountViewHelper, renderViewHelper } from "../viewport-chrome";
import { mountMeasureOverlay } from "../measure-overlay";
import { orbitGlide } from "../orbit-glide";
import { readAccent } from "./helpers";
import type { ViewCtx } from "./ctx";

export function installScene(ctx: ViewCtx): void {
  const { canvas } = ctx;
  ctx.paintBedColors = paintBedColors;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  ctx.renderer = renderer;
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  // A split shows its two sides by clipping the solid at the plane.
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  ctx.scene = scene;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  ctx.camera = camera;
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  ctx.controls = controls;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  const glide = orbitGlide(controls, camera);
  ctx.glide = glide;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.touches.ONE = THREE.TOUCH.ROTATE;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

  mountStudioLights(scene, "z-up");
  const viewHelper = mountViewHelper(camera, canvas);
  ctx.viewHelper = viewHelper;
  // A pixel check reads the frame it just drew. Users do not keep the drawing buffer.
  if (new URLSearchParams(location.search).get("perf") === "1") {
    const host = window as unknown as { __renderModelFrame?: () => void };
    host.__renderModelFrame = () => {
      renderer.render(scene, camera);
      renderViewHelper(renderer, viewHelper);
    };
  }
  ctx.colors = themeColors();
  const bedRef = mountBedReference(scene, "z-up");
  ctx.bedRef = bedRef;
  ctx.bed = { x: 220, y: 220, z: 250 };
  paintBedColors();

  ctx.accent = readAccent();
  renderer.setClearColor(hexToThree(ctx.colors.stage), 1);
  const measure = mountMeasureOverlay(canvas.parentElement ?? document.body, { scaleRight: 140 });
  ctx.measure = measure;
  const fit = document.createElement("p");
  ctx.fit = fit;
  fit.id = "modelFit";
  fit.className = "model-fit";
  fit.hidden = true;
  // E3. The size line is Inspect's Size row. Past the build volume, the status line says so too, as Inspect may be shut.
  const sizeRow = document.querySelector("#modelInspectSize");
  if (sizeRow) sizeRow.append(fit);
  else canvas.parentElement?.append(fit);
  const overChip = document.querySelector<HTMLElement>("#modelFitWarn");
  ctx.overChip = overChip;

  const context = new THREE.Group();
  ctx.context = context;
  /** The open solid's pose in model space. `body` inside it keeps the scale preview. */
  const posed = new THREE.Group();
  ctx.posed = posed;
  posed.matrixAutoUpdate = false;
  const body = new THREE.Group();
  ctx.body = body;
  posed.add(body);
  /** Stress colouring shares the solid's frame. clearBody leaves this group where it is. */
  const stressGroup = new THREE.Group();
  ctx.stressGroup = stressGroup;
  stressGroup.name = "stress";
  body.add(stressGroup);
  const stressMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  ctx.stressMaterial = stressMaterial;
  const ghosts = new THREE.Group();
  ctx.ghosts = ghosts;
  const handleGroup = new THREE.Group();
  ctx.handleGroup = handleGroup;
  /** Aspect lines in model space. Body-space lines (a scaled solid's box) are added to `body` instead. */
  const aspectGroup = new THREE.Group();
  ctx.aspectGroup = aspectGroup;
  /** The workplane datum: drawn once per size in its own U, V, W, and moved by a matrix to where the frame is. */
  const datum = new THREE.Group();
  ctx.datum = datum;
  datum.matrixAutoUpdate = false;
  datum.visible = false;
  scene.add(context, posed, datum, ghosts, handleGroup, aspectGroup);
  // --- P1: the dotted line to the face a drag lines up with. ---
  const alignLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineDashedMaterial({ color: 0x8d9780, dashSize: 1.5, gapSize: 1, transparent: true, opacity: 0.9, depthTest: false }),
  );
  ctx.alignLine = alignLine;
  alignLine.visible = false;
  alignLine.renderOrder = 4;
  alignLine.raycast = () => undefined;
  /** --- A7 model check --- outlines in model space, so a solid's pose and a mesh's pose share one draw. */
  const marks = new THREE.Group();
  ctx.marks = marks;
  scene.add(alignLine, marks);
  // --- S2 sketch: grid, reference, and entities, lifted toward the camera so they clear the solid. ---
  const sketchGroup = new THREE.Group();
  ctx.sketchGroup = sketchGroup;
  sketchGroup.visible = false;
  scene.add(sketchGroup);

  function paintBedColors() {
    bedRef.setColors(hexToThree(ctx.colors.bed), hexToThree(ctx.colors.bedMinor), hexToThree(ctx.colors.line), hexToThree(ctx.colors.teal));
  }
}
