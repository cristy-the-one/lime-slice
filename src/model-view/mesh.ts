/** The open solid's meshes: building, disposing and painting its faces, edges, outlines and check marks. */
import * as THREE from "three";
import type { Bounds } from "../mesh-place";
import { IDLE_EDGE, STRESS_LOAD } from "./constants";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { ModelSolid } from "./types";
import { boxEdges, boxList, dashSegments } from "./helpers";
import { drawnEdgeSegments, smoothNormalsOf } from "./smooth";
import { colourRuns, fillFace, fillFaces } from "./face-colours";
import { facePaint } from "../model-look";
import { faceTriangles } from "../model-select";
import { hexToThree } from "../theme";
import type { ViewCtx } from "./ctx";

export function installMesh(ctx: ViewCtx): void {
  const { body, canvas, datumLines, fatLines, ghosts, marks, renderer, snapLineMat } = ctx;
  ctx.applyScale = applyScale;
  ctx.clearBody = clearBody;
  ctx.clearGhosts = clearGhosts;
  ctx.clearPreview = clearPreview;
  ctx.disposeObject = disposeObject;
  ctx.fatLine = fatLine;
  ctx.lineResolution = lineResolution;
  ctx.paintFaces = paintFaces;
  ctx.paintLines = paintLines;
  ctx.paintMarks = paintMarks;
  ctx.repaintPreview = repaintPreview;
  ctx.showPreview = showPreview;
  ctx.syncLineResolution = syncLineResolution;

  // --- A7 model check ---
  let locatedLines: LineSegments2 | null = null;
  let checkLines: LineSegments2 | null = null;
  // --- end A3 ---

  /** Geometry a ghost borrows from the grey objects; `setContext` frees it once no object uses it. */
  const borrowed = new WeakSet<THREE.BufferGeometry>();
  ctx.borrowed = borrowed;

  function disposeObject(object: THREE.Object3D) {
    object.traverse((child) => {
      const geometry = (child as THREE.Mesh).geometry;
      if (geometry !== ctx.primitiveGeometry?.shaded && geometry !== ctx.primitiveGeometry?.edges && !borrowed.has(geometry)) geometry?.dispose();
      const material = (child as THREE.Mesh).material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    });
  }

  /** One material each for every solid shown, so a new shape does not compile the shader again. */
  const solidMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.05,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  ctx.solidMaterial = solidMaterial;
  canvas.dataset.solidOpacity = "1";
  const edgeMaterial = new THREE.LineBasicMaterial({ color: IDLE_EDGE });
  ctx.edgeMaterial = edgeMaterial;

  function clearPreview() {
    if (!ctx.preview) return;
    for (const object of [ctx.preview.mesh, ctx.preview.lines]) {
      if (!object) continue;
      body.remove(object);
      object.geometry.dispose();
    }
    ctx.preview = null;
    if (ctx.mesh) ctx.mesh.visible = true;
    if (ctx.edgeLines) ctx.edgeLines.visible = true;
    delete canvas.dataset.preview;
    paintFaces();
    ctx.rebuildCap();
  }

  /**
   * The shape's mesh and edges, coloured as a solid is, drawn where the solid is; the solid hides while it is up. With
   * no solid open (a plugin that builds its own parts) it is drawn in model space.
   */
  function showPreview(shape: ModelSolid) {
    clearPreview();
    if (shape.positions.length < 9) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(shape.positions, 3));
    const color = new Float32Array(shape.positions.length);
    const used = paintColours(shape, color, new Set(), null);
    publishFaceColours(used);
    geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
    const smooth = smoothNormalsOf(shape.positions, shape.triangles);
    geometry.setAttribute("normal", new THREE.BufferAttribute(smooth.normals, 3));
    const shaded = new THREE.Mesh(geometry, solidMaterial);
    shaded.raycast = () => undefined;
    body.add(shaded);
    const { segments } = drawnEdgeSegments(shape.edges, shape.seams);
    let lines: THREE.LineSegments | null = null;
    if (segments.length > 0) {
      const edges = new THREE.BufferGeometry();
      edges.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
      lines = new THREE.LineSegments(edges, edgeMaterial);
      lines.raycast = () => undefined;
      body.add(lines);
    }
    if (ctx.mesh) ctx.mesh.visible = false;
    if (ctx.edgeLines) ctx.edgeLines.visible = false;
    ctx.preview = { shape, mesh: shaded, lines };
    canvas.dataset.preview = String(shape.volumeMm3.toFixed(2));
    ctx.rebuildCap();
  }

  function clearBody() {
    clearPreview();
    ctx.clearSectionCap();
    for (const object of [ctx.mesh, ctx.edgeLines]) {
      if (!object) continue;
      body.remove(object);
      object.geometry.dispose();
    }
    for (const object of [ctx.faceOutline, ctx.selectedEdges, ctx.hoverEdges, ctx.flaggedEdges, ctx.litEdge]) {
      if (!object) continue;
      body.remove(object);
      disposeObject(object);
    }
    ctx.mesh = null;
    ctx.edgeLines = null;
    ctx.faceOutline = null;
    ctx.selectedEdges = null;
    ctx.hoverEdges = null;
    ctx.flaggedEdges = null;
    ctx.litEdge = null;
    fatLines.length = 0;
  }

  function clearGhosts() {
    ctx.posedPrimitive = null;
    for (const child of [...ghosts.children]) {
      ghosts.remove(child);
      // A split's offcut draws the solid's own geometry with a shared material: neither is the ghost's to free.
      if (!child.userData.borrowed) disposeObject(child);
    }
  }

  /** --- A10. One colour for a face of `shape`: its step, the accent when it is selected, or the idle grey. */
  function paintColours(shape: ModelSolid, into: Float32Array, selected: Set<number>, pickHover: number | null): Set<string> {
    const used = new Set<string>();
    const paintOf = painter(shape, selected, pickHover);
    fillFaces(into, shape.triangles, (face) => {
      const painted = paintOf(face);
      if (painted.stepHex) used.add(painted.stepHex);
      return painted.hex;
    });
    return used;
  }

  /** The accent a selected face takes: red for a face a shell removes, teal while a workplane is picked. */
  function tintNow(): number {
    return ctx.removedFaces ? hexToThree(ctx.colors.danger) : ctx.datumPick ? hexToThree(ctx.colors.teal) : ctx.accent;
  }

  /**
   * A face has one colour, so it is worked out once a face, not once a triangle: with colour by step on, each
   * call builds the step's colour from its hue, and a part has thousands of faces.
   */
  function painter(shape: ModelSolid, selected: Set<number>, pickHover: number | null): (face: number) => ReturnType<typeof facePaint> {
    const tint = tintNow();
    const paints = new Map<number, ReturnType<typeof facePaint>>();
    return (face) => {
      let painted = paints.get(face);
      if (painted) return painted;
      const owner = shape.stepFaces && face < shape.stepFaces.length ? (shape.stepFaces[face] ?? null) : null;
      painted = facePaint({
        index: face,
        owner,
        selected: selected.has(face),
        pickHover: pickHover === face,
        stepHover: ctx.highlightStep != null && owner === ctx.highlightStep,
        colourByStep: ctx.look.colourByStep,
        accent: tint,
        study: shape === ctx.solid ? stressTint(face) : null,
      });
      paints.set(face, painted);
      return painted;
    };
  }

  /** The load wins over the hold on a face that is both, as the load arrow sits on it. */
  function stressTint(face: number): number | null {
    if (ctx.stressLoad.has(face)) return STRESS_LOAD;
    if (ctx.stressHold.has(face)) return hexToThree(ctx.colors.paintEnforce);
    return null;
  }

  function publishFaceColours(used: Set<string>) {
    const text = [...used].sort().join(" ");
    if (text) canvas.dataset.faceColors = text;
    else delete canvas.dataset.faceColors;
  }

  /**
   * What the solid's colour buffer holds: for which solid, from which inputs, with which face lit by the pointer.
   * `whole` is on from a repaint of every face until the renderer has uploaded the buffer.
   */
  let painted: { attribute: THREE.BufferAttribute; solid: ModelSolid; key: string; hover: number | null; used: Set<string>; whole: boolean } | null = null;

  /** Everything a face's colour is worked out from, but the face under the pointer: `painter` and `stressTint` read these and no more. */
  function paintKey(selected: Set<number>): string {
    return [
      [...selected].sort((a, b) => a - b).join(","),
      tintNow(),
      ctx.highlightStep ?? "",
      ctx.look.colourByStep ? 1 : 0,
      [...ctx.stressLoad].join(","),
      [...ctx.stressHold].join(","),
      hexToThree(ctx.colors.paintEnforce),
    ].join("|");
  }

  /**
   * Colour the solid's faces. Asked again with nothing changed (a solid is shown, then its empty selection is), it
   * paints nothing. With only the face under the pointer changed, it repaints the face the pointer left and the one
   * it reached, and uploads those triangles alone: the whole buffer of a 216k-triangle part is 7.8 MB.
   */
  function paintFaces() {
    if (!ctx.mesh || !ctx.solid) return;
    const selected = new Set(ctx.picks.filter((pick) => pick.kind === "face").map((pick) => pick.index));
    const hoverFace = ctx.mode === "face" && ctx.hover?.kind === "face" ? ctx.hover.index : null;
    const attribute = ctx.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    const key = paintKey(selected);
    if (painted && painted.attribute === attribute && painted.solid === ctx.solid && painted.key === key) {
      if (painted.hover !== hoverFace) {
        const paintOf = painter(ctx.solid, selected, hoverFace);
        const byFace = faceTriangles(ctx.solid.triangles);
        let wrote = false;
        for (const face of [painted.hover, hoverFace]) {
          const tris = face == null ? undefined : byFace.get(face);
          if (face == null || !tris) continue;
          fillFace(array, tris, paintOf(face).hex);
          wrote = true;
          if (painted.whole) continue;
          const runs = colourRuns(tris);
          // A triangle past the end of the buffer was never written: no run names it, the whole buffer goes instead.
          if (runs.length > 0 && runs[runs.length - 2]! + runs[runs.length - 1]! > array.length) {
            attribute.clearUpdateRanges();
            painted.whole = true;
            continue;
          }
          for (let i = 0; i < runs.length; i += 2) attribute.addUpdateRange(runs[i]!, runs[i + 1]!);
        }
        painted.hover = hoverFace;
        if (wrote) attribute.needsUpdate = true;
      }
      if (!ctx.preview) publishFaceColours(painted.used);
      return;
    }
    const used = paintColours(ctx.solid, array, selected, hoverFace);
    if (painted?.attribute === attribute) {
      painted.solid = ctx.solid;
      painted.key = key;
      painted.hover = hoverFace;
      painted.used = used;
      painted.whole = true;
    } else {
      const record = { attribute, solid: ctx.solid, key, hover: hoverFace, used, whole: true };
      painted = record;
      // The renderer says when the buffer is on the card; until then a repaint of two faces must not narrow the upload.
      attribute.onUpload(() => {
        record.whole = false;
      });
    }
    // Runs left by a hover would keep the renderer to those triangles.
    attribute.clearUpdateRanges();
    attribute.needsUpdate = true;
    if (!ctx.preview) publishFaceColours(used);
  }

  function repaintPreview() {
    if (!ctx.preview) return;
    const attribute = ctx.preview.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const used = paintColours(ctx.preview.shape, attribute.array as Float32Array, new Set(), null);
    attribute.needsUpdate = true;
    publishFaceColours(used);
  }

  function fatLine(positions: number[], width: number, opacity: number, color = ctx.accent): LineSegments2 | null {
    if (positions.length < 6) return null;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({
      color,
      linewidth: width,
      transparent: opacity < 1,
      opacity,
      depthTest: false,
      worldUnits: false,
    });
    material.resolution.copy(lineResolution());
    fatLines.push(material);
    const lines = new LineSegments2(geometry, material);
    lines.renderOrder = 3;
    lines.raycast = () => undefined;
    return lines;
  }

  function replaceLine(current: LineSegments2 | null, positions: number[], width: number, opacity: number, color = ctx.accent): LineSegments2 | null {
    if (current) {
      body.remove(current);
      const material = current.material as LineMaterial;
      const index = fatLines.indexOf(material);
      if (index >= 0) fatLines.splice(index, 1);
      disposeObject(current);
    }
    const next = fatLine(positions, width, opacity, color);
    if (next) (next.material as LineMaterial).clippingPlanes = ctx.sectionClip;
    if (next) body.add(next);
    return next;
  }

  function paintLines() {
    const selectedFaces = ctx.picks.filter((pick) => pick.kind === "face").map((pick) => pick.index);
    const outline: number[] = [];
    for (const face of selectedFaces) outline.push(...(ctx.boundaries.get(face) ?? []));
    const removed = ctx.removedFaces && selectedFaces.length > 0;
    const outlineColor = removed ? hexToThree(ctx.colors.danger) : ctx.datumPick ? hexToThree(ctx.colors.teal) : ctx.accent;
    ctx.faceOutline = replaceLine(ctx.faceOutline, removed ? dashSegments(outline) : outline, 2.5, 1, outlineColor);

    const wanted = new Set(ctx.picks.filter((pick) => pick.kind === "edge").map((pick) => pick.index));
    ctx.selectedEdges = replaceLine(ctx.selectedEdges, edgePositions(wanted), 4, 1);

    const hoverEdge = ctx.mode === "edge" && ctx.hover?.kind === "edge" && !wanted.has(ctx.hover.index) ? ctx.hover.index : null;
    const lit = ctx.edgeLit != null && !wanted.has(ctx.edgeLit) ? ctx.edgeLit : hoverEdge;
    ctx.hoverEdges = replaceLine(ctx.hoverEdges, lit == null ? [] : edgePositions(new Set([lit])), 2, 0.8);
    const amber = hexToThree(ctx.colors.amber);
    ctx.flaggedEdges = replaceLine(ctx.flaggedEdges, edgePositions(new Set(ctx.flagged.edges.filter((edge) => edge !== ctx.flagged.lit && !wanted.has(edge)))), 2.5, 0.9, amber);
    ctx.litEdge = replaceLine(ctx.litEdge, ctx.flagged.lit == null ? [] : edgePositions(new Set([ctx.flagged.lit])), 6, 1, amber);
  }

  function edgePositions(ids: Set<number>): number[] {
    if (!ctx.solid || ids.size === 0) return [];
    const positions: number[] = [];
    for (const edge of ctx.solid.edges) {
      if (!ids.has(edge.id)) continue;
      const points = edge.points;
      for (let i = 0; i + 5 < points.length; i += 3) {
        positions.push(points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!, points[i + 4]!, points[i + 5]!);
      }
    }
    return positions;
  }

  function drawMark(current: LineSegments2 | null, boxes: Bounds[], color: number): LineSegments2 | null {
    if (current) {
      marks.remove(current);
      const material = current.material as LineMaterial;
      const index = fatLines.indexOf(material);
      if (index >= 0) fatLines.splice(index, 1);
      disposeObject(current);
    }
    const positions = boxes.flatMap((box) => boxEdges(box));
    const next = fatLine(positions, 2.5, 1, color);
    if (next) marks.add(next);
    return next;
  }

  function paintMarks() {
    locatedLines = drawMark(locatedLines, ctx.locatedBoxes, hexToThree(ctx.colors.danger));
    checkLines = drawMark(checkLines, ctx.checkBox ? [ctx.checkBox] : [], ctx.accent);
    const located = boxList(ctx.locatedBoxes);
    if (located) canvas.dataset.located = `red:${located}`;
    else delete canvas.dataset.located;
    const outlined = boxList(ctx.checkBox ? [ctx.checkBox] : []);
    if (outlined) canvas.dataset.checkBox = outlined;
    else delete canvas.dataset.checkBox;
  }

  function lineResolution() {
    return new THREE.Vector2(Math.max(1, renderer.domElement.width), Math.max(1, renderer.domElement.height));
  }

  function syncLineResolution() {
    const resolution = lineResolution();
    for (const material of [...fatLines, ...datumLines, snapLineMat]) material.resolution.copy(resolution);
  }

  function applyScale() {
    const factor = ctx.ghost?.kind === "scale" && ctx.ghost.factor > 0 ? ctx.ghost.factor : 1;
    body.scale.setScalar(factor);
    body.position.set(ctx.center.x * (1 - factor), ctx.center.y * (1 - factor), ctx.center.z * (1 - factor));
  }
}
