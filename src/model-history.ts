/**
 * The History panel as data: one row per node of a Model history tree, laid out as a git graph,
 * and what each key does in it. No DOM here; `ui/model-history.ts` draws the rows.
 */
import { formatMm } from "./model-plane.ts";
import type { PlaceFields } from "./model-space.ts";
import { ROOT, childrenOf, pathTo, subtree, toolUser, type ModelNode, type ModelTree, type NodeId } from "./model-tree.ts";

/** Where a row sits against the shown node: before it on its path, it, after it on the branch Redo follows, or elsewhere. */
export type RowState = "past" | "current" | "redo" | "other";

/** One vertical line in a rail column. `hot` when it is on the path to the shown node. */
export interface Rail {
  lane: number;
  hot: boolean;
}

export interface HistoryRow {
  id: NodeId;
  /** The row's own column: 0 is the main rail. */
  lane: number;
  /** The line into the dot from above, in the row's own column. */
  up: Rail | null;
  /** The line out of the dot to the next step on this branch. */
  down: Rail | null;
  /** Branches that start here: a curve from the dot down into each lane. */
  forks: Rail[];
  /** Other branches' lines passing this row. */
  through: Rail[];
  /** 1 on the main rail, one more for each branch off it. */
  level: number;
  /** Whether branches start here. */
  fork: boolean;
  state: RowState;
  /** The row's text: the user's name for the step, else the op. */
  label: string;
  /** The op, when the user named the step. */
  opLabel: string | null;
  broken: string | null;
  /** A step above this one is broken, so this one cannot be shown either. */
  blocked: boolean;
  /** The plate holds this step while the view shows another. */
  plate: boolean;
}

export interface HistoryLayout {
  rows: HistoryRow[];
  /** Columns the widest row needs. */
  lanes: number;
  /** The branch each fork continues down its own column. */
  main: ReadonlyMap<NodeId, NodeId>;
}

/** The text a step shows: its user name, else its op label. */
export function stepLabel(node: Pick<ModelNode, "label" | "name">): string {
  return node.name?.trim() || node.label;
}

/** The child a branch continues with: the one Redo follows, else the newest. */
function pickFollowed(tree: ModelTree, id: NodeId, kids: readonly NodeId[]): NodeId | null {
  if (kids.length === 0) return null;
  const last = tree.lastChild.get(id);
  return last != null && kids.includes(last) ? last : kids[kids.length - 1]!;
}

/** The steps Redo walks from the shown node. */
function redoChain(tree: ModelTree): Set<NodeId> {
  const chain = new Set<NodeId>();
  for (let at = tree.lastChild.get(tree.current); at != null && tree.nodes.has(at) && !chain.has(at); at = tree.lastChild.get(at)) chain.add(at);
  return chain;
}

/**
 * Rows oldest first: each step under its parent, side branches right under their fork in columns
 * of their own, and the followed branch straight down the parent's column, so the shown step's
 * path is the main rail. `keep` is an earlier layout's `main`: those forks keep the branch they
 * followed, so rows do not move while someone is working in the list.
 */
export function historyLayout(tree: ModelTree, keep?: ReadonlyMap<NodeId, NodeId>): HistoryLayout {
  const path = new Set(pathTo(tree, tree.current));
  const redo = redoChain(tree);
  const kidsOf = new Map<NodeId, NodeId[]>();
  for (const node of [...tree.nodes.values()].sort((a, b) => a.id - b.id)) {
    if (node.parent !== null) kidsOf.set(node.parent, [...(kidsOf.get(node.parent) ?? []), node.id]);
  }
  const main = new Map<NodeId, NodeId>();
  /** Each node's children as drawn: the side branches, then the followed one last. */
  const shown = new Map<NodeId, NodeId[]>();
  const brokenAbove = new Set<NodeId>();
  const order: NodeId[] = [];
  const level = new Map<NodeId, number>([[ROOT, 1]]);
  const visit = (id: NodeId) => {
    order.push(id);
    const kids = kidsOf.get(id) ?? [];
    const kept = keep?.get(id);
    const follow = kept != null && kids.includes(kept) ? kept : pickFollowed(tree, id, kids);
    const drawn = follow == null ? [] : [...kids.filter((kid) => kid !== follow), follow];
    if (follow != null) main.set(id, follow);
    shown.set(id, drawn);
    for (const kid of drawn) {
      level.set(kid, level.get(id)! + (kid === follow ? 0 : 1));
      if (tree.nodes.get(id)?.broken || brokenAbove.has(id)) brokenAbove.add(kid);
      visit(kid);
    }
  };
  if (tree.nodes.has(ROOT)) visit(ROOT);

  const laneOf = new Map<NodeId, number>([[ROOT, 0]]);
  /** Lanes holding a line down to a step not drawn yet, by that step. */
  const waiting = new Map<number, NodeId>();
  let lanes = 1;
  const rows = order.map((id): HistoryRow => {
    const node = tree.nodes.get(id)!;
    const lane = laneOf.get(id) ?? 0;
    waiting.delete(lane);
    const through = [...waiting].map(([at, child]) => ({ lane: at, hot: path.has(child) })).sort((a, b) => a.lane - b.lane);
    const kids = shown.get(id) ?? [];
    const follow = kids.at(-1);
    let down: Rail | null = null;
    if (follow != null) {
      laneOf.set(follow, lane);
      waiting.set(lane, follow);
      down = { lane, hot: path.has(follow) };
    }
    const forks = kids.slice(0, -1).map((kid) => {
      let free = lane + 1;
      while (waiting.has(free)) free += 1;
      laneOf.set(kid, free);
      waiting.set(free, kid);
      lanes = Math.max(lanes, free + 1);
      return { lane: free, hot: path.has(kid) };
    });
    const named = !!node.name?.trim();
    return {
      id,
      lane,
      up: node.parent === null ? null : { lane, hot: path.has(id) },
      down,
      forks,
      through,
      level: level.get(id) ?? 1,
      fork: forks.length > 0,
      state: id === tree.current ? "current" : path.has(id) ? "past" : redo.has(id) ? "redo" : "other",
      label: stepLabel(node),
      opLabel: named ? node.label : null,
      broken: node.broken ?? null,
      blocked: brokenAbove.has(id),
      plate: id === tree.committed && tree.committed !== tree.current,
    };
  });
  return { rows, lanes, main };
}

/**
 * Why a branch cannot be deleted, in plain words, or null when it can. Mirrors `dropped`, and with every tree in
 * `trees` also keeps a step that another tree's join takes as its tool, as the engine's `drop` does.
 */
export function dropRefusal(tree: ModelTree, id: NodeId, trees: ReadonlyMap<string, ModelTree> = new Map()): string | null {
  const node = tree.nodes.get(id);
  if (!node) return "This step is no longer in the history.";
  if (node.parent === null) return tree.root.kind === "primitive" ? "The primitive this solid started as begins the history and stays." : "The opened file starts the history and stays.";
  const gone = subtree(tree, id);
  if (gone.has(tree.current)) return "The step on screen is on this branch. Go to another branch first.";
  if (gone.has(tree.committed)) return "The plate still holds a step on this branch.";
  if ([...gone].some((at) => tree.nodes.get(at)?.mesh)) return "The plate held a step on this branch, and Prepare undo can bring it back.";
  if ([...gone].some((at) => tree.nodes.get(at)?.piece)) return "A split on this branch made a part of its own.";
  const user = toolUser(trees, tree.key, gone);
  if (user) return `“${user.name ?? user.label}” in another part's history uses a step on this branch as its tool.`;
  return null;
}

/**
 * Left and Right: the same depth on the next branch over, at the nearest fork above `id`. Branches
 * are ordered by column: the followed one, then the side branches to its right. Below the fork it
 * follows each branch down its column; a shorter branch ends on its last step.
 */
export function siblingBranch(tree: ModelTree, layout: HistoryLayout, id: NodeId, step: -1 | 1): NodeId | null {
  const path = pathTo(tree, id);
  const laneOf = new Map(layout.rows.map((row) => [row.id, row.lane]));
  for (let i = path.length - 1; i > 0; i -= 1) {
    const branch = path[i]!;
    const siblings = childrenOf(tree, path[i - 1]!).sort((a, b) => (laneOf.get(a) ?? 0) - (laneOf.get(b) ?? 0));
    if (siblings.length < 2) continue;
    const next = siblings[siblings.indexOf(branch) + step];
    if (next == null) return null;
    let at = next;
    for (let depth = i + 1; depth < path.length; depth += 1) {
      const deeper = layout.main.get(at);
      if (deeper == null) break;
      at = deeper;
    }
    return at;
  }
  return null;
}

export type HistoryAction =
  /** Move focus there; the view follows after the typing pause. */
  | { kind: "move"; to: NodeId }
  | { kind: "jump"; to: NodeId }
  | { kind: "rename"; id: NodeId }
  | { kind: "drop"; id: NodeId }
  | { kind: "menu"; id: NodeId }
  /** Back to the canvas. */
  | { kind: "leave" };

export interface HistoryKey {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** What a key does on the focused row. Null for keys the panel leaves alone. */
export function historyKey(ev: HistoryKey, tree: ModelTree, layout: HistoryLayout, focused: NodeId): HistoryAction | null {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  const ids = layout.rows.map((row) => row.id);
  const at = ids.indexOf(focused);
  if (at < 0) return null;
  const move = (to: NodeId | undefined | null): HistoryAction | null => (to == null || to === focused ? null : { kind: "move", to });
  switch (ev.key) {
    case "ArrowUp":
      return move(ids[at - 1]);
    case "ArrowDown":
      return move(ids[at + 1]);
    case "Home":
      return move(ids[0]);
    case "End":
      return move(ids.at(-1));
    case "ArrowLeft":
      return move(siblingBranch(tree, layout, focused, -1));
    case "ArrowRight":
      return move(siblingBranch(tree, layout, focused, 1));
    case "Enter":
    case " ":
      return { kind: "jump", to: focused };
    case "F2":
      return { kind: "rename", id: focused };
    case "Delete":
      return { kind: "drop", id: focused };
    case "F10":
      return ev.shiftKey ? { kind: "menu", id: focused } : null;
    case "ContextMenu":
      return { kind: "menu", id: focused };
    case "Escape":
      return { kind: "leave" };
    default:
      return null;
  }
}

/**
 * The Position row above the tree: the open object's pose as Place's fields read it, X, Y and Z from where its file put
 * it and the turns about its centre, each shown only when it is not 0 at the panel's precision. "At file position" for
 * none. Place moves are not steps (a pose is the plate object's, not a kernel op), so the row is not a node.
 */
export function positionText(fields: PlaceFields): string {
  const parts: string[] = [];
  for (const [key, name] of [["x", "X"], ["y", "Y"], ["z", "Z"]] as const) {
    const text = formatMm(fields[key]);
    if (text !== "0") parts.push(`${name} ${text}`);
  }
  for (const [key, name] of [["rx", "X"], ["ry", "Y"], ["rz", "Z"]] as const) {
    const text = formatMm(fields[key]);
    if (text !== "0") parts.push(`Turn ${name} ${text}°`);
  }
  return parts.length === 0 ? "At file position" : parts.join(" · ");
}
