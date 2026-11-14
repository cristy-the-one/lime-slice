/**
 * The catalogue an agent discovers the interface through (docs/plan-mcp-discovery.md). It reads what is already
 * written: the tools' descriptions and schemas (TOOLS), the op kinds, the kind texts and the guides, plus one example
 * per tool (examples.ts). Nothing here is a second copy of a description, so a new tool or field is found and explained
 * as soon as it is in TOOLS, and its words cost nothing until an agent asks for them.
 */
import { EXAMPLES } from "./examples.ts";
import { FIRST_TOOLS, groupOf, TOOL_GROUPS } from "./groups.ts";
import { GUIDES, guideSections, KIND_GUIDES } from "./guides.ts";
import { OP_KINDS, OP_SUMMARY, opFields, TOOLS, UNLISTED_TOOLS, type ToolSpec } from "./schema.ts";

export { FIRST_TOOLS };

/**
 * One line per area, for the map in the server's instructions and guide {}. A line says what the area is for, never
 * its tools, so a tool added to an area does not change it. "core" is every tool outside a group.
 */
export const AREAS: Record<string, string> = {
  core: "projects, importing meshes and STEP, the plate, printers, filament and settings, slicing, G-code and 3MF export, posing assemblies and animation, renders",
  model: "solids and Model edits: new solids, faces and edges, probe and apply, builds, recipes and plugins, history, measuring, commit to the plate",
  paint: "painted supports, seams and reinforcement",
  supports: "the sliced support trees: read, prune, grow",
  plate: "more plate work: duplicate, arrange, split shells, print order, height ranges, modifiers, overrides",
  layers: "the sliced layers and G-code in detail, layer actions",
  calibration: "calibration towers and blends",
  machines: "printer and filament records: load, read, set, save",
  stress: "stress studies: set up, solve, read a field, sweep",
};

export const AREA_NAMES: readonly string[] = Object.keys(AREAS);

/** The area a tool is in: its group, or core. */
export function areaOf(tool: string): string {
  return groupOf(tool) ?? "core";
}

/** The tools discovery covers: every tool but the old aliases that still answer (plugin is nugget now). */
export function catalogTools(): ToolSpec[] {
  return TOOLS.filter((tool) => !UNLISTED_TOOLS.has(tool.name));
}

/** A description's first sentence: the line a tool shows in a search or an area. */
export function firstSentence(text: string): string {
  // Not at "e.g." or "i.e.", nor the "!" of a "//!" line.
  const match = /^.*?(?<!\be\.g|\bi\.e|\/)[.!?](?=\s|$)/s.exec(text.trim());
  return (match ? match[0] : text.trim()).replace(/\s+/g, " ");
}

/** A line cut to about 160 characters, so one long guide line does not fill a search reply. */
function short(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).replace(/\s+\S*$/, "")}...`;
}

/** Tools about finding and calling: found by their own name, not by every task their description mentions. */
const META_TOOLS = new Set(["guide", "call", "tools_enable"]);

const STOP = new Set(["a", "an", "the", "to", "of", "and", "or", "in", "on", "for", "with", "by", "is", "it", "as", "at", "from", "into", "my", "how", "do", "i", "me", "can", "this", "that", "what", "which", "one", "be", "are", "its", "not", "no", "up"]);

/** Words of a text for matching: lower case, camelCase and snake_case split, a plural or -ing cut off. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP.has(word))
    .map(stem);
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("es") && /(ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  return word;
}

interface Entry {
  /** What the line says first: a tool name, "op gear", "topic slice". */
  label: string;
  /** The call that reads it in full. */
  read: string;
  line: string;
  name: Set<string>;
  text: Set<string>;
  /** A tool's fields: name words and description words, for the field a query names. */
  fields: { field: string; name: Set<string>; text: Set<string>; description: string }[];
  /** An exact name, ranked first when the query is that name. */
  exact: string;
}

let entries: Entry[] | null = null;

function properties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
}

function catalogue(): Entry[] {
  if (entries) return entries;
  const rows: Entry[] = [];
  for (const tool of catalogTools()) {
    rows.push({
      label: tool.name,
      read: `guide {tool:"${tool.name}"}`,
      line: short(firstSentence(tool.description), 200),
      name: new Set(words(tool.name)),
      text: new Set(words(`${tool.description} ${AREAS[areaOf(tool.name)]}`)),
      fields: Object.entries(properties(tool.inputSchema)).map(([field, node]) => ({
        field,
        name: new Set(words(field)),
        text: new Set(words(String(node.description ?? ""))),
        description: String(node.description ?? ""),
      })),
      exact: tool.name,
    });
  }
  for (const kind of OP_KINDS) {
    rows.push({
      label: `op ${kind}`,
      read: `guide {kind:"${kind}"}`,
      line: `${OP_SUMMARY[kind]} An op of model_apply, model_probe, model_build.`,
      name: new Set([...words(kind), "op", "edit"]),
      text: new Set(words(`${OP_SUMMARY[kind]} ${opFields(kind) ?? ""}`)),
      fields: [],
      exact: kind,
    });
  }
  for (const kind of Object.keys(KIND_GUIDES)) {
    const text = KIND_GUIDES[kind]!;
    rows.push({ label: `kind ${kind}`, read: `guide {kind:"${kind}"}`, line: short(firstSentence(text)), name: new Set(words(kind)), text: new Set(words(text)), fields: [], exact: kind });
  }
  for (const guide of GUIDES) {
    const topic = guide.uri.replace("lime://guide/", "");
    const sections = guideSections(topic);
    rows.push({
      label: `topic ${topic}`,
      read: `guide {topic:"${topic}"}`,
      line: short(`${guide.name}: ${firstSentence(guide.text)}`),
      name: new Set(words(`${topic} ${guide.name}`)),
      text: new Set(words(sections ? sections.map((row) => `${row.section} ${row.about}`).join(" ") : guide.text)),
      fields: [],
      exact: topic,
    });
    for (const row of sections ?? []) {
      rows.push({
        label: `topic ${topic} section ${row.section}`,
        read: `guide {topic:"${topic}", section:"${row.section}"}`,
        line: short(row.about || firstSentence(row.text)),
        name: new Set(words([row.section, ...row.also].join(" "))),
        text: new Set(words(row.text)),
        fields: [],
        exact: "",
      });
    }
  }
  entries = rows;
  return rows;
}

export interface Hit {
  label: string;
  read: string;
  line: string;
  score: number;
  fields: string[];
}

let rarity: Map<string, number> | null = null;

/**
 * How much a word tells entries apart: 2 for a word one entry has, 0.5 for a word every entry has. "floating" in
 * "why is my print floating" then outweighs "print", which half the catalogue says.
 */
function rarityOf(word: string): number {
  if (!rarity) {
    const rows = catalogue();
    const seen = new Map<string, number>();
    for (const entry of rows) {
      const own = new Set<string>([...entry.name, ...entry.text]);
      for (const field of entry.fields) for (const w of [...field.name, ...field.text]) own.add(w);
      for (const w of own) seen.set(w, (seen.get(w) ?? 0) + 1);
    }
    const all = Math.log(Math.max(2, rows.length));
    rarity = new Map([...seen].map(([w, count]) => [w, 0.5 + (1.5 * Math.log(rows.length / count)) / all]));
  }
  return rarity.get(word) ?? 1;
}

/**
 * The entries that share words with a query, best first. A word in a name or a field's name counts three, a word in a
 * text one, each times how rare the word is in the catalogue; an exact name ranks first. A tool's matching fields come
 * with it, so "couple gears" finds model_place {gears}.
 */
export function search(query: string, limit = 8): Hit[] {
  const asked = [...new Set(words(query))];
  const plain = query.trim().toLowerCase();
  if (asked.length === 0 && plain === "") return [];
  const hits: Hit[] = [];
  for (const entry of catalogue()) {
    let score = entry.exact !== "" && entry.exact.toLowerCase() === plain ? 100 : 0;
    const fieldScore = new Map<string, number>();
    for (const word of asked) {
      let best = entry.name.has(word) ? 3 : entry.text.has(word) ? 1 : 0;
      for (const field of entry.fields) {
        const s = field.name.has(word) ? 3 : field.text.has(word) ? 1 : 0;
        if (s > 0) fieldScore.set(field.field, (fieldScore.get(field.field) ?? 0) + s);
        best = Math.max(best, s);
      }
      score += best * rarityOf(word);
    }
    // Every word of the query found counts more than one word found often.
    const found = asked.filter((word) => entry.name.has(word) || entry.text.has(word) || entry.fields.some((field) => field.name.has(word) || field.text.has(word))).length;
    if (found === asked.length && asked.length > 1) score += 2;
    if (META_TOOLS.has(entry.label) && score < 100) continue;
    if (score <= 0) continue;
    const fields = [...fieldScore.entries()].filter(([, s]) => s >= 3).sort((a, b) => b[1] - a[1]).map(([name]) => name).slice(0, 3);
    hits.push({ label: entry.label, read: entry.read, line: entry.line, score, fields });
  }
  // Ties keep catalogue order: tools, then op kinds, then kind texts, then guides.
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** One search hit as the line guide {query} answers. */
export function hitLine(hit: Hit): string {
  const tool = TOOLS.find((row) => row.name === hit.label);
  const field = hit.fields[0];
  const fieldText = tool && field ? String(properties(tool.inputSchema)[field]?.description ?? "") : "";
  const label = hit.fields.length ? `${hit.label} {${hit.fields.join(", ")}}` : hit.label;
  return `${label}: ${hit.line}${fieldText ? ` ${field}: ${fieldText}` : ""} -> ${hit.read}`;
}

/** The nearest tool names to one that is not a tool, for a refusal. */
export function nearestTools(name: string, limit = 3): string[] {
  const names = new Set(catalogTools().map((tool) => tool.name));
  const byWords = search(name.replace(/_/g, " "), 20).filter((hit) => names.has(hit.label)).map((hit) => hit.label);
  const byPrefix = [...names].filter((tool) => tool.startsWith(name.slice(0, 4)) && !byWords.includes(tool));
  return [...byWords, ...byPrefix].slice(0, limit);
}

/** A field's expected value in a few words. */
export function shapeOf(node: Record<string, unknown>): string {
  if (Array.isArray(node.enum)) {
    const values = node.enum.map((value) => (typeof value === "string" ? value : JSON.stringify(value)));
    return values.length > 14 ? `${values.slice(0, 14).join("|")}|...` : values.join("|");
  }
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (Array.isArray(node.oneOf) || Array.isArray(node.anyOf)) {
    const branches = (node.oneOf ?? node.anyOf) as Record<string, unknown>[];
    if (branches.some((branch) => (properties(branch).kind as { const?: unknown } | undefined)?.const !== undefined)) return "an op {kind, ...}";
    return [...new Set(branches.map(shapeOf))].join(" or ");
  }
  const range = (low: unknown, high: unknown) =>
    typeof low === "number" && typeof high === "number" ? ` ${low} to ${high}` : typeof low === "number" ? ` from ${low}` : typeof high === "number" ? ` up to ${high}` : "";
  switch (node.type) {
    case "number": return `number${range(node.minimum ?? node.exclusiveMinimum, node.maximum ?? node.exclusiveMaximum)}`;
    case "integer": return `whole number${range(node.minimum, node.maximum)}`;
    case "string": return "text";
    case "boolean": return "true or false";
    case "array": {
      if (node.minItems === 3 && node.maxItems === 3) return "[x, y, z]";
      if (node.minItems === 2 && node.maxItems === 2) return "[a, b]";
      const items = node.items && typeof node.items === "object" ? shapeOf(node.items as Record<string, unknown>) : "";
      return items ? `list of ${items}` : "list";
    }
    case "object": {
      const names = Object.keys(properties(node));
      return names.length ? `{${names.slice(0, 12).join(", ")}${names.length > 12 ? ", ..." : ""}}` : "object";
    }
    default: return "any";
  }
}

/** One line per field, and one more level for a field that is an object (or a list of them). */
export function fieldLines(schema: Record<string, unknown>, prefix = "", depth = 0): string[] {
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  const lines: string[] = [];
  for (const [field, node] of Object.entries(properties(schema))) {
    const description = String(node.description ?? "").trim();
    lines.push(`${prefix}${field} (${required.has(field) ? "required, " : ""}${shapeOf(node)})${description ? `: ${description}` : ""}`);
    if (depth > 0) continue;
    const inner = node.type === "object" ? node : node.type === "array" && node.items && typeof node.items === "object" && (node.items as { type?: unknown }).type === "object" ? node.items as Record<string, unknown> : null;
    if (inner && Object.keys(properties(inner)).length > 0) lines.push(...fieldLines(inner, `${prefix}${field}${inner === node ? "" : "[]"}.`, depth + 1));
  }
  return lines;
}

/** Whether a tool's schema has an op or ops field, whose kinds guide {kind} explains. */
function takesOps(tool: ToolSpec): boolean {
  const props = properties(tool.inputSchema);
  return "op" in props || "ops" in props;
}

/** guide {tool}: one tool in full, the reply a client reads before its first call of it. */
export function toolDoc(name: string, withSchema: boolean): Record<string, unknown> | null {
  const tool = TOOLS.find((row) => row.name === name);
  if (!tool) return null;
  const doc: Record<string, unknown> = {
    ok: true,
    tool: tool.name,
    area: areaOf(tool.name),
    description: tool.description,
    fields: fieldLines(tool.inputSchema),
    examples: (EXAMPLES[tool.name] ?? []).map((args) => `call {tool:"${tool.name}", args:${JSON.stringify(args)}}`),
  };
  if (takesOps(tool)) doc.ops = `op kinds: ${OP_KINDS.join(", ")}. guide {kind:"fillet"} gives one kind's fields and examples.`;
  if (UNLISTED_TOOLS.has(tool.name)) doc.note = "Kept for older callers; nugget is the tool to use now.";
  if (withSchema) doc.schema = tool.inputSchema;
  return doc;
}

/** guide {group}: an area's tools, one line each. */
export function areaDoc(area: string): Record<string, unknown> | null {
  if (!Object.hasOwn(AREAS, area)) return null;
  const tools = catalogTools().filter((tool) => areaOf(tool.name) === area);
  return {
    ok: true,
    group: area,
    about: AREAS[area],
    tools: tools.map((tool) => `${tool.name}: ${firstSentence(tool.description)}`),
    next: `guide {tool} reads one in full; call {tool, args} runs it.${area === "core" ? "" : ` tools_enable {groups:["${area}"]} also lists them in clients that re-read the tool list.`}`,
  };
}

/** guide {}: the map. */
export function mapDoc(): Record<string, unknown> {
  const count = (area: string) => catalogTools().filter((tool) => areaOf(tool.name) === area).length;
  return {
    ok: true,
    groups: AREA_NAMES.map((area) => `${area} (${count(area)} tools): ${AREAS[area]}`),
    topics: GUIDES.map((guide) => `${guide.uri.replace("lime://guide/", "")}: ${guide.name}`),
    next: "guide {query:\"a few words of the task\"} finds tools, fields, op kinds and guide sections; guide {group}, {tool}, {kind} or {topic} reads one.",
  };
}

/** The tools of the groups a session opened, for the code that lists them. */
export function groupTools(group: string): string[] {
  if (group === "core") return catalogTools().filter((tool) => groupOf(tool.name) === null).map((tool) => tool.name);
  return TOOL_GROUPS[group]?.tools ?? [];
}
