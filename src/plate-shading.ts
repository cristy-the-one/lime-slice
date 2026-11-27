/**
 * The first chunk's whole share of smooth plate shading: hooks, empty until src/plate-shading-carry.ts loads (with
 * Model's code, or the background call after a project opens). Until then every mesh is drawn as before.
 */
import type { BufferGeometry } from "three";

/** A view whose plate meshes the carry module shades in place, and reports for the tests. */
export interface ShadedView {
  /** Every plate mesh the view draws, by its array: the selected part's first (null when none), then the others'. */
  meshes(): ([Float32Array, BufferGeometry] | null)[];
  canvas: HTMLElement;
  render(): void;
}

export const plateShading: {
  /** Gives a new geometry its exact normals when its mesh has them. */
  shade: ((geometry: BufferGeometry, positions: Float32Array) => void) | null;
  views: ShadedView[];
  /** A uniformly scaled copy of a plate mesh (Prepare draws `scaledCanonical`), and the plate mesh it was made from. */
  aliases: WeakMap<Float32Array, Float32Array>;
} = { shade: null, views: [], aliases: new WeakMap() };
