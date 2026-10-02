export type HapticKind = "tap" | "snap" | "success";

/**
 * Browser vibration when the device exposes it.
 * TODO(iOS Tauri haptics plugin): no-op until a native plugin exists. Do not call desktop-only APIs here.
 */
export function haptic(kind: HapticKind = "tap") {
  const ms = kind === "snap" ? 12 : kind === "success" ? 20 : 8;
  const vibrate = navigator.vibrate?.bind(navigator);
  if (!vibrate) return;
  vibrate(ms);
}
