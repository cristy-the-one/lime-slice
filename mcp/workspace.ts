import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * A write under the workspace. `name` may be a file name or a path.
 * A path that leaves the workspace, including through a symlink, is refused
 * before any directory is created. An existing regular file may be overwritten.
 */
export function resolveWrite(name: string, suffix: string): string {
  const root = requireWorkspace();
  if (!name || name.includes("\0")) throw new ProtocolError("That name cannot be written.");
  const withSuffix = name.toLowerCase().endsWith(suffix) ? name : `${name}${suffix}`;
  const full = resolve(isAbsolute(withSuffix) ? withSuffix : join(root, withSuffix));
  if (!inside(root, full)) throw new ProtocolError("Writes stay inside LIME_MCP_WORKSPACE.");
  const parts = relative(root, full).split(sep).filter((part) => part !== "");
  if (parts.length === 0) throw new ProtocolError("Writes stay inside LIME_MCP_WORKSPACE.");
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    const next = join(current, parts[i]!);
    const last = i === parts.length - 1;
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(next);
    } catch {
      stat = null;
    }
    if (stat?.isSymbolicLink()) throw new ProtocolError("Writes stay inside LIME_MCP_WORKSPACE.");
    if (!stat) {
      if (last) return next;
      mkdirSync(next);
      const real = realpathSync(next);
      if (!inside(root, real)) throw new ProtocolError("Writes stay inside LIME_MCP_WORKSPACE.");
      current = real;
      continue;
    }
    if (last) {
      if (!stat.isFile()) throw new ProtocolError("That name cannot be written.");
      const real = realpathSync(next);
      if (!inside(root, real)) throw new ProtocolError("Writes stay inside LIME_MCP_WORKSPACE.");
      return real;
    }
    if (!stat.isDirectory()) throw new ProtocolError("That name cannot be written.");
    const real = realpathSync(next);
    if (!inside(root, real)) throw new ProtocolError("Writes stay inside LIME_MCP_WORKSPACE.");
    current = real;
  }
  throw new ProtocolError("Writes stay inside LIME_MCP_WORKSPACE.");
}
