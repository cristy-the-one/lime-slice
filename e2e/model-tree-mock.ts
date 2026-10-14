import type { Page, Route } from "@playwright/test";

/** A solid as the modeler reports it, before the engine stamps the node id on it. */
export interface MockSolid {
  volumeMm3: number;
  positions: number[];
  triangles: number[];
  faces: { id: number; areaMm2: number }[];
  edges: unknown[];
  solid?: boolean;
}

export type Body = Record<string, unknown>;

/** What one Apply builds from its parent: a solid, a split's two pieces, or a refusal. */
export type Built = MockSolid | { kept: MockSolid; other: MockSolid } | { error: string; broken?: number };

export interface TreeMock {
  /** Every request to `/api/model/tree`, in order. */
  calls: Body[];
  of(call: string): Body[];
  /** Requests of that call wait for `release`. */
  hold(call: string): void;
  release(call: string): void;
  /** Drop every tree, as a restarted engine does: the next call on one answers `{error: "unknown"}`. */
  forget(): void;
}

interface Handlers {
  /** The root solid of a file. `request.filename` names it. */
  open(request: Body): MockSolid;
  apply?(request: Body, parent: MockSolid): Built;
  probe?(request: Body): Body | Promise<Body>;
  /** An answer of its own for a jump, such as a step that no longer rebuilds. Null answers as usual. */
  goto?(request: Body): Body | null;
  distanceMm?: number;
}

/**
 * The Model history tree engine, mocked at `/api/model/tree`. It keeps every node's solid by tree
 * and node as the real one does, so a jump answers the solid that node was built with.
 */
export async function mockModelTree(page: Page, handlers: Handlers): Promise<TreeMock> {
  const calls: Body[] = [];
  const docs = new Map<string, Map<number, MockSolid>>();
  const held = new Map<string, (() => void)[]>();
  const holding = new Set<string>();
  let exports = 0;
  const reply = (solid: MockSolid, id: number) => ({
    ...solid,
    id,
    fingerprint: { volumeMm3: solid.volumeMm3, faces: solid.faces.length, edges: solid.edges.length },
  });
  const answer = async (request: Body): Promise<Body> => {
    const key = String(request.key);
    const doc = docs.get(key);
    switch (request.call) {
      case "open": {
        const nodes = new Map([[0, handlers.open(request)]]);
        // Saved nodes come back as the ops that built them.
        for (const saved of (request.nodes ?? []) as { id: number; parent: number; op: Body }[]) {
          const built = handlers.apply?.({ ...request, call: "apply", op: saved.op, parent: saved.parent, node: saved.id }, nodes.get(saved.parent)!);
          if (built && !("error" in built)) nodes.set(saved.id, "kept" in built ? built.kept : built);
        }
        docs.set(key, nodes);
        return reply(nodes.get(Number(request.current ?? 0))!, Number(request.current ?? 0));
      }
      case "close":
        docs.delete(key);
        return { ok: true };
      case "drop":
        doc?.delete(Number(request.node));
        return { dropped: [request.node], current: 0 };
      case "export": {
        exports += 1;
        const bytes = Buffer.from(`EDITED-STEP-${exports}`);
        return { bytesBase64: bytes.toString("base64"), byteLength: bytes.length };
      }
      default:
        break;
    }
    if (!doc) return { error: "unknown", missing: [0] };
    const node = Number(request.call === "apply" ? request.parent : request.node);
    const base = doc.get(node);
    if (!base) return { error: "unknown", missing: [node] };
    if (request.call === "goto") return handlers.goto?.(request) ?? reply(base, node);
    if (request.call === "probe") return (await handlers.probe?.(request)) ?? { ok: true };
    if (request.call === "distance") return { id: node, distanceMm: handlers.distanceMm ?? 20 };
    if (request.call !== "apply") return { error: `unexpected ${String(request.call)}` };
    const id = Number(request.node);
    const known = doc.get(id);
    if (known) return reply(known, id);
    const built = handlers.apply?.(request, base) ?? { error: "no apply" };
    if ("error" in built) return built;
    if ("kept" in built) {
      doc.set(id, built.kept);
      const otherKey = String(request.otherKey);
      docs.set(otherKey, new Map([[0, built.other]]));
      return { ...reply(built.kept, id), op: request.op, other: { ...reply(built.other, 0), key: otherKey } };
    }
    doc.set(id, built);
    return { ...reply(built, id), op: request.op };
  };
  await page.route("**/api/model/tree", async (route: Route) => {
    const request = route.request().postDataJSON() as Body;
    calls.push(request);
    const call = String(request.call);
    if (holding.has(call)) await new Promise<void>((resolve) => held.set(call, [...(held.get(call) ?? []), resolve]));
    await route.fulfill({ json: await answer(request) });
  });
  return {
    calls,
    of: (call) => calls.filter((request) => request.call === call),
    hold: (call) => void holding.add(call),
    release: (call) => {
      holding.delete(call);
      for (const resolve of held.get(call) ?? []) resolve();
      held.delete(call);
    },
    forget: () => docs.clear(),
  };
}
