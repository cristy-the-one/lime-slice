/** api */
import * as THREE from "three";
import { BLEND_GHOST_STEP_MM } from "./constants";
import { type CameraPose, mmPerPixel } from "../sketch/frame";
import type { ModelView } from "./types";
import type { Vec3 } from "../model-drag";
import { faceOutlines } from "../model-select";
import { framePose, sameWorkplane } from "../workplane";
import { hexToThree, themeColors } from "../theme";
import { polylinePairs, readAccent } from "./helpers";
import { drawnEdgeSegments, smoothNormalsOf } from "./smooth";
import { treeRaycast } from "./solid-ray";
import type { ViewCtx } from "./ctx";

export function buildApi(ctx: ViewCtx): ModelView {
  const { alignLine, bedRef, body, camera, canvas, contextMat, controls, datum, edgeMaterial, handleGroup, projected, raycaster, renderer, sketchGroup, snapLineMat, solidMaterial, targetMat } = ctx;


  return {
    setSolid(next, at) {
      ctx.clearBody();
      ctx.solid = next;
      // The arrow's face hit was on the solid just replaced: a press must not drag from where that face was.
      ctx.seatHit = null;
      ctx.picks = [];
      ctx.hover = null;
      ctx.edgeLit = null;
      ctx.clearEdgeKnob();
      ctx.boundaries = new Map();
      ctx.center.set(0, 0, 0);
      ctx.extent = 1;
      ctx.ownBox = null;
      ctx.setPosedMatrix(at);
      if (!next || next.positions.length < 9) {
        ctx.clearGhosts();
        ctx.ghost = null;
        ctx.applyScale();
        ctx.paintFit();
        ctx.rebuildCap();
        ctx.kick();
        return;
      }
      ctx.boundaries = faceOutlines(next.positions, next.triangles);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(next.positions, 3));
      const color = new Float32Array(next.positions.length);
      geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
      const smooth = smoothNormalsOf(next.positions, next.triangles);
      geometry.setAttribute("normal", new THREE.BufferAttribute(smooth.normals, 3));
      canvas.dataset.solidPoints = `${smooth.points}/${next.positions.length / 3}`;
      ctx.mesh = new THREE.Mesh(geometry, solidMaterial);
      // Every ray at the solid (hover, press, pick, Measure, the hidden-line samples) asks a box tree, not every triangle.
      ctx.mesh.raycast = treeRaycast;
      body.add(ctx.mesh);
      const { segments, drawn } = drawnEdgeSegments(next.edges, next.seams);
      canvas.dataset.edgesDrawn = `${drawn}/${next.edges.length}`;
      if (segments.length > 0) {
        const lines = new THREE.BufferGeometry();
        lines.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
        ctx.edgeLines = new THREE.LineSegments(lines, edgeMaterial);
        ctx.edgeLines.raycast = () => undefined;
        body.add(ctx.edgeLines);
      }
      ctx.paintFaces();
      ctx.measureSolid(next.positions);
      ctx.drawDatum();
      ctx.rebuildGhost();
      ctx.resize();
    },
    setPose(next) {
      ctx.setPosedMatrix(next);
      ctx.seatSnapGuides();
      ctx.seatHit = null;
      ctx.rebuildGhost();
      ctx.kick();
    },
    frame: ctx.frameBox,
    setCameraPreset(preset) {
      const box = ctx.solidBox
        ? { min: [ctx.solidBox.min[0], ctx.solidBox.min[1], ctx.solidBox.min[2]] as Vec3, max: [ctx.solidBox.max[0], ctx.solidBox.max[1], ctx.solidBox.max[2]] as Vec3 }
        : { min: [ctx.center.x - ctx.extent / 2, ctx.center.y - ctx.extent / 2, ctx.center.z - ctx.extent / 2] as Vec3, max: [ctx.center.x + ctx.extent / 2, ctx.center.y + ctx.extent / 2, ctx.center.z + ctx.extent / 2] as Vec3 };
      const look = new THREE.Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
      const size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2], 1);
      const radius = (size * Math.sqrt(3)) / 2;
      const fov = (camera.fov * Math.PI) / 180;
      const dist = (radius / Math.sin(fov / 2)) * 1.35;
      const offset = preset === "top" ? new THREE.Vector3(0, -0.04, 1) : preset === "front" ? new THREE.Vector3(0, -1, 0.08) : new THREE.Vector3(1, -1.15, 0.72);
      camera.near = Math.max(0.01, dist / 200);
      camera.far = dist * 20;
      controls.enableDamping = false;
      controls.update();
      camera.up.set(0, 0, 1);
      camera.position.copy(look).add(offset.normalize().multiplyScalar(dist));
      controls.target.copy(look);
      camera.updateProjectionMatrix();
      controls.update();
      controls.enableDamping = true;
      ctx.publishCamera();
      ctx.kick();
    },
    watchFocus(element) {
      const onFocus = () => queueMicrotask(ctx.syncFocusedField);
      element.addEventListener("focusin", onFocus);
      element.addEventListener("focusout", onFocus);
      return () => {
        element.removeEventListener("focusin", onFocus);
        element.removeEventListener("focusout", onFocus);
      };
    },
    setStress(draw) {
      ctx.applyStress(draw);
    },
    onStressProbe(cb) {
      ctx.stressProbeCb = cb;
    },
    onStressDirection(cb) {
      ctx.stressDirCb = cb;
    },
    inView(box) {
      camera.updateMatrixWorld();
      for (let corner = 0; corner < 8; corner += 1) {
        const p = new THREE.Vector3(corner & 1 ? box.max[0] : box.min[0], corner & 2 ? box.max[1] : box.min[1], corner & 4 ? box.max[2] : box.min[2]).project(camera);
        if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || p.z > 1) return false;
      }
      return true;
    },
    setBedVisible(on) {
      ctx.bedOn = on;
      bedRef.setVisible(on);
      canvas.dataset.bedVisible = on ? "1" : "0";
      ctx.kick();
    },
    setPickMode(next) {
      ctx.mode = next;
      ctx.hover = null;
      ctx.paintFaces();
      ctx.paintLines();
      ctx.kick();
    },
    highlight(next) {
      ctx.picks = next;
      ctx.paintFaces();
      ctx.paintLines();
      ctx.kick();
    },
    setGhost(next) {
      // A drag moves the blend in steps finer than anyone sees: the strip is rebuilt once it grows by 0.05 mm.
      if (ctx.ghost?.kind === "blend" && next?.kind === "blend" && next.radius > 0 && ctx.ghost.radius > 0 && ctx.ghost.chamfer === next.chamfer
        && ctx.ghost.edges.join() === next.edges.join() && Math.abs(ctx.ghost.radius - next.radius) < BLEND_GHOST_STEP_MM) return;
      if (next?.kind === "primitive" && ctx.posePrimitive(next)) {
        ctx.ghost = next;
        ctx.publishGhostBox();
        ctx.kick();
        return;
      }
      ctx.ghost = next;
      ctx.rebuildGhost();
      ctx.kick();
    },
    setPreview(next) {
      if (next === (ctx.preview?.shape ?? null)) return;
      if (next) ctx.showPreview(next);
      else ctx.clearPreview();
      ctx.kick();
    },
    setContext: ctx.setContext,
    onGrab(hooks) {
      ctx.grabHooks = hooks;
      if (!hooks) {
        ctx.cancelGrab(false);
        ctx.setGrabHint(false);
      }
    },
    markAlignTarget(id) {
      ctx.alignMark = id;
      ctx.markTarget(id);
    },
    setTags: ctx.setTags,
    setBed(x, y, z) {
      ctx.bed = { x, y, z };
      bedRef.setSize(x, y, z);
      canvas.dataset.bed = `${x}x${y}x${z}`;
      ctx.syncBedOrigin();
      ctx.paintFit();
      ctx.kick();
    },
    setTheme() {
      ctx.colors = themeColors();
      ctx.accent = readAccent();
      ctx.paintBedColors();
      contextMat.color.setHex(hexToThree(ctx.colors.context));
      targetMat.color.setHex(hexToThree(ctx.colors.amber));
      snapLineMat.color.setHex(hexToThree(ctx.colors.amber));
      renderer.setClearColor(hexToThree(ctx.colors.stage), 1);
      ctx.paintFaces();
      ctx.paintLines();
      if (ctx.preview) ctx.showPreview(ctx.preview.shape);
      ctx.drawDatum();
      ctx.rebuildGhost();
      ctx.paintMarks();
      ctx.sketchViewCb();
      ctx.kick();
    },
    resize: ctx.resize,
    onPick(cb) {
      ctx.pickCb = cb;
    },
    setObjectPicking(on) {
      ctx.objectPicking = on;
      canvas.dataset.objectPicking = on ? "1" : "0";
    },
    onObjectPick(cb) {
      ctx.objectPickCb = cb;
    },
    setHandles(next) {
      ctx.buildHandles(next);
      const measuring = next.some((handle) => handle.id.startsWith("measure"));
      if (measuring !== ctx.measureOpen) {
        ctx.measureOpen = measuring;
        if (measuring) ctx.warmSnap();
      }
      ctx.kick();
    },
    onHandleDrag(cb) {
      ctx.handleCb = cb;
    },
    setEdgeHover(on) {
      if (ctx.edgeHoverOn === on) return;
      ctx.edgeHoverOn = on;
      if (!on && ctx.edgeLit != null) {
        ctx.edgeLit = null;
        ctx.paintLines();
        ctx.edgeHoverCb(null, null);
        ctx.kick();
      }
    },
    onEdgeHover(cb) {
      ctx.edgeHoverCb = cb;
    },
    setEdgeKnob(handle) {
      ctx.clearEdgeKnob();
      if (!handle) {
        ctx.paintHandles();
        return;
      }
      ctx.edgeKnobPart = ctx.handlePart(handle);
      handleGroup.add(ctx.edgeKnobPart.root);
      ctx.paintHandles();
    },
    onEdgeKnob(cb) {
      ctx.edgeKnobCb = cb;
    },
    pointerRay(x, y) {
      camera.updateMatrixWorld();
      const ray = ctx.rayAt(x, y);
      return {
        origin: [ray.origin.x, ray.origin.y, ray.origin.z],
        direction: [ray.direction.x, ray.direction.y, ray.direction.z],
      };
    },
    setWorkplane(plane) {
      if (plane === ctx.datumPlane || (plane && ctx.datumPlane && sameWorkplane(plane, ctx.datumPlane))) return;
      ctx.datumPlane = plane;
      datum.visible = !!plane;
      if (plane) {
        const { m, t } = framePose(plane);
        datum.matrix.set(m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2], 0, 0, 0, 1);
        datum.updateMatrixWorld(true);
        ctx.drawDatum();
        canvas.dataset.workplane = `${plane.source}:${plane.origin.map((value) => value.toFixed(2)).join(",")}:${plane.turn.map((value) => value.toFixed(2)).join(",")}`;
      } else delete canvas.dataset.workplane;
      ctx.kick();
    },
    setDatumPick(on) {
      if (ctx.datumPick === on && canvas.dataset.datumPick === (on ? "1" : "0")) return;
      ctx.datumPick = on;
      canvas.dataset.datumPick = on ? "1" : "0";
      ctx.paintFaces();
      ctx.paintLines();
      ctx.kick();
    },
    // --- A10.
    setLook(state) {
      ctx.look = state;
      ctx.rebuildGhost();
      ctx.paintFaces();
      ctx.repaintPreview();
      ctx.kick();
    },
    onSectionDrag(cb) {
      ctx.sectionDragCb = cb;
    },
    setFlaggedEdges(edges, lit) {
      if (lit === ctx.flagged.lit && edges.length === ctx.flagged.edges.length && edges.every((edge, i) => edge === ctx.flagged.edges[i])) return;
      ctx.flagged = { edges: [...edges], lit };
      if (edges.length > 0) canvas.dataset.flagged = edges.join(",");
      else delete canvas.dataset.flagged;
      if (lit != null) canvas.dataset.litEdge = String(lit);
      else delete canvas.dataset.litEdge;
      ctx.paintLines();
      ctx.kick();
    },
    setStepHighlight(id) {
      if (ctx.highlightStep === id) return;
      ctx.highlightStep = id;
      if (id == null) delete canvas.dataset.highlight;
      else canvas.dataset.highlight = String(id);
      ctx.paintFaces();
      ctx.repaintPreview();
      ctx.kick();
    },
    // --- P1 ---
    setFaceDrag(on) {
      ctx.faceDrag = on;
      if (!on) ctx.seatHit = null;
      if (!on) {
        ctx.faceDown = null;
        ctx.facesKey = "";
        delete canvas.dataset.faces;
      }
      ctx.paintHandles();
      ctx.kick();
    },
    onFacePointer(cb) {
      ctx.faceCb = cb;
    },
    projectPoint(at) {
      // lookAt changes the quaternion and leaves the world matrix behind until the next draw.
      camera.updateMatrixWorld();
      projected.set(at[0], at[1], at[2]);
      projected.project(camera);
      if (projected.z < -1 || projected.z > 1) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
      };
    },
    setAlign(ends) {
      if (!ends) {
        alignLine.visible = false;
        delete canvas.dataset.align;
      } else {
        alignLine.geometry.setFromPoints([new THREE.Vector3(...ends[0]), new THREE.Vector3(...ends[1])]);
        alignLine.computeLineDistances();
        alignLine.visible = true;
        canvas.dataset.align = "1";
      }
      ctx.kick();
    },
    setPull(distance) {
      if (distance == null || !Number.isFinite(distance)) delete canvas.dataset.pull;
      else canvas.dataset.pull = String(Math.round(distance * 10000) / 10000);
    },
    // --- A7 model check ---
    setLocated(boxes) {
      ctx.locatedBoxes = boxes ?? [];
      ctx.paintMarks();
      ctx.kick();
    },
    setCheckBox(box) {
      ctx.checkBox = box;
      ctx.paintMarks();
      ctx.kick();
    },
    // --- A2 shell ---
    setRemovedFaces(on) {
      if (ctx.removedFaces === on && canvas.dataset.removedFaces === (on ? "1" : "0")) return;
      ctx.removedFaces = on;
      canvas.dataset.removedFaces = on ? "1" : "0";
      ctx.paintFaces();
      ctx.paintLines();
      ctx.kick();
    },
    // --- S2 sketch ---
    setSketchCapture(on) {
      ctx.sketchCapture = on;
      if (!on) ctx.sketchPointerId = null;
      ctx.paintHandles();
    },
    onSketchPointer(cb) {
      ctx.sketchCb = cb;
    },
    setSketchDim(on) {
      if (ctx.solidDimmed === on) return;
      ctx.solidDimmed = on;
      solidMaterial.transparent = on;
      solidMaterial.opacity = on ? 0.35 : 1;
      solidMaterial.needsUpdate = true;
      edgeMaterial.transparent = on;
      edgeMaterial.opacity = on ? 0.35 : 1;
      edgeMaterial.needsUpdate = true;
      canvas.dataset.solidOpacity = String(solidMaterial.opacity);
      ctx.kick();
    },
    setSketchDraw(mesh) {
      ctx.clearSketchDraw();
      if (!mesh) {
        sketchGroup.visible = false;
        ctx.kick();
        return;
      }
      sketchGroup.visible = true;
      const buckets = new Map<string, number[]>();
      for (const stroke of mesh.strokes) {
        const pairs = polylinePairs(stroke.xyz);
        if (pairs.length < 6) continue;
        const bag = buckets.get(stroke.role) ?? [];
        bag.push(...pairs);
        buckets.set(stroke.role, bag);
      }
      for (const [role, positions] of buckets) {
        const style = ctx.sketchStrokeStyle(role);
        const line = ctx.fatLine(positions, style.width, style.opacity, style.color);
        if (line) sketchGroup.add(line);
      }
      const dots = new Map<string, Vec3[]>();
      for (const dot of mesh.dots) {
        const bag = dots.get(dot.role) ?? [];
        bag.push(dot.at);
        dots.set(dot.role, bag);
      }
      for (const [role, points] of dots) ctx.addSketchDots(points, role);
      for (const quad of mesh.quads) ctx.addSketchQuad(quad.corners, quad.hot);
      ctx.placeSketchOffset();
      ctx.kick();
    },
    setSketchCamera(command) {
      if (!command) {
        ctx.sketchAnim = null;
        if (ctx.sketchSaved) {
          ctx.applySketchPose(ctx.sketchSaved.pose);
          controls.mouseButtons.MIDDLE = ctx.sketchSaved.middle;
          controls.mouseButtons.RIGHT = ctx.sketchSaved.right;
          controls.enableRotate = true;
          controls.enableZoom = true;
          controls.enablePan = true;
          ctx.sketchSaved = null;
        }
        ctx.applySketchLock(false);
        canvas.dataset.sketchCamera = "free";
        ctx.kick();
        return;
      }
      if (!ctx.sketchSaved) {
        ctx.sketchSaved = {
          pose: ctx.currentSketchPose(),
          middle: controls.mouseButtons.MIDDLE,
          right: controls.mouseButtons.RIGHT,
        };
      }
      const to: CameraPose = { position: command.position, target: command.target, up: command.up };
      if (!(command.animateMs > 0)) {
        ctx.sketchAnim = null;
        ctx.applySketchPose(to);
        ctx.applySketchLock(command.lock);
        ctx.kick();
        return;
      }
      ctx.sketchAnim = { from: ctx.currentSketchPose(), to, start: performance.now(), ms: command.animateMs, lock: command.lock };
      controls.enableRotate = false;
      controls.enableZoom = false;
      canvas.dataset.sketchCamera = "anim";
      ctx.kick();
    },
    setSketchLock(on) {
      if (ctx.sketchAnim) ctx.sketchAnim.lock = on;
      else ctx.applySketchLock(on);
      ctx.kick();
    },
    sketchView() {
      const rect = canvas.getBoundingClientRect();
      const dist = Math.max(1, camera.position.distanceTo(controls.target));
      return {
        fov: camera.fov,
        width: rect.width,
        height: rect.height,
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
        up: [camera.up.x, camera.up.y, camera.up.z],
        mmPerPx: mmPerPixel(dist, camera.fov, Math.max(1, rect.height)),
      };
    },
    rollSketch: ctx.rollSketch,
    pickSolid(x, y) {
      if (!ctx.mesh || !ctx.solid) return null;
      ctx.rayAt(x, y);
      const hit = ctx.solidHit(raycaster.intersectObject(ctx.mesh, false));
      if (!hit || hit.faceIndex == null) return null;
      const face = ctx.solid.triangles[hit.faceIndex];
      if (face == null) return null;
      return { face, t: hit.distance };
    },
    onSketchView(cb) {
      ctx.sketchViewCb = cb;
    },
  };
}
