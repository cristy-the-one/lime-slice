/** Split and section: piece materials, the cut trace shader, clip planes, and the section cap. */
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { TRACE_BOUNDS } from "../cut-trace";
import { hexToThree } from "../theme";
import { pieceRegions } from "../split-print";
import { sectionCap } from "../section-cap";
import { sectionPlane } from "../model-look";
import { setPieceTraces, traceShader } from "./helpers";
import type { ViewCtx } from "./ctx";

export function installSplit(ctx: ViewCtx): void {
  const { body, canvas, edgeMaterial, ghosts, posed, raycaster, sectionCapMaterial, solidMaterial, stressMaterial } = ctx;
  ctx.clearSectionCap = clearSectionCap;
  ctx.clipToSplit = clipToSplit;
  ctx.cutAway = cutAway;
  ctx.rebuildCap = rebuildCap;
  ctx.solidHit = solidHit;

  let sectionCapMesh: THREE.Mesh | null = null;

  /** The material that draws the side a split cuts off, tinted, shared by every split shown. */
  const offcutMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
  /** The paths traced on the open solid, by trace, so a redraw that moves nothing traces nothing. */
  ctx.tracesHeld = { positions: null, paths: new Map() };

  /** --- Split to print. One material per piece, since each clips to its own slab; kept and reused, never freed. */
  const pieceMaterials: THREE.MeshStandardMaterial[] = [];
  /** A plane every point is behind: the solid draws nothing while its pieces draw it. */
  const HIDE_SOLID = new THREE.Plane(new THREE.Vector3(0, 0, 1), -1e9);

  function pieceMaterial(index: number, tone: 0 | 1): THREE.MeshStandardMaterial {
    let material = pieceMaterials[index];
    if (!material) {
      material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
      traceShader(material);
      pieceMaterials[index] = material;
    }
    material.color.setHex(tone === 0 ? ctx.accent : hexToThree(ctx.colors.teal));
    return material;
  }

  /**
   * While a split's plane is up, the solid is drawn as the two parts it makes: the side the part keeps (behind the plane's
   * normal) as it is, and the side that becomes a part of its own tinted. Clipping planes, so nothing is built.
   */
  function clipToSplit() {
    const plane = ctx.ghost?.kind === "plane" && ctx.mesh ? ctx.ghost : null;
    const keep: THREE.Plane[] = [];
    const off: THREE.Plane[] = [];
    if (plane) {
      const normal = new THREE.Vector3(...plane.normal).normalize();
      const origin = new THREE.Vector3(...plane.origin);
      keep.push(new THREE.Plane(normal.clone().negate(), normal.dot(origin)));
      off.push(new THREE.Plane(normal, -normal.dot(origin)));
      offcutMaterial.color.setHex(ctx.accent);
      const offcut = new THREE.Mesh(ctx.mesh!.geometry, offcutMaterial);
      offcut.matrixAutoUpdate = false;
      offcut.matrix.copy(posed.matrix);
      offcut.renderOrder = 2;
      offcut.raycast = () => undefined;
      offcut.userData.borrowed = true;
      ghosts.add(offcut);
    }
    // --- A10. The section hides the side its normal points toward. three.js drops the negative side, so the clip normal is the opposite.
    const section = sectionNow();
    if (section) {
      const clip = new THREE.Plane(section.normal.clone().negate(), section.normal.dot(section.origin));
      keep.push(clip);
      off.push(clip);
    }
    // --- Split to print: each piece is the solid clipped to its slab, in its own tint; the solid itself steps aside and
    // its edges stay drawn over the pieces.
    const cuts = ctx.ghost?.kind === "cuts" && ctx.mesh ? pieceRegions(ctx.ghost.planes) : [];
    const traces = ctx.ghost?.kind === "cuts" ? (ctx.ghost.traces ?? []) : [];
    cuts.forEach((region, index) => {
      const material = pieceMaterial(index, region.tone);
      // A shaped cut bounds the piece by its profile, in the shader; a straight one by its plane.
      const shaped = region.bounds
        .filter((half) => traces[half.cut])
        .slice(0, TRACE_BOUNDS)
        .map((half) => {
          const trace = traces[half.cut]!;
          return { half, trace, side: half.normal[0] * trace.w[0] + half.normal[1] * trace.w[1] + half.normal[2] * trace.w[2] < 0 ? -1 : 1 };
        });
      setPieceTraces(material, shaped);
      const flat = region.bounds.filter((half) => !shaped.some((row) => row.half === half));
      const planes = [...flat.map((half) => new THREE.Plane(new THREE.Vector3(...half.normal), half.constant)), ...(section ? [keep[keep.length - 1]!] : [])];
      if ((material.clippingPlanes?.length ?? 0) !== planes.length) material.needsUpdate = true;
      material.clippingPlanes = planes;
      const piece = new THREE.Mesh(ctx.mesh!.geometry, material);
      piece.matrixAutoUpdate = false;
      piece.matrix.copy(posed.matrix);
      piece.renderOrder = 1;
      piece.raycast = () => undefined;
      piece.userData.borrowed = true;
      ghosts.add(piece);
    });
    canvas.dataset.cutPieces = String(cuts.length);
    const solidPlanes = cuts.length > 0 ? [...keep, HIDE_SOLID] : keep;
    clipHighlights(section ? [keep[keep.length - 1]!] : []);
    offcutMaterial.clippingPlanes = off;
    // The cap lies on the section plane, so that plane must not clip it. A split still does.
    sectionCapMaterial.clippingPlanes = keep.slice(0, plane ? 1 : 0);
    // A new count of planes compiles the shader again; new planes of the same count are only new numbers.
    if ((solidMaterial.clippingPlanes?.length ?? 0) !== solidPlanes.length) solidMaterial.needsUpdate = true;
    if ((edgeMaterial.clippingPlanes?.length ?? 0) !== keep.length) edgeMaterial.needsUpdate = true;
    solidMaterial.clippingPlanes = solidPlanes;
    edgeMaterial.clippingPlanes = keep;
    if ((stressMaterial.clippingPlanes?.length ?? 0) !== keep.length) stressMaterial.needsUpdate = true;
    stressMaterial.clippingPlanes = keep;
    ctx.publishStressClip();
  }

  /** The pick outlines are cut where the solid is, so a picked face's outline does not float over the hidden half. */
  function clipHighlights(planes: THREE.Plane[]) {
    const count = ctx.sectionClip.length;
    ctx.sectionClip = planes;
    for (const line of [ctx.faceOutline, ctx.selectedEdges, ctx.hoverEdges, ctx.flaggedEdges, ctx.litEdge]) {
      if (!line) continue;
      const material = line.material as LineMaterial;
      material.clippingPlanes = planes;
      if (count !== planes.length) material.needsUpdate = true;
    }
  }

  /** Whether the section hides this world point. */
  function cutAway(point: THREE.Vector3): boolean {
    return ctx.sectionClip.some((plane) => plane.distanceToPoint(point) < 0);
  }

  /**
   * The first hit on the solid that the section leaves on screen. A hit on the hidden side is skipped. A back face
   * behind it means the ray went in through the cut, so the cap is in front and nothing is picked.
   */
  function solidHit(hits: THREE.Intersection[]): THREE.Intersection | null {
    if (ctx.sectionClip.length === 0) return hits[0] ?? null;
    for (const hit of hits) {
      if (cutAway(hit.point)) continue;
      if (hit.face && hit.object instanceof THREE.Mesh) {
        const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (normal.dot(raycaster.ray.direction) > 0) return null;
      }
      return hit;
    }
    return null;
  }

  /** The section plane in model space, which is world space here. */
  function sectionNow(): { origin: THREE.Vector3; normal: THREE.Vector3 } | null {
    if (!ctx.solidBox) return null;
    const centre: [number, number, number] = [
      (ctx.solidBox.min[0] + ctx.solidBox.max[0]) / 2,
      (ctx.solidBox.min[1] + ctx.solidBox.max[1]) / 2,
      (ctx.solidBox.min[2] + ctx.solidBox.max[2]) / 2,
    ];
    const plane = sectionPlane(ctx.look, centre);
    if (!plane) return null;
    return { origin: new THREE.Vector3(...plane.origin), normal: new THREE.Vector3(...plane.normal).normalize() };
  }

  function clearSectionCap() {
    if (!sectionCapMesh) return;
    body.remove(sectionCapMesh);
    sectionCapMesh.geometry.dispose();
    sectionCapMesh = null;
  }

  /** The cut face, in the solid's own frame, drawn in the inside colour. The section plane does not clip it. */
  function rebuildCap() {
    clearSectionCap();
    ctx.sectionPlaneWorld = sectionNow();
    if (!ctx.sectionPlaneWorld) {
      delete canvas.dataset.section;
      if (ctx.sectionArrow) ctx.sectionArrow.visible = false;
      return;
    }
    const { origin, normal } = ctx.sectionPlaneWorld;
    canvas.dataset.section = [origin.x, origin.y, origin.z, normal.x, normal.y, normal.z].map((value) => value.toFixed(2)).join(" ");
    const shape = ctx.preview?.shape ?? ctx.solid;
    const host = ctx.preview?.mesh ?? ctx.mesh;
    if (!shape || !host || shape.positions.length < 9) return;
    host.updateWorldMatrix(true, false);
    const into = host.matrixWorld.clone().invert();
    const localOrigin = origin.clone().applyMatrix4(into);
    const localNormal = normal.clone().transformDirection(into).normalize();
    const cap = sectionCap(shape.positions, shape.triangles, [localOrigin.x, localOrigin.y, localOrigin.z], [localNormal.x, localNormal.y, localNormal.z]);
    if (cap.length < 9) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(cap, 3));
    geometry.computeVertexNormals();
    sectionCapMesh = new THREE.Mesh(geometry, sectionCapMaterial);
    sectionCapMesh.raycast = () => undefined;
    body.add(sectionCapMesh);
  }
}
