/** Engine calls: the tree calls, the restore of a solid the engine dropped, and the held pieces. */
import { ROOT, pathTo, reserveId, type ModelOp, type ModelTree, type NodeId } from "../../model-tree";
import { applyRequest, isBrep, openRequest, probeRequest, wholeTreeRequest } from "../../model-request";
import { remapBlendFromNode } from "../../model-edge-step";
import { authHeaders } from "../../ui/api-base";
import { modelerFailure } from "../model-error";
import { modelTrees } from "../model-trees";
import { apiBase, apiToken } from "../settings";
import { session, state } from "../state";
import { resyncFonts } from "../user-fonts";
import { S } from "./shared";
import { failed } from "./apply";
import { stepFileName } from "./export";
import { forgetShown } from "./lifecycle";
import { modelTool, readout } from "./pick";
import {
  type Body,
  engineHeld,
  NAMES_TOPOLOGY,
  ROOT_BROKEN,
  type Seed,
  seedNotes,
  seeds,
  stepKnown,
  unopened,
} from "./shared";

/** A history longer than this many steps rebuilds a few steps per call, with a count in the readout. */
const COUNTED_REBUILD = 20;

/** Restores in flight, by tree key. */
const restoring = new Map<string, Promise<string | null>>();

/**
 * --- Held pieces cut again (polish after 4.2.0). The one cut under way for each split to print's held pieces, by
 * `<part key>#<step>`: a reopen starts it in the background, and an export, or any call on one of those pieces, waits for
 * it instead of starting a second. `warmStarts` counts the background jobs; `#model`'s `data-held-warm` and
 * `data-held-ready` say how many started and that the last one is done, for the tests.
 */
const pieceCuts = new Map<string, Promise<string | null>>();

let warmStarts = 0;

export function mm(value: number) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

export function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function isOp(value: unknown): value is ModelOp {
  return !!value && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string";
}

function missingOf(body: Body): NodeId[] | null {
  if (body.error !== "unknown" || !Array.isArray(body.missing)) return null;
  return body.missing.filter((id): id is number => typeof id === "number");
}

/**
 * One call on tree `key` that needs `node`. When the engine has forgotten the tree or the node (a
 * restarted engine), it gets the root and the ops again, and the call is asked once more. Calls that
 * find the same tree missing share one restore; a call whose node that restore did not bring back
 * runs one of its own.
 */
export async function treeCall(key: string, node: NodeId, request: Body): Promise<Body> {
  const problem = (unopened.has(key) ? await restoreShared(key, node) : null) ?? (await wholeTools(key, node, request));
  if (problem) return { error: problem };
  let body = await seededCall(key, node, request);
  // A join's tool tree the engine lacks (a restarted engine, or a tree opened from a project) opens, and the call goes again.
  // An assembly's STEP names every part as a piece, and each piece the engine lacks is one such round.
  const toolRounds = TOOL_ROUNDS + (Array.isArray(request.pieces) ? request.pieces.length : 0);
  for (let tools = 0, round = 0; round < 2; ) {
    const tool = missingToolOf(body);
    if (tool && tools < toolRounds) {
      tools += 1;
      const problem = await restoreTool(tool.key, tool.node);
      if (problem) return { error: problem };
      body = await seededCall(key, node, request);
      continue;
    }
    const missing = missingOf(body);
    if (!missing) return body;
    const running = round === 0 ? restoring.get(key) : undefined;
    round += 1;
    const restored: Promise<string | null> = running ?? restore(key, node, missing).finally(() => {
      if (restoring.get(key) === restored) restoring.delete(key);
    });
    if (!running) restoring.set(key, restored);
    const problem = await restored;
    if (problem) return { error: problem };
    body = await seededCall(key, node, request);
  }
  return missingOf(body) ? { error: GONE } : body;
}

/** Open tree `key` whole, toward `node`, sharing an open already on its way. */
export function restoreShared(key: string, node: NodeId): Promise<string | null> {
  const running = restoring.get(key);
  if (running) return running;
  // A held piece whose cut is already running for its siblings waits for that cut, then opens only if it still has to.
  const root = modelTrees.get(key)?.root;
  const cutting = root?.kind === "piece" ? pieceCuts.get(`${root.tree}#${root.node}`) : undefined;
  if (cutting) return cutting.then((problem) => (problem === STALE_CUT || (!problem && unopened.has(key)) ? (modelTrees.has(key) && unopened.has(key) ? restoreShared(key, node) : problem) : problem));
  // A cut that went stale under it is asked once more, from the step as it is now.
  const again = (problem: string | null) => (problem === STALE_CUT && modelTrees.has(key) && unopened.has(key) ? restore(key, node, [ROOT]) : problem);
  const restored: Promise<string | null> = restore(key, node, [ROOT]).then(again).finally(() => {
    if (restoring.get(key) === restored) restoring.delete(key);
  });
  restoring.set(key, restored);
  return restored;
}

/** How many tool trees one call may open again: one per tree in the deepest chain of joins anyone builds. */
const TOOL_ROUNDS = 8;

/**
 * A tree from a project that sits on its STEP-read step numbers that step 0 in the engine, so a join that names its root
 * would take the read solid instead. Every such tree a call on `node` of `key` can build from (by the joins on the way
 * to `node`, the join the call sends, and theirs in turn) opens whole first. A join naming any other step of it gets
 * `missingTool` and opens it then.
 */
async function wholeTools(key: string, node: NodeId, request: Body): Promise<string | null> {
  const joinsTo = (tree: ModelTree | undefined, at: NodeId) =>
    tree ? pathTo(tree, at).flatMap((id) => { const op = tree.nodes.get(id)?.op; return op?.kind === "join" ? [op.tool] : []; }) : [];
  // The op sent, and an edit's replayed ops, can each be a join.
  const ops = (body: Body) => [body.op, ...(Array.isArray(body.replay) ? (body.replay as { op?: unknown }[]).map((step) => step.op) : [])];
  // An edit across trees sends each tool tree's part too: its path, its op and its replay can name a tool as well.
  const parts = Array.isArray(request.tools) ? (request.tools as Body[]) : [];
  const sent = [request, ...parts].flatMap(ops);
  const queue = [
    ...joinsTo(modelTrees.get(key), node),
    ...parts.flatMap((part) => (typeof part.key === "string" && typeof part.parent === "number" ? joinsTo(modelTrees.get(part.key), part.parent) : [])),
    ...sent.flatMap((op) => (isOp(op) && op.kind === "join" ? [op.tool] : [])),
  ];
  const seen = new Set<string>();
  for (let tool = queue.pop(); tool !== undefined; tool = queue.pop()) {
    if (seen.has(`${tool.key}#${tool.node}`)) continue;
    seen.add(`${tool.key}#${tool.node}`);
    const seed = seeds.get(tool.key);
    const problem = seed && tool.node === ROOT ? await openWhole(tool.key, seed.node) : null;
    if (problem) return problem;
    queue.push(...joinsTo(modelTrees.get(tool.key), tool.node));
  }
  return null;
}

/**
 * A join's tool the engine does not hold: its tree comes back from its root and ops, as a tree after a restart does,
 * down to `node`. Calls that find it missing at once share one restore.
 */
function restoreTool(key: string, node: NodeId): Promise<string | null> {
  if (!modelTrees.get(key)?.nodes.has(node)) return Promise.resolve("The tool object's history is no longer open.");
  const running = restoring.get(key);
  if (running) return running;
  const seed = seeds.get(key);
  const restored: Promise<string | null> = (seed ? openWhole(key, seed.node) : restore(key, node, [ROOT])).finally(() => {
    if (restoring.get(key) === restored) restoring.delete(key);
  });
  restoring.set(key, restored);
  return restored;
}

export function missingToolOf(body: Body): { key: string; node: NodeId } | null {
  const tool = body.missingTool as { key?: unknown; node?: unknown } | undefined;
  return tool && typeof tool.key === "string" && typeof tool.node === "number" ? { key: tool.key, node: tool.node } : null;
}

/**
 * One call as the engine numbers the tree. While a seed is live, the plate's step is the engine's
 * root, and a step the engine was never given needs the whole tree first. While the whole tree is
 * on its way, a call waits for it: the engine runs it after the open, on the whole tree.
 */
async function seededCall(key: string, node: NodeId, request: Body): Promise<Body> {
  for (;;) {
    let seed = seeds.get(key);
    for (; seed?.whole || seed?.reading; seed = seeds.get(key)) await (seed.whole ?? seed.reading);
    // A step the engine holds takes calls and new steps on it; an earlier step, or an edit of one, needs the history.
    const named = request.call === "apply" && NAMES_TOPOLOGY.has(String((request.op as { kind?: unknown } | undefined)?.kind));
    if (seed && (!seed.held.has(node) || request.call === "edit" || named)) {
      const problem = await openWhole(key, node);
      if (problem) return { error: problem };
      continue;
    }
    if (!seed) {
      await countedReach(key, node);
      const body = await post(request);
      noteHeld(key, body);
      return body;
    }
    if (!seed.live) return post(request);
    const body = await post(engineNumbered(seed, request));
    // The engine does not run calls in the order they were sent: an open that started after this one
    // may have run first, and then its node 0 is the root. Such an answer is asked for again.
    if (seeds.get(key) !== seed || seed.whole || seed.reading || !seed.live) continue;
    if (request.call === "apply" && typeof request.node === "number" && !text(body.error)) seed.held.add(request.node);
    // `seeded`: the answer is about the STEP-read step.
    return { ...body, seeded: true, ...(body.id === ROOT ? { id: seed.node } : {}), ...(body.broken === ROOT ? { broken: seed.node } : {}) };
  }
}

/** `request` with the plate's step of a live seed as the engine's root. */
function engineNumbered(seed: Seed, request: Body): Body {
  const local = (id: unknown) => (id === seed.node ? ROOT : id);
  const asNode = (id: NodeId) => (id === seed.node ? ROOT : id);
  const numbered: Body = { ...request, node: local(request.node), ...("parent" in request ? { parent: local(request.parent) } : {}) };
  // --- A5. A blend's fromNode is a history step. The plate's step is the engine's root. ---
  if (isOp(numbered.op)) numbered.op = remapBlendFromNode(numbered.op, asNode);
  if (Array.isArray(numbered.replay)) {
    numbered.replay = numbered.replay.map((step) => {
      if (!step || typeof step !== "object") return step;
      const op = (step as { op?: unknown }).op;
      return isOp(op) ? { ...(step as object), op: remapBlendFromNode(op, asNode) } : step;
    });
  }
  return numbered;
}

/** Drop the branch from `node` in the engine, once it has one: a seeded tree's engine holds only the steps built on its seed. */
export async function dropInEngine(key: string, node: NodeId) {
  for (let seed = seeds.get(key); seed; seed = seeds.get(key)) {
    if (!seed.whole) {
      if (!seed.held.has(node) || node === seed.node) return;
      await post({ call: "drop", key, node });
      const tree = modelTrees.get(key);
      for (const id of [...seed.held]) if (id !== seed.node && !tree?.nodes.has(id)) seed.held.delete(id);
      return;
    }
    await seed.whole;
  }
  await post({ call: "drop", key, node });
}

/**
 * The tree's root STEP and every op to the engine, which builds each step when it is asked for.
 * `node` is the step wanted next; a step that no longer rebuilds is marked when it is asked again.
 * Calls on a seeded tree share one open. The solids and answers that came from the seed's STEP-read
 * solid go: the engine's steps are rebuilt from the root now, and their edges may be numbered apart.
 */
export function openWhole(key: string, node: NodeId): Promise<string | null> {
  const seed = seeds.get(key);
  if (seed?.whole) return seed.whole;
  const run = (async () => {
    if (seed?.reading) await seed.reading;
    const tree = modelTrees.get(key);
    if (!tree || tree.root.kind === "piece") return "This solid is no longer open.";
    // A step's own solid, saved in the binary format, stands in for the steps above it: the history builds from there.
    const solid = seedSolid(tree, node);
    // A short history opens at `node` in one call. With a seed, or a long history, it opens at its root, and the steps
    // still to build toward `node` are built a few per call when there are many (`countedReach`), so the readout can
    // count them and a minute of rebuilding is never a silent wait, even when the engine refuses the seed.
    const start = solid || pathTo(tree, node).length > COUNTED_REBUILD ? ROOT : node;
    // Quiet: the call that needed the tree asks for its step next, so the open meshes and sends nothing.
    let body = await post(wholeTreeRequest(tree, tree.root, start, state.stepTolerance, { seed: solid, quiet: true }));
    noteHeld(key, body);
    if (solid && typeof body.seedRefused === "string") {
      refusedSolids.add(solid.bytes);
      // Said with the step once it is shown, which can come after the rebuild's own count in the readout.
      seedNotes.set(key, `The saved solid did not open (${body.seedRefused}), so its history was rebuilt.`);
    }
    if (!text(body.error) && typeof body.broken !== "number") body = await countedReach(key, node);
    if (seed) seed.whole = null;
    if (!modelTrees.has(key)) return closeLate(key);
    // A primitive root that builds differently opens nothing: the whole tree is broken from its root.
    if (body.broken === ROOT) {
      failed(key, body);
      return ROOT_BROKEN;
    }
    const problem = typeof body.broken === "number" ? "" : text(body.error);
    if (problem) return problem;
    unopened.delete(key);
    if (seed) {
      forgetShown(key);
      // The older file's STEP was a read of the step; the step is rebuilt now, and the next save writes its solid exactly.
      const token = tree.nodes.get(seed.node)?.mesh?.token;
      if (token) stepKnown.delete(token);
    }
    seeds.delete(key);
    return null;
  })();
  if (seed) seed.whole = run;
  return run;
}

/** What a call says when the engine lost the tree again while it was being restored. */
const GONE = "The modeler no longer has this solid. Open Model again to reload it.";

/** The engine's refusal of a scale by 1, which it answers after building the step the probe names (`countedBuild`). */
const SCALE_BY_ONE = "Scale needs a factor other than 1";

/** Solids the engine refused as a seed (another modeler's, or not the step): the history is rebuilt instead. */
const refusedSolids = new WeakSet<ArrayBuffer>();

/**
 * The saved solid to open `node`'s history with: the nearest step on the way to `node` whose plate mesh carries its solid
 * in the binary format, else the plate's step's, which serves a later jump below it. Null when no step has one.
 */
function seedSolid(tree: ModelTree, node: NodeId): { node: NodeId; bytes: ArrayBuffer } | null {
  const usable = (id: NodeId) => {
    const bytes = id === ROOT ? undefined : tree.nodes.get(id)?.mesh?.step;
    return bytes && isBrep(bytes) && !refusedSolids.has(bytes) ? { node: id, bytes } : null;
  };
  for (const id of pathTo(tree, node).reverse()) {
    const found = usable(id);
    if (found) return found;
  }
  return usable(tree.committed);
}

export function noteHeld(key: string, body: Body) {
  if (Array.isArray(body.held)) engineHeld.set(key, new Set(body.held.filter((id): id is number => typeof id === "number")));
}

/**
 * Build `path` (from a step the engine holds down to the step wanted) a few steps per call, counting them in the
 * readout. Answers the step that broke, or an error, else nothing.
 */
async function countedBuild(key: string, path: readonly NodeId[]): Promise<Body> {
  const steps = path.length - 1;
  const stride = Math.max(1, Math.round(steps / 50));
  const shownHere = () => state.stage === "model" && S.open?.key === key;
  let body: Body = {};
  for (let at = stride; at <= steps && !text(body.error) && typeof body.broken !== "number"; at = at === steps ? steps + 1 : Math.min(steps, at + stride)) {
    if (!modelTrees.has(key)) break;
    if (shownHere()) readout(`Rebuilding the history: step ${at} of ${steps}…`);
    // A probe builds its step without meshing it; a scale by 1 asks nothing else of the kernel.
    let built = await post(probeRequest(key, path[at]!, { kind: "scale", factor: 1 }));
    // A join on the way whose tool tree the engine does not hold: that tree opens, and the step is asked again.
    for (let tools = 0, tool = missingToolOf(built); tool && tools < TOOL_ROUNDS; tools += 1, tool = missingToolOf(built)) {
      const problem = await restoreTool(tool.key, tool.node);
      if (problem) return { error: problem };
      built = await post(probeRequest(key, path[at]!, { kind: "scale", factor: 1 }));
    }
    body = typeof built.broken === "number" || text(built.error).includes("not open") ? built : {};
    // A probe's answer lists no solids. The scale by 1 is refused once its step is built, so that refusal (or a check that
    // passed) means the step is held now, and the call after this one counts from it; any other answer built nothing.
    if (built.ok === true || text(built.error) === SCALE_BY_ONE) engineHeld.get(key)?.add(path[at]!);
    else if (typeof built.broken !== "number") return { error: missingOf(built) ? GONE : text(built.error) || "The history could not be rebuilt." };
  }
  return body;
}

/**
 * Before a call on `node` of a whole tree: when the engine would replay more than `COUNTED_REBUILD` steps to reach it
 * (a jump far below a reopened project's plate step, or past solids it let go), they are built counted first.
 */
async function countedReach(key: string, node: NodeId): Promise<Body> {
  const held = engineHeld.get(key);
  const tree = modelTrees.get(key);
  if (!held || !tree?.nodes.has(node)) return {};
  const path = pathTo(tree, node);
  let from = path.length - 1;
  while (from > 0 && !held.has(path[from]!)) from -= 1;
  if (path.length - 1 - from <= COUNTED_REBUILD) return {};
  return countedBuild(key, path.slice(from));
}

/** An open that lands for a tree released or forgotten meanwhile: the engine lets it go too. */
function closeLate(key: string): string {
  void post({ call: "close", key });
  return "This solid is no longer open.";
}

async function restore(key: string, node: NodeId, missing: NodeId[]): Promise<string | null> {
  const tree = modelTrees.get(key);
  if (!tree) return "This solid is no longer open.";
  // --- Text milestone 4: a restarted engine has forgotten the fonts of the person's too; its text steps need them to build again.
  await resyncFonts();
  const chord = state.stepTolerance;
  const seed = seeds.get(key);
  if (seed?.whole) return seed.whole;
  // The plate's step opens from its own STEP, as fast as the file: at first, and again after an engine restart.
  const step = seed && node === seed.node ? tree.nodes.get(node)?.mesh : undefined;
  if (seed && step?.step) {
    if (state.stage === "model") readout("Reading the solid…");
    seed.live = false;
    let read = () => {};
    seed.reading = new Promise<void>((resolve) => (read = resolve));
    const body = await post(openRequest(key, { kind: "step", name: stepFileName(step.name), bytes: step.step }, chord)).finally(() => {
      seed.reading = null;
      read();
    });
    if (!modelTrees.has(key)) return closeLate(key);
    if (seeds.get(key) !== seed) return openWhole(key, node);
    if (!text(body.error)) {
      seed.live = true;
      return null;
    }
  }
  if (seed || missing.includes(ROOT)) {
    // `open` registers every saved node, so nothing else is missing.
    if (tree.root.kind !== "piece") return openWhole(key, node);
    const problem = await rebuildPiece(tree.root.tree, tree.root.node, key, tree.root.index, tree.root.pins === true);
    if (problem) return problem;
  }
  // A piece's tree comes back as its root only: its steps are applied again down to `node`. A split
  // among them goes without its `otherKey`, which would start that piece's tree over.
  for (const id of pathTo(tree, node).slice(1)) {
    const step = tree.nodes.get(id);
    if (!step?.op || step.parent === null) continue;
    const request = applyRequest(key, step.parent, id, step.op, chord);
    let body = await post(request);
    for (let tools = 0; missingToolOf(body) && tools < TOOL_ROUNDS; tools += 1) {
      const tool = missingToolOf(body)!;
      const problem = await restoreTool(tool.key, tool.node);
      if (problem) return problem;
      body = await post(request);
    }
    // A node the engine still has, made by a split with its piece's key, refuses a resend without it.
    if (text(body.error).includes("already in this tree")) continue;
    if (failed(key, body)) return text(body.error);
  }
  return null;
}

/**
 * The piece a split cut off comes back by running that split again on a spare node, which then goes. A split to print's
 * piece `index` comes back the same way, its key at its place and none for the others, whose trees stay as they are;
 * its pins, with `pins`, under their key alone.
 */
function rebuildPiece(parentKey: string, split: NodeId, pieceKey: string, index?: number, pins = false): Promise<string | null> {
  const id = `${parentKey}#${split}`;
  const running = pieceCuts.get(id);
  if (running) return running.then((problem) => (problem || !unopened.has(pieceKey) ? problem : rebuildPiece(parentKey, split, pieceKey, index, pins)));
  const job = cutPieceAgain(parentKey, split, pieceKey, index, pins).finally(() => {
    if (pieceCuts.get(id) === job) pieceCuts.delete(id);
  });
  pieceCuts.set(id, job);
  return job;
}

/** The sentence a cut gives back when its part changed while it ran, and its answer went nowhere. */
const STALE_CUT = "The part changed while its pieces were being cut again. Try again.";

async function cutPieceAgain(parentKey: string, split: NodeId, pieceKey: string, index?: number, pins = false): Promise<string | null> {
  const parent = modelTrees.get(parentKey);
  const splitNode = parent?.nodes.get(split);
  const epoch = session.docEpoch;
  if (!parent || !splitNode?.op || splitNode.parent === null) return "The part this piece was split from is no longer open.";
  const [reserved, spare] = reserveId(parent);
  modelTrees.set(parentKey, reserved);
  const partition = splitNode.op.kind === "partition";
  // A project's held pieces that no call has opened yet come back in the same cut: one cut, not one a piece.
  const waiting = (key: string | null | undefined): key is string => !!key && unopened.has(key) && modelTrees.get(key)?.root.kind === "piece";
  const keys = partition && !pins && index != null ? (splitNode.pieces ?? []).map((key, at) => (at === index - 2 ? pieceKey : waiting(key) ? key : null)) : partition && pins ? (splitNode.pieces ?? []).map((key) => (waiting(key) ? key : null)) : null;
  const pinsKey = partition ? (pins ? pieceKey : waiting(splitNode.pins) ? splitNode.pins : null) : null;
  const other = keys || pins ? null : pieceKey;
  const body = await treeCall(parentKey, splitNode.parent, applyRequest(parentKey, splitNode.parent, spare, splitNode.op, state.stepTolerance, other, keys && keys.some((key) => key) ? keys : undefined, pinsKey ?? null));
  await dropInEngine(parentKey, spare);
  const problem = text(body.error) || null;
  const made = [pieceKey, ...(keys ?? []), pinsKey].filter((key): key is string => !!key);
  // The answer belongs to the cut as it was asked: a new file, or an edit or an Update of that step meanwhile, leaves it
  // stale, and the trees it made go. A piece then stays unopened, and the next call cuts it from the step as it is now.
  const now = modelTrees.get(parentKey)?.nodes.get(split);
  const held = (key: string) => session.docEpoch === epoch && modelTrees.get(key)?.root.kind === "piece" && !!now && [...(now.pieces ?? []), now.pins, now.piece].includes(key);
  if (session.docEpoch !== epoch || now?.op !== splitNode.op || !made.every(held)) {
    // The engine's trees no tree here names any more go. A piece still held stays unopened: its next call cuts it again
    // and replaces what this cut left under its key.
    for (const key of made) if (!held(key)) void post({ call: "close", key });
    return STALE_CUT;
  }
  if (!problem) for (const key of made) unopened.delete(key);
  return problem;
}

/**
 * A project just opened with held pieces that have no solids: cut each such split to print's pieces again in the
 * background, one job a cut, so a STEP export usually finds them ready. Nothing waits for it; a call that needs the
 * solids first waits for the same job (`restoreShared`). A failure is left for that call to meet again.
 */
export function warmHeldPieces() {
  const epoch = session.docEpoch;
  const cuts = new Map<string, string>();
  for (const key of unopened) {
    const root = modelTrees.get(key)?.root;
    if (root?.kind !== "piece") continue;
    const id = `${root.tree}#${root.node}`;
    if (!cuts.has(id) && !pieceCuts.has(id)) cuts.set(id, key);
  }
  for (const key of cuts.values()) {
    if (session.docEpoch !== epoch || !unopened.has(key)) continue;
    warmStarts += 1;
    const view = document.querySelector("#model");
    view?.setAttribute("data-held-warm", String(warmStarts));
    void restoreShared(key, ROOT).then((problem) => {
      if (session.docEpoch === epoch) view?.setAttribute("data-held-ready", problem ? "failed" : String(warmStarts));
    });
  }
}

export async function post(payload: Body): Promise<Body> {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  try {
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      return JSON.parse(await invoke<string>("model_tree", { payload: JSON.stringify(payload) })) as Body;
    }
    const res = await fetch(`${apiBase()}/api/model/tree`, {
      method: "POST",
      headers: authHeaders(apiToken(), { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const body = await res.json() as Body;
    if (!res.ok && typeof body.error !== "string") {
      return { error: modelerFailure(body.error ?? body.message, modelTool()) };
    }
    return body;
  } catch (err) {
    const message = modelerFailure(err, modelTool());
    if (message === "Failed to fetch") {
      return { error: `Model measure needs the slicer engine at ${apiBase()}. Start it with cargo run -p lime-slice --release -- serve.` };
    }
    return { error: message };
  }
}
