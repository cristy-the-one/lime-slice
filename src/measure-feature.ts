/**
 * The feature a Measure point lands on near a ray hit, for any mesh a view draws: Model's open solid and its grey
 * neighbours, and every object in Prepare. The features of one mesh are built once and held with it.
 */
import * as THREE from "three";
import { faceCentre, featuresOf, nearestFeature, type FeatureSet, type MeasureKind, type Vec3 } from "./measure-snap.ts";

/** A Measure point snaps to a feature this close to the pointer on screen. */
export const MEASURE_SNAP_PX = 10;

interface Held {
  set: FeatureSet;
  faces: Map<number, Vec3 | null>;
}

const held = new WeakMap<Float32Array, Held>();

function heldFor(positions: Float32Array, curves: readonly ArrayLike<number>[] | undefined): Held {
  let entry = held.get(positions);
  if (!entry) {
    entry = { set: featuresOf(positions, curves), faces: new Map() };
    held.set(positions, entry);
  }
  return entry;
}

/** Build the features of a mesh ahead of the first hover on it: on a large part that pass is a visible hitch. */
export function warmFeatures(positions: Float32Array, curves?: readonly ArrayLike<number>[]): void {
  heldFor(positions, curves);
}

export interface FeatureAt {
  /** In the world of the mesh's parent: where the feature is. */
  at: THREE.Vector3;
  kind: MeasureKind;
}

/**
 * The corner, edge middle, face middle, box point or circle centre nearest the pointer, where `hit` struck `mesh`, or
 * null when nothing is within `MEASURE_SNAP_PX` of the pointer on screen. `curves` are the B-rep edges of the mesh's
 * solid, when it has them. The mesh's world matrix must be current.
 */
export function featureAtHit(hit: THREE.Intersection, mesh: THREE.Mesh, camera: THREE.PerspectiveCamera, canvas: HTMLElement, curves?: readonly ArrayLike<number>[]): FeatureAt | null {
  const positions = mesh.geometry.getAttribute("position").array as Float32Array;
  const entry = heldFor(positions, curves);
  const height = Math.max(1, canvas.clientHeight);
  const perPx = (2 * camera.position.distanceTo(hit.point) * Math.tan((camera.fov * Math.PI) / 360)) / height;
  const local = mesh.worldToLocal(hit.point.clone());
  let face: Vec3 | null = null;
  if (hit.faceIndex != null) {
    if (!entry.faces.has(hit.faceIndex)) faceCentre(positions, hit.faceIndex, entry.faces);
    face = entry.faces.get(hit.faceIndex) ?? null;
  }
  const rect = canvas.getBoundingClientRect();
  const pointer = hit.point.clone().project(camera);
  const probe = new THREE.Vector3();
  const fromPointer = (at: Vec3) => {
    probe.set(at[0], at[1], at[2]).applyMatrix4(mesh.matrixWorld).project(camera);
    return Math.hypot(((probe.x - pointer.x) / 2) * rect.width, ((probe.y - pointer.y) / 2) * rect.height);
  };
  // Space is searched four pixels' worth wide, so a face seen at a slant still finds what is near the pointer on screen.
  const found = nearestFeature(entry.set, [local.x, local.y, local.z], MEASURE_SNAP_PX * perPx * 4, face, { px: MEASURE_SNAP_PX, from: fromPointer });
  if (!found) return null;
  return { at: mesh.localToWorld(new THREE.Vector3(found.at[0], found.at[1], found.at[2])), kind: found.kind };
}
