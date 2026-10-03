/**
 * Where the page is running, and which chrome it should use.
 * Desktop window APIs stay behind `isDesktopShell` so a later iOS shell never calls them.
 *
 * TODO(iOS Tauri): gate `tauri-plugin-window-state` and `setDecorations` with `#[cfg(desktop)]`
 * in src-tauri. The web layer already skips those calls when this is not a desktop shell.
 */

export const LAYOUT_STORAGE_KEY = "lime-slice-layout";

export type LayoutChoice = "auto" | "desktop" | "compact";
export type ResolvedLayout = "desktop" | "compact";
export type EngineMode = "invoke" | "http";

export interface LayoutInput {
  query: string | null;
  stored: string | null;
  width: number;
  height: number;
  coarse: boolean;
  mobileUa: boolean;
}

export function isTauri(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** In-process invoke inside Tauri. The browser, including compact layout, uses HTTP. */
export function engineMode(): EngineMode {
  return isTauri() ? "invoke" : "http";
}

export function normalizeLayoutChoice(value: string | null | undefined): LayoutChoice | null {
  if (value === "auto" || value === "desktop" || value === "compact") return value;
  return null;
}

/**
 * `?layout=` wins, then the saved Interface layout, then auto.
 * Auto is compact when the width is at most 600px, or when a coarse/mobile
 * pointer is on a short viewport (phone landscape). An iPad-sized window stays desktop.
 */
export function resolveLayout(input: LayoutInput): ResolvedLayout {
  const query = normalizeLayoutChoice(input.query);
  if (query === "desktop" || query === "compact") return query;
  const stored = normalizeLayoutChoice(input.stored);
  if (stored === "desktop" || stored === "compact") return stored;
  if (input.width <= 600) return "compact";
  const shortSide = Math.min(input.width, input.height);
  if ((input.coarse || input.mobileUa) && shortSide <= 500) return "compact";
  return "desktop";
}

export function readLayoutInput(): LayoutInput {
  const params = new URLSearchParams(location.search);
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const ua = navigator.userAgent;
  const mobileUa = /iPhone|iPad|iPod|Android/i.test(ua);
  return {
    query: params.get("layout"),
    stored: localStorage.getItem(LAYOUT_STORAGE_KEY),
    width: window.innerWidth,
    height: window.innerHeight,
    coarse,
    mobileUa,
  };
}

export function currentLayout(): ResolvedLayout {
  return resolveLayout(readLayoutInput());
}

export function isMobileLayout(): boolean {
  return document.documentElement.classList.contains("layout-compact");
}

/** Window decorations and window-state apply only here, and never in compact layout. */
export function isDesktopShell(): boolean {
  return isTauri() && !isMobileLayout();
}

export function applyLayout(): ResolvedLayout {
  const resolved = currentLayout();
  document.documentElement.classList.toggle("layout-compact", resolved === "compact");
  document.documentElement.dataset.layout = resolved;
  document.documentElement.style.setProperty("--layout-mode", resolved);
  window.dispatchEvent(new CustomEvent("lime-layout", { detail: resolved }));
  return resolved;
}

export function saveLayoutChoice(choice: LayoutChoice) {
  localStorage.setItem(LAYOUT_STORAGE_KEY, choice);
  applyLayout();
}

/** Browser file input. TODO(iOS plugins): document picker. */
export function pickModelFile() {
  document.querySelector<HTMLInputElement>("#file")?.click();
}

/** Browser file input. TODO(iOS plugins): document picker. */
export function pickProjectFile() {
  const input = document.querySelector<HTMLInputElement>("#projectFile");
  if (!input) return;
  input.value = "";
  input.click();
}

/**
 * Browser save downloads the JSON. The desktop shell reuses the Tauri save
 * command, which already asks through tauri-plugin-dialog and writes the file.
 * TODO(iOS plugins): share sheet.
 * Returns false when the desktop dialog is cancelled.
 */
export async function saveProjectText(text: string, name: string): Promise<boolean> {
  if (isDesktopShell()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("save_text_file", { text, defaultName: name, extension: "lime" });
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}

/**
 * Browser export is the existing download path.
 * TODO(iOS plugins): share sheet. `navigator.share` is used when the export
 * button is enabled and the platform can share a text file; otherwise the
 * existing download runs.
 */
export async function saveGcode() {
  const button = document.querySelector<HTMLButtonElement>("#export");
  if (!button || button.disabled) return;
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (nav.share && nav.canShare?.({ text: "gcode" })) {
    try {
      await nav.share({ title: "Lime Slice G-code", text: "G-code from Lime Slice" });
      return;
    } catch {
      /* user dismissed the sheet, or the payload was rejected; fall through */
    }
  }
  button.click();
}

export function mountPlatform() {
  applyLayout();
  window.addEventListener("resize", () => applyLayout());
  window.addEventListener("orientationchange", () => applyLayout());
  const panel = document.querySelector("#gear .gear-panel");
  if (!panel || document.querySelector("#layoutChoice")) return;
  const label = document.createElement("label");
  label.className = "field";
  label.innerHTML = `Interface layout
    <select id="layoutChoice" aria-label="Interface layout">
      <option value="auto">Auto</option>
      <option value="desktop">Desktop</option>
      <option value="compact">Compact (phone)</option>
    </select>`;
  panel.append(label);
  const select = label.querySelector<HTMLSelectElement>("select")!;
  const stored = normalizeLayoutChoice(localStorage.getItem(LAYOUT_STORAGE_KEY)) ?? "auto";
  select.value = stored;
  select.addEventListener("change", () => {
    const choice = normalizeLayoutChoice(select.value) ?? "auto";
    saveLayoutChoice(choice);
  });
}
