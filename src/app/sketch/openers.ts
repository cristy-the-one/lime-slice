/** How History Edit and Split to print open a sketch. */
import { S } from "./state";
import { endEditSession } from "./feature";
import { closeQuietly, dropProfile } from "./profile";
import type { LoftPick } from "./types";
import { publish } from "./view";
import { enterSketchData, activeSketch, finishSketch, pinSketch, withTool } from "../../sketch/session";
import { regionsOfOutlines, chooseRegions } from "../../sketch/extrude";
import { regionsForEdit, regionCrossesAxis } from "../../sketch/revolve";

export function installOpeners(): void {
  S.openFeatureImpl = (sketch, preset, outlines) => {
    S.host.closeTool();
    S.editor = enterSketchData(endEditSession(S.editor), sketch);
    S.editSession = true;
    S.editCards = S.editor.active != null ? [S.editor.active] : [];
    S.editOutlines = [...outlines];
    const slots: 1 | 2 | 3 = preset.draftDeg != null && preset.draftDeg !== 0 ? 3 : preset.depth2 != null && preset.depth2 > 0 ? 2 : 1;
    S.revolve = null;
    S.loft = null;
    S.sweep = null;
    const drawn = activeSketch(S.editor) ?? sketch;
    const found = regionsOfOutlines(drawn, outlines);
    S.gesture = {
      slots,
      distance: preset.distance,
      depth2: preset.depth2,
      draft: preset.draftDeg,
      upTo: preset.upTo,
      choice: preset.choice,
      regions: found.length > 0 ? found : chooseRegions(drawn, [], null),
      dragging: false,
      guide: null,
      down: null,
    };
    S.aimKey = "";
    S.refsKey = "";
    publish("open");
  };
  S.openRevolveImpl = (sketch, preset, outlines) => {
    S.host.closeTool();
    S.editor = enterSketchData(endEditSession(S.editor), sketch);
    S.editSession = true;
    S.editCards = S.editor.active != null ? [S.editor.active] : [];
    S.editOutlines = [...outlines];
    S.gesture = null;
    S.loft = null;
    S.sweep = null;
    const drawn = activeSketch(S.editor) ?? sketch;
    const regions = regionsForEdit(drawn, outlines);
    S.revolveNote = "";
    S.revolve = {
      angle: preset.angleDeg,
      axis: preset.axis,
      follow: false,
      choice: preset.choice,
      regions,
      dragging: false,
      crossing: regions.some((region) => regionCrossesAxis(region, preset.axis)),
      down: null,
    };
    S.aimKey = "";
    S.refsKey = "";
    publish("open");
  };
  S.openLoftImpl = (preset) => {
    S.host.closeTool();
    // The cards already on screen stay. The edit's own sections are cards of their own, which go when the edit ends.
    S.editor = endEditSession(S.editor);
    if (S.editor.phase === "editing") S.editor = finishSketch(S.editor);
    const before = new Set(S.editor.pinned.map((item) => item.id));
    S.editSession = true;
    S.gesture = null;
    S.revolve = null;
    if (preset.kind === "sweep") {
      if (preset.pathSketch) S.editor = pinSketch(S.editor, preset.pathSketch, "Path");
      S.editor = enterSketchData(S.editor, preset.profile);
      const drawn = activeSketch(S.editor) ?? preset.profile;
      const profile = chooseRegions(drawn, [], null)[0] ?? null;
      S.sweep = {
        profileSketch: drawn,
        profile,
        pathSketch: preset.pathSketch,
        path: preset.path.map((point) => [point[0], point[1], point[2]]),
        check: preset.path.map(() => true),
        scale: preset.scale,
        edges: [...preset.edges],
        choice: preset.choice,
        dragging: false,
        down: null,
        note: "",
      };
      S.loft = null;
    } else {
      const real = preset.sketches.map((sketch, index) => ({ sketch, index })).filter((item) => item.sketch);
      const active = real.at(-1);
      let nameAt = 1;
      for (const item of real) {
        if (item === active || !item.sketch) continue;
        S.editor = pinSketch(S.editor, item.sketch, `Section ${nameAt}`);
        nameAt += 1;
      }
      const drawn = active?.sketch ?? preset.sketches.find((sketch) => sketch) ?? null;
      if (drawn) S.editor = enterSketchData(S.editor, drawn);
      const own = S.editor.pinned.filter((item) => !before.has(item.id));
      const picks: LoftPick[] = preset.sections.map((section, index) => {
        const sketch = preset.sketches[index] ?? null;
        const pinned = sketch ? own.find((item) => item.sketch === sketch || JSON.stringify(item.sketch) === JSON.stringify(sketch)) : undefined;
        return {
          key: pinned ? `sketch:${pinned.id}` : `section:${index}`,
          sketchId: pinned?.id ?? null,
          sketch,
          section,
        };
      });
      S.loft = { picks, ruled: preset.ruled, choice: preset.choice, note: "" };
      S.sweep = null;
    }
    S.editCards = S.editor.pinned.filter((item) => !before.has(item.id)).map((item) => item.id);
    S.aimKey = "";
    S.refsKey = "";
    publish("open");
  };
  S.openProfileImpl = (request) => {
    dropProfile();
    S.gesture = null;
    S.revolve = null;
    S.loft = null;
    S.sweep = null;
    S.editor = endEditSession(S.editor);
    if (S.editor.phase === "editing") S.editor = finishSketch(S.editor);
    S.profile = request;
    S.editor = enterSketchData(S.editor, request.sketch);
    if (request.sketch.entities.length === 0) S.editor = withTool(S.editor, "line");
    S.aimKey = "";
    S.refsKey = "";
    publish("open");
  };
  // Model closes the sketch: a history jump, holes from it applied, or Model left. What Model says then stays.
  S.closeFeatureImpl = () => {
    S.keepReadout = true;
    try {
      closeQuietly();
    } finally {
      S.keepReadout = false;
      S.saidLast = false;
    }
  };
}
