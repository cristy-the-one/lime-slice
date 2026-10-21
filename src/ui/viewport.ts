export type ViewPreset = "top" | "front" | "iso";

let viewPresetHook: ((preset: ViewPreset) => void) | null = null;

/** The same camera change the Top, Front and Iso chips run. */
export function applyViewPreset(preset: ViewPreset) {
  viewPresetHook?.(preset);
}

export function mountViewport(hooks: { setViewPreset(preset: ViewPreset): void }) {
  viewPresetHook = hooks.setViewPreset;
  mountViewKeys(hooks);
  mountEmptyDrop();
}

/** Without a mesh the stage is the drop zone: the layer slider and playback have nothing to drive. */
export function syncEmptyState(hasMesh: boolean) {
  document.querySelector("#stage")?.classList.toggle("is-empty", !hasMesh);
  document.querySelectorAll<HTMLElement>(".empty-drop").forEach((el) => {
    el.toggleAttribute("hidden", hasMesh);
  });
}

/** Top, Front and Iso: a chip over the Prepare view's top right corner. */
function mountViewKeys(hooks: { setViewPreset(preset: ViewPreset): void }) {
  const host = document.querySelector("#prepareBody");
  if (!host || document.querySelector("#viewPresets")) return;
  const row = document.createElement("div");
  row.id = "viewPresets";
  row.className = "modes stage-chip view-presets";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Camera");
  row.append(
    viewButton("top", "Top", hooks),
    viewButton("front", "Front", hooks),
    viewButton("iso", "Iso", hooks),
  );
  host.append(row);
}

function viewButton(
  preset: ViewPreset,
  label: string,
  hooks: { setViewPreset(preset: ViewPreset): void },
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = label;
  button.dataset.tip = `${label} view`;
  button.addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>("#tabPrepare")?.click();
    hooks.setViewPreset(preset);
  });
  return button;
}

function mountEmptyDrop() {
  for (const id of ["#prepareBody", "#previewBody"]) {
    const host = document.querySelector(id);
    if (!host || host.querySelector(".empty-drop")) continue;
    const zone = document.createElement("div");
    zone.className = "empty-drop";
    zone.innerHTML = `<div><strong>Drop a mesh</strong><p>STL · 3MF · STEP</p><button class="btn" type="button">Open mesh</button></div>`;
    zone.querySelector("button")?.addEventListener("click", () => {
      document.querySelector<HTMLInputElement>("#file")?.click();
    });
    host.append(zone);
  }
}
