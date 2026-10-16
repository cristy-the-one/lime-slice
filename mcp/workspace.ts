import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ProtocolError } from "./engine.ts";

const MESH_EXT = new Set([".stl", ".3mf", ".step", ".stp"]);

export function meshByteLimit(): number {
  const raw = Number(process.env.LIME_MCP_MESH_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 256 * 1024 * 1024;
}

/** The directory writes may use. Created only when the operator set it. */
export function workspaceRoot(): string | null {
  const raw = process.env.LIME_MCP_WORKSPACE;
  if (!raw || raw.trim() === "") return null;
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

export function requireWorkspace(): string {
  const root = workspaceRoot();
  if (!root) throw new ProtocolError("Set LIME_MCP_WORKSPACE to a directory before saving or exporting.");
  return root;
}

function extensionOf(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".limemachine.json")) return ".limemachine.json";
  if (lower.endsWith(".limeprofile.json")) return ".limeprofile.json";
  const dot = lower.lastIndexOf(".");
  return dot < 0 ? "" : lower.slice(dot);
}

/** A named input mesh or project. Not confined to the workspace. A symlink to a regular file is the file. */
export function resolveRead(path: string, kind: "mesh" | "lime" | "profile" | "machine"): string {
  if (!path || path.includes("\0")) throw new ProtocolError("That path is not a file this server can read.");
  const full = resolve(path);
  let stat;
  try {
    stat = statSync(full);
  } catch {
    throw new ProtocolError("That file was not found.");
  }
  if (!stat.isFile()) throw new ProtocolError("That path is not a regular file.");
  if (stat.size > meshByteLimit()) throw new ProtocolError("That file is larger than the mesh limit.");
  const ext = extensionOf(full);
  const allowed = kind === "mesh" ? MESH_EXT : kind === "lime" ? new Set([".lime"]) : kind === "profile" ? new Set([".limeprofile.json", ".json"]) : new Set([".limemachine.json", ".json"]);
  if (!allowed.has(ext)) {
    throw new ProtocolError(kind === "mesh"
      ? "Open a .stl, .3mf, .step, or .stp file. A .lime project uses project_open."
      : "That file is not the kind this tool reads.");
  }
  return full;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A write under the workspace. `name` may be a file name or a path.
 * A path that leaves the workspace, including through a symlink, is refused.
 * An existing file in the workspace may be overwritten.
 */
export function resolveWrite(name: string, suffix: string): string {
  const root = requireWorkspace();
  if (!name || name.includes("\0")) throw new ProtocolError("That name cannot be written.");
  const withSuffix = name.toLowerCase().endsWith(suffix) ? name : `${name}${suffix}`;
  const full = isAbsolute(withSuffix) ? withSuffix : resolve(root, withSuffix);
  const parent = full.slice(0, full.lastIndexOf(sep));
  mkdirSync(parent, { recursive: true });
  const realParent = realpathSync(parent);
  const target = resolve(realParent, full.slice(full.lastIndexOf(sep) + 1));
  if (!inside(root, target)) throw new ProtocolError("Writes stay inside LIME_MCP_WORKSPACE.");
  return target;
}
