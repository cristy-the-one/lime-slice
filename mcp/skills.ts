/**
 * The lime-slice skill, served over io.modelcontextprotocol/skills (SEP-2640).
 * The folder is `skills/` beside this file: `mcp/skills/` while running the checkout,
 * and the copy `tools/mcp/bundle.mjs` places beside `server.mjs` in an install.
 * Digests and `resources/read` both take the buffer from `readFileSync` with no
 * encoding and no newline rewrite, so a CRLF file is hashed and served as those bytes. There is no YAML package in this
 * repo; the shipped frontmatter is flat `key: value` lines, and that is what is parsed.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

export interface SkillResource {
  uri: string;
  digest: string;
  size: number;
}

export interface SkillEntry {
  uri: string;
  frontmatter: Record<string, string>;
  resources: SkillResource[];
}

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
 * The `---` block as JSON. A line that is not `key: value` means the block is not
 * the flat frontmatter this server knows how to serve, and the skill is skipped.
 */
function parseFrontmatter(bytes: Buffer): Record<string, string> | null {
  const lines = bytes.toString("utf8").split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const fields: Record<string, string> = Object.create(null);
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const key = line.slice(0, colon).trim();
    if (key === "" || Object.hasOwn(fields, key)) return null;
    fields[key] = line.slice(colon + 1).trim();
  }
  return fields;
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

function load(root: string): LoadedSkill[] {
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const loaded: LoadedSkill[] = [];
  for (const entry of names) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = join(root, entry.name);
    const skillPath = join(dir, "SKILL.md");
    let skillBytes: Buffer;
    try {
      skillBytes = readFileSync(skillPath);
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(skillBytes);
    const name = frontmatter?.name ?? "";
    const description = frontmatter?.description ?? "";
    // The last segment of the skill path is the directory name. It has to be the frontmatter name.
    if (frontmatter === null || name === "" || description === "" || name !== entry.name) continue;
    const files = new Map<string, Buffer>();
    const resources: SkillResource[] = [];
    for (const file of filesUnder(dir)) {
      const rel = relative(dir, file).split(sep).join("/");
      if (rel === "" || rel.split("/").includes("..")) continue;
      const uri = `skill://${entry.name}/${rel}`;
      const bytes = file === skillPath ? skillBytes : readFileSync(file);
      files.set(uri, bytes);
      resources.push({ uri, digest: sha256(bytes), size: bytes.length });
    }
    resources.sort((a, b) => {
      const aSkill = a.uri.endsWith("/SKILL.md");
      const bSkill = b.uri.endsWith("/SKILL.md");
      if (aSkill !== bSkill) return aSkill ? -1 : 1;
      return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
    });
    loaded.push({
      entry: { uri: `skill://${entry.name}/SKILL.md`, frontmatter, resources },
      files,
    });
  }
  loaded.sort((a, b) => (a.entry.uri < b.entry.uri ? -1 : a.entry.uri > b.entry.uri ? 1 : 0));
  return loaded;
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
