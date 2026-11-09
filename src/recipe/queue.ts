/**
 * --- docs/plan-native-recipes.md 7.1. Queued booleans in a recipe run, shared by the MCP session and the app's runner.
 *
 * A recipe line whose `apply` reply the recipe does not read (`./unread-applies.ts`) is answered `{ok, queued}` at
 * once when its op is a plain fuse or cut whose tool builds alone and whose box meets the part: anything else is built
 * there and then, after what is queued, so its refusal comes back at its own line. `s.apply_later` always queues.
 *
 * The queue of a part is built before any other call that names the part (a read, a probe, a place, an apply that does
 * not queue), at `s.flush`, a checkpoint, `done`, 200 ops, and near the run's time limit. The ops are grouped in the
 * order sent: an op joins the earliest group of its kind whose tools' boxes it misses, when it also misses every tool
 * of the groups after it (disjoint tools commute); otherwise it starts a group. Each group is one combined boolean, and
 * the ops are stored as the recipe sent them, one History step each (`QueuePort.build`).
 *
 * A group refused, or a tool it left out, cannot be told to a recipe that already moved past that line: the run is
 * taken back and run again with silent queuing off (`replay`), which is exact because a run is deterministic. An
 * explicit queue's refusals come back from `s.flush` instead, each built one by one to say which.
 */
import { hasAnchor, type Box } from "../modeling/anchors.ts";
import { primitiveBox } from "../model-feasibility.ts";
import type { PrimitiveSpec } from "../model-primitive.ts";
import type { ModelOp } from "../model-tree.ts";
import { lostVolume, touchingEdges, touchingReason } from "../modeling/step-guard.ts";
import type { RecipeCallSite, RecipeReply } from "./host.ts";

export type QueueKind = "fuse" | "cut";

/** The most ops one part holds before they are built. */
export const QUEUE_MAX = 200;
/** Two boxes this far apart (mm) share nothing a boolean could join. */
const APART_MM = 1e-4;
/** The part of the run's time limit after which nothing more is queued silently. */
const LATE = 0.8;

/** A queued op's tool: its kind, its box, and whether it is a plain boolean that merges faces after it (`merge`). */
export interface QueueTool {
  kind: QueueKind;
  box: Box;
  merge?: boolean;
}

/** One queued op: the call that sent it, its tool's kind and box (null: built on its own, in its place). */
export interface QueuedOp {
  site: RecipeCallSite;
  /** The call's arguments without `queue`, as the op is applied. */
  args: Record<string, unknown>;
  op: Record<string, unknown>;
  tool: QueueTool | null;
  explicit: boolean;
  /** Its place among the part's `apply_later` ops since the recipe's last `flush` of it. */
  index: number;
}

/** What a host does for the queue. */
export interface QueuePort {
  /** A plain fuse or cut's tool kind and box, or null when the op is not one, or its tool does not build alone. */
  tool(object: string, op: Record<string, unknown>): Promise<QueueTool | null>;
  /** The part's box as it stands, in the frame `tool` answers in. */
  partBox(object: string): Box | null;
  /**
   * Builds `ops` (the queue, in the order sent) on the part as the combined `groups` (indexes into `ops`), each one
   * boolean, and stores each op as its own step in that order. On a refusal nothing changes, and `index` is the op the
   * engine named, when it named one.
   */
  build(object: string, ops: QueuedOp[], groups: number[][]): Promise<{ ok: true } | { ok: false; reason: string; index?: number }>;
  /** One op on its own, as the recipe's call would have been answered. */
  applyOne(site: RecipeCallSite): Promise<RecipeReply>;
}

/** The op kinds a queue builds as tools of one boolean. */
const TOOL_KINDS = new Set(["boolean", "extrude", "revolve", "loft"]);
/** Fields that read the part's faces or edges as it stands: such an op is built in its place, never queued. */
const READS_PART = new Set(["face", "faceIndex", "faces", "upTo", "onFace", "nearPoint", "edges", "fromNode", "select", "anchor"]);

/** Whether a typed op could be a queued tool: a boolean, extrude, revolve or loft that names no face, edge or anchor. */
export function queueableOp(raw: Record<string, unknown>): boolean {
  if (!TOOL_KINDS.has(String(raw.kind)) || hasAnchor(raw)) return false;
  const reads = (value: unknown, depth: number): boolean => {
    if (depth > 8 || !value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((v) => reads(v, depth + 1));
    return Object.entries(value).some(([key, v]) => READS_PART.has(key) || reads(v, depth + 1));
  };
  return !reads(raw, 0);
}

/** A solid as the guards read it. */
interface Guarded {
  volumeMm3: number;
  positions: ArrayLike<number>;
}

/**
 * The step guards (`src/modeling/step-guard.ts`) of queued ops built together, from the solid before them and after:
 * a fuse that lost volume, cuts that removed more than their boxes hold, and a box primitive that leaves pieces meeting
 * only along an edge. Null when none fires; a sentence otherwise, and the queue gives up on building them together.
 */
export function queuedGuard(ops: readonly ModelOp[], before: Guarded | null, after: Guarded | null): string | null {
  if (!before || !after) return null;
  const kinds = ops.map((op) => (op as { op?: string }).op);
  if (kinds.includes("fuse")) {
    const lost = lostVolume({ kind: "boolean", op: "fuse" }, before.volumeMm3, after.volumeMm3, null);
    if (lost) return lost;
  }
  const boxes = ops.map((op) => (op.kind === "boolean" ? primitiveBox(op as unknown as PrimitiveSpec) : null));
  if (ops.every((_, i) => kinds[i] === "cut" && boxes[i])) {
    const most = boxes.reduce((sum, box) => sum + [0, 1, 2].reduce((acc, i) => acc * Math.max(0, Number(box!.max[i]) - Number(box!.min[i])), 1), 0);
    const slack = Math.max(before.volumeMm3 * 1e-4, 0.01);
    if (before.volumeMm3 - after.volumeMm3 > most * 1.02 + slack) return "The queued cuts removed more than their tools hold.";
  }
  for (const box of boxes) {
    if (!box) continue;
    const was = touchingEdges(before.positions, box);
    const now = touchingEdges(after.positions, box);
    if (now.count > was.count) return touchingReason(now.at);
  }
  return null;
}

export function boxesApart(a: Box, b: Box): boolean {
  return [0, 1, 2].some((i) => a.max[i]! < b.min[i]! - APART_MM || b.max[i]! < a.min[i]! - APART_MM);
}

function boxesMeet(a: Box, b: Box): boolean {
  return [0, 1, 2].every((i) => a.max[i]! >= b.min[i]! - APART_MM && b.max[i]! >= a.min[i]! - APART_MM);
}

/**
 * The groups for a run of plain ops, as indexes in the order sent: each op joins the earliest group of its kind it can
 * reach going back past groups whose every tool its box misses, and whose own tools it misses too; else a new group.
 */
export function planGroups(tools: QueueTool[]): number[][] {
  const groups: { kind: QueueKind; merge: boolean; members: number[] }[] = [];
  tools.forEach((tool, index) => {
    const merge = tool.merge === true;
    let target = -1;
    for (let g = groups.length - 1; g >= 0; g -= 1) {
      const group = groups[g]!;
      if (!group.members.every((m) => boxesApart(tools[m]!.box, tool.box))) break;
      // A plain boolean merges the faces left on one surface after it, so it groups only with plain booleans, whose
      // group merges once at its end.
      if (group.kind === tool.kind && group.merge === merge) target = g;
    }
    if (target >= 0) groups[target]!.members.push(index);
    else groups.push({ kind: tool.kind, merge, members: [index] });
  });
  return groups.map((group) => group.members);
}

/** What the run's queue did, for the reply's hints. */
export interface QueueReport {
  /** Ops built through the queue, and the booleans they took. */
  queued: number;
  booleans: number;
  /** A call that built a part's queue while silent ops were in it: its line and tool, how often, and how many ops. */
  flushedBy: Map<string, { line: number; tool: string; times: number; ops: number }>;
  /** A line whose apply reply the recipe reads, so its applies were built one by one: how many. */
  readLines: Map<number, number>;
}

/**
 * What a run's reply says of its queue: how many applies were built through it in how many booleans, and up to three
 * hints from its own numbers (a read that kept building the queue, a line whose reply is read in a loop). `at` maps a
 * built line to the recipe's own.
 */
export function queueSummary(report: QueueReport, at: (line: number) => number = (line) => line): { queued?: { applies: number; booleans: number }; queueHints?: string[] } {
  const hints: string[] = [];
  for (const row of [...report.flushedBy.values()].filter((r) => r.times >= 2).sort((a, b) => b.times - a.times).slice(0, 2)) {
    hints.push(`${row.tool} at line ${at(row.line)} built the queue ${row.times} times (${row.ops} applies); read before the loop of applies so they build together.`);
  }
  for (const [line, count] of [...report.readLines].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]).slice(0, 3 - hints.length)) {
    hints.push(`line ${at(line)} reads its apply's reply, so its ${count} applies were built one by one; drop the read, or use s.apply_later, to build them together.`);
  }
  return {
    ...(report.queued > 0 ? { queued: { applies: report.queued, booleans: report.booleans } } : {}),
    ...(hints.length ? { queueHints: hints.slice(0, 3) } : {}),
  };
}

export class RecipeQueue {
  /** Silent queuing: off for a replay, after `s.queue(false)`, or when the host has no marks. */
  silent: boolean;
  /** Set when a late refusal of a silent op means the run must be built again one by one. */
  replay: { line: number; reason: string } | null = null;
  readonly report: QueueReport = { queued: 0, booleans: 0, flushedBy: new Map(), readLines: new Map() };
  private readonly queues = new Map<string, QueuedOp[]>();
  /** Explicit ops' refusals not yet given to the recipe by its `flush`, by part. */
  private readonly pending = new Map<string, { index: number; reason: string; line: number }[]>();
  private readonly counts = new Map<string, number>();
  private readonly started = Date.now();

  private readonly port: QueuePort;
  /** The built text's lines whose apply reply the recipe does not read. */
  private readonly unread: ReadonlySet<number>;
  /** Whether `s.queue(true)` may turn silent queuing back on: not in a replay. */
  private readonly allowed: boolean;

  constructor(port: QueuePort, unread: ReadonlySet<number>, opts: { silent: boolean; timeLimitS: number; selected?: () => string | null }) {
    this.port = port;
    this.unread = unread;
    this.silent = opts.silent;
    this.allowed = opts.silent;
    this.timeLimitMs = opts.timeLimitS * 1000;
    this.selected = opts.selected ?? (() => null);
  }

  private readonly timeLimitMs: number;
  private readonly selected: () => string | null;

  /** True while a part holds queued ops. */
  get holding(): boolean {
    return [...this.queues.values()].some((q) => q.length > 0);
  }

  /** Answers one call, queuing or building first as it needs. `inner` answers a call as the host always has. */
  async call(site: RecipeCallSite, inner: (site: RecipeCallSite) => Promise<RecipeReply>): Promise<RecipeReply> {
    if (site.tool === "queue") {
      this.silent = site.args.silent !== false && this.allowed;
      return { ok: true, result: { ok: true } };
    }
    if (site.tool === "flush") {
      const object = typeof site.args.object === "string" ? site.args.object : this.selected() ?? "";
      const built = await this.flush(object, site);
      if (built) return built;
      const failures = this.pending.get(object) ?? [];
      this.pending.delete(object);
      const applied = this.counts.get(object) ?? 0;
      this.counts.delete(object);
      return { ok: true, result: { ok: true, applied: applied - failures.length, failures } };
    }
    if (site.tool === "model_apply") return this.apply(site, inner);
    if (site.tool === "checkpoint") {
      const built = await this.flushAll(site);
      return built ?? inner(site);
    }
    // Every queued part the call names; a call that names no part reads the selected one, or, when the host cannot say
    // which that is, any of them.
    const own = ["solid_new", "log", "data", "native_geometry", "text_outline", "mesh_at_end"].includes(site.tool);
    const named = this.named(site.args, !own);
    const addressed = typeof site.args.object === "string" || Array.isArray(site.args.objects) || this.selected() !== null;
    const parts = named.length > 0 || addressed ? named : own ? [] : [...this.queues.keys()];
    for (const object of parts) {
      const built = await this.flush(object, site);
      if (built) return built;
    }
    return inner(site);
  }

  /** Builds every part's queue: `done`, a checkpoint. A late refusal sets `replay` and answers it. */
  async flushAll(site?: RecipeCallSite): Promise<RecipeReply | null> {
    for (const object of [...this.queues.keys()]) {
      const built = await this.flush(object, site);
      if (built) return built;
    }
    return null;
  }

  /** The explicit queue's refusals the recipe never asked `flush` for, for the run's notes. */
  unreported(): { index: number; reason: string; line: number }[] {
    return [...this.pending.values()].flat();
  }

  private named(args: Record<string, unknown>, selectedToo: boolean): string[] {
    const found = new Set<string>();
    const walk = (value: unknown, depth: number) => {
      if (depth > 6) return;
      if (typeof value === "string") {
        if (this.queues.get(value)?.length) found.add(value);
      } else if (Array.isArray(value)) value.forEach((v) => walk(v, depth + 1));
      else if (value && typeof value === "object") for (const v of Object.values(value)) walk(v, depth + 1);
    };
    walk(args, 0);
    if (args.object === undefined && selectedToo) {
      const selected = this.selected();
      if (selected && this.queues.get(selected)?.length) found.add(selected);
    }
    return [...found];
  }

  private async apply(site: RecipeCallSite, inner: (site: RecipeCallSite) => Promise<RecipeReply>): Promise<RecipeReply> {
    const { queue: mode, ...args } = site.args;
    const plain: RecipeCallSite = { ...site, args };
    const object = typeof args.object === "string" ? args.object : this.selected() ?? "";
    const explicit = mode === "later";
    const late = Date.now() - this.started > this.timeLimitMs * LATE;
    const silent = this.silent && mode === undefined && args.probe === true && this.unread.has(site.line) && !late;
    if (!explicit && !silent) {
      if (mode === undefined && !this.unread.has(site.line)) this.report.readLines.set(site.line, (this.report.readLines.get(site.line) ?? 0) + 1);
      const built = await this.flush(object, site);
      return built ?? inner(plain);
    }
    const op = args.op && typeof args.op === "object" ? (args.op as Record<string, unknown>) : null;
    let tool = op && object ? await this.port.tool(object, op) : null;
    if (tool) {
      // The box must meet the part as it will stand: its box and every fuse queued before.
      const queue = this.queues.get(object) ?? [];
      const part = this.port.partBox(object);
      const grown = queue.filter((q) => q.tool?.kind === "fuse").map((q) => q.tool!.box);
      if (!part || ![part, ...grown].some((b) => boxesMeet(b, tool!.box))) tool = null;
    }
    if (!tool && !explicit) {
      // Not a plain fuse or cut on this part: built now, so its answer, or its refusal, is the recipe's own.
      const built = await this.flush(object, site);
      return built ?? inner(plain);
    }
    const queue = this.queues.get(object) ?? [];
    if (queue.length >= QUEUE_MAX) {
      const built = await this.flush(object, site);
      if (built) return built;
    }
    const index = explicit ? (this.counts.get(object) ?? 0) : -1;
    if (explicit) this.counts.set(object, index + 1);
    const list = this.queues.get(object) ?? [];
    list.push({ site: plain, args, op: op ?? {}, tool, explicit, index });
    this.queues.set(object, list);
    return { ok: true, result: { ok: true, queued: true } };
  }

  /**
   * Builds the part's queue. Null when it built (or was empty); a fatal reply when a silent op was refused, which
   * ends the run for its replay. `by` is the call that asked, for the hints.
   */
  private async flush(object: string, by?: RecipeCallSite): Promise<RecipeReply | null> {
    const queue = this.queues.get(object);
    if (!queue || queue.length === 0) return null;
    this.queues.set(object, []);
    if (by && by.tool !== "flush" && by.tool !== "model_apply" && queue.some((q) => !q.explicit)) {
      const key = `${by.line}:${by.tool}`;
      const row = this.report.flushedBy.get(key) ?? { line: by.line, tool: by.tool, times: 0, ops: 0 };
      row.times += 1;
      row.ops += queue.length;
      this.report.flushedBy.set(key, row);
    }
    // Runs of plain ops between ops built on their own, in order.
    let run: QueuedOp[] = [];
    const segments: (QueuedOp[] | QueuedOp)[] = [];
    for (const q of queue) {
      if (q.tool) run.push(q);
      else {
        if (run.length) segments.push(run);
        run = [];
        segments.push(q);
      }
    }
    if (run.length) segments.push(run);
    for (const segment of segments) {
      const failed = Array.isArray(segment) ? await this.buildRun(object, segment) : await this.buildOne(object, segment);
      if (failed) return failed;
    }
    return null;
  }

  /** A queued op built on its own: an explicit op's refusal waits for `flush`; a silent one's means a replay. */
  private async buildOne(object: string, q: QueuedOp): Promise<RecipeReply | null> {
    const reply = await this.port.applyOne(q.site);
    if (reply.ok) return null;
    if (q.explicit) {
      this.refused(object, q, reply.error);
      return null;
    }
    return this.late(q.site.line, reply.error);
  }

  private async buildRun(object: string, run: QueuedOp[]): Promise<RecipeReply | null> {
    if (run.length === 1) {
      const one = await this.buildOne(object, run[0]!);
      if (!one) {
        this.report.queued += 1;
        this.report.booleans += 1;
      }
      return one;
    }
    const groups = planGroups(run.map((q) => q.tool!));
    const built = await this.port.build(object, run, groups);
    if (built.ok) {
      this.report.queued += run.length;
      this.report.booleans += groups.length;
      return null;
    }
    // Refused together. With a silent op in it, the recipe already moved on: build the run again one by one.
    const silentOne = run.find((q) => !q.explicit);
    if (silentOne) {
      const named = built.index !== undefined ? run[built.index] : undefined;
      return this.late((named ?? silentOne).site.line, built.reason);
    }
    for (const q of run) {
      const failed = await this.buildOne(object, q);
      if (failed) return failed;
    }
    return null;
  }

  private refused(object: string, q: QueuedOp, reason: string) {
    const list = this.pending.get(object) ?? [];
    list.push({ index: q.index, reason, line: q.site.line });
    this.pending.set(object, list);
  }

  private late(line: number, reason: string): RecipeReply {
    this.replay = { line, reason };
    return { ok: false, error: `The tool at line ${line} was refused inside a queued boolean (${reason}); the run is built again one by one.`, fatal: true };
  }
}
