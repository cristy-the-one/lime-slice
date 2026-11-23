/**
 * Organic surfaces S4: open sheets as plate objects, the app's one rule over MCP.
 *
 * The rule is the app's `isOpenSheet` (src/model-sheet.ts in #824): the kernel says the shape is not editable (no closed
 * solid), it has faces, and it has open borders (`nakedEdges`), unless it is the root of a STEP import, which opens,
 * commits and slices as it did on 7.1.2. `src/modeling/model-calls.ts` `solidView` drops `nakedEdges`, so the session
 * reads replies through the `solidView` here, which keeps them.
 *
 * The mark is set or cleared when an object's committed shape changes (a commit, which apply, build and edit go
 * through; a project open; a duplicate or a shell split carries it). It lives on the plate object (`sheet`) and on the
 * committed history node (`sheet: true`, the field the app's saved tree carries from #824). Slice, the G-code export
 * and the 3MF export stop on a marked object with one sentence.
 *
 * Until #824 is merged, src/model-sheet.ts is not on this branch: `isOpenSheet` below is that function, word for word.
 * Import it from there once both are in.
 */
import { solidView as kernelSolidView } from "../../src/modeling/model-calls.ts";
import { ROOT, type ModelTree, type NodeId } from "../../src/model-tree.ts";
import { refuse, type Refusal } from "../refusals.ts";
import { shownName } from "./shared.ts";

export interface SheetShape {
  editable: boolean;
  faces: { length: number };
  nakedEdges?: readonly number[];
}

/** True when `shape`, shown at `node` of a tree with `root`, is an open sheet a step or a feature built. */
export function isOpenSheet(shape: SheetShape | null | undefined, root: { kind: string } | null | undefined, node: NodeId): boolean {
  if (!shape || shape.editable || shape.faces.length === 0 || (shape.nakedEdges?.length ?? 0) === 0) return false;
  // A STEP that opened as surfaces with no closed solid: an import, as on v7.1.2, not a built sheet.
  if (node === ROOT && root?.kind === "step") return false;
  return true;
}

/** The kernel's solid view, keeping the open borders the plain view drops. */
export function solidView(body: Record<string, unknown>) {
  const view = kernelSolidView(body);
  if (!view) return view;
  const naked = Array.isArray(body.nakedEdges) ? body.nakedEdges.filter((edge): edge is number => Number.isInteger(edge) && (edge as number) >= 0) : [];
  return naked.length > 0 ? Object.assign(view, { nakedEdges: naked }) : view;
}

interface Marked {
  name: string;
  sheet?: true;
  solid: unknown;
  tree: ModelTree | null;
}

/** Whether the shape the object shows now (its tree's current step) is an open sheet. */
export function showsSheet(obj: Marked): boolean {
  const tree = obj.tree;
  if (!tree || tree.root.kind === "piece") return false;
  return isOpenSheet(obj.solid as SheetShape | null, tree.root, tree.current);
}

/** Sets or clears the mark on the object and on its committed history node. */
export function markSheet(obj: Marked, sheet: boolean): void {
  if (sheet) obj.sheet = true;
  else delete obj.sheet;
  const tree = obj.tree;
  const node = tree?.nodes.get(tree.committed) as ({ sheet?: true } & object) | undefined;
  if (!tree || !node) return;
  const marked = node.sheet === true;
  if (marked === sheet) return;
  const next = { ...node } as { sheet?: true };
  if (sheet) next.sheet = true;
  else delete next.sheet;
  const nodes = new Map(tree.nodes);
  nodes.set(tree.committed, next as never);
  obj.tree = { ...tree, nodes };
}

/** The committed node's mark, as a saved tree carries it. */
export function treeMarked(tree: ModelTree | null | undefined): boolean {
  return (tree?.nodes.get(tree.committed) as { sheet?: true } | undefined)?.sheet === true;
}

/** The sentence Slice and the exports stop with: the first marked object, or null when none is. */
export function openSheetRefusal(objects: readonly { id: string; name: string; sheet?: true }[], what: string): Refusal | null {
  const sheet = objects.find((obj) => obj.sheet === true);
  if (!sheet) return null;
  return refuse(
    "open-sheet",
    `${shownName(sheet.name)} (${sheet.id}) is an open sheet, not a solid, so it cannot be ${what}. Thicken it ({kind:"thicken", thickness}) or sew it shut ({kind:"sew", capPlanar:true}) and commit, then try again.`,
    { object: sheet.id },
  );
}
