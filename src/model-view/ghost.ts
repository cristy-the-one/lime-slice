/** Ghost previews: dry-run shapes, primitive and edge-blend ghosts, and their materials. */
import * as THREE from "three";
import { type BlendSide, blendGhost } from "../interact/ghosts";
import type { ModelGhost, ModelSolid } from "./types";
import { OBJECT_OUTLINE_MAX_TRIANGLES, PRIMITIVE_CREASE_DEG } from "./constants";
import type { Vec3 } from "../model-drag";
import { edgeSides } from "../interact/edge-drag";
import { failedGhostMaterial, primitiveScale, turnQuaternion, writePositions } from "./helpers";
import { hexToThree } from "../theme";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { turnCentre } from "../model-primitive";
import type { ViewCtx } from "./ctx";

export function installGhost(ctx: ViewCtx): void {
  const { borrowed, canvas, ghosts, posed, yAxis, zAxis } = ctx;
  ctx.ghostMaterial = ghostMaterial;
  ctx.posePrimitive = posePrimitive;
  ctx.publishGhostBox = publishGhostBox;
  ctx.rebuildGhost = rebuildGhost;
  ctx.restyleGhostFaces = restyleGhostFaces;
  ctx.restyleGhostLines = restyleGhostLines;


  /**
   * The primitive ghost's shaded and edge geometry, built once per mesh: a move or a turn of the same primitive
   * only moves it. `disposeObject` leaves these two alone; a new mesh frees them.
   */
  ctx.primitiveGeometry = null;
  // --- A3 composite features: one geometry per piece mesh, borrowed so a rebuild does not free a mesh still in use. ---
  const pieceGeometry = new Map<Float32Array, { shaded: THREE.BufferGeometry; edges: THREE.EdgesGeometry }>();
  /** The failed piece last framed, so a rebuild of the same refusal does not jump the camera. */
  let framedPiece: string | null = null;

  function primitiveGeometryFor(mesh: Float32Array) {
    if (ctx.primitiveGeometry?.mesh === mesh) return ctx.primitiveGeometry;
    ctx.primitiveGeometry?.shaded.dispose();
    ctx.primitiveGeometry?.edges.dispose();
    const soup = new THREE.BufferGeometry();
    soup.setAttribute("position", new THREE.BufferAttribute(mesh, 3));
    // Round sides shade smooth, and a box's or a wedge's faces stay flat.
    const shaded = toCreasedNormals(soup, (PRIMITIVE_CREASE_DEG * Math.PI) / 180);
    soup.dispose();
    // A round side's facets meet at a few degrees: only the primitive's real edges are drawn.
    const edges = new THREE.EdgesGeometry(shaded, PRIMITIVE_CREASE_DEG);
    ctx.primitiveGeometry = { mesh, shaded, edges };
    return ctx.primitiveGeometry;
  }

  // --- A3 composite features ---
  function pieceGeometryFor(mesh: Float32Array) {
    const held = pieceGeometry.get(mesh);
    if (held) return held;
    const soup = new THREE.BufferGeometry();
    soup.setAttribute("position", new THREE.BufferAttribute(mesh, 3));
    const shaded = toCreasedNormals(soup, (PRIMITIVE_CREASE_DEG * Math.PI) / 180);
    soup.dispose();
    const edges = new THREE.EdgesGeometry(shaded, PRIMITIVE_CREASE_DEG);
    borrowed.add(shaded);
    borrowed.add(edges);
    const next = { shaded, edges };
    pieceGeometry.set(mesh, next);
    return next;
  }

  /** `flat` for a mesh that carries no normals, as a grey object's buffers do. */
  /** Faces of the ghost step back by at most a fifth while one aspect is lit. The solid stays as it is. */
  function ghostFaceOpacity(base: number) {
    return ctx.aspectDim ? base * 0.8 : base;
  }

  function ghostMaterial(opacity: number, flat = false) {
    const material = new THREE.MeshStandardMaterial({
      color: ctx.accent,
      roughness: 0.55,
      metalness: 0.05,
      flatShading: flat,
      transparent: true,
      opacity: ghostFaceOpacity(opacity),
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    material.userData.baseOpacity = opacity;
    return material;
  }

  /** Each edge's points with their two faces, read once per solid: the drag only rebuilds the strip. */
  const blendSides = new WeakMap<object, Map<number, BlendSide[]>>();

  function sidesOf(shape: ModelSolid, edgeId: number): BlendSide[] {
    let known = blendSides.get(shape);
    if (!known) blendSides.set(shape, (known = new Map()));
    let sides = known.get(edgeId);
    if (!sides) {
      const edge = shape.edges.find((item) => item.id === edgeId);
      sides = edge ? edgeSides(shape.positions, shape.triangles, edge.points) : [];
      known.set(edgeId, sides);
    }
    return sides;
  }

  function addGhostMesh(geometry: THREE.BufferGeometry, position: THREE.Vector3, opacity = 0.22, edgeAngle = 1) {
    const meshGhost = new THREE.Mesh(geometry, ghostMaterial(opacity));
    meshGhost.position.copy(position);
    meshGhost.renderOrder = 2;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, edgeAngle),
      new THREE.LineBasicMaterial({ color: ctx.accent, transparent: true, opacity: 0.95 }),
    );
    edges.raycast = () => undefined;
    meshGhost.add(edges);
    ghosts.add(meshGhost);
    return meshGhost;
  }

  function pointCylinder(x: number, y: number, z: number, radius: number, height: number, failed = false) {
    if (!(radius > 0) || !(height > 0)) return;
    const geometry = new THREE.CylinderGeometry(radius, radius, height, 32);
    const meshGhost = failed ? addFailedGhost(geometry, new THREE.Vector3(x, y, z)) : addGhostMesh(geometry, new THREE.Vector3(x, y, z));
    meshGhost.quaternion.setFromUnitVectors(yAxis, zAxis);
    return meshGhost;
  }

  /** --- F4. The hole a probe refused, in the same red as a failed feature piece. --- */
  function addFailedGhost(geometry: THREE.BufferGeometry, position: THREE.Vector3) {
    const meshGhost = new THREE.Mesh(geometry, failedGhostMaterial());
    meshGhost.position.copy(position);
    meshGhost.renderOrder = 2;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0xd64545, transparent: true, opacity: 0.95 }),
    );
    edges.raycast = () => undefined;
    meshGhost.add(edges);
    ghosts.add(meshGhost);
    return meshGhost;
  }

  function rebuildGhost() {
    ctx.ghostSerial += 1;
    ctx.ghostPose = 0;
    ctx.posedPrimitive = null;
    canvas.dataset.ghostSerial = String(ctx.ghostSerial);
    canvas.dataset.ghostPose = "0";
    delete canvas.dataset.connectors;
    delete canvas.dataset.ghostTriangles;
    delete canvas.dataset.cutTraces;
    delete canvas.dataset.cutPath;
    ctx.clearGhosts();
    ctx.applyScale();
    ctx.clipToSplit();
    buildGhost();
    rememberPrimitive();
    restyleGhostLines();
    publishGhostBox();
    ctx.rebuildCap();
  }

  /** The primitive group `buildGhost` just added, when a later size change can reuse it. */
  function rememberPrimitive() {
    if (ctx.ghost?.kind !== "primitive") return;
    const group = ghosts.children.find((child) => child instanceof THREE.Group);
    const shape = group?.children.find((child) => child instanceof THREE.Mesh);
    const outline = shape?.children.find((child) => child instanceof THREE.LineSegments);
    if (!(group instanceof THREE.Group) || !(shape instanceof THREE.Mesh) || !(outline instanceof THREE.LineSegments)) return;
    if (!shape.geometry.getAttribute("position") || !outline.geometry.getAttribute("position")) return;
    const spec = ctx.ghost.spec;
    ctx.posedPrimitive = {
      primitive: spec.primitive,
      soupCount: ctx.ghost.mesh.length,
      group,
      shape,
      outline,
      spec: { ...spec, origin: [...spec.origin], size: [...spec.size], turn: [...spec.turn] },
    };
  }

  /**
   * Same primitive, same vertex count: keep the meshes already on screen.
   * A box and its kin were built at a real size, so they scale about that size. Anything else copies
   * positions into the existing buffers. A `LineSegmentsGeometry` takes `setPositions`.
   */
  function posePrimitive(next: Extract<ModelGhost, { kind: "primitive" }>): boolean {
    const held = ctx.posedPrimitive;
    if (!held || ctx.ghost?.kind !== "primitive") return false;
    if (held.primitive !== next.spec.primitive) return false;
    const scale = primitiveScale(held.spec, next.spec);
    // A new segment count builds a different soup. Scale only the mesh we already have.
    if (scale && held.soupCount === next.mesh.length) {
      held.shape.scale.set(scale[0], scale[1], scale[2]);
      const centre = turnCentre(next.spec);
      const [x, y, z] = next.spec.origin;
      held.group.position.set(x + centre[0], y + centre[1], z + centre[2]);
      held.group.quaternion.copy(turnQuaternion(next.spec.turn));
      held.shape.position.set(-centre[0], -centre[1], -centre[2]);
      ctx.ghostPose += 1;
      canvas.dataset.ghostPose = String(ctx.ghostPose);
      return true;
    }
    if (held.soupCount !== next.mesh.length) return false;
    // The scale path may have run on an earlier size. These positions are already the new size.
    held.shape.scale.set(1, 1, 1);
    const soup = new THREE.BufferGeometry();
    soup.setAttribute("position", new THREE.BufferAttribute(next.mesh, 3));
    const shaded = toCreasedNormals(soup, (PRIMITIVE_CREASE_DEG * Math.PI) / 180);
    soup.dispose();
    const edges = new THREE.EdgesGeometry(shaded, PRIMITIVE_CREASE_DEG);
    const shadedPos = shaded.getAttribute("position");
    const shadedNorm = shaded.getAttribute("normal");
    const edgePos = edges.getAttribute("position");
    const livePos = held.shape.geometry.getAttribute("position");
    const liveNorm = held.shape.geometry.getAttribute("normal");
    const liveEdge = held.outline.geometry.getAttribute("position");
    const fits = !!shadedPos && !!edgePos && !!livePos && !!liveEdge && shadedPos.count === livePos.count && edgePos.count === liveEdge.count;
    if (!fits || !shadedPos || !edgePos || !livePos || !liveEdge) {
      shaded.dispose();
      edges.dispose();
      return false;
    }
    writePositions(livePos, shadedPos.array);
    if (liveNorm && shadedNorm && liveNorm.count === shadedNorm.count) writePositions(liveNorm, shadedNorm.array);
    const line = held.outline.geometry as THREE.BufferGeometry & { setPositions?: (array: Float32Array) => void };
    if (typeof line.setPositions === "function") line.setPositions(edgePos.array as Float32Array);
    else writePositions(liveEdge, edgePos.array);
    held.shape.geometry.computeBoundingBox();
    held.shape.geometry.computeBoundingSphere();
    held.outline.geometry.computeBoundingBox();
    held.outline.geometry.computeBoundingSphere();
    shaded.dispose();
    edges.dispose();
    const centre = turnCentre(next.spec);
    const [x, y, z] = next.spec.origin;
    held.group.position.set(x + centre[0], y + centre[1], z + centre[2]);
    held.group.quaternion.copy(turnQuaternion(next.spec.turn));
    held.shape.position.set(-centre[0], -centre[1], -centre[2]);
    ctx.ghostPose += 1;
    canvas.dataset.ghostPose = String(ctx.ghostPose);
    return true;
  }

  /** The ghost's own edges step back while one aspect is lit, so the thick lines read on their own. */
  function restyleGhostLines() {
    ghosts.traverse((child) => {
      if (!(child instanceof THREE.LineSegments)) return;
      const material = child.material;
      if (!(material instanceof THREE.LineBasicMaterial)) return;
      material.transparent = true;
      material.opacity = ctx.aspectDim ? 0.35 : 0.95;
    });
  }

  function restyleGhostFaces() {
    ghosts.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const material = child.material;
      if (!(material instanceof THREE.MeshStandardMaterial)) return;
      const base = material.userData.baseOpacity;
      if (typeof base !== "number") return;
      material.opacity = ghostFaceOpacity(base);
      material.needsUpdate = true;
    });
  }

  /** The ghost's world box, for tests: centre then size, in millimetres. */
  function publishGhostBox() {
    if (ghosts.children.length === 0) {
      delete canvas.dataset.ghost;
      delete canvas.dataset.ghostTone;
      return;
    }
    if (ctx.ghost?.kind === "soup" && ctx.ghost.tone) canvas.dataset.ghostTone = ctx.ghost.tone;
    else delete canvas.dataset.ghostTone;
    ghosts.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(ghosts);
    const at = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    canvas.dataset.ghost = [at.x, at.y, at.z, size.x, size.y, size.z].map((value) => value.toFixed(2)).join(" ");
  }

  function buildGhost() {
    const current = ctx.ghost;
    if (!current) return;
    // --- P1: the client prism, in the solid's frame. ---
    if (current.kind === "soup") {
      // --- Text with real fonts: the letters too thin for the nozzle are drawn apart, in the refusal colour.
      if (current.flagged && current.flagged.length >= 9) {
        const thin = new THREE.BufferGeometry();
        thin.setAttribute("position", new THREE.BufferAttribute(current.flagged, 3));
        thin.computeVertexNormals();
        const thinMesh = addFailedGhost(thin, new THREE.Vector3());
        thinMesh.matrixAutoUpdate = false;
        thinMesh.matrix.copy(posed.matrix);
      }
      if (current.positions.length < 9) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(current.positions, 3));
      geometry.computeVertexNormals();
      const added = current.tone === "add";
      // --- Print transitions, step 4: material to be cut, red, drawn through the solid it lies inside.
      const cut = current.tone === "cut";
      const material = ghostMaterial(added || cut ? 0.45 : 0.28);
      if (added || cut) material.color.set(hexToThree(cut ? ctx.colors.danger : ctx.colors.ok));
      if (cut) material.depthTest = false;
      const meshGhost = new THREE.Mesh(geometry, material);
      meshGhost.matrixAutoUpdate = false;
      meshGhost.matrix.copy(posed.matrix);
      meshGhost.renderOrder = cut ? 3 : 2;
      meshGhost.raycast = () => undefined;
      if (added || cut) {
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20), new THREE.LineBasicMaterial({ color: hexToThree(cut ? ctx.colors.danger : ctx.colors.ok), transparent: true, opacity: 0.95, depthTest: !cut }));
        outline.raycast = () => undefined;
        meshGhost.add(outline);
      }
      ghosts.add(meshGhost);
      return;
    }
    if (current.kind === "primitive") {
      // A new solid's ghost needs no open solid.
      if (current.mesh.length < 9) return;
      const { shaded, edges } = primitiveGeometryFor(current.mesh);
      const centre = turnCentre(current.spec);
      const [x, y, z] = current.spec.origin;
      const turned = new THREE.Group();
      turned.position.set(x + centre[0], y + centre[1], z + centre[2]);
      turned.quaternion.copy(turnQuaternion(current.spec.turn));
      const shape = new THREE.Mesh(shaded, ghostMaterial(0.22));
      shape.position.set(-centre[0], -centre[1], -centre[2]);
      shape.renderOrder = 2;
      const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: ctx.accent, transparent: true, opacity: 0.95 }));
      outline.raycast = () => undefined;
      shape.add(outline);
      turned.add(shape);
      ghosts.add(turned);
      return;
    }
    // --- A3 composite features ---
    if (current.kind === "pieces") {
      const used = new Set<Float32Array>();
      let failedGroup: THREE.Object3D | null = null;
      for (let index = 0; index < current.parts.length; index++) {
        const part = current.parts[index]!;
        if (part.mesh.length < 9) continue;
        used.add(part.mesh);
        const { shaded, edges } = pieceGeometryFor(part.mesh);
        const centre = turnCentre(part.spec);
        const [x, y, z] = part.spec.origin;
        const failed = current.failed === index + 1;
        const turned = new THREE.Group();
        turned.position.set(x + centre[0], y + centre[1], z + centre[2]);
        turned.quaternion.copy(turnQuaternion(part.spec.turn));
        if (!current.outlines) {
          const shape = new THREE.Mesh(shaded, failed ? failedGhostMaterial() : ghostMaterial(0.22));
          shape.position.set(-centre[0], -centre[1], -centre[2]);
          shape.renderOrder = 2;
          const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: failed ? 0xd64545 : ctx.accent, transparent: true, opacity: 0.95 }));
          outline.raycast = () => undefined;
          shape.add(outline);
          turned.add(shape);
        } else {
          const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: failed ? 0xd64545 : ctx.accent, transparent: true, opacity: 0.95 }));
          outline.position.set(-centre[0], -centre[1], -centre[2]);
          outline.raycast = () => undefined;
          turned.add(outline);
        }
        ghosts.add(turned);
        if (failed) failedGroup = turned;
      }
      canvas.dataset.ghostTriangles = String(current.parts.reduce((sum, part) => sum + Math.floor(part.mesh.length / 9), 0));
      for (const [mesh, held] of pieceGeometry) {
        if (used.has(mesh)) continue;
        held.shaded.dispose();
        held.edges.dispose();
        pieceGeometry.delete(mesh);
      }
      if (failedGroup && current.failed != null) {
        const part = current.parts[current.failed - 1];
        const key = part ? `${current.failed}:${part.spec.origin.map((value) => value.toFixed(2)).join(",")}` : "";
        if (key && framedPiece !== key) {
          framedPiece = key;
          failedGroup.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(failedGroup);
          if (!box.isEmpty()) ctx.frameBox({ min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] });
        }
      } else framedPiece = null;
      return;
    }
    // --- end A3 ---
    if (current.kind === "object") {
      // The grey object's own buffers, moved by its matrix: nothing is copied.
      const held = ctx.contextHeld(current.positions);
      // Its outline is built once, and not at all for a mesh so dense that would hold up the pick.
      if (!held.edges && current.positions.length <= OBJECT_OUTLINE_MAX_TRIANGLES * 9) {
        held.edges = new THREE.EdgesGeometry(held.geometry, PRIMITIVE_CREASE_DEG);
        borrowed.add(held.edges);
      }
      const shape = new THREE.Mesh(held.geometry, ghostMaterial(0.22, true));
      const { m, t } = current.matrix;
      shape.matrixAutoUpdate = false;
      shape.matrix.set(m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2], 0, 0, 0, 1);
      shape.renderOrder = 2;
      shape.raycast = () => undefined;
      if (held.edges) {
        const outline = new THREE.LineSegments(held.edges, new THREE.LineBasicMaterial({ color: ctx.accent, transparent: true, opacity: 0.95 }));
        outline.raycast = () => undefined;
        shape.add(outline);
      }
      ghosts.add(shape);
      return;
    }
    if (!ctx.solid) return;
    if (current.kind === "measure") {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...current.a), new THREE.Vector3(...current.b)]),
        new THREE.LineDashedMaterial({ color: ctx.accent, dashSize: Math.max(ctx.extent / 60, 0.3), gapSize: Math.max(ctx.extent / 90, 0.2), depthTest: false, transparent: true }),
      );
      line.computeLineDistances();
      line.renderOrder = 5;
      line.raycast = () => undefined;
      ghosts.add(line);
      return;
    }
    if (current.kind === "hole" || current.kind === "holes") {
      const holes = current.kind === "hole" ? [current] : current.holes;
      const failedAt = current.kind === "holes" ? current.failed : undefined;
      holes.forEach((hole, index) => {
        const failed = failedAt === index + 1;
        const dir = hole.dir ?? [0, 0, -1];
        const length = Math.hypot(dir[0], dir[1], dir[2]);
        const axis = length > 1e-9 ? [dir[0] / length, dir[1] / length, dir[2] / length] as Vec3 : [0, 0, -1] as Vec3;
        const straightDown = Math.abs(axis[0]) < 1e-6 && Math.abs(axis[1]) < 1e-6 && axis[2] < 0;
        // A cylinder from the origin `depth` into the part: the hole, and its counterbore at the entry.
        const drill = (radius: number, depth: number) => {
          const cylinder = pointCylinder(
            hole.x + axis[0] * depth / 2,
            hole.y + axis[1] * depth / 2,
            hole.z + axis[2] * depth / 2,
            radius,
            depth,
            failed,
          );
          if (cylinder && !straightDown) {
            cylinder.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(zAxis, new THREE.Vector3(axis[0], axis[1], axis[2])));
          }
        };
        drill(hole.radius, hole.depth);
        if (hole.bore) drill(hole.bore.radius, hole.bore.depth);
      });
      return;
    }
    if (current.kind === "plane" || current.kind === "cuts") {
      // Drawn square around the solid's centre, dropped onto the plane, and turned with its tilt.
      const span = Math.max(ctx.extent * 1.45, 30);
      // The plane is in model space, so it is centred on the solid's middle there.
      const box = ctx.solidBox ?? { min: [0, 0, 0], max: [0, 0, 0] };
      const mid = new THREE.Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
      // Split to print's planes each stop just past the part's section and draw fainter, so the pieces read through them.
      if (current.kind === "plane") {
        const normal = new THREE.Vector3(...current.normal).normalize();
        const middle = mid.clone().addScaledVector(normal, -normal.dot(mid.clone().sub(new THREE.Vector3(...current.origin))));
        addGhostMesh(new THREE.PlaneGeometry(span, span), middle, 0.2).quaternion.setFromUnitVectors(zAxis, normal);
        return;
      }
      let traced = 0;
      current.planes.forEach((plane, index) => {
        // A shaped cut draws its path instead of a flat square: the folded sheet and where it meets the part.
        const trace = current.traces?.[index];
        if (trace && ctx.drawTrace(trace)) {
          traced += 1;
          return;
        }
        const shown = ctx.cutSquare(plane);
        addGhostMesh(new THREE.PlaneGeometry(shown.span, shown.span), new THREE.Vector3(...shown.origin), 0.1).quaternion.setFromUnitVectors(zAxis, new THREE.Vector3(...plane.normal).normalize());
      });
      if (traced > 0) canvas.dataset.cutTraces = String(traced);
      // Each connector the planner placed: its hole, through the cut, half in each piece. The holes are inside the
      // solid, so they draw over it.
      for (const mark of current.marks ?? []) {
        const cylinder = pointCylinder(mark.at[0], mark.at[1], mark.at[2], mark.radius, mark.depth);
        if (!cylinder) continue;
        cylinder.quaternion.setFromUnitVectors(yAxis, new THREE.Vector3(...mark.normal).normalize());
        cylinder.renderOrder = 4;
        for (const part of [cylinder, ...cylinder.children]) {
          const material = (part as THREE.Mesh).material as THREE.Material;
          material.depthTest = false;
          (part as THREE.Mesh).renderOrder = 4;
        }
      }
      canvas.dataset.connectors = String(current.marks?.length ?? 0);
      return;
    }
    if (current.kind === "blend") {
      if (!(current.radius > 0)) return;
      for (const edgeId of current.edges) {
        const soup = blendGhost(sidesOf(ctx.solid, edgeId), current.radius, current.chamfer === true);
        if (soup.length < 9) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(soup, 3));
        geometry.computeVertexNormals();
        // The edge is in the solid's own frame: the blend goes where the solid is drawn. Only its outline is lined.
        const meshGhost = addGhostMesh(geometry, new THREE.Vector3(), 0.38, 30);
        meshGhost.matrixAutoUpdate = false;
        meshGhost.matrix.copy(posed.matrix);
      }
    }
  }
}
