/**
 * P1. Face push/pull on the open solid.
 * With no other model tool open, and while Push/Pull itself is open, a face drag
 * moves the face. Alt on one face adds a prism. Release applies. Tab, for three
 * seconds, edits that step.
 */

import { GHOST_PROBE_WAIT_MS } from "./interact/ghosts.ts";
import { mountHud, type HudCommit, type Params } from "./interact/hud.ts";
import { repeatClick, type ClickAt } from "./interact/drag-axis.ts";
import type { FaceLevel } from "./interact/drag-axis.ts";
import { faceTable } from "./interact/face-table.ts";
import { fieldText, handlesFor, type Vec3 } from "./model-drag.ts";
import { applyPose, turnDir, type Affine } from "./model-space.ts";
import type { FaceExtrudeOp, MoveFacesOp } from "./model-tree.ts";
import { isPlainNumber, withExprs } from "./modeling/params.ts";
import type { FacePointer, ModelView } from "./model-view.ts";
import {
  distanceForDiameter,
  pullDone,
  pullDrag,
  pullFields,
  pullGhost,
  pullHint,
  pullLevels,
  pullOp,
  tabEditOpen,
  type PullFace,
} from "./push-pull.ts";

export interface PullSolid {
  positions: ArrayLike<number>;
  triangles: ArrayLike<number>;
  faces: {
    id: number;
    areaMm2: number;
    normal?: Vec3;
    radiusMm?: number;
    surface?: PullFace["surface"];
    axisPoint?: Vec3;
    axis?: Vec3;
  }[];
}

export interface PullMade {
  parent: number;
  node: number;
}

export interface PullHooks {
  /** Face mode, an editable solid, and either no tool or Push/Pull. */
  live(): boolean;
  /** Push/Pull's panel is the open tool, so a typed distance draws before Apply. */
  toolOpen(): boolean;
  solid(): PullSolid | null;
  pose(): Affine;
  selectedFaces(): number[];
  /** The panel's distance. */
  distance(): number;
  setField(distance: number): void;
  readout(text: string): void;
  parameters(): Params;
  /** Keep the panel's dry-run from clearing a gesture probe. */
  hold(on: boolean): void;
  /** A kernel preview may replace the solid while no tool panel is open. */
  armPreview(on: boolean): void;
  previewFresh(): boolean;
  probe(op: MoveFacesOp | FaceExtrudeOp): void;
  clearPreview(): void;
  /** Apply on release. Null when the step was not kept. */
  apply(op: MoveFacesOp | FaceExtrudeOp): Promise<PullMade | null>;
  /** Tab edits the step just made. False when the edit was not kept. */
  edit(parent: number, node: number, op: MoveFacesOp | FaceExtrudeOp): Promise<boolean>;
  busy(): boolean;
}

interface Dragging {
  faces: PullFace[];
  alt: boolean;
  origin: Vec3;
  dir: Vec3;
  /** The other faces' levels along the drag, read once when it begins. */
  levels: FaceLevel[];
}

interface Remember {
  at: number;
  parent: number;
  node: number;
  faces: PullFace[];
  alt: boolean;
  distance: number;
}

export interface PullController {
  /** Draw the arrow, or return false so another tool draws. */
  sync(): boolean;
}

export function mountPull(view: ModelView, hooks: PullHooks): PullController {
  const parent = document.querySelector<HTMLElement>("#modelBody") ?? document.body;
  const hud = mountHud(parent);
  let hoverFace: number | null = null;
  let hoverLocal: Vec3 | null = null;
  /** The press, before it has moved enough to be a drag. */
  let armed: FacePointer | null = null;
  let dragging: Dragging | null = null;
  let dragDistance = 0;
  let typed: number | null = null;
  let previous: number | null = null;
  let previousAlt = false;
  let lastClick: ClickAt | null = null;
  let remember: Remember | null = null;
  let editing = false;
  let applying = false;
  let timer = 0;
  const faceRows = new WeakMap<PullSolid, Map<number, PullSolid["faces"][number]>>();

  hud.onCommit((commit) => {
    const distance = commitDistance(commit);
    const texts = pullTexts(commit);
    if (editing && remember) {
      editing = false;
      hud.close();
      void commitEdit(distance, texts);
      return;
    }
    if (!dragging) return;
    const faces = dragging.faces;
    const alt = dragging.alt;
    stopGesture();
    void commitNew(distance, faces, alt, texts);
  });
  hud.onCancel(() => {
    editing = false;
    typed = null;
    if (dragging) stopGesture();
    else hud.close();
    hooks.readout(pullHint(previous));
  });
  hud.onEdit((values) => {
    typed = editedDistance(values);
    if (dragging && typed != null) paintDrag(typed);
  });

  view.onFacePointer((ev) => {
    if (!hooks.live() || hooks.busy() || applying) return;
    if (ev.phase === "hover") {
      hoverFace = ev.face;
      hoverLocal = ev.local;
      if (!dragging && !editing) {
        paintIdle();
        if (ev.face != null) hooks.readout(pullHint(previous));
      }
      return;
    }
    if (ev.phase === "down") {
      if (editing) return;
      armed = ev;
      return;
    }
    if (ev.phase === "move") {
      if (!dragging && armed?.face != null && armed.point) begin(armed, ev);
      if (dragging) move(ev);
      return;
    }
    if (ev.phase === "up") {
      armed = null;
      if (!dragging) return;
      const faces = dragging.faces;
      const alt = dragging.alt;
      const distance = typed ?? dragDistance;
      stopGesture();
      if (distance !== 0) void commitNew(distance, faces, alt);
      else hooks.readout(pullHint(previous));
      return;
    }
    if (ev.phase === "click") {
      armed = null;
      if (dragging) stopGesture();
      onClick(ev);
    }
  });

  window.addEventListener("keydown", onTab, true);

  return { sync };

  function sync(): boolean {
    if (!hooks.live()) {
      view.setFaceDrag(false);
      if (!dragging) view.setAlign(null);
      return false;
    }
    view.setFaceDrag(true);
    if (dragging) {
      if (hooks.previewFresh()) view.setGhost(null);
      else paintGhost(dragDistance, dragging.faces);
      return true;
    }
    if (!editing) paintIdle();
    return true;
  }

  function onTab(ev: KeyboardEvent) {
    if (ev.key !== "Tab" || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
    if (hud.shown || dragging || editing || applying) return;
    const target = ev.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, select")) return;
    if (!remember || !tabEditOpen(remember.at, performance.now())) return;
    ev.preventDefault();
    ev.stopPropagation();
    editing = true;
    typed = null;
    const spot = view.projectPoint(applyPose(hooks.pose(), remember.faces[0]?.at ?? [0, 0, 0]));
    const at = spot ? localOf(spot) : { x: 24, y: 24 };
    hud.open(pullFields(remember.distance, remember.faces), at, hooks.parameters());
    hooks.readout("Type a distance. Enter sets it, Esc cancels.");
  }

  function onClick(ev: FacePointer) {
    const now = { at: performance.now(), x: ev.x, y: ev.y };
    const again = repeatClick(lastClick, now);
    lastClick = now;
    if (!again || previous == null || previous === 0 || ev.face == null) return;
    const solid = hooks.solid();
    if (!solid) return;
    const faces = facesFor(solid, ev.face, ev.local);
    if (faces.length === 0) return;
    void commitNew(previous, faces, previousAlt);
  }

  function begin(grab: FacePointer, ev: FacePointer) {
    const solid = hooks.solid();
    if (!solid || grab.face == null || !grab.point) return;
    const faces = facesFor(solid, grab.face, grab.local);
    const under = faces.find((face) => face.index === grab.face) ?? faces[0];
    if (!under) return;
    const pose = hooks.pose();
    const dir = turnDir(pose, under.normal);
    const levels = pullLevels(worldFaces(solid, pose), grab.point, dir, new Set(faces.map((face) => face.index)));
    dragging = { faces, alt: grab.alt && faces.length === 1, origin: grab.point, dir, levels };
    dragDistance = 0;
    typed = null;
    editing = false;
    hooks.hold(true);
    hooks.armPreview(true);
    hud.open(pullFields(0, faces), localOf({ x: ev.x, y: ev.y }), hooks.parameters());
    paintArrow(grab.point, dragging.dir, 0);
    view.setGhost(null);
    view.setPull(0);
  }

  function move(ev: FacePointer) {
    const drag = dragging;
    if (!drag) return;
    window.clearTimeout(timer);
    hooks.clearPreview();
    const dragged = pullDrag(ev.ray, drag.origin, drag.dir, {
      round: ev.ctrl,
      fine: ev.shift,
      faces: drag.levels,
      mmPerPx: mmPerPx(drag.origin, drag.dir),
      previous,
    });
    if (!dragged) return;
    if (typed == null) dragDistance = dragged.distance;
    const distance = typed ?? dragDistance;
    paintDrag(distance);
    view.setAlign(dragged.align);
    view.setPull(distance);
    hud.move(localOf({ x: ev.x, y: ev.y }));
    if (typed == null) hud.setValues(pullFields(distance, drag.faces).map((field) => field.value));
    const op = pullOp(drag.faces, distance, drag.alt);
    if (!op) return;
    timer = window.setTimeout(() => hooks.probe(op), GHOST_PROBE_WAIT_MS);
  }

  function paintDrag(distance: number) {
    const drag = dragging;
    if (!drag) return;
    dragDistance = distance;
    paintArrow(drag.origin, drag.dir, distance);
    if (hooks.previewFresh()) view.setGhost(null);
    else paintGhost(distance, drag.faces);
    hooks.setField(distance);
  }

  function paintIdle() {
    const solid = hooks.solid();
    const pose = hooks.pose();
    if (!solid) {
      view.setHandles([]);
      view.setGhost(null);
      return;
    }
    const hover = hoverFace == null ? null : describe(solid, hoverFace, hoverLocal);
    const selected = hooks.selectedFaces();
    const last = selected.length > 0 ? describe(solid, selected[selected.length - 1]!, null) : null;
    const seat = hover ?? (hooks.toolOpen() ? last : null);
    if (!seat) {
      view.setHandles([]);
      if (!hooks.previewFresh()) view.setGhost(null);
      return;
    }
    const at = applyPose(pose, seat.at);
    const dir = turnDir(pose, seat.normal);
    paintArrow(at, dir, hooks.distance());
    if (hooks.toolOpen() && last && hooks.distance() !== 0 && !hooks.previewFresh()) {
      const faces = selected.map((index) => describe(solid, index, null)).filter((face): face is PullFace => face != null);
      paintGhost(hooks.distance(), faces.length > 0 ? faces : [seat]);
    } else if (!hooks.previewFresh()) view.setGhost(null);
  }

  function paintArrow(at: Vec3, dir: Vec3, distance: number) {
    view.setHandles(handlesFor("pushpull", {
      read: () => distance,
      primitive: "box",
      center: at,
      extent: 10,
      split: null,
      edge: null,
      pull: { at, dir },
    }));
  }

  function paintGhost(distance: number, faces: readonly PullFace[]) {
    const solid = hooks.solid();
    if (!solid) return;
    const soup = pullGhost(solid.positions, solid.triangles, faces, distance);
    view.setGhost(soup.length > 0 ? { kind: "soup", positions: soup } : null);
  }

  function stopGesture() {
    armed = null;
    dragging = null;
    typed = null;
    window.clearTimeout(timer);
    hud.close();
    view.setAlign(null);
    view.setPull(null);
    hooks.hold(false);
    hooks.armPreview(false);
    hooks.clearPreview();
  }

  function pullTexts(commit: HudCommit): Record<string, string> | undefined {
    const ids = ["distance", "diameter"];
    const out: Record<string, string> = {};
    commit.texts.forEach((text, index) => {
      const id = ids[index];
      if (id && text && !isPlainNumber(text)) out[id] = text.trim();
    });
    return Object.keys(out).length > 0 ? out : undefined;
  }

  function stamped(op: MoveFacesOp | FaceExtrudeOp, texts: Record<string, string> | undefined): MoveFacesOp | FaceExtrudeOp {
    return withExprs(op, texts) as MoveFacesOp | FaceExtrudeOp;
  }

  async function commitNew(distance: number, faces: PullFace[], alt: boolean, texts?: Record<string, string>) {
    const op = pullOp(faces, distance, alt);
    if (!op || applying) return;
    applying = true;
    try {
      const made = await hooks.apply(stamped(op, texts));
      if (!made) return;
      previous = distance;
      previousAlt = alt;
      remember = { at: performance.now(), parent: made.parent, node: made.node, faces, alt, distance };
      hooks.setField(distance);
      hooks.readout(pullDone(distance));
    } finally {
      applying = false;
    }
  }

  async function commitEdit(distance: number, texts?: Record<string, string>) {
    const kept = remember;
    if (!kept || applying) return;
    const op = pullOp(kept.faces, distance, kept.alt);
    if (!op) return;
    applying = true;
    try {
      const ok = await hooks.edit(kept.parent, kept.node, stamped(op, texts));
      if (!ok) return;
      previous = distance;
      previousAlt = kept.alt;
      remember = { ...kept, at: performance.now(), distance };
      hooks.setField(distance);
      hooks.readout(pullDone(distance));
    } finally {
      applying = false;
    }
  }

  function facesFor(solid: PullSolid, face: number, local: Vec3 | null): PullFace[] {
    const selected = hooks.selectedFaces();
    const indexes = selected.includes(face) && selected.length > 1 ? selected : [face];
    const faces: PullFace[] = [];
    for (const index of indexes) {
      const described = describe(solid, index, index === face ? local : null);
      if (described) faces.push(described);
    }
    return faces;
  }

  function describe(solid: PullSolid, index: number, local: Vec3 | null): PullFace | null {
    const row = rowsOf(solid).get(index);
    const table = faceTable(solid.positions, solid.triangles).get(index);
    const normal = row?.normal ?? table?.normal;
    if (!normal) return null;
    const at = local ?? table?.centre;
    if (!at) return null;
    return {
      index,
      normal,
      at,
      ...(row?.areaMm2 != null ? { areaMm2: row.areaMm2 } : {}),
      ...(row?.radiusMm != null ? { radiusMm: row.radiusMm } : {}),
      ...(row?.surface ? { surface: row.surface } : {}),
      ...(row?.axisPoint ? { axisPoint: row.axisPoint } : {}),
      ...(row?.axis ? { axis: row.axis } : {}),
    };
  }

  /** The kernel's face rows by id, read once per solid. */
  function rowsOf(solid: PullSolid): Map<number, PullSolid["faces"][number]> {
    let rows = faceRows.get(solid);
    if (!rows) faceRows.set(solid, (rows = new Map(solid.faces.map((face) => [face.id, face]))));
    return rows;
  }

  /** Every face in model space, for the snap levels. Read once per drag: the solid and its pose hold still while it runs. */
  function worldFaces(solid: PullSolid, pose: Affine): PullFace[] {
    const faces: PullFace[] = [];
    for (const index of faceTable(solid.positions, solid.triangles).keys()) {
      const face = describe(solid, index, null);
      if (face) faces.push({ ...face, at: applyPose(pose, face.at), normal: turnDir(pose, face.normal) });
    }
    return faces;
  }

  function mmPerPx(origin: Vec3, dir: Vec3): number | undefined {
    const a = view.projectPoint(origin);
    const b = view.projectPoint([origin[0] + dir[0], origin[1] + dir[1], origin[2] + dir[2]]);
    if (!a || !b) return undefined;
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    return px > 0.5 ? 1 / px : undefined;
  }

  function editedDistance(values: readonly number[]): number | null {
    const faces = dragging?.faces ?? remember?.faces ?? [];
    const active = hud.element.dataset.hudActive;
    if (active === "1") return distanceForDiameter(faces, values[1] ?? Number.NaN);
    const distance = values[0];
    return distance != null && Number.isFinite(distance) ? distance : null;
  }

  function commitDistance(commit: HudCommit): number {
    const fromValues = editedDistance(commit.values);
    return fromValues ?? commit.values[0] ?? 0;
  }

  function localOf(at: { x: number; y: number }): { x: number; y: number } {
    const frame = parent.getBoundingClientRect();
    return { x: at.x - frame.left, y: at.y - frame.top };
  }
}

/** The panel field, shown the way the other distances are. */
export function pullFieldText(distance: number): string {
  return fieldText(distance);
}
