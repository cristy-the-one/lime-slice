import { applyTheme, loadTheme, onSchemeChange } from "./theme";
import { mountChrome } from "./ui/chrome";
import { mountLegend } from "./ui/legend";
import { mountLayerTip } from "./ui/layer-tip";
import { fillHelpShortcuts, mountPalette, mountStageTabs } from "./ui/palette";
import { applyStoredLevel, mountShell, syncEmptyState } from "./ui/shell";
import { mountCompact } from "./ui/compact/mount";
import { mountConnection } from "./ui/connection";
import { mountPlatform } from "./platform";
import { mountToasts } from "./ui/toasts";
import { session, state } from "./app/state";
import { activeSection, draw, fitNarrow, mountViews, paintGizmoReadout, prepare, previewCenter, resize, selectedObjectIndex, setHelp, setStage, setView, view3d } from "./app/viewer";
import { probe, renderChrome } from "./app/settings";
import { runSlice, treeSupports } from "./app/slice-run";
import { mountSupportEdits } from "./ui/support-edit-ui";
import { clearSeam, drawSeam, seamStroke } from "./app/seam-actions";
import { mountSeamPaint } from "./ui/seam-paint-ui";
import { mountSupportPaint } from "./ui/support-paint-ui";
import { clearPaint, drawPaint, paintStroke, tallyOf } from "./app/paint-actions";
import { fx } from "./app/fx";
import { plateListed } from "./plate";
import { mountMarkup } from "./app/markup";
import { wireApp } from "./app/wire";

mountMarkup(document.querySelector("#app")!);
mountViews();
wireApp();

new ResizeObserver(() => resize()).observe(document.querySelector("#stage")!);
applyStoredLevel();
applyTheme(loadTheme());
(document.querySelector("#theme") as HTMLSelectElement).value = loadTheme();
onSchemeChange(() => {
  view3d.setTheme();
  prepare.setTheme();
  draw();
});
renderChrome();
fitNarrow();
resize();
view3d.setTheme();
prepare.setTheme();
mountChrome({
  setGizmoTool: (tool) => prepare.setGizmoTool(tool),
  onToolReadout: () => paintGizmoReadout(),
});
mountShell({ setViewPreset: (preset) => prepare.setViewPreset(preset) });
session.supportUi = mountSupportEdits(view3d, {
  view() {
    const layers = state.result?.layers ?? [];
    const low = layers[state.rangeLow];
    const high = layers[state.layer];
    const spec = activeSection();
    const center = previewCenter();
    // On a plate the editor works on the selected object, in that object's part frame.
    const objects = state.result?.objects;
    const result = objects ? (objects[selectedObjectIndex()] ?? null) : state.result;
    // A belt reply's layer z is the belt position, not a height, and its knots are cut by that z.
    const belt = !!result?.skeleton?.ls;
    return {
      result,
      sent: session.slicedEdits,
      edits: state.supportEdits,
      busy: state.busy,
      treeSupports: treeSupports(),
      copies: state.result?.beltCopies,
      visible: {
        zLow: low ? (belt ? low.z : low.z - low.height) : -1e6,
        zHigh: high ? high.z : 1e6,
        section: spec && center ? { center, spec } : null,
      },
      supportShown: !state.hidden.has("support"),
    };
  },
  apply(next) {
    state.supportEdits = next;
    void runSlice(false);
  },
  reveal() {
    if (state.stage !== "preview") setStage("preview");
    if (state.viewMode !== "solid") setView("solid");
  },
});
session.paintUi = mountSupportPaint(prepare, {
  yieldBrush() {
    session.seamUi?.stop();
  },
  view() {
    const listed = plateListed(state.plate);
    const obj = listed ? state.plate.objects.find((o) => o.id === state.plate.selectedId) : undefined;
    const fresh = session.slicedPaint === state.supportPaint;
    return {
      disks: state.supportPaint,
      supportsOn: obj?.settings.supports ?? state.supports,
      tally: fresh ? tallyOf(state.result, selectedObjectIndex()) : null,
      hasMesh: !!state.placed,
    };
  },
  stroke: paintStroke,
  clear: clearPaint,
  reveal() {
    if (state.stage !== "prepare") setStage("prepare");
  },
});
session.seamUi = mountSeamPaint(prepare, {
  view() {
    return { disks: state.seamPaint, hasMesh: !!state.placed };
  },
  stroke: seamStroke,
  clear: clearSeam,
  reveal() {
    if (state.stage !== "prepare") setStage("prepare");
  },
  yieldBrush() {
    session.paintUi?.stop();
  },
  restoreBrush() {
    session.paintUi?.bind();
  },
});
fx.drawPaint = () => {
  drawPaint();
  drawSeam();
};
drawPaint();
drawSeam();
mountConnection(() => {
  void probe();
});
mountPlatform();
mountCompact();
mountToasts();
mountPalette();
mountStageTabs();
fillHelpShortcuts(document.querySelector("#helpShortcuts")!);
mountLegend();
mountLayerTip();
document.addEventListener("lime-open-help", () => setHelp(true));
syncEmptyState(!!state.mesh);
resize();
void probe();
