/**
 * Opt-in live mirror. The desktop listens for `lime-bridge` only inside Tauri.
 * The headless MCP server does not import this file.
 */
import { bridgeDrifted, bridgeHasPlateUpdate, bridgeHistoryRelation, bridgeIsNew, bridgeHumanChanges, bridgeMerge, bridgeNextBaseline, bridgeOverrides, bridgeSavedRoot, bridgeSettings, bridgeShapeChanges, bridgeSwapLabel, decodeBridgeHistory, mirrorPlate, parkBridge, releaseBridge, type BridgeHold, type BridgeMessage, type BridgeReplaced, type BridgeSeen, type MirrorObject } from "../bridge.ts";
import type { Mat3 } from "../mesh-place.ts";
import { isIdentity } from "../model-space.ts";
import { bridgedObject, emptyPlate, mirroredPlate, pinPlateMeshes, setMeshSeat, snapPlate, type PlateObject } from "../plate.ts";
import { isTauri } from "../platform.ts";
import { fnv1aHex } from "../slice-action.ts";
import type { SavedTree } from "../model-tree-file.ts";
import { pushToast } from "../ui/toasts.ts";
import { place } from "./files.ts";
import { fx } from "./fx.ts";
import { captureEdit, newestEdits, onPlateTouched, pendingTouched, rebaseEdits, recordForeignStep, undoUserEdit } from "./history.ts";
import { mountBridgeLight } from "./bridge-light.ts";
import { loadModel, modelApi } from "./workspaces.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { markStale, renderChrome, settleTypedField } from "./settings.ts";
import { state, STEP_TOLERANCE_DEFAULT } from "./state.ts";

const waiting: BridgeMessage[] = [];
let seen: BridgeSeen = { session: "", seq: 0 };
let plateSeen: BridgeSeen = { session: "", seq: 0 };
/** Server objects on this plate. The mirror never removes an object outside this set. */
let owned = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let processing = false;
let lastMissing = "";
let baseline = new Map<string, MirrorObject<null>>();
/**
 * Mirrored parts a person changed here (an undo step changed them) since the version both sides last agreed on. Only
 * these count as the person's changes: a difference the window made by itself is put right by the next snapshot.
 */
const touched = new Set<string>();
/** Snapshots already reported as waiting, so the receipt says it once. */
const toldWaiting = new WeakSet<BridgeMessage>();
/** A mesh hash per buffer, so a big part is hashed once and not on every message. */
const hashes = new WeakMap<ArrayBuffer, string>();
let refreshHumanContext: (() => void) | undefined;
const activity = new Map<string, { tool: string; object?: string; timer: ReturnType<typeof setTimeout> }>();

function showActivity(): void {
  const element = document.querySelector<HTMLElement>("#tandemActivity");
  if (!element) return;
  const current = [...activity.values()].at(-1);
  element.hidden = !current;
  element.textContent = current ? `Assistant: ${current.tool.replaceAll("_", " ")}${current.object ? ` · ${current.object}` : ""}` : "";
}

function receiveActivity(value: NonNullable<BridgeMessage["activity"]>): void {
  if (typeof value.id !== "string" || value.id.length > 100) return;
  if (value.phase === "end") {
    const old = activity.get(value.id);
    if (old) clearTimeout(old.timer);
    activity.delete(value.id);
    showActivity();
  } else if (value.phase === "start" && typeof value.tool === "string" && !activity.has(value.id)) {
    if (activity.size >= 64) return;
    // Expire a lost end message. Names are text, never markup.
    const timer = setTimeout(() => { activity.delete(value.id); showActivity(); }, 120_000);
    activity.set(value.id, { tool: value.tool.slice(0, 80), ...(typeof value.object === "string" ? { object: value.object.slice(0, 120) } : {}), timer });
    setTimeout(() => { if (activity.has(value.id)) showActivity(); }, 250);
  }
}

function hashOf(bytes: ArrayBuffer): string {
  let hash = hashes.get(bytes);
  if (!hash) {
    hash = fnv1aHex(new Uint8Array(bytes));
    hashes.set(bytes, hash);
  }
  return hash;
}

/**
 * A number field a person typed into and has not committed yet. A snapshot waits for it, as it waits for a drag: re-rendering
 * the panel under it would commit the typed value to whatever part the snapshot selected (found 2026-11-09, where a
 * duplicate MCP had just selected took the person's half-typed X).
 */
let typing: HTMLElement | null = null;

/** Why a snapshot waits now: a gesture, or a typed value not yet committed. Empty when it can apply. */
function busyHere(): string {
  if (typing && !typing.isConnected) typing = null;
  return state.poseHud || (typing ? "typing" : "");
}

/**
 * Why the queued snapshots wait, as a receipt names it (`gesture`, `typing`, `model-edit`), or empty when they can apply.
 * A Model edit in progress holds back only a snapshot that changes that part's shape: a tool open on it, a step running.
 */
function waitReason(): "" | "gesture" | "typing" | "model-edit" {
  const busy = busyHere();
  if (busy) return busy === "typing" ? "typing" : "gesture";
  const editing = modelApi()?.modelEditingPart();
  if (!editing || waiting.length === 0) return "";
  const current = desktopRows();
  return waiting.some((message) => bridgeShapeChanges(current, message, seen, owned).includes(editing)) ? "model-edit" : "";
}

function watchTyping(): void {
  document.addEventListener("input", (ev) => {
    const target = ev.target;
    // Number fields set poses, sizes and settings; a search box left focused must not hold the mirror up.
    if (ev.isTrusted && target instanceof HTMLInputElement && target.type === "number") typing = target;
  }, true);
  const done = (ev: Event) => {
    if (ev.target !== typing) return;
    typing = null;
    // After the change lands on the part it was typed for: the app's own handlers run first.
    if (waiting.length) setTimeout(() => void flush(), 0);
  };
  document.addEventListener("change", done, true);
  document.addEventListener("focusout", done, true);
}

function applyMessage(message: BridgeMessage): void {
  waiting.splice(0, waiting.length, ...parkBridge(waiting, message));
  void flush();
}

type Outcome = "applied" | "diverged" | "conflict" | "missing" | "failed" | "stale" | "waiting";

/**
 * What the window did with a snapshot. `replaced` names the parts where MCP's version replaced the window's own (kept as
 * one undo step); `waiting` says it waits for the person (`reason`), and its outcome follows under the same number.
 */
function receipt(message: BridgeMessage, outcome: Outcome, extra: { held?: readonly BridgeHold[]; replaced?: readonly BridgeReplaced[]; reason?: string } = {}): void {
  if (!message.session || typeof message.seq !== "number" || !bridgeHasPlateUpdate(message)) return;
  const held = (extra.held ?? []).slice(0, 20).map((row) => ({ object: row.object, name: row.name, kind: row.kind }));
  const replaced = (extra.replaced ?? []).slice(0, 20).map((row) => ({ object: row.object, name: row.name, kind: row.kind }));
  const args = { session: message.session, seq: message.seq, outcome, ...(held.length ? { held } : {}), ...(replaced.length ? { replaced } : {}), ...(extra.reason ? { reason: extra.reason } : {}) };
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke("bridge_receipt", args)).catch(() => {});
}

async function flush(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
  // Load before taking messages out of the queue: the document or a gesture can change while loading.
  if (waiting.some((message) => message.modelHistories && bridgeHasPlateUpdate(message))) await loadModel();
  const reason = waitReason();
  const released = releaseBridge(waiting, reason);
  waiting.splice(0, waiting.length, ...released.waiting);
  // Tell MCP once that its change waits for the person, so its reply can say so rather than "pending".
  for (const message of waiting) {
    if (toldWaiting.has(message) || !reason) continue;
    toldWaiting.add(message);
    receipt(message, "waiting", { reason });
  }
  for (const message of released.ready) {
    try {
      apply(message);
    } catch (err) {
      receipt(message, "failed");
      // A mirror never stops the window. Say what went wrong, so it is not a silent empty plate.
      pushToast(`The MCP mirror could not be shown: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }
  if (waiting.length > 0 && timer === undefined) {
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 200);
  }
  } catch (err) {
    for (const message of waiting.splice(0)) receipt(message, "failed");
    pushToast(`The MCP mirror could not load Model: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    processing = false;
    if (waiting.length && !waitReason() && timer === undefined) void flush();
  }
}

/** The desktop plate as the mirror compares it. */
function desktopRows(): MirrorObject<PlateObject>[] {
  return state.plate.objects.map((obj) => ({
    id: obj.id,
    name: obj.name,
    scalePercent: obj.partScale * 100,
    centered: obj.centered,
    offset: { ...obj.offset },
    orient: [...obj.orient] as Mat3,
    meshHash: hashOf(obj.bytes),
    extra: obj,
  }));
}

/** Parts a person changed: the recorded steps and the gesture still open. */
function humanTouched(): Set<string> {
  const ids = new Set(touched);
  for (const id of pendingTouched()) ids.add(id);
  return ids;
}

/**
 * Whether the window's history for `id` is MCP's incoming one or an ancestor of it (a fast-forward: nothing of the
 * window's is lost). Null when either is unknown, as when MCP sent no history for the part.
 */
function historyBehind(message: BridgeMessage, id: string): boolean | null {
  const saved = message.modelHistories?.[id]?.tree;
  const here = modelApi()?.bridgeHistoryOf(id) ?? null;
  if (!saved || !here) return null;
  const relation = bridgeHistoryRelation(here, { root: bridgeSavedRoot(saved), nodes: saved.nodes, committed: saved.committed });
  return relation === null ? null : relation !== "diverged";
}

/** What the person sees after a swap: what MCP did, what of theirs it replaced, and Undo right there. */
function sayReplaced(label: string, replaced: readonly BridgeReplaced[]): void {
  const step = newestEdits().undo;
  const mine = replaced.filter((row) => row.kind !== "model-history").map((row) => row.name);
  const history = replaced.filter((row) => row.kind === "model-history").map((row) => row.name);
  const said = [
    mine.length ? `It replaced your changes to ${mine.join(", ")}.` : "",
    history.length ? `It replaced the window's own Model history of ${history.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  pushToast(`${label}.${said ? ` ${said}` : ""} Undo puts the window's version back.`, "info", {
    label: "Undo",
    run: () => {
      // Only while that step is still the newest: an Undo button must never take back a later edit of the person's.
      if (newestEdits().undo !== step) return;
      undoUserEdit();
      modelApi()?.followSelection();
    },
  });
}

/** Forget a person's change once the desktop and the shared version agree on that part again. */
function pruneTouched(current: readonly MirrorObject<PlateObject>[]): void {
  const here = new Map(current.map((row) => [row.id, row]));
  for (const id of touched) {
    const before = baseline.get(id);
    const now = here.get(id);
    if (!before || (now && samePose(now, { ...before, extra: now.extra }) && now.meshHash === before.meshHash)) touched.delete(id);
  }
}

function apply(message: BridgeMessage): void {
  const settings = bridgeSettings(message);
  if (settings) assignSettings(settings);
  // A focused Place field's text is the person's, for the part selected now: it lands there before the snapshot, and is
  // not stored again by the rebuild after it, on the part the snapshot selects or over the pose it sets (bug A, 2026-11-09).
  if (bridgeHasPlateUpdate(message) && bridgeIsNew(seen, message)) settleTypedField();
  // The selected object's live pose is the plate's before the mirror compares against it.
  syncPlateFromState();
  const current = desktopRows();
  const human = humanTouched();
  // MCP's version of every part applies (wave 8: live, every time, never held back). What it overwrites here, a Model
  // history or the person's own edits, becomes one named undo step, and the receipt names what was the person's.
  const { swaps, replaced } = bridgeOverrides(current, message, seen, baseline, owned, { hasModel: (row) => !!row.extra?.modelTree, touched: human, historyBehind: (id) => historyBehind(message, id) });
  const merged = bridgeMerge(current, message, seen, baseline, [], human);
  const result = mirrorPlate(current, merged.message, seen, owned);
  if (result.missing) {
    // Say it once per gap. Telling the listener this window is new makes the server send every mesh again.
    if (lastMissing !== `${message.session}:${message.seq}`) pushToast(result.missing, "info");
    lastMissing = `${message.session}:${message.seq}`;
    void announce();
    receipt(message, "missing");
    return;
  }
  const accept = () => {
    if (result.applied && (message.session ?? "") !== seen.session) {
      // A new server process numbers its objects again: nothing it sends is a part a person changed.
      touched.clear();
    }
    seen = result.seen;
    owned = result.owned;
    if (result.applied && bridgeHasPlateUpdate(message)) {
      baseline = bridgeNextBaseline(message, baseline, []);
      plateSeen = result.seen;
      // A swapped part is MCP's now; the person's change to it lives on as the undo step.
      for (const id of swaps) touched.delete(id);
      pruneTouched(desktopRows());
    }
    if (result.applied) refreshHumanContext?.();
    receipt(message, !result.applied ? "stale" : merged.diverged ? "diverged" : "applied", { replaced: result.applied ? replaced : [] });
  };
  // The window as it stands, for the undo step a swap makes: taken before anything below changes it.
  const before = result.applied && swaps.length ? captureEdit() : null;
  const plateChanged = result.plate.length !== current.length || result.plate.some((obj, at) => obj.mesh || obj.extra !== current[at]?.extra || !samePose(obj, current[at]));
  if (!plateChanged) {
    if (settings) {
      markStale();
      renderChrome();
    }
    accept();
    return;
  }
  const objects = result.plate.map(toPlateObject);
  // A history comes with a new part and with every new shape of a part: MCP's shape and MCP's history together, over the
  // window's own (kept by the undo step below). A pose-only change keeps the window's history.
  const incomingTrees = new Map<string, SavedTree<{ name: string; bytes: ArrayBuffer }>>();
  for (const object of objects) {
    const prior = current.find((row) => row.id === object.id);
    const row = result.plate.find((item) => item.id === object.id);
    if (prior && !row?.mesh) continue;
    const saved = message.modelHistories?.[object.id];
    const decoded = saved && decodeBridgeHistory(saved);
    if (!decoded) {
      if (saved) pushToast(`Tandem showed ${object.name} as a mesh; its linked or unreadable Model history was not imported.`, "info");
      continue;
    }
    incomingTrees.set(object.id, decoded.tree);
    if (decoded.brep) object.brep = decoded.brep;
  }
  if (objects.length === 0) {
    state.plate = emptyPlate();
    state.mesh = null;
    state.sourcePos = null;
  } else {
    state.plate = mirroredPlate(objects, result.selectId ?? state.plate.selectedId);
    if (incomingTrees.size && modelApi()) modelApi()!.adoptSavedTrees(incomingTrees);
    applySelectedToState(state.plate);
  }
  let label = "";
  if (before) {
    // One named step, before the trees are released, so the window's own trees stay reachable from it.
    const names = swaps.map((id) => result.plate.find((row) => row.id === id)?.name ?? current.find((row) => row.id === id)?.name ?? id);
    label = bridgeSwapLabel(message, names);
    recordForeignStep(before, label);
    // In Model on a swapped part, Model's Undo takes this step too, back to the window's tree.
    const open = state.plate.selectedId;
    if (open && swaps.includes(open) && state.plate.objects.some((obj) => obj.id === open && obj.modelTree)) modelApi()?.noteBridgeSwap(open);
  }
  modelApi()?.releaseModelTrees();
  place("load");
  markStale();
  // A fresh window opens on Preview, and a changed plate makes any preview stale: show the plate. Model stays put.
  if (objects.length > 0 && state.stage !== "model" && state.stage !== "prepare") fx.setStage("prepare");
  modelApi()?.followSelection();
  keepWrittenPoses(result.plate, result.owned);
  rebaseOnto(current, new Set(swaps));
  renderChrome();
  accept();
  if (label) sayReplaced(label, replaced);
}

/**
 * What this snapshot changed in the window is MCP's, not a step of the person's: their Undo history takes it as given, so
 * Undo takes back only their own edits and never MCP's parts or moves. The parts in `swapped` are the exception: the
 * snapshot's own undo step puts the window's version of them back, so no step takes MCP's version of them as given.
 */
function rebaseOnto(before: readonly MirrorObject<PlateObject>[], swapped: ReadonlySet<string> = new Set()): void {
  const was = new Map(before.map((row) => [row.id, row]));
  const now = desktopRows();
  const ids = new Set(now.filter((row) => {
    const old = was.get(row.id);
    return !swapped.has(row.id) && (!old || old.meshHash !== row.meshHash || !samePose(row, old));
  }).map((row) => row.id));
  const removed = new Set(before.filter((row) => !swapped.has(row.id) && !now.some((item) => item.id === row.id)).map((row) => row.id));
  if (ids.size === 0 && removed.size === 0) return;
  const plate = { ...state.plate, objects: state.plate.objects.filter((obj) => ids.has(obj.id)) };
  const pins = new Map(pinPlateMeshes(plate).map((pin) => [pin.id, pin]));
  rebaseEdits(new Map(snapPlate(plate).objects.map((row) => [row.id, { row, pin: pins.get(row.id)! }])), removed);
}

/**
 * The mirror wrote these poses; nothing the window runs after it may turn or move a mirrored part by itself. A part that
 * moved anyway is put back, so the person never sees a pose neither side chose and it is never reported as theirs.
 */
function keepWrittenPoses(written: readonly MirrorObject<PlateObject>[], mirrored: ReadonlySet<string>): void {
  syncPlateFromState();
  const drifted = new Set(bridgeDrifted(written, desktopRows(), mirrored));
  if (drifted.size === 0) return;
  const wanted = new Map(written.map((row) => [row.id, row]));
  console.warn(`Tandem: the window moved ${[...drifted].join(", ")} while showing an MCP snapshot; the snapshot's pose was put back.`);
  state.plate = { ...state.plate, objects: state.plate.objects.map((obj) => {
    const row = drifted.has(obj.id) ? wanted.get(obj.id) : undefined;
    return row ? { ...obj, name: row.name, orient: [...row.orient] as Mat3, partScale: row.scalePercent / 100, centered: row.centered, offset: { ...row.offset } } : obj;
  }) };
  applySelectedToState(state.plate);
  place("load");
}

function samePose(next: MirrorObject<PlateObject>, before: MirrorObject<PlateObject> | undefined): boolean {
  if (!before || before.id !== next.id || before.name !== next.name) return false;
  if (before.scalePercent !== next.scalePercent || before.centered !== next.centered) return false;
  if (before.offset.x !== next.offset.x || before.offset.y !== next.offset.y || before.offset.z !== next.offset.z) return false;
  return before.orient.every((value, at) => value === next.orient[at]);
}

/** A mirrored row as the desktop's plate object. A new mesh drops the desktop's own solid and Model history for it. */
function toPlateObject(row: MirrorObject<PlateObject>): PlateObject {
  const pose = {
    name: row.name,
    orient: [...row.orient] as Mat3,
    partScale: row.scalePercent / 100,
    centered: row.centered,
    offset: { ...row.offset },
  };
  // `mirrorPlate` sends a mesh with every row the desktop did not have, so a row without one has `extra`.
  if (!row.mesh) return { ...row.extra!, ...pose };
  const bytes = row.mesh.bytes.buffer.slice(row.mesh.bytes.byteOffset, row.mesh.bytes.byteOffset + row.mesh.bytes.byteLength) as ArrayBuffer;
  hashes.set(bytes, row.meshHash);
  if (row.mesh.seatMm !== undefined) setMeshSeat(bytes, row.mesh.seatMm);
  const incoming = {
    name: row.name,
    fileName: row.mesh.fileName,
    bytes,
    sourcePos: row.mesh.source,
    stepTolerance: row.extra?.stepTolerance ?? STEP_TOLERANCE_DEFAULT,
  };
  if (!row.extra) return withModelPlace({ ...bridgedObject(row.id, row.name, incoming), ...pose }, row);
  const next: PlateObject = { ...row.extra, ...pose, fileName: incoming.fileName, bytes, sourcePos: incoming.sourcePos };
  delete next.brep;
  delete next.modelTree;
  delete next.workplane;
  return withModelPlace(next, row);
}

/**
 * Where a part with a new mesh stands in Model's shared space: the server's place for it when the server sent one,
 * else the place the window has. A new shape of a part is the same part in the same assembly, so its place is never
 * dropped: without it the part reads as standing at the origin (`modelPoseOf`), and in Pose and the assembled view an
 * edited part fell out of its assembly while the others stayed. The plate does not read this pose.
 */
function withModelPlace(object: PlateObject, row: MirrorObject<PlateObject>): PlateObject {
  if (!row.model) return object;
  const next = { ...object };
  if (isIdentity(row.model.pose)) delete next.modelPose;
  else next.modelPose = row.model.pose;
  if (row.model.frame === "part") next.frame = "part";
  else delete next.frame;
  return next;
}

function assignSettings(settings: NonNullable<ReturnType<typeof bridgeSettings>>): void {
  if (typeof settings.layerHeight === "number") state.layerHeight = settings.layerHeight;
  if (typeof settings.supports === "boolean") state.supports = settings.supports;
  if (settings.blendKind === "single" || settings.blendKind === "weight" || settings.blendKind === "byLayer" || settings.blendKind === "byRegion") state.blendKind = settings.blendKind;
  if (settings.strategy === "speed" || settings.strategy === "toughness") state.strategy = settings.strategy;
  if (typeof settings.toughness === "number") state.toughness = settings.toughness;
}

/** Tell the listener this page is new, so the server's next message carries every mesh. */
async function announce(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("bridge_ready");
    refreshHumanContext?.();
  } catch {
    // The bridge is off, or this build has no listener: nothing to announce.
  }
}

/** Drop the mirrored plate so a new document does not keep the previous MCP session. */
export function resetBridgeMirror(): void {
  waiting.splice(0, waiting.length);
  seen = { session: "", seq: 0 };
  plateSeen = { session: "", seq: 0 };
  owned = new Set();
  lastMissing = "";
  baseline.clear();
  touched.clear();
  for (const item of activity.values()) clearTimeout(item.timer);
  activity.clear();
  showActivity();
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  void announce();
}

export function mountBridge(): void {
  if (!isTauri()) return;
  let contextTimer: ReturnType<typeof setTimeout> | undefined;
  let lastContext = "";
  const publishContext = () => {
    if (contextTimer !== undefined) clearTimeout(contextTimer);
    contextTimer = setTimeout(() => {
      syncPlateFromState();
      const selected = state.plate.objects.find((item) => item.id === state.plate.selectedId);
      const focused = document.activeElement;
      const rows = desktopRows().filter((row) => baseline.has(row.id));
      const human = humanTouched();
      // Only a person's changes are theirs to report; a pose the window drifted to by itself is not.
      const changes = bridgeHumanChanges(rows, baseline, human);
      // Nothing is held back any more: MCP's version always applies, and the window's is an undo step (wave 8).
      const context = { stage: state.stage, selected: selected?.name ?? null, gesture: !!state.poseHud, editing: focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || (focused instanceof HTMLElement && focused.isContentEditable), conflict: null, conflicts: [], mirrorSession: plateSeen.session || null, mirrorSeq: plateSeen.session ? plateSeen.seq : null, humanChanges: changes.slice(0, 20), humanChangesTruncated: changes.length > 20 };
      const encoded = JSON.stringify(context);
      if (encoded === lastContext) return;
      lastContext = encoded;
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("bridge_human_context", { context })).catch(() => { lastContext = ""; });
    }, 50);
  };
  refreshHumanContext = () => { lastContext = ""; publishContext(); };
  onPlateTouched((ids) => {
    for (const id of ids) touched.add(id);
    publishContext();
  });
  for (const event of ["pointerdown", "pointerup", "click", "focusin", "focusout", "change"]) document.addEventListener(event, publishContext);
  watchTyping();
  publishContext();
  mountBridgeLight();
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<BridgeMessage>("lime-bridge", (event) => {
      if (event.payload.activity) { receiveActivity(event.payload.activity); return; }
      applyMessage(event.payload);
    });
  });
  void announce();
}
