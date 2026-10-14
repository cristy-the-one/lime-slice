/**
 * A foreign 3MF can carry a slicer's settings next to the mesh.
 * The mesh still loads either way. Apply to Recipe copies geometry only:
 * layer height, wall count, infill density, and whether supports are on.
 * Temperatures, speeds, infill pattern, and support style stay put.
 * Top and bottom shell counts are read and then left alone: shell depth
 * follows the strategy, and changing that would also change speeds.
 */

const VENDORS: readonly [string, string][] = [
  ["prusaslicer", "PrusaSlicer"],
  ["slic3r", "PrusaSlicer"],
  ["orcaslicer", "OrcaSlicer"],
  ["bambustudio", "Bambu Studio"],
  ["bambu", "Bambu Studio"],
];

/** The layer-height field's own range. A value outside it is not a recipe this app can store. */
const LAYER_MIN_MM = 0.08;
const LAYER_MAX_MM = 0.4;
const CONFIG_MAX_BYTES = 512 * 1024;

export interface ForeignRecipe {
  vendor: string;
  layerHeightMm?: number;
  walls?: number;
  /** Recognized, not applied. */
  topLayers?: number;
  /** Recognized, not applied. */
  bottomLayers?: number;
  /** Sparse infill, 0 to 1. */
  infill?: number;
  supports?: boolean;
}

/** Vendor label when the 3MF package names a slicer project, otherwise null. */
export function foreignSlicer3mf(bytes: Uint8Array): string | null {
  const names = zipEntryNames(bytes);
  if (names.length === 0) return null;
  const blob = names.join("\n").toLowerCase();
  for (const [needle, label] of VENDORS) {
    if (blob.includes(needle)) return label;
  }
  if (/(^|\n|\/)cura(\/|\n|$)/.test(blob) || blob.includes("cura.fdm")) return "Cura";
  if (blob.includes("project_settings.config") || blob.includes("model_settings.config")) return "slicer";
  return null;
}

export function foreign3mfMessage(vendor: string): string {
  const whose = vendor === "slicer" ? "Slicer" : vendor;
  return `Opened the mesh only. ${whose} settings in this 3MF were not imported.`;
}

/** The toast when Apply has something to copy. Null when the file has no geometry setting this app can store. */
export function foreignRecipeOffer(recipe: ForeignRecipe): string | null {
  const bits: string[] = [];
  if (recipe.layerHeightMm !== undefined) bits.push(`${recipe.layerHeightMm.toFixed(2)} mm layers`);
  if (recipe.walls !== undefined) bits.push(`${recipe.walls} walls`);
  if (recipe.infill !== undefined) bits.push(`${Math.round(recipe.infill * 100)}% infill`);
  if (recipe.supports !== undefined) bits.push(recipe.supports ? "supports on" : "supports off");
  if (bits.length === 0) return null;
  const whose = recipe.vendor === "slicer" ? "Slicer" : recipe.vendor;
  return `Found ${whose} print settings (${bits.join(", ")}).`;
}

/** Geometry settings from a Prusa, Orca, Bambu, or Cura project. Null when the package has no such config. */
export async function extractForeign3mfRecipe(bytes: Uint8Array): Promise<ForeignRecipe | null> {
  const texts = await configTexts(bytes);
  if (texts.length === 0) return null;
  const recipe: ForeignRecipe = { vendor: foreignSlicer3mf(bytes) ?? "slicer" };
  for (const text of texts) fillRecipe(recipe, readPairs(text));
  return recipe;
}

/** File names from local and central headers. Compressed file bytes are not read. */
export function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  for (let i = 0; i + 30 < bytes.length; i++) {
    const sig = u32(bytes, i);
    if (sig === 0x04034b50) pushName(names, bytes, i + 30, u16(bytes, i + 26));
    else if (sig === 0x02014b50 && i + 46 < bytes.length) pushName(names, bytes, i + 46, u16(bytes, i + 28));
  }
  return names;
}

function fillRecipe(recipe: ForeignRecipe, pairs: Map<string, string>) {
  if (recipe.layerHeightMm === undefined) recipe.layerHeightMm = layerHeight(pairs);
  if (recipe.walls === undefined) recipe.walls = walls(pairs);
  if (recipe.topLayers === undefined) recipe.topLayers = layerCount(pairs, ["top_solid_layers", "top_shell_layers", "top_layers"]);
  if (recipe.bottomLayers === undefined) recipe.bottomLayers = layerCount(pairs, ["bottom_solid_layers", "bottom_shell_layers", "bottom_layers"]);
  if (recipe.infill === undefined) recipe.infill = infill(pairs);
  if (recipe.supports === undefined) recipe.supports = supports(pairs);
}

function layerHeight(pairs: Map<string, string>): number | undefined {
  const value = numberOf(pairs.get("layer_height"));
  if (value === undefined || value < LAYER_MIN_MM || value > LAYER_MAX_MM) return undefined;
  return value;
}

function walls(pairs: Map<string, string>): number | undefined {
  const value = numberOf(first(pairs, ["perimeters", "wall_loops", "wall_line_count"]));
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > 12) return undefined;
  return value;
}

function layerCount(pairs: Map<string, string>, keys: string[]): number | undefined {
  const value = numberOf(first(pairs, keys));
  if (value === undefined || !Number.isInteger(value) || value < 0 || value > 50) return undefined;
  return value;
}

function infill(pairs: Map<string, string>): number | undefined {
  const raw = first(pairs, ["fill_density", "sparse_infill_density", "infill_sparse_density"]);
  if (raw === undefined) return undefined;
  const value = numberOf(raw);
  if (value === undefined) return undefined;
  const fraction = raw.includes("%") || value > 1 ? value / 100 : value;
  if (fraction < 0 || fraction > 1) return undefined;
  return fraction;
}

function supports(pairs: Map<string, string>): boolean | undefined {
  const raw = first(pairs, ["support_material", "enable_support", "support_enable"]);
  if (raw === undefined) return undefined;
  const text = raw.trim().toLowerCase();
  if (text === "1" || text === "true" || text === "yes" || text === "on") return true;
  if (text === "0" || text === "false" || text === "no" || text === "off") return false;
  return undefined;
}

function first(pairs: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = pairs.get(key);
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

function numberOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim().replace(/%$/, ""));
  return Number.isFinite(value) ? value : undefined;
}

function readPairs(text: string): Map<string, string> {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed.startsWith("{")) return jsonPairs(trimmed);
  return iniPairs(trimmed);
}

function iniPairs(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed.startsWith("[")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !pairs.has(key)) pairs.set(key, value);
  }
  return pairs;
}

function jsonPairs(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return pairs;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return pairs;
  const root = parsed as Record<string, unknown>;
  absorb(pairs, root);
  for (const nest of ["settings", "overrides"]) {
    const child = root[nest];
    if (child && typeof child === "object" && !Array.isArray(child)) absorb(pairs, child as Record<string, unknown>);
  }
  return pairs;
}

function absorb(pairs: Map<string, string>, row: Record<string, unknown>) {
  for (const [key, value] of Object.entries(row)) {
    const name = key.toLowerCase();
    if (pairs.has(name)) continue;
    const flat = flatValue(value);
    if (flat !== undefined) pairs.set(name, flat);
  }
}

function flatValue(value: unknown): string | undefined {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const inner = row.default_value ?? row.value;
  if (typeof inner === "number" || typeof inner === "boolean" || typeof inner === "string") return String(inner);
  return undefined;
}

function isConfigName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith("slic3r_pe.config")
    || lower.endsWith("prusaslicer.ini")
    || lower.endsWith("project_settings.config")
    || (lower.includes("cura/") && lower.endsWith(".json"));
}

/** Print-settings texts, Prusa and Orca first, then Cura. */
async function configTexts(bytes: Uint8Array): Promise<string[]> {
  const found = await zipConfigs(bytes);
  const rank = (name: string) => {
    const lower = name.toLowerCase();
    if (lower.endsWith("project_settings.config")) return 0;
    if (lower.endsWith("slic3r_pe.config") || lower.endsWith("prusaslicer.ini")) return 1;
    return 2;
  };
  return found.sort((a, b) => rank(a.name) - rank(b.name)).map((entry) => entry.text);
}

interface NamedText {
  name: string;
  text: string;
}

async function zipConfigs(bytes: Uint8Array): Promise<NamedText[]> {
  const out: NamedText[] = [];
  const central = centralConfigs(bytes);
  const entries = central ?? localConfigs(bytes);
  for (const entry of entries) {
    if (out.length >= 4) break;
    const text = await entryText(entry);
    if (text) out.push({ name: entry.name, text });
  }
  return out;
}

interface ZipPayload {
  name: string;
  method: number;
  data: Uint8Array;
}

function centralConfigs(bytes: Uint8Array): ZipPayload[] | null {
  const eocd = findEocd(bytes);
  if (eocd === null) return null;
  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  const entries: ZipPayload[] = [];
  for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
    if (u32(bytes, at) !== 0x02014b50) return entries;
    const method = u16(bytes, at + 10);
    const compSize = u32(bytes, at + 20);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const localAt = u32(bytes, at + 42);
    const name = readName(bytes, at + 46, nameLen);
    if (name && isConfigName(name)) {
      const payload = localPayload(bytes, localAt, compSize);
      if (payload && payload.length === compSize) entries.push({ name, method, data: payload });
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function localConfigs(bytes: Uint8Array): ZipPayload[] {
  const entries: ZipPayload[] = [];
  for (let i = 0; i + 30 < bytes.length;) {
    if (u32(bytes, i) !== 0x04034b50) {
      i += 1;
      continue;
    }
    const method = u16(bytes, i + 8);
    const compSize = u32(bytes, i + 18);
    const nameLen = u16(bytes, i + 26);
    const extraLen = u16(bytes, i + 28);
    const name = readName(bytes, i + 30, nameLen);
    const dataAt = i + 30 + nameLen + extraLen;
    if (name && isConfigName(name) && compSize > 0 && dataAt + compSize <= bytes.length) {
      entries.push({ name, method, data: bytes.subarray(dataAt, dataAt + compSize) });
    }
    i = compSize > 0 && dataAt + compSize <= bytes.length ? dataAt + compSize : dataAt;
  }
  return entries;
}

function localPayload(bytes: Uint8Array, localAt: number, compSize: number): Uint8Array | null {
  if (compSize === 0 || compSize > CONFIG_MAX_BYTES || localAt + 30 > bytes.length) return null;
  if (u32(bytes, localAt) !== 0x04034b50) return null;
  const nameLen = u16(bytes, localAt + 26);
  const extraLen = u16(bytes, localAt + 28);
  const dataAt = localAt + 30 + nameLen + extraLen;
  if (dataAt + compSize > bytes.length) return null;
  return bytes.subarray(dataAt, dataAt + compSize);
}

async function entryText(entry: ZipPayload): Promise<string | null> {
  if (entry.data.length > CONFIG_MAX_BYTES) return null;
  try {
    const raw = entry.method === 0 ? entry.data : entry.method === 8 ? await inflateRaw(entry.data) : null;
    if (!raw || raw.length > CONFIG_MAX_BYTES) return null;
    return new TextDecoder().decode(raw);
  } catch {
    return null;
  }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  await writer.write(new Uint8Array(data));
  await writer.close();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    size += step.value.length;
    if (size > CONFIG_MAX_BYTES) throw new Error("config too large");
    chunks.push(step.value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function findEocd(bytes: Uint8Array): number | null {
  const start = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= start; i--) {
    if (u32(bytes, i) === 0x06054b50) return i;
  }
  return null;
}

function pushName(names: string[], bytes: Uint8Array, start: number, length: number) {
  const name = readName(bytes, start, length);
  if (name) names.push(name);
}

function readName(bytes: Uint8Array, start: number, length: number): string | null {
  if (length === 0 || length > 200 || start + length > bytes.length) return null;
  let name = "";
  for (let i = 0; i < length; i++) {
    const code = bytes[start + i]!;
    if (code < 0x20 || code > 0x7e) return null;
    name += String.fromCharCode(code);
  }
  return name;
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}
