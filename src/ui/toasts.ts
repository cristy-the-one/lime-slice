export type ToastTone = "info" | "warn" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

const HOLD_MS = 6000;
let host: HTMLElement | null = null;
let seq = 0;

export function mountToasts() {
  if (document.querySelector("#toasts")) return;
  host = document.createElement("div");
  host.id = "toasts";
  host.className = "toasts";
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-relevant", "additions");
  document.body.append(host);
}

/** Transient status. Blocking problems stay in the banner rail. `action` is a button such as Retry, or several. */
export function pushToast(message: string, tone: ToastTone = "info", action?: ToastAction | readonly ToastAction[]) {
  if (!host) mountToasts();
  const rail = host!;
  const toast = document.createElement("div");
  const id = ++seq;
  toast.className = `toast toast-${tone}`;
  toast.dataset.toast = String(id);
  toast.setAttribute("role", tone === "error" || tone === "warn" ? "alert" : "status");
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  toast.append(text);
  for (const entry of action === undefined ? [] : "label" in action ? [action] : action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = entry.label;
    button.addEventListener("click", () => {
      toast.remove();
      entry.run();
    });
    toast.append(button);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => toast.remove());
  toast.append(close);
  rail.prepend(toast);
  while (rail.children.length > 4) rail.lastElementChild?.remove();
  window.setTimeout(() => {
    if (toast.isConnected) toast.remove();
  }, HOLD_MS);
}
