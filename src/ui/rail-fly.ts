import { computePosition, offset, shift } from "@floating-ui/dom";

/**
 * The rail's flyouts: a button with `data-fly` opens the panel it controls beside the rail. One is open at a time.
 * A click outside, Esc, or a stage switch closes it; Esc gives the focus back to its button.
 */
export function mountRailFlyouts(rail: HTMLElement) {
  let open: { button: HTMLButtonElement; panel: HTMLElement } | null = null;

  const close = (refocus: boolean) => {
    if (!open) return;
    const { button, panel } = open;
    open = null;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (refocus) button.focus();
  };

  const show = (button: HTMLButtonElement, panel: HTMLElement, keyboard: boolean) => {
    close(false);
    open = { button, panel };
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    void computePosition(button, panel, {
      strategy: "fixed",
      placement: "right-start",
      middleware: [offset(6), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      if (open?.panel !== panel) return;
      panel.style.left = `${Math.max(x, rail.getBoundingClientRect().right + 4)}px`;
      panel.style.top = `${y}px`;
    });
    if (keyboard) panel.querySelector<HTMLElement>("select, input, button")?.focus();
  };

  rail.addEventListener("click", (ev) => {
    const button = (ev.target as Element | null)?.closest<HTMLButtonElement>("button[data-fly]");
    if (!button) return;
    const panel = document.getElementById(button.dataset.fly ?? "");
    if (!panel) return;
    if (open?.panel === panel) close(false);
    else show(button, panel, (ev as MouseEvent).detail === 0);
  });
  document.addEventListener("pointerdown", (ev) => {
    const target = ev.target as Element | null;
    if (open && target && !open.panel.contains(target) && !open.button.contains(target)) close(false);
  }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !open) return;
    if (!open.panel.contains(ev.target as Node) && !open.button.contains(ev.target as Node)) return;
    ev.preventDefault();
    ev.stopPropagation();
    close(true);
  }, true);
  return { close: () => close(false) };
}
