export type ViewPreset = "top" | "front" | "iso";

export function mountViewport(hooks: { setViewPreset(preset: ViewPreset): void }) {
  mountViewKeys(hooks);
  mountEmptyDrop();
  window.addEventListener("keydown", (ev) => onViewKey(ev, hooks));
}

export function syncEmptyState(hasMesh: boolean) {
  document.querySelectorAll<HTMLElement>(".empty-drop").forEach((el) => {
    el.toggleAttribute("hidden", hasMesh);
  });
}

function mountViewKeys(hooks: { setViewPreset(preset: ViewPreset): void }) {
  const bar = document.querySelector(".viewbar");
  if (!bar || document.querySelector("#viewPresets")) return;
  const row = document.createElement("div");
  row.id = "viewPresets";
  row.className = "modes";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Camera");
  row.hidden = true;
  row.append(
    viewButton("top", "Top", "T", hooks),
    viewButton("front", "Front", "Y", hooks),
    viewButton("iso", "Iso", "I", hooks),
  );
  const modes = document.querySelector("#viewModes");
  if (modes) modes.after(row);
  else bar.prepend(row);
}

function viewButton(
  preset: ViewPreset,
  label: string,
  shortcut: string,
  hooks: { setViewPreset(preset: ViewPreset): void },
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = label;
  button.dataset.tip = `${label} view`;
  button.dataset.shortcut = shortcut;
  button.addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>("#tabPrepare")?.click();
    hooks.setViewPreset(preset);
  });
  return button;
}

function onViewKey(ev: KeyboardEvent, hooks: { setViewPreset(preset: ViewPreset): void }) {
  if (document.documentElement.dataset.overlay) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
  const target = ev.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target?.isContentEditable) return;
  const help = document.querySelector("#help");
  if (help && !help.hasAttribute("hidden")) return;
  const key = ev.key.toLowerCase();
  const preset = key === "t" ? "top" : key === "y" ? "front" : key === "i" ? "iso" : null;
  if (!preset) return;
  ev.preventDefault();
  document.querySelector<HTMLButtonElement>("#tabPrepare")?.click();
  hooks.setViewPreset(preset);
}

function mountEmptyDrop() {
  for (const id of ["#prepareBody", "#previewBody"]) {
    const host = document.querySelector(id);
    if (!host || host.querySelector(".empty-drop")) continue;
    const zone = document.createElement("div");
    zone.className = "empty-drop";
    zone.innerHTML = `<div><strong>Drop a mesh</strong><p>STL, 3MF, or STEP onto the window.</p><button class="btn" type="button">Open mesh</button></div>`;
    zone.querySelector("button")?.addEventListener("click", () => {
      document.querySelector<HTMLInputElement>("#file")?.click();
    });
    host.append(zone);
  }
}
