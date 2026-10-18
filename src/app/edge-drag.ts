/**
 * P2. Idle edge drag: hover an edge, drag the knob for a fillet, hold Alt for a chamfer.
 * While the pointer moves only the blend ghost is drawn. The kernel is asked once the pointer
 * has been still, and `maxMm` clamps the radius. Release applies. Tab, for a few seconds, reopens
 * the drag as an edit of that step. The fillet and chamfer panels are unchanged.
 */

import { mountHud, type HudMount, type Params } from "../interact/hud";
import {
  blendRadius,
  edgeAppliedNote,
  edgeDragEdges,
  edgeDragKind,
  edgeDragNote,
  edgeDragOp,
  edgeDragRefusal,
  edgeFrame,
  edgeHoverHint,
  EDGE_KNOB_ID,
  EDGE_MIN_MM,
  EDGE_STEP_MM,
  knobAt,
  tabStillOpen,
  type BlendKind,
} from "../interact";
import { GHOST_PROBE_WAIT_MS } from "../interact/ghosts";
import type { EdgeKnobEvent, ModelGhost, ModelSolid, ModelView } from "../model-view";
import { applyPose, isIdentity, turnDir, type Affine } from "../model-space";
import type { Vec3 } from "../model-drag";
import type { ModelOp } from "../model-tree";

export interface EdgeSolid {
  positions: ArrayLike<number>;
  triangles: ArrayLike<number>;
  edges: { id: number; points: ArrayLike<number> }[];
}

export interface EdgeProbe {
  ok: boolean;
  error: string;
  maxMm: number | null;
  shape: ModelSolid | null;
}

export interface EdgeDragHost {
  stage(): string;
  /** No other tool is using the view, and the solid can be edited. */
  armed(): boolean;
  solid(): EdgeSolid | null;
  pose(): Affine;
  /** Centre of the solid, in its own frame. */
  center(): Vec3;
  selectedEdges(): number[];
  highlight(edges: readonly number[]): void;
  restoreHighlight(): void;
  readout(message: string): void;
  about(): string;
  probe(op: ModelOp): Promise<EdgeProbe>;
  /** Apply a new step. The id of the step that landed, or null when it did not. */
  apply(op: ModelOp): Promise<number | null>;
  /** Show the step's parent and hold an edit of `node`. */
  beginEdit(node: number, op: ModelOp): Promise<boolean>;
  commitEdit(op: ModelOp): Promise<number | null>;
  abortEdit(): void;
  editing(): boolean;
  /** The stored blend's edges, as they are on the solid now showing. */
  matchedEdges(op: ModelOp): number[];
  nodeOp(node: number): ModelOp | null;
  view(): ModelView | null;
  canvas(): HTMLCanvasElement | null;
  setGhost(ghost: Extract<ModelGhost, { kind: "blend" }> | null): void;
  setPreview(shape: ModelSolid | null): void;
  ray(x: number, y: number): { origin: Vec3; direction: Vec3 };
  params(): Params;
}

interface Target {
  edge: number;
  edges: number[];
  point: Vec3;
  dir: Vec3;
}

interface Session {
  kind: BlendKind;
  edges: number[];
  point: Vec3;
  dir: Vec3;
  size: number;
  original: number;
  maxMm: number | null;
  dragging: boolean;
  typing: boolean;
  proved: string | null;
  editing: boolean;
}

/** Wire the idle edge knob. `sync` when the open tool or the solid changes; `picksChanged` after a click. */
export function mountEdgeDrag(host: EdgeDragHost): { sync(): void; picksChanged(): void; holding(): boolean } {
  let live: Session | null = null;
  let shown: Target | null = null;
  let hoverEdge: number | null = null;
  let hinting = false;
  let lastAt: { x: number; y: number } | null = null;
  let tab: { at: number; node: number } | null = null;
  let hud: HudMount | null = null;
  let bound = false;
  let probeGen = 0;
  let timer = 0;
  let committing = false;

  function bind() {
    const view = host.view();
    if (!view || bound) return;
    bound = true;
    ensureHud();
    view.onEdgeHover(onHover);
    view.onEdgeKnob(onKnob);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
  }

  function ensureHud(): HudMount | null {
    if (hud) return hud;
    const parent = host.canvas()?.parentElement;
    if (!parent) return null;
    hud = mountHud(parent);
    hud.onCommit((commit) => {
      if (!live) return;
      const size = commit.values[0];
      live.typing = false;
      live.dragging = false;
      if (size != null && Number.isFinite(size)) live.size = Math.max(0, size);
      live.proved = null;
      void commitSession();
    });
    hud.onCancel(() => cancel(!!live?.editing));
    hud.onEdit((values) => {
      if (!live) return;
      const size = values[0];
      if (size == null || !Number.isFinite(size)) return;
      live.typing = true;
      live.size = Math.max(0, size);
      live.proved = null;
      paint();
      host.readout(edgeDragNote(live.kind, live.size, live.maxMm));
      if (live.size >= EDGE_MIN_MM) scheduleProbe();
      else holdProbe();
    });
    return hud;
  }

  function parentPoint(at: { x: number; y: number }): { x: number; y: number } {
    const frame = host.canvas()?.parentElement?.getBoundingClientRect();
    if (!frame) return at;
    return { x: at.x - frame.left, y: at.y - frame.top };
  }

  function openHud(at: { x: number; y: number }, size: number) {
    const box = ensureHud();
    if (!box || !live) return;
    box.open(
      [{ id: "size", label: live.kind === "fillet" ? "Radius" : "Distance", unit: "mm", value: size, places: 2 }],
      parentPoint(at),
      host.params(),
    );
  }

  function knob(point: Vec3, dir: Vec3, size: number, kind: BlendKind) {
    return {
      id: EDGE_KNOB_ID,
      kind: "axis" as const,
      look: "knob" as const,
      fields: ["edgeSize"],
      seat: { at: "feature" as const, origin: knobAt(point, dir, size) },
      dir,
      rate: 1,
      step: EDGE_STEP_MM,
      min: 0,
      ...(live?.maxMm != null ? { max: live.maxMm } : {}),
      color: "accent" as const,
      label: kind === "fillet" ? "Fillet" : "Chamfer",
      unit: "mm" as const,
      values: [size],
    };
  }

  function paint() {
    const session = live;
    const view = host.view();
    if (!view || !session) return;
    view.setEdgeKnob(knob(session.point, session.dir, session.size, session.kind));
    host.setGhost(session.size > 0 ? { kind: "blend", edges: session.edges, radius: session.size } : null);
    if (hud?.shown && !session.typing) hud.setValues([session.size]);
    publish();
  }

  function publish() {
    const canvas = host.canvas();
    if (!canvas) return;
    const session = live;
    const edges = session?.edges ?? shown?.edges;
    if (!session && !shown) {
      delete canvas.dataset.edgeDrag;
      delete canvas.dataset.edgeKind;
      delete canvas.dataset.edgeSize;
      delete canvas.dataset.edgeEdges;
      delete canvas.dataset.edgeClamp;
      return;
    }
    canvas.dataset.edgeDrag = session?.dragging ? "drag" : session?.typing ? "type" : session?.editing ? "edit" : "hover";
    canvas.dataset.edgeKind = session?.kind ?? "fillet";
    canvas.dataset.edgeSize = String(session?.size ?? 0);
    canvas.dataset.edgeEdges = (edges ?? []).join(",");
    if (session?.maxMm != null && session.size >= session.maxMm - 1e-6) canvas.dataset.edgeClamp = String(session.maxMm);
    else delete canvas.dataset.edgeClamp;
  }

  function targetOf(edge: number): Omit<Target, "edge"> | null {
    const solid = host.solid();
    if (!solid) return null;
    const found = solid.edges.find((item) => item.id === edge);
    if (!found) return null;
    const frame = edgeFrame(solid.positions, solid.triangles, found.points, host.center());
    if (!frame) return null;
    const pose = host.pose();
    const point = isIdentity(pose) ? frame.point : applyPose(pose, frame.point);
    const dir = isIdentity(pose) ? frame.dir : turnDir(pose, frame.dir);
    return { edges: edgeDragEdges(edge, host.selectedEdges()), point, dir };
  }

  function onHover(edge: number | null, at: { x: number; y: number } | null) {
    if (at) lastAt = at;
    if (live?.dragging || live?.typing || live?.editing) return;
    if (edge === hoverEdge) return;
    hoverEdge = edge;
    const view = host.view();
    if (edge == null || !host.armed()) {
      shown = null;
      view?.setEdgeKnob(null);
      publish();
      if (hinting) {
        hinting = false;
        if (host.armed()) host.readout(host.about());
      }
      return;
    }
    const target = targetOf(edge);
    if (!target) {
      shown = null;
      view?.setEdgeKnob(null);
      publish();
      return;
    }
    shown = { edge, ...target };
    view?.setEdgeKnob(knob(target.point, target.dir, 0, "fillet"));
    host.readout(edgeHoverHint(target.edges.length));
    hinting = true;
    publish();
  }

  function picksChanged() {
    if (!shown || live) return;
    const edges = edgeDragEdges(shown.edge, host.selectedEdges());
    shown = { ...shown, edges };
    if (hinting) host.readout(edgeHoverHint(edges.length));
    publish();
  }

  function onKnob(ev: EdgeKnobEvent) {
    if (ev.phase === "down") begin(ev);
    else if (ev.phase === "move") move(ev);
    else if (ev.phase === "up") void finish();
    else cancel(!!live?.editing);
  }

  function begin(ev: EdgeKnobEvent) {
    if (live?.dragging) return;
    if (!live) {
      if (!shown || !host.armed()) return;
      live = {
        kind: edgeDragKind(ev.alt),
        edges: shown.edges,
        point: shown.point,
        dir: shown.dir,
        size: 0,
        original: 0,
        maxMm: null,
        dragging: true,
        typing: false,
        proved: null,
        editing: false,
      };
    } else {
      live.dragging = true;
      live.kind = edgeDragKind(ev.alt);
    }
    lastAt = { x: ev.x, y: ev.y };
    host.highlight(live.edges);
    if (!hud?.shown) openHud(lastAt, live.size);
    paint();
    host.readout(edgeDragNote(live.kind, live.size, live.maxMm));
  }

  function setKind(alt: boolean) {
    if (!live) return;
    const kind = edgeDragKind(alt);
    if (live.kind === kind) return;
    live.kind = kind;
    live.proved = null;
    live.maxMm = null;
    paint();
    host.readout(edgeDragNote(live.kind, live.size, null));
    if (hud?.shown && !live.typing) openHud(lastAt ?? { x: 48, y: 48 }, live.size);
    if (live.size >= EDGE_MIN_MM) scheduleProbe();
  }

  function move(ev: EdgeKnobEvent) {
    if (!live?.dragging) return;
    lastAt = { x: ev.x, y: ev.y };
    setKind(ev.alt);
    const radius = blendRadius(host.ray(ev.x, ev.y), live.point, live.dir, {
      round: ev.ctrl || ev.meta,
      fine: ev.shift,
      max: live.maxMm,
    });
    if (radius == null) return;
    const moved = Math.abs(radius - live.size) >= 1e-9;
    if (moved) {
      live.size = radius;
      live.proved = null;
      host.readout(edgeDragNote(live.kind, live.size, live.size > 0 ? live.maxMm : null));
    }
    paint();
    if (hud?.shown) hud.move(parentPoint(lastAt));
    // The pointer is still moving: the kernel waits until it has been still.
    if (live.size >= EDGE_MIN_MM) scheduleProbe();
    else holdProbe();
  }

  async function finish() {
    if (!live?.dragging) return;
    live.dragging = false;
    if (live.typing) {
      paint();
      return;
    }
    if (live.size < EDGE_MIN_MM) {
      if (live.editing) {
        paint();
        return;
      }
      cancel(false);
      return;
    }
    if (live.editing && Math.abs(live.size - live.original) < 1e-9) {
      paint();
      return;
    }
    await commitSession();
  }

  function holdProbe() {
    window.clearTimeout(timer);
    probeGen += 1;
  }

  function scheduleProbe() {
    window.clearTimeout(timer);
    const gen = ++probeGen;
    timer = window.setTimeout(() => {
      void check(gen, true);
    }, GHOST_PROBE_WAIT_MS);
  }

  async function check(gen: number, clampAgain: boolean): Promise<boolean> {
    const session = live;
    if (!session || gen !== probeGen) return false;
    if (session.size < EDGE_MIN_MM) return false;
    const op = edgeDragOp(session.kind, session.edges, session.size);
    const key = JSON.stringify(op);
    if (session.proved === key) return true;
    const answer = await host.probe(op);
    if (gen !== probeGen || live !== session) return false;
    if (answer.ok) {
      session.proved = key;
      host.setPreview(answer.shape);
      return true;
    }
    host.setPreview(null);
    if (clampAgain && answer.maxMm != null && session.size > answer.maxMm + 1e-6) {
      session.maxMm = answer.maxMm;
      session.size = answer.maxMm;
      session.proved = null;
      paint();
      host.readout(edgeDragNote(session.kind, session.size, session.maxMm));
      const next = ++probeGen;
      return check(next, false);
    }
    session.maxMm = answer.maxMm;
    paint();
    host.readout(edgeDragRefusal(answer.error, answer.maxMm));
    return false;
  }

  async function commitSession() {
    if (!live || committing) return;
    committing = true;
    const session = live;
    try {
      const gen = ++probeGen;
      window.clearTimeout(timer);
      const ok = await check(gen, true);
      if (!ok || live !== session) return;
      const op = edgeDragOp(session.kind, session.edges, session.size);
      // Drop the session before the view is replaced, so that refresh does not cancel the edit it is committing.
      live = null;
      shown = null;
      hoverEdge = null;
      hud?.close();
      host.setGhost(null);
      host.setPreview(null);
      host.view()?.setEdgeKnob(null);
      hinting = false;
      publish();
      const node = session.editing ? await host.commitEdit(op) : await host.apply(op);
      if (node != null) {
        tab = { at: performance.now(), node };
        host.readout(edgeAppliedNote(session.kind, session.size));
      } else if (session.editing && host.editing()) host.abortEdit();
    } finally {
      committing = false;
    }
  }

  function cancel(abortEdit: boolean, quiet = false) {
    holdProbe();
    const edit = !!live?.editing;
    live = null;
    shown = null;
    hoverEdge = null;
    hud?.close();
    host.setGhost(null);
    host.setPreview(null);
    host.view()?.setEdgeKnob(null);
    host.restoreHighlight();
    hinting = false;
    publish();
    if (abortEdit && edit) host.abortEdit();
    else if (!quiet && host.armed()) host.readout(host.about());
  }

  function startTyping(key: string) {
    if (!shown || live) return;
    live = {
      kind: "fillet",
      edges: shown.edges,
      point: shown.point,
      dir: shown.dir,
      size: 0,
      original: 0,
      maxMm: null,
      dragging: false,
      typing: true,
      proved: null,
      editing: host.editing(),
    };
    host.highlight(live.edges);
    openHud(lastAt ?? { x: 48, y: 48 }, 0);
    paint();
    // The first character is written into the box. A second keydown would also be the shortcut for a
    // workspace tab (2 is Preview), and that shortcut would leave Model.
    const input = hud?.element.querySelector("input");
    if (input instanceof HTMLInputElement) {
      input.value = key;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function onKey(ev: KeyboardEvent) {
    if (ev.defaultPrevented || document.documentElement.dataset.overlay) return;
    if (host.stage() !== "model") return;
    const target = ev.target instanceof HTMLElement ? ev.target : null;
    const foreign = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || !!target.isContentEditable) && !hud?.element.contains(target);
    if (foreign) return;
    if (ev.key === "Alt" && live) {
      setKind(true);
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === "Tab" && !ev.shiftKey && !live && tab && tabStillOpen(tab.at, performance.now())) {
      ev.preventDefault();
      ev.stopPropagation();
      const node = tab.node;
      tab = null;
      void reopen(node);
      return;
    }
    if (live || !shown || ev.repeat) return;
    // A digit, a decimal or an opening parenthesis starts the size. Letters stay with the tool keys
    // (Fillet is L, Chamfer is Shift+L) until the box is open, and then the box takes them.
    if (!/^[0-9.(]$/.test(ev.key)) return;
    ev.preventDefault();
    ev.stopPropagation();
    startTyping(ev.key);
  }

  function onKeyUp(ev: KeyboardEvent) {
    if (ev.key === "Alt" && live?.dragging) setKind(false);
  }

  async function reopen(node: number) {
    const op = host.nodeOp(node);
    if (!op || (op.kind !== "fillet" && op.kind !== "chamfer")) return;
    const opened = await host.beginEdit(node, op);
    if (!opened) return;
    const edges = host.matchedEdges(op);
    const target = edges.length > 0 ? targetOf(edges[0]!) : null;
    if (!target || edges.length === 0) {
      host.abortEdit();
      host.readout("This step's edges are not on this solid any more: pick them again.");
      return;
    }
    live = {
      kind: op.kind,
      edges,
      point: target.point,
      dir: target.dir,
      size: op.size,
      original: op.size,
      maxMm: null,
      dragging: false,
      typing: false,
      proved: null,
      editing: true,
    };
    shown = { edge: edges[0]!, edges, point: target.point, dir: target.dir };
    hoverEdge = edges[0]!;
    host.highlight(edges);
    paint();
    openHud(lastAt ?? { x: 48, y: 48 }, op.size);
    host.readout(`${edgeDragNote(op.kind, op.size, null)} Enter sets the size, Esc cancels.`);
  }

  function sync() {
    bind();
    const view = host.view();
    if (!view) return;
    // A history jump already dropped the edit: take the box away and leave that jump's readout.
    if (live?.editing && !host.editing()) cancel(false, true);
    const on = host.armed();
    if (!on && live) cancel(!!live.editing, true);
    view.setEdgeHover(on);
    if (!on) {
      shown = null;
      hoverEdge = null;
      view.setEdgeKnob(null);
      publish();
    } else if (!live) {
      // The solid may have been replaced. The next move draws the knob again for whatever edge is under it.
      hoverEdge = null;
    }
  }

  return {
    sync,
    picksChanged,
    holding() {
      return live != null;
    },
  };
}
