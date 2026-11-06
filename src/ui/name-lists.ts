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
  /** Hidden in the Model view (a view choice only). */
  hidden?: boolean;
}

const EYE_OPEN = raw(`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>`);
const EYE_SHUT = raw(`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" opacity=".55"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`);

/**
 * Inspect's rows: each object on the plate with an eye (hide or show in the Model view), Check, Frame and (with more
 * than one) Remove. The open object's eye is disabled: it is always shown.
 */
export function inspectRowsHtml(objects: readonly InspectObject[], openId: string | null): Html {
  const many = objects.length > 1;
  if (objects.length === 0) return html`<p class="model-note">Nothing on the plate.</p>`;
  return html`${objects.map((obj) => {
    const current = obj.id === openId;
    const off = !!obj.hidden && !current;
    const eye = current
      ? html`<button class="btn obj-eye" type="button" data-plate-eye="${obj.id}" aria-pressed="false" aria-label="Hide ${obj.name}" data-tip="Open in Model, always shown" disabled>${EYE_OPEN}</button>`
      : html`<button class="btn obj-eye" type="button" data-plate-eye="${obj.id}" aria-pressed="${off ? "true" : "false"}" aria-label="${off ? "Show" : "Hide"} ${obj.name}" data-tip="${off ? "Show" : "Hide"} ${obj.name} (Alt-click: only this one)">${off ? EYE_SHUT : EYE_OPEN}</button>`;
    return html`<div class="obj obj-row" role="listitem" data-selected="${current ? "true" : "false"}" data-hidden="${off ? "true" : "false"}">
      <button class="obj-select" type="button" data-plate-select="${obj.id}" aria-pressed="${current ? "true" : "false"}" data-tip="${current ? "Open in Model" : "Open this object in Model"}"><b>${obj.name}</b><span>${obj.size} mm</span></button>
      <div class="obj-actions">
        ${many ? eye : ""}
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
