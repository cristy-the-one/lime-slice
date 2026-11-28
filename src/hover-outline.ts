/**
 * The hover outline (`src/hover.ts`): the contour of the object under the pointer, as seen on screen. The object is drawn
 * flat white into an off-screen mask, with nothing in front of it, and a full-screen pass lays a thick bright line over
 * the main picture where the mask's edge is. So the line is the silhouette only, never an interior edge, and it shows in
 * full even where another object stands in front. Loaded on the first hover, so none of it is in the first chunk.
 */
import * as THREE from "three";
import { hexToThree } from "./theme";
import type { HoverHit } from "./hover";

/** Line width in CSS pixels, centred on the contour. */
const WIDTH_PX = 4;
/** Mask geometries kept, newest last. */
const KEPT = 6;

export interface HoverOutline {
  show(hit: HoverHit): void;
  hide(): void;
  setColor(hex: string): void;
  resize(): void;
  /** Lay the outline over the picture the renderer has just drawn. Nothing when none is shown. */
  paint(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  readonly visible: boolean;
}

const VERTEX = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAGMENT = `
uniform sampler2D mask;
uniform vec2 texel;
uniform float radius;
uniform vec3 tint;
varying vec2 vUv;
void main() {
  float centre = texture2D(mask, vUv).r;
  float lo = centre, hi = centre;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 0.39269908;
    vec2 d = vec2(cos(a), sin(a)) * texel * radius;
    float m = texture2D(mask, vUv + d).r;
    lo = min(lo, m);
    hi = max(hi, m);
    float m2 = texture2D(mask, vUv + d * 0.5).r;
    lo = min(lo, m2);
    hi = max(hi, m2);
  }
  if (hi < 0.5 || lo > 0.5) discard;
  gl_FragColor = vec4(tint, 1.0);
  #include <colorspace_fragment>
}`;

export function createHoverOutline(_scene: THREE.Scene, _canvas: HTMLCanvasElement, color: string): HoverOutline {
  const target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const maskScene = new THREE.Scene();
  const maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), maskMaterial);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  mesh.visible = false;
  maskScene.add(mesh);
  const held = new Map<Float32Array, THREE.BufferGeometry>();

  const pass = new THREE.ShaderMaterial({
    uniforms: { mask: { value: target.texture }, texel: { value: new THREE.Vector2(1, 1) }, radius: { value: WIDTH_PX }, tint: { value: new THREE.Color(hexToThree(color)) } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), pass);
  quad.frustumCulled = false;
  quadScene.add(quad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  return {
    show(hit) {
      let geometry = held.get(hit.positions);
      if (!geometry) {
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(hit.positions, 3));
        held.set(hit.positions, geometry);
        for (const [positions, old] of held) {
          if (held.size <= KEPT) break;
          if (old !== geometry) { old.dispose(); held.delete(positions); }
        }
      }
      mesh.geometry = geometry;
      mesh.matrix.copy(hit.matrixWorld);
      mesh.matrixWorld.copy(hit.matrixWorld);
      mesh.visible = true;
    },
    hide() {
      mesh.visible = false;
    },
    setColor(hex) {
      (pass.uniforms.tint!.value as THREE.Color).setHex(hexToThree(hex));
    },
    resize() {
      /* The mask follows the drawing buffer each time it is painted. */
    },
    paint(renderer, camera) {
      if (!mesh.visible) return;
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
      (pass.uniforms.texel!.value as THREE.Vector2).set(1 / size.x, 1 / size.y);
      pass.uniforms.radius!.value = (WIDTH_PX / 2) * renderer.getPixelRatio();
      const before = renderer.getRenderTarget();
      const clear = renderer.getClearColor(new THREE.Color());
      const clearAlpha = renderer.getClearAlpha();
      const auto = renderer.autoClear;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(maskScene, camera);
      renderer.setRenderTarget(before);
      renderer.setClearColor(clear, clearAlpha);
      renderer.autoClear = false;
      renderer.render(quadScene, quadCamera);
      renderer.autoClear = auto;
    },
    get visible() {
      return mesh.visible;
    },
  };
}
