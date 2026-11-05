/** The pointer handlers of the sketch view. */
import { S } from "./state";
import { paintDataset } from "./dataset";
import { commitOpenLabel } from "./dimensions";
import { extrudePointer } from "./extrude";
import { syncHud } from "./hud";
import { loftPointer } from "./loft";
import { revolvePointer } from "./revolve";
import { sweepPointer } from "./sweep";
import { chooseAt, draw, drawingFrame, enterFace, enterNamed, publish } from "./view";
import { rayOnPlane, toWorld } from "../../sketch/frame";
import { sketchBusy, beginChoose, sketchPointer } from "../../sketch/session";

export function installPointer(): void {
  S.host.canvas.addEventListener("dblclick", (ev) => {
    if (sketchBusy(S.editor) || S.host.pullArmed()) return;
    const hit = S.host.view.pickSolid(ev.clientX, ev.clientY);
    if (!hit) return;
    ev.preventDefault();
    ev.stopPropagation();
    S.host.closeTool();
    S.editor = beginChoose(S.editor);
    enterFace(hit.face);
  });
  S.host.view.onSketchPointer((ev) => {
    S.lastClient = { x: ev.x, y: ev.y };
    if (S.applying || S.holding) return;
    if (S.editor.phase === "choosing") {
      const hit = chooseAt(ev.x, ev.y);
      S.editor = { ...S.editor, hotPlane: hit?.kind === "plane" ? hit.name : null };
      if (ev.phase === "down") S.chooseDown = { x: ev.x, y: ev.y };
      if (ev.phase === "up" && S.chooseDown) {
        const moved = (ev.x - S.chooseDown.x) ** 2 + (ev.y - S.chooseDown.y) ** 2 > 16;
        S.chooseDown = null;
        if (!moved && hit) {
          if (hit.kind === "face") enterFace(hit.face);
          else enterNamed(hit.name);
          return;
        }
      }
      publish("skip");
      return;
    }
    if (ev.phase === "down") {
      S.menuOpen = null;
      // A press on the canvas leaves an open dimension label: its typed value is set first.
      const label = S.labels.querySelector<HTMLInputElement>("input.sketch-dim-input");
      if (label) commitOpenLabel(label);
    }
    if (S.editor.phase !== "editing" || S.editor.lookAround) return;
    const frame = drawingFrame();
    if (!frame) return;
    if (S.revolve) {
      revolvePointer(ev, frame);
      return;
    }
    if (S.sweep) {
      sweepPointer(ev, frame);
      return;
    }
    if (S.loft) {
      loftPointer(ev);
      return;
    }
    if (S.gesture) {
      extrudePointer(ev, frame);
      return;
    }
    const ray = S.host.view.pointerRay(ev.x, ev.y);
    const hit = rayOnPlane(frame, ray.origin, ray.direction);
    const uv = hit?.uv ?? S.editor.cursor ?? [0, 0];
    S.editor = sketchPointer(S.editor, {
      phase: ev.phase,
      uv,
      sx: ev.x,
      sy: ev.y,
      shift: ev.shift,
      ctrl: ev.ctrl,
      alt: ev.alt,
      double: ev.double,
    }, {
      mmPerPx: Math.max(S.host.view.sketchView().mmPerPx, 1e-4),
      project: (at) => S.host.view.projectPoint(toWorld(frame, at)),
    });
    publish(ev.phase === "move" ? "values" : "open");
  });
  S.host.view.onSketchView(() => {
    if (S.editor.phase !== "editing" && S.editor.phase !== "choosing") return;
    draw();
    // The tilt runs after the feature opens. Hits, and the value box on the handle, follow the camera.
    paintDataset();
    if (S.gesture || S.revolve || S.sweep) syncHud("values");
  });
}
