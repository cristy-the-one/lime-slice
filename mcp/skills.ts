/**
 * Skills served over io.modelcontextprotocol/skills (SEP-2640 / ext-skills).
 * The folder is `skills/` beside this file: `mcp/skills/` while running the checkout,
 * and the copy `tools/mcp/bundle.mjs` places beside `server.mjs` in an install.
 * Digests and `resources/read` both take the buffer from `readFileSync` with no
 * encoding and no newline rewrite, so a CRLF file is hashed and served as those bytes.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
/** SEP-2640 §Limits: hosts must support up to 512 entries and 16 MiB per skill; servers should not exceed them. */
export const MAX_RESOURCES_PER_SKILL = 512;
export const MAX_TOTAL_SIZE_PER_SKILL = 16 * 1024 * 1024;

/**
 * Agent Skills naming rules (agentskills.io/specification#name-field):
 * 1-64 chars, lowercase ASCII alphanumeric and hyphens, no leading/trailing/consecutive hyphens.
 */
const SKILL_NAME_RE = /^(?!.*--)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
/** RFC 3986 reg-name / URI segment check for organizational prefix segments. */
const URI_SEGMENT_RE = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})+$/;
const MAX_DESCRIPTION_LEN = 1024;
const MAX_COMPATIBILITY_LEN = 500;

export interface SkillResource {
  uri: string;
  digest: string;
  size: number;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface SkillEntry {
  uri: string;
  frontmatter: SkillFrontmatter;
  resources: SkillResource[];
}

export type SkillResourceContent =
  | { uri: string; mimeType: string; text: string; blob?: undefined }
  | { uri: string; mimeType: string; blob: string; text?: undefined };

interface LoadedSkill {
  entry: SkillEntry;
  files: Map<string, Buffer>;
}

/** `LIME_MCP_SKILLS` is how the tests point at a throwaway folder. */
export function skillsRoot(): string {
  const override = process.env.LIME_MCP_SKILLS;
  if (typeof override === "string" && override.trim() !== "") return override;
  return join(dirname(fileURLToPath(import.meta.url)), "skills");
}

/**
 * The `---` block as JSON. The frontmatter this server serves is flat: one `key: value` line per field, the value
 * taken as written. Blank lines and `#` comment lines are skipped. Anything a YAML reader would read differently (an
 * indented line, a field with no value on its line, a quoted, block, flow, anchored or tagged value, a repeated key)
 * means the block is not that flat frontmatter, and the skill is skipped instead of served with a misread field.
 */
export function parseFrontmatter(bytes: Buffer): Record<string, string> | null {
  let text = bytes.toString("utf8");
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const fields: Record<string, string> = Object.create(null);
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (/^\s/.test(line)) return null;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "" || value === "" || Object.hasOwn(fields, key)) return null;
    if (/^["'|>\[{&*!%@`#]/.test(value) || / #/.test(value)) return null;
    fields[key] = value;
  }
  return fields;
}

function validateFrontmatter(raw: Record<string, unknown> | null, dirName: string): SkillFrontmatter | null {
  if (raw === null) return null;
  const name = raw.name;
  const description = raw.description;
  if (typeof name !== "string" || !SKILL_NAME_RE.test(name) || name !== dirName) return null;
  if (typeof description !== "string" || description.trim() === "" || description.length > MAX_DESCRIPTION_LEN) return null;
  if (raw.compatibility !== undefined) {
    if (typeof raw.compatibility !== "string" || raw.compatibility.trim() === "" || raw.compatibility.length > MAX_COMPATIBILITY_LEN) {
      return null;
    }
  }
  // `metadata` is a map, and a map is not flat frontmatter: a value on its line is not one.
  if (raw.metadata !== undefined) return null;
  return raw as SkillFrontmatter;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function filesUnder(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** Recursively discovers every directory under `root` containing a regular `SKILL.md` file. */
function skillDirsUnder(root: string, current = root): string[] {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  let hasSkillMd = false;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name === "SKILL.md" && current !== root) {
      hasSkillMd = true;
    } else if (entry.isDirectory()) {
      dirs.push(...skillDirsUnder(root, join(current, entry.name)));
    }
  }
  if (hasSkillMd) dirs.push(current);
  return dirs;
}

function encodeRelativeUriPath(rel: string): string {
  return rel.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function load(root: string): LoadedSkill[] {
  const loaded: LoadedSkill[] = [];
  for (const dir of skillDirsUnder(root)) {
    const relDir = relative(root, dir).split(sep).join("/");
    if (relDir === "" || relDir.split("/").includes("..")) continue;
    const segments = relDir.split("/");
    const dirName = segments[segments.length - 1] ?? "";
    if (!segments.every((seg) => URI_SEGMENT_RE.test(seg))) continue;

    const skillPath = join(dir, "SKILL.md");
    let skillBytes: Buffer;
    try {
      skillBytes = readFileSync(skillPath);
    } catch {
      continue;
    }
    const frontmatter = validateFrontmatter(parseFrontmatter(skillBytes), dirName);
    if (frontmatter === null) continue;

    const skillUri = `skill://${relDir}/SKILL.md`;
    const files = new Map<string, Buffer>();
    const resources: SkillResource[] = [];
    let totalSize = 0;
    let oversized = false;

    for (const file of filesUnder(dir)) {
      const rel = relative(dir, file).split(sep).join("/");
      if (rel === "" || rel.split("/").includes("..")) continue;
      if (resources.length >= MAX_RESOURCES_PER_SKILL) {
        oversized = true;
        break;
      }
      const uri = `skill://${relDir}/${encodeRelativeUriPath(rel)}`;
      const bytes = file === skillPath ? skillBytes : readFileSync(file);
      totalSize += bytes.length;
      if (totalSize > MAX_TOTAL_SIZE_PER_SKILL) {
        oversized = true;
        break;
      }
      files.set(uri, bytes);
      resources.push({ uri, digest: sha256(bytes), size: bytes.length });
    }
    if (oversized || !files.has(skillUri)) continue;

    resources.sort((a, b) => {
      const aSkill = a.uri === skillUri;
      const bSkill = b.uri === skillUri;
      if (aSkill !== bSkill) return aSkill ? -1 : 1;
      return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
    });
    loaded.push({
      entry: { uri: skillUri, frontmatter, resources },
      files,
    });
  }
  loaded.sort((a, b) => (a.entry.uri < b.entry.uri ? -1 : a.entry.uri > b.entry.uri ? 1 : 0));
  return loaded;
}

const TEXT_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".mts": "text/typescript",
  ".cts": "text/typescript",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".svg": "image/svg+xml",
};

const BINARY_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".stl": "model/stl",
  ".3mf": "model/3mf",
  ".step": "model/step",
  ".stp": "model/step",
  ".glb": "model/gltf-binary",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

// `ignoreBOM` keeps a leading byte-order mark in the text, so the text is every byte the digest and size were taken of.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeUtf8Text(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function listSkills(root = skillsRoot()): SkillEntry[] {
  return load(root).map((row) => row.entry);
}

export function getSkill(uri: string, root = skillsRoot()): SkillEntry | null {
  return load(root).find((row) => row.entry.uri === uri)?.entry ?? null;
}

/** The bytes `listSkills` hashed for this URI, read again the same way. */
export function readSkillFile(uri: string, root = skillsRoot()): Buffer | null {
  for (const row of load(root)) {
    const bytes = row.files.get(uri);
    if (bytes) return bytes;
  }
  return null;
}

/**
 * Formats a skill file for `resources/read`: `SKILL.md` is `text/markdown`, other files
 * get their content-appropriate MIME type, and binary/non-UTF-8 files use `blob` (base64)
 * so bytes round-trip identically to the SHA-256 digest and size in the manifest.
 */
export function readSkillResource(uri: string, root = skillsRoot()): SkillResourceContent | null {
  const bytes = readSkillFile(uri, root);
  if (!bytes) return null;
  const ext = extname(uri).toLowerCase();
  const binaryMime = BINARY_MIME[ext];
  if (binaryMime) {
    return { uri, mimeType: binaryMime, blob: bytes.toString("base64") };
  }
  const text = decodeUtf8Text(bytes);
  if (text === null) {
    return { uri, mimeType: "application/octet-stream", blob: bytes.toString("base64") };
  }
  return { uri, mimeType: TEXT_MIME[ext] ?? "text/plain", text };
}
