const GRAB_HINT_KEY = "lime-slice-grab-hint";

/** The first time Ctrl is held over an object, in Prepare or in Model, the status line says what a drag does. It stays quiet after that. */
export function paintGrabHint(over: boolean) {
  const el = document.querySelector<HTMLElement>("#grabHint");
  if (!el) return;
  if (!over) {
    el.hidden = true;
    return;
  }
  try {
    if (localStorage.getItem(GRAB_HINT_KEY)) return;
    localStorage.setItem(GRAB_HINT_KEY, "1");
  } catch {
    if (el.dataset.shown) return;
  }
  el.dataset.shown = "1";
  el.textContent = "Drag to move · Right-drag to turn · X, Y, Z pick the turn axis · Esc cancels";
  el.hidden = false;
}
