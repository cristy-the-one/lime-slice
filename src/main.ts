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
    return {
      result: objects ? (objects[selectedObjectIndex()] ?? null) : state.result,
      sent: session.slicedEdits,
      edits: state.supportEdits,
      busy: state.busy,
      treeSupports: treeSupports(),
      visible: {
        zLow: low ? low.z - low.height : -1e6,
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
