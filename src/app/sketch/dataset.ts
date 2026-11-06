/** The canvas dataset the e2e specs read, and the size box. */
import { S } from "./state";
import { resolvedMode } from "./extrude";
import { resolvedLoftMode, scaleOf } from "./loft";
import { resolvedRevolveMode } from "./revolve";
import { resolvedSweepMode } from "./sweep";
import { drawingFrame } from "./view";
import { refreshModelRailTips } from "../../ui/model-chrome";
import { toWorld } from "../../sketch/frame";
import { boxCrosses } from "../../sketch/hit";
import { activeSketch } from "../../sketch/session";
import { placedStatus, dimensionLabels, firstLineMeasure } from "../../sketch/constrain";
import { parseConstraints } from "../../sketch/solve";

export function installDatasetDefaults(): void {
  S.host.canvas.dataset.sketch = "off";
  // Not `data-sketch-tool`: the card's tool buttons carry that, and a locator for one must not also match the canvas.
  S.host.canvas.dataset.sketchCurrentTool = "";
  S.host.canvas.dataset.sketchEntities = "0";
  S.host.canvas.dataset.sketchPlane = "";
  S.host.canvas.dataset.sketchLook = "0";
  S.host.canvas.dataset.sketchKinds = "";
  S.host.canvas.dataset.sketchConstruction = "0";
  S.host.canvas.dataset.sketchDims = "0";
  S.host.canvas.dataset.sketchDefined = "";
  S.host.canvas.dataset.sketchDof = "";
  S.host.canvas.dataset.sketchConstraints = "0";
  S.host.canvas.dataset.sketchInfer = "";
  S.host.canvas.dataset.extrude = "off";
  S.host.canvas.dataset.extrudeMode = "";
  S.host.canvas.dataset.extrudeDepth = "";
  S.host.canvas.dataset.extrudeRegions = "0";
  // --- F2 ---
  S.host.canvas.dataset.revolve = "off";
  S.host.canvas.dataset.revolveMode = "";
  S.host.canvas.dataset.revolveAngle = "";
  S.host.canvas.dataset.revolveAxis = "";
  S.host.canvas.dataset.revolveRegions = "0";
  S.host.canvas.dataset.revolveCross = "0";
  // --- F3 ---
  S.host.canvas.dataset.loft = "off";
  S.host.canvas.dataset.loftMode = "";
  S.host.canvas.dataset.loftSections = "0";
  S.host.canvas.dataset.loftRuled = "0";
  S.host.canvas.dataset.sweep = "off";
  S.host.canvas.dataset.sweepMode = "";
  S.host.canvas.dataset.sweepScale = "";
  S.host.canvas.dataset.sweepPath = "0";
  S.host.canvas.dataset.sweepProfile = "0";
  S.host.canvas.dataset.sweepMade = "";
  S.host.canvas.dataset.sweepRound = "";
  S.host.canvas.dataset.sketchDemo = "";
  S.host.canvas.dataset.sketchDemoMade = "";
}

export function paintDataset() {
  const sketch = activeSketch(S.editor) ?? (S.editor.phase === "pinned" ? S.editor.pinned[S.editor.pinned.length - 1]?.sketch : null);
  const on = sketch?.on;
  S.host.canvas.dataset.sketch = S.editor.phase;
  S.host.canvas.dataset.sketchCurrentTool = S.editor.phase === "editing" ? S.editor.tool : "";
  S.host.canvas.dataset.sketchEntities = String(sketch?.entities.length ?? 0);
  S.host.canvas.dataset.sketchPlane = on?.kind === "plane" ? on.name : on?.kind === "face" ? `face ${on.face.index}` : on?.kind === "workplane" ? "workplane" : "";
  S.host.canvas.dataset.sketchLook = S.editor.lookAround ? "1" : "0";
  S.host.canvas.dataset.sketchKinds = sketch?.entities.map((entity) => entity.kind).join(",") ?? "";
  S.host.canvas.dataset.sketchConstruction = String(sketch?.entities.filter((entity) => entity.construction).length ?? 0);
  // Where the plane's origin and 10 mm along its X and Y fall on screen, for a script that draws by the plane's numbers.
  const drawn = S.editor.phase === "editing" ? drawingFrame() : null;
  const marks = drawn ? ([[0, 0], [10, 0], [0, 10]] as [number, number][]).map((at) => S.host.view.projectPoint(toWorld(drawn, at))) : [];
  if (marks.length === 3 && marks.every((mark) => mark)) S.host.canvas.dataset.sketchFrame = marks.map((mark) => `${mark!.x.toFixed(1)},${mark!.y.toFixed(1)}`).join(" ");
  else delete S.host.canvas.dataset.sketchFrame;
  S.host.canvas.dataset.sketchProfile = S.profile ? "1" : "";
  const status = sketch && S.editor.phase === "editing" ? placedStatus(sketch) : null;
  S.host.canvas.dataset.sketchDims = String(sketch && S.editor.phase === "editing" ? dimensionLabels(sketch).length : 0);
  const exprs = sketch && S.editor.phase === "editing" ? (sketch.dims ?? []).map((dim) => dim.expr).filter((expr): expr is string => !!expr).join("\n") : "";
  if (exprs) S.host.canvas.dataset.sketchExprs = exprs;
  else delete S.host.canvas.dataset.sketchExprs;
  if (S.editor.phase === "editing" && (S.gesture || S.revolve || S.loft || S.sweep)) S.host.canvas.dataset.sketchFeature = "1";
  else delete S.host.canvas.dataset.sketchFeature;
  refreshModelRailTips();
  S.host.canvas.dataset.sketchDefined = status ? (status.fullyDefined ? "1" : "0") : "";
  S.host.canvas.dataset.sketchDof = status ? String(status.dof) : "";
  S.host.canvas.dataset.sketchConstraints = String(sketch && S.editor.phase === "editing" ? parseConstraints(sketch).length : 0);
  const measure = sketch && S.editor.phase === "editing" ? firstLineMeasure(sketch) : null;
  if (measure) S.host.canvas.dataset.sketchMeasure = `${measure.length.toFixed(3)},${measure.rise.toFixed(3)}`;
  else delete S.host.canvas.dataset.sketchMeasure;
  const shown = S.gesture && S.editor.phase === "editing" ? S.gesture : null;
  S.host.canvas.dataset.extrude = shown ? (shown.dragging ? "drag" : "aim") : "off";
  S.host.canvas.dataset.extrudeMode = shown ? resolvedMode() : "";
  S.host.canvas.dataset.extrudeDepth = shown ? String(shown.distance) : "";
  S.host.canvas.dataset.extrudeRegions = shown ? String(shown.regions.length) : "0";
  const spun = S.revolve && S.editor.phase === "editing" ? S.revolve : null;
  S.host.canvas.dataset.revolve = spun ? (spun.dragging ? "drag" : "aim") : "off";
  S.host.canvas.dataset.revolveMode = spun ? resolvedRevolveMode() : "";
  S.host.canvas.dataset.revolveAngle = spun ? String(spun.angle) : "";
  S.host.canvas.dataset.revolveAxis = spun ? spun.axis.kind : "";
  S.host.canvas.dataset.revolveRegions = spun ? String(spun.regions.length) : "0";
  S.host.canvas.dataset.revolveCross = spun && spun.crossing ? "1" : "0";
  const lofting = S.loft && S.editor.phase === "editing" ? S.loft : null;
  S.host.canvas.dataset.loft = lofting ? "pick" : "off";
  S.host.canvas.dataset.loftMode = lofting ? resolvedLoftMode() : "";
  S.host.canvas.dataset.loftSections = lofting ? String(lofting.picks.length) : "0";
  S.host.canvas.dataset.loftRuled = lofting?.ruled ? "1" : "0";
  const sweeping = S.sweep && S.editor.phase === "editing" ? S.sweep : null;
  S.host.canvas.dataset.sweep = sweeping ? (sweeping.dragging ? "aim" : "pick") : "off";
  S.host.canvas.dataset.sweepMode = sweeping ? resolvedSweepMode() : "";
  S.host.canvas.dataset.sweepScale = sweeping ? String(scaleOf(sweeping.scale)) : "";
  S.host.canvas.dataset.sweepPath = sweeping && sweeping.path.length >= 2 ? "1" : "0";
  S.host.canvas.dataset.sweepProfile = sweeping?.profile ? "1" : "0";
  S.host.canvas.dataset.sweepMade = sweeping?.pipe ? "pipe" : sweeping?.oneSketch ? sweeping.oneSketch.stance : "";
  // S3: the corner radius while Round corners is on, "off" while it is offered but off.
  S.host.canvas.dataset.sweepRound = sweeping?.round ? (sweeping.round.on ? String(sweeping.round.radius) : "off") : "";
  S.host.canvas.dataset.sketchDemo = S.demo?.kind ?? "";
  // O1 and C1: Offset's wall options, and Shift+X's helper lines, for tests.
  const wallOn = S.editor.draw.wall;
  S.host.canvas.dataset.sketchWall = [wallOn.both ? "both" : "", wallOn.close ? "close" : "", wallOn.helper ? "helper" : ""].filter(Boolean).join(",");
  S.host.canvas.dataset.sketchHelperLine = S.editor.phase === "editing" && S.editor.helperLine ? "1" : "";
  // Milestone 6: where an Edit tool's demo wants its next click, in client pixels, for tests.
  const aimFrame = S.demo?.aim && S.editor.phase === "editing" ? drawingFrame() : null;
  const aimAt = aimFrame && S.demo?.aim ? S.host.view.projectPoint(toWorld(aimFrame, S.demo.aim)) : null;
  if (aimAt) S.host.canvas.dataset.sketchDemoAim = `${aimAt.x.toFixed(1)},${aimAt.y.toFixed(1)}`;
  else delete S.host.canvas.dataset.sketchDemoAim;
  S.host.canvas.dataset.sketchMarks = String(S.redShown.count);
  S.host.canvas.dataset.sketchMarksKind = S.redShown.kind;
  // --- F4. Off unless the Hole panel is placing one hole per point. Hits are client pixels, for tests. ---
  const holeCount = S.host.sketchHoleCount();
  S.host.canvas.dataset.sketchHoles = holeCount == null ? "off" : String(holeCount);
  if (S.editor.phase === "editing") {
    const frame = drawingFrame();
    const drawn = activeSketch(S.editor);
    const hits: string[] = [];
    if (frame && drawn) {
      for (const point of drawn.points) {
        const at = S.host.view.projectPoint(toWorld(frame, point.at));
        if (at) hits.push(`${point.id}:${at.x.toFixed(1)},${at.y.toFixed(1)}`);
      }
    }
    S.host.canvas.dataset.sketchHits = hits.join(" ");
    S.host.canvas.dataset.sketchSelected = S.editor.selection.points.join(",");
  } else {
    delete S.host.canvas.dataset.sketchHits;
    delete S.host.canvas.dataset.sketchSelected;
  }
}

export function paintBox() {
  const drag = S.editor.box;
  if (!drag || S.editor.phase !== "editing") {
    S.box.hidden = true;
    return;
  }
  const x = Math.min(drag.sx, drag.x);
  const y = Math.min(drag.sy, drag.y);
  S.box.hidden = false;
  S.box.dataset.cross = boxCrosses(drag.sx, drag.x) ? "1" : "0";
  S.box.style.left = `${x}px`;
  S.box.style.top = `${y}px`;
  S.box.style.width = `${Math.abs(drag.x - drag.sx)}px`;
  S.box.style.height = `${Math.abs(drag.y - drag.sy)}px`;
}
