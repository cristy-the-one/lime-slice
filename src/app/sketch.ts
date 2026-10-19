/**
 * --- S2 sketch editor ---
 * Enter and leave a sketch, the plane camera, the grid, reference lines, Line and Rectangle.
 * The sketch stays in this module until a feature copies it. It is not written into the file.
 * Undo here is the sketch's own stack (`docs/plan-gui-cad-modeling.md` §4.3).
 */
import { Pencil, createElement } from "lucide";
import { mountHud } from "../interact/hud";
import { gridSpacing } from "../interact/snap";
import type { ParsedSolid } from "../model-reply";
import type { FacePlane } from "../model-plane";
import type { Affine } from "../model-space";
import type { ModelView } from "../model-view";
import type { FaceRef, SketchOn, Vec3 } from "../sketch/model";
import { sketchMesh, type OriginPlane } from "../sketch/draw";
import {
  frameFromWorkplane,
  lookAtFrame,
  originFrame,
  planeOf,
  planeWindow,
  rayOnPlane,
  rayOnQuad,
  SKETCH_ANIM_MS,
  toWorld,
  type SketchFrame,
} from "../sketch/frame";
import { gridLines } from "../sketch/grid";
import { boxCrosses } from "../sketch/hit";
import { projectReferences } from "../sketch/refs";
import {
  activeSketch,
  beginChoose,
  canRedoSketch,
  canUndoSketch,
  commitSizes,
  discardSketch,
  enterSketch,
  finishSketch,
  previewSizes,
  redoSketch,
  reopenSketch,
  sketchBusy,
  sketchDimensions,
  sketchHandlesKey,
  sketchKey,
  sketchOff,
  sketchPointer,
  sketchReadout,
  undoSketch,
  withLook,
  withRefs,
  withTool,
  type SketchEditor,
  type SketchTool,
} from "../sketch/session";
import { DRAW_MENU, isDrawTool } from "../sketch/tools";
import { workplaneIn, workplaneOnFace, workplaneOwn, type Workplane } from "../workplane";

export interface SketchHost {
  view: ModelView;
  canvas: HTMLCanvasElement;
  readout(message: string): void;
  /** The sentence to put back when the sketch closes. */
  idleReadout(): string;
  closeTool(): void;
  solid(): ParsedSolid | null;
  pose(): Affine;
  /** The part origin in model space. */
  origin(): Vec3;
  /** A point the camera looks at, in model space. */
  focus(): Vec3;
  /** How large the part is, in millimetres, for the camera distance and the plane quads. */
  extent(): number;
  workplane(): Workplane;
  /** A flat face in model space, or null when the face is curved or missing. The ref is the solid's own frame. */
  faceInfo(face: number): { ref: FaceRef; plane: FacePlane } | null;
  /** Solid edges in model space. */
  edges(): { points: ArrayLike<number> }[];
  /** The face outline in model space, packed as segment pairs. Empty when the sketch is not on a face. */
  outline(face: number | null): number[];
  /** Push/Pull is the gesture under the pointer, so a double-click stays that repeat. */
  pullArmed(): boolean;
  syncPull(): void;
  syncEdge(): void;
  onHistory(): void;
}

interface SketchApi {
  occupies(): boolean;
  ownsHistory(): boolean;
  history(): { undo: boolean; redo: boolean } | null;
  undo(): void;
  redo(): void;
  sync(): void;
}

let editor: SketchEditor = sketchOff();
let api: SketchApi = {
  occupies: () => false,
  ownsHistory: () => false,
  history: () => null,
  undo: () => {},
  redo: () => {},
  sync: () => {},
};

/** Choosing or editing. Pinned cards do not take the view, so push/pull and the edge knob stay. */
export function sketchOccupiesView(): boolean {
  return api.occupies();
}

export function sketchOwnsHistory(): boolean {
  return api.ownsHistory();
}

export function sketchHistoryButtons(): { undo: boolean; redo: boolean } | null {
  return api.history();
}

export function sketchUndo(): void {
  api.undo();
}

export function sketchRedo(): void {
  api.redo();
}

export function mountSketch(host: SketchHost): { sync(): void } {
  const cards = document.querySelector<HTMLElement>("#sketchCards");
  const button = document.querySelector<HTMLButtonElement>("#modelToolSketch");
  const bed = document.querySelector<HTMLButtonElement>("#modelEmptySketch");
  if (button && !button.querySelector(".ico")) {
    const label = button.textContent?.trim() || "Sketch";
    button.replaceChildren(createElement(Pencil, { width: 14, height: 14, "aria-hidden": "true", class: "ico" }));
    const text = document.createElement("span");
    text.className = "model-tool-label";
    text.textContent = label;
    button.append(text);
    button.classList.add("is-icon");
  }
  const hud = mountHud(host.canvas.parentElement ?? document.body);
  const box = document.createElement("div");
  box.className = "sketch-box";
  box.hidden = true;
  document.body.append(box);
  hud.onCommit((commit) => {
    editor = commitSizes(editor, commit.values);
    publish("open");
  });
  hud.onCancel(() => {
    const next = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false });
    if (!next) return;
    editor = next;
    publish("open");
  });
  hud.onEdit((values) => {
    editor = previewSizes(editor, values);
    publish("skip");
  });

  let aimKey = "";
  let refsKey = "";
  let drawOpen = false;
  let shownPlanes: OriginPlane[] = [];
  let chooseDown: { x: number; y: number } | null = null;
  let lastClient = { x: 0, y: 0 };

  const sync = () => {
    if (editor.phase === "off") return;
    refsKey = "";
    publish("open");
  };
  api = {
    occupies: () => sketchBusy(editor),
    ownsHistory: () => editor.phase === "editing",
    history: () => (editor.phase === "editing" ? { undo: canUndoSketch(editor), redo: canRedoSketch(editor) } : null),
    undo() {
      editor = undoSketch(editor);
      publish("open");
    },
    redo() {
      editor = redoSketch(editor);
      publish("open");
    },
    sync,
  };

  button?.addEventListener("click", () => {
    if (sketchBusy(editor)) return;
    host.closeTool();
    editor = beginChoose(editor);
    publish("open");
  });
  bed?.addEventListener("click", () => {
    host.closeTool();
    editor = beginChoose(editor);
    enterNamed("XY");
  });
  cards?.addEventListener("click", (ev) => {
    const target = ev.target instanceof HTMLElement ? ev.target.closest("button") : null;
    if (!(target instanceof HTMLButtonElement)) return;
    const plane = target.dataset.sketchPlane;
    if (plane === "XY" || plane === "XZ" || plane === "YZ" || plane === "workplane") {
      enterNamed(plane);
      return;
    }
    const tool = target.dataset.sketchTool;
    const picked = tool === "line" || tool === "rectangle" || tool === "select" || (typeof tool === "string" && isDrawTool(tool)) ? tool : null;
    if (picked) {
      drawOpen = false;
      editor = withTool(editor, picked);
      publish("open");
      return;
    }
    if (target.dataset.sketchMenu != null) {
      drawOpen = !drawOpen;
      publish("skip");
      return;
    }
    if (target.dataset.sketchLook != null) {
      editor = withLook(editor, !editor.lookAround);
      publish("open");
      return;
    }
    if (target.dataset.sketchFinish != null) {
      editor = finishSketch(editor);
      publish("open");
      return;
    }
    if (target.dataset.sketchCancel != null) {
      editor = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false }) ?? editor;
      publish("open");
      return;
    }
    const openId = target.dataset.sketchOpen;
    if (openId) {
      host.closeTool();
      editor = reopenSketch(editor, Number(openId));
      aimKey = "";
      refsKey = "";
      publish("open");
      return;
    }
    const dropId = target.dataset.sketchDiscard;
    if (dropId) {
      editor = discardSketch(editor, Number(dropId));
      publish("open");
    }
  });
  host.canvas.addEventListener("dblclick", (ev) => {
    if (sketchBusy(editor) || host.pullArmed()) return;
    const hit = host.view.pickSolid(ev.clientX, ev.clientY);
    if (!hit) return;
    ev.preventDefault();
    ev.stopPropagation();
    host.closeTool();
    editor = beginChoose(editor);
    enterFace(hit.face);
  });
  window.addEventListener("keydown", (ev) => {
    if (!sketchBusy(editor) || ev.defaultPrevented) return;
    const mods = { ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey };
    const history = (ev.ctrlKey || ev.metaKey) && (ev.key === "z" || ev.key === "Z" || ev.key === "y" || ev.key === "Y");
    if (!sketchHandlesKey(ev.key, mods) && !history) return;
    const typing = ev.target instanceof HTMLElement && (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA" || ev.target.isContentEditable);
    if (typing && !history && ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    const next = sketchKey(editor, ev.key, mods);
    if (!next || next === editor) return;
    editor = next;
    publish("open");
  }, true);
  host.view.onSketchPointer((ev) => {
    lastClient = { x: ev.x, y: ev.y };
    if (editor.phase === "choosing") {
      const hit = chooseAt(ev.x, ev.y);
      editor = { ...editor, hotPlane: hit?.kind === "plane" ? hit.name : null };
      if (ev.phase === "down") chooseDown = { x: ev.x, y: ev.y };
      if (ev.phase === "up" && chooseDown) {
        const moved = (ev.x - chooseDown.x) ** 2 + (ev.y - chooseDown.y) ** 2 > 16;
        chooseDown = null;
        if (!moved && hit) {
          if (hit.kind === "face") enterFace(hit.face);
          else enterNamed(hit.name);
          return;
        }
      }
      publish("skip");
      return;
    }
    if (ev.phase === "down") drawOpen = false;
    if (editor.phase !== "editing" || editor.lookAround) return;
    const frame = drawingFrame();
    if (!frame) return;
    const ray = host.view.pointerRay(ev.x, ev.y);
    const hit = rayOnPlane(frame, ray.origin, ray.direction);
    const uv = hit?.uv ?? editor.cursor ?? [0, 0];
    editor = sketchPointer(editor, {
      phase: ev.phase,
      uv,
      sx: ev.x,
      sy: ev.y,
      shift: ev.shift,
      ctrl: ev.ctrl,
      alt: ev.alt,
      double: ev.double,
    }, {
      mmPerPx: Math.max(host.view.sketchView().mmPerPx, 1e-4),
      project: (at) => host.view.projectPoint(toWorld(frame, at)),
    });
    publish(ev.phase === "move" ? "values" : "open");
  });
  host.view.onSketchView(() => {
    if (editor.phase !== "editing" && editor.phase !== "choosing") return;
    draw();
  });

  host.canvas.dataset.sketch = "off";
  host.canvas.dataset.sketchTool = "";
  host.canvas.dataset.sketchEntities = "0";
  host.canvas.dataset.sketchPlane = "";
  host.canvas.dataset.sketchLook = "0";
  host.canvas.dataset.sketchKinds = "";
  host.canvas.dataset.sketchConstruction = "0";

  function enterNamed(name: "XY" | "XZ" | "YZ" | "workplane") {
    const frame = name === "workplane" ? frameFromWorkplane(host.workplane()) : originFrame(name, host.origin());
    const own = workplaneOwn({ source: "global", origin: frame.origin, turn: planeOf(frame).turn }, host.pose());
    const on: SketchOn = name === "workplane" ? { kind: "workplane" } : { kind: "plane", name };
    startDrawing(own.origin, own.turn, on);
  }

  function enterFace(face: number) {
    const info = host.faceInfo(face);
    if (!info) {
      host.readout("Pick a flat face. This one is curved.");
      return;
    }
    const own = workplaneOwn(workplaneOnFace(info.plane), host.pose());
    startDrawing(own.origin, own.turn, { kind: "face", face: info.ref });
  }

  function startDrawing(origin: Vec3, turn: Vec3, on: SketchOn) {
    const base = editor.phase === "choosing" ? editor : beginChoose(editor);
    editor = enterSketch(base, { origin, turn }, on);
    aimKey = "";
    refsKey = "";
    publish("open");
  }

  function drawingFrame(): SketchFrame | null {
    const sketch = activeSketch(editor);
    if (!sketch || editor.phase !== "editing") return null;
    return frameFromWorkplane(workplaneIn({ source: "global", origin: sketch.plane.origin, turn: sketch.plane.turn }, host.pose()));
  }

  function chooserPlanes(): OriginPlane[] {
    const origin = host.origin();
    const half = Math.max(host.extent(), 20) * 0.75;
    const planes: OriginPlane[] = (["XY", "XZ", "YZ"] as const).map((name) => ({ name, frame: originFrame(name, origin), half }));
    const work = frameFromWorkplane(host.workplane());
    const same = planes.some((plane) => framesMatch(plane.frame, work));
    if (!same) planes.push({ name: "workplane", frame: work, half });
    return planes;
  }

  function chooseAt(x: number, y: number): { kind: "face"; face: number } | { kind: "plane"; name: OriginPlane["name"] } | null {
    const ray = host.view.pointerRay(x, y);
    let best: { name: OriginPlane["name"]; t: number } | null = null;
    for (const plane of shownPlanes) {
      const hit = rayOnQuad(plane.frame, ray.origin, ray.direction, plane.half);
      if (!hit) continue;
      if (!best || hit.t < best.t) best = { name: plane.name, t: hit.t };
    }
    const face = host.view.pickSolid(x, y);
    if (face && (!best || face.t <= best.t)) return { kind: "face", face: face.face };
    return best ? { kind: "plane", name: best.name } : null;
  }

  function publish(hudMode: "open" | "values" | "skip") {
    const frame = drawingFrame();
    if (frame) ensureRefs(frame);
    shownPlanes = editor.phase === "choosing" ? chooserPlanes() : [];
    if (editor.phase === "editing") aim(frame);
    else if (aimKey) {
      aimKey = "";
      host.view.setSketchCamera(null);
    }
    host.view.setSketchCapture(sketchBusy(editor) && !editor.lookAround);
    host.view.setSketchDim(sketchBusy(editor));
    if (editor.phase === "editing" && aimKey) host.view.setSketchLock(!editor.lookAround);
    draw();
    paintCards();
    paintBox();
    paintDataset();
    if (editor.phase === "off") host.readout(host.idleReadout());
    else host.readout(sketchReadout(editor));
    syncHud(hudMode);
    if (button) button.setAttribute("aria-pressed", sketchBusy(editor) ? "true" : "false");
    host.syncPull();
    host.syncEdge();
    host.onHistory();
  }

  function aim(frame: SketchFrame | null) {
    if (!frame) return;
    const key = `${editor.active}:${frame.origin.map((value) => value.toFixed(3)).join()}:${frame.w.map((value) => value.toFixed(3)).join()}`;
    if (key === aimKey) return;
    aimKey = key;
    const view = host.view.sketchView();
    const pose = lookAtFrame(frame, host.focus(), host.extent(), view.fov);
    host.view.setSketchCamera({ ...pose, animateMs: SKETCH_ANIM_MS, lock: !editor.lookAround });
  }

  function ensureRefs(frame: SketchFrame) {
    const on = activeSketch(editor)?.on;
    const face = on?.kind === "face" ? on.face.index : null;
    const key = `${editor.active}:${face ?? "x"}:${frame.origin.map((value) => value.toFixed(2)).join()}`;
    if (key === refsKey) return;
    refsKey = key;
    editor = withRefs(editor, projectReferences(frame, host.edges(), host.outline(face)));
  }

  function draw() {
    if (editor.phase === "off" || editor.phase === "pinned") {
      host.view.setSketchDraw(null);
      return;
    }
    const frame = drawingFrame();
    const grid = frame ? gridFor(frame) : [];
    host.view.setSketchDraw(sketchMesh(editor, frame, grid, shownPlanes));
  }

  function gridFor(frame: SketchFrame) {
    const view = host.view.sketchView();
    const window = planeWindow(frame, {
      position: view.position,
      target: view.target,
      up: view.up,
      fovDeg: view.fov,
      aspect: view.height > 0 ? view.width / view.height : 1,
    });
    return gridLines(window.minU, window.maxU, window.minV, window.maxV, gridSpacing(view.mmPerPx));
  }

  function syncHud(mode: "open" | "values" | "skip") {
    if (mode === "skip") return;
    const dims = sketchDimensions(editor);
    if (!dims) {
      hud.close();
      return;
    }
    const at = pointerAt();
    if (mode === "open" || !hud.shown) hud.open(dims.fields, at);
    else hud.setValues(dims.fields.map((field) => field.value));
    hud.move(at);
  }

  function pointerAt(): { x: number; y: number } {
    const parent = host.canvas.parentElement?.getBoundingClientRect();
    if (!parent) return { x: 24, y: 24 };
    return { x: lastClient.x - parent.left + 16, y: lastClient.y - parent.top + 16 };
  }

  function paintDataset() {
    const sketch = activeSketch(editor) ?? (editor.phase === "pinned" ? editor.pinned[editor.pinned.length - 1]?.sketch : null);
    const on = sketch?.on;
    host.canvas.dataset.sketch = editor.phase;
    host.canvas.dataset.sketchTool = editor.phase === "editing" ? editor.tool : "";
    host.canvas.dataset.sketchEntities = String(sketch?.entities.length ?? 0);
    host.canvas.dataset.sketchPlane = on?.kind === "plane" ? on.name : on?.kind === "face" ? `face ${on.face.index}` : on?.kind === "workplane" ? "workplane" : "";
    host.canvas.dataset.sketchLook = editor.lookAround ? "1" : "0";
    host.canvas.dataset.sketchKinds = sketch?.entities.map((entity) => entity.kind).join(",") ?? "";
    host.canvas.dataset.sketchConstruction = String(sketch?.entities.filter((entity) => entity.construction).length ?? 0);
  }

  function paintBox() {
    const drag = editor.box;
    if (!drag || editor.phase !== "editing") {
      box.hidden = true;
      return;
    }
    const x = Math.min(drag.sx, drag.x);
    const y = Math.min(drag.sy, drag.y);
    box.hidden = false;
    box.dataset.cross = boxCrosses(drag.sx, drag.x) ? "1" : "0";
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${Math.abs(drag.x - drag.sx)}px`;
    box.style.height = `${Math.abs(drag.y - drag.sy)}px`;
  }

  function paintCards() {
    if (!cards) return;
    cards.replaceChildren();
    const pinned = editor.pinned.filter((item) => item.id !== editor.active && item.name !== "Sketch");
    if (editor.phase === "off" && pinned.length === 0) {
      cards.hidden = true;
      return;
    }
    cards.hidden = false;
    if (editor.phase === "choosing") cards.append(card(chooserRow()));
    if (editor.phase === "editing") cards.append(card(editingRow()));
    for (const item of pinned) cards.append(card(pinnedRow(item.id, item.name)));
    if (cards.childElementCount === 0) cards.hidden = true;
  }

  function chooserRow(): Node[] {
    return [
      paragraph("Sketch on"),
      planeButton("XY", "XY plane"),
      planeButton("XZ", "XZ plane"),
      planeButton("YZ", "YZ plane"),
      planeButton("workplane", "Workplane"),
      textButton("Cancel", { sketchCancel: "" }),
    ];
  }

  function editingRow(): Node[] {
    return [
      toolButton("line", "Line"),
      toolButton("rectangle", "Rectangle"),
      // --- S3. Drawing tools live in this menu, not on the Model toolbar. ---
      drawMenu(),
      toolButton("select", "Select"),
      textButton(editor.lookAround ? "Lock view" : "Look around", { sketchLook: editor.lookAround ? "1" : "0" }),
      textButton("Finish sketch", { sketchFinish: "" }),
    ];
  }

  function drawMenu(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sketch-menu";
    const current = isDrawTool(editor.tool) ? DRAW_MENU.find((item) => item.tool === editor.tool) : undefined;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn";
    open.dataset.sketchMenu = "draw";
    open.textContent = current?.label ?? "Draw";
    open.setAttribute("aria-haspopup", "menu");
    open.setAttribute("aria-expanded", drawOpen ? "true" : "false");
    open.setAttribute("aria-pressed", current ? "true" : "false");
    const menu = document.createElement("div");
    menu.className = "sketch-menu-list";
    menu.setAttribute("role", "menu");
    menu.hidden = !drawOpen;
    for (const item of DRAW_MENU) {
      const node = document.createElement("button");
      node.type = "button";
      node.className = "btn";
      node.setAttribute("role", "menuitem");
      node.dataset.sketchTool = item.tool;
      node.textContent = item.label;
      node.title = item.shortcut;
      node.setAttribute("aria-pressed", editor.tool === item.tool ? "true" : "false");
      menu.append(node);
    }
    wrap.append(open, menu);
    return wrap;
  }

  function pinnedRow(id: number, name: string): Node[] {
    return [
      textButton(name, { sketchOpen: String(id) }),
      textButton("Discard", { sketchDiscard: String(id) }),
    ];
  }

  function card(children: Node[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "sketch-card";
    row.append(...children);
    return row;
  }

  function paragraph(text: string): HTMLElement {
    const node = document.createElement("p");
    node.textContent = text;
    return node;
  }

  function planeButton(name: OriginPlane["name"], label: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "btn";
    node.dataset.sketchPlane = name;
    node.textContent = label;
    return node;
  }

  function toolButton(tool: SketchTool, label: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "btn";
    node.dataset.sketchTool = tool;
    node.textContent = label;
    node.setAttribute("aria-pressed", editor.tool === tool ? "true" : "false");
    return node;
  }

  function textButton(label: string, data: Record<string, string>): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "btn";
    node.textContent = label;
    for (const [key, value] of Object.entries(data)) node.dataset[key] = value;
    return node;
  }

  return { sync };
}

function framesMatch(a: SketchFrame, b: SketchFrame): boolean {
  const origin = Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]);
  const normal = Math.abs(a.w[0] * b.w[0] + a.w[1] * b.w[1] + a.w[2] * b.w[2]);
  return origin < 0.5 && normal > 0.999;
}
