/**
 * Lists of things people name (plate objects, settings profiles): markup through `html`, so a name like
 * `<img src=x onerror=…>` from a file shows as text. Pure, so src/ui/html.test.ts renders them with hostile names.
 */
import { html, raw, type Html } from "./html.ts";

export interface InspectObject {
  id: string;
  name: string;
  /** "10 × 10 × 10", as the Prepare list says it. */
  size: string;
}

/** Inspect's rows: each object on the plate with Check, Frame and (with more than one) Remove. */
export function inspectRowsHtml(objects: readonly InspectObject[], openId: string | null): Html {
  const many = objects.length > 1;
  if (objects.length === 0) return html`<p class="model-note">Nothing on the plate.</p>`;
  return html`${objects.map((obj) => {
    const current = obj.id === openId;
    return html`<div class="obj obj-row" role="listitem" data-selected="${current ? "true" : "false"}">
      <button class="obj-select" type="button" data-plate-select="${obj.id}" aria-pressed="${current ? "true" : "false"}" data-tip="${current ? "Open in Model" : "Open this object in Model"}"><b>${obj.name}</b><span>${obj.size} mm</span></button>
      <div class="obj-actions">
        <button class="btn obj-check" type="button" data-plate-check="${obj.id}" aria-label="Check ${obj.name}">Check</button>
        <button class="btn obj-frame" type="button" data-plate-frame="${obj.id}" aria-label="Frame ${obj.name}">Frame</button>
        ${many ? html`<button class="btn obj-remove" type="button" data-plate-remove="${obj.id}" aria-label="Remove ${obj.name}">Remove</button>` : ""}
      </div>
    </div>`;
  })}`;
}

export interface NamedProfile {
  id: string;
  name: string;
}

/** The settings profile select's options after "Current", sorted by name, `selected` marked. */
export function profileOptionsHtml(profiles: readonly NamedProfile[], selected: string): Html {
  const sorted = profiles.slice().sort((a, b) => a.name.localeCompare(b.name));
  return html`${sorted.map((profile) => html`<option value="${profile.id}"${profile.id === selected ? raw(" selected") : ""}>${profile.name}</option>`)}`;
}
