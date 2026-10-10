/** Compact support-edit gestures. Pure: the desktop editor applies the same edits. */
import { coverageWarning } from "../../slice-action.ts";
import type { PickScope } from "../../support-pick.ts";

export type CompactGesture = "tap" | "longpress";

/** A tap takes the branch under the finger. A long-press takes the whole tree. */
export function scopeForGesture(gesture: CompactGesture): PickScope {
  return gesture === "longpress" ? "tree" : "branch";
}

export interface LimbSelection {
  kind: "limb";
  scope: PickScope;
  tips: number;
  /** Contact height of the picked limb, when it still has a live tip. */
  z: number | null;
}

export interface GapSelection {
  kind: "gap";
  areaMm2: number;
  z: [number, number];
}

export type CompactSelection = LimbSelection | GapSelection;

/** Short sheet label: branch or tree, and the site. A gap names its z range. */
export function selectionLabel(target: CompactSelection): string {
  if (target.kind === "gap") {
    return `Unheld · ${target.areaMm2.toFixed(1)} mm² · Z ${target.z[0].toFixed(2)}–${target.z[1].toFixed(2)}`;
  }
  const name = target.scope === "tree" ? "Tree" : "Branch";
  if (target.tips === 1 && target.z != null) return `${name} · Z ${target.z.toFixed(2)}`;
  const tips = `${target.tips} tip${target.tips === 1 ? "" : "s"}`;
  return `${name} · ${tips}`;
}

/** The floating action. Prune for a limb, Regrow for a gap. Nothing until a tap lands. */
export function chipAction(target: CompactSelection | null): "prune" | "regrow" | null {
  if (!target) return null;
  return target.kind === "gap" ? "regrow" : "prune";
}

/** One line for the peek. The selection wins; otherwise the real coverage warning, or the hint. */
export function peekLine(input: {
  treeSupports: boolean;
  gaps: readonly { areaMm2: number }[];
  selected: string | null;
}): string {
  if (input.selected) return input.selected;
  if (!input.treeSupports) return "Tree supports are off.";
  return coverageWarning(input.gaps) ?? "";
}
