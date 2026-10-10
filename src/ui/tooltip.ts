import { computePosition, flip, offset, shift } from "@floating-ui/dom";

import { commandForElement, shortcutOf, targetSelector } from "./commands";

const SHOW_MS = 380;

/** A summary whose menu or popover is open: the tip would sit on top of what it opened. */
function opensMenu(el: HTMLElement): boolean {
  return el instanceof HTMLElement && el.tagName === "SUMMARY" && (el.parentElement as HTMLDetailsElement | null)?.open === true;
}

/** Small tooltip for elements with `data-tip` and for the buttons of keyed commands, which show their first key. */
export function mountTooltips(root: ParentNode = document) {
  const hostSelector = `[data-tip], ${targetSelector()}`;
  const tip = document.createElement("div");
  tip.className = "lime-tip";
  tip.setAttribute("role", "tooltip");
  document.body.append(tip);

  let host: HTMLElement | null = null;
  let timer = 0;

  const hide = () => {
    window.clearTimeout(timer);
    host = null;
    tip.dataset.open = "false";
  };

  const place = (el: HTMLElement) => {
    if (opensMenu(el)) {
      hide();
      return;
    }
    const command = commandForElement(el);
    const text = el.dataset.tip ?? command?.label ?? "";
    const shortcut = command ? shortcutOf(command) ?? "" : "";
    if (!text && !shortcut) {
      hide();
      return;
    }
    tip.replaceChildren();
    if (text) tip.append(document.createTextNode(text));
    if (shortcut) {
      const kbd = document.createElement("kbd");
      kbd.textContent = shortcut;
      tip.append(kbd);
    }
    tip.dataset.open = "true";
    void computePosition(el, tip, {
      strategy: "fixed",
      placement: "bottom",
      middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      if (host !== el) return;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    });
  };

  const schedule = (el: HTMLElement, delay: number) => {
    window.clearTimeout(timer);
    host = el;
    timer = window.setTimeout(() => place(el), delay);
  };

  root.addEventListener("mouseover", (ev) => {
    const el = (ev.target as Element | null)?.closest<HTMLElement>(hostSelector);
    if (!el || el === host) return;
    schedule(el, SHOW_MS);
  });
  root.addEventListener("mouseout", (ev) => {
    if (!host) return;
    const mouse = ev as MouseEvent;
    const next = (mouse.relatedTarget as Element | null)?.closest?.(hostSelector);
    if (next === host) return;
    const from = (mouse.target as Element | null)?.closest?.(hostSelector);
    if (from === host) hide();
  });
  // A pointer press is the answer to the tip, and the focus it gives is not a keyboard visit.
  root.addEventListener("pointerdown", hide, true);
  root.addEventListener("click", hide, true);
  root.addEventListener("toggle", hide, true);
  root.addEventListener("focusin", (ev) => {
    const el = (ev.target as Element | null)?.closest<HTMLElement>(hostSelector);
    if (el?.matches(":focus-visible")) schedule(el, 0);
  });
  root.addEventListener("focusout", (ev) => {
    const el = (ev.target as Element | null)?.closest<HTMLElement>(hostSelector);
    if (el && el === host) hide();
  });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hide();
  });
}
