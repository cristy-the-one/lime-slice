import * as THREE from "three";
/** Pose stage: select, link and edit joints without changing the print layout. */
import { assemblyOf, memberPose, readJoint, rotationQuaternion, samePose, solveAssembly, withMember, type Assembly, type Joint, type Member } from "../assembly.ts";
import { boundsOf } from "../mesh-place.ts";
import { applyPose, inversePose, isIdentity, turnDir, type Affine } from "../model-space.ts";
import { meshSeat, modelPoseOf } from "../plate.ts";
import { linked, poseChain, solvePose, turnBall, turnHinge } from "../pose.ts";
import { createPoseView, type PoseCamera, type PoseHit, type PoseView, type ReachEvent, type TurnEvent } from "../pose-view.ts";
import { cylinderJoint } from "../pose-cylinder.ts";
import { loadModel } from "./workspaces.ts";
import { markProjectDirty } from "../project-dirty.ts";
import type { Vec3 } from "../model-tree.ts";
import { assembledParts, assemblyClashes, liveAssemblies, syncAssemblyView } from "./assemblies.ts";
import { fx } from "./fx.ts";
import { cancelEdit, holdEdit, noteEdit, flushEdit, redoUserEdit, undoUserEdit } from "./history.ts";
import { refreshObjectList } from "./settings.ts";
import { session, state } from "./state.ts";

type Tool = "select" | "turn" | "joint" | "link" | "reach";
let view: PoseView | null = null;
let tool: Tool = "select";
let linkParent: string | null = null;
let message = "";
let sceneShift: Affine | undefined;
let chainSelected = false;
let dragging = false;
let dragStart: Member | null = null;
let reachStart: { assembly: Assembly; object: string; at: Vec3; poses: Map<string, Affine>; centres: Map<string, Vec3>; shift: Affine } | null = null;
let reachDistance: number | null = null;
let lastClashes = new Set<string>();
let pickSerial = 0;

function poseOf(id: string): Affine | undefined {
  const object = state.plate.objects.find((row) => row.id === id);
  return object ? modelPoseOf(object) : undefined;
}
function selected(): { assembly: Assembly; member: Member } | null {
  const id = state.plate.selectedId;
  if (!id) return null;
  const assembly = assemblyOf(liveAssemblies(), id);
  const member = assembly?.members.find((row) => row.object === id);
  return assembly && member ? { assembly, member } : null;
}
function centre(id: string): Vec3 {
  const object = state.plate.objects.find((row) => row.id === id);
  if (!object || object.sourcePos.length < 3) return [0, 0, 0];
  const box = boundsOf(object.sourcePos);
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2 + (meshSeat(object.bytes) ?? 0)];
}

/** Persist an assembly and its solved model poses; never touch the bed layout or slice state. */
function writeAssembly(assembly: Assembly, poses?: Map<string, Affine>): void {
  session.assemblies = session.assemblies.map((row) => row.id === assembly.id ? assembly : row);
  const solved = poses ?? solveAssembly(assembly, poseOf).poses;
  state.plate = { ...state.plate, objects: state.plate.objects.map((part) => {
    const pose = solved.get(part.id);
    if (!pose || samePose(modelPoseOf(part), pose)) return part;
    const next = { ...part };
    if (isIdentity(pose)) delete next.modelPose;
    else next.modelPose = pose;
    return next;
  }) };
  markProjectDirty();
  if (dragging) syncPose();
  else refreshPoseConsumers();
}
function refreshPoseConsumers(): void {
  syncAssemblyView();
  refreshObjectList();
  fx.refreshModelContext?.();
}
function editAssembly(assembly: Assembly): void {
  noteEdit();
  writeAssembly(assembly);
  flushEdit();
}
function replaceMember(assembly: Assembly, member: Member): void {
  const next = withMember(assembly, member);
  if ("reason" in next) { message = next.reason; renderPanel(); return; }
  editAssembly(next);
}
function setTool(next: Tool): void {
  view?.cancelReach();
  pickSerial++;
  tool = next;
  view?.setReach(next === "reach");
  chainSelected = false;
  linkParent = null;
  message = next === "link" ? "Choose the parent, then its child." : next === "reach" ? "Drag a point on a jointed part." : next === "joint" ? "Select a linked part, then click its cylindrical face. Shift-click a mesh to snap its pivot." : "";
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-pose-tool]")) button.setAttribute("aria-pressed", String(button.dataset.poseTool === tool));
  syncPose();
}
async function pickJoint(id: string, hit: PoseHit): Promise<void> {
  const row = selected();
  const object = state.plate.objects.find((part) => part.id === id);
  if (!row || !row.member.parent || !object || !sceneShift) { message = "Select a linked child to place its joint."; renderPanel(); return; }
  const serial = ++pickSerial;
  const memberBefore = JSON.stringify(row.member);
  const inverse = inversePose(modelPoseOf(object));
  const sceneInverse = inversePose(sceneShift);
  const localPoint = (point: readonly number[]) => applyPose(inverse, applyPose(sceneInverse, point));
  message = "Reading the selected face…"; renderPanel();
  try {
    const solid = object.modelTree || object.brep || /\.(step|stp)$/i.test(object.fileName) ? await (await loadModel()).poseSolid(object) : null;
    if (serial !== pickSerial || state.stage !== "pose" || tool !== "joint" || state.plate.selectedId !== id || state.plate.objects.find((part) => part.id === id) !== object || JSON.stringify(selected()?.member) !== memberBefore) return;
    let pivot: Vec3 | undefined;
    let axis: Vec3 | undefined;
    if (typeof solid === "string") { message = solid; renderPanel(); return; }
    if (solid) {
      const origin = localPoint(hit.ray.origin);
      const direction = turnDir(inverse, turnDir(sceneInverse, hit.ray.direction));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(solid.positions, 3));
      const material = new THREE.MeshBasicMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      const ray = new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction));
      const faceIndex = ray.intersectObject(mesh, false)[0]?.faceIndex;
      geometry.dispose(); material.dispose();
      const pickedFace = faceIndex == null ? undefined : solid.triangles[faceIndex];
      const canvas = document.querySelector<HTMLCanvasElement>("#pose");
      if (canvas) canvas.dataset.jointFace = pickedFace === undefined ? "" : String(pickedFace);
      const picked = pickedFace === undefined ? null : cylinderJoint(solid, pickedFace);
      if (!picked) { message = "Click a cylindrical face to place the joint."; renderPanel(); return; }
      ({ pivot, axis } = picked);
    } else {
      if (!hit.shift) { message = "For a mesh, Shift-click a vertex, edge midpoint or box centre; type the axis."; renderPanel(); return; }
      const vertices = hit.triangle.map(localPoint);
      const candidates = [...vertices, ...vertices.map((v, i) => v.map((n, k) => (n + vertices[(i + 1) % vertices.length]![k]!) / 2) as Vec3), centre(id)];
      const at = localPoint(hit.point);
      candidates.sort((a, b) => Math.hypot(...a.map((v, i) => v - at[i]!)) - Math.hypot(...b.map((v, i) => v - at[i]!)));
      pivot = candidates[0];
    }
    if (!pivot) return;
    const current = selected();
    if (!current || current.member.object !== id) return;
    const old = current.member.joint;
    const joint: Joint = old?.kind === "ball" ? { ...old, pivot } : { ...(old?.kind === "hinge" ? old : { kind: "hinge" as const, angle: 0 }), pivot, axis: axis ?? (old?.kind === "hinge" ? old.axis : [0, 0, 1]) };
    message = solid ? "Joint placed on the cylindrical face." : "Pivot snapped. Type the joint axis.";
    replaceMember(current.assembly, { ...current.member, joint });
  } catch (error) {
    if (serial === pickSerial) { message = `Could not read the selected face: ${error instanceof Error ? error.message : String(error)}`; renderPanel(); }
  }
}
function pick(id: string | null, hit?: PoseHit): void {
  if (!id) return;
  if (tool === "link") {
    if (!linkParent) { linkParent = id; message = "Now choose the child."; fx.selectPlateObject(id); syncPose(); return; }
    const parent = linkParent;
    linkParent = null;
    const assembly = assemblyOf(liveAssemblies(), parent);
    if (!assembly) { message = "Attach the parent to an assembly in Prepare first."; renderPanel(); return; }
    const next = linked(assembly, id, parent, poseOf);
    if ("reason" in next) { message = next.reason; renderPanel(); return; }
    fx.selectPlateObject(id);
    editAssembly(next);
    message = "Linked. Both parts kept their positions.";
    syncPose();
    return;
  }
  if (id !== state.plate.selectedId) { pickSerial++; chainSelected = false; fx.selectPlateObject(id); }
  else if (tool === "joint" && hit) { void pickJoint(id, hit); }
  else if (tool === "select") { chainSelected = !chainSelected; syncPose(); }
}
function turn(event: TurnEvent): void {
  if (event.phase === "start") { const row = selected(); if (!row?.member.joint) return; holdEdit(); dragging = true; dragStart = structuredClone(row.member); return; }
  if (event.phase === "end") { if (dragging) flushEdit(); dragging = false; dragStart = null; refreshPoseConsumers(); return; }
  const row = selected();
  if (!row?.member.joint || !dragStart?.joint || dragStart.object !== row.member.object) return;
  const joint = dragStart.joint;
  const axis: Vec3 = event.axis === 0 ? [1, 0, 0] : event.axis === 1 ? [0, 1, 0] : [0, 0, 1];
  const turned = joint.kind === "hinge" ? turnHinge(dragStart, event.delta) : turnBall(dragStart, axis, event.delta, centre(row.member.object));
  if ("reason" in turned) { message = turned.reason; renderPanel(); return; }
  const next = withMember(row.assembly, turned);
  if ("reason" in next) { message = next.reason; return; }
  writeAssembly(next);
}

/** A Reach gesture always solves from its starting pose, and is one undo step. */
function reach(event: ReachEvent): boolean | void {
  if (event.phase === "start") {
    if (!sceneShift) return false;
    if (event.object !== state.plate.selectedId) fx.selectPlateObject(event.object);
    const row = selected();
    if (!row || !poseChain([row.assembly], event.object).size) {
      message = "This part has no jointed chain to reach with."; renderPanel(); return false;
    }
    const objectPose = poseOf(event.object);
    if (!objectPose) return false;
    const inModel = applyPose(inversePose(sceneShift), event.point);
    const poses = new Map(state.plate.objects.map((part) => [part.id, structuredClone(modelPoseOf(part))]));
    const centres = new Map<string, Vec3>();
    for (const id of poseChain([row.assembly], event.object)) {
      const joint = row.assembly.members.find((member) => member.object === id)?.joint;
      if (joint?.kind === "ball" && joint.cone !== undefined) centres.set(id, centre(id));
    }
    reachStart = { assembly: structuredClone(row.assembly), object: event.object, at: applyPose(inversePose(objectPose), inModel), poses, centres, shift: structuredClone(sceneShift) };
    const canvas = document.querySelector<HTMLCanvasElement>("#pose");
    if (canvas) { canvas.dataset.reachObject = event.object; canvas.dataset.reachLocal = JSON.stringify(reachStart.at); }
    reachDistance = null;
    holdEdit(); dragging = true;
    return true;
  }
  if (event.phase === "cancel" || event.phase === "end") {
    const cancelled = event.phase === "cancel";
    const wasDragging = dragging;
    dragging = false; reachStart = null;
    if (wasDragging) { if (cancelled) cancelEdit(); else flushEdit(); }
    message = cancelled ? "Reach cancelled." : reachDistance !== null && reachDistance > 0.05 ? `The grabbed point is ${reachDistance.toFixed(2)} mm from the target.` : "";
    refreshPoseConsumers();
    return;
  }
  if (!reachStart) return;
  const target = applyPose(inversePose(reachStart.shift), event.target);
  const result = solvePose(reachStart.assembly, (id) => reachStart?.poses.get(id), reachStart.object, reachStart.at, target, (id) => reachStart?.centres.get(id));
  if ("reason" in result) { message = result.reason; return; }
  reachDistance = result.distance;
  const canvas = document.querySelector<HTMLCanvasElement>("#pose");
  if (canvas) {
    canvas.dataset.reachAnchor = result.anchor;
    canvas.dataset.reachTarget = JSON.stringify(target);
    canvas.dataset.reachPoint = JSON.stringify(result.point);
    canvas.dataset.reachDistance = String(result.distance);
  }
  writeAssembly(result.assembly, result.poses);
}

function mount(): PoseView | null {
  if (view) return view;
  const canvas = document.querySelector<HTMLCanvasElement>("#pose");
  if (!canvas) return null;
  view = createPoseView(canvas);
  view.onPick(pick);
  view.onTurn(turn);
  view.onReach(reach);
  document.querySelector("#toolRail")?.addEventListener("click", (event) => {
    const value = (event.target as Element).closest<HTMLButtonElement>("[data-pose-tool]")?.dataset.poseTool;
    if (value === "select" || value === "turn" || value === "joint" || value === "link" || value === "reach") setTool(value);
  });
  document.querySelector("#poseViewPresets")?.addEventListener("click", (event) => {
    const preset = (event.target as Element).closest<HTMLElement>("[data-pose-view]")?.dataset.poseView;
    if (preset === "top" || preset === "front" || preset === "iso") view?.setCamera(preset as PoseCamera);
  });
  document.querySelector("#posePanel")?.addEventListener("click", panelClick);
  document.querySelector("#posePanel")?.addEventListener("change", panelChange);
  window.addEventListener("keydown", (event) => { if (state.stage === "pose" && event.key === "Escape") setTool("select"); });
  fx.syncPose = syncPose;
  return view;
}
export function showPose(): void {
  const poseView = mount();
  if (!poseView) return;
  sceneShift = undefined;
  poseView.resize();
  syncPose();
}
export function syncPose(): void {
  if (!view || state.stage !== "pose") return;
  const { bedX, bedY, bedZ } = state.profile;
  const placed = assembledParts(bedX, bedY, sceneShift);
  sceneShift ??= placed.shift;
  const assemblies = liveAssemblies();
  if (!dragging) lastClashes = assemblies.length ? new Set(assemblyClashes().flatMap((row) => [row.a, row.b])) : new Set<string>();
  const clashing = lastClashes;
  const row = selected();
  const object = row && state.plate.objects.find((part) => part.id === row.member.object);
  let gizmo: { pivot: Vec3; axes: Vec3[]; radius: number } | undefined;
  if (tool === "turn" && row?.member.parent && row.member.joint && object && sceneShift) {
    const pose = modelPoseOf(object), joint = row.member.joint;
    const pivot = applyPose(sceneShift, applyPose(pose, joint.pivot));
    const axes: Vec3[] = joint.kind === "hinge" ? [turnDir(pose, joint.axis)] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((axis) => turnDir(pose, axis));
    const b = boundsOf(object.sourcePos);
    gizmo = { pivot, axes, radius: Math.max(8, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.55) };
  }
  const chain = poseChain(assemblies, state.plate.selectedId);
  const marks: { pivot: Vec3; axis?: Vec3 }[] = [];
  if (sceneShift) for (const id of chain) {
    const part = state.plate.objects.find((object) => object.id === id);
    const joint = assemblyOf(assemblies, id)?.members.find((member) => member.object === id)?.joint;
    if (!part || !joint) continue;
    const pose = modelPoseOf(part);
    marks.push({ pivot: applyPose(sceneShift, applyPose(pose, joint.pivot)), ...(joint.kind === "hinge" ? { axis: turnDir(pose, joint.axis) } : {}) });
  }
  view.setBed(bedX, bedY, bedZ);
  view.setScene({ parts: placed.parts, selectedId: state.plate.selectedId, chain, clashing, marks, ...(gizmo ? { gizmo } : {}) });
  const empty = document.querySelector<HTMLElement>("#poseEmpty");
  if (empty) empty.hidden = placed.parts.length > 0;
  if (!dragging) renderPanel();
}
export function setPoseTheme(): void { view?.setTheme(); }

function addText(parent: HTMLElement, tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; parent.append(node); return node;
}
function button(parent: HTMLElement, text: string, action: string): HTMLButtonElement {
  const node = document.createElement("button"); node.type = "button"; node.className = "btn"; node.dataset.poseAction = action; node.textContent = text; parent.append(node); return node;
}
function field(parent: HTMLElement, label: string, name: string, value: number | undefined, placeholder = ""): void {
  const wrap = document.createElement("label"); wrap.className = "pose-field";
  addText(wrap, "span", label);
  const input = document.createElement("input"); input.type = "number"; input.step = "any"; input.dataset.poseField = name; input.value = value === undefined ? "" : String(Math.round(value * 10000) / 10000); input.placeholder = placeholder; input.setAttribute("aria-label", label); wrap.append(input); parent.append(wrap);
}
function renderPanel(): void {
  const panel = document.querySelector<HTMLElement>("#posePanel");
  if (!panel || state.stage !== "pose") return;
  panel.replaceChildren();
  addText(panel, "h3", "Parts");
  const tree = document.createElement("div"); tree.className = "pose-tree"; panel.append(tree);
  const assemblies = liveAssemblies();
  const listed = new Set<string>();
  const addPart = (id: string, depth: number) => {
    const part = state.plate.objects.find((object) => object.id === id); if (!part || listed.has(id)) return;
    listed.add(id); const entry = button(tree, part.name, "select"); entry.dataset.object = id; entry.style.paddingLeft = `${8 + depth * 16}px`; entry.setAttribute("aria-pressed", String(state.plate.selectedId === id));
  };
  for (const assembly of assemblies) {
    addText(tree, "strong", assembly.name);
    const walk = (parent: string | null, depth: number) => { for (const member of assembly.members.filter((item) => item.parent === parent)) { if (listed.has(member.object)) continue; addPart(member.object, depth); walk(member.object, depth + 1); } };
    walk(null, 0);
  }
  for (const part of state.plate.objects) addPart(part.id, 0);
  if (message) addText(panel, "p", message);
  if (chainSelected) addText(panel, "p", "Chain selected. Press Esc to select the part.");
  const row = selected();
  if (!row) { addText(panel, "p", "Select an assembly member to add a joint. Attach free parts in Prepare."); return; }
  addText(panel, "h3", state.plate.objects.find((item) => item.id === row.member.object)?.name ?? row.member.object);
  const parentName = state.plate.objects.find((item) => item.id === row.member.parent)?.name;
  addText(panel, "p", parentName ? `Parent: ${parentName}` : "Assembly root (fixed)");
  if (!row.member.parent) return;
  const label = document.createElement("label"); label.className = "pose-field"; addText(label, "span", "Joint");
  const select = document.createElement("select"); select.dataset.poseField = "kind"; select.setAttribute("aria-label", "Joint kind");
  for (const [value, name] of [["none", "Fixed"], ["hinge", "Hinge"], ["ball", "Ball"]]) { const option = document.createElement("option"); option.value = value!; option.textContent = name!; select.append(option); }
  select.value = row.member.joint?.kind ?? "none"; label.append(select); panel.append(label);
  const joint = row.member.joint;
  if (joint) {
    for (let i = 0; i < 3; i++) field(panel, `Pivot ${"XYZ"[i]} mm`, `pivot${i}`, joint.pivot[i]);
    if (joint.kind === "hinge") {
      for (let i = 0; i < 3; i++) field(panel, `Axis ${"XYZ"[i]}`, `axis${i}`, joint.axis[i]);
      field(panel, "Angle °", "angle", joint.angle ?? 0);
      field(panel, "Minimum °", "min", joint.min, "Free"); field(panel, "Maximum °", "max", joint.max, "Free");
    } else field(panel, "Cone °", "cone", joint.cone, "Free");
  }
  const actions = document.createElement("div"); actions.className = "pose-buttons"; panel.append(actions);
  button(actions, "Rest", "rest"); button(actions, "Make rest", "make-rest"); button(actions, "Undo", "undo"); button(actions, "Redo", "redo");
}
function panelClick(event: Event): void {
  const target = (event.target as Element).closest<HTMLButtonElement>("[data-pose-action]");
  if (!target) return;
  const action = target.dataset.poseAction;
  if (action === "select" && target.dataset.object) { pick(target.dataset.object); return; }
  if (action === "undo") { undoUserEdit(); syncPose(); return; }
  if (action === "redo") { redoUserEdit(); syncPose(); return; }
  const row = selected(); if (!row || (action !== "rest" && action !== "make-rest")) return;
  const ids = poseChain([row.assembly], row.member.object);
  let assembly = row.assembly;
  for (const member of assembly.members) {
    if (!ids.has(member.object) || !member.joint) continue;
    let updated: Member = member;
    if (action === "rest" && member.joint.kind === "hinge") {
      const result = turnHinge(member, -(member.joint.angle ?? 0));
      if ("reason" in result) { message = result.reason; renderPanel(); return; }
      updated = result;
    } else if (action === "make-rest") {
      const joint = member.joint.kind === "hinge" ? { ...member.joint, angle: 0 } : { ...member.joint, rest: rotationQuaternion(memberPose(member).m) };
      // Limits are relative to rest; translate them with the hinge's zero point.
      if (joint.kind === "hinge" && member.joint.kind === "hinge") {
        const old = member.joint.angle ?? 0;
        if (joint.min !== undefined) joint.min -= old;
        if (joint.max !== undefined) joint.max -= old;
      }
      updated = { ...member, joint };
    }
    const next = withMember(assembly, updated); if (!("reason" in next)) assembly = next;
  }
  editAssembly(assembly);
}
function panelChange(event: Event): void {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  const name = input.dataset.poseField;
  const row = selected(); if (!name || !row || !row.member.parent) return;
  message = "";
  if (name === "kind") {
    const kind = input.value;
    const pivot = row.member.joint?.pivot ?? [0, 0, 0];
    const joint: Joint | undefined = kind === "hinge" ? { kind, pivot, axis: [0, 0, 1], angle: 0 } : kind === "ball" ? { kind, pivot, rest: rotationQuaternion(memberPose(row.member).m) } : undefined;
    const { joint: _joint, ...plain } = row.member;
    replaceMember(row.assembly, joint ? { ...plain, joint } : plain);
    return;
  }
  const old = row.member.joint; if (!old) return;
  const optional = name === "min" || name === "max" || name === "cone";
  const value = input.value.trim() === "" && optional ? undefined : Number(input.value);
  if ((value === undefined && !optional) || (value !== undefined && (!Number.isFinite(value) || input.value.trim() === ""))) { message = "Enter a finite number."; renderPanel(); return; }
  if (name === "angle" && old.kind === "hinge") {
    const next = turnHinge(row.member, value! - (old.angle ?? 0));
    if ("reason" in next) { message = next.reason; renderPanel(); return; }
    replaceMember(row.assembly, next); return;
  }
  const raw = structuredClone(old) as Joint;
  if (name.startsWith("pivot")) raw.pivot[Number(name.slice(-1))] = value!;
  else if (name.startsWith("axis") && raw.kind === "hinge") raw.axis[Number(name.slice(-1))] = value!;
  else if ((name === "min" || name === "max") && raw.kind === "hinge") { if (value === undefined) delete raw[name]; else raw[name] = value; }
  else if (name === "cone" && raw.kind === "ball") { if (value === undefined) delete raw.cone; else raw.cone = value; }
  const checked = readJoint(raw);
  if (!checked) { message = "Check the axis, limits and current angle; the joint was not changed."; renderPanel(); return; }
  replaceMember(row.assembly, { ...row.member, joint: checked });
}
