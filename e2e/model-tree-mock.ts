import type { Page, Route } from "@playwright/test";
import { encodeSolid } from "../src/model-reply";

/** A solid with plain number arrays. The mock sends it in the engine's binary reply format. */
export interface MockSolid {
  volumeMm3: number;
  positions: number[];
  triangles: number[];
  faces: { id: number; areaMm2: number }[];
  edges: { id: number; lengthMm: number; points: number[] }[];
  solid?: boolean;
}

export type Body = Record<string, unknown>;

/** What one Apply builds from its parent: a solid, a split's two pieces, or a refusal. */
export type Built = MockSolid | { kept: MockSolid; other: MockSolid } | { error: string; broken?: number };

export interface TreeMock {
  /** Every request to `/api/model/tree`, in order. */
  calls: Body[];
  of(call: string): Body[];
  /** Drop every tree, as a restarted engine does: the next call on one answers `{error: "unknown"}`. */
  forget(): void;
}

interface Handlers {
  /** The root solid of a file (`request.filename` names it) or of a primitive (`request.primitive`), or why there is none. */
  open(request: Body): MockSolid | { error: string };
  apply?(request: Body, parent: MockSolid): Built;
  probe?(request: Body): Body | Promise<Body>;
  /** An answer of its own for a jump, such as a step that no longer rebuilds. Null answers as usual. */
  goto?(request: Body): Body | null;
  distanceMm?: number;
  /** How long an export takes, so a test can act while one is still on its way. */
  exportMs?: number;
}

interface MockNode {
  solid: MockSolid;
  parent: number | null;
  /** The op and the split piece's key, as one string, so a repeated Apply can be told from another. */
  step: string;
  op?: Body;
}

/** A join's tool, as the op names it. */
type ToolRef = { key: string; node: number };

const TOOL_MISSING = "The tool object's history is not open in the modeler";

/**
 * The Model history tree engine, mocked at `/api/model/tree`. It keeps every node's solid by tree
 * and node as the real one does, so a jump answers the solid that node was built with, and it
 * refuses what the real one refuses: an existing id for another step, and calls on a tree it forgot.
 */
export async function mockModelTree(page: Page, handlers: Handlers): Promise<TreeMock> {
  const calls: Body[] = [];
  const docs = new Map<string, Map<number, MockNode>>();
  /** Saved joins an `open` could not build yet, their tool's tree not open: built once it is, as the engine does. */
  const waiting = new Map<string, Map<number, { parent: number; op: Body }>>();
  const toolOf = (op: unknown): ToolRef | null => {
    const body = op as { kind?: unknown; tool?: ToolRef } | undefined;
    return body?.kind === "join" && body.tool ? body.tool : null;
  };
  const toolHeld = (tool: ToolRef) => docs.get(tool.key)?.has(tool.node) ?? false;
  const toolMissing = (tool: ToolRef, broken?: number) => ({ error: TOOL_MISSING, ...(broken === undefined ? {} : { broken }), missingTool: { key: tool.key, node: tool.node } });
  /** Node `id` of tree `key`, built now if a saved join was waiting for its tool; a reply instead while it still must wait. */
  const materialize = (key: string, doc: Map<number, MockNode>, id: number): Body | null => {
    const pending = waiting.get(key)?.get(id);
    if (!pending || doc.has(id)) return null;
    const parentFirst = materialize(key, doc, pending.parent);
    if (parentFirst) return parentFirst;
    const tool = toolOf(pending.op);
    if (tool && !toolHeld(tool)) return toolMissing(tool, id);
    const built = handlers.apply?.({ call: "apply", key, op: pending.op, parent: pending.parent, node: id }, doc.get(pending.parent)!.solid);
    if (!built || "error" in built) return built ?? { error: "no apply" };
    doc.set(id, { solid: "kept" in built ? built.kept : built, parent: pending.parent, step: JSON.stringify([pending.op, null]), op: pending.op });
    waiting.get(key)!.delete(id);
    return null;
  };
  /** Each STEP the mock wrote, and the solid it holds, so opening that STEP again opens that solid. */
  const exported = new Map<string, MockSolid>();
  let exports = 0;
  const fingerprint = (solid: MockSolid) => ({ volumeMm3: solid.volumeMm3, faces: solid.faces.length, edges: solid.edges.length });
  const reply = (solid: MockSolid, id: number) => ({ id, ...encodeSolid(solid), fingerprint: fingerprint(solid) });
  const stepOf = (request: Body) => JSON.stringify([request.op, request.otherKey ?? null]);
  const subtree = (doc: Map<number, MockNode>, id: number) => {
    const gone = new Set([id]);
    for (const [child, node] of [...doc].sort(([a], [b]) => a - b)) if (node.parent !== null && gone.has(node.parent)) gone.add(child);
    return gone;
  };
  /**
   * As the engine's `edit`: the op on `parent` as a new node, then each replayed op on the last that built. The first that
   * does not build is kept, broken, with the rest; nothing is kept when the edited op itself does not build.
   */
  const edit = (key: string, doc: Map<number, MockNode>, parent: number, from: MockSolid, request: Body): Body => {
    const replay = (request.replay ?? []) as { id: number; op: Body }[];
    const ids = [Number(request.node), ...replay.map((step) => step.id)];
    if (ids.some((id) => doc.has(id))) return { error: `Node ${ids.find((id) => doc.has(id))} is already in this tree for another step` };
    const build = (op: Body, under: number, id: number, solid: MockSolid) => {
      const built = handlers.apply?.({ call: "apply", key, op, parent: under, node: id }, solid) ?? { error: "no apply" };
      return "error" in built ? built : "kept" in built ? built.kept : built;
    };
    const first = build(request.op as Body, parent, ids[0]!, from);
    if ("error" in first) return first;
    doc.set(ids[0]!, { solid: first, parent, step: JSON.stringify([request.op, null]), op: request.op as Body });
    const built = [{ id: ids[0], op: request.op, fingerprint: fingerprint(first) }];
    let last = ids[0]!;
    let broken: { id: number; error: string } | null = null;
    for (const step of replay) {
      if (broken) continue;
      const made = build(step.op, last, step.id, doc.get(last)!.solid);
      if ("error" in made) {
        broken = { id: step.id, error: made.error };
        continue;
      }
      doc.set(step.id, { solid: made, parent: last, step: JSON.stringify([step.op, null]), op: step.op });
      built.push({ id: step.id, op: step.op, fingerprint: fingerprint(made) });
      last = step.id;
    }
    return { ...reply(doc.get(last)!.solid, last), built, ...(broken ? { broken } : {}) };
  };
  const answer = async (request: Body): Promise<Body> => {
    const key = String(request.key);
    const doc = docs.get(key);
    if (request.call === "open") {
      const data = typeof request.dataB64 === "string" ? Buffer.from(request.dataB64, "base64").toString() : "";
      // The handler hears every open, and a STEP this mock wrote opens as the solid it was written from.
      const read = handlers.open(request);
      if ("error" in read) return read;
      const nodes = new Map<number, MockNode>([[0, { solid: exported.get(data) ?? read, parent: null, step: "" }]]);
      const later = new Map<number, { parent: number; op: Body }>();
      // Saved nodes come back as the ops that built them; a join whose tool's tree is not open waits for it.
      for (const saved of (request.nodes ?? []) as { id: number; parent: number; op: Body }[]) {
        const tool = toolOf(saved.op);
        if (later.has(saved.parent) || (tool && !toolHeld(tool))) {
          later.set(saved.id, { parent: saved.parent, op: saved.op });
          continue;
        }
        const built = handlers.apply?.({ ...request, call: "apply", op: saved.op, parent: saved.parent, node: saved.id }, nodes.get(saved.parent)!.solid);
        if (built && !("error" in built)) nodes.set(saved.id, { solid: "kept" in built ? built.kept : built, parent: saved.parent, step: JSON.stringify([saved.op, null]), op: saved.op });
      }
      docs.set(key, nodes);
      waiting.set(key, later);
      const current = Number(request.current ?? 0);
      const wait = materialize(key, nodes, current);
      if (wait) return wait;
      return reply(nodes.get(current)!.solid, current);
    }
    if (request.call === "close") {
      const used = [...docs].some(([other, nodes]) => other !== key && [...nodes.values()].some((node) => toolOf(node.op)?.key === key));
      if (used) return { error: "A step of another part's history uses this part as its tool, so it stays open" };
      docs.delete(key);
      waiting.delete(key);
      return { ok: true };
    }
    if (!doc) return { error: "unknown", missing: [0] };
    const node = Number(request.call === "apply" || request.call === "edit" ? request.parent : request.node);
    const wait = materialize(key, doc, node);
    if (wait) return wait;
    const asked = toolOf(request.op);
    if (asked && (request.call === "apply" || request.call === "probe") && !toolHeld(asked)) return toolMissing(asked);
    const base = doc.get(node);
    if (!base) return { error: "unknown", missing: [node] };
    switch (request.call) {
      case "goto":
        return handlers.goto?.(request) ?? reply(base.solid, node);
      case "probe":
        return (await handlers.probe?.(request)) ?? { ok: true };
      case "distance":
        return { id: node, distanceMm: handlers.distanceMm ?? 20 };
      case "drop": {
        const gone = subtree(doc, node);
        for (const id of gone) doc.delete(id);
        return { dropped: [...gone], current: 0 };
      }
      case "export": {
        exports += 1;
        const bytes = Buffer.from(`EDITED-STEP-${exports}`);
        exported.set(bytes.toString(), base.solid);
        if (handlers.exportMs) await new Promise((resolve) => setTimeout(resolve, handlers.exportMs));
        return { bytesBase64: bytes.toString("base64"), byteLength: bytes.length };
      }
      case "apply":
        break;
      case "edit":
        return edit(key, doc, node, base.solid, request);
      default:
        return { error: `unexpected ${String(request.call)}` };
    }
    const id = Number(request.node);
    const known = doc.get(id);
    if (known) {
      if (known.parent !== node || known.step !== stepOf(request)) return { error: `Node ${id} is already in this tree for another step` };
      return reply(known.solid, id);
    }
    const built = handlers.apply?.(request, base.solid) ?? { error: "no apply" };
    if ("error" in built) return built;
    if ("kept" in built) {
      doc.set(id, { solid: built.kept, parent: node, step: stepOf(request), op: request.op as Body });
      // As the engine: the piece goes out only to start its own tree.
      if (!request.otherKey) return { ...reply(built.kept, id), op: request.op };
      const otherKey = String(request.otherKey);
      docs.set(otherKey, new Map([[0, { solid: built.other, parent: null, step: "" }]]));
      return { ...reply(built.kept, id), op: request.op, other: { ...reply(built.other, 0), key: otherKey } };
    }
    doc.set(id, { solid: built, parent: node, step: stepOf(request), op: request.op as Body });
    return { ...reply(built, id), op: request.op };
  };
  await page.route("**/api/model/tree", async (route: Route) => {
    const request = route.request().postDataJSON() as Body;
    calls.push(request);
    await route.fulfill({ json: await answer(request) });
  });
  return {
    calls,
    of: (call) => calls.filter((request) => request.call === call),
    forget: () => {
      docs.clear();
      waiting.clear();
    },
  };
}
