import { mountSettingsPanel } from "./settings-panel";
import { mountSplitters } from "./splitters";
import { mountTitlebar } from "./titlebar";
import { mountViewport, type ViewPreset } from "./viewport";
import "./shell.css";

export { applyStoredLevel, levelBarHtml, paintSettingMarks } from "./settings-panel";
export { syncEmptyState } from "./viewport";
export type { ViewPreset } from "./viewport";

export function mountShell(hooks: { setViewPreset(preset: ViewPreset): void }) {
  mountTitlebar();
  mountSplitters();
  mountSettingsPanel();
  mountViewport(hooks);
}
