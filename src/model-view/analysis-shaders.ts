/**
 * --- Organic surfaces S1: GPU reflection Zebra shader & Isoparm line material ---
 * Uses exact OCCT analytic vertex normals so G0 (broken), G1 (kinked), and G2 (flowing) seams
 * read cleanly at interactive frame rates without inflating triangle counts.
 */
import * as THREE from "three";
import type { LookState } from "../model-look";

const ZEBRA_VERTEX = `
#include <common>
#include <clipping_planes_pars_vertex>
varying vec3 vViewNormal;
varying vec3 vViewPos;
varying vec3 vWorldNormal;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPos = -mvPosition.xyz;
  vViewNormal = normalize(normalMatrix * normal);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

/** The stripe body, shared by the viewport shader and the continuity test. */
export const ZEBRA_STRIPE_BODY = `
  vec3 N = normalize(vViewNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(vViewPos);
  vec3 R = reflect(-V, N);

  // Choose band coordinate: view-locked reflection bands (default), world horizontal, or world vertical.
  float coord = R.y;
  if (uAxis == 1) {
    vec3 wN = normalize(vWorldNormal);
    if (!gl_FrontFacing) wN = -wN;
    coord = wN.z;
  } else if (uAxis == 2) {
    vec3 wN = normalize(vWorldNormal);
    if (!gl_FrontFacing) wN = -wN;
    coord = atan(wN.y, wN.x) / 3.14159265;
  }

  float phase = coord * uStripes;
  float wave = sin(phase * 3.14159265);
  float aa = max(fwidth(wave), 0.015);
  float stripe = smoothstep(-aa, aa, wave);

  // Subtle key-light modulation keeps 3D depth legible inside both black and white bands.
  float key = 0.78 + 0.22 * max(dot(N, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
  vec3 darkBand = vec3(0.09, 0.10, 0.11) * key;
  vec3 lightBand = vec3(0.95, 0.96, 0.94) * key;
  vec3 col = mix(darkBand, lightBand, stripe);
  gl_FragColor = vec4(col, uOpacity);
`;

const ZEBRA_FRAGMENT = `
#include <common>
#include <clipping_planes_pars_fragment>
uniform float uStripes;
uniform int uAxis;
uniform float uOpacity;
varying vec3 vViewNormal;
varying vec3 vViewPos;
varying vec3 vWorldNormal;
void main() {
  #include <clipping_planes_fragment>
  ${ZEBRA_STRIPE_BODY}
}
`;


/** Create the shared Zebra reflection ShaderMaterial with clipping plane support. */
export function createZebraMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: ZEBRA_VERTEX,
    fragmentShader: ZEBRA_FRAGMENT,
    uniforms: {
      uStripes: { value: 12.0 },
      uAxis: { value: 0 },
      uOpacity: { value: 1.0 },
    },
    clipping: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

/** Synchronize Zebra uniforms & opacity with current LookState and sketch-dim flag. */
export function syncZebraMaterial(material: THREE.ShaderMaterial, look: LookState, dimmed: boolean): void {
  const stripes = Math.max(4, Math.min(40, Number.isFinite(look.zebraStripes) ? look.zebraStripes : 12));
  const axis = look.zebraAxis === "horizontal" ? 1 : look.zebraAxis === "vertical" ? 2 : 0;
  const opacity = dimmed ? 0.35 : 1.0;
  material.uniforms.uStripes!.value = stripes;
  material.uniforms.uAxis!.value = axis;
  material.uniforms.uOpacity!.value = opacity;
  if (material.transparent !== dimmed) {
    material.transparent = dimmed;
    material.needsUpdate = true;
  }
}

/** Shared material for UV surface-grid (isoparm) line overlays. */
export function createIsoMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  });
}
