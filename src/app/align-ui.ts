/** The Align to... row of the Place panel: pick the bed or another object, pick how, and Align. Pure markup and the pick it remembers. */
import { ALIGN_LABELS, ALIGN_RELATIONS, relationFitsBed, type AlignRelation } from "../place-snap.ts";

const GROUPS: { label: string; relations: readonly AlignRelation[] }[] = [
  { label: "Flush", relations: ["flush-left", "flush-right", "flush-front", "flush-back"] },
  { label: "Touching", relations: ["left-of", "right-of", "front-of", "behind"] },
  { label: "Centre", relations: ["centre-x", "centre-y", "centre"] },
  { label: "Stack", relations: ["on-top"] },
];

export interface AlignPick {
  to: string;
  how: AlignRelation;
}

/** What the row holds. It outlives a re-render of the panel. */
export const alignPick: AlignPick = { to: "bed", how: "centre" };

/** What Model's row holds. Model space has no fixed bed to align to, so its target is always an object; "" is none yet. */
export const modelAlignPick: AlignPick = { to: "", how: "centre" };

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
export function alignHowHtml(pick: AlignPick = alignPick): string {
  const bed = pick.to === "bed";
  return GROUPS.map((group) => {
    const shown = group.relations.filter((r) => ALIGN_RELATIONS.includes(r) && (!bed || relationFitsBed(r)));
    if (shown.length === 0) return "";
    return `<optgroup label="${group.label}">${shown.map((r) => `<option value="${r}"${r === pick.how ? " selected" : ""}>${ALIGN_LABELS[r]}</option>`).join("")}</optgroup>`;
  }).join("");
}

/** The options of Model's Align to... select: the other objects. */
export function modelAlignToHtml(others: readonly AlignTarget[]): string {
  settleModelPick(others);
  return others.map((t) => `<option value="${esc(t.id)}" title="${esc(t.name)}"${t.id === modelAlignPick.to ? " selected" : ""}>${esc(t.name)}</option>`).join("");
}

export function alignHtml(others: readonly AlignTarget[]): string {
  settleAlignPick(others);
  const targets = [{ id: "bed", name: "Bed" }, ...others];
  return `
    <div class="align-grid" id="placeAlign">
      <label class="setting" data-label="align to" data-keywords="snap flush centre edge touch stack on top"><span class="scrub-label">Align to…</span><select id="alignTo" aria-label="Align to" title="${esc(targets.find((t) => t.id === alignPick.to)?.name ?? "Bed")}">${targets.map((t) => `<option value="${esc(t.id)}" title="${esc(t.name)}"${t.id === alignPick.to ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
      <label class="setting" data-label="align how" data-keywords="snap flush centre edge touch stack on top"><span class="scrub-label">How</span><select id="alignHow" aria-label="Align how">${alignHowHtml()}</select></label>
      <button class="btn" id="alignGo" type="button" data-tip="Move the selected object to line up with the pick. One undo step.">Align</button>
    </div>`;
}
