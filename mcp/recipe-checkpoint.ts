/** A bounded journal of a recipe's calls and their replies, stored only in this server's autosave. */
import { createHash } from "node:crypto";
import { pathTo } from "../src/model-tree.ts";
import type { RecipeCallSite, RecipeReply } from "../src/recipe/host.ts";
import type { PlateObject } from "./session/shared.ts";
import type { KeptIngredient } from "./ingredients.ts";
import type { RecipeData } from "./recipe.ts";

export const CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;

export interface CheckpointEvent { site: RecipeCallSite; reply: RecipeReply }
export interface RecipeCheckpoint {
  source: string;
  buildHash: string;
  environmentHash: string;
  params: Record<string, unknown>;
  events: CheckpointEvent[];
  objects: { id: string; signature: string }[];
  placed: string[];
  modelPlaced: string[];
  selected: string;
  assemblies: unknown;
  notes: string[];
  data: Record<string, RecipeData>;
  carried: Record<string, RecipeData>;
  ingredients: Record<string, KeptIngredient>;
}

/** Stable JSON for comparing call arguments and parameters independently of object key order. */
export function checkpointJson(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value));
}

/** Geometry and placements that must still match before a checkpoint is replayed. */
export function checkpointSignature(obj: PlateObject): string {
  const tree = obj.tree;
  const data = {
    root: tree?.root ?? null,
    current: tree?.current ?? null,
    ops: tree ? pathTo(tree, tree.current).map((id) => tree.nodes.get(id)?.op ?? null) : [],
    pose: obj.modelPose, frame: obj.frame ?? null,
    orient: obj.orient, scale: obj.scale, centered: obj.centered, offset: obj.offset,
  };
  return createHash("sha256").update(checkpointJson(data)).digest("hex");
}

/** Autosaves are data: ignore malformed or oversized journals instead of trusting them. */
export function checkpointRecords(value: unknown): Record<string, RecipeCheckpoint> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, RecipeCheckpoint> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(name) || !raw || typeof raw !== "object") continue;
    const c = raw as Partial<RecipeCheckpoint>;
    if (typeof c.source !== "string" || c.source.length > 100000 || typeof c.buildHash !== "string" || !/^[0-9a-f]{64}$/.test(c.buildHash) || typeof c.environmentHash !== "string" || !/^[0-9a-f]{64}$/.test(c.environmentHash) || !c.params || typeof c.params !== "object" || !Array.isArray(c.events) || c.events.length > 2000 || !Array.isArray(c.objects) || c.objects.length > 2000 || !Array.isArray(c.placed) || !Array.isArray(c.modelPlaced) || typeof c.selected !== "string" || !Array.isArray(c.notes) || !c.data || typeof c.data !== "object" || !c.carried || typeof c.carried !== "object" || !c.ingredients || typeof c.ingredients !== "object") continue;
    if (Buffer.byteLength(JSON.stringify(c)) > CHECKPOINT_MAX_BYTES || !c.objects.every((o) => o && typeof o.id === "string" && typeof o.signature === "string") || !c.events.every((e) => e && e.site && typeof e.site.tool === "string" && e.reply && typeof e.reply.ok === "boolean")) continue;
    result[name] = c as RecipeCheckpoint;
  }
  return result;
}
