/** The heads-up box and the feature readout line. */
import { S } from "./state";
import { commitExtrude, endExtrude, extrudeFields, extrudeNote, takeValues } from "./extrude";
import { armProbe, fieldTexts } from "./feature";
import { escapeFeature, leaveEditing } from "./keys";
import { endLoft, scaleOf } from "./loft";
import { armRevolveProbe, commitRevolve, endRevolve, takeRevolveAngle } from "./revolve";
import { armSweepProbe, commitSweep, endSweep, madeSweep, roundedSweep } from "./sweep";
import { drawingFrame, publish } from "./view";
import { type HudField, mountHud } from "../../interact/hud";
import { applyPose } from "../../model-space";
import { type Vec3 } from "../../sketch/model";
import { toWorld } from "../../sketch/frame";
import { sketchDimensions, commitSizes, sketchKey, previewSizes } from "../../sketch/session";
import { regionsCentroid } from "../../sketch/extrude";
import { axisWorld, typedAngle } from "../../sketch/revolve";

export function installHud(): void {
  S.hud = mountHud(S.host.canvas.parentElement ?? document.body);
  S.host.view.watchFocus(S.hud.element);
  S.box = document.createElement("div");
  S.box.className = "sketch-box";
  S.box.hidden = true;
  document.body.append(S.box);
  S.hud.onCommit((commit) => {
    if (S.sweep?.pipe) {
      const wall = commit.values[1];
      S.sweep = roundedSweep(madeSweep({ ...S.sweep, pipe: { ...S.sweep.pipe, diameter: commit.values[0] ?? Number.NaN, wall: wall != null && Number.isFinite(wall) ? wall : S.sweep.pipe.wall } }));
      if (S.sweep.note) {
        publish("skip");
        S.host.readout(S.sweep.note);
        return;
      }
      void commitSweep();
      return;
    }
    if (S.sweep) {
      const value = commit.values[0] ?? Number.NaN;
      if (!(value > 0)) {
        S.host.readout("Each radius and scale is above 0.");
        return;
      }
      const scaleText = commit.texts[0] ?? undefined;
      S.sweep = { ...S.sweep, scale: value, note: "", ...(scaleText ? { scaleText } : {}) };
      void commitSweep();
      return;
    }
    if (S.revolve) {
      const typed = typedAngle(commit.values[0] ?? Number.NaN);
      if ("error" in typed) {
        S.host.readout(typed.error);
        return;
      }
      const angleText = commit.texts[0] ?? undefined;
      S.revolve = { ...S.revolve, angle: typed.angle, follow: false, ...(angleText ? { angleText } : {}) };
      void commitRevolve();
      return;
    }
    if (S.gesture) {
      S.gesture = { ...S.gesture, texts: fieldTexts(extrudeFields(), commit.texts) };
      takeValues(commit.values);
      void commitExtrude();
      return;
    }
    S.editor = commitSizes(S.editor, commit.values, commit.texts);
    publish("open");
  });
  S.hud.onCancel(() => {
    if (S.applying || S.holding) return;
    if (S.sweep) {
      escapeFeature(endSweep);
      return;
    }
    if (S.loft) {
      escapeFeature(endLoft);
      return;
    }
    if (S.revolve) {
      escapeFeature(endRevolve);
      return;
    }
    if (S.gesture) {
      escapeFeature(endExtrude);
      return;
    }
    const next = sketchKey(S.editor, "Escape", { ctrl: false, meta: false, shift: false });
    if (!next) return;
    leaveEditing(next);
  });
  S.hud.onEdit((values) => {
    if (S.sweep?.pipe) {
      const diameter = values[0];
      const wall = values[1];
      if (diameter != null && Number.isFinite(diameter)) S.sweep = roundedSweep(madeSweep({ ...S.sweep, pipe: { ...S.sweep.pipe, diameter, wall: wall != null && Number.isFinite(wall) ? wall : S.sweep.pipe.wall } }));
      publish("skip");
      armSweepProbe();
      return;
    }
    if (S.sweep) {
      const value = values[0];
      if (value != null && value > 0) S.sweep = { ...S.sweep, scale: value, note: "" };
      publish("skip");
      armSweepProbe();
      return;
    }
    if (S.revolve) {
      takeRevolveAngle(values[0] ?? S.revolve.angle);
      publish("skip");
      armRevolveProbe();
      return;
    }
    if (S.gesture) {
      takeValues(values);
      publish("skip");
      armProbe();
      return;
    }
    S.editor = previewSizes(S.editor, values);
    publish("skip");
  });
}

/** The open feature's refusal, for under the box. */
export function featureNote(): string {
  if (S.editor.phase !== "editing") return "";
  if (S.sweep) return S.sweep.note;
  if (S.revolve) return S.revolveNote;
  if (S.gesture) return extrudeNote();
  return "";
}

export function syncHud(mode: "open" | "values" | "skip") {
  S.hud.setParams(S.host.parameters());
  if (mode === "skip") return;
  if (S.sweep && S.editor.phase === "editing") {
    const fields: HudField[] = S.sweep.pipe
      ? [
          { id: "diameter", label: "Diameter", unit: "mm", value: S.sweep.pipe.diameter },
          { id: "wall", label: "Wall", unit: "mm", value: S.sweep.pipe.wall },
        ]
      : [{ id: "scale", label: "End scale", unit: "×", value: scaleOf(S.sweep.scale) }];
    const anchor = featureAnchor();
    const at = anchor?.at ?? pointerAt();
    if (mode === "open" || !S.hud.shown) S.hud.open(fields, at, S.host.parameters());
    else S.hud.setValues(fields.map((field) => field.value));
    S.hud.move(at, anchor?.dir);
    return;
  }
  if (S.loft && S.editor.phase === "editing") {
    S.hud.close();
    return;
  }
  if (S.revolve && S.editor.phase === "editing") {
    const fields: HudField[] = [{ id: "angle", label: "Angle", unit: "°", value: S.revolve.angle }];
    const anchor = featureAnchor();
    const at = anchor?.at ?? pointerAt();
    if (mode === "open" || !S.hud.shown) S.hud.open(fields, at, S.host.parameters());
    else S.hud.setValues(fields.map((field) => field.value));
    S.hud.move(at, anchor?.dir);
    return;
  }
  if (S.gesture && S.editor.phase === "editing") {
    const fields = extrudeFields();
    const anchor = featureAnchor();
    const at = anchor?.at ?? pointerAt();
    if (mode === "open" || !S.hud.shown) S.hud.open(fields, at, S.host.parameters());
    else S.hud.setValues(fields.map((field) => field.value));
    S.hud.move(at, anchor?.dir);
    return;
  }
  const dims = sketchDimensions(S.editor);
  if (!dims) {
    S.hud.close();
    return;
  }
  const at = pointerAt();
  if (mode === "open" || !S.hud.shown) S.hud.open(dims.fields, at, S.host.parameters());
  else S.hud.setValues(dims.fields.map((field) => field.value));
  S.hud.move(at);
}

function pointerAt(): { x: number; y: number } {
  const parent = S.host.canvas.parentElement?.getBoundingClientRect();
  if (!parent) return { x: 24, y: 24 };
  return { x: S.lastClient.x - parent.left + 16, y: S.lastClient.y - parent.top + 16 };
}

function toParent(point: { x: number; y: number } | null): { x: number; y: number } | null {
  const parent = S.host.canvas.parentElement?.getBoundingClientRect();
  if (!point || !parent) return null;
  return { x: point.x - parent.left, y: point.y - parent.top };
}

/** The open feature's handle, in the HUD parent's coordinates, and its screen direction. */
function featureAnchor(): { at: { x: number; y: number }; dir: { x: number; y: number } } | null {
  const frame = drawingFrame();
  if (S.gesture && frame && S.gesture.regions.length > 0) {
    const centre = toWorld(frame, regionsCentroid(S.gesture.regions));
    const tip: Vec3 = [centre[0] + frame.w[0] * S.gesture.distance, centre[1] + frame.w[1] * S.gesture.distance, centre[2] + frame.w[2] * S.gesture.distance];
    const from = toParent(S.host.view.projectPoint(centre));
    const at = toParent(S.host.view.projectPoint(tip));
    if (!at) return null;
    return { at, dir: from ? { x: at.x - from.x, y: at.y - from.y } : { x: 0, y: -1 } };
  }
  if (S.revolve && frame && S.revolve.regions.length > 0) {
    const centre = toWorld(frame, regionsCentroid(S.revolve.regions));
    const axis = axisWorld(frame, S.revolve.axis);
    const tip: Vec3 = [centre[0] + axis[0], centre[1] + axis[1], centre[2] + axis[2]];
    const from = toParent(S.host.view.projectPoint(centre));
    const at = toParent(S.host.view.projectPoint(tip));
    if (!from) return null;
    return { at: from, dir: at ? { x: at.x - from.x, y: at.y - from.y } : { x: 0, y: -1 } };
  }
  if (S.sweep && S.sweep.path.length >= 1) {
    const last = S.sweep.path[S.sweep.path.length - 1]!;
    const prev = S.sweep.path[S.sweep.path.length - 2] ?? last;
    const end = toParent(S.host.view.projectPoint(applyPose(S.host.pose(), last)));
    const before = toParent(S.host.view.projectPoint(applyPose(S.host.pose(), prev)));
    if (!end) return null;
    return { at: end, dir: before ? { x: end.x - before.x, y: end.y - before.y } : { x: 0, y: -1 } };
  }
  return null;
}
