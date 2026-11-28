import * as THREE from "three";
/** Pose stage: select, link and edit joints without changing the print layout. */
import { assemblyOf, bodyOf, couplingNames, drives, freshAssemblyId, jointAt, memberFields, memberPose, readJoint, rotationQuaternion, samePose, solveAssembly, turnsOnPlate, withCouplings, withFound, withMember, type Assembly, type DeclaredKind, type Joint, type Member } from "../assembly.ts";
import { gearsInTree, type WorldGear } from "../gear-pair.ts";
import { couplingLine, crossedNotes, declareCoupling, findCouplings, prepareTrain, preparedLines, trainCheck, trainScales, trainTurn, type DeclareSpec, type GearPart, type Turned } from "../gear-train.ts";
import { modelTrees } from "./model-trees.ts";
import { warmShadingLater } from "./files.ts";
import { boundsOf } from "../mesh-place.ts";
import { applyPose, inversePose, isIdentity, poseScale, seatLift, thenPose, turnDir, type Affine } from "../model-space.ts";
import { meshSeat, meshToModel, modelPoseOf } from "../plate.ts";
import { aboutAxis, bodyOf as massBodyOf, movingBody, partIntegrals, swing, type BodyPart } from "../mass.ts";
import { poseChain, solvePose, turnBall, turnHinge } from "../pose.ts";
import { createPoseView, type MoveEvent, type PoseCamera, type PoseHit, type PoseView, type ReachEvent, type TurnEvent } from "../pose-view.ts";
import { cylinderJoint } from "../pose-cylinder.ts";
import { coaxialPinAt, loopPickStatus, pickLoopFace } from "../pose-loop-pick.ts";
import { closeLoop, closureGapMm, removeLoop } from "../pose-loops.ts";
import { loadModel } from "./workspaces.ts";
import { markProjectDirty } from "../project-dirty.ts";
import type { Vec3 } from "../model-tree.ts";
import { assembledParts, assemblyClashes, liveAssemblies, measureClashes, syncAssemblyView } from "./assemblies.ts";
import { alignMove, appendMoveCard, heldMoveCard, highlightAlign, keepMoveCard, moveFieldChanged, onPoseMove, poseSettleChanged, setMoveFrame } from "./pose-move.ts";
import { isAlignRelation } from "../place-snap.ts";
import { fx } from "./fx.ts";
import { cancelEdit, holdEdit, noteEdit, flushEdit, redoUserEdit, undoUserEdit } from "./history.ts";
import { refreshObjectList } from "./settings.ts";
import { exportAssembly, linkAssemblyParts, ungroupAssembly } from "./plate-actions.ts";
import { setAnimationFacts, setLoopFacts } from "./command-reasons.ts";
import { session, state } from "./state.ts";
import { PosePlayback } from "../pose-playback.ts";
import type { AnimationResult, AnimationPart, PoseAnimation } from "../pose-anim.ts";
import type { AnimationStage } from "../recipe/animation-run.ts";
import { bodySha256, pluginFileText, readPluginFile, type PluginFileInfo, type PluginParamInfo } from "../plugin-file.ts";
import { apiVerdict } from "../recipe/api-level.ts";
import { RECIPE_API } from "../plugin-step.ts";
import type { ContactJob, ContactJobReply } from "../contact-worker.ts";
import type { MotionJobMessage, MotionJobReply } from "../motion-worker.ts";
import type { MotionReport, MotionSpec } from "../motion.ts";
import type { ContactAnswer, KernelVerdict } from "../contact.ts";
import { memberNamesOf, membersMatching, missingMember } from "../anim-members.ts";
import { clickFits, freeWayOf, ratchetFromStamps, ratchetStamp, readRatchet, RATCHET_CLICK, RATCHET_WHEEL, type CouplingPart } from "../plugins/clock-parts.ts";

/** One turn of a train's first gear, in steps that are no whole number of teeth for any likely gear (as the MCP checks). */
const CHECK_ANGLES = Array.from({ length: 24 }, (_, i) => (i * 360) / 23);

type Tool = "select" | "turn" | "joint" | "link" | "reach" | "move";
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
/**
 * `manual` is "1" once the person chose to type a ratchet's numbers over those read from its parts; `freeSet` and
 * `clickSet` once they chose the free way or the click themselves, so what the stamps suggest no longer replaces it.
 */
interface CoupleDraft { driven: string; kind: CoupleKind; ratio: string; radius: string; wind: string; free: string; click: string; teeth: string; tip: string; root: string; manual: string; freeSet: string; clickSet: string }
const EMPTY_DRAFT: CoupleDraft = { driven: "", kind: "ratio", ratio: "", radius: "", wind: "in", free: "1", click: "", teeth: "", tip: "", root: "", manual: "", freeSet: "", clickSet: "" };
let coupleDraft: CoupleDraft = { ...EMPTY_DRAFT };
/** The part the form was filled for: another selection starts it again. */
let coupleDraftFor: string | null = null;
/** What the last Couple or Remove said, for the assembly it ran on. */
let coupleNote: { assembly: string; text: string } | null = null;
/** A clutch that slipped or a ratchet that held, said after a turn. */
function turnWords(turned: Turned): string {
  return [...(turned.slipped ?? []), ...(turned.stopped ? [`Stopped: ${turned.stopped}`] : [])].join(" ");
}
/** A turn's options: names so a loop's refusal says the part, and the root's pose so the closure is measured where it stands. */
function turnOptions(): { poseOf: (id: string) => Affine | undefined; names: (id: string) => string; centreOf: (id: string) => Vec3 | undefined } {
  return { poseOf, names: (id) => state.plate.objects.find((object) => object.id === id)?.name ?? id, centreOf: centre };
}
/**
 * Close a loop, kept while the Joint tool's section is filled in (docs/plan-pose-loops.md L3). `arm` is which point
 * the next click records. A line's direction is a picked cylinder's axis, or the typed X/Y/Z.
 */
interface LoopDraft {
  forId: string;
  arm: "a" | "b" | null;
  at: Vec3 | null;
  other: string | null;
  toAt: Vec3 | null;
  kind: "pin" | "line";
  axisA: Vec3 | null;
  axisB: Vec3 | null;
  typed: [string, string, string];
}
let loopDraft: LoopDraft | null = null;
const LOOP_EMPTY = "No assembly.";
const LOOP_ONE = "One member picked.";
function loopNames(id: string): string {
  return state.plate.objects.find((object) => object.id === id)?.name ?? id;
}
function chainHas(assembly: Assembly, id: string, of: string): boolean {
  const seen = new Set<string>();
  let cur = assembly.members.find((member) => member.object === of)?.parent ?? null;
  while (cur && !seen.has(cur)) {
    if (cur === id) return true;
    seen.add(cur);
    cur = assembly.members.find((member) => member.object === cur)?.parent ?? null;
  }
  return false;
}
/** The same sentence closeLoop returns when one member is the other's parent. */
function parentLoopSentence(assembly: Assembly, member: string, other: string): string | null {
  if (chainHas(assembly, member, other)) return `${loopNames(member)} is already ${loopNames(other)}'s parent: that is a joint, not a loop`;
  if (chainHas(assembly, other, member)) return `${loopNames(other)} is already ${loopNames(member)}'s parent: that is a joint, not a loop`;
  return null;
}
function loopDraftFor(id: string): LoopDraft {
  if (!loopDraft || loopDraft.forId !== id) loopDraft = { forId: id, arm: null, at: null, other: null, toAt: null, kind: "pin", axisA: null, axisB: null, typed: ["", "", ""] };
  return loopDraft;
}
/** A direction in `fromId`'s frame, written in `toId`'s frame. */
function axisInFrame(from: Vec3, fromId: string, toId: string): Vec3 | null {
  const fromPose = poseOf(fromId), toPose = poseOf(toId);
  if (!fromPose || !toPose) return null;
  const local = turnDir(inversePose(toPose), turnDir(fromPose, from));
  return Math.hypot(...local) < 1e-12 ? null : local;
}
function lineDirection(draft: LoopDraft): Vec3 | null {
  if (draft.typed.some((text) => text.trim() !== "")) {
    const nums = draft.typed.map(Number);
    if (!nums.every((n) => Number.isFinite(n)) || draft.typed.some((text) => text.trim() === "")) return null;
    return Math.hypot(...(nums as [number, number, number])) < 1e-12 ? null : nums as unknown as Vec3;
  }
  if (draft.axisB) return draft.axisB;
  if (draft.axisA && draft.other) return axisInFrame(draft.axisA, draft.forId, draft.other);
  return null;
}
/** Why Close loop cannot run. Null when the button can. */
function loopReason(memberId: string | null): string | null {
  if (state.stage !== "pose") return "Close loop is in Pose.";
  if (tool !== "joint") return "Close loop is in the Joint tool.";
  const row = memberId ? selected() : null;
  if (!row || row.member.object !== memberId) return LOOP_EMPTY;
  const draft = loopDraft?.forId === memberId ? loopDraft : null;
  if (!draft?.at || !draft.other || !draft.toAt) return LOOP_ONE;
  const parent = parentLoopSentence(row.assembly, memberId, draft.other);
  if (parent) return parent;
  if (draft.kind === "line" && !lineDirection(draft)) return "A line needs a direction.";
  return null;
}
function publishLoopFacts(): void {
  const row = state.stage === "pose" && tool === "joint" ? selected() : null;
  setLoopFacts({ jointTool: state.stage === "pose" && tool === "joint", reason: loopReason(row?.member.object ?? null) });
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
/**
 * The member each animation's member parameters name, per assembly (docs/plan-animation-plugins.md A5): keyed
 * `<plugin>\u0000<assembly id>`, so one animation keeps its own choice on each assembly it plays on.
 */
const animationMembers = new Map<string, Record<string, string>>();
/** The code the plugin library holds, by hash: an animation played from other code can be kept there. */
let libraryShas = new Set<string>();
export interface PoseAnimationState { result: AnimationResult; spec: PoseAnimation; camera?: unknown; original: Assembly; poses: Map<string, Affine | undefined>; parts: AnimationPart[]; clock: PosePlayback; assembly: string; plugin: { sha: string; text: string; name: string; source: string; api: string; params: Record<string, unknown> }; swatches?: Map<string, string>; background?: string | undefined; used?: string[]; colourOnly?: string[]; motion?: true }
let animation: PoseAnimationState | null = null;
/** "Until contact" (docs/plan-contact-poses.md): the solve running, and what the last one said, for the part it ran on. */
let contactBusy = false;
let contactNote: { object: string; text: string } | null = null;
let contactWorker: Worker | null = null;
let contactJob = 0;
/**
 * The last answer that stopped short of curved faces by their chords, on two solids in the desktop app, so the kernel
 * can be asked for the exact one (docs/plan-contact-poses.md section 6): the assembly before the press and after it.
 */
let contactExact: { object: string; before: Assembly; after: string; answer: ContactAnswer } | null = null;
let animationRequest = 0;
/**
 * An animation being prepared: its script built and run, its frames made off the window's thread. One at a time: Play
 * does nothing while one is prepared, and Cancel (or Esc) stops it and leaves the panel as it was.
 */
let preparing: { ticket: number; controller: AbortController; stage: AnimationStage | { stage: "start" } } | null = null;
/**
 * Run (docs/plan-hinge-dynamics.md): what is typed, per assembly; the run going on (its worker, its progress); and what
 * the last run said, for the assembly it ran on.
 */
interface MotionDraft { assembly: string; drive: string; kind: "torque" | "weight"; amount: string; wheel: string; anchor: string; teeth: string; tip: string; root: string; lean: string; span: string; pendulum: string; friction: string; seconds: string }
let motionDraft: MotionDraft | null = null;
let motionRunning: { ticket: number; assembly: string; worker: Worker | null; stop: () => void; fraction: number; stage: string } | null = null;
let motionNote: { assembly: string; verdict?: string; lines: string[]; error?: boolean } | null = null;
let motionTicket = 0;
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
    animationParameters.clear(); animationMembers.clear(); animationParameterProject = session.mcpModel; animationParameterPlugins = session.plugins;
  }
  libraryShas = new Set(pluginLibrary().bySha.keys());
  const files = [...pluginLibrary().plugins.values()].map((row) => row.file);
  for (const text of Object.values(session.plugins ?? {})) {
    const file = readPluginFile(text); if (file) files.push(file);
  }
  const saved = session.mcpModel?.animations;
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    for (const [name, value] of Object.entries(saved)) {
      const row = value as { source?: unknown; api?: unknown; params?: unknown; assembly?: unknown } | null;
      if (!row || typeof row.source !== "string") continue;
      const existing = readPluginFile(row.source);
      const id = existing?.kind === "animation" ? existing.plugin : name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "animation";
      if (!animationParameters.has(id) && row.params && typeof row.params === "object" && !Array.isArray(row.params)) {
        const values = Object.entries(row.params).filter((entry): entry is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof entry[1]));
        animationParameters.set(id, Object.fromEntries(values));
        // The names it was saved with are its members' on the assembly it played on, not on another.
        if (typeof row.assembly === "string") animationMembers.set(memberKey(id, row.assembly), Object.fromEntries(values.filter((entry): entry is [string, string] => typeof entry[1] === "string")));
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
  else publishAnimationFacts();
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
  // A member the animation needs that this assembly lacks: said before anything builds (docs/plan-animation-plugins.md A3).
  const missing = missingMember(rigNamesOf(row.assembly), file.memberParams, file.memberNames, file.params, animationValues(file, row.assembly));
  if (missing) { message = missing; renderPanel(); return; }
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
    const chordMm = contactChord(part);
    return [{ object: part.id, name: part.name, positions, ...(chordMm ? { chordMm } : {}) }];
  });
  const params = animationValues(file, live);
  try {
    const result = await runAppAnimation(recipes, file.plugin, file.body, params, assemblySnapshot, (id) => poses.get(id), parts, { signal, transfer: true, ...(file.memberOptional ? { optional: file.memberOptional } : {}), onStage: (stage) => setPreparingStage(ticket, stage) });
    if (!current()) return;
    const { animationStale } = await import("../pose-anim.ts");
    const stale = staleSince(animationStale, assemblySnapshot, poses, objects);
    if (stale) { message = `${stale} while the animation was building. Play it again.`; return; }
    if (!result.ok) { message = result.issues?.length ? result.issues.map((issue) => `${issue.line ? `line ${issue.line}: ` : ""}${issue.reason}`).join("; ") : result.reason; return; }
    preparing = null;
    animation = { result: result.result, spec: result.spec, camera: result.camera, original: assemblySnapshot, poses, parts, clock: new PosePlayback(result.result.frames.length, result.result.fps), assembly: live.id, plugin: { sha, text: file.text, name: file.plugin, source: file.body, api: file.api, params }, used: result.used, colourOnly: result.colourOnly, ...(result.spec.background ? { background: result.spec.background.toLowerCase() } : {}) };
    message = result.result.warnings[0]?.reason ?? "";
    animation.clock.play(performance.now()); animationDrawn = -1; animationTick(); renderPanel();
  } catch (error) {
    if (ticket === animationRun) message = error instanceof Error ? error.message : String(error);
  }
}


function memberKey(plugin: string, assembly: string): string {
  return `${plugin}\u0000${assembly}`;
}
/** The assembly's members as an animation names them (`animationRig`'s names, src/pose-anim.ts). */
function rigNamesOf(assembly: Assembly): { name: string }[] {
  const names = memberNamesOf(assembly.members, (id) => state.plate.objects.find((item) => item.id === id)?.name);
  return assembly.members.map((member) => ({ name: names.get(member.object)! }));
}
/**
 * The values an animation runs with on `assembly`: its defaults, then the values set in the panel, then, for a member
 * parameter, the member chosen on this assembly (another assembly's choice never carries over).
 */
function animationValues(file: PluginFileInfo, assembly: Assembly | null): Record<string, unknown> {
  const members = new Set(file.memberParams ?? []);
  const set = Object.entries(animationParameters.get(file.plugin) ?? {}).filter(([name]) => !members.has(name));
  const chosen = assembly ? animationMembers.get(memberKey(file.plugin, assembly.id)) ?? {} : {};
  const picked = Object.entries(chosen).filter(([name]) => members.has(name));
  return { ...Object.fromEntries(file.params.filter((param) => param.default !== null).map((param) => [param.name, param.default])), ...Object.fromEntries(set), ...Object.fromEntries(picked) };
}

/**
 * A member parameter's control: a select of the assembly's members. A pattern the value holds stays an option with how
 * many parts it matches; a value that matches none shows "Choose a member", and Play then says which to set.
 */
function memberSelect(name: string, label: string, value: string, rig: { name: string }[]): HTMLSelectElement {
  const input = document.createElement("select"); input.dataset.poseAnimationMember = name; input.setAttribute("aria-label", label);
  const option = (text: string, optionValue: string) => { const item = document.createElement("option"); item.value = optionValue; item.textContent = text; input.append(item); };
  const matched = value ? membersMatching(rig, value) : [];
  if (!matched.length) option("Choose a member", "");
  if (matched.length && !rig.some((row) => row.name === value)) option(`${value} (${matched.length} ${matched.length === 1 ? "part" : "parts"})`, value);
  for (const row of rig) option(row.name, row.name);
  input.value = matched.length ? value : "";
  return input;
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
function poseMove(event: MoveEvent): void {
  if (tool !== "move") return;
  if (event.phase === "start" || event.phase === "change") dragging = true;
  onPoseMove(event);
  if (event.phase === "end" || event.phase === "cancel") {
    dragging = false;
    syncPose();
  }
}
function setTool(next: Tool): void {
  stopAnimation();
  view?.cancelReach();
  if (next !== "move") view?.cancelMove();
  pickSerial++;
  tool = next;
  view?.setReach(next === "reach");
  view?.setMove(next === "move");
  chainSelected = false;
  linkParent = null;
  if (loopDraft?.arm) loopDraft = { ...loopDraft, arm: null };
  message = next === "link" ? "Choose the parent, then its child." : next === "reach" ? "Drag a point on a jointed part." : next === "joint" ? "Select a linked part, then click its cylindrical face. Shift-click a mesh to snap its pivot." : next === "move" ? "Drag a part in design space. Right-drag turns it. Alt turns snap off. Shift snaps to 1 mm and 15°." : "";
  const nudge = document.querySelector<HTMLElement>("#gizmoNudge");
  if (nudge && state.stage === "pose") nudge.hidden = next !== "move" || !state.plate.selectedId;
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
/** The next click, while Close a loop is armed, records a point instead of placing a hinge or changing the selection. */
async function pickLoopPoint(id: string, hit: PoseHit): Promise<void> {
  const selectedId = state.plate.selectedId;
  const draft = loopDraft;
  if (!draft?.arm || !selectedId || draft.forId !== selectedId || !sceneShift) return;
  const arm = draft.arm;
  if (arm === "a" && id !== selectedId) { message = "Click the selected part."; renderPanel(); return; }
  if (arm === "b" && id === selectedId) { message = "Click the other part."; renderPanel(); return; }
  const object = state.plate.objects.find((part) => part.id === id);
  if (!object) return;
  const serial = ++pickSerial;
  const inverse = inversePose(modelPoseOf(object));
  const sceneInverse = inversePose(sceneShift);
  const localPoint = (point: readonly number[]): Vec3 => applyPose(inverse, applyPose(sceneInverse, point));
  message = "Reading the point…";
  renderPanel();
  try {
    const solid = object.modelTree || object.brep || /\.(step|stp)$/i.test(object.fileName) ? await (await loadModel()).poseSolid(object) : null;
    if (serial !== pickSerial || state.stage !== "pose" || tool !== "joint" || loopDraft?.forId !== selectedId || loopDraft.arm !== arm) return;
    let at: Vec3 | undefined;
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
      const hitOnSolid = ray.intersectObject(mesh, false)[0];
      const faceIndex = hitOnSolid?.faceIndex;
      geometry.dispose(); material.dispose();
      const pickedFace = faceIndex == null ? undefined : solid.triangles[faceIndex];
      const canvas = document.querySelector<HTMLCanvasElement>("#pose");
      if (canvas) canvas.dataset.jointFace = pickedFace === undefined ? "" : String(pickedFace);
      const hitAt: Vec3 | null = hitOnSolid ? [hitOnSolid.point.x, hitOnSolid.point.y, hitOnSolid.point.z] : null;
      const picked = pickedFace === undefined || !hitAt ? null : pickLoopFace(solid, pickedFace, hitAt);
      if (!picked) {
        if (canvas) delete canvas.dataset.loopStatus;
        message = "Click a cylindrical face, or a mesh.";
        renderPanel();
        return;
      }
      at = picked.at;
      axis = picked.axis;
      const label = loopPickStatus(picked.kind, picked.diameterMm, loopNames(id));
      if (canvas) canvas.dataset.loopStatus = label;
      message = label;
    } else if (hit.shift) {
      const vertices = hit.triangle.map(localPoint);
      const candidates = [...vertices, ...vertices.map((v, i) => v.map((n, k) => (n + vertices[(i + 1) % vertices.length]![k]!) / 2) as Vec3), centre(id)];
      const here = localPoint(hit.point);
      candidates.sort((a, b) => Math.hypot(...a.map((v, i) => v - here[i]!)) - Math.hypot(...b.map((v, i) => v - here[i]!)));
      at = candidates[0];
    } else at = localPoint(hit.point);
    if (!at || !loopDraft || loopDraft.forId !== selectedId) return;
    if (arm === "a") loopDraft = { ...loopDraft, at, axisA: axis ?? null, arm: null };
    else loopDraft = { ...loopDraft, other: id, toAt: at, axisB: axis ?? (loopDraft.other === id ? loopDraft.axisB : null), arm: null };
    const marked = document.querySelector<HTMLCanvasElement>("#pose");
    if (marked) marked.dataset.loopPoint = `${arm}:${id}`;
    if (!axis) {
      if (marked) delete marked.dataset.loopStatus;
      message = arm === "a" ? "Point on this part." : `Point on ${loopNames(id)}.`;
    }
    renderPanel();
  } catch (error) {
    if (serial === pickSerial) { message = `Could not read the point: ${error instanceof Error ? error.message : String(error)}`; renderPanel(); }
  }
}
function pick(id: string | null, hit?: PoseHit): void {
  if (!id) return;
  stopAnimation();
  if (tool === "joint" && hit && loopDraft?.arm && loopDraft.forId === state.plate.selectedId) { void pickLoopPoint(id, hit); return; }
  if (tool === "link") {
    if (!linkParent) { linkParent = id; message = "Now choose the child."; fx.selectPlateObject(id); syncPose(); return; }
    const parent = linkParent;
    linkParent = null;
    message = "Linked. Both parts kept their positions.";
    const refused = linkAssemblyParts(id, parent);
    if (refused) { message = refused; renderPanel(); return; }
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
  // A slide's delta is millimetres along its axis. trainTurn clamps it and turns a pinion a rack drives.
  if ((joint.kind === "hinge" || joint.kind === "slide") && dragAssembly) {
    // A coupled hinge turns its gear train with it (docs/plan-gear-coupling.md); a locked one says why and stays.
    const train = trainTurn(dragAssembly, dragStart.object, event.delta, turnOptions());
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
  view.onMove((event) => poseMove(event));
  view.setMove(tool === "move");
  // The tool rail and the view buttons are heard in wire.ts (pickPoseTool, pickPoseView): they are on screen before
  // this module has loaded.
  document.querySelector("#posePanel")?.addEventListener("click", panelClick);
  document.querySelector("#posePanel")?.addEventListener("change", panelChange);
  document.querySelector("#posePanel")?.addEventListener("focusin", (event) => {
    const input = event.target;
    if (input instanceof HTMLSelectElement && input.id === "poseAlignTo" && input.value) highlightAlign(input.value);
  });
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
    if (event.key === "Escape" && motionRunning) cancelMotion("Run cancelled: nothing changed.");
    else if (event.key === "Escape" && animation) { stopAnimation(); message = ""; syncPose(); }
    else if (event.key === "Escape") setTool("select");
    else if (event.code === "Space" && animation && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement)) { event.preventDefault(); void playAnimation(); }
  });
  fx.syncPose = syncPose;
  return view;
}
/**
 * A press on a Pose tool of the rail, or its key. A press made while this module was still loading can be handed over
 * before the stage's own first showPose (the loads finish in no fixed order), so the scene is shown first.
 */
export function pickPoseTool(value: string): void {
  if (state.stage !== "pose") return;
  if (!view) showPose();
  if (value === "select" || value === "turn" || value === "joint" || value === "link" || value === "reach" || value === "move") setTool(value);
}
/** A press on one of Pose's view buttons (Top, Front, Iso), or its key. The same holds: the view needs its parts first. */
export function pickPoseView(preset: string): void {
  if (state.stage !== "pose") return;
  if (!view) showPose();
  if (preset === "top" || preset === "front" || preset === "iso") view?.setCamera(preset as PoseCamera);
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
  let gizmo: { pivot: Vec3; axes: Vec3[]; radius: number; slide?: boolean } | undefined;
  // A slide shows an arrow along its axis. A hinge shows its ring, a ball its three rings.
  if (tool === "turn" && (row?.member.parent || turnsOnPlate(row?.member)) && row?.member.joint && object && sceneShift) {
    const pose = modelPoseOf(object), joint = row.member.joint;
    const pivot = applyPose(sceneShift, applyPose(pose, joint.pivot));
    const slide = joint.kind === "slide";
    const axes: Vec3[] = joint.kind === "ball" ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((axis) => turnDir(pose, axis)) : [turnDir(pose, joint.axis)];
    const b = boundsOf(object.sourcePos);
    gizmo = { pivot, axes, radius: Math.max(8, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.55), ...(slide ? { slide: true } : {}) };
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
  const poseCanvas = document.querySelector<HTMLCanvasElement>("#pose");
  if (poseCanvas) {
    let gap = 0;
    let any = false;
    for (const assembly of assemblies) {
      if (!assembly.closures?.length) continue;
      any = true;
      gap = Math.max(gap, closureGapMm(assembly, poseOf));
    }
    if (any) poseCanvas.dataset.loopGap = gap.toFixed(6);
    else delete poseCanvas.dataset.loopGap;
  }
  view.setBed(bedX, bedY, bedZ);
  // Drawing only: a part with a solid and no normals yet asks for them once, when the app is idle.
  warmShadingLater();
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
  if (tool === "move" && state.stage === "pose") {
    const nudge = document.querySelector<HTMLElement>("#gizmoNudge");
    if (nudge) nudge.hidden = !state.plate.selectedId;
  }
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
/** What the palette's animation commands can do. Published even when the panel is not on screen. */
function publishAnimationFacts(): void {
  const file = animationFiles.find((item) => item.plugin === animationChoice);
  const ready = !!animation && !animation.motion;
  setAnimationFacts({
    plugins: animationFiles.length > 0,
    assembly: !!selected() && !!file,
    ready,
    preparing: !!preparing,
    inLibrary: !!animation && libraryShas.has(animation.plugin.sha),
  });
}
function renderPanel(): void {
  publishAnimationFacts();
  const panel = document.querySelector<HTMLElement>("#posePanel");
  if (!panel || state.stage !== "pose") { publishLoopFacts(); return; }
  // A Move field being typed in stays where it is: a rebuild that lands mid-typing (a late library read) keeps the number.
  const held = heldMoveCard(panel);
  if (held) for (const node of [...panel.childNodes]) { if (node !== held) node.remove(); }
  else panel.replaceChildren();
  fillPanel(panel);
  if (held) keepMoveCard(held);
  publishLoopFacts();
}
function fillPanel(panel: HTMLElement): void {
  addText(panel, "h3", "Parts");
  addText(panel, "p", "Link two parts to pose them together.");
  const tree = document.createElement("div"); tree.className = "pose-tree"; panel.append(tree);
  const assemblies = liveAssemblies();
  const listed = new Set<string>();
  const addPart = (id: string, depth: number) => {
    const part = state.plate.objects.find((object) => object.id === id); if (!part || listed.has(id)) return;
    listed.add(id); const entry = button(tree, part.name, "select"); entry.dataset.object = id; entry.style.paddingLeft = `${8 + depth * 16}px`; entry.setAttribute("aria-pressed", String(state.plate.selectedId === id));
  };
  for (const assembly of assemblies) {
    const head = document.createElement("div"); head.className = "pose-assembly"; head.dataset.poseAssembly = assembly.id;
    const title = document.createElement("div"); title.className = "pose-assembly-name";
    addText(title, "strong", assembly.name);
    addText(title, "span", `${assembly.members.length} parts`);
    const actions = document.createElement("div"); actions.className = "pose-assembly-actions";
    const ungroup = button(actions, "Ungroup", "ungroup");
    ungroup.dataset.poseUngroup = assembly.id; ungroup.dataset.assembly = assembly.id;
    ungroup.setAttribute("aria-label", `Ungroup ${assembly.name}`); ungroup.dataset.tip = "Ungroup: every part keeps where it is.";
    const exp = button(actions, "Export…", "assembly-export");
    exp.dataset.assembly = assembly.id; exp.setAttribute("aria-label", `Export ${assembly.name}`);
    exp.dataset.tip = "Open Export on this assembly, as STEP.";
    head.append(title, actions); tree.append(head);
    const walk = (parent: string | null, depth: number) => { for (const member of assembly.members.filter((item) => item.parent === parent)) { if (listed.has(member.object)) continue; addPart(member.object, depth); walk(member.object, depth + 1); } };
    walk(null, 0);
  }
  const free = state.plate.objects.filter((part) => !listed.has(part.id));
  if (free.length) {
    addText(tree, "p", "Free parts", "pose-free");
    for (const part of free) addPart(part.id, 0);
  }
  if (tool === "move") appendMoveCard(panel);
  const clashRows = assemblyClashes();
  if (clashRows.length) {
    const interference = document.createElement("div");
    interference.className = "meta warn-text";
    interference.id = "assemblyInterference";
    interference.dataset.tip = "Checked at the assembled poses. It never blocks a slice: a press fit is meant to cross.";
    interference.append(document.createTextNode(`${clashRows.map((row) => (row.unmeasured ? `${row.line} (mesh only: ${row.unmeasured})` : row.line)).join("; ")} `));
    if (clashRows.some((row) => row.volumeMm3 === undefined && row.unmeasured === undefined)) {
      const measure = document.createElement("button");
      measure.className = "btn";
      measure.type = "button";
      measure.dataset.assemblyMeasure = "1";
      measure.dataset.tip = "Ask the kernel for each pair's common volume. Under 0.01 mm³ is a touch.";
      measure.textContent = "Measure";
      interference.append(measure);
    }
    panel.append(interference);
  }
  // The pose is what an export writes: STEP AP242 assembly, glTF, 3MF, STL, OBJ, or Pose sheet.
  if (assemblies.length) {
    const exports = document.createElement("div"); exports.className = "pose-buttons"; panel.append(exports);
    const openExport = button(exports, "Export…", "pose-export");
    openExport.dataset.tip = "Export the posed assembly (or the stopped animation frame) as STEP, glTF, 3MF, STL, OBJ or Pose sheet.";
    for (const assembly of assemblies) {
      const save = button(exports, assemblies.length === 1 ? "Save pose as STEP" : `Save ${assembly.name} as STEP`, "step");
      save.dataset.assembly = assembly.id;
      save.dataset.tip = "One STEP AP242 assembly of the posed parts.";
    }
  }
  addText(panel, "h3", "Animations");
  if (animationFiles.length) {
    const select = document.createElement("select"); select.dataset.poseAnimation = "choice"; select.setAttribute("aria-label", "Animation");
    for (const file of animationFiles) { const option = document.createElement("option"); option.value = file.plugin; option.textContent = file.title; select.append(option); }
    select.value = animationChoice; panel.append(select);
    const file = animationFiles.find((item) => item.plugin === animationChoice);
    const on = selected()?.assembly ?? null;
    const values = file ? animationValues(file, on) : {};
    for (const param of file?.params ?? []) {
      if (param.kind === "face" || param.kind === "outline") continue;
      const label = document.createElement("label"); label.className = "pose-field"; addText(label, "span", param.label || param.name);
      const value = values[param.name] ?? param.default;
      if (param.kind === "text" && file!.memberParams?.includes(param.name)) {
        // A member parameter: the selected assembly's members, so the same animation plays on parts named otherwise. A
        // stacked row, so a long member name shows whole.
        label.classList.add("pose-field-stacked");
        label.append(memberSelect(param.name, param.label || param.name, String(value ?? ""), on ? rigNamesOf(on) : []));
      } else if (param.kind === "choice") {
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
    if (!preparing) button(actions, animation?.clock.playing && !animation.motion ? "Pause" : "Play", "animation-play");
    if (animation && !preparing && !animation.motion) {
      button(actions, "Stop", "animation-stop"); button(actions, "Keep this frame", "animation-keep"); button(actions, "Save animation…", "animation-save");
      const exportFrame = button(actions, "Export…", "pose-export");
      exportFrame.dataset.assembly = animation.assembly;
      exportFrame.dataset.tip = "Export this frame (or the whole animation as glTF) as STEP, glTF, 3MF, STL, OBJ or Pose sheet.";
      // Code the library does not hold yet (a project's animation, an edited one): keep it there, for any assembly.
      if (!libraryShas.has(animation.plugin.sha)) button(actions, "Keep in library…", "animation-library").dataset.tip = "Keep this animation in your plugin library, so it plays on any assembly, its member names chosen there.";
      const slider = document.createElement("input"); slider.type = "range"; slider.min = "0"; slider.max = String(animation.result.frames.length - 1); slider.value = String(animation.clock.frame(performance.now())); slider.dataset.poseAnimationFrame = ""; slider.setAttribute("aria-label", "Animation frame"); panel.append(slider);
      const label = addText(panel, "p", `Frame ${Number(slider.value) + 1} / ${animation.result.frames.length}`); label.dataset.poseAnimationCount = "";
    }
  } else addText(panel, "p", "No animation plugins in this project or library.");
  if (message) addText(panel, "p", message);
  if (chainSelected) addText(panel, "p", "Chain selected. Press Esc to select the part.");
  const row = selected();
  if (!row) {
    // A gear in no assembly: Couple gears makes its train (docs/plan-gear-kinds.md, stage 1).
    freeGearSection(panel);
    if (tool === "joint") loopSection(panel, null);
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
  if (tool === "joint") loopSection(panel, row);
  contactSection(panel, row.assembly, row.member);
  const actions = document.createElement("div"); actions.className = "pose-buttons"; panel.append(actions);
  button(actions, "Rest", "rest"); button(actions, "Make rest", "make-rest"); button(actions, "Undo", "undo"); button(actions, "Redo", "redo");
  massSection(panel, row.assembly, row.member.object);
  motionSection(panel, row.assembly);
}
/**
 * The selected member's body weighed, as model_mass weighs it (docs/plan-mass-properties.md): the part and what rides
 * on it without a joint, a solid at the filament's density, its centre of gravity in model space and, on a hinge, its
 * inertia, lever arm and period as a pendulum. Read-only; a mesh that does not close says so instead.
 */
function fmt3(at: Vec3): string {
  return at.map((value) => String(Math.round(value * 100) / 100)).join(", ");
}
/** Close a loop, in the Joint tool (docs/plan-pose-loops.md L3). The button stays, disabled, when it cannot run. */
function loopSection(panel: HTMLElement, row: { assembly: Assembly; member: Member } | null): void {
  const box = document.createElement("div"); box.dataset.poseLoop = "section"; panel.append(box);
  addText(box, "h3", "Close a loop");
  const memberId = row?.member.object ?? null;
  const draft = memberId ? loopDraftFor(memberId) : null;
  if (draft && row) {
    const mine = button(box, "Pick a point", "loop-arm"); mine.dataset.loopArm = "a"; mine.setAttribute("aria-pressed", String(draft.arm === "a"));
    addText(box, "p", draft.at ? `On this part: ${fmt3(draft.at)}` : "Click this part, or one of its cylindrical faces.");
    const other = button(box, "Pick the other", "loop-arm"); other.dataset.loopArm = "b"; other.setAttribute("aria-pressed", String(draft.arm === "b"));
    addText(box, "p", draft.other && draft.toAt ? `On ${loopNames(draft.other)}: ${fmt3(draft.toAt)}` : "Then click the other part.");
    const kindLabel = document.createElement("label"); kindLabel.className = "pose-field"; addText(kindLabel, "span", "Loop");
    const select = document.createElement("select"); select.dataset.poseLoop = "kind"; select.setAttribute("aria-label", "Loop kind");
    for (const [value, name] of [["pin", "Pin"], ["line", "Line"]] as const) { const option = document.createElement("option"); option.value = value; option.textContent = name; select.append(option); }
    select.value = draft.kind; kindLabel.append(select); box.append(kindLabel);
    if (draft.kind === "line") {
      const hinted = draft.axisB ?? (draft.axisA && draft.other ? axisInFrame(draft.axisA, draft.forId, draft.other) : null);
      for (let i = 0; i < 3; i++) {
        const wrap = document.createElement("label"); wrap.className = "pose-field"; addText(wrap, "span", `Line ${"XYZ"[i]}`);
        const input = document.createElement("input"); input.type = "number"; input.step = "any"; input.dataset.poseLoop = "xyz"[i]!;
        input.value = draft.typed[i]; input.placeholder = hinted ? String(Math.round(hinted[i] * 10000) / 10000) : "";
        input.setAttribute("aria-label", `Line ${"XYZ"[i]}`); wrap.append(input); box.append(wrap);
      }
    }
  }
  const actions = document.createElement("div"); actions.className = "pose-buttons"; box.append(actions);
  const close = button(actions, "Close loop", "close-loop");
  const reason = loopReason(memberId);
  if (reason) { close.setAttribute("aria-disabled", "true"); close.dataset.tip = `Close a loop.\n${reason}`; close.title = reason; }
  else close.dataset.tip = "Close a loop.";
  if (!row) return;
  const loops = (row.assembly.closures ?? []).filter((closure) => closure.a.member === row.member.object || closure.b.member === row.member.object);
  if (!loops.length) addText(box, "p", "No loops on this part.");
  for (const closure of loops) {
    const otherId = closure.a.member === row.member.object ? closure.b.member : closure.a.member;
    const line = document.createElement("div"); line.className = "pose-coupling";
    addText(line, "p", `${closure.kind === "line" ? "Line" : "Pin"} to ${loopNames(otherId)}`);
    const remove = button(line, "Remove", "remove-loop"); remove.dataset.loopId = closure.id;
    box.append(line);
  }
}
function commitLoop(): void {
  const row = selected();
  const draft = loopDraft;
  if (!row || !draft || draft.forId !== row.member.object || !draft.at || !draft.other || !draft.toAt) return;
  const along = draft.kind === "line" ? lineDirection(draft) : null;
  if (draft.kind === "line" && !along) { message = "A line needs a direction."; renderPanel(); return; }
  let toAt = draft.toAt;
  if (draft.axisA && draft.axisB) {
    const aPose = poseOf(draft.forId);
    const bPose = poseOf(draft.other);
    if (aPose && bPose) {
      const foot = coaxialPinAt({ at: draft.at, axis: draft.axisA }, aPose, { at: draft.toAt, axis: draft.axisB }, bPose);
      if (foot) toAt = foot;
    }
  }
  const result = closeLoop(row.assembly, { member: row.member.object, at: draft.at, to: draft.other, toAt, ...(along ? { along } : {}) }, loopNames, poseOf);
  if ("reason" in result) { message = result.reason; renderPanel(); return; }
  message = "Loop closed.";
  loopDraft = { ...draft, arm: null };
  editAssembly(result.assembly);
}
function dropLoop(id: string): void {
  const row = selected();
  if (!row) return;
  const result = removeLoop(row.assembly, id);
  if ("reason" in result) { message = result.reason; renderPanel(); return; }
  message = "Loop removed.";
  editAssembly(result.assembly);
}
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
/** The assembly's members on a hinge or a slide, by name: what a drive, an escapement or a pendulum can name. */
function jointedOf(assembly: Assembly): [string, string][] {
  return assembly.members.filter((row) => drives(row.joint) && row.parent !== null).map((row) => [row.object, state.plate.objects.find((item) => item.id === row.object)?.name ?? row.object]);
}
function motionSelect(parent: HTMLElement, label: string, key: keyof MotionDraft, options: [string, string][], value: string): void {
  // Stacked, as a member parameter is, so a part's whole name shows.
  const wrap = document.createElement("label"); wrap.className = "pose-field pose-field-stacked"; addText(wrap, "span", label);
  const select = document.createElement("select"); select.dataset.poseMotion = key; select.setAttribute("aria-label", label);
  for (const [v, text] of options) { const option = document.createElement("option"); option.value = v; option.textContent = text; select.append(option); }
  select.value = value; wrap.append(select); parent.append(wrap);
}
function motionField(parent: HTMLElement, label: string, key: keyof MotionDraft, value: string, placeholder = ""): void {
  const wrap = document.createElement("label"); wrap.className = "pose-field"; addText(wrap, "span", label);
  const input = document.createElement("input"); input.type = "number"; input.step = "any"; input.dataset.poseMotion = key; input.value = value; input.placeholder = placeholder; input.setAttribute("aria-label", label);
  wrap.append(input); parent.append(wrap);
}
/**
 * Run (docs/plan-hinge-dynamics.md, stage D): the assembly run in time under gravity, a drive and friction, in a worker,
 * with its progress and Cancel in the panel's own block; at the end the motion plays and the answers are said in
 * sentences. A Graham escapement is described by horology's numbers and fitted to the parts.
 */
function motionSection(panel: HTMLElement, assembly: Assembly): void {
  const jointed = jointedOf(assembly);
  if (!jointed.length) return;
  if (motionDraft?.assembly !== assembly.id) {
    motionDraft = { assembly: assembly.id, drive: jointed[0]![0], kind: "torque", amount: "0.25", wheel: "", anchor: "", teeth: "30", tip: "", root: "", lean: "", span: "", pendulum: "", friction: "0.3", seconds: "20" };
  }
  const draft = motionDraft;
  const box = document.createElement("div"); box.dataset.poseMotion = "section"; panel.append(box);
  addText(box, "h3", "Run");
  addText(box, "p", "Runs the assembly in time: gravity, each part's mass from its mesh, the drive, and friction at the pins. Printed pivots' friction is not known, so each run also sweeps it.", "pose-help");
  motionSelect(box, "Drive part", "drive", jointed, draft.drive);
  motionSelect(box, "Drive", "kind", [["torque", "Torque (N·mm)"], ["weight", "Weight on its winch (g)"]], draft.kind);
  motionField(box, draft.kind === "torque" ? "Torque N·mm" : "Weight g", "amount", draft.amount);
  motionSelect(box, "Escape wheel", "wheel", [["", "None"], ...jointed], draft.wheel);
  if (draft.wheel) {
    motionSelect(box, "Anchor", "anchor", [["", "Choose"], ...jointed.filter(([id]) => id !== draft.wheel)], draft.anchor);
    motionField(box, "Teeth", "teeth", draft.teeth);
    motionField(box, "Tip radius mm", "tip", draft.tip);
    motionField(box, "Root radius mm", "root", draft.root);
    motionField(box, "Lean °", "lean", draft.lean);
    motionField(box, "Span teeth", "span", draft.span, "7.5");
  } else motionSelect(box, "Pendulum", "pendulum", [["", "None"], ...jointed], draft.pendulum);
  motionField(box, "Friction", "friction", draft.friction);
  motionField(box, "Seconds", "seconds", draft.seconds);
  if (motionRunning?.assembly === assembly.id) motionProgressBlock(box);
  else {
    const actions = document.createElement("div"); actions.className = "pose-buttons"; box.append(actions);
    const run = button(actions, "Run", "motion-run");
    run.dataset.tip = "Run it from rest and from a push, each again at half the step to check the answer, then at friction 0.1 to 0.5.";
    run.disabled = !!motionRunning;
  }
  if (motionNote?.assembly === assembly.id) {
    const note = document.createElement("div"); note.dataset.poseMotionReport = ""; note.setAttribute("role", "status"); box.append(note);
    if (motionNote.verdict) addText(note, "p", VERDICT_WORDS[motionNote.verdict] ?? motionNote.verdict, "pose-motion-verdict").dataset.verdict = motionNote.verdict;
    for (const line of motionNote.lines) addText(note, "p", line, motionNote.error ? "pose-error" : undefined);
  }
  if (animation?.motion && animation.assembly === assembly.id) {
    const actions = document.createElement("div"); actions.className = "pose-buttons"; box.append(actions);
    button(actions, animation.clock.playing ? "Pause" : "Play", "motion-play");
    button(actions, "Stop", "animation-stop");
    const slider = document.createElement("input"); slider.type = "range"; slider.min = "0"; slider.max = String(animation.result.frames.length - 1); slider.value = String(animation.clock.frame(performance.now())); slider.dataset.poseAnimationFrame = ""; slider.setAttribute("aria-label", "Run frame"); box.append(slider);
    addText(box, "p", `Frame ${Number(slider.value) + 1} / ${animation.result.frames.length}`).dataset.poseAnimationCount = "";
  }
}
/** The run's progress, as the animation's preparation shows its own: what runs, a bar, Cancel. */
/** A run's verdict as the panel's heading (src/motion.ts says what each means). */
const VERDICT_WORDS: Record<string, string> = {
  "not converged": "Not converged", runs: "It runs", "not settled": "Not settled", stalls: "It does not run", overswings: "It swings past its pallets",
  swings: "It swings", "swings, decaying": "It swings, decaying", still: "It hangs still", moves: "It moves",
};
function motionProgressBlock(parent: HTMLElement): void {
  const block = document.createElement("div"); block.className = "pose-progress"; block.dataset.poseMotionProgress = "";
  const head = document.createElement("div"); head.className = "pose-progress-head";
  addText(head, "span", "", "pose-progress-title").dataset.poseMotionStage = "";
  addText(head, "span", "", "pose-progress-share").dataset.poseMotionShare = "";
  const bar = document.createElement("div"); bar.className = "pose-progress-bar"; bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-label", "Running the assembly"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); bar.dataset.poseMotionBar = "";
  bar.append(document.createElement("span"));
  const foot = document.createElement("div"); foot.className = "pose-progress-foot";
  const detail = document.createElement("p"); detail.className = "pose-progress-detail"; detail.textContent = "From rest and from a push, each again at half the step, then the friction sweep.";
  foot.append(detail);
  button(foot, "Cancel", "motion-cancel").dataset.tip = "Stop the run (Esc). Nothing changes.";
  block.append(head, bar, foot);
  parent.append(block);
  drawMotionProgress();
}
function drawMotionProgress(): void {
  const block = document.querySelector<HTMLElement>("[data-pose-motion-progress]");
  if (!block || !motionRunning) return;
  block.querySelector<HTMLElement>("[data-pose-motion-stage]")!.textContent = motionRunning.stage || "Getting the run ready…";
  const share = Math.floor(motionRunning.fraction * 100);
  block.querySelector<HTMLElement>("[data-pose-motion-share]")!.textContent = `${share}%`;
  const bar = block.querySelector<HTMLElement>("[data-pose-motion-bar]")!;
  bar.setAttribute("aria-valuenow", String(share));
  (bar.firstElementChild as HTMLElement).style.width = `${share}%`;
}
function cancelMotion(said: string): void {
  if (!motionRunning) return;
  const assembly = motionRunning.assembly;
  motionRunning.stop();
  motionRunning = null;
  motionTicket += 1;
  motionNote = { assembly, lines: [said] };
  renderPanel();
}
/** The draft as a run's spec, or what is wrong with it in a sentence. */
function motionSpecOf(draft: MotionDraft): MotionSpec | string {
  const n = (text: string, what: string): number | string => { const v = Number(text); return text.trim() !== "" && Number.isFinite(v) ? v : what; };
  const amount = n(draft.amount, `Enter the drive's ${draft.kind === "torque" ? "torque in N·mm" : "weight in grams"}.`);
  const friction = n(draft.friction, "Enter a friction coefficient, 0 to 1.");
  const seconds = n(draft.seconds, "Enter the seconds to run, up to 600.");
  for (const v of [amount, friction, seconds]) if (typeof v === "string") return v;
  if ((friction as number) < 0 || (friction as number) > 1) return "Friction is 0 to 1.";
  if (!((seconds as number) > 0 && (seconds as number) <= 600)) return "Run 0 to 600 seconds.";
  const spec: MotionSpec = { densityGCm3: state.profile.filamentDensityGCm3, friction: friction as number, seconds: seconds as number, fps: 10, drive: { member: draft.drive, ...(draft.kind === "torque" ? { torqueNmm: amount as number } : { weightG: amount as number }) } };
  if (draft.wheel) {
    if (!draft.anchor) return "Choose the anchor.";
    const words = { teeth: "teeth", tip: "tip radius in mm", root: "root radius in mm", lean: "teeth lean in degrees", span: "span in teeth" } as const;
    const nums = (["teeth", "tip", "root", "lean", "span"] as const).map((key) => n(draft[key], `Enter the escape wheel's ${words[key]}, as horology built it.`));
    const bad = nums.find((v) => typeof v === "string");
    if (typeof bad === "string") return bad;
    const [teeth, tip, root, lean, span] = nums as number[];
    spec.escapement = { wheel: draft.wheel, anchor: draft.anchor, teeth: teeth!, tip: tip!, root: root!, lean: lean!, span: span! };
  } else if (draft.pendulum) spec.pendulum = draft.pendulum;
  return spec;
}
/** Run: the assembly's copy and its meshes to the worker (or in slices on this thread), then play what it did. */
async function startMotion(): Promise<void> {
  const row = selected();
  if (!row || !motionDraft || motionRunning) return;
  const spec = motionSpecOf(motionDraft);
  if (typeof spec === "string") { motionNote = { assembly: row.assembly.id, lines: [spec], error: true }; renderPanel(); return; }
  stopAnimation();
  const snapshot = structuredClone(row.assembly);
  const names = new Map(snapshot.members.map((m) => [m.object, state.plate.objects.find((item) => item.id === m.object)?.name ?? m.object]));
  const rig = memberNamesOf(snapshot.members, (id) => names.get(id));
  const parts = snapshot.members.flatMap((m) => {
    const part = state.plate.objects.find((item) => item.id === m.object);
    return part ? [{ object: part.id, name: part.name, positions: part.sourcePos.slice(), pose: meshToModel(part), frame: modelPoseOf(part) }] : [];
  });
  const ticket = ++motionTicket;
  const job: MotionJobMessage = { id: ticket, assembly: snapshot, parts, spec, names: [...names], rig: [...rig] };
  const current = () => ticket === motionTicket && state.stage === "pose";
  const progress = (value: { fraction: number; stage: string }) => {
    if (!current() || !motionRunning) return;
    motionRunning.fraction = value.fraction; motionRunning.stage = value.stage;
    drawMotionProgress();
  };
  const done = (report: MotionReport | { reason: string }) => { if (current()) void finishMotion(ticket, snapshot, report); };
  let worker: Worker | null = null;
  try { worker = new Worker(new URL("../motion-worker.ts", import.meta.url), { type: "module" }); } catch { worker = null; }
  if (worker) {
    const w = worker;
    motionRunning = { ticket, assembly: row.assembly.id, worker: w, stop: () => w.terminate(), fraction: 0, stage: "" };
    w.addEventListener("message", (ev: MessageEvent<MotionJobReply>) => {
      if (ev.data.id !== ticket) return;
      if ("progress" in ev.data) progress(ev.data.progress);
      else { w.terminate(); done(ev.data.done); }
    });
    w.addEventListener("error", () => { w.terminate(); if (current()) { motionRunning = null; motionNote = { assembly: snapshot.id, lines: ["The run stopped: press Run again."], error: true }; renderPanel(); } }, { once: true });
    motionNote = null; renderPanel();
    w.postMessage(job, parts.map((part) => part.positions.buffer as ArrayBuffer));
    return;
  }
  // No worker: the same steps in slices, so the window keeps answering and Cancel is heard.
  const { motionJobSteps } = await import("../motion-worker.ts");
  const steps = motionJobSteps(job);
  let stopped = false;
  motionRunning = { ticket, assembly: row.assembly.id, worker: null, stop: () => { stopped = true; }, fraction: 0, stage: "" };
  motionNote = null; renderPanel();
  const slice = () => {
    if (stopped || !current()) return;
    const until = performance.now() + 30;
    for (;;) {
      const step = steps.next();
      if (step.done) { done(step.value); return; }
      if (performance.now() > until) { progress(step.value); break; }
    }
    window.setTimeout(slice, 0);
  };
  slice();
}
/** The run's report into the panel, and its keys sampled into frames that play as an animation. */
async function finishMotion(ticket: number, snapshot: Assembly, report: MotionReport | { reason: string }): Promise<void> {
  motionRunning = null;
  if ("reason" in report) { motionNote = { assembly: snapshot.id, lines: [report.reason], error: true }; renderPanel(); return; }
  const lines = [...report.sentences, ...report.notes, `Left out: ${report.leftOut.join("; ")}.`];
  motionNote = { assembly: snapshot.id, verdict: report.verdict, lines };
  if (report.animation) {
    const { sampleAnimation } = await import("../pose-anim.ts");
    if (ticket !== motionTicket || state.stage !== "pose") return;
    const poses = new Map(snapshot.members.map((member) => [member.object, poseOf(member.object)]));
    const parts: AnimationPart[] = snapshot.members.flatMap((member) => {
      const part = state.plate.objects.find((item) => item.id === member.object);
      if (!part) return [];
      const seat = meshSeat(part.bytes) ?? 0, positions = part.sourcePos.slice();
      if (seat) for (let i = 2; i < positions.length; i += 3) positions[i] += seat;
      return [{ object: part.id, name: part.name, positions }];
    });
    const result = sampleAnimation(report.animation, snapshot, (id) => poses.get(id), parts, { interference: false });
    if ("issues" in result) lines.push(`The motion cannot be shown: ${result.issues.map((issue) => issue.reason).join("; ")}`);
    else {
      const played: PoseAnimationState = { result, spec: report.animation, original: snapshot, poses, parts, clock: new PosePlayback(result.frames.length, result.fps), assembly: snapshot.id, plugin: { sha: "", text: "", name: "motion-run", source: "", api: RECIPE_API.join("."), params: {} }, motion: true };
      animation = played;
      played.clock.play(performance.now()); animationDrawn = -1; animationTick();
    }
  }
  renderPanel();
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
  if (!contactBusy && contactExact?.object === member.object) {
    const exact = button(actions, "Exact contact", "contact-exact");
    exact.dataset.tip = `Ask the kernel for the exact contact on these curved faces: it checks the solids' common volume, at most ${KERNEL_CHECKS} times (each a boolean of the two solids, so it can take some seconds), and moves the joint to the last pose it calls clear or a touch. One Undo.`;
  }
  const line = contactBusy ? (contactBusyText ?? "Finding contact…") : contactNote?.object === member.object ? contactNote.text : "";
  if (line) { const note = addText(panel, "p", line); note.dataset.poseContactNote = ""; note.setAttribute("role", "status"); }
}
/** KERNEL_CALLS in src/contact.ts, kept here so the panel does not load the solve to draw a tip. */
const KERNEL_CHECKS = 12;
let contactBusyText: string | null = null;
/** The chord a plate part's mesh was made at when the kernel made it (a Model solid or a STEP); none for a mesh file, which is its own triangles. */
function contactChord(part: (typeof state.plate.objects)[number]): number | undefined {
  const solid = !!part.modelTree || !!part.brep || /\.(step|stp)$/i.test(part.fileName);
  return solid ? Math.max(part.stepTolerance || 0, state.stepTolerance || 0) || undefined : undefined;
}
const mmText = (value: number) => `${Math.round(value * 1000) / 1000} mm`;
/** The line under the buttons for a contact found by the shared solve: on curved faces, what the facets can and cannot say. */
function contactLine(answer: ContactAnswer, nameOf: (id: string) => string, at: (value: number) => string, ignored: string): string {
  const pair = answer.pair!, meets = `${nameOf(pair.moving)} meets ${nameOf(pair.other)} at ${at(answer.value)}`;
  const bound = answer.boundMm ?? 0, left = answer.clearanceMm!;
  if (!(bound > 0)) return `${meets}, ${mmText(left)} left.${ignored}`;
  if (answer.marginKept === false) return `${meets}, ${mmText(left)} left between the meshes; their curved faces are meshed to within ${mmText(bound)}, and they already stood that close, so the parts may overlap by up to ${mmText(Math.max(0, bound - left))}.${ignored}`;
  return `${meets}, clear by at most ${mmText(left + bound)}. On curved faces it stops just short, so the parts cannot overlap.${ignored}`;
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
    const chordMm = contactChord(part);
    return [{ object: part.id, positions, ...(chordMm ? { chordMm } : {}) }];
  });
  const poses = assembly.members.flatMap((member) => { const pose = poseOf(member.object); return pose ? [[member.object, pose] as [string, Affine]] : []; });
  const job: ContactJob = { id: ++contactJob, assembly: structuredClone(assembly), poses, parts, object, dir, names: assembly.members.map((member) => [member.object, nameOf(member.object)]) };
  contactBusy = true; contactNote = null; contactExact = null; renderPanel();
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
  contactNote = { object, text: contactLine(answer, nameOf, at, ignored) };
  // On curved faces of two solids, the desktop app can ask the kernel for the exact contact.
  const solidOf = (id: string) => { const part = state.plate.objects.find((item) => item.id === id); return !!part && contactChord(part) !== undefined; };
  const offer = (answer.boundMm ?? 0) > 0 && fx.isTauri() && solidOf(pair.moving) && solidOf(pair.other);
  const before = structuredClone(assembly);
  editAssembly(answer.assembly);
  if (offer) { contactExact = { object, before, after: JSON.stringify(liveAssemblies().find((item) => item.id === assembly.id)), answer }; renderPanel(); }
}
/**
 * "Exact contact": the kernel's contact from the last answer on curved faces (`kernelContact`, the same as model_place
 * {until} over MCP). It asks the kernel for the pair's common volume at the facets' own contact and between, at most
 * KERNEL_CALLS times, and moves the joint to the last pose it calls clear or a touch: one Undo. Nothing moves when it
 * finds none within the budget, and the line says so.
 */
async function exactContact(): Promise<void> {
  const held = contactExact;
  const row = selected();
  if (!held || !row || contactBusy || row.member.object !== held.object) return;
  const object = held.object, answer = held.answer, pair = answer.pair!;
  const nameOf = (id: string) => state.plate.objects.find((part) => part.id === id)?.name ?? id;
  const live = () => liveAssemblies().find((item) => item.id === held.before.id);
  if (JSON.stringify(live()) !== held.after) { contactExact = null; contactNote = { object, text: "The assembly changed since contact was found. Press Until contact again." }; renderPanel(); return; }
  const [{ kernelContact }, { exactVerdict, meshVolume }, model] = await Promise.all([import("../contact.ts"), import("../interference.ts"), loadModel()]);
  const partOf = (id: string) => state.plate.objects.find((item) => item.id === id);
  const a = partOf(pair.moving), b = partOf(pair.other);
  if (!a || !b) return;
  const volumes: [number, number] = [meshVolume(a.sourcePos), meshVolume(b.sourcePos)];
  const measure = async (value: number): Promise<KernelVerdict | { reason: string }> => {
    const turned = trainTurn(held.before, answer.body, value - answer.from, turnOptions());
    if ("reason" in turned) return { reason: turned.reason };
    const poses = solveAssembly(turned.assembly, poseOf).poses;
    const pa = poses.get(a.id), pb = poses.get(b.id);
    if (!pa || !pb) return { reason: "Both parts need a pose in the assembly." };
    const volume = await model.commonVolume(a.id, b.id, [pa, pb]);
    if (typeof volume === "string") return { reason: volume };
    return { verdict: volume === 0 ? "clear" : exactVerdict(volume, volumes), volumeMm3: Math.round(volume * 1000) / 1000 };
  };
  contactBusy = true; contactBusyText = "Asking the kernel…"; renderPanel();
  const started = performance.now();
  let kernel: Awaited<ReturnType<typeof kernelContact>>;
  try {
    kernel = await kernelContact(answer, measure);
  } catch (error) {
    kernel = { reason: error instanceof Error ? error.message : String(error) };
  }
  contactBusy = false; contactBusyText = null;
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (state.stage !== "pose") return;
  if (JSON.stringify(live()) !== held.after) { contactExact = null; contactNote = { object, text: "The assembly changed while the kernel was asked. Press Until contact again." }; renderPanel(); return; }
  contactExact = null;
  if ("reason" in kernel) { contactNote = { object, text: `The kernel could not measure ${nameOf(pair.moving)} and ${nameOf(pair.other)}: ${kernel.reason} Nothing moved.` }; renderPanel(); return; }
  const slide = answer.kind === "slide";
  const at = (value: number) => `${Math.round(value * 100) / 100}${slide ? " mm" : "°"}`;
  const checks = `${kernel.calls} kernel check${kernel.calls === 1 ? "" : "s"}, ${seconds} s`;
  if (!kernel.reached) {
    contactNote = { object, text: `The kernel finds ${kernel.meshAnswer.volumeMm3} mm³ shared at the facets' contact (${at(kernel.meshValue)}) and found no pose it calls clear within ${checks}. Nothing moved: the pose stays at ${at(answer.value)}.` };
    renderPanel(); return;
  }
  const turned = trainTurn(held.before, answer.body, kernel.value - answer.from, turnOptions());
  if ("reason" in turned) { contactNote = { object, text: turned.reason }; renderPanel(); return; }
  const there = kernel.at.verdict === "clear" ? "no shared volume" : `${kernel.at.volumeMm3} mm³ shared, a touch`;
  const short = kernel.backedOff > 0 ? `, ${at(kernel.backedOff)} short of the facets' contact` : ", at the facets' own contact";
  contactNote = { object, text: `${nameOf(pair.moving)} meets ${nameOf(pair.other)} at ${at(kernel.value)} by the kernel: ${there} there${short} (${checks}).` };
  editAssembly(turned.assembly);
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
    const kinds: [CoupleKind, string][] = [["ratio", "Ratio"], ["winch", "Winch: drum and cord"], ["ratchet", "Ratchet: one way only"], ["clutch", "Clutch: can slip"]];
    addText(box, "p", `${nameOf(own)} drives:`, "pose-couple-lead");
    const others = assembly.members.filter((row) => {
      const other = bodyOf(assembly, row.object);
      return row.object !== own && !!other && !("reason" in other) && other.body !== own;
    });
    coupleSelect(box, "Other part", "driven", [["", "Choose a part"], ...others.map((row) => [row.object, nameOf(row.object)] as [string, string])], draft.driven);
    coupleSelect(box, "Kind", "kind", kinds, draft.kind);
    if (draft.kind === "ratio") coupleField(box, "Ratio", "ratio", draft.ratio, "1");
    if (draft.kind === "winch") {
      coupleField(box, "Drum radius mm", "radius", draft.radius, "");
      coupleSelect(box, "Turning the drum forward", "wind", [["in", "winds the cord in"], ["out", "pays the cord out"]], draft.wind);
    }
    if (draft.kind === "ratchet") ratchetFields(box, assembly, member, own);
    if (draft.kind === "clutch") coupleField(box, "Ratio", "ratio", draft.ratio, "1");
    const help: Record<CoupleKind, string> = {
      ratio: "The other part moves this many degrees (or mm on a slide) for each degree (or mm) of this one. Either part can be turned.",
      winch: "This part is the drum. The other part is the load on a slide: it moves the length of cord the drum winds, 2πr for each turn.",
      ratchet: "This part is the ratchet wheel. The other part is what its click is mounted on, or the frame. Turned one way, the wheel carries that part; the other way it runs free. Add the click, seated in a tooth now: the click rides each tooth and drops. A wheel or click made by the built-in Ratchet wheel and Ratchet click gives its numbers itself.",
      clutch: "No torque is computed: the clutch slips only when the other part is held, stuck or turned by itself.",
    };
    addText(box, "p", help[draft.kind], "pose-couple-help");
    const actions = document.createElement("div"); actions.className = "pose-buttons"; box.append(actions);
    const go = button(actions, "Couple", "couple-declared");
    go.dataset.tip = "Couple this part's joint to the other part's, as set above. Turning either then moves the other. One Undo.";
  }
  if (coupleNote?.assembly === assembly.id) { const note = addText(box, "p", coupleNote.text); note.dataset.poseCoupleNote = ""; note.setAttribute("role", "status"); }
}
/** A part's Model tree, where a plugin's stamp is. */
function treeOfPart(id: string) {
  const obj = state.plate.objects.find((part) => part.id === id);
  return obj?.modelTree ? modelTrees.get(obj.modelTree) : undefined;
}
const projectCode = (sha256: string) => session.plugins?.[sha256];
/** The parts of a ratchet coupling as the stamp readers take them. */
function couplingParts(assembly: Assembly, wheel: string, click: string | null): { wheel: CouplingPart; click: CouplingPart | null } {
  const nameOf = (id: string) => state.plate.objects.find((part) => part.id === id)?.name ?? id;
  const joint = assembly.members.find((row) => row.object === wheel)?.joint;
  return {
    wheel: { name: nameOf(wheel), tree: treeOfPart(wheel), hingeAxis: joint?.kind === "hinge" ? joint.axis : undefined },
    click: click ? { name: nameOf(click), tree: treeOfPart(click), pose: poseOf(click) } : null,
  };
}
/**
 * The ratchet's own fields (docs/plan-clock-parts.md): the free way, the click (those made by Ratchet click for this
 * wheel first, and chosen when the person has not), and the wheel's teeth, tip and root, shown as read from the parts'
 * stamps, with Type them for a wheel made another way. Without a stamp the numbers are typed, as before.
 */
function ratchetFields(box: HTMLElement, assembly: Assembly, member: Member, own: string): void {
  const nameOf = (id: string) => state.plate.objects.find((part) => part.id === id)?.name ?? id;
  const wheelId = member.object;
  const wheelStamp = ratchetStamp(treeOfPart(wheelId), projectCode, [RATCHET_WHEEL]);
  const { wheel } = couplingParts(assembly, wheelId, null);
  const free = wheelStamp && wheel.hingeAxis ? freeWayOf(wheel.hingeAxis) : null;
  if (free && coupleDraft.freeSet !== "1") coupleDraft = { ...coupleDraft, free: String(free) };
  const clicks = assembly.members.filter((row) => row.joint?.kind === "hinge" && row.parent !== null && row.object !== own && row.object !== wheelId);
  const stamps = new Map(clicks.map((row) => [row.object, ratchetStamp(treeOfPart(row.object), projectCode, [RATCHET_CLICK])] as const));
  const fits = (id: string) => !!stamps.get(id) && (!wheelStamp || clickFits(stamps.get(id)!, wheelStamp.numbers));
  const ordered = [...clicks.filter((row) => fits(row.object)), ...clicks.filter((row) => !fits(row.object))];
  if (!coupleDraft.click && coupleDraft.clickSet !== "1" && ordered[0] && fits(ordered[0].object)) coupleDraft = { ...coupleDraft, click: ordered[0].object };
  const draft = coupleDraft;
  coupleSelect(box, "Runs free turning", "free", [["1", "forward"], ["-1", "back"]], draft.free);
  if (free && draft.freeSet !== "1") addText(box, "p", `As ${wheelStamp!.title} cuts its teeth, ${nameOf(wheelId)} runs free turning ${free === 1 ? "forward" : "back"} on its hinge.`, "pose-couple-help");
  coupleSelect(box, "Click", "click", [["", "None"], ...ordered.map((row) => [row.object, fits(row.object) ? `${nameOf(row.object)} (made for this wheel)` : nameOf(row.object)] as [string, string])], draft.click);
  if (!draft.click) return;
  const parts = couplingParts(assembly, wheelId, draft.click);
  const read = readRatchet(parts.wheel, parts.click, projectCode);
  if (read && !("reason" in read) && draft.manual !== "1") {
    const line = addText(box, "p", `Read from the parts: ${read.said}`, "pose-couple-read");
    line.dataset.poseCoupleRead = read.from;
    const type = button(box, "Type them", "couple-type");
    type.dataset.tip = "Type the wheel's teeth and radii yourself, for a wheel made another way.";
    return;
  }
  if (read && "reason" in read) addText(box, "p", read.reason, "pose-couple-help").dataset.poseCoupleRead = "refused";
  coupleField(box, "Teeth", "teeth", draft.teeth, "");
  coupleField(box, "Tip radius mm", "tip", draft.tip, "");
  coupleField(box, "Root radius mm", "root", draft.root, "");
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
/** Whether the parts give the ratchet's numbers, so the form shows them read. */
function readsRatchet(assembly: Assembly, wheel: string, click: string): boolean {
  const parts = couplingParts(assembly, wheel, click);
  const read = readRatchet(parts.wheel, parts.click, projectCode);
  return !!read && !("reason" in read);
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
      if (draft.manual === "1" || !readsRatchet(row.assembly, row.member.object, draft.click)) for (const key of ["teeth", "tip", "root"] as const) { const value = number(draft[key]); if (value !== undefined) spec[key] = value; }
      const pose = poseOf(draft.click);
      if (pose) spec.clickCentre = applyPose(pose, centre(draft.click));
      // docs/plan-clock-parts.md: what the person did not type is read from the stamps, and a stamped click's hand from
      // its own outline.
      const parts = couplingParts(row.assembly, row.member.object, draft.click);
      const stamped = ratchetFromStamps(parts.wheel, parts.click, { teeth: spec.teeth, tip: spec.tip, root: spec.root, free: spec.free }, projectCode);
      if ("reason" in stamped) { say(stamped.reason); return; }
      Object.assign(spec, stamped.fill);
      if (stamped.clickCentre) spec.clickCentre = stamped.clickCentre;
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
  const measure = (event.target as Element).closest<HTMLButtonElement>("[data-assembly-measure]");
  if (measure) {
    measure.disabled = true;
    measure.textContent = "Measuring…";
    void measureClashes(async (a, b) => (await loadModel()).commonVolume(a, b));
    return;
  }
  const target = (event.target as Element).closest<HTMLButtonElement>("[data-pose-action]");
  if (!target) return;
  if (target.dataset.poseAction === "move-frame") {
    const frame = target.dataset.placeFrame;
    if (frame === "part" || frame === "model") setMoveFrame(frame);
    return;
  }
  if (target.dataset.poseAction === "move-align") {
    const to = document.querySelector<HTMLSelectElement>("#poseAlignTo");
    const how = document.querySelector<HTMLSelectElement>("#poseAlignHow");
    if (to?.value && how && isAlignRelation(how.value)) alignMove(to.value, how.value);
    return;
  }
  const action = target.dataset.poseAction;
  if (animation && action && !action.startsWith("animation-") && action !== "pose-export") stopAnimation();
  if (action === "pose-export") {
    const current = animation;
    const frameIndex = current ? current.clock.frame(performance.now()) : undefined;
    if (current?.clock.playing) {
      current.clock.pause(performance.now());
      syncPose();
      renderPanel();
    }
    const title = current ? (animationFiles.find((item) => item.plugin === current.plugin.name)?.title ?? current.plugin.name) : undefined;
    const assemblyId = target.dataset.assembly || current?.assembly || selected()?.assembly.id || liveAssemblies()[0]?.id;
    void import("./pose-export-dialog.ts").then(({ showPoseExport }) => {
      if (state.stage !== "pose") return;
      showPoseExport({ assemblyId, animation: current, animationTitle: title, frameIndex });
    });
    return;
  }
  if (action === "animation-play") { void playAnimation(); return; }
  if (action === "motion-run") { void startMotion(); return; }
  if (action === "motion-cancel") { cancelMotion("Run cancelled: nothing changed."); return; }
  if (action === "motion-play" && animation?.motion) {
    if (animation.clock.playing) animation.clock.pause(performance.now());
    else { animation.clock.play(performance.now()); animationDrawn = -1; animationTick(); }
    renderPanel(); return;
  }
  if (action === "animation-cancel") { cancelPreparation("Animation cancelled."); return; }
  if (action === "animation-save") {
    if (animation && view && sceneShift) {
      const current = animation, poseView = view, shift = sceneShift;
      void import("./pose-animation-save.ts").then(({ showAnimationSave }) => { if (animation === current && state.stage === "pose") showAnimationSave({ current, view: poseView, shift, active: () => animation, isPose: () => state.stage === "pose", sync: syncPose, render: renderPanel }); });
    }
    return;
  }
  if (action === "animation-library") {
    if (animation) {
      const current = animation;
      void import("./pose-animation-keep.ts").then(({ showAnimationKeep }) => {
        if (animation !== current || state.stage !== "pose") return;
        const file = animationFiles.find((item) => item.plugin === current.plugin.name);
        showAnimationKeep({ current, file, done: (id, said) => {
          message = said;
          // The kept plugin starts from the values it was played with, its members' on this assembly included.
          const played = Object.entries(current.plugin.params).filter((entry): entry is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof entry[1]));
          animationParameters.set(id, Object.fromEntries(played));
          animationMembers.set(memberKey(id, current.original.id), Object.fromEntries(played.filter((entry): entry is [string, string] => typeof entry[1] === "string")));
          // The keep added its file to the project's plugins: the same project, so the values set here stay.
          animationParameterPlugins = session.plugins;
          void refreshAnimations().then(() => { if (animationFiles.some((item) => item.plugin === id)) { animationChoice = id; renderPanel(); } });
        } });
      });
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
  if (action === "ungroup" && target.dataset.assembly) {
    message = "Ungrouped. Every part kept where it is.";
    ungroupAssembly(target.dataset.assembly);
    return;
  }
  if (action === "assembly-export" && target.dataset.assembly) {
    const assemblyId = target.dataset.assembly;
    void import("./export-dialog.ts").then(({ showExport }) => {
      void import("../modeling/partition-export.ts").then(({ exportStem }) => {
        const name = liveAssemblies().find((row) => row.id === assemblyId)?.name ?? "assembly";
        showExport({ scope: "assembly", format: "step", explicitFormat: true, assemblyId, fileName: `${exportStem(name)}.step` });
      });
    });
    return;
  }
  if (action === "select" && target.dataset.object) { pick(target.dataset.object); return; }
  if (action === "contact-back" || action === "contact-on") { void untilContact(action === "contact-on" ? 1 : -1); return; }
  if (action === "contact-exact") { void exactContact(); return; }
  if (action === "couple-declared") { coupleDeclared(); return; }
  if (action === "couple-type") {
    // Type the numbers over those read: the fields start from them.
    const row = selected();
    const parts = row && coupleDraft.click ? couplingParts(row.assembly, row.member.object, coupleDraft.click) : null;
    const read = parts ? readRatchet(parts.wheel, parts.click, projectCode) : null;
    const numbers = read && !("reason" in read) ? read.numbers : null;
    coupleDraft = { ...coupleDraft, manual: "1", ...(numbers ? { teeth: String(numbers.teeth), tip: String(numbers.tip), root: String(numbers.root) } : {}) };
    renderPanel();
    return;
  }
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
  if (action === "loop-arm") {
    const arm = target.dataset.loopArm === "b" ? "b" : "a";
    const armed = selected();
    if (!armed) { message = LOOP_EMPTY; renderPanel(); return; }
    const draft = loopDraftFor(armed.member.object);
    loopDraft = { ...draft, arm: draft.arm === arm ? null : arm };
    message = loopDraft.arm === "a" ? "Click a point on this part." : loopDraft.arm === "b" ? "Click a point on the other part." : "";
    renderPanel();
    return;
  }
  if (action === "close-loop") {
    const reason = loopReason(selected()?.member.object ?? null);
    if (reason) { message = reason; renderPanel(); return; }
    commitLoop();
    return;
  }
  if (action === "remove-loop") {
    const id = target.dataset.loopId;
    if (id) dropLoop(id);
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
      const result = trainTurn(assembly, member.object, -jointAt(live.joint), turnOptions());
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
  if (input.id.startsWith("poseMove") && input instanceof HTMLInputElement && input.type === "number") {
    moveFieldChanged(input);
    return;
  }
  if (input.id === "poseSettleOn" && input instanceof HTMLInputElement) {
    poseSettleChanged(input.checked);
    return;
  }
  if (input.id === "poseAlignTo" && input instanceof HTMLSelectElement) {
    highlightAlign(input.value);
    return;
  }
  if (input.dataset.poseAnimation === "choice") { stopAnimation(); cancelPreparation(""); animationChoice = input.value; syncPose(); return; }
  if (input.dataset.poseAnimationMember) {
    const assembly = selected()?.assembly;
    if (!assembly) return;
    const key = memberKey(animationChoice, assembly.id);
    animationMembers.set(key, { ...animationMembers.get(key), [input.dataset.poseAnimationMember]: input.value });
    message = ""; stopAnimation(); cancelPreparation(""); syncPose(); return;
  }
  if (input.dataset.poseAnimationParam) {
    const name = input.dataset.poseAnimationParam, previous = animationParameters.get(animationChoice) ?? {};
    const value = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input instanceof HTMLInputElement && input.type === "number" ? Number(input.value) : input.value;
    if (typeof value === "number" && (!Number.isFinite(value) || input.value.trim() === "")) { message = "Enter a finite animation parameter."; renderPanel(); return; }
    animationParameters.set(animationChoice, { ...previous, [name]: value }); stopAnimation(); cancelPreparation(""); syncPose(); return;
  }
  const motionKey = input.dataset.poseMotion as keyof MotionDraft | undefined;
  if (motionKey && motionDraft) {
    motionDraft = { ...motionDraft, [motionKey]: input.value } as MotionDraft;
    // A choice that changes which fields show draws the panel again; a typed number waits for Run.
    if (motionKey === "wheel" || motionKey === "kind") renderPanel();
    return;
  }
  if (input.hasAttribute("data-pose-animation-frame") && animation) { animation.clock.seek(Number(input.value)); syncPose(); renderPanel(); return; }
  const couple = input.dataset.poseCouple as keyof CoupleDraft | undefined;
  if (couple) {
    // A new kind starts its numbers afresh: a ratio typed for one kind means something else in another.
    if (couple === "kind" && input.value === coupleDraft.kind) return;
    coupleDraft = couple === "kind" ? { ...EMPTY_DRAFT, driven: coupleDraft.driven, kind: input.value as CoupleKind } : { ...coupleDraft, [couple]: input.value, ...(couple === "free" ? { freeSet: "1" } : couple === "click" ? { clickSet: "1", manual: "" } : {}) } as CoupleDraft;
    // A choice that changes which fields the form shows draws it again; a typed number waits for Couple.
    if (couple === "kind" || couple === "click" || couple === "driven" || couple === "free") { coupleNote = null; renderPanel(); }
    return;
  }
  const loopKey = input.dataset.poseLoop;
  if (loopKey && loopDraft) {
    if (loopKey === "kind") { loopDraft = { ...loopDraft, kind: input.value === "line" ? "line" : "pin" }; renderPanel(); return; }
    const index = "xyz".indexOf(loopKey);
    if (index >= 0) {
      const typed: [string, string, string] = [...loopDraft.typed];
      typed[index] = input.value;
      loopDraft = { ...loopDraft, typed };
      renderPanel();
    }
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
    const next = trainTurn(row.assembly, row.member.object, value! - (old.travel ?? 0), turnOptions());
    if ("reason" in next) { message = next.reason; renderPanel(); return; }
    message = turnWords(next);
    editAssembly(next.assembly); return;
  }
  if (name === "angle" && old.kind === "hinge") {
    const next = trainTurn(row.assembly, row.member.object, value! - (old.angle ?? 0), turnOptions());
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
