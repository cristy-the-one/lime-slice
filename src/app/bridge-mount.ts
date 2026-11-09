/**
 * Opt-in live mirror. The desktop listens for `lime-bridge` only inside Tauri.
 * The headless MCP server does not import this file.
 */
import { bridgeDrifted, bridgeHasPlateUpdate, bridgeHolds, bridgeIsNew, bridgeHumanChanges, bridgeMerge, bridgeNextBaseline, bridgeServerBaseline, bridgeSettings, decodeBridgeHistory, mirrorPlate, parkBridge, releaseBridge, type BridgeHold, type BridgeMessage, type BridgeSeen, type MirrorObject } from "../bridge.ts";
import type { Mat3 } from "../mesh-place.ts";
import { bridgedObject, emptyPlate, mirroredPlate, pinPlateMeshes, setMeshSeat, snapPlate, type PlateObject } from "../plate.ts";
import { isTauri } from "../platform.ts";
import { fnv1aHex } from "../slice-action.ts";
import type { SavedTree } from "../model-tree-file.ts";
import { pushToast } from "../ui/toasts.ts";
import { place } from "./files.ts";
import { fx } from "./fx.ts";
import { onPlateTouched, pendingTouched, rebaseEdits } from "./history.ts";
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
/** Parts held back from MCP's snapshots, each with MCP's latest version of it (null: MCP removed it). */
let holds: BridgeHold[] = [];
const heldRemote = new Map<string, MirrorObject<null> | null>();
let lastHeld = "";
/**
 * Mirrored parts a person changed here (an undo step changed them) since the version both sides last agreed on. Only
 * these count as the person's changes: a difference the window made by itself is put right by the next snapshot.
 */
const touched = new Set<string>();
/** Parts whose Model history came from MCP with this mesh, untouched here: MCP's next commit may replace them. */
const adopted = new Map<string, string>();
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

type Outcome = "applied" | "diverged" | "conflict" | "missing" | "failed" | "stale";

/** What the window did with a snapshot. A conflict names each part held back; everything else in it applied. */
function receipt(message: BridgeMessage, outcome: Outcome, held: readonly BridgeHold[] = []): void {
  if (!message.session || typeof message.seq !== "number" || !bridgeHasPlateUpdate(message)) return;
  const parts = held.slice(0, 20).map((row) => ({ object: row.object, name: row.name, kind: row.kind }));
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke("bridge_receipt", { session: message.session, seq: message.seq, outcome, ...(parts.length ? { held: parts } : {}) })).catch(() => {});
}

async function flush(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
  // Load before taking messages out of the queue: the document or a gesture can change while loading.
  if (waiting.some((message) => message.modelHistories && bridgeHasPlateUpdate(message))) await loadModel();
  const released = releaseBridge(waiting, busyHere());
  waiting.splice(0, waiting.length, ...released.waiting);
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
    if (waiting.length && !busyHere() && timer === undefined) void flush();
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
 * The window keeps a Model history MCP must not discard: one a person made or changed here, or one open in Model now.
 * A history MCP sent with this very mesh and nobody touched since is MCP's own, and its next commit replaces it.
 */
function holdsModel(row: MirrorObject<PlateObject>, human: ReadonlySet<string>): boolean {
  if (!row.extra?.modelTree) return false;
  const open = state.stage === "model" && state.plate.selectedId === row.id;
  return open || human.has(row.id) || adopted.get(row.id) !== row.meshHash;
}

/** Remember what is held back and MCP's version of each, and tell the person once per new set. */
function holdBack(found: readonly BridgeHold[], message: BridgeMessage): void {
  holds = [...found];
  heldRemote.clear();
  const remote = bridgeServerBaseline(message);
  for (const hold of found) heldRemote.set(hold.object, remote.get(hold.object) ?? null);
  const names = found.map((hold) => hold.name).join(", ");
  if (names && names !== lastHeld) pushToast(found.length === 1 ? `Tandem: ${found[0]!.reason}` : `Tandem held back MCP's updates to ${names}; the rest of the plate updated. Undo your change to a part here to take MCP's version of it.`, "error");
  lastHeld = names;
}

/** The holds that still stand against the desktop as it is now: undoing here, or matching MCP's version, clears one. */
function standingHolds(current: readonly MirrorObject<PlateObject>[], human: ReadonlySet<string>): BridgeHold[] {
  if (holds.length === 0) return [];
  const ids = new Set(holds.map((hold) => hold.object));
  const plate = [...heldRemote].flatMap(([id, row]) => (row ? [{ object: id, name: row.name, scalePercent: row.scalePercent, centered: row.centered, offset: row.offset, orient: row.orient, meshHash: row.meshHash }] : []));
  const probe: BridgeMessage = { tool: "plate_sync", session: plateSeen.session, seq: plateSeen.seq + 1, ok: true, plate };
  const shared = new Map([...baseline].filter(([id]) => ids.has(id)));
  return bridgeHolds(current.filter((row) => ids.has(row.id)), probe, plateSeen, shared, ids, { protectedModel: (row) => holdsModel(row, human), touched: human });
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
  // Only the parts in conflict wait; a new part, or a change to any other part, applies.
  const found = bridgeHolds(current, message, seen, baseline, owned, { protectedModel: (row) => holdsModel(row, human), touched: human });
  const merged = bridgeMerge(current, message, seen, baseline, found, human);
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
      // A new server process numbers its objects again: nothing it sends is a part a person changed or MCP's history.
      touched.clear();
      adopted.clear();
    }
    seen = result.seen;
    owned = result.owned;
    if (result.applied && bridgeHasPlateUpdate(message)) {
      baseline = bridgeNextBaseline(message, baseline, found);
      plateSeen = result.seen;
      holdBack(found, message);
      pruneTouched(desktopRows());
    }
    if (result.applied) refreshHumanContext?.();
    receipt(message, !result.applied ? "stale" : found.length ? "conflict" : merged.diverged ? "diverged" : "applied", found);
  };
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
  // A history comes with a new part, with a part the window showed as a mesh, or with MCP's next commit of a history it
  // sent before. A history a person made or changed here is never replaced: that part was held above.
  const incomingTrees = new Map<string, SavedTree<{ name: string; bytes: ArrayBuffer }>>();
  for (const object of objects) {
    const prior = current.find((row) => row.id === object.id);
    const row = result.plate.find((item) => item.id === object.id);
    if (prior && !row?.mesh) continue;
    if (prior?.extra?.modelTree && holdsModel(prior, human)) continue;
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
    if (incomingTrees.size && modelApi()) {
      modelApi()!.adoptSavedTrees(incomingTrees);
      for (const id of incomingTrees.keys()) {
        const row = result.plate.find((item) => item.id === id);
        if (row) adopted.set(id, row.meshHash);
      }
    }
    applySelectedToState(state.plate);
  }
  modelApi()?.releaseModelTrees();
  place("load");
  markStale();
  // A fresh window opens on Preview, and a changed plate makes any preview stale: show the plate. Model stays put.
  if (objects.length > 0 && state.stage !== "model" && state.stage !== "prepare") fx.setStage("prepare");
  modelApi()?.followSelection();
  keepWrittenPoses(result.plate, result.owned);
  rebaseOnto(current);
  renderChrome();
  accept();
}

/**
 * What this snapshot changed in the window is MCP's, not a step of the person's: their Undo history takes it as given, so
 * Undo takes back only their own edits (a held part's move, say) and never MCP's parts or moves.
 */
function rebaseOnto(before: readonly MirrorObject<PlateObject>[]): void {
  const was = new Map(before.map((row) => [row.id, row]));
  const now = desktopRows();
  const ids = new Set(now.filter((row) => {
    const old = was.get(row.id);
    return !old || old.meshHash !== row.meshHash || !samePose(row, old);
  }).map((row) => row.id));
  const removed = new Set(before.filter((row) => !now.some((item) => item.id === row.id)).map((row) => row.id));
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
  if (!row.extra) return { ...bridgedObject(row.id, row.name, incoming), ...pose };
  const next: PlateObject = { ...row.extra, ...pose, fileName: incoming.fileName, bytes, sourcePos: incoming.sourcePos };
  delete next.brep;
  delete next.modelTree;
  delete next.modelPose;
  delete next.frame;
  delete next.workplane;
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
  holds = [];
  heldRemote.clear();
  lastHeld = "";
  touched.clear();
  adopted.clear();
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
      const standing = standingHolds(rows, human);
      const conflicts = standing.slice(0, 8).map(({ object, name, kind, reason }) => ({ object, name, kind, reason }));
      const context = { stage: state.stage, selected: selected?.name ?? null, gesture: !!state.poseHud, editing: focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || (focused instanceof HTMLElement && focused.isContentEditable), conflict: standing[0]?.name ?? null, conflicts, mirrorSession: plateSeen.session || null, mirrorSeq: plateSeen.session ? plateSeen.seq : null, humanChanges: changes.slice(0, 20), humanChangesTruncated: changes.length > 20 };
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
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<BridgeMessage>("lime-bridge", (event) => {
      if (event.payload.activity) { receiveActivity(event.payload.activity); return; }
      applyMessage(event.payload);
    });
  });
  void announce();
}
