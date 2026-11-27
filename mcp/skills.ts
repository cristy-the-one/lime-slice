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

class YamlError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function indentOf(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === " ") count += 1;
  if (count < line.length && line[count] === "\t") throw new YamlError("Tab indentation is not allowed.");
  return count;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function stripInlineComment(text: string): string {
  let quote: '"' | "'" | null = null;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote === '"') {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") i += 1;
        else quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function parseDoubleQuoted(text: string, start: number): { value: string; next: number } {
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') return { value: out, next: i + 1 };
    if (ch === "\\") {
      i += 1;
      if (i >= text.length) throw new YamlError("Unterminated escape.");
      const esc = text[i]!;
      switch (esc) {
        case "0": out += "\0"; break;
        case "a": out += "\x07"; break;
        case "b": out += "\b"; break;
        case "t": case "\t": out += "\t"; break;
        case "n": out += "\n"; break;
        case "v": out += "\v"; break;
        case "f": out += "\f"; break;
        case "r": out += "\r"; break;
        case "e": out += "\x1b"; break;
        case " ": out += " "; break;
        case '"': out += '"'; break;
        case "/": out += "/"; break;
        case "\\": out += "\\"; break;
        case "N": out += "\u0085"; break;
        case "_": out += "\u00a0"; break;
        case "L": out += "\u2028"; break;
        case "P": out += "\u2029"; break;
        case "x": {
          const hex = text.slice(i + 1, i + 3);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new YamlError("Invalid \\x escape.");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 2;
          break;
        }
        case "u": {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new YamlError("Invalid \\u escape.");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
          break;
        }
        case "U": {
          const hex = text.slice(i + 1, i + 9);
          if (!/^[0-9a-fA-F]{8}$/.test(hex)) throw new YamlError("Invalid \\U escape.");
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 8;
          break;
        }
        default:
          throw new YamlError(`Unsupported escape \\${esc}.`);
      }
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  throw new YamlError("Unterminated double-quoted string.");
}

function parseSingleQuoted(text: string, start: number): { value: string; next: number } {
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, next: i + 1 };
    }
    out += ch;
    i += 1;
  }
  throw new YamlError("Unterminated single-quoted string.");
}

/** YAML 1.2 Core Schema plain scalar conversion. */
function parsePlainScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "Null" || s === "NULL" || s === "~") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (/^[-+]?(?:0|[1-9][0-9]*)$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^0o[0-7]+$/.test(s)) {
    const n = Number.parseInt(s.slice(2), 8);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^0x[0-9a-fA-F]+$/.test(s)) {
    const n = Number.parseInt(s.slice(2), 16);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(s) || /^\.(?:nan|NaN|NAN)$/.test(s)) {
    throw new YamlError("Non-JSON float literal is not supported.");
  }
  return s;
}

function parseFlowValue(text: string, pos: number): { value: unknown; next: number } {
  let i = pos;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  if (i >= text.length) throw new YamlError("Expected flow value.");
  const ch = text[i]!;
  if (ch === "&" || ch === "*" || ch === "!") throw new YamlError("Anchors, aliases, and tags are not supported.");
  if (ch === '"') return parseDoubleQuoted(text, i);
  if (ch === "'") return parseSingleQuoted(text, i);
  if (ch === "[") return parseFlowSequence(text, i);
  if (ch === "{") return parseFlowMapping(text, i);
  let end = i;
  while (end < text.length && text[end] !== "," && text[end] !== "]" && text[end] !== "}") {
    if (text[end] === ":" && (text[end + 1] === " " || text[end + 1] === "\t" || text[end + 1] === "," || text[end + 1] === "}" || text[end + 1] === "]")) {
      break;
    }
    end += 1;
  }
  const slice = text.slice(i, end).trim();
  return { value: parsePlainScalar(slice), next: end };
}

function parseFlowSequence(text: string, start: number): { value: unknown[]; next: number } {
  const items: unknown[] = [];
  let i = start + 1;
  for (;;) {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
    if (i >= text.length) throw new YamlError("Unterminated flow sequence.");
    if (text[i] === "]") return { value: items, next: i + 1 };
    const parsed = parseFlowValue(text, i);
    items.push(parsed.value);
    i = parsed.next;
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] === "]") return { value: items, next: i + 1 };
    throw new YamlError("Expected ',' or ']' in flow sequence.");
  }
}

function parseFlowMapping(text: string, start: number): { value: Record<string, unknown>; next: number } {
  const obj: Record<string, unknown> = Object.create(null);
  let i = start + 1;
  for (;;) {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
    if (i >= text.length) throw new YamlError("Unterminated flow mapping.");
    if (text[i] === "}") return { value: obj, next: i + 1 };
    let key: string;
    if (text[i] === '"') {
      const k = parseDoubleQuoted(text, i);
      key = k.value;
      i = k.next;
    } else if (text[i] === "'") {
      const k = parseSingleQuoted(text, i);
      key = k.value;
      i = k.next;
    } else {
      let end = i;
      while (end < text.length && text[end] !== ":" && text[end] !== "}" && text[end] !== ",") end += 1;
      key = text.slice(i, end).trim();
      i = end;
    }
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
    if (key === "" || text[i] !== ":" || Object.hasOwn(obj, key)) {
      throw new YamlError("Invalid or duplicate key in flow mapping.");
    }
    i += 1;
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
    if (text[i] === "," || text[i] === "}") {
      obj[key] = null;
    } else {
      const val = parseFlowValue(text, i);
      obj[key] = val.value;
      i = val.next;
    }
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] === "}") return { value: obj, next: i + 1 };
    throw new YamlError("Expected ',' or '}' in flow mapping.");
  }
}

/** Splits a YAML mapping entry (`key: value`). Returns null if the line is not a mapping entry. */
function splitMappingLine(content: string): { key: string; rest: string } | null {
  if (content === "" || content.startsWith("- ") || content === "-" || content.startsWith("? ")) return null;
  if (content[0] === '"') {
    const parsed = parseDoubleQuoted(content, 0);
    let i = parsed.next;
    while (i < content.length && (content[i] === " " || content[i] === "\t")) i += 1;
    if (content[i] !== ":") return null;
    const after = content.slice(i + 1);
    if (after !== "" && after[0] !== " " && after[0] !== "\t") return null;
    return { key: parsed.value, rest: after.trimStart() };
  }
  if (content[0] === "'") {
    const parsed = parseSingleQuoted(content, 0);
    let i = parsed.next;
    while (i < content.length && (content[i] === " " || content[i] === "\t")) i += 1;
    if (content[i] !== ":") return null;
    const after = content.slice(i + 1);
    if (after !== "" && after[0] !== " " && after[0] !== "\t") return null;
    return { key: parsed.value, rest: after.trimStart() };
  }
  if (content[0] === "[" || content[0] === "{") return null;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!;
    if (ch === "#" && (i === 0 || content[i - 1] === " " || content[i - 1] === "\t")) return null;
    if (ch === ":" && (i + 1 === content.length || content[i + 1] === " " || content[i + 1] === "\t")) {
      const key = content.slice(0, i).trim();
      if (key === "") return null;
      return { key, rest: content.slice(i + 1).trimStart() };
    }
  }
  return null;
}

function parseBlockScalar(lines: string[], start: number, parentIndent: number, header: string): { value: string; next: number } {
  const match = /^([|>])(?:([1-9])([+-])?|([+-])([1-9])?)?(?:[ \t]+#.*)?$/.exec(header.trim());
  if (!match) throw new YamlError("Invalid block scalar header.");
  const style = match[1] as "|" | ">";
  const explicitIndent = match[2] ?? match[5];
  const chomp = (match[3] ?? match[4] ?? "") as "" | "-" | "+";

  let blockIndent = explicitIndent ? parentIndent + Number(explicitIndent) : -1;
  const collected: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      collected.push(line);
      i += 1;
      continue;
    }
    let spaces = 0;
    while (spaces < line.length && line[spaces] === " ") spaces += 1;
    if (blockIndent < 0) {
      if (spaces <= parentIndent) break;
      blockIndent = spaces;
    } else if (spaces < blockIndent) {
      break;
    }
    collected.push(line);
    i += 1;
  }

  // Separate trailing blank lines for chomping.
  let trailingBlanks = 0;
  while (collected.length > 0 && collected[collected.length - 1]!.trim() === "") {
    collected.pop();
    trailingBlanks += 1;
  }

  if (collected.length === 0) {
    return { value: chomp === "+" ? "\n".repeat(trailingBlanks) : "", next: i };
  }

  const stripped = collected.map((line) => (line.length <= blockIndent ? "" : line.slice(blockIndent)));
  let body: string;
  if (style === "|") {
    body = stripped.join("\n");
  } else {
    // Folded scalar (>): single newlines between normal lines fold to spaces; blank lines and more-indented lines keep newlines.
    let out = "";
    for (let k = 0; k < stripped.length; k += 1) {
      const cur = stripped[k]!;
      if (k === 0) {
        out = cur;
        continue;
      }
      const prev = stripped[k - 1]!;
      const curMore = cur.startsWith(" ") || cur.startsWith("\t");
      const prevMore = prev.startsWith(" ") || prev.startsWith("\t");
      if (cur === "") {
        out += "\n";
      } else if (prev === "") {
        // One blank line separates paragraphs with a single newline; extra blanks kept above.
        out += cur;
      } else if (curMore || prevMore) {
        out += `\n${cur}`;
      } else {
        out += ` ${cur}`;
      }
    }
    body = out;
  }

  if (chomp === "-") return { value: body, next: i };
  if (chomp === "+") return { value: `${body}\n${"\n".repeat(trailingBlanks)}`, next: i };
  return { value: `${body}\n`, next: i };
}

function parseInlineValue(lines: string[], idx: number, ownerIndent: number, rest: string): { value: unknown; next: number } {
  if (rest === "" || rest.startsWith("#")) {
    let next = idx + 1;
    while (next < lines.length && isBlankOrComment(lines[next]!)) next += 1;
    if (next >= lines.length) return { value: null, next };
    const nextIndent = indentOf(lines[next]!);
    const nextContent = lines[next]!.slice(nextIndent);
    if (nextIndent === ownerIndent && (nextContent === "-" || nextContent.startsWith("- "))) {
      return parseBlockSequence(lines, next, nextIndent);
    }
    if (nextIndent > ownerIndent) {
      if (nextContent === "-" || nextContent.startsWith("- ")) {
        return parseBlockSequence(lines, next, nextIndent);
      }
      if (splitMappingLine(nextContent) !== null) {
        return parseBlockMapping(lines, next, nextIndent);
      }
      return parseMultilinePlain(lines, next, ownerIndent, "");
    }
    return { value: null, next };
  }

  if (rest[0] === "&" || rest[0] === "*" || rest[0] === "!") {
    throw new YamlError("Anchors, aliases, and tags are not supported.");
  }
  if (rest[0] === "|" || rest[0] === ">") {
    return parseBlockScalar(lines, idx + 1, ownerIndent, rest);
  }
  if (rest[0] === '"') {
    const parsed = parseDoubleQuoted(rest, 0);
    const trailing = stripInlineComment(rest.slice(parsed.next)).trim();
    if (trailing !== "") throw new YamlError("Unexpected trailing text after double-quoted string.");
    return { value: parsed.value, next: idx + 1 };
  }
  if (rest[0] === "'") {
    const parsed = parseSingleQuoted(rest, 0);
    const trailing = stripInlineComment(rest.slice(parsed.next)).trim();
    if (trailing !== "") throw new YamlError("Unexpected trailing text after single-quoted string.");
    return { value: parsed.value, next: idx + 1 };
  }
  if (rest[0] === "[" || rest[0] === "{") {
    const cleaned = stripInlineComment(rest);
    const parsed = parseFlowValue(cleaned, 0);
    if (cleaned.slice(parsed.next).trim() !== "") throw new YamlError("Unexpected trailing text after flow value.");
    return { value: parsed.value, next: idx + 1 };
  }

  const first = stripInlineComment(rest);
  // Check for multiline plain scalar continuation on subsequent more-indented lines.
  return parseMultilinePlain(lines, idx + 1, ownerIndent, first);
}

function parseMultilinePlain(lines: string[], start: number, ownerIndent: number, first: string): { value: unknown; next: number } {
  const parts: string[] = first === "" ? [] : [first];
  let i = start;
  let pendingBlanks = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      pendingBlanks += 1;
      i += 1;
      continue;
    }
    const ind = indentOf(line);
    if (ind <= ownerIndent) break;
    const content = line.slice(ind);
    if (content.startsWith("#")) break;
    if (parts.length > 0 && pendingBlanks > 0) {
      parts.push("\n".repeat(pendingBlanks));
    } else if (parts.length > 0) {
      parts.push(" ");
    }
    pendingBlanks = 0;
    parts.push(stripInlineComment(content).trim());
    i += 1;
  }
  return { value: parsePlainScalar(parts.join("")), next: i };
}

function parseBlockSequence(lines: string[], start: number, seqIndent: number): { value: unknown[]; next: number } {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    if (isBlankOrComment(lines[i]!)) {
      i += 1;
      continue;
    }
    const ind = indentOf(lines[i]!);
    if (ind < seqIndent) break;
    if (ind > seqIndent) throw new YamlError("Unexpected indentation in sequence.");
    const content = lines[i]!.slice(ind);
    if (content !== "-" && !content.startsWith("- ")) break;
    const afterDash = content === "-" ? "" : content.slice(2);
    const itemIndent = ind + 2 + (afterDash.length - afterDash.trimStart().length);
    const trimmedAfter = afterDash.trimStart();
    if (trimmedAfter !== "" && !trimmedAfter.startsWith("#")) {
      const inlineMap = splitMappingLine(trimmedAfter);
      if (inlineMap !== null) {
        // Inline mapping starting on the `- key: val` line.
        const map: Record<string, unknown> = Object.create(null);
        const firstVal = parseInlineValue(lines, i, itemIndent, inlineMap.rest);
        map[inlineMap.key] = firstVal.value;
        i = firstVal.next;
        // Consume any additional keys at itemIndent.
        while (i < lines.length) {
          if (isBlankOrComment(lines[i]!)) {
            i += 1;
            continue;
          }
          const nextInd = indentOf(lines[i]!);
          if (nextInd < itemIndent) break;
          if (nextInd > itemIndent) throw new YamlError("Unexpected indentation in sequence mapping.");
          const entry = splitMappingLine(lines[i]!.slice(nextInd));
          if (!entry || Object.hasOwn(map, entry.key)) throw new YamlError("Invalid or duplicate mapping key.");
          const val = parseInlineValue(lines, i, itemIndent, entry.rest);
          map[entry.key] = val.value;
          i = val.next;
        }
        items.push(map);
        continue;
      }
    }
    const parsed = parseInlineValue(lines, i, ind, trimmedAfter);
    items.push(parsed.value);
    i = parsed.next;
  }
  return { value: items, next: i };
}

function parseBlockMapping(lines: string[], start: number, mapIndent: number): { value: Record<string, unknown>; next: number } {
  const fields: Record<string, unknown> = Object.create(null);
  let i = start;
  while (i < lines.length) {
    if (isBlankOrComment(lines[i]!)) {
      i += 1;
      continue;
    }
    const ind = indentOf(lines[i]!);
    if (ind < mapIndent) break;
    if (ind > mapIndent) throw new YamlError("Unexpected indentation in mapping.");
    const content = lines[i]!.slice(ind);
    const entry = splitMappingLine(content);
    if (!entry || Object.hasOwn(fields, entry.key)) throw new YamlError("Invalid or duplicate mapping key.");
    const parsed = parseInlineValue(lines, i, mapIndent, entry.rest);
    fields[entry.key] = parsed.value;
    i = parsed.next;
  }
  return { value: fields, next: i };
}

/**
 * Parses the YAML frontmatter block (`---` ... `---` / `...`) at the start of a SKILL.md
 * into a verbatim JSON-compatible object, matching YAML 1.2 Core Schema.
 * Returns null if frontmatter is missing, malformed, or uses unsupported YAML features.
 */
export function parseFrontmatter(bytes: Buffer): Record<string, unknown> | null {
  let text = bytes.toString("utf8");
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (!/^---[ \t]*$/.test(lines[0] ?? "")) return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const block = lines.slice(1, end);
  try {
    let first = 0;
    while (first < block.length && isBlankOrComment(block[first]!)) first += 1;
    if (first >= block.length) return Object.create(null) as Record<string, unknown>;
    const baseIndent = indentOf(block[first]!);
    if (baseIndent !== 0) return null;
    const parsed = parseBlockMapping(block, first, 0);
    let tail = parsed.next;
    while (tail < block.length && isBlankOrComment(block[tail]!)) tail += 1;
    if (tail < block.length) return null;
    return parsed.value;
  } catch {
    return null;
  }
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
  if (raw.metadata !== undefined && !isPlainObject(raw.metadata)) return null;
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

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

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
