/**
 * --- Plugin steps (docs/plan-recipe-plugins.md D6, D7). A plugin file as the app reads the project's copies: its `//!`
 * front matter and its body, and whether the body is still the code its hash names. Browser-safe: the hash is Web
 * Crypto's. The MCP server writes these files (`mcp/plugins.ts`); this reads the same format.
 */
import type { PluginValue } from "./model-tree.ts";

/** One declared parameter, as the header's `params` caches it. */
export interface PluginParamInfo {
  name: string;
  kind: "number" | "count" | "toggle" | "choice" | "text" | "face" | "outline";
  default: PluginValue | null;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label?: string;
  help?: string;
  options?: string[];
  /** A face parameter that takes a curved face too (recipe API 1.3). */
  curved?: boolean;
}

export interface PluginFileInfo {
  plugin: string;
  /** Animation plugins run in Pose, not Model. Absent means a recipe plugin. */
  kind?: "animation";
  title: string;
  version: number;
  description: string;
  author: string;
  madeBy: string;
  api: string;
  params: PluginParamInfo[];
  /** Whether a run needs a part (`object`), may take one (`either`), or makes its own (`new`). */
  target: PluginTarget;
  /** The header's `source-sha256`: the body the header was written for. */
  headerSha: string;
  created: string;
  lust: string;
  built?: string;
  body: string;
  /** The whole file, LF line ends. */
  text: string;
}

export type PluginTarget = "new" | "object" | "either";

/** A project's copy, read and checked: `intact` when its body hashes to the key it is kept under. */
export interface CheckedCopy {
  file: PluginFileInfo | null;
  intact: boolean;
}

const FENCE = "//! ---";

/** Plugin text is data (D11.5): one line, no control characters, at most `max` characters. */
function oneLine(text: string | undefined, max: number): string {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The front matter and body of a plugin file, or null when it has none. */
export function readPluginFile(raw: string): PluginFileInfo | null {
  const text = raw.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== FENCE) return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === FENCE);
  if (end < 0) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const m = /^\/\/!\s?([a-z0-9-]+):\s?(.*)$/.exec(line);
    if (m) fields.set(m[1]!, m[2]!.trim());
  }
  const plugin = fields.get("plugin") ?? "";
  if (!plugin) return null;
  let params: PluginParamInfo[] = [];
  try {
    const parsed = JSON.parse(fields.get("params") ?? "[]") as unknown;
    if (Array.isArray(parsed)) params = parsed.filter((p): p is PluginParamInfo => !!p && typeof p === "object" && typeof (p as PluginParamInfo).name === "string");
  } catch {
    params = [];
  }
  const target = fields.get("target");
  return {
    plugin,
    ...(fields.get("kind") === "animation" ? { kind: "animation" as const } : {}),
    title: oneLine(fields.get("title") ?? plugin, 60),
    version: Math.max(1, Math.floor(Number(fields.get("version")) || 1)),
    description: oneLine(fields.get("description"), 280),
    author: oneLine(fields.get("author") || "unknown", 60),
    madeBy: oneLine(fields.get("made-by"), 60),
    api: fields.get("api") ?? "1.0",
    params,
    target: target === "object" || target === "either" ? target : "new",
    headerSha: fields.get("source-sha256") ?? "",
    created: fields.get("created") ?? "",
    lust: fields.get("lust") ?? "",
    ...(fields.get("built") ? { built: oneLine(fields.get("built"), 100) } : {}),
    body: lines.slice(end + 1).join("\n"),
    text,
  };
}

/** A plugin's header as it is written (D6), in the MCP server's field order (`pluginText` in `mcp/plugins.ts`). */
export interface PluginHeaderOut {
  plugin: string;
  kind?: "animation";
  title: string;
  version: number;
  description: string;
  author: string;
  madeBy?: string;
  api: string;
  lust?: string;
  sha256: string;
  created: string;
  target: PluginTarget;
  params: PluginParamInfo[];
}

/** The file text: the front matter as inner doc comments, then the body, so the file is a valid main.rs as it stands. */
export function pluginFileText(header: PluginHeaderOut, body: string): string {
  const fields: [string, unknown][] = [
    ["plugin", header.plugin],
    ["kind", header.kind],
    ["title", header.title],
    ["version", header.version],
    ["description", header.description],
    ["author", header.author],
    ["made-by", header.madeBy],
    ["api", header.api],
    ["lust", header.lust],
    ["source-sha256", header.sha256],
    ["created", header.created],
    ["target", header.target],
    ["params", JSON.stringify(header.params)],
  ];
  const lines = fields.filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => `//! ${key}: ${value}`);
  return [FENCE, ...lines, FENCE, body.replace(/\r\n?/g, "\n").replace(/^\n+/, "")].join("\n");
}

/** SHA-256 of a body as the MCP server hashes it (`bodyHash`): UTF-8, LF line ends, lower-case hex. */
export async function bodySha256(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body.replace(/\r\n?/g, "\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Each of the project's copies read and checked against the hash it is kept under. */
export async function checkedCopies(plugins: Record<string, string> | undefined): Promise<Map<string, CheckedCopy>> {
  const out = new Map<string, CheckedCopy>();
  for (const [sha, text] of Object.entries(plugins ?? {})) {
    const file = readPluginFile(text);
    out.set(sha, { file, intact: !!file && (await bodySha256(file.body)) === sha });
  }
  return out;
}
