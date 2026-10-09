/** The user's support edit list and how to describe it. Pure: no three.js, no DOM. */
import type { CoverageGap, EditOutcome, PruneEdit, RegrowEdit, SupportEditRequest } from "./support-edits.ts";
import type { PickScope } from "./support-pick.ts";

/** One edit the user made, plus what the UI needs to describe it. `id` is unique within a session. */
export type EditEntry =
  | { id: number; edit: PruneEdit; scope: PickScope }
  | { id: number; edit: RegrowEdit; areaMm2: number };

export function appendEdit(list: readonly EditEntry[], entry: EditEntry): EditEntry[] {
  return [...list, entry];
}

export function undoLast(list: readonly EditEntry[]): EditEntry[] {
  return list.slice(0, -1);
}

export function removeEdit(list: readonly EditEntry[], id: number): EditEntry[] {
  return list.filter((entry) => entry.id !== id);
}

export function clearEdits(): EditEntry[] {
  return [];
}

/** Request fields. `{}` when neither applies, so the recipe key is untouched. */
export function editRequestFields(list: readonly EditEntry[], treeSupports: boolean): SupportEditRequest {
  if (!treeSupports) return {};
  if (list.length === 0) return { includeSkeleton: true };
  return { supportEdits: list.map((entry) => entry.edit), includeSkeleton: true };
}

/**
 * Outcome of each entry, or `undefined` when the shown result was not sliced with it.
 * `sent` is the list the shown result's request carried; entry i has outcome i only while
 * `sent[0..=i]` are the same entries (by id) as `list[0..=i]`.
 */
export function alignOutcomes(list: readonly EditEntry[], sent: readonly EditEntry[], outcomes: readonly EditOutcome[]): (EditOutcome | undefined)[] {
  let same = true;
  return list.map((entry, i) => {
    same = same && sent[i]?.id === entry.id;
    return same ? outcomes[i] : undefined;
  });
}

export type Badge = "applied" | "rebound" | "stale" | "pending";

export function badgeOf(outcome: EditOutcome | undefined): Badge {
  return outcome ? outcome.status : "pending";
}

const tips = (n: number) => `${n} tip${n === 1 ? "" : "s"}`;
const mm2 = (v: number) => `${v.toFixed(1)} mm²`;
const zRange = (z: readonly [number, number]) => `Z ${z[0].toFixed(2)}–${z[1].toFixed(2)}`;
/** Coverage changes under this are boolean noise, the engine's smallest unheld piece. */
const NOISE_MM2 = 0.05;

/** The z range a gap is shown at: the preview layers' own `z`, which on a belt is a belt position and not the gap's slice-frame `z`. */
export function gapZ(gap: CoverageGap): [number, number] {
  return gap.tilted?.ls ?? gap.z;
}

/**
 * Short title, e.g. "Delete tree · 36 tips", "Delete branch · 1 tip", "Regrow · Z 4.20–6.40".
 * On a belt a regrow's `z` is a slice-frame height no layer shows, so it names the area instead.
 */
export function editTitle(entry: EditEntry, belt = false): string {
  if (!("scope" in entry)) return belt ? `Regrow · ${mm2(entry.areaMm2)}` : `Regrow · ${zRange(entry.edit.z)}`;
  return `Delete ${entry.scope} · ${tips(entry.edit.sites.length)}`;
}

/** One sentence pair for the toast and the panel. */
export function outcomeText(entry: EditEntry, outcome: EditOutcome): string {
  if (!("scope" in entry)) {
    if (outcome.status === "stale") return "Nothing unheld to regrow here.";
    if (outcome.newlyFloatingMm2 < -NOISE_MM2) return `Regrew supports. ${mm2(-outcome.newlyFloatingMm2)} of overhang held again.`;
    return "Regrew supports. Nothing more is held.";
  }
  const n = entry.edit.sites.length;
  const unheld = outcome.newlyFloatingMm2 > NOISE_MM2 ? `${mm2(outcome.newlyFloatingMm2)} of overhang now unheld.` : "Nothing new is unheld.";
  const removed = `Removed 1 ${entry.scope} (${tips(n)})`;
  if (outcome.status === "applied") return `${removed}. ${unheld}`;
  if (outcome.status === "rebound") return `${removed}, matched ${outcome.movedMm.toFixed(2)} mm from where it was picked. ${unheld}`;
  if (outcome.missed >= n || outcome.changedLayers === 0) return "Nothing matched: the supports changed since this edit.";
  return `${outcome.missed} of ${n} tips no longer ${outcome.missed === 1 ? "exists" : "exist"}, the rest were removed. ${unheld}`;
}

/**
 * Gaps to draw, deduplicated by z, min, and max: each prune adds the gaps it left, each regrow
 * replaces the gaps its region covers with the ones it still leaves, then the result's `coverage`.
 * `sent` is the list the result's request carried, so `outcomes[i]` belongs to `sent[i]`.
 */
export function gapsToShow(coverage: readonly CoverageGap[] | undefined, sent: readonly EditEntry[], outcomes: readonly EditOutcome[] | undefined): CoverageGap[] {
  let shown: CoverageGap[] = [];
  (outcomes ?? []).forEach((outcome, i) => {
    const edit = sent[i]?.edit;
    if (edit?.kind === "regrow") shown = shown.filter((gap) => !covers(edit, gap));
    shown.push(...outcome.floating);
  });
  shown.push(...(coverage ?? []));
  const seen = new Set<string>();
  return shown.filter((gap) => {
    const key = `${gap.z[0]},${gap.z[1]},${gap.min[0]},${gap.min[1]},${gap.max[0]},${gap.max[1]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function covers(edit: RegrowEdit, gap: CoverageGap) {
  if (gap.z[1] < edit.z[0] || gap.z[0] > edit.z[1]) return false;
  return edit.region.some((loop) => {
    const xs = loop.map((p) => p[0]);
    const ys = loop.map((p) => p[1]);
    return gap.min[0] <= Math.max(...xs) && gap.max[0] >= Math.min(...xs) && gap.min[1] <= Math.max(...ys) && gap.max[1] >= Math.min(...ys);
  });
}
