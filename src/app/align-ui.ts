/** The Align to... row of the Place panel: pick the bed or another object, pick how, and Align. Pure markup and the pick it remembers. */
import { ALIGN_LABELS, ALIGN_RELATIONS, relationFitsBed, type AlignRelation } from "../place-snap.ts";
import { html, raw, type Html } from "../ui/html.ts";

const GROUPS: { label: string; relations: readonly AlignRelation[] }[] = [
  { label: "Flush", relations: ["flush-left", "flush-right", "flush-front", "flush-back"] },
  { label: "Touching", relations: ["left-of", "right-of", "front-of", "behind"] },
  { label: "Centre", relations: ["centre-x", "centre-y", "centre"] },
  { label: "Stack", relations: ["on-top"] },
];

/** The longer wording of an option whose short label needs it, for its tooltip. */
const ALIGN_TIPS: Partial<Record<AlignRelation, string>> = { centre: "Centre X and Y" };

export interface AlignPick {
  to: string;
  how: AlignRelation;
}

/** What the row holds. It outlives a re-render of the panel. */
export const alignPick: AlignPick = { to: "bed", how: "centre" };

/** What Model's row holds. Model space has no fixed bed to align to, so its target is always an object; "" is none yet. */
export const modelAlignPick: AlignPick = { to: "", how: "centre" };

export interface AlignTarget {
  id: string;
  name: string;
}

/** Keep the pick on something that exists: a removed object falls back to the bed, and the bed has no side to touch. */
export function settleAlignPick(others: readonly AlignTarget[]): void {
  if (alignPick.to !== "bed" && !others.some((o) => o.id === alignPick.to)) alignPick.to = "bed";
  if (alignPick.to === "bed" && !relationFitsBed(alignPick.how)) alignPick.how = "centre";
}

/** Model's pick stays on an object that is still there, else the first one, else none. */
export function settleModelPick(others: readonly AlignTarget[]): void {
  if (!others.some((o) => o.id === modelAlignPick.to)) modelAlignPick.to = others[0]?.id ?? "";
}

/** The relations as option groups. With `pick` on the bed, only those a bed has a side for. */
export function alignHowHtml(pick: AlignPick = alignPick): Html {
  const bed = pick.to === "bed";
  return html`${GROUPS.map((group) => {
    const shown = group.relations.filter((r) => ALIGN_RELATIONS.includes(r) && (!bed || relationFitsBed(r)));
    if (shown.length === 0) return "";
    return html`<optgroup label="${group.label}">${shown.map((r) => html`<option value="${r}" title="${ALIGN_TIPS[r] ?? ALIGN_LABELS[r]}"${r === pick.how ? raw(" selected") : ""}>${ALIGN_LABELS[r]}</option>`)}</optgroup>`;
  })}`;
}

/** The options of Model's Align to... select: the other objects, their names escaped. */
export function modelAlignToHtml(others: readonly AlignTarget[]): Html {
  settleModelPick(others);
  return html`${others.map((t) => html`<option value="${t.id}" title="${t.name}"${t.id === modelAlignPick.to ? raw(" selected") : ""}>${t.name}</option>`)}`;
}

export function alignHtml(others: readonly AlignTarget[]): Html {
  settleAlignPick(others);
  const targets = [{ id: "bed", name: "Bed" }, ...others];
  return html`
    <div class="align-grid" id="placeAlign">
      <label class="setting" data-label="align to" data-keywords="snap flush centre edge touch stack on top"><span class="scrub-label">Align to…</span><select id="alignTo" aria-label="Align to" title="${targets.find((t) => t.id === alignPick.to)?.name ?? "Bed"}">${targets.map((t) => html`<option value="${t.id}" title="${t.name}"${t.id === alignPick.to ? raw(" selected") : ""}>${t.name}</option>`)}</select></label>
      <label class="setting" data-label="align how" data-keywords="snap flush centre edge touch stack on top"><span class="scrub-label">How</span><select id="alignHow" aria-label="Align how" title="${ALIGN_TIPS[alignPick.how] ?? ALIGN_LABELS[alignPick.how]}">${alignHowHtml()}</select></label>
      <button class="btn" id="alignGo" type="button" data-tip="Move the selected object to line up with the pick. One undo step.">Align</button>
    </div>`;
}
