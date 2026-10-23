/**
 * --- Split to print, Explode (docs/plan-split-connectors.md, D12) for the open part: which plate objects are its
 * split to print's pieces, and the grey context with those pieces spread by the gap, each labelled with its number.
 * The open solid stays where it is; the other pieces move by their shift less its own.
 */
import { boundsOf, type Bounds } from "../mesh-place";
import type { ContextPart } from "../model-context";
import { cutsInModel, explodeShifts, posedCentre, shiftedPose, shownPartition } from "../model-explode";
import type { Affine } from "../model-space";
import { modelPoseOf } from "../plate";
import { modelTrees } from "./model-trees";
import { state } from "./state";

type Vec3 = [number, number, number];

export interface Exploded {
  parts: ContextPart[];
  tags: { text: string; at: Vec3 }[];
  /** Each piece's number and shift, for `data-explode-parts` on `#model`. */
  shifts: string;
}

interface Member {
  part: number;
  id: string;
  centre: Vec3;
}

/** The split to print the open part's tree is on: its own, or, for a piece, its part's. */
function partitionOf(openKey: string): { found: NonNullable<ReturnType<typeof shownPartition>>; ownerKey: string; open: number } | null {
  const tree = modelTrees.get(openKey);
  if (!tree) return null;
  const own = shownPartition(tree);
  if (own) return { found: own, ownerKey: openKey, open: 1 };
  if (tree.root.kind !== "piece") return null;
  const node = modelTrees.get(tree.root.tree)?.nodes.get(tree.root.node);
  return node?.op?.kind === "partition" ? { found: { op: node.op, pieces: node.pieces ?? [] }, ownerKey: tree.root.tree, open: tree.root.index ?? 2 } : null;
}

/** The pieces of the split to print the open part belongs to, or null when it has none whose pieces are on screen. */
function members(openId: string, openKey: string, openBox: Bounds, openPose: Affine, parts: readonly ContextPart[]): { cuts: { origin: Vec3; normal: Vec3 }[]; members: Member[]; open: number } | null {
  const at = partitionOf(openKey);
  if (!at) return null;
  const { found, ownerKey, open } = at;
  const owner = state.plate.objects.find((obj) => obj.modelTree === ownerKey);
  if (!owner) return null;
  const list: Member[] = [];
  for (const [index, key] of [ownerKey, ...found.pieces].entries()) {
    if (index + 1 === open) {
      list.push({ part: open, id: openId, centre: posedCentre(openBox, openPose) });
      continue;
    }
    const obj = key ? state.plate.objects.find((row) => row.modelTree === key) : undefined;
    const shown = obj ? parts.find((part) => part.id === obj.id) : undefined;
    if (shown) list.push({ part: index + 1, id: shown.id, centre: posedCentre(boundsOf(shown.positions), shown.matrix) });
  }
  return list.length > 1 ? { cuts: cutsInModel(found.op, modelPoseOf(owner)), members: list, open } : null;
}

/** Whether the open part has pieces to explode: another piece of its split to print is on screen. Reads no mesh. */
export function canExplode(openKey: string, parts: readonly ContextPart[]): boolean {
  const at = partitionOf(openKey);
  if (!at) return false;
  const shown = new Set(parts.map((part) => part.id));
  return [at.ownerKey, ...at.found.pieces].some((key, index) => {
    if (!key || index + 1 === at.open) return false;
    const obj = state.plate.objects.find((row) => row.modelTree === key);
    return !!obj && shown.has(obj.id);
  });
}

/** The context with the pieces spread by `gapMm`, and a tag with each number. Null when there is nothing to explode. */
export function explodeContext(openId: string, openKey: string, openBox: Bounds, openPose: Affine, parts: readonly ContextPart[], gapMm: number): Exploded | null {
  const found = members(openId, openKey, openBox, openPose, parts);
  if (!found) return null;
  const shifts = explodeShifts(found.cuts, found.members.map((member) => member.centre), gapMm);
  const still = shifts[found.members.findIndex((member) => member.part === found.open)] ?? [0, 0, 0];
  const relative = shifts.map((shift) => shift.map((value, i) => value - still[i]! + 0) as Vec3);
  const moved = new Map(found.members.map((member, at) => [member.id, relative[at]!]));
  const round = (value: number) => Math.round(value * 1000) / 1000 + 0;
  return {
    parts: parts.map((part) => {
      const shift = moved.get(part.id);
      return shift ? { ...part, matrix: shiftedPose(part.matrix, shift) } : part;
    }),
    tags: found.members.map((member, at) => ({ text: String(member.part), at: member.centre.map((value, i) => value + relative[at]![i]!) as Vec3 })),
    shifts: found.members.map((member, at) => `${member.part}:${relative[at]!.map(round).join(",")}`).join(" "),
  };
}
