/**
 * --- Organic surfaces: the plate boundary for the display mesh (src/model-mesh-quality.ts).
 *
 * The view shows the kernel's fine display mesh. Nothing that reaches the plate, a slice, an export or a project file
 * may come from it: `plateSolidOf` gives the node's plate-quality solid, asking the kernel again for that node without
 * the display field when the one in hand was a display reply. It is asked for only when the plate needs it (no extra
 * engine call while History is browsed): a commit that does not find it asks and commits again when it arrives; a
 * slice, an export or a save waits for it first (`settleShownMesh`).
 */
import { decodeSolid, type ParsedSolid } from "../../model-reply";
import { plateRequest } from "../../model-mesh-quality";
import { gotoRequest } from "../../model-request";
import type { NodeId } from "../../model-tree";
import { state } from "../state";
import { treeCall } from "./engine";
import { S } from "./shared";

const MAX = 8;
const ready = new Map<string, ParsedSolid>();
const asking = new Map<string, Promise<ParsedSolid | null>>();

const nameOf = (key: string, node: NodeId, chord: number) => `${key}#${node}@${chord}`;

/** The plate-quality solid of `key`'s `node`, when it is known already (`solid` itself when it was no display reply). */
export function cachedPlateSolid(key: string, node: NodeId, solid: ParsedSolid): ParsedSolid | null {
  if (!solid.displayMesh) return solid;
  return ready.get(nameOf(key, node, state.stepTolerance)) ?? null;
}

/** The plate-quality solid of `key`'s `node`: `solid` itself unless it was a display reply, else asked for again. */
export async function plateSolidOf(key: string, node: NodeId, solid: ParsedSolid): Promise<ParsedSolid | null> {
  if (!solid.displayMesh) return solid;
  const chord = state.stepTolerance;
  const name = nameOf(key, node, chord);
  const known = ready.get(name);
  if (known) return known;
  let pending = asking.get(name);
  if (!pending) {
    pending = treeCall(key, node, plateRequest(gotoRequest(key, node, chord))).then((body) => {
      const parsed = decodeSolid(body);
      asking.delete(name);
      if (typeof parsed === "string" || parsed.displayMesh) return null;
      ready.set(name, parsed);
      while (ready.size > MAX) ready.delete(ready.keys().next().value!);
      return parsed;
    });
    asking.set(name, pending);
  }
  return pending;
}

/** Before a slice, an export or a save: the shown node's plate mesh is in hand, so the commit can take it. */
export async function settleShownMesh(): Promise<void> {
  const at = S.open;
  if (at?.solid.displayMesh) await plateSolidOf(at.key, at.solid.id, at.solid);
}

/** Forget a tree's plate solids (a root edit rebuilds its nodes under the same ids). */
export function forgetPlateSolids(key: string) {
  for (const name of [...ready.keys()]) if (name.startsWith(`${key}#`)) ready.delete(name);
}
