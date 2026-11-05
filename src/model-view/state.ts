/** The view's shared state: what the open solid, picks, ghost, handles, sketch and stress code all read and write. */
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { hexToThree } from "../theme";
import { idleLook } from "../model-look";
import type { ViewCtx } from "./ctx";

export function installState(ctx: ViewCtx): void {
  const { canvas, scene } = ctx;


  ctx.solid = null;
  /** The open solid's box in model space. */
  ctx.solidBox = null;
  /** The open solid's box in its own frame. */
  ctx.ownBox = null;
  ctx.bedOn = true;
  ctx.boundaries = new Map<number, number[]>();
  ctx.center = new THREE.Vector3();
  ctx.extent = 1;
  ctx.mode = "face";
  ctx.mesh = null;
  ctx.edgeLines = null;
  /** A dry-run's shape in the solid's place, and its edges. The solid stays, hidden, for picks. */
  ctx.preview = null;
  ctx.faceOutline = null;
  ctx.locatedBoxes = [];
  ctx.checkBox = null;
  ctx.selectedEdges = null;
  ctx.hoverEdges = null;
  /** --- Print transitions, auto-find: the edges found, and the one lit. */
  ctx.flaggedEdges = null;
  ctx.litEdge = null;
  ctx.flagged = { edges: [], lit: null };
  /** --- A10. The section's clip plane, in world space, while a section is on: the picks and their outlines keep to the side shown. */
  ctx.sectionClip = [];
  const fatLines: LineMaterial[] = [];
  ctx.fatLines = fatLines;
  ctx.picks = [];
  ctx.hover = null;
  /** P2. Edge lighting and the fillet knob, drawn beside whatever tool handles are up. */
  ctx.edgeHoverOn = false;
  ctx.edgeLit = null;
  ctx.edgeHoverCb = () => {};
  ctx.edgeKnobPart = null;
  ctx.edgeDrag = null;
  ctx.edgeKnobCb = () => {};
  ctx.ghost = null;
  ctx.datumPlane = null;
  const datumLines: LineMaterial[] = [];
  ctx.datumLines = datumLines;
  ctx.datumPick = false;
  // --- A10. Section and colour by step. The arrow is scene-space, so a tool's handles stay in front of it.
  ctx.look = idleLook();
  ctx.sectionDragCb = () => {};
  ctx.highlightStep = null;
  ctx.sectionPlaneWorld = null;
  ctx.sectionArrow = null;
  ctx.stressSeat = new THREE.Vector3();
  ctx.stressHold = new Set<number>();
  ctx.stressLoad = new Set<number>();
  ctx.stressProbeCb = () => {};
  ctx.stressDirCb = () => {};
  const INSIDE = 0xcd463c;
  ctx.INSIDE = INSIDE;
  const sectionCapMaterial = new THREE.MeshBasicMaterial({
    color: INSIDE,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  ctx.sectionCapMaterial = sectionCapMaterial;
  /** Picked faces a shell will open: danger tint and a dashed outline, over the dry-run. */
  ctx.removedFaces = false;
  ctx.pickCb = () => {};
  ctx.down = null;
  ctx.handleParts = [];
  const dockAt = new THREE.Vector3();
  ctx.dockAt = dockAt;
  ctx.aspectDim = false;
  /** Bumps when the ghost is rebuilt. An in-place size change does not bump it. */
  ctx.ghostSerial = 0;
  /** Bumps when the same primitive's numbers are written into the ghost it already has. */
  ctx.ghostPose = 0;
  /** The primitive ghost last built, so a size drag can scale it or write positions instead of rebuilding. */
  ctx.posedPrimitive = null;
  /** The panel or HUD field that has focus, so its handle lights without a pointer. */
  ctx.focusedField = null;
  /** Which sketch hole the focused depth belongs to, when several share one number. */
  ctx.focusedHole = null;
  /** The panel's one depth field lights every hole, not the first knob's. */
  ctx.lightEveryHole = false;
  ctx.aspectNow = null;
  /** Occlusion ray for a lit edge. A binding placed after the returned object would never initialise. */
  const depthRay = new THREE.Raycaster();
  ctx.depthRay = depthRay;
  ctx.overHandle = null;
  ctx.drag = null;
  ctx.handleCb = () => {};
  // --- P1 ---
  ctx.faceDrag = false;
  ctx.faceCb = () => {};
  ctx.faceDown = null;
  /** P1. The face hit the push arrow is seated on, so a press on the arrow drags that face. */
  ctx.seatHit = null;
  ctx.facesKey = "";
  // --- S2 sketch ---
  ctx.sketchCapture = false;
  ctx.sketchLock = false;
  ctx.sketchCb = () => {};
  ctx.sketchViewCb = () => {};
  ctx.sketchPointerId = null;
  ctx.sketchAnim = null;
  ctx.sketchSaved = null;
  const sketchNormal = new THREE.Vector3(0, 0, 1);
  ctx.sketchNormal = sketchNormal;
  ctx.solidDimmed = false;
  const tip = document.createElement("div");
  ctx.tip = tip;
  tip.className = "model-drag-tip";
  tip.hidden = true;
  canvas.parentElement?.append(tip);
  const snapMark = document.createElement("div");
  ctx.snapMark = snapMark;
  snapMark.className = "model-snap-mark";
  snapMark.hidden = true;
  const snapMarkText = document.createElement("span");
  ctx.snapMarkText = snapMarkText;
  snapMark.append(snapMarkText);
  canvas.parentElement?.append(snapMark);
  /** What a Measure point is snapped to, for the marker and the readout; null when it is free on the surface. */
  ctx.snappedTo = null;
  /** What the last Measure ray struck, snapped or not, for the readout's labels. */
  ctx.struck = null;
  /** The open solid's pose, as the app last set it. */
  ctx.poseNow = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  ctx.contextList = [];
  /** The grey object a snap or Align to... has picked: its grey is swapped for the amber of the snap guides. */
  ctx.markedTarget = null;
  ctx.alignMark = null;
  canvas.dataset.snapTarget = "";
  ctx.grabHooks = null;
  /** Whether the Measure tool's points are on screen, so its features are worth building ahead. */
  ctx.measureOpen = false;
  /** What a move snaps on, built when the drag starts: where the part stands, its neighbours, and how big a millimetre is on screen. */
  ctx.snapRun = null;
  ctx.snapLabel = null;
  const snapGroup = new THREE.Group();
  ctx.snapGroup = snapGroup;
  const snapLineMat = new LineMaterial({ color: hexToThree(ctx.colors.amber), linewidth: 2.5, transparent: true, depthTest: false, worldUnits: false, toneMapped: false });
  ctx.snapLineMat = snapLineMat;
  scene.add(snapGroup);
  const aspectLabel = document.createElement("div");
  ctx.aspectLabel = aspectLabel;
  aspectLabel.className = "model-aspect-label";
  aspectLabel.hidden = true;
  canvas.parentElement?.append(aspectLabel);

  const raycaster = new THREE.Raycaster();
  ctx.raycaster = raycaster;
  const pointer = new THREE.Vector2();
  ctx.pointer = pointer;
  const projected = new THREE.Vector3();
  ctx.projected = projected;
  const yAxis = new THREE.Vector3(0, 1, 0);
  ctx.yAxis = yAxis;
  const zAxis = new THREE.Vector3(0, 0, 1);
  ctx.zAxis = zAxis;
}
