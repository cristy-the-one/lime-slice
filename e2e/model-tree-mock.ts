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
}

/**
 * The Model history tree engine, mocked at `/api/model/tree`. It keeps every node's solid by tree
 * and node as the real one does, so a jump answers the solid that node was built with, and it
 * refuses what the real one refuses: an existing id for another step, and calls on a tree it forgot.
 */
export async function mockModelTree(page: Page, handlers: Handlers): Promise<TreeMock> {
  const calls: Body[] = [];
  const docs = new Map<string, Map<number, MockNode>>();
  /** Each STEP the mock wrote, and the solid it holds, so opening that STEP again opens that solid. */
  const exported = new Map<string, MockSolid>();
  let exports = 0;
  const reply = (solid: MockSolid, id: number) => ({
    id,
    ...encodeSolid(solid),
    fingerprint: { volumeMm3: solid.volumeMm3, faces: solid.faces.length, edges: solid.edges.length },
  });
  const stepOf = (request: Body) => JSON.stringify([request.op, request.otherKey ?? null]);
  const subtree = (doc: Map<number, MockNode>, id: number) => {
    const gone = new Set([id]);
    for (const [child, node] of [...doc].sort(([a], [b]) => a - b)) if (node.parent !== null && gone.has(node.parent)) gone.add(child);
    return gone;
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
      // Saved nodes come back as the ops that built them.
      for (const saved of (request.nodes ?? []) as { id: number; parent: number; op: Body }[]) {
        const built = handlers.apply?.({ ...request, call: "apply", op: saved.op, parent: saved.parent, node: saved.id }, nodes.get(saved.parent)!.solid);
        if (built && !("error" in built)) nodes.set(saved.id, { solid: "kept" in built ? built.kept : built, parent: saved.parent, step: JSON.stringify([saved.op, null]) });
      }
      docs.set(key, nodes);
      const current = Number(request.current ?? 0);
      return reply(nodes.get(current)!.solid, current);
    }
    if (request.call === "close") {
      docs.delete(key);
      return { ok: true };
    }
    if (!doc) return { error: "unknown", missing: [0] };
    const node = Number(request.call === "apply" ? request.parent : request.node);
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
      doc.set(id, { solid: built.kept, parent: node, step: stepOf(request) });
      // As the engine: the piece goes out only to start its own tree.
      if (!request.otherKey) return { ...reply(built.kept, id), op: request.op };
      const otherKey = String(request.otherKey);
      docs.set(otherKey, new Map([[0, { solid: built.other, parent: null, step: "" }]]));
      return { ...reply(built.kept, id), op: request.op, other: { ...reply(built.other, 0), key: otherKey } };
    }
    doc.set(id, { solid: built, parent: node, step: stepOf(request) });
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
    forget: () => docs.clear(),
  };
}
