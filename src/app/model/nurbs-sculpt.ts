/** S6: pole, row and column sculpting, with a live Zebra preview and a commit on release. */
import { fx } from "../fx";
import { modelTrees } from "../model-trees";
import { state } from "../state";
import { decodeSolid } from "../../model-reply";
import { nurbsSurfaceOp, openRequest } from "../../model-request";
import { ROOT, type NurbsSurfaceOp } from "../../model-tree";
import {
  bicubicGrid,
  creaseSurface,
  DEFAULT_PREVIEW_DENSITY,
  elevateSurfaceDegree,
  evalNurbsSurface3D,
  insertSurfaceKnot,
  sculptGrid,
  surfaceMesh,
  surfaceRefusal,
  type CvAxis,
  type NurbsSurface3D,
  type SculptHit,
  type Vec3,
} from "../../modeling/nurbs-eval.ts";
import { createFeatureSolid } from "./create";
import { post } from "./engine";
import { readout } from "./pick";
import { S } from "./shared";
import { openPose } from "./view";

const DEBOUNCE_MS = 180;

let spec: NurbsSurface3D = fresh();
let hit: SculptHit = { iu: 1, iv: 1, mode: "pole" };
let drag: { axis: CvAxis; pointer: number; lastY: number; normal: Vec3 } | null = null;
let timer = 0;
let key: string | null = null;
let placed = false;

function fresh(): NurbsSurface3D {
  return { poles: bicubicGrid(), degreeU: 3, degreeV: 3 };
}

function toolOpen(): boolean {
  return document.querySelector("#modelToolNurbs")?.getAttribute("aria-pressed") === "true"
    || document.querySelector("#modelFeatureMenu [data-tool=sculpt]")?.getAttribute("aria-pressed") === "true";
}

function num(id: string, fallback: number): number {
  const value = Number(document.querySelector<HTMLInputElement>(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function normalAt(iu: number, iv: number): Vec3 {
  const nu = spec.poles.length;
  const nv = spec.poles[0]?.length ?? 1;
  const u = nu <= 1 ? 0 : iu / (nu - 1);
  const v = nv <= 1 ? 0 : iv / (nv - 1);
  return evalNurbsSurface3D(spec, u, v).normal;
}

function paint() {
  const overlay = document.querySelector<HTMLElement>("#modelNurbsOverlay");
  if (!overlay || !fx.model) return;
  if (!toolOpen()) {
    overlay.hidden = true;
    overlay.replaceChildren();
    fx.model.setNurbsPreview(null);
    return;
  }
  const started = performance.now();
  const mesh = surfaceMesh(spec, DEFAULT_PREVIEW_DENSITY);
  if (typeof mesh === "string") {
    readout(mesh);
    return;
  }
  fx.model.setNurbsPreview(mesh, started);
  overlay.hidden = false;
  const buttons: HTMLButtonElement[] = [];
  const poleButton = (iu: number, iv: number, at: { x: number; y: number }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = iu === hit.iu && iv === hit.iv ? "nurbs-pole on" : "nurbs-pole";
    button.dataset.nurbsIu = String(iu);
    button.dataset.nurbsIv = String(iv);
    button.style.left = `${at.x}px`;
    button.style.top = `${at.y}px`;
    button.setAttribute("aria-label", `Pole ${iu + 1}, ${iv + 1}`);
    button.textContent = iu === hit.iu && iv === hit.iv ? "•" : "";
    buttons.push(button);
  };
  spec.poles.forEach((row, iu) => {
    row.forEach((pole, iv) => {
      const at = fx.model!.projectPoint(pole);
      if (at) poleButton(iu, iv, at);
    });
  });
  const selected = spec.poles[hit.iu]?.[hit.iv];
  if (selected) {
    const at = fx.model.projectPoint(selected);
    if (at) {
      const axes: [CvAxis, string, number, number][] = [["x", "X", 18, 0], ["y", "Y", 0, -18], ["z", "Z", -18, 0], ["normal", "N", 0, 18]];
      for (const [axis, label, dx, dy] of axes) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.cvAxis = axis;
        button.style.left = `${at.x + dx}px`;
        button.style.top = `${at.y + dy}px`;
        button.setAttribute("aria-label", `Drag ${label}`);
        button.textContent = label;
        buttons.push(button);
      }
    }
    const mirror = spec.poles[spec.poles.length - 1 - hit.iu]?.[hit.iv];
    const canvas = document.querySelector<HTMLCanvasElement>("#model");
    if (canvas && mirror) {
      canvas.dataset.nurbsPole = selected.join(",");
      canvas.dataset.nurbsMirror = mirror.join(",");
    }
  }
  overlay.replaceChildren(...buttons);
}

function showRefusal(next: NurbsSurface3D | string): boolean {
  if (typeof next === "string") {
    readout(next);
    return false;
  }
  const refusal = surfaceRefusal(next);
  if (refusal) {
    readout(refusal);
    return false;
  }
  spec = next;
  paint();
  schedule();
  return true;
}

export async function commitNurbs(): Promise<boolean> {
  const refusal = surfaceRefusal(spec);
  if (refusal) {
    readout(refusal);
    return false;
  }
  const op = nurbsSurfaceOp(spec);
  if (!placed || !key || !S.open || S.open.key !== key) {
    const ok = await createFeatureSolid(op, undefined, true);
    if (ok && S.open) {
      placed = true;
      key = S.open.key;
    }
    return ok;
  }
  return replace(op);
}

async function replace(op: NurbsSurfaceOp): Promise<boolean> {
  if (!S.open || !key || S.busy) return false;
  const tree = modelTrees.get(key);
  if (!tree || tree.root.kind !== "feature") return createFeatureSolid(op, undefined, true);
  const mine = S.ticket;
  S.busy = true;
  const body = await post(openRequest(key, { kind: "feature", op }, state.stepTolerance));
  if (mine === S.ticket) S.busy = false;
  const parsed = decodeSolid(body);
  if (typeof parsed === "string") {
    readout(parsed);
    return false;
  }
  tree.root = { kind: "feature", op };
  const node = tree.nodes.get(ROOT);
  if (node) node.fingerprint = parsed.fingerprint;
  S.open = { objectId: S.open.objectId, key, solid: parsed };
  fx.model?.setSolid(parsed, openPose());
  return true;
}

function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (drag) void commitNurbs();
  }, DEBOUNCE_MS);
}

function onPointerDown(ev: PointerEvent) {
  const target = ev.target instanceof Element ? ev.target : null;
  const pole = target?.closest<HTMLButtonElement>("[data-nurbs-iu]");
  if (pole && toolOpen()) {
    hit = { iu: Number(pole.dataset.nurbsIu), iv: Number(pole.dataset.nurbsIv), mode: hit.mode };
    paint();
    return;
  }
  const axis = target?.closest<HTMLButtonElement>("[data-cv-axis]");
  if (!axis || !toolOpen()) return;
  drag = {
    axis: axis.dataset.cvAxis as CvAxis,
    pointer: ev.pointerId,
    lastY: ev.clientY,
    normal: normalAt(hit.iu, hit.iv),
  };
  axis.setPointerCapture?.(ev.pointerId);
  ev.preventDefault();
}

function onPointerMove(ev: PointerEvent) {
  if (!drag || ev.pointerId !== drag.pointer) {
    if (toolOpen()) paint();
    return;
  }
  const amount = (drag.lastY - ev.clientY) * 0.15;
  drag.lastY = ev.clientY;
  if (amount === 0) return;
  spec = {
    ...spec,
    poles: sculptGrid(spec.poles, hit, drag.axis, amount, drag.normal, num("#modelNurbsFalloff", 0), document.querySelector<HTMLInputElement>("#modelNurbsSymmetry")?.checked === true),
  };
  paint();
  schedule();
}

function onPointerUp(ev: PointerEvent) {
  if (!drag || ev.pointerId !== drag.pointer) return;
  drag = null;
  window.clearTimeout(timer);
  void commitNurbs();
}

function onClick(ev: MouseEvent) {
  const target = ev.target instanceof Element ? ev.target : null;
  const mode = target?.closest<HTMLButtonElement>("[data-sculpt-mode]");
  if (mode?.dataset.sculptMode === "pole" || mode?.dataset.sculptMode === "row" || mode?.dataset.sculptMode === "column") {
    hit = { ...hit, mode: mode.dataset.sculptMode };
    document.querySelectorAll<HTMLButtonElement>("[data-sculpt-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", button === mode ? "true" : "false");
    });
    return;
  }
  if (target?.closest("#modelNurbsInsertU")) showRefusal(insertSurfaceKnot(spec, "u", 0.5, 1));
  if (target?.closest("#modelNurbsInsertV")) showRefusal(insertSurfaceKnot(spec, "v", 0.5, 1));
  if (target?.closest("#modelNurbsCreaseU")) showRefusal(creaseSurface(spec, "u", 0.5));
  if (target?.closest("#modelNurbsElevateU")) showRefusal(elevateSurfaceDegree(spec, "u", 1));
  if (target?.closest("#modelNurbsElevateV")) showRefusal(elevateSurfaceDegree(spec, "v", 1));
  if (target?.closest("#modelNurbsWeight")) {
    const weight = num("#modelNurbsWeight", 1);
    const weights = spec.poles.map((row, iu) => row.map((_, iv) => spec.weights?.[iu]?.[iv] ?? 1));
    const row = weights[hit.iu];
    if (row) row[hit.iv] = weight;
    showRefusal({ ...spec, weights });
  }
}

export function installNurbsSculpt() {
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("click", onClick);
  document.addEventListener("lime-nurbs", () => {
    if (toolOpen()) paint();
    else {
      const overlay = document.querySelector<HTMLElement>("#modelNurbsOverlay");
      if (overlay) {
        overlay.hidden = true;
        overlay.replaceChildren();
      }
      fx.model?.setNurbsPreview(null);
    }
  });
  document.querySelector("#modelNurbsDegreeU")?.addEventListener("change", () => {
    const degreeU = num("#modelNurbsDegreeU", 3);
    showRefusal(degreeU > (spec.degreeU ?? 3) ? elevateSurfaceDegree({ ...spec, degreeU: spec.degreeU }, "u", degreeU - (spec.degreeU ?? 3)) : { ...spec, degreeU });
  });
  document.querySelector("#modelNurbsDegreeV")?.addEventListener("change", () => {
    const degreeV = num("#modelNurbsDegreeV", 3);
    showRefusal(degreeV > (spec.degreeV ?? 3) ? elevateSurfaceDegree(spec, "v", degreeV - (spec.degreeV ?? 3)) : { ...spec, degreeV });
  });
}
