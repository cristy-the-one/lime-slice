/**
 * Organic surfaces S4: open sheets as plate objects, the app's one rule over MCP.
 *
 * The rule is the app's (src/model-sheet.ts): `isOpenSheet` on the kernel's reply, with the object's mark passed as
 * `marked`, so a surfaces-only STEP root is a sheet only once its plate object is marked, as in the app.
 * `src/modeling/model-calls.ts` `solidView` drops `nakedEdges`, so the session reads replies through the `solidView`
 * here, which keeps them.
 *
 * The mark is the app's field: `PlateObject.sheet` (`sheet: true` on the object), written to the project row as the
 * app writes it (`if (obj.sheet) row.sheet = true`, which makes the file version 5) and read back on project_open. It
 * is set or cleared when an object's committed shape changes (a commit, which apply, build and edit go through; a
 * project open; a duplicate or a shell split carries it). The committed history node keeps the kernel's verdict in
 * `ModelNode.sheet`, as the app keeps it for the History badge; it is not saved. Slice, the G-code export and the 3MF
 * export stop on a marked object with one sentence.
 */
import { isOpenSheet, type SheetShape } from "../../src/model-sheet.ts";
import { solidView as kernelSolidView } from "../../src/modeling/model-calls.ts";
import type { ModelTree } from "../../src/model-tree.ts";
import { refuse, type Refusal } from "../refusals.ts";
import { shownName } from "./shared.ts";

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

/** Whether the shape the object shows now (its tree's current step) is an open sheet, by the app's rule. */
export function showsSheet(obj: Marked): boolean {
  const tree = obj.tree;
  if (!tree || tree.root.kind === "piece") return false;
  return isOpenSheet(obj.solid as SheetShape | null, tree.root, tree.current, obj.sheet === true);
}

/** Sets or clears the object's mark (`PlateObject.sheet`), and keeps the verdict on its committed node (`ModelNode.sheet`). */
export function markSheet(obj: Marked, sheet: boolean): void {
  if (sheet) obj.sheet = true;
  else delete obj.sheet;
  const tree = obj.tree;
  const node = tree?.nodes.get(tree.committed);
  if (!tree || !node || node.sheet === sheet) return;
  const nodes = new Map(tree.nodes);
  nodes.set(tree.committed, { ...node, sheet });
  obj.tree = { ...tree, nodes };
}

/**
 * The sentence Slice and the exports stop with: the first marked object, or null when none is. The app's is
 * `sheetPartNote`; this one also names the object's id, the call that stopped, and the MCP ops that make it a solid.
 */
export function openSheetRefusal(objects: readonly { id: string; name: string; sheet?: true }[], what: string): Refusal | null {
  const sheet = objects.find((obj) => obj.sheet === true);
  if (!sheet) return null;
  return refuse(
    "open-sheet",
    `${shownName(sheet.name)} (${sheet.id}) is an open sheet, not a solid, so it cannot be ${what}. Thicken it ({kind:"thicken", thickness}) or sew it shut ({kind:"sew", capPlanar:true}) and commit, then try again.`,
    { object: sheet.id },
  );
}
