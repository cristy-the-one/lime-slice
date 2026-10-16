/**
 * The History panel as data: one row per node of a Model history tree, laid out as a git graph,
 * and what each key does in it. A join is a merge: the steps that made its tool come in on a lane
 * of their own and meet at the join's row. No DOM here; `ui/model-history.ts` draws the rows.
 */
import { formatMm } from "./model-plane.ts";
import type { PlaceFields } from "./model-space.ts";
import type { ToolLink } from "./model-edit.ts";
import { ROOT, childrenOf, pathTo, subtree, toolUser, type JoinOp, type ModelNode, type ModelTree, type NodeId } from "./model-tree.ts";

/** Where a row sits against the shown step: before it in its history, it, after it on the branch Redo follows, or elsewhere. */
export type RowState = "past" | "current" | "redo" | "other";

/**
 * A row's name: the step's id, after the ids of the joins it is reached through, from the open tree down, joined by
 * "/". "4" is step 4 of the open solid; "2/3" is step 3 of the tool that its join at step 2 takes.
 */
export type RowKey = string;

export function rowKey(via: readonly NodeId[], id: NodeId): RowKey {
  return [...via, id].join("/");
}

/** The joins a row is reached through and its step, or null for a key that names no row. */
export function readRow(key: RowKey): { via: NodeId[]; id: NodeId } | null {
  const parts = key.split("/").map(Number);
  if (parts.length === 0 || parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  return { via: parts.slice(0, -1), id: parts.at(-1)! };
}

/** One vertical line in a rail column. `hot` when it leads into the shown step's history. */
export interface Rail {
  lane: number;
  hot: boolean;
}

export interface HistoryRow {
  key: RowKey;
  id: NodeId;
  /** The tree the step is in: the open one, or a tool's. */
  tree: string;
  /** The joins the row is reached through, from the open tree down; empty for the open solid's own steps. */
  via: NodeId[];
  /** On a tool's lane: the tool object's name, as the join that takes it says it. */
  tool: string | null;
  /** The first row of a tool's lane, where its name is shown. */
  toolStart: boolean;
  /** The row's own column: 0 is the main rail. */
  lane: number;
  /** The line into the dot from above, in the row's own column. */
  up: Rail | null;
  /** The line out of the dot to the next step on this branch, or into the join a tool's last step merges at. */
  down: Rail | null;
  /** Branches that start here: a curve from the dot down into each lane. */
  forks: Rail[];
  /** A join's tool lane, ending here: a curve from that lane above into the dot. */
  merges: Rail[];
  /** Other lines passing this row. */
  through: Rail[];
  /** 1 on the main rail, one more for each branch off it, and a tool's steps one more than their join. */
  level: number;
  /** Whether branches start here. */
  fork: boolean;
  /** A join's tool lane rows, which belong to it in the tree's structure though they are drawn above it. */
  owns: RowKey[];
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
  /** The branch each fork of the open tree continues down its own column. */
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

/** The tool a join of tree `key` takes, at the step it names, while that tree has the step; null otherwise. */
function toolOf(trees: ReadonlyMap<string, ModelTree>, node: ModelNode | undefined, seen: ReadonlySet<string>): { tree: ModelTree; op: JoinOp } | null {
  const op = node?.op;
  if (op?.kind !== "join" || seen.has(op.tool.key)) return null;
  const tree = trees.get(op.tool.key);
  return tree?.nodes.has(op.tool.node) ? { tree, op } : null;
}

/**
 * The rows the step `id` of `tree` was made from, itself included: the steps above it and, for each join among them,
 * the tool's steps up to the one it takes, at any depth, as a merge commit's history holds the branch it merged.
 */
function historyOf(trees: ReadonlyMap<string, ModelTree>, tree: ModelTree, via: readonly NodeId[], id: NodeId, out: Set<RowKey>, seen: ReadonlySet<string>) {
  const inner = new Set([...seen, tree.key]);
  for (const at of pathTo(tree, id)) {
    out.add(rowKey(via, at));
    const tool = toolOf(trees, tree.nodes.get(at), inner);
    if (tool) historyOf(trees, tool.tree, [...via, at], tool.op.tool.node, out, inner);
  }
}

/** The step a row names, in the tree it is in: through `via`'s joins from `tree`. Null when one of them is gone. */
export function rowStep(trees: ReadonlyMap<string, ModelTree>, tree: ModelTree, key: RowKey): { tree: ModelTree; id: NodeId; joins: ToolLink[] } | null {
  const row = readRow(key);
  if (!row) return null;
  let at = tree;
  const joins: ToolLink[] = [];
  for (const join of row.via) {
    const tool = toolOf(trees, at.nodes.get(join), new Set(joins.map((link) => link.tree.key)));
    if (!tool) return null;
    joins.push({ tree: at, id: join, op: tool.op });
    at = tool.tree;
  }
  return at.nodes.has(row.id) ? { tree: at, id: row.id, joins } : null;
}

/**
 * How many rows `historyLayout` draws for `tree`: one per step under the root, on every branch, and each join's tool
 * steps on its lane, nested lanes included. The History header shows it, so it counts the rows without laying them out.
 */
export function rowCount(tree: ModelTree, trees: ReadonlyMap<string, ModelTree> = new Map()): number {
  const lane = (node: ModelNode, seen: ReadonlySet<string>): number => {
    const tool = toolOf(trees, node, seen);
    if (!tool) return 0;
    const inner = new Set([...seen, tool.tree.key]);
    return pathTo(tool.tree, tool.op.tool.node).reduce((sum, id) => sum + 1 + lane(tool.tree.nodes.get(id)!, inner), 0);
  };
  const top = new Set([tree.key]);
  return [...subtree(tree, ROOT)].reduce((sum, id) => sum + 1 + lane(tree.nodes.get(id)!, top), 0);
}

/**
 * Rows oldest first: each step under its parent, side branches right under their fork in columns
 * of their own, and the followed branch straight down the parent's column, so the shown step's
 * path is the main rail. Right above each join, the steps that made its tool, from the tool's root
 * to the step the join takes, run down a lane of their own and merge into the join's row; a tool
 * that has joins of its own nests the same way. `keep` is an earlier layout's `main`: those forks
 * keep the branch they followed, so rows do not move while someone is working in the list. `trees`
 * holds the tools' trees. `shown` is the row on screen: the open tree's current step unless a tool's
 * step is shown.
 */
export function historyLayout(tree: ModelTree, keep?: ReadonlyMap<NodeId, NodeId>, trees: ReadonlyMap<string, ModelTree> = new Map(), shown?: RowKey): HistoryLayout {
  const shownKey = shown ?? rowKey([], tree.current);
  const hot = new Set<RowKey>();
  const target = rowStep(trees, tree, shownKey);
  if (target) historyOf(trees, target.tree, readRow(shownKey)!.via, target.id, hot, new Set(target.joins.map((join) => join.tree.key)));
  const ownShown = target?.joins.length === 0;
  const redo = ownShown ? redoChain(tree) : new Set<NodeId>();
  const kidsOf = new Map<NodeId, NodeId[]>();
  for (const node of [...tree.nodes.values()].sort((a, b) => a.id - b.id)) {
    if (node.parent !== null) kidsOf.set(node.parent, [...(kidsOf.get(node.parent) ?? []), node.id]);
  }
  const main = new Map<NodeId, NodeId>();
  /** Each node's children as drawn: the side branches, then the followed one last. */
  const shownKids = new Map<NodeId, NodeId[]>();
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
    shownKids.set(id, drawn);
    for (const kid of drawn) {
      level.set(kid, level.get(id)! + (kid === follow ? 0 : 1));
      if (tree.nodes.get(id)?.broken || brokenAbove.has(id)) brokenAbove.add(kid);
      visit(kid);
    }
  };
  if (tree.nodes.has(ROOT)) visit(ROOT);

  const rows: HistoryRow[] = [];
  const laneOf = new Map<NodeId, number>([[ROOT, 0]]);
  /** Lanes holding a line down to a row not drawn yet, by that row. */
  const waiting = new Map<number, RowKey>();
  let lanes = 1;
  const through = () => [...waiting].map(([at, key]) => ({ lane: at, hot: hot.has(key) })).sort((a, b) => a.lane - b.lane);
  const freeLane = (from: number) => {
    let free = from + 1;
    while (waiting.has(free)) free += 1;
    lanes = Math.max(lanes, free + 1);
    return free;
  };
  const state = (key: RowKey, redoStep: boolean): RowState => (key === shownKey ? "current" : hot.has(key) ? "past" : redoStep ? "redo" : "other");
  const text = (node: ModelNode) => ({ label: stepLabel(node), opLabel: node.name?.trim() ? node.label : null, broken: node.broken ?? null });

  /**
   * The lane of the tool the join `join` takes, drawn before the join's row: its steps from the root to the one the join
   * names, each before the lanes of its own joins. Returns the line the join's row merges, and the rows' keys.
   */
  const toolLane = (join: ModelNode, joinKey: RowKey, joinLane: number, joinLevel: number, via: NodeId[], seen: ReadonlySet<string>): { merge: Rail; owns: RowKey[] } | null => {
    const tool = toolOf(trees, join, seen);
    if (!tool) return null;
    const inner = new Set([...seen, tool.tree.key]);
    const lane = freeLane(joinLane);
    const path = pathTo(tool.tree, tool.op.tool.node);
    const here = [...via, join.id];
    const owns: RowKey[] = [];
    let blocked = false;
    path.forEach((id, i) => {
      const node = tool.tree.nodes.get(id)!;
      const key = rowKey(here, id);
      // The lane is taken while the steps this one's own join takes are drawn beside it.
      waiting.set(lane, key);
      const nested = toolLane(node, key, lane, joinLevel + 1, here, inner);
      waiting.delete(lane);
      const next = i + 1 < path.length ? rowKey(here, path[i + 1]!) : joinKey;
      rows.push({
        key,
        id,
        tree: tool.tree.key,
        via: here,
        tool: tool.op.tool.name,
        toolStart: i === 0,
        lane,
        up: i === 0 ? null : { lane, hot: hot.has(key) },
        down: { lane, hot: hot.has(next) },
        forks: [],
        merges: nested ? [nested.merge] : [],
        through: through(),
        level: joinLevel + 1,
        fork: false,
        owns: nested?.owns ?? [],
        state: state(key, false),
        ...text(node),
        blocked,
        plate: false,
      });
      owns.push(key);
      if (node.broken) blocked = true;
      waiting.set(lane, next);
    });
    waiting.delete(lane);
    return { merge: { lane, hot: hot.has(joinKey) }, owns };
  };

  for (const id of order) {
    const node = tree.nodes.get(id)!;
    const key = rowKey([], id);
    const lane = laneOf.get(id) ?? 0;
    const rowLevel = level.get(id) ?? 1;
    const lane2 = toolLane(node, key, lane, rowLevel, [], new Set([tree.key]));
    waiting.delete(lane);
    const passing = through();
    const kids = shownKids.get(id) ?? [];
    const follow = kids.at(-1);
    let down: Rail | null = null;
    if (follow != null) {
      laneOf.set(follow, lane);
      waiting.set(lane, rowKey([], follow));
      down = { lane, hot: hot.has(rowKey([], follow)) };
    }
    const forks = kids.slice(0, -1).map((kid) => {
      const free = freeLane(lane);
      laneOf.set(kid, free);
      waiting.set(free, rowKey([], kid));
      return { lane: free, hot: hot.has(rowKey([], kid)) };
    });
    rows.push({
      key,
      id,
      tree: tree.key,
      via: [],
      tool: null,
      toolStart: false,
      lane,
      up: node.parent === null ? null : { lane, hot: hot.has(key) },
      down,
      forks,
      merges: lane2 ? [lane2.merge] : [],
      through: passing,
      level: rowLevel,
      fork: forks.length > 0,
      owns: lane2?.owns ?? [],
      state: state(key, redo.has(id)),
      ...text(node),
      blocked: brokenAbove.has(id),
      plate: id === tree.committed && key !== shownKey,
    });
  }
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
 * Left and Right: the same depth on the next branch over, at the nearest fork above `id` of the open tree. Branches
 * are ordered by column: the followed one, then the side branches to its right. Below the fork it follows each branch
 * down its column; a shorter branch ends on its last step.
 */
export function siblingBranch(tree: ModelTree, layout: HistoryLayout, id: NodeId, step: -1 | 1): NodeId | null {
  const path = pathTo(tree, id);
  const laneOf = new Map(layout.rows.filter((row) => row.via.length === 0).map((row) => [row.id, row.lane]));
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
  | { kind: "move"; to: RowKey }
  | { kind: "jump"; to: RowKey }
  | { kind: "rename"; id: RowKey }
  | { kind: "drop"; id: RowKey }
  | { kind: "menu"; id: RowKey }
  /** Back to the canvas. */
  | { kind: "leave" };

export interface HistoryKey {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * What a key does on the focused row. Null for keys the panel leaves alone. Right on a join goes into its tool's lane,
 * to the step the join takes, and Left on a tool's step comes back to the join, as a tree item's children are reached;
 * elsewhere Left and Right switch branches.
 */
export function historyKey(ev: HistoryKey, tree: ModelTree, layout: HistoryLayout, focused: RowKey): HistoryAction | null {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  const keys = layout.rows.map((row) => row.key);
  const at = keys.indexOf(focused);
  if (at < 0) return null;
  const row = layout.rows[at]!;
  const move = (to: RowKey | undefined | null): HistoryAction | null => (to == null || to === focused ? null : { kind: "move", to });
  const branch = (step: -1 | 1) => {
    const next = row.via.length === 0 ? siblingBranch(tree, layout, row.id, step) : null;
    return next == null ? null : rowKey([], next);
  };
  switch (ev.key) {
    case "ArrowUp":
      return move(keys[at - 1]);
    case "ArrowDown":
      return move(keys[at + 1]);
    case "Home":
      return move(keys[0]);
    case "End":
      return move(keys.at(-1));
    case "ArrowLeft":
      return move(row.via.length > 0 ? rowKey(row.via.slice(0, -1), row.via.at(-1)!) : branch(-1));
    case "ArrowRight":
      return move(row.owns.length > 0 ? row.owns.at(-1) : branch(1));
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
