export type ViewPreset = "top" | "front" | "iso";

export function mountViewport(hooks: { setViewPreset(preset: ViewPreset): void }) {
  mountViewKeys(hooks);
  mountEmptyDrop();
}

/** Without a mesh the stage is the drop zone alone: no view bar, layer slider, playback or legend. */
export function syncEmptyState(hasMesh: boolean) {
  document.querySelector("#stage")?.classList.toggle("is-empty", !hasMesh);
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
    viewButton("top", "Top", hooks),
    viewButton("front", "Front", hooks),
    viewButton("iso", "Iso", hooks),
  );
  const modes = document.querySelector("#viewModes");
  if (modes) modes.after(row);
  else bar.prepend(row);
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
