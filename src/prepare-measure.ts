/**
 * Prepare's point-to-point Measure: click two points on any object on the plate and read the distance and the change on
 * each axis between them. A point snaps through `measure-feature.ts` to a corner, an edge's middle, the middle of a flat
 * face or a box point of whatever object is under the pointer, so two objects' features can be compared. Alt turns the
 * snap off. The overlay is DOM over the canvas, and lengths are print millimetres, Z up.
 */
import * as THREE from "three";
import { featureAtHit, warmFeatures } from "./measure-feature.ts";
import { pointLabel, readoutLines, type PickedPoint } from "./measure-points.ts";
import type { Vec3 } from "./measure-snap.ts";
import "./ui/measure.css";

export interface MeasureTarget {
  mesh: THREE.Mesh;
  id: string;
  name: string;
}

export interface PointMeasureDeps {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  raycaster: THREE.Raycaster;
  /** Aims the raycaster at the pointer, with every matrix current. */
  aim(ev: { clientX: number; clientY: number }): void;
  /** The meshes a point can land on: the selected object and the grey ones. */
  targets(): MeasureTarget[];
  toPrint(world: THREE.Vector3): Vec3;
  toScene(p: Vec3): THREE.Vector3;
  redraw(): void;
}

export interface PointMeasure {
  isOn(): boolean;
  setOn(on: boolean): void;
  /** Forget the points: the objects they were on have moved. */
  clear(): void;
  /** Reposition the overlay for the camera as it is now. */
  paint(): void;
}

/** A click is a press and a release this close together; further apart, the press was an orbit. */
const CLICK_PX = 4;

interface End extends PickedPoint {
  at: Vec3;
}

export function mountPointMeasure(deps: PointMeasureDeps): PointMeasure {
  const { canvas, camera, raycaster } = deps;
  const host = canvas.parentElement;
  let on = false;
  let a: End | null = null;
  let b: End | null = null;
  let hover: End | null = null;
  let down: { x: number; y: number } | null = null;
  const hits: THREE.Intersection[] = [];
  const probe = new THREE.Vector3();

  const layer = document.createElement("div");
  layer.className = "pm-layer";
  layer.hidden = true;
  layer.innerHTML = `
    <svg class="pm-svg" aria-hidden="true"><line class="pm-line" x1="0" y1="0" x2="0" y2="0"></line></svg>
    <div class="pm-dot" data-end="a" hidden><span>A</span></div>
    <div class="pm-dot" data-end="b" hidden><span>B</span></div>
    <div class="pm-hover" hidden><span></span></div>
    <div class="pm-readout" id="pointMeasureReadout" role="status" hidden></div>`;
  host?.append(layer);
  const line = layer.querySelector<SVGLineElement>(".pm-line")!;
  const dotA = layer.querySelector<HTMLElement>('.pm-dot[data-end="a"]')!;
  const dotB = layer.querySelector<HTMLElement>('.pm-dot[data-end="b"]')!;
  const hoverMark = layer.querySelector<HTMLElement>(".pm-hover")!;
  const hoverText = hoverMark.querySelector("span")!;
  const readout = layer.querySelector<HTMLElement>(".pm-readout")!;

  /** The point under the pointer, snapped unless `snap` is off. Null off every object. */
  function pick(ev: { clientX: number; clientY: number }, snap: boolean): End | null {
    deps.aim(ev);
    const targets = deps.targets();
    let best: { hit: THREE.Intersection; target: MeasureTarget } | null = null;
    for (const target of targets) {
      hits.length = 0;
      THREE.Mesh.prototype.raycast.call(target.mesh, raycaster, hits);
      const first = hits.reduce<THREE.Intersection | null>((near, item) => (!near || item.distance < near.distance ? item : near), null);
      if (first && (!best || first.distance < best.hit.distance)) best = { hit: first, target };
    }
    if (!best) return null;
    const object = targets.length > 1 ? best.target.name : undefined;
    const found = snap ? featureAtHit(best.hit, best.target.mesh, camera, canvas) : null;
    const world = found ? found.at : best.hit.point;
    return { at: deps.toPrint(world), kind: found ? found.kind : "surface", ...(object ? { object } : {}) };
  }

  function project(end: End, into: HTMLElement) {
    const rect = canvas.getBoundingClientRect();
    const parent = host?.getBoundingClientRect();
    if (!parent) return null;
    probe.copy(deps.toScene(end.at)).project(camera);
    const behind = probe.z > 1;
    const x = rect.left - parent.left + ((probe.x + 1) / 2) * rect.width;
    const y = rect.top - parent.top + ((1 - probe.y) / 2) * rect.height;
    into.style.left = `${x}px`;
    into.style.top = `${y}px`;
    into.hidden = behind;
    return behind ? null : { x, y };
  }

  function paint() {
    if (!on) return;
    const pa = a ? project(a, dotA) : (dotA.hidden = true, null);
    const pb = b ? project(b, dotB) : (dotB.hidden = true, null);
    if (pa && pb) {
      line.setAttribute("x1", String(pa.x));
      line.setAttribute("y1", String(pa.y));
      line.setAttribute("x2", String(pb.x));
      line.setAttribute("y2", String(pb.y));
      line.style.display = "";
    } else {
      line.style.display = "none";
    }
    if (hover && !(a && b)) {
      project(hover, hoverMark);
      hoverText.textContent = pointLabel(hover);
    } else {
      hoverMark.hidden = true;
    }
  }

  function sync() {
    layer.hidden = !on;
    const ends = [a, b].filter((end): end is End => end !== null);
    if (a && b) {
      readout.hidden = false;
      readout.replaceChildren(...readoutLines(a, b).map((text, i) => Object.assign(document.createElement("div"), { textContent: text, className: i === 0 ? "pm-dist" : "" })));
    } else {
      readout.hidden = !on;
      readout.textContent = a ? "Click a second point. Alt turns the snap off. Esc clears." : "Click a point on any object. It snaps to corners, edge middles and face middles; Alt turns that off.";
    }
    if (on) canvas.dataset.pointMeasure = ends.map((end) => end.at.map((v) => v.toFixed(3)).join(",")).join("|");
    else delete canvas.dataset.pointMeasure;
    if (hover && hover.kind !== "surface") canvas.dataset.measureSnap = `${hover.kind}:${hover.at.map((v) => v.toFixed(3)).join(",")}`;
    else delete canvas.dataset.measureSnap;
    canvas.style.cursor = on ? "crosshair" : "";
    paint();
    deps.redraw();
  }

  /** Each object's features are a pass over its vertices; built one object to a task as Measure turns on, the first hover finds them held. */
  function warm() {
    const jobs = deps.targets().map((target) => () => warmFeatures(target.mesh.geometry.getAttribute("position").array as Float32Array));
    const next = () => {
      jobs.shift()?.();
      if (jobs.length > 0 && on) window.setTimeout(next, 0);
    };
    window.setTimeout(next, 0);
  }

  canvas.addEventListener("pointerdown", (ev) => {
    down = on && ev.button === 0 ? { x: ev.clientX, y: ev.clientY } : null;
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!on || ev.buttons !== 0) return;
    hover = pick(ev, !ev.altKey);
    sync();
  });
  canvas.addEventListener("pointerleave", () => {
    if (!on || !hover) return;
    hover = null;
    sync();
  });
  canvas.addEventListener("pointerup", (ev) => {
    const press = down;
    down = null;
    if (!on || !press || ev.button !== 0) return;
    if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > CLICK_PX) return;
    const end = pick(ev, !ev.altKey);
    if (!end) return;
    if (!a || b) {
      a = end;
      b = null;
    } else {
      b = end;
    }
    hover = null;
    sync();
  });
  window.addEventListener("keydown", (ev) => {
    if (!on || ev.key !== "Escape" || (!a && !b)) return;
    a = null;
    b = null;
    sync();
    ev.stopPropagation();
  }, true);

  return {
    isOn: () => on,
    setOn(next) {
      if (next === on) return;
      on = next;
      if (!on) {
        a = null;
        b = null;
        hover = null;
      } else {
        warm();
      }
      sync();
    },
    clear() {
      if (!a && !b && !hover) return;
      a = null;
      b = null;
      hover = null;
      sync();
    },
    paint,
  };
}
