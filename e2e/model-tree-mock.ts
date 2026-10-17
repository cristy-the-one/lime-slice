import type { Page, Route } from "@playwright/test";
import { encodeSolid } from "../src/model-reply";
import { fnv1aHex } from "../src/slice-action";

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
  /** What `request.op` builds on `parent`. A join gets its tool's solid at the step it names, when the mock holds it. */
  apply?(request: Body, parent: MockSolid, tool?: MockSolid): Built;
  /** A dry-run of `request.op` on `on`, the solid of the node it names. */
  probe?(request: Body, on: MockSolid): Body | Promise<Body>;
  /** The shape a dry-run that works answers when the request asks for a preview; without it the mock sends none. */
  preview?(request: Body, on: MockSolid, tool?: MockSolid): MockSolid | null;
  /** An answer of its own for a jump, such as a step that no longer rebuilds. Null answers as usual. */
  goto?(request: Body): Body | null;
  /** Why the engine refuses an open's saved solid (`request.seed`), as its `seedRefused`; null takes it. */
  seedRefused?(request: Body): string | null;
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
  /** A step an edit kept without building it: broken, or under a broken one. */
  unbuilt?: true;
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
  /** The solid a join's tool step holds, for the handlers. */
  const toolSolid = (op: unknown) => {
    const tool = toolOf(op);
    return tool ? docs.get(tool.key)?.get(tool.node)?.solid : undefined;
  };
  const build = (request: Body, parent: MockSolid): Built => handlers.apply?.(request, parent, toolSolid(request.op)) ?? { error: "no apply" };
  const toolMissing = (tool: ToolRef, broken?: number) => ({ error: TOOL_MISSING, ...(broken === undefined ? {} : { broken }), missingTool: { key: tool.key, node: tool.node } });
  /** Node `id` of tree `key`, built now if a saved join was waiting for its tool; a reply instead while it still must wait. */
  const materialize = (key: string, doc: Map<number, MockNode>, id: number): Body | null => {
    const pending = waiting.get(key)?.get(id);
    if (!pending || doc.has(id)) return null;
    const parentFirst = materialize(key, doc, pending.parent);
    if (parentFirst) return parentFirst;
    const tool = toolOf(pending.op);
    if (tool && !toolHeld(tool)) return toolMissing(tool, id);
    const built = build({ call: "apply", key, op: pending.op, parent: pending.parent, node: id }, doc.get(pending.parent)!.solid);
    if ("error" in built) return built;
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
   * As the engine's `edit`: for each tool tree in `request.tools`, deepest first, then the tree asked about, the op on
   * `parent` as a new node, then each replayed op on the last that built. The first that does not build is kept, broken,
   * with the rest, and so is a join whose tool step broke; nothing is kept in any tree when an edited op itself does not
   * build. Steps the mock does not build are kept too, unbuilt, as the engine keeps them.
   */
  const edit = (request: Body): Body => {
    type Level = { key: string; parent: number; node: number; op: Body; replay?: { id: number; op: Body }[] };
    const levels: Level[] = [...((request.tools ?? []) as Level[]), { key: String(request.key), parent: Number(request.parent), node: Number(request.node), op: request.op as Body, replay: request.replay as Level["replay"] }];
    const kept: [Map<number, MockNode>, number[]][] = [];
    const undo = (answer: Body) => {
      for (const [doc, ids] of kept) for (const id of ids) doc.delete(id);
      return answer;
    };
    // As the engine checks before it builds: each tree once, and each tool part feeding the join above it.
    if (new Set(levels.map((level) => level.key)).size !== levels.length) return { error: "One edit changes each tree once" };
    const tip = (level: Level) => level.replay?.at(-1)?.id ?? level.node;
    if (levels.some((level, at) => at > 0 && !(toolOf(level.op)?.key === levels[at - 1]!.key && toolOf(level.op)?.node === tip(levels[at - 1]!)))) {
      return { error: "Each tool tree's edit must feed the join above it" };
    }
    const solidOf = (made: Built) => ("error" in made ? made : "kept" in made ? made.kept : made);
    const parts: Body[] = [];
    let below: { tip: number } | { error: string } | null = null;
    for (const [at, level] of levels.entries()) {
      const own = at === levels.length - 1;
      const doc = docs.get(level.key);
      const base = doc?.get(level.parent);
      if (!doc || !base) return undo(own ? { error: "unknown", missing: [doc ? level.parent : 0] } : toolMissing({ key: level.key, node: level.parent }));
      const replay = level.replay ?? [];
      const ids = [level.node, ...replay.map((step) => step.id)];
      if (ids.some((id) => doc.has(id))) return undo({ error: `Node ${ids.find((id) => doc.has(id))} is already in this tree for another step` });
      if (replay.some((step) => step.op.kind === "root")) return undo({ error: "A new solid's primitive can only be built again right under its root" });
      kept.push([doc, ids]);
      const built: Body[] = [];
      let broken: { id: number; error: string } | null = null;
      let last = level.parent;
      let tail = level.parent;
      for (const [index, step] of [{ id: level.node, op: level.op }, ...replay].entries()) {
        let made: MockSolid | { error: string } | null = null;
        if (!broken && index === 0 && below && "error" in below) broken = { id: step.id, error: `The tool object's step could not be rebuilt: ${below.error}` };
        if (!broken) {
          made = solidOf(build({ call: "apply", key: level.key, op: step.op, parent: last, node: step.id }, doc.get(last)!.solid));
          if ("error" in made) {
            if (index === 0) return undo(made);
            broken = { id: step.id, error: made.error };
            made = null;
          }
        }
        if (made && !("error" in made)) {
          doc.set(step.id, { solid: made, parent: last, step: JSON.stringify([step.op, null]), op: step.op });
          built.push({ id: step.id, op: step.op, fingerprint: fingerprint(made) });
          last = step.id;
        } else {
          // Kept unbuilt, as the engine keeps it: in the tree, without a solid the mock could answer.
          doc.set(step.id, { solid: doc.get(tail)!.solid, parent: tail, step: JSON.stringify([step.op, null]), op: step.op, unbuilt: true });
        }
        tail = step.id;
      }
      if (!own) {
        parts.push({ key: level.key, built, ...(broken ? { broken } : {}) });
        below = broken ? { error: broken.error } : { tip: last };
        continue;
      }
      return { ...reply(doc.get(last)!.solid, last), built, ...(broken ? { broken } : {}), ...(parts.length > 0 ? { tools: parts } : {}) };
    }
    return { error: "no levels" };
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
        const built = handlers.apply?.({ ...request, call: "apply", op: saved.op, parent: saved.parent, node: saved.id }, nodes.get(saved.parent)!.solid, toolSolid(saved.op));
        if (built && !("error" in built)) nodes.set(saved.id, { solid: "kept" in built ? built.kept : built, parent: saved.parent, step: JSON.stringify([saved.op, null]), op: saved.op });
      }
      // As the engine: a step seeded from a solid this mock wrote holds that solid, and nothing above it is built for it.
      const seed = request.seed as { node: number; dataB64: string } | undefined;
      const seedSolid = seed ? exported.get(Buffer.from(seed.dataB64, "base64").toString()) : undefined;
      const seedStep = seed ? ((request.nodes ?? []) as { id: number; parent: number; op: Body }[]).find((saved) => saved.id === seed.node) : undefined;
      if (seedSolid && seedStep && !handlers.seedRefused?.(request)) {
        nodes.set(seedStep.id, { solid: seedSolid, parent: seedStep.parent, step: JSON.stringify([seedStep.op, null]), op: seedStep.op });
        later.delete(seedStep.id);
      }
      docs.set(key, nodes);
      waiting.set(key, later);
      const current = Number(request.current ?? 0);
      const wait = materialize(key, nodes, current);
      if (wait) return wait;
      const refused = request.seed ? handlers.seedRefused?.(request) : null;
      return { ...reply(nodes.get(current)!.solid, current), ...(refused ? { seedRefused: refused } : {}) };
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
    if (base.unbuilt && request.call !== "drop") return { error: "This step could not be rebuilt", broken: node };
    switch (request.call) {
      case "goto":
        return handlers.goto?.(request) ?? reply(base.solid, node);
      case "probe": {
        const answer = (await handlers.probe?.(request, base.solid)) ?? { ok: true };
        const shape = answer.ok === true && request.preview ? handlers.preview?.(request, base.solid, toolSolid(request.op)) : null;
        return shape ? { ...answer, preview: reply(shape, node) } : answer;
      }
      case "distance":
        return { id: node, distanceMm: handlers.distanceMm ?? 20 };
      case "drop": {
        const gone = subtree(doc, node);
        for (const id of gone) doc.delete(id);
        return { dropped: [...gone], current: 0 };
      }
      case "export": {
        exports += 1;
        // A `brep` export starts as the engine's binary solid does, so the app takes it as that step exactly.
        const bytes = Buffer.from(request.format === "brep" ? `LIMEBREP 1 mock 0 *\nEDITED-${exports}` : `EDITED-STEP-${exports}`);
        exported.set(bytes.toString(), base.solid);
        // The STEP an older app would have written for the same export opens as the same solid (`olderFile`).
        exported.set(`EDITED-STEP-${exports}`, base.solid);
        if (handlers.exportMs) await new Promise((resolve) => setTimeout(resolve, handlers.exportMs));
        return { bytesBase64: bytes.toString("base64"), byteLength: bytes.length };
      }
      case "apply":
        break;
      case "edit":
        return edit(request);
      default:
        return { error: `unexpected ${String(request.call)}` };
    }
    const id = Number(request.node);
    const known = doc.get(id);
    if (known) {
      if (known.parent !== node || known.step !== stepOf(request)) return { error: `Node ${id} is already in this tree for another step` };
      return reply(known.solid, id);
    }
    const built = build(request, base.solid);
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

/**
 * A saved project as an app before version 3 wrote it: version 2, each solid (`brep`) the STEP the mock would have
 * written in its place, which the mock opens as the same solid.
 */
export function olderFile(saved: Buffer): Buffer {
  const doc = JSON.parse(saved.toString("utf8")) as { version: number; objects?: { brep?: { name: string; bytesBase64: string; byteLength: number; hash: string } }[] };
  doc.version = 2;
  for (const obj of doc.objects ?? []) {
    if (!obj.brep) continue;
    const text = Buffer.from(obj.brep.bytesBase64, "base64").toString();
    const step = Buffer.from(text.replace(/^LIMEBREP 1 mock 0 \*\nEDITED-/, "EDITED-STEP-"));
    obj.brep = { name: obj.brep.name.replace(/\.brep$/, ".step"), bytesBase64: step.toString("base64"), byteLength: step.length, hash: fnv1aHex(step) };
  }
  return Buffer.from(JSON.stringify(doc));
}
