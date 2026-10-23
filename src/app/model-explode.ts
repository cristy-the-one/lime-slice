/**
 * --- Split to print, Explode (docs/plan-split-connectors.md, D12) for the open part: which plate objects are its
 * split to print's pieces, and the grey context with those pieces spread by the gap, each labelled with its number.
 * The open solid stays where it is; the other pieces move by their shift less its own.
 */
import { boundsOf, type Bounds } from "../mesh-place";
import type { ContextPart } from "../model-context";
import { cutsInModel, explodeShifts, posedCentre, shiftedPose, shownPartition } from "../model-explode";
import type { Affine } from "../model-space";
import { ROOT } from "../model-tree";
import { meshToModel, modelPoseOf, type PlateObject } from "../plate";
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
  /** An export target's piece, held off the plate: the part to draw, since `parts` has none for it. */
  held?: { positions: Float32Array; matrix: Affine };
}

/** The split to print the open part's tree is on: its own, or, for a piece, its part's. */
function partitionOf(openKey: string): { found: NonNullable<ReturnType<typeof shownPartition>>; ownerKey: string; open: number } | null {
  const tree = modelTrees.get(openKey);
  if (!tree) return null;
  const own = shownPartition(tree);
  if (own) return { found: own, ownerKey: openKey, open: 1 };
  if (tree.root.kind !== "piece") return null;
  const node = modelTrees.get(tree.root.tree)?.nodes.get(tree.root.node);
  const open = tree.root.pins ? PINS_PART : (tree.root.index ?? 2);
  return node?.op?.kind === "partition" ? { found: { op: node.op, pieces: node.pieces ?? [], pins: node.pins ?? null }, ownerKey: tree.root.tree, open } : null;
}

/**
 * An export target's piece (D12): held in Model by its tree, with no plate object. Its mesh is the tree's, and it sits where
 * the part's own plate object puts a mesh of that seat in model space. Null when the tree holds no mesh.
 */
export function heldPiece(key: string, owner: PlateObject): { positions: Float32Array; pose: Affine } | null {
  const tree = modelTrees.get(key);
  const mesh = tree?.nodes.get(tree.current)?.mesh ?? tree?.nodes.get(ROOT)?.mesh;
  if (!mesh || mesh.sourcePos.length < 9) return null;
  return { positions: mesh.sourcePos, pose: meshToModel({ ...owner, bytes: mesh.bytes, sourcePos: mesh.sourcePos }) };
}

const heldId = (key: string) => `held:${key}`;

/** The pins' place among the members: before piece 1, and tagged "Pins", not a number. */
const PINS_PART = 0;

/** The open part's split to print pieces that are held off the plate, as grey context where they were cut. */
export function heldParts(openKey: string): ContextPart[] {
  const at = partitionOf(openKey);
  const owner = at ? state.plate.objects.find((obj) => obj.modelTree === at.ownerKey) : undefined;
  if (!at || !owner) return [];
  const out: ContextPart[] = [];
  for (const [index, key] of [...at.found.pieces.map((key, i) => [i + 2, key] as const), [PINS_PART, at.found.pins ?? null] as const]) {
    if (!key || index === at.open || state.plate.objects.some((row) => row.modelTree === key)) continue;
    const piece = heldPiece(key, owner);
    if (piece) out.push({ id: heldId(key), positions: piece.positions, matrix: piece.pose });
  }
  return out;
}

/** The pieces of the split to print the open part belongs to, or null when it has none whose pieces are on screen or held. */
function members(openId: string, openKey: string, openBox: Bounds, openPose: Affine, parts: readonly ContextPart[]): { cuts: { origin: Vec3; normal: Vec3 }[]; members: Member[]; open: number } | null {
  const at = partitionOf(openKey);
  if (!at) return null;
  const { found, ownerKey, open } = at;
  const owner = state.plate.objects.find((obj) => obj.modelTree === ownerKey);
  if (!owner) return null;
  const list: Member[] = [];
  // The pins come last, as in the export, after every piece.
  const rows = [...[ownerKey, ...found.pieces].map((key, index) => [index + 1, key] as const), [PINS_PART, found.pins ?? null] as const];
  for (const [part, key] of rows) {
    if (part === open) {
      list.push({ part: open, id: openId, centre: posedCentre(openBox, openPose) });
      continue;
    }
    const obj = key ? state.plate.objects.find((row) => row.modelTree === key) : undefined;
    const shown = obj ? parts.find((one) => one.id === obj.id) : undefined;
    if (shown) list.push({ part, id: shown.id, centre: posedCentre(boundsOf(shown.positions), shown.matrix) });
    else if (key && !obj) {
      const piece = heldPiece(key, owner);
      if (piece) list.push({ part, id: heldId(key), centre: posedCentre(boundsOf(piece.positions), piece.pose), held: { positions: piece.positions, matrix: piece.pose } });
    }
  }
  return list.length > 1 ? { cuts: cutsInModel(found.op, modelPoseOf(owner)), members: list, open } : null;
}

/** Whether the open part has pieces to explode: another piece of its split to print is on screen. Reads no mesh. */
export function canExplode(openKey: string, parts: readonly ContextPart[]): boolean {
  const at = partitionOf(openKey);
  if (!at) return false;
  const shown = new Set(parts.map((part) => part.id));
  return [...[at.ownerKey, ...at.found.pieces].map((key, index) => [index + 1, key] as const), [PINS_PART, at.found.pins ?? null] as const].some(([part, key]) => {
    if (!key || part === at.open) return false;
    const obj = state.plate.objects.find((row) => row.modelTree === key);
    return obj ? shown.has(obj.id) : modelTrees.has(key);
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
  const drawn = [...parts, ...found.members.flatMap((member) => (member.held && !parts.some((part) => part.id === member.id) ? [{ id: member.id, ...member.held }] : []))];
  return {
    parts: drawn.map((part) => {
      const shift = moved.get(part.id);
      return shift ? { ...part, matrix: shiftedPose(part.matrix, shift) } : part;
    }),
    tags: found.members.map((member, at) => ({ text: member.part === PINS_PART ? "Pins" : String(member.part), at: member.centre.map((value, i) => value + relative[at]![i]!) as Vec3 })),
    shifts: found.members.map((member, at) => `${member.part}:${relative[at]!.map(round).join(",")}`).join(" "),
  };
}
