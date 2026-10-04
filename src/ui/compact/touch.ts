import { haptic } from "../haptics";

export function mountCompactTouch(hooks: {
  toggleChrome(): void;
  onFit(): void;
  onLongPress(x: number, y: number): void;
}) {
  for (const id of ["#prepare", "#view3d", "#view"]) {
    const canvas = document.querySelector<HTMLCanvasElement>(id);
    if (!canvas || canvas.dataset.compactTouch === "1") continue;
    canvas.dataset.compactTouch = "1";
    wire(canvas, hooks);
  }
}

function compact() {
  return document.documentElement.classList.contains("layout-compact");
}

/** The support brush is on: a tap paints, so it neither hides the chrome nor opens the menu. */
function painting() {
  return document.documentElement.dataset.supportPaint === "1";
}

function wire(
  canvas: HTMLCanvasElement,
  hooks: { toggleChrome(): void; onFit(): void; onLongPress(x: number, y: number): void },
) {
  let startX = 0;
  let startY = 0;
  let moved = false;
  let lastTap = 0;
  let hold = 0;
  let single = 0;
  let pressed = false;
  let held = false;
  let consumed = false;

  canvas.addEventListener("pointerdown", (ev) => {
    if (!compact() || ev.button !== 0) return;
    if (ev.pointerType === "touch" && !ev.isPrimary) return;
    startX = ev.clientX;
    startY = ev.clientY;
    moved = false;
    held = false;
    pressed = true;
    // Gizmo, section, and view-helper hits call preventDefault in capture.
    // Those are tool taps. Empty canvas does not.
    consumed = ev.defaultPrevented;
    window.clearTimeout(hold);
    hold = window.setTimeout(() => {
      if (!pressed || moved || !compact() || painting()) return;
      held = true;
      haptic("snap");
      if (document.documentElement.dataset.supportEdit === "1") {
        window.dispatchEvent(new CustomEvent("lime-support-hold"));
        return;
      }
      hooks.onLongPress(startX, startY);
    }, 500);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!pressed) return;
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 10) {
      moved = true;
      window.clearTimeout(hold);
    }
  });
  const finish = (ev: PointerEvent) => {
    if (!pressed) return;
    pressed = false;
    window.clearTimeout(hold);
    if (document.documentElement.dataset.supportEdit === "1" || painting()) return;
    if (!compact() || moved || held || consumed || ev.button !== 0) return;
    const now = performance.now();
    if (now - lastTap < 280) {
      lastTap = 0;
      window.clearTimeout(single);
      haptic("tap");
      hooks.onFit();
      return;
    }
    lastTap = now;
    window.clearTimeout(single);
    single = window.setTimeout(() => {
      if (compact()) hooks.toggleChrome();
    }, 280);
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", () => {
    pressed = false;
    window.clearTimeout(hold);
    window.clearTimeout(single);
  });
}
