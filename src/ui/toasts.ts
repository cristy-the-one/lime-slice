export type ToastTone = "success" | "info" | "warn" | "error";

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

/** Transient status. Blocking problems stay in the banner rail. */
export function pushToast(message: string, tone: ToastTone = "info") {
  if (!host) mountToasts();
  const rail = host!;
  const toast = document.createElement("div");
  const id = ++seq;
  toast.className = `toast toast-${tone}`;
  toast.dataset.toast = String(id);
  toast.setAttribute("role", tone === "error" || tone === "warn" ? "alert" : "status");
  toast.textContent = message;
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
