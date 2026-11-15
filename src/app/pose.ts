import * as THREE from "three";
/** Pose stage: select, link and edit joints without changing the print layout. */
import { assemblyOf, bodyOf, couplingNames, drives, freshAssemblyId, jointAt, memberFields, memberPose, readJoint, rotationQuaternion, samePose, solveAssembly, turnsOnPlate, withCouplings, withFound, withMember, type Assembly, type DeclaredKind, type Joint, type Member } from "../assembly.ts";
import { gearsInTree, type WorldGear } from "../gear-pair.ts";
import { couplingLine, crossedNotes, declareCoupling, findCouplings, prepareTrain, preparedLines, trainCheck, trainScales, trainTurn, type DeclareSpec, type GearPart, type Turned } from "../gear-train.ts";
import { modelTrees } from "./model-trees.ts";
import { boundsOf } from "../mesh-place.ts";
import { applyPose, inversePose, isIdentity, poseScale, seatLift, thenPose, turnDir, type Affine } from "../model-space.ts";
import { meshSeat, meshToModel, modelPoseOf } from "../plate.ts";
import { aboutAxis, bodyOf as massBodyOf, movingBody, partIntegrals, swing, type BodyPart } from "../mass.ts";
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
import { exportAssembly } from "./plate-actions.ts";
import { session, state } from "./state.ts";
import { PosePlayback } from "../pose-playback.ts";
import type { AnimationResult, AnimationPart, PoseAnimation } from "../pose-anim.ts";
import type { AnimationStage } from "../recipe/animation-run.ts";
import { bodySha256, pluginFileText, readPluginFile, type PluginFileInfo, type PluginParamInfo } from "../plugin-file.ts";
import { apiVerdict } from "../recipe/api-level.ts";
import { RECIPE_API } from "../plugin-step.ts";
import type { ContactJob, ContactJobReply } from "../contact-worker.ts";

/** One turn of a train's first gear, in steps that are no whole number of teeth for any likely gear (as the MCP checks). */
const CHECK_ANGLES = Array.from({ length: 24 }, (_, i) => (i * 360) / 23);

type Tool = "select" | "turn" | "joint" | "link" | "reach";
let view: PoseView | null = null;
let tool: Tool = "select";
let linkParent: string | null = null;
let message = "";
let sceneShift: Affine | undefined;
let chainSelected = false;
let dragging = false;
let dragStart: Member | null = null;
/** The assembly at the start of a hinge drag: a gear train turns from it, so a drag never drifts. */
let dragAssembly: Assembly | null = null;
/** The Couplings form (docs/plan-coupling-kinds.md): what is typed, kept while the panel is drawn again. */
type CoupleKind = DeclaredKind;
interface CoupleDraft { driven: string; kind: CoupleKind; ratio: string; radius: string; wind: string; free: string; click: string; teeth: string; tip: string; root: string }
const EMPTY_DRAFT: CoupleDraft = { driven: "", kind: "ratio", ratio: "", radius: "", wind: "in", free: "1", click: "", teeth: "", tip: "", root: "" };
let coupleDraft: CoupleDraft = { ...EMPTY_DRAFT };
/** The part the form was filled for: another selection starts it again. */
let coupleDraftFor: string | null = null;
/** What the last Couple or Remove said, for the assembly it ran on. */
let coupleNote: { assembly: string; text: string } | null = null;
/** A clutch that slipped or a ratchet that held, said after a turn. */
function turnWords(turned: Turned): string {
  return [...(turned.slipped ?? []), ...(turned.stopped ? [`Stopped: ${turned.stopped}`] : [])].join(" ");
}
/** What the last Couple gears said: pairs not coupled and why, for the assembly it ran on. */
let gearNotes: { assembly: string; lines: string[]; made?: string[] } | null = null;
let reachStart: { assembly: Assembly; object: string; at: Vec3; poses: Map<string, Affine>; centres: Map<string, Vec3>; shift: Affine } | null = null;
let reachDistance: number | null = null;
let lastClashes = new Set<string>();
let pickSerial = 0;
let animationFiles: PluginFileInfo[] = [];
let animationChoice = "";
const animationParameters = new Map<string, Record<string, string | number | boolean>>();
let animationParameterProject: unknown;
let animationParameterPlugins: unknown;
let animationRun = 0;
export interface PoseAnimationState { result: AnimationResult; spec: PoseAnimation; camera?: unknown; original: Assembly; poses: Map<string, Affine | undefined>; parts: AnimationPart[]; clock: PosePlayback; assembly: string; plugin: { sha: string; text: string; name: string; source: string; api: string; params: Record<string, unknown> }; swatches?: Map<string, string>; background?: string | undefined }
let animation: PoseAnimationState | null = null;
/** "Until contact" (docs/plan-contact-poses.md): the solve running, and what the last one said, for the part it ran on. */
let contactBusy = false;
let contactNote: { object: string; text: string } | null = null;
let contactWorker: Worker | null = null;
let contactJob = 0;
let animationRequest = 0;
/**
 * An animation being prepared: its script built and run, its frames made off the window's thread. One at a time: Play
 * does nothing while one is prepared, and Cancel (or Esc) stops it and leaves the panel as it was.
 */
let preparing: { ticket: number; controller: AbortController; stage: AnimationStage | { stage: "start" } } | null = null;
let progressRequest = 0;

function stopAnimation(): void {
  if (animationRequest) cancelAnimationFrame(animationRequest);
  animationRequest = 0;
  animation = null;
}
/** The frame the last tick drew, or -1 when the next tick must draw. */
let animationDrawn = -1;
function animationTick(): void {
  if (!animation || state.stage !== "pose") { stopAnimation(); return; }
  const frame = animation.clock.frame(performance.now());
  // The display refreshes more often than the animation steps: a tick inside the same frame has nothing to draw.
  if (frame !== animationDrawn || !animation.clock.playing) {
    animationDrawn = frame;
    syncPose();
    const slider = document.querySelector<HTMLInputElement>("[data-pose-animation-frame]");
    const label = document.querySelector<HTMLElement>("[data-pose-animation-count]");
    if (slider) slider.value = String(frame);
    if (label) label.textContent = `Frame ${frame + 1} / ${animation.result.frames.length}`;
  }
  if (animation.clock.playing) animationRequest = requestAnimationFrame(animationTick);
  else { animationRequest = 0; renderPanel(); }
}
async function refreshAnimations(): Promise<void> {
  const { loadLibrary, pluginLibrary } = await import("../ui/plugins-panel.ts");
  await loadLibrary();
  if (animationParameterProject !== session.mcpModel || animationParameterPlugins !== session.plugins) {
    animationParameters.clear(); animationParameterProject = session.mcpModel; animationParameterPlugins = session.plugins;
  }
  const files = [...pluginLibrary().plugins.values()].map((row) => row.file);
  for (const text of Object.values(session.plugins ?? {})) {
    const file = readPluginFile(text); if (file) files.push(file);
  }
  const saved = session.mcpModel?.animations;
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    for (const [name, value] of Object.entries(saved)) {
      const row = value as { source?: unknown; api?: unknown; params?: unknown } | null;
      if (!row || typeof row.source !== "string") continue;
      const existing = readPluginFile(row.source);
      const id = existing?.kind === "animation" ? existing.plugin : name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "animation";
      if (!animationParameters.has(id) && row.params && typeof row.params === "object" && !Array.isArray(row.params)) {
        const values = Object.entries(row.params).filter((entry): entry is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof entry[1]));
        animationParameters.set(id, Object.fromEntries(values));
      }
      if (existing?.kind === "animation") { files.push(existing); continue; }
      if (files.some((file) => file.kind === "animation" && file.plugin === id)) continue;
      const params: PluginParamInfo[] = [];
      if (row.params && typeof row.params === "object" && !Array.isArray(row.params)) for (const [key, defaultValue] of Object.entries(row.params)) {
        if (typeof defaultValue === "boolean") params.push({ name: key, kind: "toggle", default: defaultValue });
        else if (typeof defaultValue === "number") params.push({ name: key, kind: "number", default: defaultValue });
        else if (typeof defaultValue === "string") params.push({ name: key, kind: "text", default: defaultValue });
      }
      const code = row.source.replace(/\r\n?/g, "\n").replace(/^\n+/, "");
      const sha256 = await bodySha256(code);
      const text = pluginFileText({ plugin: id, kind: "animation", title: name, version: 1, description: "Saved with this project.", author: "unknown", api: typeof row.api === "string" ? row.api : "1.8", sha256, created: "", target: "object", params }, code);
      const file = readPluginFile(text); if (file) files.push(file);
    }
  }
  const unique = new Map<string, PluginFileInfo>();
  for (const file of files) if (file.kind === "animation") unique.set(file.plugin, file);
  animationFiles = [...unique.values()].sort((a, b) => a.title.localeCompare(b.title));
  if (!animationFiles.some((file) => file.plugin === animationChoice)) animationChoice = animationFiles[0]?.plugin ?? "";
  if (state.stage === "pose") renderPanel();
}
/** Stop the animation being prepared: its build, its script and its frames' worker. `said` replaces the message. */
function cancelPreparation(said?: string): void {
  if (!preparing) return;
  preparing.controller.abort();
  preparing = null;
  animationRun++;
  if (said !== undefined) message = said;
  renderPanel();
}
/** The progress the panel shows, one stage at a time, in place: the panel is not rebuilt for a frame. */
function setPreparingStage(ticket: number, stage: AnimationStage): void {
  if (!preparing || preparing.ticket !== ticket) return;
  if (state.stage !== "pose") { cancelPreparation(""); return; }
  const before = preparing.stage.stage;
  preparing.stage = stage;
  if (before !== stage.stage) { renderPanel(); return; }
  if (!progressRequest) progressRequest = requestAnimationFrame(() => { progressRequest = 0; drawProgress(); });
}
async function playAnimation(): Promise<void> {
  if (preparing) return;
  const row = selected(), file = animationFiles.find((item) => item.plugin === animationChoice);
  if (!row || !file) { message = "Select an assembly and an animation."; renderPanel(); return; }
  const verdict = apiVerdict(file.api, [RECIPE_API]);
  if (!verdict.ok) { message = verdict.reason; renderPanel(); return; }
  if (animation && animation.assembly === row.assembly.id) {
    if (animation.clock.playing) animation.clock.pause(performance.now());
    else { animation.clock.play(performance.now()); animationDrawn = -1; animationTick(); }
    renderPanel(); return;
  }
  // Another assembly's animation stops: the view shows the assembly as it stands while the new one is prepared.
  stopAnimation();
  const ticket = ++animationRun;
  const controller = new AbortController();
  preparing = { ticket, controller, stage: { stage: "start" } };
  message = ""; renderPanel();
  try {
    await prepareAnimation(ticket, controller.signal, row.assembly, file);
  } finally {
    if (preparing?.ticket === ticket) { preparing = null; renderPanel(); }
  }
}
async function prepareAnimation(ticket: number, signal: AbortSignal, live: Assembly, file: PluginFileInfo): Promise<void> {
  const current = () => ticket === animationRun && state.stage === "pose";
  const assemblySnapshot = structuredClone(live);
  const poses = new Map(live.members.map((member) => [member.object, poseOf(member.object)]));
  const objects = new Map(live.members.map((member) => [member.object, state.plate.objects.find((item) => item.id === member.object)]));
  const [{ recipeRuntime }, { runAppAnimation }, sha] = await Promise.all([import("../recipe/runtime.ts"), import("../recipe/animation-run.ts"), bodySha256(file.body)]);
  const recipes = await recipeRuntime();
  if (!current()) return;
  if (!recipes) { message = "Playing an animation needs the desktop app."; return; }
  const [{ needsFirstRun, approveFirstRun }, { pluginLibrary, loadLibrary }] = await Promise.all([import("../ui/plugin-import.ts"), import("../ui/plugins-panel.ts")]);
  if (needsFirstRun(file, sha, pluginLibrary())) {
    const approved = await approveFirstRun(file, sha, undefined, pluginLibrary());
    if (!current()) return;
    if (!approved) { message = "Animation cancelled."; return; }
    await loadLibrary();
  }
  // Copies made for this animation: their buffers are lent to the frames' worker and come back with the frames.
  const parts: AnimationPart[] = live.members.flatMap((member) => {
    const part = state.plate.objects.find((item) => item.id === member.object);
    if (!part) return [];
    const seat = meshSeat(part.bytes) ?? 0, positions = part.sourcePos.slice();
    if (seat) for (let i = 2; i < positions.length; i += 3) positions[i] += seat;
    return [{ object: part.id, name: part.name, positions }];
  });
  const params = { ...Object.fromEntries(file.params.filter((param) => param.default !== null).map((param) => [param.name, param.default])), ...animationParameters.get(file.plugin) };
  try {
    const result = await runAppAnimation(recipes, file.plugin, file.body, params, assemblySnapshot, (id) => poses.get(id), parts, { signal, transfer: true, onStage: (stage) => setPreparingStage(ticket, stage) });
    if (!current()) return;
    const { animationStale } = await import("../pose-anim.ts");
    const stale = staleSince(animationStale, assemblySnapshot, poses, objects);
    if (stale) { message = `${stale} while the animation was building. Play it again.`; return; }
    if (!result.ok) { message = result.issues?.length ? result.issues.map((issue) => `${issue.line ? `line ${issue.line}: ` : ""}${issue.reason}`).join("; ") : result.reason; return; }
    preparing = null;
    animation = { result: result.result, spec: result.spec, camera: result.camera, original: assemblySnapshot, poses, parts, clock: new PosePlayback(result.result.frames.length, result.result.fps), assembly: live.id, plugin: { sha, text: file.text, name: file.plugin, source: file.body, api: file.api, params }, ...(result.spec.background ? { background: result.spec.background.toLowerCase() } : {}) };
    message = result.result.warnings[0]?.reason ?? "";
    animation.clock.play(performance.now()); animationDrawn = -1; animationTick(); renderPanel();
  } catch (error) {
    if (ticket === animationRun) message = error instanceof Error ? error.message : String(error);
  }
}


function poseOf(id: string): Affine | undefined {
  const object = state.plate.objects.find((row) => row.id === id);
  return object ? modelPoseOf(object) : undefined;
}

/** What the animation was built from, against what stands now (`animationStale`, src/pose-anim.ts). */
function staleSince(animationStale: typeof import("../pose-anim.ts").animationStale, snapshot: Assembly, poses: ReadonlyMap<string, Affine | undefined>, objects: ReadonlyMap<string, (typeof state.plate.objects)[number] | undefined>): string | null {
  const parts = (of: (id: string) => (typeof state.plate.objects)[number] | undefined, pose: (id: string, part: (typeof state.plate.objects)[number]) => Affine | undefined) => new Map([...objects.keys()].map((id) => {
    const part = of(id);
    return [id, part ? { name: part.name, pose: pose(id, part), points: part.sourcePos } : undefined] as const;
  }));
  return animationStale(snapshot, liveAssemblies().find((row) => row.id === snapshot.id), parts((id) => objects.get(id), (id) => poses.get(id)), parts((id) => state.plate.objects.find((item) => item.id === id), (_id, part) => modelPoseOf(part)));
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
  session.assemblies = session.assemblies.some((row) => row.id === assembly.id) ? session.assemblies.map((row) => row.id === assembly.id ? assembly : row) : [...session.assemblies, assembly];
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
  stopAnimation();
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
    const joint: Joint = old?.kind === "ball" ? { ...old, pivot } : old?.kind === "slide" ? { ...old, pivot, axis: axis ?? old.axis } : { ...(old?.kind === "hinge" ? old : { kind: "hinge" as const, angle: 0 }), pivot, axis: axis ?? (old?.kind === "hinge" ? old.axis : [0, 0, 1]) };
    message = solid ? "Joint placed on the cylindrical face." : "Pivot snapped. Type the joint axis.";
    replaceMember(current.assembly, { ...current.member, joint });
  } catch (error) {
    if (serial === pickSerial) { message = `Could not read the selected face: ${error instanceof Error ? error.message : String(error)}`; renderPanel(); }
  }
}
function pick(id: string | null, hit?: PoseHit): void {
  if (!id) return;
  stopAnimation();
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
  if (event.phase === "start") { const row = selected(); if (!row?.member.joint) return; holdEdit(); dragging = true; dragStart = structuredClone(row.member); dragAssembly = structuredClone(row.assembly); return; }
  if (event.phase === "end") { if (dragging) flushEdit(); dragging = false; dragStart = null; dragAssembly = null; refreshPoseConsumers(); return; }
  const row = selected();
  if (!row?.member.joint || !dragStart?.joint || dragStart.object !== row.member.object) return;
  const joint = dragStart.joint;
  const axis: Vec3 = event.axis === 0 ? [1, 0, 0] : event.axis === 1 ? [0, 1, 0] : [0, 0, 1];
  if (joint.kind === "hinge" && dragAssembly) {
    // A coupled hinge turns its gear train with it (docs/plan-gear-coupling.md); a locked one says why and stays.
    const train = trainTurn(dragAssembly, dragStart.object, event.delta);
    if ("reason" in train) { message = train.reason; renderPanel(); return; }
    message = turnWords(train);
    writeAssembly(train.assembly); return;
  }
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
  document.querySelector("#posePanel")?.addEventListener("input", (event) => {
    const slider = event.target as HTMLInputElement;
    if (!slider.hasAttribute("data-pose-animation-frame") || !animation) return;
    animation.clock.seek(Number(slider.value)); syncPose();
    const label = document.querySelector<HTMLElement>("[data-pose-animation-count]");
    if (label) label.textContent = `Frame ${Number(slider.value) + 1} / ${animation.result.frames.length}`;
  });
  window.addEventListener("keydown", (event) => {
    if (state.stage !== "pose") return;
    if (event.key === "Escape" && preparing) cancelPreparation("Animation cancelled.");
    else if (event.key === "Escape" && animation) { stopAnimation(); message = ""; syncPose(); }
    else if (event.key === "Escape") setTool("select");
    else if (event.code === "Space" && animation && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement)) { event.preventDefault(); void playAnimation(); }
  });
  fx.syncPose = syncPose;
  return view;
}
export function showPose(): void {
  stopAnimation();
  cancelPreparation();
  const poseView = mount();
  if (!poseView) return;
  sceneShift = undefined;
  poseView.resize();
  syncPose();
  void refreshAnimations();
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
  // A slide has no ring: a rack moves with its pinion's ring, or by its Travel field.
  if (tool === "turn" && (row?.member.parent || turnsOnPlate(row?.member)) && row?.member.joint && row.member.joint.kind !== "slide" && object && sceneShift) {
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
  const frame = animation?.result.frames[animation.clock.frame(performance.now())];
  const shown = frame && sceneShift ? placed.parts.map((part) => {
    const pose = frame.poses.get(part.id), object = state.plate.objects.find((item) => item.id === part.id);
    if (!pose || !object) return part;
    const seated = thenPose(seatLift(meshSeat(object.bytes) ?? 0), pose);
    return { ...part, matrix: thenPose(seated, sceneShift!) };
  }) : placed.parts;
  view.setScene({ parts: shown, selectedId: frame ? null : state.plate.selectedId, chain: frame ? new Set() : chain, clashing: frame ? new Set() : clashing, marks: frame ? [] : marks, ...(frame ? { colors: animation?.swatches ?? frame.colors, ...(animation?.background ? { background: animation.background } : {}) } : {}), ...(!frame && gizmo ? { gizmo } : {}) });
  const empty = document.querySelector<HTMLElement>("#poseEmpty");
  if (empty) empty.hidden = placed.parts.length > 0;
  if (!dragging && !animation) renderPanel();
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
/** The three steps of preparing an animation, in the order they run, as the panel names them. */
const PREPARE_STEPS = [["build", "Build script"], ["run", "Run script"], ["frames", "Prepare frames"]] as const;
/** Where a preparation stands, in words: what is happening, the bar's share (null while it cannot be known), a note. */
function progressWords(stage: AnimationStage | { stage: "start" }): { title: string; share: number | null; detail: string; step: number; live: string } {
  switch (stage.stage) {
    case "start": return { title: "Getting the animation ready…", share: null, detail: "", step: 0, live: "Getting the animation ready" };
    case "build": return { title: "Building the animation script…", share: null, detail: "The script is compiled once; a script built before is quick.", step: 0, live: "Building the animation script" };
    case "run": return { title: "Running the animation script…", share: null, detail: "The script reads the assembly and sets its keys.", step: 1, live: "Running the animation script" };
    case "frames": return {
      title: stage.frame >= stage.count ? `Prepared ${stage.count} ${stage.count === 1 ? "frame" : "frames"}` : `Preparing frame ${stage.frame + 1} of ${stage.count}`,
      share: stage.count ? stage.frame / stage.count : 0,
      detail: "Each frame poses the assembly and checks it for parts that cross.",
      step: 2,
      live: `Preparing ${stage.count} ${stage.count === 1 ? "frame" : "frames"}`,
    };
    case "finish": return { title: "Finishing…", share: 1, detail: "", step: 3, live: "Finishing" };
  }
}
/** The progress block of the Animations section, while one is prepared. `drawProgress` fills it. */
function progressBlock(panel: HTMLElement): void {
  const block = document.createElement("div"); block.className = "pose-progress"; block.dataset.poseProgress = "";
  const steps = document.createElement("ol"); steps.className = "pose-progress-steps"; steps.setAttribute("aria-hidden", "true");
  for (const [, label] of PREPARE_STEPS) { const item = document.createElement("li"); const mark = document.createElement("span"); mark.className = "pose-progress-mark"; item.append(mark, document.createTextNode(label)); steps.append(item); }
  const head = document.createElement("div"); head.className = "pose-progress-head";
  const title = addText(head, "span", "", "pose-progress-title"); title.dataset.poseProgressText = "";
  const share = addText(head, "span", "", "pose-progress-share"); share.dataset.poseProgressShare = "";
  const bar = document.createElement("div"); bar.className = "pose-progress-bar"; bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-label", "Preparing the animation"); bar.dataset.poseProgressBar = "";
  bar.append(document.createElement("span"));
  const detail = document.createElement("p"); detail.className = "pose-progress-detail";
  const foot = document.createElement("div"); foot.className = "pose-progress-foot"; foot.append(detail);
  const cancel = button(foot, "Cancel", "animation-cancel");
  cancel.dataset.tip = "Stop preparing this animation (Esc).";
  // Said once per stage, not per frame: the bar's value is there for whoever asks for it.
  const live = document.createElement("span"); live.className = "sr-only"; live.setAttribute("aria-live", "polite"); live.dataset.poseProgressLive = "";
  block.append(steps, head, bar, foot, live);
  panel.append(block);
  drawProgress();
}
function drawProgress(): void {
  const block = document.querySelector<HTMLElement>("[data-pose-progress]");
  if (!block || !preparing) return;
  const words = progressWords(preparing.stage);
  block.dataset.stage = preparing.stage.stage;
  block.querySelectorAll<HTMLElement>(".pose-progress-steps > li").forEach((item, at) => { item.dataset.state = at < words.step ? "done" : at === words.step ? "active" : "todo"; });
  block.querySelector<HTMLElement>("[data-pose-progress-text]")!.textContent = words.title;
  block.querySelector<HTMLElement>("[data-pose-progress-share]")!.textContent = words.share === null ? "" : `${Math.floor(words.share * 100)}%`;
  const bar = block.querySelector<HTMLElement>("[data-pose-progress-bar]")!;
  bar.classList.toggle("indeterminate", words.share === null);
  if (preparing.stage.stage === "frames") {
    bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", String(preparing.stage.count));
    bar.setAttribute("aria-valuenow", String(preparing.stage.frame)); bar.setAttribute("aria-valuetext", `${preparing.stage.frame} of ${preparing.stage.count} frames`);
  } else for (const name of ["aria-valuemin", "aria-valuemax", "aria-valuenow"]) bar.removeAttribute(name);
  if (preparing.stage.stage !== "frames") bar.setAttribute("aria-valuetext", words.title.replace(/…$/, ""));
  (bar.firstElementChild as HTMLElement).style.width = words.share === null ? "" : `${Math.max(0, Math.min(100, words.share * 100))}%`;
  const detail = block.querySelector<HTMLElement>(".pose-progress-detail")!;
  detail.textContent = words.detail; detail.hidden = !words.detail;
  // A live region is read when its text changes after it is in the page, so a new block says its stage a moment later.
  const live = block.querySelector<HTMLElement>("[data-pose-progress-live]")!;
  if (live.dataset.said !== words.live) { live.dataset.said = words.live; window.setTimeout(() => { live.textContent = words.live; }, 100); }
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
  // The pose is what a STEP export writes: each member a named solid at its assembled pose.
  if (assemblies.length) {
    const exports = document.createElement("div"); exports.className = "pose-buttons"; panel.append(exports);
    for (const assembly of assemblies) {
      const save = button(exports, assemblies.length === 1 ? "Save pose as STEP" : `Save ${assembly.name} as STEP`, "step");
      save.dataset.assembly = assembly.id;
      save.dataset.tip = "One STEP file of the assembly as posed: each part a named solid at its assembled pose.";
    }
  }
  addText(panel, "h3", "Animations");
  if (animationFiles.length) {
    const select = document.createElement("select"); select.dataset.poseAnimation = "choice"; select.setAttribute("aria-label", "Animation");
    for (const file of animationFiles) { const option = document.createElement("option"); option.value = file.plugin; option.textContent = file.title; select.append(option); }
    select.value = animationChoice; panel.append(select);
    const file = animationFiles.find((item) => item.plugin === animationChoice);
    for (const param of file?.params ?? []) {
      if (param.kind === "face" || param.kind === "outline") continue;
      const label = document.createElement("label"); label.className = "pose-field"; addText(label, "span", param.label || param.name);
      const value = animationParameters.get(file!.plugin)?.[param.name] ?? param.default;
      if (param.kind === "choice") {
        const input = document.createElement("select"); input.dataset.poseAnimationParam = param.name; input.setAttribute("aria-label", param.label || param.name);
        for (const item of param.options ?? []) { const option = document.createElement("option"); option.value = item; option.textContent = item; input.append(option); }
        input.value = String(value ?? ""); label.append(input);
      } else {
        const input = document.createElement("input"); input.dataset.poseAnimationParam = param.name; input.setAttribute("aria-label", param.label || param.name);
        input.type = param.kind === "toggle" ? "checkbox" : param.kind === "text" ? "text" : "number";
        if (input.type === "checkbox") input.checked = value === true;
        else { input.value = String(value ?? ""); if (param.min !== undefined) input.min = String(param.min); if (param.max !== undefined) input.max = String(param.max); if (param.step !== undefined) input.step = String(param.step); }
        label.append(input);
      }
      panel.append(label);
    }
    if (preparing) progressBlock(panel);
    const actions = document.createElement("div"); actions.className = "pose-buttons"; if (!preparing) panel.append(actions);
    if (!preparing) button(actions, animation?.clock.playing ? "Pause" : "Play", "animation-play");
    if (animation && !preparing) {
      button(actions, "Stop", "animation-stop"); button(actions, "Keep this frame", "animation-keep"); button(actions, "Save animation…", "animation-save");
      const slider = document.createElement("input"); slider.type = "range"; slider.min = "0"; slider.max = String(animation.result.frames.length - 1); slider.value = String(animation.clock.frame(performance.now())); slider.dataset.poseAnimationFrame = ""; slider.setAttribute("aria-label", "Animation frame"); panel.append(slider);
      const label = addText(panel, "p", `Frame ${Number(slider.value) + 1} / ${animation.result.frames.length}`); label.dataset.poseAnimationCount = "";
    }
  } else addText(panel, "p", "No animation plugins in this project or library.");
  if (message) addText(panel, "p", message);
  if (chainSelected) addText(panel, "p", "Chain selected. Press Esc to select the part.");
  const row = selected();
  if (!row) {
    // A gear in no assembly: Couple gears makes its train (docs/plan-gear-kinds.md, stage 1).
    if (!freeGearSection(panel)) addText(panel, "p", "Select an assembly member to add a joint. Attach free parts in Prepare.");
    return;
  }
  addText(panel, "h3", state.plate.objects.find((item) => item.id === row.member.object)?.name ?? row.member.object);
  const parentName = state.plate.objects.find((item) => item.id === row.member.parent)?.name;
  addText(panel, "p", parentName ? `Parent: ${parentName}` : turnsOnPlate(row.member) ? "Assembly root (turns on the plate)" : "Assembly root (fixed)");
  gearSection(panel, row.assembly);
  if (coupleDraftFor !== row.member.object) { coupleDraft = { ...EMPTY_DRAFT }; coupleNote = null; coupleDraftFor = row.member.object; }
  couplingSection(panel, row.assembly, row.member);
  const isRoot = !row.member.parent;
  const label = document.createElement("label"); label.className = "pose-field"; addText(label, "span", "Joint");
  const select = document.createElement("select"); select.dataset.poseField = "kind"; select.setAttribute("aria-label", "Joint kind");
  // A root turns only on a hinge, on the plate. Held: fixed on purpose, and Couple gears leaves it so.
  const kinds = isRoot ? [["none", "Fixed"], ["hinge", "Hinge"], ["held", "Held"]] : [["none", "Fixed"], ["hinge", "Hinge"], ["ball", "Ball"], ["slide", "Slide"], ["held", "Held"]];
  for (const [value, name] of kinds) { const option = document.createElement("option"); option.value = value!; option.textContent = name!; select.append(option); }
  select.value = row.member.joint?.kind ?? (row.member.held ? "held" : "none"); label.append(select); panel.append(label);
  select.dataset.tip = "Fixed rides its parent. Held stays fixed on purpose: Couple gears never gives it a hinge.";
  const joint = row.member.joint;
  if (joint) {
    for (let i = 0; i < 3; i++) field(panel, `Pivot ${"XYZ"[i]} mm`, `pivot${i}`, joint.pivot[i]);
    if (joint.kind === "hinge") {
      for (let i = 0; i < 3; i++) field(panel, `Axis ${"XYZ"[i]}`, `axis${i}`, joint.axis[i]);
      field(panel, "Angle °", "angle", joint.angle ?? 0);
      field(panel, "Minimum °", "min", joint.min, "Free"); field(panel, "Maximum °", "max", joint.max, "Free");
    } else if (joint.kind === "slide") {
      // A slide (docs/plan-gear-kinds.md, stage 3): along its axis, in mm.
      for (let i = 0; i < 3; i++) field(panel, `Axis ${"XYZ"[i]}`, `axis${i}`, joint.axis[i]);
      field(panel, "Travel mm", "travel", joint.travel ?? 0);
      field(panel, "Minimum mm", "min", joint.min, "Free"); field(panel, "Maximum mm", "max", joint.max, "Free");
    } else field(panel, "Cone °", "cone", joint.cone, "Free");
  }
  contactSection(panel, row.assembly, row.member);
  const actions = document.createElement("div"); actions.className = "pose-buttons"; panel.append(actions);
  button(actions, "Rest", "rest"); button(actions, "Make rest", "make-rest"); button(actions, "Undo", "undo"); button(actions, "Redo", "redo");
  massSection(panel, row.assembly, row.member.object);
}
/**
 * The selected member's body weighed, as model_mass weighs it (docs/plan-mass-properties.md): the part and what rides
 * on it without a joint, a solid at the filament's density, its centre of gravity in model space and, on a hinge, its
 * inertia, lever arm and period as a pendulum. Read-only; a mesh that does not close says so instead.
 */
function massSection(panel: HTMLElement, assembly: Assembly, object: string): void {
  const moving = movingBody(assembly, object);
  if (!moving) return;
  const box = document.createElement("div"); box.dataset.poseMass = ""; panel.append(box);
  addText(box, "h3", "Mass");
  const density = state.profile.filamentDensityGCm3;
  const parts: BodyPart[] = [];
  const names: string[] = [];
  for (const id of moving.parts) {
    const part = state.plate.objects.find((item) => item.id === id);
    if (!part || part.sourcePos.length < 9) continue;
    const integrals = partIntegrals(part.sourcePos, part.name);
    if ("reason" in integrals) { addText(box, "p", integrals.reason, "pose-error"); return; }
    parts.push({ integrals, pose: meshToModel(part), densityGCm3: density });
    names.push(part.name);
  }
  if (!parts.length) return;
  const body = massBodyOf(parts);
  const fixed = (value: number, digits: number) => (Math.round(value * 10 ** digits) / 10 ** digits + 0).toLocaleString(undefined, { maximumFractionDigits: digits });
  if (names.length > 1) addText(box, "p", `Body: ${names.join(", ")}`);
  addText(box, "p", `${fixed(body.massG, 2)} g, ${fixed(body.volumeMm3, 0)} mm³ solid at ${density} g/cm³. A print with infill weighs less.`);
  addText(box, "p", `Centre of gravity (model): ${body.centreMm.map((v) => fixed(v, 2)).join(", ")} mm`);
  const member = assembly.members.find((item) => item.object === moving.body);
  const joint = member?.joint;
  const hinged = state.plate.objects.find((item) => item.id === moving.body);
  if (joint?.kind !== "hinge" || !hinged) return;
  const pose = modelPoseOf(hinged);
  const point = applyPose(pose, joint.pivot), axis = turnDir(pose, joint.axis);
  const about = aboutAxis(body, point, axis);
  if ("reason" in about) return;
  addText(box, "p", `About the hinge: ${fixed(about.inertiaGmm2, 0)} g·mm², lever ${fixed(about.leverMm, 2)} mm`);
  const swung = swing(body, point, axis);
  if ("reason" in swung) { addText(box, "p", swung.reason); return; }
  addText(box, "p", `Period ${fixed(swung.periodS, 3)} s for small swings (simple pendulum ${fixed(swung.lengthMm, 1)} mm), gravity along −Z${swung.offRestDeg > 0.5 ? `; turned ${fixed(swung.offRestDeg, 1)}° from rest` : ""}`);
}
/** The driven joint of a selected member: its own hinge or slide, or that of the part it is seated on without a joint. */
function contactBody(assembly: Assembly, member: Member): Member | null {
  const body = bodyOf(assembly, member.object);
  if (!body || "reason" in body || body.fixed) return null;
  const driven = assembly.members.find((row) => row.object === body.body);
  return driven && drives(driven.joint) ? driven : null;
}
/** "Until contact", one button for each way, and what the last press found. */
function contactSection(panel: HTMLElement, assembly: Assembly, member: Member): void {
  const body = contactBody(assembly, member);
  if (!body) return;
  const slide = body.joint?.kind === "slide";
  const verb = slide ? "Slide" : "Turn";
  const actions = document.createElement("div"); actions.className = "pose-buttons"; actions.dataset.poseContact = ""; panel.append(actions);
  const back = button(actions, "◀ Until contact", "contact-back"), on = button(actions, "Until contact ▶", "contact-on");
  back.setAttribute("aria-label", `${verb} back until contact`); on.setAttribute("aria-label", `${verb} on until contact`);
  const what = body.object === member.object ? `this part's ${slide ? "slide" : "hinge"}` : `the ${slide ? "slide" : "hinge"} it rides on`;
  back.dataset.tip = `${verb} ${what} backwards (${slide ? "against its axis" : "clockwise about its axis"}), with its gear train, until a part it moves first touches another part of the assembly, and stop there. One Undo.`;
  on.dataset.tip = `${verb} ${what} forwards (${slide ? "along its axis" : "anticlockwise about its axis"}), with its gear train, until a part it moves first touches another part of the assembly, and stop there. One Undo.`;
  for (const one of [back, on]) one.disabled = contactBusy;
  const line = contactBusy ? "Finding contact…" : contactNote?.object === member.object ? contactNote.text : "";
  if (line) { const note = addText(panel, "p", line); note.dataset.poseContactNote = ""; note.setAttribute("role", "status"); }
}
/** A solve off the UI thread; on the UI thread when no worker can be made. */
async function solveContact(job: ContactJob): Promise<ContactJobReply> {
  let worker: Worker;
  try {
    contactWorker ??= new Worker(new URL("../contact-worker.ts", import.meta.url), { type: "module" });
    worker = contactWorker;
  } catch {
    contactWorker = null;
    const { solveContactJob } = await import("../contact-worker.ts");
    return solveContactJob(job);
  }
  return await new Promise<ContactJobReply>((resolve, reject) => {
    const done = (ev: MessageEvent<ContactJobReply>) => { if (ev.data.id !== job.id) return; worker.removeEventListener("message", done); resolve(ev.data); };
    worker.addEventListener("message", done);
    worker.addEventListener("error", () => { worker.terminate(); if (contactWorker === worker) contactWorker = null; reject(new Error("The contact search stopped: press again.")); }, { once: true });
    worker.postMessage(job, job.parts.map((part) => part.positions.buffer as ArrayBuffer));
  });
}
/**
 * Drive the selected part's joint (with its train) until a part it moves first touches another, by the shared solve
 * (src/contact.ts, the same as model_place {until}), and move it there: one Undo. Nothing moves when nothing is met.
 */
async function untilContact(dir: 1 | -1): Promise<void> {
  const row = selected();
  if (!row || contactBusy) return;
  const object = row.member.object, assembly = row.assembly;
  if (!contactBody(assembly, row.member)) return;
  const nameOf = (id: string) => state.plate.objects.find((part) => part.id === id)?.name ?? id;
  const parts = assembly.members.flatMap((member) => {
    const part = state.plate.objects.find((item) => item.id === member.object);
    if (!part || part.sourcePos.length < 9) return [];
    // The plate mesh in its CAD frame, up by its seat, as the animation and the clash check take it.
    const seat = meshSeat(part.bytes) ?? 0, positions = new Float32Array(part.sourcePos);
    if (seat) for (let i = 2; i < positions.length; i += 3) positions[i] += seat;
    return [{ object: part.id, positions }];
  });
  const poses = assembly.members.flatMap((member) => { const pose = poseOf(member.object); return pose ? [[member.object, pose] as [string, Affine]] : []; });
  const job: ContactJob = { id: ++contactJob, assembly: structuredClone(assembly), poses, parts, object, dir, names: assembly.members.map((member) => [member.object, nameOf(member.object)]) };
  contactBusy = true; contactNote = null; renderPanel();
  let reply: ContactJobReply;
  try {
    reply = await solveContact(job);
  } catch (error) {
    contactBusy = false; contactNote = { object, text: error instanceof Error ? error.message : String(error) }; renderPanel(); return;
  }
  contactBusy = false;
  document.querySelector("#posePanel")?.setAttribute("data-contact-ms", String(Math.round(reply.ms)));
  if (state.stage !== "pose") return;
  const now = liveAssemblies().find((item) => item.id === assembly.id);
  if (!now || JSON.stringify(now) !== JSON.stringify(assembly)) { contactNote = { object, text: "The assembly changed while contact was being found. Press again." }; renderPanel(); return; }
  const answer = reply.answer;
  if ("reason" in answer) { contactNote = { object, text: answer.reason }; renderPanel(); return; }
  const slide = answer.kind === "slide";
  const at = (value: number) => `${Math.round(value * 100) / 100}${slide ? " mm" : "°"}`;
  const ignored = answer.ignored.length ? ` Left out, already crossing where it stood: ${answer.ignored.map((pair) => `${nameOf(pair.moving)} and ${nameOf(pair.other)}`).join("; ")}.` : "";
  if (!answer.contact) {
    contactNote = { object, text: `Nothing met ${slide ? "sliding" : "turning"} ${nameOf(answer.body)} from ${at(answer.searched.from)} to ${at(answer.searched.to)}${answer.searched.limit ? ", where a joint limit stops it" : ""}. Nothing moved.${ignored}` };
    renderPanel(); return;
  }
  const pair = answer.pair!;
  contactNote = { object, text: `${nameOf(pair.moving)} meets ${nameOf(pair.other)} at ${at(answer.value)}, ${Math.round(answer.clearanceMm! * 1000) / 1000} mm left.${ignored}` };
  editAssembly(answer.assembly);
}
/** The assembly's gears where they stand, from each member's Model history. Model fills the trees it holds. */
function assemblyGears(assembly: Assembly, poses: ReadonlyMap<string, Affine>): WorldGear[] {
  return assembly.members.flatMap((member) => {
    const object = state.plate.objects.find((part) => part.id === member.object);
    const tree = object?.modelTree ? modelTrees.get(object.modelTree) : undefined;
    const pose = poses.get(member.object);
    return object && tree && pose ? gearsInTree(tree, pose, object.id, object.name) : [];
  });
}
/** Every plate object that holds gears, at its model pose, in plate order. */
function plateGears(): GearPart[] {
  return state.plate.objects.flatMap((object) => {
    const tree = object.modelTree ? modelTrees.get(object.modelTree) : undefined;
    const pose = modelPoseOf(object);
    const gears = tree ? gearsInTree(tree, pose, object.id, object.name) : [];
    return gears.length ? [{ id: object.id, name: object.name, pose, gears }] : [];
  });
}
/** The Gears section for a selected gear in no assembly: Couple gears makes its train. False when it is no gear. */
function freeGearSection(panel: HTMLElement): boolean {
  const id = state.plate.selectedId;
  const parts = id ? plateGears() : [];
  if (!id || !parts.some((part) => part.id === id) || parts.length < 2) return false;
  addText(panel, "h3", state.plate.objects.find((item) => item.id === id)?.name ?? id);
  addText(panel, "h3", "Gears");
  const list = document.createElement("div"); list.dataset.poseGears = ""; panel.append(list);
  const notes = gearNotes?.assembly === `free:${id}` ? gearNotes.lines : [];
  for (const line of notes) addText(list, "p", line);
  if (!notes.length) addText(list, "p", "Couple the gears that mesh, so turning one turns its train. Each gear gets a hinge about its own axis.");
  const actions = document.createElement("div"); actions.className = "pose-buttons"; panel.append(actions);
  button(actions, "Couple gears", "couple-gears").dataset.tip = "Find the gears that mesh with this one, give each a hinge about its own axis, and couple them: turning one turns its train at the tooth ratio.";
  return true;
}
/** Gears: the couplings, any locked train, what the last Couple gears said, and its buttons. */
function gearSection(panel: HTMLElement, assembly: Assembly): void {
  // Found gear meshes only: declared couplings are listed under Couplings.
  const couplings = (assembly.couplings ?? []).filter((row) => row.gears);
  const notes = gearNotes?.assembly === assembly.id ? gearNotes.lines : [];
  const made = gearNotes?.assembly === assembly.id ? gearNotes.made ?? [] : [];
  const gears = couplings.length || notes.length || made.length ? null : assemblyGears(assembly, solveAssembly(assembly, poseOf).poses);
  if (!couplings.length && !notes.length && !made.length && (gears?.length ?? 0) < 2) return;
  addText(panel, "h3", "Gears");
  const list = document.createElement("div"); list.dataset.poseGears = ""; panel.append(list);
  // What Couple gears made comes first: the hinges it gave, and the assembly it made.
  for (const line of made) addText(list, "p", line);
  for (const row of couplings) addText(list, "p", `${couplingLine(row)}.`);
  const seen = new Set<string>();
  for (const row of couplings) {
    if (seen.has(row.driver)) continue;
    const train = trainScales(assembly, row.driver);
    for (const id of train.scales.keys()) seen.add(id);
    if (train.locked) addText(list, "p", train.locked.reason);
  }
  for (const line of notes) addText(list, "p", line);
  if (!couplings.length && !notes.length && !made.length) addText(list, "p", "Couple the gears that mesh, so turning one turns its train.");
  const actions = document.createElement("div"); actions.className = "pose-buttons"; panel.append(actions);
  button(actions, "Couple gears", "couple-gears").dataset.tip = "Find the gears that mesh, by the mesh check, and couple them: turning one turns its train at the tooth ratio.";
  if (couplings.length) button(actions, "Uncouple", "uncouple-gears");
}
/**
 * Couplings (docs/plan-coupling-kinds.md): the declared couplings of the assembly, each with Remove, and a form to couple
 * the selected part's joint to another part's: a ratio, a winch, a ratchet (with its click) or a clutch. One Undo each.
 */
function couplingSection(panel: HTMLElement, assembly: Assembly, member: Member): void {
  const declared = (assembly.couplings ?? []).map((row, index) => ({ row, index })).filter(({ row }) => row.kind !== undefined);
  const body = bodyOf(assembly, member.object);
  const moves = !!body && !("reason" in body) && !body.fixed;
  if (!declared.length && !moves) return;
  const nameOf = (id: string) => state.plate.objects.find((part) => part.id === id)?.name ?? id;
  const box = document.createElement("div"); box.dataset.poseCouplings = ""; panel.append(box);
  addText(box, "h3", "Couplings");
  for (const { row, index } of declared) {
    const line = document.createElement("div"); line.className = "pose-coupling"; box.append(line);
    addText(line, "p", `${couplingLine(row)}.`);
    const remove = button(line, "Remove", "remove-coupling");
    remove.dataset.index = String(index);
    remove.setAttribute("aria-label", `Remove: ${couplingNames(row).join(" and ")}`);
  }
  if (moves) {
    const own = (body as { body: string }).body;
    const draft = coupleDraft;
    const kinds: [CoupleKind, string][] = [["ratio", "Ratio"], ["winch", "Winch (drum to load)"], ["ratchet", "Ratchet (one way)"], ["clutch", "Friction clutch"]];
    addText(box, "p", `${nameOf(own)} drives:`, "pose-couple-lead");
    const others = assembly.members.filter((row) => {
      const other = bodyOf(assembly, row.object);
      return row.object !== own && !!other && !("reason" in other) && other.body !== own;
    });
    coupleSelect(box, "Other part", "driven", [["", "Choose a part"], ...others.map((row) => [row.object, nameOf(row.object)] as [string, string])], draft.driven);
    coupleSelect(box, "Kind", "kind", kinds, draft.kind);
    if (draft.kind === "ratio") coupleField(box, "Ratio (° or mm per ° or mm)", "ratio", draft.ratio, "1");
    if (draft.kind === "winch") {
      coupleField(box, "Drum radius mm", "radius", draft.radius, "");
      coupleSelect(box, "Turning the drum forward", "wind", [["in", "winds the cord in"], ["out", "pays the cord out"]], draft.wind);
    }
    if (draft.kind === "ratchet") {
      coupleSelect(box, "Runs free turning", "free", [["1", "forward"], ["-1", "back"]], draft.free);
      const clicks = assembly.members.filter((row) => row.joint?.kind === "hinge" && row.parent !== null && row.object !== own);
      coupleSelect(box, "Click", "click", [["", "None"], ...clicks.map((row) => [row.object, nameOf(row.object)] as [string, string])], draft.click);
      if (draft.click) {
        coupleField(box, "Teeth", "teeth", draft.teeth, "");
        coupleField(box, "Tip radius mm", "tip", draft.tip, "");
        coupleField(box, "Root radius mm", "root", draft.root, "");
      }
    }
    if (draft.kind === "clutch") coupleField(box, "Ratio", "ratio", draft.ratio, "1");
    const help: Record<CoupleKind, string> = {
      ratio: "The other part moves this many degrees (or mm, on a slide) for each degree (or mm) of this one, both ways.",
      winch: "This part is the drum on a hinge, the other the load on a slide: the cord moves 2πr/360 mm a degree.",
      ratchet: "This part is the ratchet wheel; the other is the part its click sits on, or the frame. It carries that part one way and runs free the other. With a click (in its notch now) and the wheel's numbers, the click rides each tooth and drops.",
      clutch: "The other part follows one to one unless it is held or turned on its own: then the clutch slips. No torque is computed.",
    };
    addText(box, "p", help[draft.kind], "pose-couple-help");
    const actions = document.createElement("div"); actions.className = "pose-buttons"; box.append(actions);
    const go = button(actions, "Couple", "couple-declared");
    go.dataset.tip = "Couple this part's joint to the other part's, as set above. Turning either then moves the other. One Undo.";
  }
  if (coupleNote?.assembly === assembly.id) { const note = addText(box, "p", coupleNote.text); note.dataset.poseCoupleNote = ""; note.setAttribute("role", "status"); }
}
function coupleSelect(parent: HTMLElement, label: string, name: keyof CoupleDraft, options: [string, string][], value: string): void {
  const wrap = document.createElement("label"); wrap.className = "pose-field";
  addText(wrap, "span", label);
  const select = document.createElement("select"); select.dataset.poseCouple = name; select.setAttribute("aria-label", label);
  for (const [key, text] of options) { const option = document.createElement("option"); option.value = key; option.textContent = text; select.append(option); }
  select.value = value; wrap.append(select); parent.append(wrap);
}
function coupleField(parent: HTMLElement, label: string, name: keyof CoupleDraft, value: string, placeholder: string): void {
  const wrap = document.createElement("label"); wrap.className = "pose-field";
  addText(wrap, "span", label);
  const input = document.createElement("input"); input.type = "number"; input.step = "any"; input.dataset.poseCouple = name; input.value = value; input.placeholder = placeholder; input.setAttribute("aria-label", label);
  wrap.append(input); parent.append(wrap);
}
/** Couple the selected part's joint to the chosen part's, as the form says: one edit, one Undo. */
function coupleDeclared(): void {
  const row = selected();
  if (!row) return;
  const draft = coupleDraft;
  const say = (text: string) => { coupleNote = { assembly: row.assembly.id, text }; renderPanel(); };
  if (!draft.driven) { say("Choose the other part."); return; }
  const number = (text: string) => (text.trim() === "" ? undefined : Number(text));
  const spec: DeclareSpec = { driver: row.member.object, driven: draft.driven, kind: draft.kind };
  if (draft.kind === "ratio" || draft.kind === "clutch") { const ratio = number(draft.ratio); if (ratio !== undefined) spec.ratio = ratio; else if (draft.kind === "ratio") spec.ratio = 1; }
  if (draft.kind === "winch") { const radius = number(draft.radius); if (radius !== undefined) spec.radius = radius; spec.wind = draft.wind === "out" ? "out" : "in"; }
  if (draft.kind === "ratchet") {
    spec.free = draft.free === "-1" ? -1 : 1;
    if (draft.click) {
      spec.click = draft.click;
      for (const key of ["teeth", "tip", "root"] as const) { const value = number(draft[key]); if (value !== undefined) spec[key] = value; }
      const pose = poseOf(draft.click);
      if (pose) spec.clickCentre = applyPose(pose, centre(draft.click));
    }
  }
  for (const value of [spec.ratio, spec.radius, spec.teeth, spec.tip, spec.root]) if (value !== undefined && !Number.isFinite(value)) { say("Enter finite numbers."); return; }
  const nameOf = (id: string) => state.plate.objects.find((part) => part.id === id)?.name ?? id;
  const next = declareCoupling(row.assembly, solveAssembly(row.assembly, poseOf).poses, spec, nameOf);
  if ("reason" in next) { say(next.reason); return; }
  const made = next.couplings![next.couplings!.length - 1]!;
  coupleNote = { assembly: row.assembly.id, text: `Coupled: ${couplingLine(made)}.` };
  coupleDraft = { ...EMPTY_DRAFT };
  editAssembly(next);
}
/**
 * Couple gears (docs/plan-gear-kinds.md, stage 1): the gears that mesh with `start`'s get a hinge about their own axes
 * where they need one, gears in no assembly get one of their own, and the meshes are coupled. One edit, one Undo.
 */
function coupleGears(start: string): void {
  const live = liveAssemblies();
  const nameOf = (id: string) => state.plate.objects.find((part) => part.id === id)?.name ?? id;
  const prepared = prepareTrain(live, plateGears(), start, poseOf, freshAssemblyId(live));
  if (!prepared.assembly) {
    // Gears whose axes cross say so: bevel gears and worms are not covered (docs/plan-gear-kinds.md, stage 4).
    const crossed = crossedNotes(plateGears().flatMap((part) => part.gears), start);
    gearNotes = { assembly: `free:${start}`, lines: crossed.length ? crossed : ["This gear meshes with no gear of another part that stands in no assembly. The gear card in Model says when two gears mesh."] };
    renderPanel(); return;
  }
  const assembly = prepared.assembly;
  const poses = solveAssembly(assembly, poseOf).poses;
  const gears = assemblyGears(assembly, poses);
  if (gears.length < 2) { gearNotes = { assembly: assembly.id, lines: ["This assembly has fewer than two gears that Model knows: open the gears' parts in Model once, then couple."] }; renderPanel(); return; }
  const found = findCouplings(assembly, gears, poses, nameOf);
  const made = preparedLines(prepared, nameOf);
  // The validator, as the MCP runs it: each train turned through one turn of its first body in 24 steps and every
  // coupled pair asked again by the mesh check. A frame that does not mesh is said; the driver never reads this.
  const coupled = withFound(assembly, found.couplings);
  const checked: string[] = [];
  const seen = new Set<string>();
  for (const row of found.couplings) {
    if (seen.has(row.driver)) continue;
    const train = trainScales(coupled, row.driver);
    for (const id of train.scales.keys()) seen.add(id);
    if (train.locked) continue;
    const sweep = trainCheck(coupled, poseOf, (at) => assemblyGears(coupled, at), row.driver, CHECK_ANGLES);
    const bad = "reason" in sweep ? undefined : sweep.bad[0];
    if (bad) checked.push(`Turned ${Math.round(bad.angle)}°, ${bad.names[0]} and ${bad.names[1]} do not mesh: check where they stand, then couple again.`);
  }
  gearNotes = { assembly: assembly.id, made, lines: [...(found.couplings.length || found.notCoupled.length || made.length ? [] : ["No pair of these gears meshes."]), ...found.notCoupled.map((row) => row.reason), ...checked] };
  noteEdit();
  // The members that joined read their Model numbers in their own frame, as Attach gives them (D2).
  const root = assembly.members.find((member) => member.parent === null)?.object;
  const joined = new Set(prepared.joined.filter((id) => id !== root));
  if (joined.size) state.plate = { ...state.plate, objects: state.plate.objects.map((obj) => (joined.has(obj.id) ? { ...obj, frame: "part" as const } : obj)) };
  writeAssembly(withFound(assembly, found.couplings));
  flushEdit();
}
function panelClick(event: Event): void {
  const target = (event.target as Element).closest<HTMLButtonElement>("[data-pose-action]");
  if (!target) return;
  const action = target.dataset.poseAction;
  if (animation && action && !action.startsWith("animation-")) stopAnimation();
  if (action === "animation-play") { void playAnimation(); return; }
  if (action === "animation-cancel") { cancelPreparation("Animation cancelled."); return; }
  if (action === "animation-save") {
    if (animation && view && sceneShift) {
      const current = animation, poseView = view, shift = sceneShift;
      void import("./pose-animation-save.ts").then(({ showAnimationSave }) => { if (animation === current && state.stage === "pose") showAnimationSave({ current, view: poseView, shift, active: () => animation, isPose: () => state.stage === "pose", sync: syncPose, render: renderPanel }); });
    }
    return;
  }
  if (action === "animation-stop") { stopAnimation(); message = ""; syncPose(); return; }
  if (action === "animation-keep" && animation) {
    const frame = animation.result.frames[animation.clock.frame(performance.now())];
    const plugin = animation.plugin, assembly = animation.assembly;
    stopAnimation();
    if (frame) {
      session.plugins = { ...(session.plugins ?? {}), [plugin.sha]: plugin.text };
      const prior = session.mcpModel?.animations;
      const kept = prior && typeof prior === "object" && !Array.isArray(prior) ? prior as Record<string, unknown> : {};
      session.mcpModel = { ...(session.mcpModel ?? {}), animations: { ...kept, [plugin.name]: { source: plugin.source, plugin: plugin.name, api: plugin.api, params: plugin.params, assembly } } };
      editAssembly(frame.assembly);
    }
    syncPose(); return;
  }
  if (action === "select" && target.dataset.object) { pick(target.dataset.object); return; }
  if (action === "contact-back" || action === "contact-on") { void untilContact(action === "contact-on" ? 1 : -1); return; }
  if (action === "couple-declared") { coupleDeclared(); return; }
  if (action === "remove-coupling") {
    const row = selected(), index = Number(target.dataset.index);
    const gone = row?.assembly.couplings?.[index];
    if (!row || !gone || gone.kind === undefined) return;
    coupleNote = { assembly: row.assembly.id, text: `Removed: ${couplingLine(gone)}.` };
    editAssembly(withCouplings(row.assembly, row.assembly.couplings!.filter((_, at) => at !== index)));
    return;
  }
  if (action === "undo") { undoUserEdit(); syncPose(); return; }
  if (action === "redo") { redoUserEdit(); syncPose(); return; }
  if (action === "step" && target.dataset.assembly) {
    target.disabled = true;
    void exportAssembly(target.dataset.assembly).finally(() => { target.disabled = false; });
    return;
  }
  if (action === "couple-gears" || action === "uncouple-gears") {
    const row = selected();
    if (action === "couple-gears") { if (state.plate.selectedId) coupleGears(state.plate.selectedId); }
    else if (row) { gearNotes = null; editAssembly(withFound(row.assembly, undefined)); }
    return;
  }
  const row = selected(); if (!row || (action !== "rest" && action !== "make-rest")) return;
  const ids = poseChain([row.assembly], row.member.object);
  // A root that turns on the plate goes back to rest with its train. Its zero stays: the parts hinged on it keep their
  // couplings by it (couplingSeat), so Make rest leaves a root as it is.
  if (action === "rest" && turnsOnPlate(row.member)) ids.add(row.member.object);
  let assembly = row.assembly;
  for (const member of assembly.members) {
    if (!ids.has(member.object) || !member.joint) continue;
    let updated: Member = member;
    if (action === "rest" && drives(member.joint)) {
      // Through its gear train, if it has one: the train follows the gear (or the rack) back to rest.
      const live = assembly.members.find((row) => row.object === member.object)!;
      const result = trainTurn(assembly, member.object, -jointAt(live.joint));
      if ("reason" in result) { message = result.reason; renderPanel(); return; }
      assembly = result.assembly;
      continue;
    } else if (action === "make-rest") {
      // A slide keeps its zero: its couplings are seated by it (couplingSeat), as a root's hinge's are.
      if (member.joint.kind === "slide") continue;
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
  if (input.dataset.poseAnimation === "choice") { stopAnimation(); cancelPreparation(""); animationChoice = input.value; syncPose(); return; }
  if (input.dataset.poseAnimationParam) {
    const name = input.dataset.poseAnimationParam, previous = animationParameters.get(animationChoice) ?? {};
    const value = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input instanceof HTMLInputElement && input.type === "number" ? Number(input.value) : input.value;
    if (typeof value === "number" && (!Number.isFinite(value) || input.value.trim() === "")) { message = "Enter a finite animation parameter."; renderPanel(); return; }
    animationParameters.set(animationChoice, { ...previous, [name]: value }); stopAnimation(); cancelPreparation(""); syncPose(); return;
  }
  if (input.hasAttribute("data-pose-animation-frame") && animation) { animation.clock.seek(Number(input.value)); syncPose(); renderPanel(); return; }
  const couple = input.dataset.poseCouple as keyof CoupleDraft | undefined;
  if (couple) {
    // A new kind starts its numbers afresh: a ratio typed for one kind means something else in another.
    if (couple === "kind" && input.value === coupleDraft.kind) return;
    coupleDraft = couple === "kind" ? { ...EMPTY_DRAFT, driven: coupleDraft.driven, kind: input.value as CoupleKind } : { ...coupleDraft, [couple]: input.value } as CoupleDraft;
    // A choice that changes which fields the form shows draws it again; a typed number waits for Couple.
    if (couple === "kind" || couple === "click" || couple === "driven") { coupleNote = null; renderPanel(); }
    return;
  }
  const name = input.dataset.poseField;
  if (name && animation) stopAnimation();
  const row = selected(); if (!name || !row || (!row.member.parent && name !== "kind" && !turnsOnPlate(row.member))) return;
  message = "";
  if (name === "kind") {
    const kind = input.value;
    const pivot = row.member.joint?.pivot ?? [0, 0, 0];
    const joint: Joint | undefined = kind === "hinge" ? { kind, pivot, axis: [0, 0, 1], angle: 0 } : kind === "slide" ? { kind, pivot, axis: [1, 0, 0], travel: 0 } : kind === "ball" ? { kind, pivot, rest: rotationQuaternion(memberPose(row.member).m) } : undefined;
    const { joint: _joint, held: _held, ...plain } = row.member;
    let next: Member = joint ? { ...plain, joint } : kind === "held" ? { ...plain, held: true } : plain;
    if (!row.member.parent) {
      // A root that turns on the plate holds its pose in its offset and turn; a fixed one stands at its model pose.
      const pose = poseOf(row.member.object);
      if (joint && pose && Math.abs(poseScale(pose) - 1) > 1e-9) { message = "This part is scaled in model space, so it cannot turn on the plate."; renderPanel(); return; }
      next = joint && pose ? { ...next, ...(turnsOnPlate(row.member) ? {} : memberFields(pose)) } : { ...next, offset: [0, 0, 0], turn: [0, 0, 0] };
    }
    replaceMember(row.assembly, next);
    return;
  }
  const old = row.member.joint; if (!old) return;
  const optional = name === "min" || name === "max" || name === "cone";
  const value = input.value.trim() === "" && optional ? undefined : Number(input.value);
  if ((value === undefined && !optional) || (value !== undefined && (!Number.isFinite(value) || input.value.trim() === ""))) { message = "Enter a finite number."; renderPanel(); return; }
  if (name === "travel" && old.kind === "slide") {
    const next = trainTurn(row.assembly, row.member.object, value! - (old.travel ?? 0));
    if ("reason" in next) { message = next.reason; renderPanel(); return; }
    message = turnWords(next);
    editAssembly(next.assembly); return;
  }
  if (name === "angle" && old.kind === "hinge") {
    const next = trainTurn(row.assembly, row.member.object, value! - (old.angle ?? 0));
    if ("reason" in next) { message = next.reason; renderPanel(); return; }
    message = turnWords(next);
    editAssembly(next.assembly); return;
  }
  const raw = structuredClone(old) as Joint;
  if (name.startsWith("pivot")) raw.pivot[Number(name.slice(-1))] = value!;
  else if (name.startsWith("axis") && (raw.kind === "hinge" || raw.kind === "slide")) raw.axis[Number(name.slice(-1))] = value!;
  else if ((name === "min" || name === "max") && (raw.kind === "hinge" || raw.kind === "slide")) { if (value === undefined) delete raw[name]; else raw[name] = value; }
  else if (name === "cone" && raw.kind === "ball") { if (value === undefined) delete raw.cone; else raw.cone = value; }
  const checked = readJoint(raw);
  if (!checked) { message = "Check the axis, limits and current angle; the joint was not changed."; renderPanel(); return; }
  replaceMember(row.assembly, { ...row.member, joint: checked });
}
