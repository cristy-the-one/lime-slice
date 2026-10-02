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
import { state } from "./app/state";
import { draw, fitNarrow, mountViews, paintGizmoReadout, prepare, resize, setHelp, view3d } from "./app/viewer";
import { probe, renderChrome } from "./app/settings";
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
