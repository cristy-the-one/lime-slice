/**
 * The Model sections of a `.lime` file, decoded: each plate object's history (`modelTree`), the kept tools' trees
 * (`modelTools`), and the held pieces of a split to print (`heldPieces`). `src/project-envelope.ts` reads the rest of
 * the file and hands these over as they were (`ModelSections`), so the app's first chunk never loads the tree readers;
 * the app loads this module when a file has such a section, and the MCP server and the tests read through
 * `src/project.ts`, which joins the two.
 */
import { readSavedTree, savedToolObjects, treeBody } from "./model-tree-file.ts";
import type { NodeId } from "./model-tree.ts";
import { exportsPieces } from "./split-pieces.ts";
import type { PlateFileObject } from "./plate.ts";
import {
  assemblePlate,
  bytesPool,
  finite,
  readMesh,
  readRootStep,
  recordId,
  type HeldPiece,
  type LimeProject,
  type ModelSectionReader,
  type ToolTree,
} from "./project-envelope.ts";

/** The plate's trees: each object's tree set on it (`objects` changes), the kept tools' trees, and the names of damaged ones. */
function readTrees(objects: PlateFileObject[], fileTrees: readonly unknown[], tools: unknown): { modelTools: ToolTree[]; unreadHistory: string[] } {
  const out = objects;
  const seen = new Set(objects.map((obj) => obj.id));
  // A kept tool is a plate object no more: its id and name, and its tree. One that is not even that is left out, named if it can be.
  const keptRows = Array.isArray(tools) ? tools : [];
  const unreadHistory: string[] = [];
  const kept: { id: string; name: string; raw: unknown }[] = [];
  for (const row of keptRows) {
    const item = row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
    const name = typeof item.name === "string" && item.name.trim() ? item.name : "";
    if (typeof item.id === "string" && item.id && name && !seen.has(item.id)) {
      seen.add(item.id);
      kept.push({ id: item.id, name, raw: item.modelTree });
    } else {
      unreadHistory.push(name || "a removed tool");
    }
  }
  const holders = [...out.map((obj, i) => ({ id: obj.id, name: obj.name, raw: fileTrees[i] })), ...kept];
  const pool = bytesPool(out);
  const trees = holders.map(({ raw }) => {
    // Every whole root STEP joins the bytes, as the writer counted it, even in a tree too damaged to read.
    const root = raw && typeof raw === "object" ? readRootStep((raw as Record<string, unknown>).rootStep) : null;
    if (root?.bytesBase64 !== undefined && !pool.has(recordId(root))) pool.set(recordId(root), root.bytesBase64);
    const tree = raw == null ? null : readSavedTree(raw);
    return tree && (root || tree.rootPrimitive || tree.rootFeature) ? { tree, root } : null;
  });
  const read = holders.map(({ raw }, i): PlateFileObject["modelTree"] | null => {
    const saved = trees[i];
    // A sketch-started solid's root is its feature: there are no bytes to find.
    if (saved?.tree.rootFeature) return { ...treeBody(saved.tree), rootFeature: saved.tree.rootFeature };
    // A new solid's root is its primitive: there are no bytes to find.
    if (saved?.tree.rootPrimitive) return { ...treeBody(saved.tree), rootPrimitive: saved.tree.rootPrimitive };
    const bytesBase64 = saved?.root ? saved.root.bytesBase64 ?? pool.get(recordId(saved.root)) : undefined;
    if (saved?.root && bytesBase64 !== undefined) return { ...treeBody(saved.tree), rootStep: { ...saved.root, bytesBase64 } };
    return raw != null ? null : undefined;
  });
  // A join whose tool's tree is not in the file cannot rebuild: its tree is left out as a damaged one is, and then any
  // tree that took a tool from that one, and so on. A kept tool no tree names any more goes quietly.
  for (let changed = true; changed; ) {
    changed = false;
    const readable = new Set(holders.filter((_, i) => read[i]).map(({ id }) => id));
    read.forEach((tree, i) => {
      if (tree && [...savedToolObjects(tree)].some((id) => !readable.has(id))) {
        read[i] = null;
        changed = true;
      }
    });
  }
  const named = new Set(read.flatMap((tree) => (tree ? [...savedToolObjects(tree)] : [])));
  const modelTools: ToolTree[] = [];
  holders.forEach(({ id, name }, i) => {
    const tree = read[i];
    if (i >= out.length) {
      if (tree && named.has(id)) modelTools.push({ id, name, modelTree: tree });
      return;
    }
    if (tree) out[i]!.modelTree = tree;
    else if (tree === null) unreadHistory.push(name);
  });
  return { modelTools, unreadHistory };
}

/**
 * The held pieces of a file, each for a cut for an export target in its object's tree that names no piece there. A row
 * that is damaged, or names no such cut, is left out: the piece is cut again (`piecesToCut`).
 */
function readHeldPieces(value: unknown, objects: readonly PlateFileObject[]): HeldPiece[] {
  if (!Array.isArray(value)) return [];
  const out: HeldPiece[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const pins = row.pins === true;
    if (typeof row.object !== "string" || !Number.isInteger(row.node) || pins === Number.isInteger(row.index)) continue;
    const node = row.node as number;
    const index = pins ? undefined : (row.index as number);
    const cut = objects.find((obj) => obj.id === row.object)?.modelTree?.nodes.find((step) => step.id === node);
    if (!cut || !exportsPieces(cut.op?.kind === "partition" ? cut.op : null)) continue;
    if (index === undefined ? cut.pins !== null : index < 2 || cut.pieces?.[index - 2] !== null) continue;
    const mesh = readMesh(row.mesh);
    const brep = row.brep === undefined ? undefined : readMesh(row.brep);
    const id = `${row.object}#${node}#${index ?? "pins"}`;
    if (typeof mesh === "string" || typeof brep === "string" || seen.has(id)) continue;
    seen.add(id);
    out.push({ object: row.object, node, ...(index === undefined ? { pins: true as const } : { index }), mesh, ...(brep ? { brep } : {}), ...(finite(row.meshSeatMm) ? { meshSeatMm: row.meshSeatMm as number } : {}) });
  }
  return out;
}

/**
 * The pieces of each cut for an export target that a project holds no saved piece for, as a file 3.8.0 wrote: each
 * plate object's cut, its step, the part numbers to cut again, and `pins` when its pins are to be made again too.
 */
export function piecesToCut(project: LimeProject): { object: string; node: NodeId; indexes: number[]; pins?: true }[] {
  const out: { object: string; node: NodeId; indexes: number[]; pins?: true }[] = [];
  for (const obj of project.objects ?? []) {
    for (const step of obj.modelTree?.nodes ?? []) {
      if (!exportsPieces(step.op?.kind === "partition" ? step.op : null) || !step.pieces) continue;
      const kept = (index?: number) => !!project.heldPieces?.some((held) => held.object === obj.id && held.node === step.id && (index === undefined ? held.pins === true : held.index === index));
      const indexes = step.pieces.flatMap((piece, at) => (piece === null && !kept(at + 2) ? [at + 2] : []));
      const pins = step.pins === null && !kept();
      if (indexes.length > 0 || pins) out.push({ object: obj.id, node: step.id, indexes, ...(pins ? { pins: true as const } : {}) });
    }
  }
  return out;
}

/** What `src/project-envelope.ts` decodes Model sections with. */
export const modelSectionReader: ModelSectionReader = { readTrees, readHeldPieces };

/** A project the envelope read with its Model sections still as they were, finished: the project a full read gives. */
export function readModelSections(project: LimeProject): LimeProject {
  return project.modelSections ? assemblePlate(project.modelSections, modelSectionReader) : project;
}
