/**
 * E3. Inspect: the right dock in Model. The open solid's size (the view's size line), its volume, the bed it is checked
 * against, the last Check, and the objects on the plate. It fills only while it is on screen in Model, and catches up
 * when it comes back, so a hidden Inspect costs nothing.
 */
import { state } from "../app/state";
import { setDock } from "./splitters";

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

export interface InspectObject {
  id: string;
  name: string;
  /** "10 × 10 × 10", as the Prepare list says it. */
  size: string;
}

export interface ModelInspectHooks {
  objects(): InspectObject[];
  /** The object Model has open, or null. */
  openId(): string | null;
  /** Open another plate object in Model. Picking it selects it; the plate does not move. */
  open(id: string): void;
  /** Check the open object, as Check in the rail does. */
  check(): void;
}

let hooks: ModelInspectHooks | null = null;
let volume = "—";
let checked = "";

/** On screen: the right dock in Model, or the Device tab on the phone. */
function shown(): boolean {
  return !!document.querySelector<HTMLElement>("#modelInspect")?.checkVisibility();
}

export function mountModelInspect(next: ModelInspectHooks) {
  hooks = next;
  document.querySelector("#modelInspectCheckRun")?.addEventListener("click", () => hooks?.check());
  // The status line's "Too large" opens Inspect, where the size says by how much.
  document.querySelector("#modelFitWarn")?.addEventListener("click", () => setDock("right", true));
  document.querySelector("#modelInspectObjects")?.addEventListener("click", (ev) => {
    const row = (ev.target as Element | null)?.closest<HTMLElement>("[data-inspect-open]");
    const id = row?.dataset.inspectOpen;
    if (id && id !== hooks?.openId()) hooks?.open(id);
  });
  window.addEventListener("lime-inspect", () => paintModelInspect(true));
  paintModelInspect();
}

/** The open solid's volume, as the readout says it, or a dash with no solid. */
export function setInspectVolume(text: string) {
  if (volume === text) return;
  volume = text;
  const node = document.querySelector("#modelInspectVolume");
  if (node) node.textContent = text;
}

/** The object the last Check was for: another object open says it is not checked yet. */
let checkedFor: string | null = null;

/** The last Check's summary for the open object, in one line. */
export function setInspectCheck(text: string) {
  checked = text;
  checkedFor = hooks?.openId() ?? null;
  paintCheck();
}

function paintCheck() {
  const node = document.querySelector("#modelInspectCheck");
  const text = checked && checkedFor === (hooks?.openId() ?? null) ? checked : "Not checked yet.";
  if (node && node.textContent !== text) node.textContent = text;
}

let painted = "";

/** What the rows are made of: the open object, the bed, and each object's mesh, scale and turn. */
function rowsKey(openId: string | null): string {
  const { bedX, bedY, bedZ } = state.profile;
  const objects = state.plate.objects.map((obj) => `${obj.id}:${obj.name}:${obj.bytes.byteLength}:${obj.partScale}:${obj.orient.join(",")}`);
  return [openId, bedX, bedY, bedZ, ...objects].join("|");
}

/**
 * The plate or the open object may have changed: the rows follow now if Inspect shows and they did change, else when
 * Inspect next shows (`force`).
 */
export function paintModelInspect(force = false) {
  paintCheck();
  if (!hooks || !shown()) return;
  const key = rowsKey(hooks.openId());
  if (!force && key === painted) return;
  painted = key;
  const bed = document.querySelector("#modelInspectBed");
  const profile = state.profile;
  if (bed) bed.textContent = `${profile.bedX} × ${profile.bedY} × ${profile.bedZ} mm`;
  const list = document.querySelector("#modelInspectObjects");
  if (!list) return;
  const openId = hooks.openId();
  const rows = hooks.objects().map((obj) => {
    const current = obj.id === openId;
    return `<div role="listitem"><button class="model-inspect-object" type="button" data-inspect-open="${escapeHtml(obj.id)}"${current ? ' aria-current="true"' : ""} data-tip="${current ? "Open in Model" : "Open this object in Model"}"><b>${escapeHtml(obj.name)}</b><span>${escapeHtml(obj.size)} mm</span></button></div>`;
  });
  list.innerHTML = rows.join("") || `<p class="model-note">Nothing on the plate.</p>`;
}
