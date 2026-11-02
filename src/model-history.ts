/**
 * The History panel as data: one row per node of a Model history tree, laid out as a git graph,
 * and what each key does in it. A join is a merge: the steps that made its tool come in on a lane
 * of their own and meet at the join's row. No DOM here; `ui/model-history.ts` draws the rows.
 */
import { formatMm } from "./model-plane.ts";
import type { PlaceFields } from "./model-space.ts";
import type { ToolLink } from "./model-edit.ts";
import { ROOT, childrenOf, historyCaption, makesParts, pathTo, redoTarget, subtree, toolUser, undoTarget, type JoinOp, type ModelNode, type ModelTree, type NodeId, type PluginStamp, type RunMark } from "./model-tree.ts";
import { RECIPE_API, runEndingAt, runRedoFrom } from "./plugin-step.ts";
import type { CheckedCopy, PluginParamInfo } from "./plugin-file.ts";

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
  /** The step this row was built on. The root has none. */
  parent: NodeId | null;
  /** --- Plugin steps (D8). The recipe run this step is part of, and on its first step what ran. */
  run?: RunMark;
  plugin?: PluginStamp;
  /**
   * Set when this row is part of a folded MCP composite (`prefix k/n`).
   * A collapsed run is one row; an expanded run marks its first step so it can fold again.
   */
  fold?: FoldMark;
}

/** A collapsible run of steps named `prefix 1/n` … `prefix n/n`. */
export interface FoldMark {
  id: string;
  /** The collapsed stand-in, or the first step while the run is open. */
  head: boolean;
  expanded: boolean;
  keys: RowKey[];
  /** The last step: Undo from here lands before the first, and a click shows it. */
  lastKey: RowKey;
  /** The member on screen, when the view is inside this run. */
  shownLabel?: string;
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
  const text = (node: ModelNode) => {
    const feature = node.op ?? (node.id === ROOT && tree.root.kind === "feature" ? tree.root.op : null);
    return { label: node.name?.trim() || historyCaption(feature, node.label), opLabel: node.name?.trim() ? node.label : null, broken: node.broken ?? null };
  };

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
        parent: node.parent,
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
      parent: node.parent,
      ...(node.run ? { run: node.run } : {}),
      ...(node.plugin ? { plugin: node.plugin } : {}),
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
  if (node.parent === null) {
    if (tree.root.kind === "primitive") return "The primitive this solid started as begins the history and stays.";
    if (tree.root.kind === "feature") return "The sketch this solid started as begins the history and stays.";
    return "The opened file starts the history and stays.";
  }
  const gone = subtree(tree, id);
  if (gone.has(tree.current)) return "The step on screen is on this branch. Go to another branch first.";
  if (gone.has(tree.committed)) return "The plate still holds a step on this branch.";
  if ([...gone].some((at) => tree.nodes.get(at)?.mesh)) return "The plate held a step on this branch, and Prepare undo can bring it back.";
  if ([...gone].some((at) => tree.nodes.get(at)?.piece)) return "A split on this branch made a part of its own.";
  if ([...gone].some((at) => makesParts(tree.nodes.get(at)))) return "A split to print on this branch made parts of their own.";
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
  /** Open a folded composite so its steps show. */
  | { kind: "expand"; id: string }
  /** Fold a composite back into one row. */
  | { kind: "collapse"; id: string }
  /** Back to the canvas. */
  | { kind: "leave" }
  /** --- D29. Add the row to the steps Pattern or Mirror repeats, or take it out. */
  | { kind: "pick"; id: RowKey };

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
 * elsewhere Left and Right switch branches. `picking`: Pattern or Mirror is open, so Enter and Space choose the row as a
 * step to repeat instead of showing it (the panel moves focus without showing a step then too).
 */
export function historyKey(ev: HistoryKey, tree: ModelTree, layout: HistoryLayout, focused: RowKey, picking = false): HistoryAction | null {
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
      // An open composite folds on Left from its first step. Elsewhere Left still switches branches.
      if (row.fold?.head && row.fold.expanded) return { kind: "collapse", id: row.fold.id };
      return move(row.via.length > 0 ? rowKey(row.via.slice(0, -1), row.via.at(-1)!) : branch(-1));
    case "ArrowRight":
      if (row.fold?.head && !row.fold.expanded) return { kind: "expand", id: row.fold.id };
      return move(row.owns.length > 0 ? row.owns.at(-1) : branch(1));
    case "Enter":
    case " ":
      if (picking) return { kind: "pick", id: focused };
      return { kind: "jump", to: row.fold && !row.fold.expanded ? row.fold.lastKey : focused };
    case "F2":
      if (row.fold && !row.fold.expanded) return null;
      return { kind: "rename", id: focused };
    case "Delete":
      if (row.fold && !row.fold.expanded) return null;
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
 * it and the turns about its centre, each shown only when it is not 0 at the panel's precision. "Placed as in the file"
 * for none. Place moves are not steps (a pose is the plate object's, not a kernel op), so the row is not a node.
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
  return parts.length === 0 ? "Placed as in the file" : parts.join(" · ");
}

// --- A8. Files that still have rows named "prefix k/n" fold those runs. A9 stores a new MCP composite as one group, already one row.
// Consecutive rows that run 1/n … n/n fold into one collapsible row. The shown step stays a node. ---

/** "rim leaves 3/12" → { prefix: "rim leaves", k: 3, n: 12 }. A single step (n < 2) is not a run. */
export function pieceLabel(text: string): { prefix: string; k: number; n: number } | null {
  const match = /^(.+) (\d+)\/(\d+)$/.exec(text.trim());
  if (!match) return null;
  const prefix = match[1]!.trim();
  const k = Number(match[2]);
  const n = Number(match[3]);
  if (!prefix || !Number.isInteger(k) || !Number.isInteger(n) || n < 2 || k < 1 || k > n) return null;
  return { prefix, k, n };
}

/** The row a folded composite shows: "rim leaves · 12 steps". */
export function foldTitle(prefix: string, n: number): string {
  return `${prefix} · ${n} steps`;
}

export interface HistoryFold {
  id: string;
  prefix: string;
  n: number;
  label: string;
  keys: RowKey[];
  first: NodeId;
  last: NodeId;
  /** A recipe run's fold: what ran, from its first step. */
  plugin?: PluginStamp;
}

/** --- Plugin steps (D8). The title a plugin step's row shows: the plugin's own title when the project has its file. */
export type PluginTitle = (stamp: PluginStamp) => string | undefined;

/** "Bolt-circle flange · plugin v3", or "studs · draft" for a run kept only with the project. */
export function pluginRowLabel(stamp: PluginStamp, title?: string): string {
  return `${title?.trim() || stamp.plugin} · ${stamp.version > 0 ? `plugin v${stamp.version}` : "draft"}`;
}

/** Rows `i` … `i + n - 1` are one chain: each built on the one before, in one tree, reached the same way. */
function chained(rows: readonly HistoryRow[], i: number, n: number): boolean {
  for (let k = 1; k < n; k += 1) {
    const row = rows[i + k]!;
    const prev = rows[i + k - 1]!;
    if (row.parent !== prev.id || row.tree !== prev.tree || row.via.join("/") !== prev.via.join("/")) return false;
  }
  return true;
}

/**
 * Consecutive rows on one chain that are one recipe run (`run` 1/n … n/n), and rows whose names run `prefix 1/n` …
 * `prefix n/n`. A run of two or more steps folds under its plugin's name; a stamped run of one step is one row already.
 */
export function historyFolds(rows: readonly HistoryRow[], title?: PluginTitle): HistoryFold[] {
  const folds: HistoryFold[] = [];
  let i = 0;
  while (i < rows.length) {
    const head = rows[i]!;
    if (head.run && head.run.k === 1 && head.plugin && head.run.n >= 2 && i + head.run.n <= rows.length) {
      const n = head.run.n;
      const members = rows.slice(i, i + n);
      if (members.every((row, k) => row.run?.id === head.run!.id && row.run.k === k + 1 && row.run.n === n) && chained(rows, i, n)) {
        folds.push({ id: `fold:${head.key}`, prefix: head.plugin.plugin, n, label: pluginRowLabel(head.plugin, title?.(head.plugin)), keys: members.map((row) => row.key), first: head.id, last: members[n - 1]!.id, plugin: head.plugin });
        i += n;
        continue;
      }
    }
    const start = pieceLabel(rows[i]!.label);
    if (!start || start.k !== 1) {
      i += 1;
      continue;
    }
    const { prefix, n } = start;
    if (i + n > rows.length) {
      i += 1;
      continue;
    }
    let ok = true;
    for (let k = 1; k <= n; k += 1) {
      const row = rows[i + k - 1]!;
      const got = pieceLabel(row.label);
      if (!got || got.prefix !== prefix || got.n !== n || got.k !== k) {
        ok = false;
        break;
      }
      if (k > 1) {
        const prev = rows[i + k - 2]!;
        if (row.parent !== prev.id || row.tree !== prev.tree || row.via.join("/") !== prev.via.join("/")) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) {
      i += 1;
      continue;
    }
    const members = rows.slice(i, i + n);
    const first = members[0]!;
    folds.push({
      id: `fold:${first.key}`,
      prefix,
      n,
      label: foldTitle(prefix, n),
      keys: members.map((row) => row.key),
      first: first.id,
      last: members[n - 1]!.id,
    });
    i += n;
  }
  return folds;
}

/** The rows to draw: a collapsed run is one row, an open run keeps its steps and marks the first. */
export function presentedRows(rows: readonly HistoryRow[], open: ReadonlySet<string>, title?: PluginTitle): HistoryRow[] {
  const folds = historyFolds(rows, title);
  const out: HistoryRow[] = [];
  const hidden = new Set<RowKey>();
  for (const fold of folds) if (!open.has(fold.id)) for (const key of fold.keys) hidden.add(key);
  for (const row of rows) {
    const fold = folds.find((item) => item.keys[0] === row.key);
    if (fold && !open.has(fold.id)) {
      out.push(collapsedFold(rows, fold));
      continue;
    }
    if (hidden.has(row.key)) continue;
    // A one-step plugin run is one row already: it takes the plugin's name, its op beside it.
    if (row.plugin && row.run?.n === 1) {
      out.push({ ...row, label: pluginRowLabel(row.plugin, title?.(row.plugin)), opLabel: row.label });
      continue;
    }
    if (fold && open.has(fold.id)) out.push({ ...row, fold: { id: fold.id, head: true, expanded: true, keys: fold.keys, lastKey: fold.keys[fold.keys.length - 1]! } });
    else out.push(row);
  }
  return out;
}

function collapsedFold(rows: readonly HistoryRow[], fold: HistoryFold): HistoryRow {
  const members = fold.keys.map((key) => rows.find((row) => row.key === key)!);
  const first = members[0]!;
  const last = members[members.length - 1]!;
  const shown = members.find((row) => row.state === "current");
  const broken = members.find((row) => row.broken);
  return {
    ...first,
    key: fold.id,
    id: (shown ?? last).id,
    label: fold.label,
    opLabel: shown ? `Showing ${shown.label}` : null,
    down: last.down,
    forks: last.forks,
    fork: last.fork,
    owns: [],
    merges: first.merges,
    state: shown ? "current" : members.every((row) => row.state === "past") ? "past" : members.every((row) => row.state === "redo") ? "redo" : members.every((row) => row.state === "other") ? "other" : "past",
    broken: broken?.broken ?? null,
    blocked: first.blocked,
    plate: members.some((row) => row.plate),
    toolStart: false,
    fold: { id: fold.id, head: true, expanded: false, keys: fold.keys, lastKey: last.key, shownLabel: shown?.label },
  };
}

/** A join whose tool tree is open draws a lane, which would split the run. */
function toolLaneOpen(node: ModelNode, trees: ReadonlyMap<string, ModelTree> | undefined): boolean {
  const op = node.op;
  if (op?.kind !== "join" || !trees) return false;
  return trees.get(op.tool.key)?.nodes.has(op.tool.node) ?? false;
}

/**
 * The run of `prefix 1/n` … `prefix n/n` that ends at `id`, when those steps are one chain with nothing drawn
 * between them. Null when `id` is not the last step of such a run.
 */
export function foldEndingAt(tree: ModelTree, id: NodeId, trees?: ReadonlyMap<string, ModelTree>, title?: PluginTitle): { label: string; first: NodeId; last: NodeId; before: NodeId | null } | null {
  // --- Plugin steps (D8). A stamped recipe run on a part it was given is one undo step, by its run id.
  const run = runEndingAt(tree, id);
  if (run?.stamp && run.before !== null) return { label: pluginRowLabel(run.stamp, title?.(run.stamp)), first: run.first, last: run.last, before: run.before };
  const node = tree.nodes.get(id);
  const piece = node ? pieceLabel(stepLabel(node)) : null;
  if (!node || !piece || piece.k !== piece.n) return null;
  const chain: ModelNode[] = [];
  let at: ModelNode | undefined = node;
  for (let k = piece.n; k >= 1; k -= 1) {
    if (!at) return null;
    const got = pieceLabel(stepLabel(at));
    if (!got || got.prefix !== piece.prefix || got.n !== piece.n || got.k !== k) return null;
    // A tool lane, or a side branch, is drawn between this step and the next, so the rows are not one run.
    // The first step's lane sits above the run, and the last step's branches sit below it.
    if (k > 1 && toolLaneOpen(at, trees)) return null;
    if (k < piece.n && childrenOf(tree, at.id).length !== 1) return null;
    chain.push(at);
    at = k === 1 ? undefined : at.parent === null ? undefined : tree.nodes.get(at.parent);
  }
  const first = chain[chain.length - 1]!;
  return { label: foldTitle(piece.prefix, piece.n), first: first.id, last: id, before: first.parent };
}

/**
 * The run Redo would walk whole, when the next step is its `prefix 1/n` and the followed children run to `n/n`
 * with nothing drawn between them.
 */
export function foldRedoFrom(tree: ModelTree, trees?: ReadonlyMap<string, ModelTree>, title?: PluginTitle): { label: string; last: NodeId } | null {
  const run = runRedoFrom(tree);
  if (run?.stamp && run.before !== null) return { label: pluginRowLabel(run.stamp, title?.(run.stamp)), last: run.last };
  const next = redoTarget(tree);
  if (next == null) return null;
  let at = tree.nodes.get(next);
  const piece = at ? pieceLabel(stepLabel(at)) : null;
  if (!at || !piece || piece.k !== 1) return null;
  for (let k = 1; k <= piece.n; k += 1) {
    if (!at) return null;
    const got = pieceLabel(stepLabel(at));
    if (!got || got.prefix !== piece.prefix || got.n !== piece.n || got.k !== k) return null;
    if (k > 1 && toolLaneOpen(at, trees)) return null;
    if (k < piece.n && childrenOf(tree, at.id).length !== 1) return null;
    if (k === piece.n) return { label: foldTitle(piece.prefix, piece.n), last: at.id };
    const child = tree.lastChild.get(at.id);
    at = child != null ? tree.nodes.get(child) : undefined;
  }
  return null;
}

/** Where Undo goes: before a folded composite when the shown step is its last step, otherwise the parent. */
export function foldedUndoTarget(tree: ModelTree, trees?: ReadonlyMap<string, ModelTree>): NodeId | null {
  const fold = foldEndingAt(tree, tree.current, trees);
  if (fold) return fold.before;
  return undoTarget(tree);
}

/** Where Redo goes: the end of a folded composite when the next steps are that whole run, otherwise the next step. */
export function foldedRedoTarget(tree: ModelTree, trees?: ReadonlyMap<string, ModelTree>): NodeId | null {
  return foldRedoFrom(tree, trees)?.last ?? redoTarget(tree);
}

export interface RecipeNote {
  title: "Built by a recipe";
  /** The recipe's name and parameters, in the order they were saved. Empty when it has neither. */
  detail: string;
}

/**
 * The recipe an MCP build saved for this object, under `mcpModel.recipes[id]`. Null when this object has none.
 * Read-only: rebuilding from new parameters is a later change.
 */
export function recipeNote(mcpModel: unknown, objectId: string): RecipeNote | null {
  if (!objectId || !mcpModel || typeof mcpModel !== "object" || Array.isArray(mcpModel)) return null;
  const recipes = (mcpModel as { recipes?: unknown }).recipes;
  if (!recipes || typeof recipes !== "object" || Array.isArray(recipes)) return null;
  const saved = (recipes as Record<string, unknown>)[objectId];
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
  // A recipe_run object names its source in `rustRecipes`, kept once per recipe name.
  const rust = (saved as { rust?: unknown }).rust;
  const rustRow = typeof rust === "string" ? ((mcpModel as { rustRecipes?: Record<string, unknown> }).rustRecipes ?? {})[rust] : undefined;
  const recipe = rustRow && typeof rustRow === "object" ? { name: rust, params: (rustRow as { params?: unknown }).params } : (saved as { recipe?: unknown }).recipe;
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return null;
  const rec = recipe as { name?: unknown; params?: unknown };
  const bits: string[] = [];
  if (typeof rec.name === "string" && rec.name.trim()) bits.push(rec.name.trim());
  if (rec.params && typeof rec.params === "object" && !Array.isArray(rec.params)) {
    for (const [key, value] of Object.entries(rec.params)) {
      if (typeof value === "number" && Number.isFinite(value)) bits.push(`${key} = ${value}`);
      else if (typeof value === "string") bits.push(`${key} = ${value}`);
    }
  }
  return { title: "Built by a recipe", detail: bits.join(" · ") };
}

/** --- Plugin steps (D5, D9). What a plugin step's card shows: one value per declared parameter, read-only. */
export interface PluginField {
  name: string;
  label: string;
  kind: PluginParamInfo["kind"];
  value: number | boolean | string;
  unit?: string;
  options?: string[];
  help?: string;
  /** The range a number or count takes, as the header declares it. */
  min?: number;
  max?: number;
  step?: number;
  /** The value is the parameter's default: the run was not given one. */
  isDefault: boolean;
}

export interface PluginStepView {
  title: string;
  /** "plugin v3", or "draft". */
  kind: string;
  author?: string;
  madeBy?: string;
  description?: string;
  fields: PluginField[];
  /** The D9 sentence when the step cannot be rebuilt as it is, else null. */
  note: string | null;
  /** The code, read-only, when the project has it. */
  source: string | null;
  /**
   * --- Milestone 6. Whether the step's values can change here: `yes`; `ask` when the project's copy was edited outside
   * the app (Rebuild asks first, D9); `no` when the code is missing, needs a newer API, or cannot run on this platform.
   */
  rebuild: "yes" | "ask" | "no";
}

/** What the app knows of a step's code: the project's checked copies, the drafts it carries, and where it runs. */
export interface PluginEnv {
  copies: ReadonlyMap<string, CheckedCopy>;
  /** Draft sources by hash, from `mcpModel.rustRecipes`. */
  drafts: ReadonlyMap<string, string>;
  /** The macOS app ships no lust. */
  mac: boolean;
}

/** The project's drafts by hash: each `mcpModel.rustRecipes` entry's source. */
export function draftSources(mcpModel: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const rust = mcpModel && typeof mcpModel === "object" ? (mcpModel as { rustRecipes?: unknown }).rustRecipes : undefined;
  if (!rust || typeof rust !== "object") return out;
  for (const row of Object.values(rust as Record<string, unknown>)) {
    const entry = row as { sha256?: unknown; source?: unknown } | null;
    if (entry && typeof entry.sha256 === "string" && typeof entry.source === "string") out.set(entry.sha256, entry.source);
  }
  return out;
}

function apiNewer(api: string): string | null {
  const m = /^(\d+)\.(\d+)$/.exec(api.trim());
  if (!m) return null;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > RECIPE_API[0] || (major === RECIPE_API[0] && minor > RECIPE_API[1]) ? `${major}.${minor}` : null;
}

/**
 * --- D9. A plugin step as its card shows it: the stamped values over the declared defaults, the code when the project
 * carries it, and the one sentence that says why it cannot be rebuilt, if one does. The app reads only the project's
 * copies here; the library's are the MCP server's to read.
 */
export function pluginStepView(stamp: PluginStamp, env: PluginEnv): PluginStepView {
  const copy = env.copies.get(stamp.sha256);
  const file = copy?.file ?? null;
  const draft = env.drafts.get(stamp.sha256) ?? null;
  const declared = file?.params ?? [];
  const fields: PluginField[] = declared.map((p) => {
    const given = stamp.params[p.name];
    return { name: p.name, label: p.label?.trim() || p.name, kind: p.kind, value: given ?? p.default, ...(p.unit ? { unit: p.unit } : {}), ...(p.options ? { options: p.options } : {}), ...(p.help ? { help: p.help } : {}), ...(typeof p.min === "number" ? { min: p.min } : {}), ...(typeof p.max === "number" ? { max: p.max } : {}), ...(typeof p.step === "number" ? { step: p.step } : {}), isDefault: given === undefined };
  });
  // A value the header does not declare (a draft, or a parameter declared without a builder) still shows.
  for (const [name, value] of Object.entries(stamp.params)) {
    if (declared.some((p) => p.name === name)) continue;
    fields.push({ name, label: name, kind: typeof value === "boolean" ? "toggle" : typeof value === "number" ? "number" : "text", value, isDefault: false });
  }
  const newer = apiNewer(file?.api ?? stamp.api);
  let note: string | null = null;
  if (copy && !copy.intact) note = "This project's copy of the plugin was changed outside the app.";
  else if (newer) note = `This plugin needs recipe API ${newer}, from a newer Lime Slice; this app has ${RECIPE_API[0]}.${RECIPE_API[1]}.`;
  else if (!copy && !draft) note = "The plugin source is not in this project. The part is kept as built; its values cannot change.";
  else if (env.mac) note = "Rebuilding needs lust, which the macOS app does not ship yet.";
  return {
    title: file?.title || stamp.plugin,
    kind: stamp.version > 0 ? `plugin v${stamp.version}` : "draft",
    ...(file?.author && file.author !== "unknown" ? { author: file.author } : {}),
    ...(file?.madeBy ? { madeBy: file.madeBy } : {}),
    ...(file?.description ? { description: file.description } : {}),
    fields,
    note,
    source: file?.text ?? draft,
    rebuild: copy && !copy.intact && file && !newer && !env.mac ? "ask" : note ? "no" : "yes",
  };
}
