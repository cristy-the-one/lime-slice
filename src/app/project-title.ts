/** The name in the title bar. Null is an untitled project. */
import { isTauri } from "../platform.ts";
import { session } from "./state.ts";

export const UNTITLED = "Untitled";

export function setProjectTitle(name: string | null) {
  const trimmed = name?.trim() ?? "";
  session.projectTitle = trimmed ? trimmed : null;
  paintProjectTitle();
}

export function paintProjectTitle() {
  const label = session.projectTitle ?? UNTITLED;
  const node = document.querySelector("#projectTitle");
  if (node) node.textContent = label;
  document.title = `${label} — Lime Slice`;
  if (!isTauri()) return;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(`${label} — Lime Slice`))
    .catch(() => undefined);
}
