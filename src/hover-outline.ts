/**
 * The hover outline (`src/hover.ts`): one thick line object per view, bright, drawn over everything else so a part
 * behind another is still plainly marked. It outlines the part's sharp edges, as the views' own outlines do; a smooth
 * solid with none gets its box. Loaded on the first hover, so the line shader is not in the first chunk.
 */
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { sharpEdges } from "./mesh-edges";
import { boundsOf } from "./mesh-place";
import { hexToThree } from "./theme";
import type { HoverHit } from "./hover";

/** Edges sharper than this crease are outlined, as in Pose and Model. */
const EDGE_ANGLE_DEG = 30;
/** Line width in screen pixels: thick enough to read at a glance on a part's far side. */
const WIDTH_PX = 4;
/** Outlines kept, so GPU buffers stay few. */
const KEPT = 6;

export interface HoverOutline {
  show(hit: HoverHit): void;
  hide(): void;
  setColor(hex: string): void;
  /** The canvas changed size: the line's width is in pixels. */
  resize(): void;
  /** The outline is on screen. */
  readonly visible: boolean;
}

function boxSegments(positions: Float32Array): Float32Array {
  const box = boundsOf(positions);
  const c = (x: number, y: number, z: number) => [box.min[0] * (1 - x) + box.max[0] * x, box.min[1] * (1 - y) + box.max[1] * y, box.min[2] * (1 - z) + box.max[2] * z];
  const out: number[] = [];
  const pairs: [number[], number[]][] = [];
  for (const a of [0, 1]) for (const b of [0, 1]) {
    pairs.push([c(0, a, b), c(1, a, b)], [c(a, 0, b), c(a, 1, b)], [c(a, b, 0), c(a, b, 1)]);
  }
  for (const [p, q] of pairs) out.push(...p!, ...q!);
  return new Float32Array(out);
}

export function createHoverOutline(scene: THREE.Scene, canvas: HTMLCanvasElement, color: string): HoverOutline {
  const material = new LineMaterial({ color: hexToThree(color), linewidth: WIDTH_PX, depthTest: false, depthWrite: false, transparent: true });
  /** The last few parts' outlines, newest last: a pointer going back and forth over two parts builds each once. */
  const held = new Map<Float32Array, LineSegmentsGeometry>();
  const line = new LineSegments2(new LineSegmentsGeometry(), material);
  line.matrixAutoUpdate = false;
  line.frustumCulled = false;
  line.renderOrder = 1000;
  line.visible = false;
  line.raycast = () => undefined;
  scene.add(line);

  function resize() {
    material.resolution.set(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight));
  }
  resize();

  return {
    show(hit) {
      let geometry = held.get(hit.positions);
      if (!geometry) {
        geometry = new LineSegmentsGeometry();
        const edges = sharpEdges(hit.positions, EDGE_ANGLE_DEG);
        geometry.setPositions(edges.length >= 6 ? edges : boxSegments(hit.positions));
        held.set(hit.positions, geometry);
        for (const [positions, old] of held) {
          if (held.size <= KEPT) break;
          if (old !== geometry) { old.dispose(); held.delete(positions); }
        }
      }
      line.geometry = geometry;
      line.matrix.copy(hit.matrixWorld);
      line.matrixWorld.copy(hit.matrixWorld);
      line.visible = true;
      resize();
    },
    hide() {
      line.visible = false;
    },
    setColor(hex) {
      material.color.setHex(hexToThree(hex));
    },
    resize,
    get visible() {
      return line.visible;
    },
  };
}
