/**
 * E3. Inspect: the right dock in Model. The open solid's size (the view's size line), its volume, the bed it is checked
 * against, the last Check, and the objects on the plate with the Prepare list's own actions. It fills only while it is
 * on screen, and catches up when it comes back, so a hidden Inspect costs nothing.
 */
import { state } from "../app/state.ts";
import { openDock } from "./dock-reveal.ts";

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
}

/**
 * The plate's own actions, as the Prepare list has them: Model hides the settings, so Inspect's rows carry them. Each is
 * the user's own choice; Model never changes the plate by itself.
 */
export interface InspectPlateActions {
  /** Select the object, which opens it in Model. */
  select(id: string): void;
  frame(id: string): void;
  check(id: string): void;
  remove(id: string): void;
  duplicate(): void;
  add(): void;
}

let hooks: ModelInspectHooks | null = null;
let actions: InspectPlateActions | null = null;
let volume = "—";
let checked = "";

export function setInspectPlateActions(next: InspectPlateActions) {
  actions = next;
}

/** On screen: the right dock in Model, or the Device tab on the phone. */
function shown(): boolean {
  return !!document.querySelector<HTMLElement>("#modelInspect")?.checkVisibility();
}

export function mountModelInspect(next: ModelInspectHooks) {
  hooks = next;
  // The status line's "Too large" opens Inspect, where the size says by how much.
  document.querySelector("#modelFitWarn")?.addEventListener("click", () => openDock("right"));
  document.querySelector("#modelInspectObjects")?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const pick = (attr: string) => target?.closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr) ?? null;
    const frame = pick("data-plate-frame");
    if (frame) return actions?.frame(frame);
    const check = pick("data-plate-check");
    if (check) return actions?.check(check);
    const remove = pick("data-plate-remove");
    if (remove) return actions?.remove(remove);
    const select = pick("data-plate-select");
    if (select && select !== hooks?.openId()) actions?.select(select);
  });
  document.querySelector("#modelInspectDuplicate")?.addEventListener("click", () => actions?.duplicate());
  document.querySelector("#modelInspectAdd")?.addEventListener("click", () => actions?.add());
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
  const objects = hooks.objects();
  const many = objects.length > 1;
  const rows = objects.map((obj) => {
    const current = obj.id === openId;
    const id = escapeHtml(obj.id);
    const name = escapeHtml(obj.name);
    return `<div class="obj obj-row" role="listitem" data-selected="${current ? "true" : "false"}">
      <button class="obj-select" type="button" data-plate-select="${id}" aria-pressed="${current ? "true" : "false"}" data-tip="${current ? "Open in Model" : "Open this object in Model"}"><b>${name}</b><span>${escapeHtml(obj.size)} mm</span></button>
      <div class="obj-actions">
        <button class="btn obj-check" type="button" data-plate-check="${id}" aria-label="Check ${name}">Check</button>
        <button class="btn obj-frame" type="button" data-plate-frame="${id}" aria-label="Frame ${name}">Frame</button>
        ${many ? `<button class="btn obj-remove" type="button" data-plate-remove="${id}" aria-label="Remove ${name}">Remove</button>` : ""}
      </div>
    </div>`;
  });
  list.innerHTML = rows.join("") || `<p class="model-note">Nothing on the plate.</p>`;
}
